/**
 * Resonance billing API — Cloudflare Worker
 *
 * Stripe Checkout + Billing Portal + webhooks + magic-link identity for the
 * Resonance WebAR app (static hosting on ZapWorks, so the API lives here).
 *
 * Routes (all JSON, CORS-restricted to APP_ORIGINS):
 *   POST /api/checkout  { return }            -> { url }   Stripe Checkout (subscription, 7-day trial)
 *   GET  /api/me[?session_id=cs_…]            -> { plan, status, trialEnd, currentPeriodEnd, email, token? }
 *   POST /api/portal    { return }            -> { url }   Stripe Billing Portal (needs bearer token)
 *   POST /api/restore   { email, return }     -> { ok }    emails a magic link `<return>?auth=<token>`
 *   POST /api/webhook                          Stripe webhooks (signature verified)
 *   GET  /api/health
 *
 * Bindings / secrets (see wrangler.toml + README.md):
 *   SUBS (KV)                     user:<email> -> record, cust:<customerId> -> email
 *   STRIPE_SECRET_KEY             sk_live_… / sk_test_…
 *   STRIPE_WEBHOOK_SECRET         whsec_…
 *   STRIPE_PRICE_ID               price_… for Resonance Plus £3.99/month
 *   AUTH_SECRET                   random 32+ byte string, signs bearer tokens
 *   APP_ORIGINS                   comma-separated allowed origins (zapworks + any staging)
 *   TRIAL_DAYS                    optional, default 7
 *   RESEND_API_KEY, MAIL_FROM     optional; without them /api/restore logs the link instead of emailing it
 */

const JSON_HEADERS = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' };
const TOKEN_TTL_MS = 180 * 24 * 3600e3; // bearer tokens live 180 days
const MAGIC_TTL_MS = 30 * 60e3;         // magic links live 30 minutes

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const origin = request.headers.get('Origin') || '';
    const cors = corsHeaders(origin, env);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    try {
      const res = await route(request, env, ctx, url);
      for (const [k, v] of Object.entries(cors)) res.headers.set(k, v);
      return res;
    } catch (e) {
      console.error('resonance-api', e);
      const status = e.status || 500;
      return json({ error: status === 500 ? 'internal' : e.message }, status, cors);
    }
  },
};

async function route(request, env, ctx, url) {
  const p = url.pathname.replace(/\/$/, '');
  if (request.method === 'GET' && p === '/api/health') return json({ ok: true, now: new Date().toISOString() });
  if (request.method === 'POST' && p === '/api/webhook') return webhook(request, env, ctx);
  if (request.method === 'POST' && p === '/api/checkout') return checkout(request, env);
  if (request.method === 'GET' && p === '/api/me') return me(request, env, url);
  if (request.method === 'POST' && p === '/api/portal') return portal(request, env);
  if (request.method === 'POST' && p === '/api/restore') return restore(request, env, ctx);
  return json({ error: 'not found' }, 404);
}

// ---------- handlers ----------

async function checkout(request, env) {
  requireEnv(env, ['STRIPE_SECRET_KEY', 'STRIPE_PRICE_ID']);
  const body = await readJson(request);
  const ret = appReturnUrl(body.return, env);
  const who = await identity(request, env); // optional: signed-in users reuse their customer
  const params = {
    mode: 'subscription',
    'line_items[0][price]': env.STRIPE_PRICE_ID,
    'line_items[0][quantity]': '1',
    payment_method_collection: 'always',
    'subscription_data[trial_period_days]': String(parseInt(env.TRIAL_DAYS || '7', 10)),
    success_url: withQuery(ret, { checkout: 'success', session_id: '{CHECKOUT_SESSION_ID}' }),
    cancel_url: withQuery(ret, { checkout: 'cancel' }),
    'metadata[app]': 'resonance',
  };
  if (who) {
    const rec = await getUser(env, who.email);
    if (rec && rec.stripeCustomerId) params.customer = rec.stripeCustomerId;
    else params.customer_email = who.email;
  }
  const session = await stripe(env, 'POST', '/v1/checkout/sessions', params);
  return json({ url: session.url, id: session.id });
}

