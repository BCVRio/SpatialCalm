#!/usr/bin/env node
/**
 * One-command connection of the Resonance paywall to the BCVR Stripe + Cloudflare accounts.
 * Idempotent: re-running finds what already exists and only fills the gaps.
 *
 *   STRIPE_SECRET_KEY=sk_live_… CLOUDFLARE_API_TOKEN=… CLOUDFLARE_ACCOUNT_ID=… node api/connect.mjs
 *
 * Optional env:  APP_ORIGIN=https://<project>.zapworks.app   (added to APP_ORIGINS)
 *                RESEND_API_KEY=re_…   MAIL_FROM="Resonance <resonance@bcvr.io>"
 *                AUTH_SECRET=…         (otherwise generated once and kept in api/.connect.local.json)
 *                STRIPE_WEBHOOK_SECRET=whsec_… (only needed if the webhook endpoint already exists)
 * Flags:         --dry-run   show the plan without touching Stripe or Cloudflare
 *
 * Steps: Stripe product + £3.99/month price → Billing Portal configuration → KV namespaces →
 *        wrangler deploy → Stripe webhook endpoint → Worker secrets → index.html RZ_CONFIG.api → zip
 */
import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const API_DIR = path.dirname(fileURLToPath(import.meta.url)), ROOT = path.resolve(API_DIR, '..');
const DRY = process.argv.includes('--dry-run');
const env = process.env;
const log = (...a) => console.log('›', ...a);
const die = m => { console.error('✗', m); process.exit(1); };

const PRODUCT_NAME = 'Resonance Plus', PRICE = { currency: 'gbp', unit_amount: 399, interval: 'month' };
const WEBHOOK_EVENTS = ['checkout.session.completed', 'customer.subscription.created', 'customer.subscription.updated', 'customer.subscription.deleted', 'invoice.payment_failed'];

if (!DRY) for (const k of ['STRIPE_SECRET_KEY', 'CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID']) if (!env[k]) die(`${k} is not set (add it to the environment, never paste it in chat)`);
const live = (env.STRIPE_SECRET_KEY || '').startsWith('sk_live_');
log(DRY ? 'DRY RUN — nothing will be changed' : `connecting to Stripe (${live ? 'LIVE' : 'test'} mode) and Cloudflare account ${env.CLOUDFLARE_ACCOUNT_ID}`);

// local state that must survive re-runs (gitignored)
const STATE_FILE = path.join(API_DIR, '.connect.local.json');
const state = existsSync(STATE_FILE) ? JSON.parse(readFileSync(STATE_FILE, 'utf8')) : {};
const saveState = () => writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));

// ---------- helpers ----------
const form = o => Object.entries(o).flatMap(([k, v]) => Array.isArray(v) ? v.map((x, i) => [`${k}[${i}]`, x]) : typeof v === 'object' && v ? Object.entries(v).map(([k2, v2]) => [`${k}[${k2}]`, v2]) : [[k, v]]).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
async function stripe(method, p, params) {
  if (DRY) { log(`  (dry) stripe ${method} ${p}`, params ? JSON.stringify(params) : ''); return method === 'GET' ? { data: [] } : { id: `${p.split('/').pop()}_dry`, url: 'https://dry.example', secret: 'whsec_dry' }; }
  const r = await fetch('https://api.stripe.com' + p + (method === 'GET' && params ? '?' + form(params) : ''), { method, headers: { Authorization: 'Bearer ' + env.STRIPE_SECRET_KEY, 'Stripe-Version': '2024-06-20', ...(method !== 'GET' ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}) }, body: method !== 'GET' && params ? form(params) : undefined });
  const j = await r.json(); if (!r.ok) die(`Stripe ${method} ${p}: ${j.error && j.error.message}`); return j;
}
const sh = (cmd, opts = {}) => { log('  $', cmd.replace(/(sk_(live|test)_|whsec_|re_)[A-Za-z0-9]+/g, '$1…')); if (DRY) return ''; return execSync(cmd, { cwd: API_DIR, stdio: ['ignore', 'pipe', 'inherit'], env: { ...env }, ...opts }).toString(); };
const wrangler = (args, opts) => sh(`npx --yes wrangler@3 ${args}`, opts);

