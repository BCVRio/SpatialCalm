// Unit tests for the Worker with Stripe and KV stubbed. Run: `cd api && npm test`
import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker, { verifyStripeSignature, signToken, verifyToken, isPlus } from '../src/index.js';
import { createHmac } from 'node:crypto';

const ORIGIN = 'https://resonance.zapworks.app';
function kv() { const m = new Map(); return { m, get: async (k, t) => { const v = m.get(k); return v == null ? null : t === 'json' ? JSON.parse(v) : v; }, put: async (k, v) => { m.set(k, v); } }; }
function env(extra = {}) { return { SUBS: kv(), STRIPE_SECRET_KEY: 'sk_test_x', STRIPE_WEBHOOK_SECRET: 'whsec_test', STRIPE_PRICE_ID: 'price_123', AUTH_SECRET: 'super-secret-signing-key', APP_ORIGINS: ORIGIN + ',http://localhost:8080', ...extra }; }
const calls = [];
globalThis.fetch = async (url, init = {}) => {
  calls.push({ url: String(url), init });
  const u = String(url);
  if (u.includes('/v1/checkout/sessions/cs_done')) return ok({ id: 'cs_done', customer: 'cus_1', customer_details: { email: 'Fan@Example.com' }, subscription: { id: 'sub_1', status: 'trialing', trial_end: 1800000000, current_period_end: 1800000000, cancel_at_period_end: false } });
  if (u.endsWith('/v1/checkout/sessions')) return ok({ id: 'cs_new', url: 'https://checkout.stripe.com/c/pay/cs_new' });
  if (u.endsWith('/v1/billing_portal/sessions')) return ok({ url: 'https://billing.stripe.com/p/session/x' });
  if (u.includes('/v1/subscriptions/sub_1')) return ok({ id: 'sub_1', status: 'active', trial_end: null, current_period_end: 1900000000 });
  if (u.includes('/v1/customers/cus_1')) return ok({ id: 'cus_1', email: 'fan@example.com' });
  if (u.startsWith('https://api.resend.com')) return ok({ id: 'email_1' });
  return new Response('{}', { status: 404 });
};
const ok = o => new Response(JSON.stringify(o), { status: 200, headers: { 'Content-Type': 'application/json' } });
const req = (method, path, { body, headers = {}, origin = ORIGIN } = {}) => new Request('https://api.test' + path, { method, headers: { Origin: origin, 'Content-Type': 'application/json', ...headers }, body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body) });
const run = (r, e, ctx = { waitUntil: p => p }) => worker.fetch(r, e, ctx);
function stripeSig(payload, secret, t = Math.floor(Date.now() / 1000)) { return `t=${t},v1=${createHmac('sha256', secret).update(`${t}.${payload}`).digest('hex')}`; }

test('CORS: allowed origin echoed, others not', async () => {
  const e = env();
  const a = await run(req('OPTIONS', '/api/health'), e);
  assert.equal(a.status, 204); assert.equal(a.headers.get('Access-Control-Allow-Origin'), ORIGIN);
  const b = await run(req('GET', '/api/health', { origin: 'https://evil.example' }), e);
  assert.equal(b.status, 200); assert.equal(b.headers.get('Access-Control-Allow-Origin'), null);
});

test('checkout creates a trial subscription session with app return URLs', async () => {
  calls.length = 0; const e = env();
  const r = await run(req('POST', '/api/checkout', { body: { return: ORIGIN + '/?foo=1' } }), e);
  assert.equal(r.status, 200); const j = await r.json(); assert.match(j.url, /checkout\.stripe\.com/);
  const body = decodeURIComponent(calls[0].init.body);
  assert.match(body, /mode=subscription/); assert.match(body, /line_items\[0\]\[price\]=price_123/);
  assert.match(body, /subscription_data\[trial_period_days\]=7/); assert.match(body, /payment_method_collection=always/);
  assert.match(body, /success_url=https:\/\/resonance\.zapworks\.app\/\?checkout=success&session_id=\{CHECKOUT_SESSION_ID\}/);
  assert.match(body, /cancel_url=https:\/\/resonance\.zapworks\.app\/\?checkout=cancel/);
});

test('checkout rejects return URLs outside APP_ORIGINS', async () => {
  const r = await run(req('POST', '/api/checkout', { body: { return: 'https://evil.example/' } }), env());
  assert.equal(r.status, 400);
});

test('me?session_id resolves the plan, persists the user and mints a token that /api/me and /api/portal accept', async () => {
  const e = env();
  const r = await run(req('GET', '/api/me?session_id=cs_done'), e);
  assert.equal(r.status, 200); const j = await r.json();
  assert.equal(j.plan, 'plus'); assert.equal(j.status, 'trialing'); assert.equal(j.email, 'fan@example.com'); assert.ok(j.token);
  assert.equal(await e.SUBS.get('cust:cus_1'), 'fan@example.com');
  const me = await (await run(req('GET', '/api/me', { headers: { Authorization: 'Bearer ' + j.token } }), e)).json();
  assert.equal(me.plan, 'plus'); assert.equal(me.token, undefined);
  const anon = await (await run(req('GET', '/api/me'), e)).json(); assert.equal(anon.plan, 'free');
  const portal = await run(req('POST', '/api/portal', { body: { return: ORIGIN + '/' }, headers: { Authorization: 'Bearer ' + j.token } }), e);
  assert.equal(portal.status, 200); assert.match((await portal.json()).url, /billing\.stripe\.com/);
  const noAuth = await run(req('POST', '/api/portal', { body: { return: ORIGIN + '/' } }), e); assert.equal(noAuth.status, 401);
});