async function me(request, env, url) {
  const sessionId = url.searchParams.get('session_id');
  if (sessionId) {
    // Fresh return from Checkout: resolve the customer from the session and mint a token.
    requireEnv(env, ['STRIPE_SECRET_KEY', 'AUTH_SECRET']);
    if (!/^cs_[A-Za-z0-9_]+$/.test(sessionId)) throw httpError(400, 'bad session id');
    const s = await stripe(env, 'GET', `/v1/checkout/sessions/${sessionId}`, { 'expand[]': 'subscription' });
    const email = (s.customer_details && s.customer_details.email) || s.customer_email;
    const customerId = typeof s.customer === 'string' ? s.customer : s.customer && s.customer.id;
    if (!email || !customerId) throw httpError(409, 'checkout not complete');
    const rec = await upsertUser(env, email, {
      stripeCustomerId: customerId,
      ...(s.subscription && typeof s.subscription === 'object' ? subFields(s.subscription) : {}),
    });
    const token = await signToken(env, { email: rec.email, exp: Date.now() + TOKEN_TTL_MS });
    return json({ ...planView(rec), token });
  }
  const who = await identity(request, env);
  if (!who) return json({ plan: 'free' });
  const rec = await getUser(env, who.email);
  return json(planView(rec || { email: who.email }));
}

async function portal(request, env) {
  requireEnv(env, ['STRIPE_SECRET_KEY']);
  const who = await identity(request, env);
  if (!who) throw httpError(401, 'sign in required');
  const rec = await getUser(env, who.email);
  if (!rec || !rec.stripeCustomerId) throw httpError(404, 'no subscription');
  const body = await readJson(request);
  const ret = appReturnUrl(body.return, env);
  const s = await stripe(env, 'POST', '/v1/billing_portal/sessions', { customer: rec.stripeCustomerId, return_url: ret });
  return json({ url: s.url });
}

async function restore(request, env, ctx) {
  requireEnv(env, ['AUTH_SECRET']);
  const body = await readJson(request);
  const email = normEmail(body.email);
  if (!email) throw httpError(400, 'email required');
  const ret = appReturnUrl(body.return, env);
  const rec = await getUser(env, email);
  // Always answer ok so the endpoint doesn't reveal who is subscribed.
  if (!rec || !rec.stripeCustomerId) return json({ ok: true });
  const token = await signToken(env, { email, exp: Date.now() + MAGIC_TTL_MS, magic: true });
  const link = withQuery(ret, { auth: token });
  const send = sendMail(env, email, 'Your Resonance sign-in link', magicMail(link));
  if (ctx && ctx.waitUntil) ctx.waitUntil(send); else await send;
  return json({ ok: true });
}

async function webhook(request, env, ctx) {
  requireEnv(env, ['STRIPE_WEBHOOK_SECRET']);
  const raw = await request.text();
  const sig = request.headers.get('Stripe-Signature') || '';
  if (!(await verifyStripeSignature(raw, sig, env.STRIPE_WEBHOOK_SECRET))) throw httpError(400, 'bad signature');
  const event = JSON.parse(raw);
  const obj = event.data && event.data.object;
  switch (event.type) {
    case 'checkout.session.completed': {
      const email = (obj.customer_details && obj.customer_details.email) || obj.customer_email;
      const customerId = typeof obj.customer === 'string' ? obj.customer : obj.customer && obj.customer.id;
      if (email && customerId) {
        let fields = { stripeCustomerId: customerId };
        if (obj.subscription && env.STRIPE_SECRET_KEY) {
          const subId = typeof obj.subscription === 'string' ? obj.subscription : obj.subscription.id;
          try { fields = { ...fields, ...subFields(await stripe(env, 'GET', `/v1/subscriptions/${subId}`)) }; } catch (e) { console.warn('sub fetch failed', e); }
        }
        await upsertUser(env, email, fields);
      }
      break;
    }
    case 'customer.subscription.created':
    case 'customer.subscription.updated':
    case 'customer.subscription.deleted': {
      const customerId = typeof obj.customer === 'string' ? obj.customer : obj.customer && obj.customer.id;
      const email = await emailForCustomer(env, customerId);
      if (email) await upsertUser(env, email, { stripeCustomerId: customerId, ...subFields(obj), ...(event.type.endsWith('deleted') ? { status: 'canceled' } : {}) });
      break;
    }
    case 'invoice.payment_failed': {
      const customerId = typeof obj.customer === 'string' ? obj.customer : obj.customer && obj.customer.id;
      const email = await emailForCustomer(env, customerId);
      if (email) await upsertUser(env, email, { stripeCustomerId: customerId, status: 'past_due', lastPaymentFailedAt: new Date().toISOString() });
      break;
    }
    default: break;
  }
  return json({ received: true });
}