// ---------- 1. Stripe product + price ----------
log('1/8 Stripe product and price');
let product = (await stripe('GET', '/v1/products/search', { query: `name:'${PRODUCT_NAME}' AND active:'true'`, limit: 1 })).data[0];
if (!product) product = await stripe('POST', '/v1/products', { name: PRODUCT_NAME, description: 'All 8 moods, 6 nature layers, singing bowl, binaural bands, breath guide and 60-minute sessions in Resonance.', metadata: { app: 'resonance' } });
log(`  product ${product.id}`);
let price = (await stripe('GET', '/v1/prices', { product: product.id, active: true, limit: 100 })).data.find(p => p.currency === PRICE.currency && p.unit_amount === PRICE.unit_amount && p.recurring && p.recurring.interval === PRICE.interval);
if (!price) price = await stripe('POST', '/v1/prices', { product: product.id, currency: PRICE.currency, unit_amount: PRICE.unit_amount, recurring: { interval: PRICE.interval }, nickname: 'Resonance Plus monthly', metadata: { app: 'resonance' } });
log(`  price ${price.id} (£3.99 / month)`);

// ---------- 2. Billing Portal configuration (Settings → Manage) ----------
log('2/8 Stripe Billing Portal configuration');
const portals = (await stripe('GET', '/v1/billing_portal/configurations', { is_default: true, limit: 1 })).data;
if (!portals.length) {
  await stripe('POST', '/v1/billing_portal/configurations', { business_profile: { headline: 'Manage your Resonance Plus subscription' }, features: { subscription_cancel: { enabled: true, mode: 'at_period_end' }, payment_method_update: { enabled: true }, invoice_history: { enabled: true } }, default_return_url: env.APP_ORIGIN || undefined });
  log('  created default portal configuration');
} else log(`  default portal configuration exists (${portals[0].id})`);

// ---------- 3. KV namespaces ----------
log('3/8 Workers KV namespaces');
const tomlPath = path.join(API_DIR, 'wrangler.toml'); let toml = readFileSync(tomlPath, 'utf8');
const kvList = DRY ? [] : JSON.parse(wrangler('kv namespace list') || '[]');
const ensureKv = async (title, preview) => { let ns = kvList.find(n => n.title === title); if (!ns) { const out = wrangler(`kv namespace create SUBS${preview ? ' --preview' : ''}`); const m = /(?:id|preview_id)\s*=\s*"([0-9a-f]{32})"/.exec(out); ns = { id: m ? m[1] : 'DRY', title }; } return ns.id; };
const kvId = await ensureKv('resonance-api-SUBS', false), kvPrev = await ensureKv('resonance-api-SUBS_preview', true);
toml = toml.replace(/id = "[^"]*", preview_id = "[^"]*"/, `id = "${kvId}", preview_id = "${kvPrev}"`);
if (env.APP_ORIGIN) { const m = /APP_ORIGINS = "([^"]*)"/.exec(toml); const set = new Set((m ? m[1] : '').split(',').map(s => s.trim()).filter(Boolean)); set.add(env.APP_ORIGIN.replace(/\/$/, '')); toml = toml.replace(/APP_ORIGINS = "[^"]*"/, `APP_ORIGINS = "${[...set].join(',')}"`); }
if (env.MAIL_FROM) toml = toml.replace(/MAIL_FROM = "[^"]*"/, `MAIL_FROM = "${env.MAIL_FROM}"`);
if (!DRY) writeFileSync(tomlPath, toml); log(`  SUBS ${kvId} / preview ${kvPrev}`);