test('webhook: rejects bad signatures, applies subscription lifecycle', async () => {
  const e = env(); await e.SUBS.put('user:fan@example.com', JSON.stringify({ email: 'fan@example.com', stripeCustomerId: 'cus_1', status: 'trialing' })); await e.SUBS.put('cust:cus_1', 'fan@example.com');
  const ev = (type, object) => JSON.stringify({ id: 'evt_1', type, data: { object } });
  const bad = await run(req('POST', '/api/webhook', { body: ev('customer.subscription.updated', {}), headers: { 'Stripe-Signature': 't=1,v1=00' } }), e);
  assert.equal(bad.status, 400);
  const upd = ev('customer.subscription.updated', { id: 'sub_1', customer: 'cus_1', status: 'active', trial_end: null, current_period_end: 1900000000, cancel_at_period_end: true });
  const r1 = await run(req('POST', '/api/webhook', { body: upd, headers: { 'Stripe-Signature': stripeSig(upd, 'whsec_test') } }), e);
  assert.equal(r1.status, 200);
  let rec = await e.SUBS.get('user:fan@example.com', 'json'); assert.equal(rec.status, 'active'); assert.equal(rec.cancelAtPeriodEnd, true); assert.ok(isPlus(rec));
  const failed = ev('invoice.payment_failed', { customer: 'cus_1' });
  await run(req('POST', '/api/webhook', { body: failed, headers: { 'Stripe-Signature': stripeSig(failed, 'whsec_test') } }), e);
  rec = await e.SUBS.get('user:fan@example.com', 'json'); assert.equal(rec.status, 'past_due'); assert.ok(isPlus(rec), 'keeps access until period end');
  const del = ev('customer.subscription.deleted', { id: 'sub_1', customer: 'cus_1', status: 'canceled', current_period_end: 1700000000 });
  await run(req('POST', '/api/webhook', { body: del, headers: { 'Stripe-Signature': stripeSig(del, 'whsec_test') } }), e);
  rec = await e.SUBS.get('user:fan@example.com', 'json'); assert.equal(rec.status, 'canceled'); assert.equal(isPlus(rec), false);
  const completed = ev('checkout.session.completed', { customer: 'cus_1', customer_details: { email: 'fan@example.com' }, subscription: 'sub_1' });
  await run(req('POST', '/api/webhook', { body: completed, headers: { 'Stripe-Signature': stripeSig(completed, 'whsec_test') } }), e);
  rec = await e.SUBS.get('user:fan@example.com', 'json'); assert.equal(rec.status, 'active');
});

test('stripe signature verification honours tolerance', async () => {
  const p = '{"a":1}'; const old = stripeSig(p, 's', Math.floor(Date.now() / 1000) - 3600);
  assert.equal(await verifyStripeSignature(p, old, 's'), false);
  assert.equal(await verifyStripeSignature(p, stripeSig(p, 's'), 's'), true);
});

test('restore: sends a magic link only for known subscribers, always answers ok', async () => {
  calls.length = 0; const e = env({ RESEND_API_KEY: 're_x', MAIL_FROM: 'Resonance <r@bcvr.io>' });
  const r0 = await run(req('POST', '/api/restore', { body: { email: 'nobody@example.com', return: ORIGIN + '/' } }), e);
  assert.equal(r0.status, 200); assert.equal(calls.filter(c => c.url.includes('resend')).length, 0);
  await e.SUBS.put('user:fan@example.com', JSON.stringify({ email: 'fan@example.com', stripeCustomerId: 'cus_1', status: 'active' }));
  const r1 = await run(req('POST', '/api/restore', { body: { email: 'FAN@example.com', return: ORIGIN + '/' } }), e);
  assert.equal(r1.status, 200);
  const mail = calls.find(c => c.url.includes('resend')); assert.ok(mail);
  const link = JSON.parse(mail.init.body).text.match(/https:\/\/\S+/)[0]; const tok = new URL(link).searchParams.get('auth');
  const claims = await verifyToken(e, tok); assert.equal(claims.email, 'fan@example.com'); assert.equal(claims.magic, true);
  const me = await (await run(req('GET', '/api/me', { headers: { Authorization: 'Bearer ' + tok } }), e)).json(); assert.equal(me.plan, 'plus');
});

test('tokens: tampering and expiry are rejected', async () => {
  const e = env();
  const t = await signToken(e, { email: 'a@b.co', exp: Date.now() + 1000 });
  assert.ok(await verifyToken(e, t));
  assert.equal(await verifyToken(e, t.slice(0, -2) + 'zz'), null);
  assert.equal(await verifyToken({ AUTH_SECRET: 'other' }, t), null);
  assert.equal(await verifyToken(e, await signToken(e, { email: 'a@b.co', exp: Date.now() - 1 })), null);
});

test('missing config answers 503 rather than crashing', async () => {
  const r = await run(req('POST', '/api/checkout', { body: { return: ORIGIN + '/' } }), env({ STRIPE_PRICE_ID: '' }));
  assert.equal(r.status, 503);
});