// ---------- plan logic ----------

function subFields(sub) {
  const ts = v => (v ? new Date(v * 1000).toISOString() : null);
  return {
    subscriptionId: sub.id,
    status: sub.status,
    trialEnd: ts(sub.trial_end),
    currentPeriodEnd: ts(sub.current_period_end),
    cancelAtPeriodEnd: !!sub.cancel_at_period_end,
  };
}

export function isPlus(rec, now = Date.now()) {
  if (!rec) return false;
  const st = rec.status;
  if (st === 'trialing' || st === 'active') return true;
  // Past due keeps access until the paid period runs out; Stripe then cancels.
  if (st === 'past_due' && rec.currentPeriodEnd && new Date(rec.currentPeriodEnd).getTime() > now) return true;
  return false;
}

function planView(rec) {
  const plus = isPlus(rec);
  return {
    plan: plus ? 'plus' : 'free',
    status: rec && rec.status ? rec.status : 'none',
    trialEnd: (rec && rec.trialEnd) || null,
    currentPeriodEnd: (rec && rec.currentPeriodEnd) || null,
    cancelAtPeriodEnd: !!(rec && rec.cancelAtPeriodEnd),
    email: (rec && rec.email) || null,
  };
}

// ---------- storage ----------

const normEmail = e => (typeof e === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e.trim()) ? e.trim().toLowerCase() : '');

async function getUser(env, email) {
  email = normEmail(email); if (!email) return null;
  return env.SUBS.get('user:' + email, 'json');
}
async function upsertUser(env, email, fields) {
  email = normEmail(email); if (!email) throw httpError(400, 'bad email');
  const prev = (await getUser(env, email)) || { email, createdAt: new Date().toISOString() };
  const rec = { ...prev, ...fields, email, updatedAt: new Date().toISOString() };
  await env.SUBS.put('user:' + email, JSON.stringify(rec));
  if (rec.stripeCustomerId) await env.SUBS.put('cust:' + rec.stripeCustomerId, email);
  return rec;
}
async function emailForCustomer(env, customerId) {
  if (!customerId) return null;
  const email = await env.SUBS.get('cust:' + customerId);
  if (email) return email;
  if (!env.STRIPE_SECRET_KEY) return null;
  try { const c = await stripe(env, 'GET', `/v1/customers/${customerId}`); return normEmail(c.email) || null; } catch (e) { return null; }
}

// ---------- identity: HMAC-signed bearer tokens ----------

async function identity(request, env) {
  const h = request.headers.get('Authorization') || '';
  const m = /^Bearer\s+(.+)$/i.exec(h);
  if (!m || !env.AUTH_SECRET) return null;
  const claims = await verifyToken(env, m[1].trim());
  return claims && claims.email ? claims : null;
}
export async function signToken(env, claims) {
  const payload = b64url(new TextEncoder().encode(JSON.stringify(claims)));
  const sig = b64url(await hmac(env.AUTH_SECRET, payload));
  return `${payload}.${sig}`;
}
export async function verifyToken(env, token) {
  const i = token.lastIndexOf('.'); if (i < 1) return null;
  const payload = token.slice(0, i), sig = token.slice(i + 1);
  const expect = b64url(await hmac(env.AUTH_SECRET, payload));
  if (!timingSafeEqual(sig, expect)) return null;
  let claims; try { claims = JSON.parse(new TextDecoder().decode(b64urlDecode(payload))); } catch (e) { return null; }
  if (!claims || typeof claims.exp !== 'number' || claims.exp < Date.now()) return null;
  claims.email = normEmail(claims.email);
  return claims.email ? claims : null;
}

// ---------- Stripe ----------

async function stripe(env, method, path, params) {
  const init = { method, headers: { Authorization: 'Bearer ' + env.STRIPE_SECRET_KEY, 'Stripe-Version': '2024-06-20' } };
  let url = 'https://api.stripe.com' + path;
  const body = params ? formEncode(params) : '';
  if (method === 'GET') { if (body) url += '?' + body; }
  else { init.headers['Content-Type'] = 'application/x-www-form-urlencoded'; init.body = body; }
  const r = await fetch(url, init);
  const data = await r.json().catch(() => ({}));
  if (!r.ok) { const e = httpError(r.status >= 500 ? 502 : 400, (data.error && data.error.message) || 'stripe error'); e.stripe = data.error; throw e; }
  return data;
}