// ---------- 4. Deploy the Worker ----------
log('4/8 wrangler deploy');
const deployOut = wrangler('deploy');
const workerUrl = DRY ? 'https://resonance-api.example.workers.dev' : (/(https:\/\/[^\s]+\.workers\.dev)/.exec(deployOut) || [])[1];
if (!workerUrl) die('could not read the Worker URL from wrangler output');
log(`  ${workerUrl}`);

// ---------- 5. Stripe webhook endpoint ----------
log('5/8 Stripe webhook endpoint');
const hookUrl = workerUrl + '/api/webhook';
let hook = (await stripe('GET', '/v1/webhook_endpoints', { limit: 100 })).data.find(h => h.url === hookUrl);
let webhookSecret = env.STRIPE_WEBHOOK_SECRET || state.webhookSecret;
if (!hook) { hook = await stripe('POST', '/v1/webhook_endpoints', { url: hookUrl, enabled_events: WEBHOOK_EVENTS, description: 'Resonance billing Worker', metadata: { app: 'resonance' } }); webhookSecret = hook.secret; state.webhookSecret = webhookSecret; log(`  created ${hook.id}`); }
else { const missing = WEBHOOK_EVENTS.filter(e => !hook.enabled_events.includes(e) && !hook.enabled_events.includes('*')); if (missing.length) await stripe('POST', `/v1/webhook_endpoints/${hook.id}`, { enabled_events: [...new Set([...hook.enabled_events, ...WEBHOOK_EVENTS])] }); log(`  exists ${hook.id}`); if (!webhookSecret) log('  ! endpoint already existed and STRIPE_WEBHOOK_SECRET is not set — copy its signing secret from the Stripe dashboard and re-run with STRIPE_WEBHOOK_SECRET=…'); }

// ---------- 6. Worker secrets ----------
log('6/8 Worker secrets');
const authSecret = env.AUTH_SECRET || state.authSecret || (state.authSecret = randomBytes(48).toString('base64'));
if (!env.AUTH_SECRET) saveState();
const secrets = { STRIPE_SECRET_KEY: env.STRIPE_SECRET_KEY, STRIPE_PRICE_ID: price.id, AUTH_SECRET: authSecret, ...(webhookSecret ? { STRIPE_WEBHOOK_SECRET: webhookSecret } : {}), ...(env.RESEND_API_KEY ? { RESEND_API_KEY: env.RESEND_API_KEY } : {}) };
const secretsFile = path.join(API_DIR, '.secrets.tmp.json');
if (!DRY) writeFileSync(secretsFile, JSON.stringify(secrets));
try { wrangler(`secret bulk ${secretsFile}`); } finally { if (existsSync(secretsFile)) execSync(`rm -f ${secretsFile}`); }
log(`  set: ${Object.keys(secrets).join(', ')}`);

// ---------- 7. Point the app at the Worker ----------
log('7/8 index.html → RZ_CONFIG.api');
const indexPath = path.join(ROOT, 'index.html'); let html = readFileSync(indexPath, 'utf8');
html = html.replace(/(window\.RZ_CONFIG = \{ api: ')[^']*(')/, `$1${workerUrl}$2`);
if (!DRY) writeFileSync(indexPath, html); log(`  api: '${workerUrl}'`);

// ---------- 8. Health check + zip ----------
log('8/8 health check and ZapWorks zip');
if (!DRY) { const h = await fetch(workerUrl + '/api/health').then(r => r.json()).catch(e => ({ error: String(e) })); if (!h.ok) die('health check failed: ' + JSON.stringify(h)); log('  /api/health ok'); }
sh('sh tools/make-zip.sh', { cwd: ROOT });

console.log(`
Connected.
  Worker        ${workerUrl}
  Price         ${price.id}
  Webhook       ${hook.id} → ${hookUrl}
  App origins   ${(/APP_ORIGINS = "([^"]*)"/.exec(toml) || [])[1]}
Next: upload dist/resonance-webar-*.zip to ZapWorks, then re-run with APP_ORIGIN=<published origin> if it is not in the list above.
Commit api/wrangler.toml and index.html; api/.connect.local.json stays local (it holds AUTH_SECRET and the webhook secret).`);