export async function verifyStripeSignature(payload, header, secret, toleranceSec = 300, now = Date.now()) {
  const parts = Object.create(null);
  for (const kv of header.split(',')) { const [k, v] = kv.split('='); if (k && v) (parts[k.trim()] ||= []).push(v.trim()); }
  const t = parts.t && parts.t[0]; const sigs = parts.v1 || [];
  if (!t || !sigs.length) return false;
  if (Math.abs(now / 1000 - Number(t)) > toleranceSec) return false;
  const expected = hex(await hmac(secret, `${t}.${payload}`));
  return sigs.some(s => timingSafeEqual(s, expected));
}

// ---------- mail (Resend) ----------

async function sendMail(env, to, subject, { text, html }) {
  if (!env.RESEND_API_KEY || !env.MAIL_FROM) { console.log('MAGIC LINK (mail not configured) ->', to, text); return false; }
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + env.RESEND_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: env.MAIL_FROM, to: [to], subject, text, html }),
  });
  if (!r.ok) console.error('resend failed', r.status, await r.text().catch(() => ''));
  return r.ok;
}
function magicMail(link) {
  const text = `Tap to sign back in to Resonance and restore your Plus subscription on this device:\n\n${link}\n\nThe link works for 30 minutes. If you didn't ask for it, ignore this email.\n\nBCVR Immersive`;
  const html = `<div style="font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;font-size:15px;line-height:1.5;color:#111"><p>Tap to sign back in to Resonance and restore your Plus subscription on this device:</p><p><a href="${link}" style="display:inline-block;padding:12px 18px;background:#000;color:#fff;text-decoration:none;border-radius:2px">Open Resonance</a></p><p style="color:#666;font-size:13px">The link works for 30 minutes. If you didn't ask for it, ignore this email.<br>BCVR Immersive</p></div>`;
  return { text, html };
}

// ---------- helpers ----------

function corsHeaders(origin, env) {
  const allowed = allowedOrigins(env);
  const ok = origin && (allowed.includes('*') || allowed.includes(origin));
  const h = { 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type,Authorization', 'Access-Control-Max-Age': '86400', Vary: 'Origin' };
  if (ok) h['Access-Control-Allow-Origin'] = origin;
  return h;
}
function allowedOrigins(env) { return String(env.APP_ORIGINS || '').split(',').map(s => s.trim().replace(/\/$/, '')).filter(Boolean); }
function appReturnUrl(ret, env) {
  let u; try { u = new URL(String(ret || '')); } catch (e) { throw httpError(400, 'bad return url'); }
  const allowed = allowedOrigins(env);
  if (!(allowed.includes('*') || allowed.includes(u.origin))) throw httpError(400, 'return url not allowed');
  u.search = ''; u.hash = '';
  return u.toString();
}
function withQuery(base, q) { const u = new URL(base); for (const [k, v] of Object.entries(q)) u.searchParams.set(k, v); return u.toString().replace(/%7B/gi, '{').replace(/%7D/gi, '}'); }
async function readJson(request) { try { const t = await request.text(); return t ? JSON.parse(t) : {}; } catch (e) { throw httpError(400, 'bad json'); } }
function json(data, status = 200, extra = {}) { return new Response(JSON.stringify(data), { status, headers: { ...JSON_HEADERS, ...extra } }); }
function httpError(status, message) { const e = new Error(message); e.status = status; return e; }
function requireEnv(env, keys) { const missing = keys.filter(k => !env[k]); if (missing.length) throw httpError(503, 'missing config: ' + missing.join(', ')); }
function formEncode(obj) { return Object.entries(obj).filter(([, v]) => v !== undefined && v !== null).map(([k, v]) => encodeURIComponent(k) + '=' + encodeURIComponent(v)).join('&'); }
async function hmac(secret, data) { const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']); return new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data))); }
function hex(bytes) { return [...bytes].map(b => b.toString(16).padStart(2, '0')).join(''); }
function b64url(bytes) { let s = ''; for (const b of bytes) s += String.fromCharCode(b); return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
function b64urlDecode(s) { s = s.replace(/-/g, '+').replace(/_/g, '/'); while (s.length % 4) s += '='; const bin = atob(s); return Uint8Array.from(bin, c => c.charCodeAt(0)); }
function timingSafeEqual(a, b) { if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false; let r = 0; for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i); return r === 0; }
