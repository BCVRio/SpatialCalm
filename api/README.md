# Resonance billing API (Cloudflare Worker)

ZapWorks hosting is static, so Stripe Checkout, the Billing Portal, webhooks and the
magic-link identity live in this Worker. The app talks to it over CORS from the
ZapWorks origin and reads one thing back: the user's `plan`.

```
app ── POST /api/checkout ──▶ Stripe Checkout (subscription, 7-day trial) ──▶ back to app ?checkout=success&session_id=…
app ── GET  /api/me?session_id=… ──▶ resolves customer + subscription, mints bearer token
app ── GET  /api/me (Bearer) ──▶ { plan: 'plus' | 'free', status, trialEnd, currentPeriodEnd, email }
app ── POST /api/portal (Bearer) ──▶ Stripe Billing Portal URL  (Settings → Manage)
app ── POST /api/restore { email } ──▶ emails `<app>?auth=<token>`  (Restore purchase)
Stripe ── POST /api/webhook ──▶ checkout.session.completed, customer.subscription.{created,updated,deleted}, invoice.payment_failed
```

Records live in Workers KV: `user:<email>` → `{ email, stripeCustomerId, subscriptionId, status, trialEnd, currentPeriodEnd, cancelAtPeriodEnd }`
and `cust:<customerId>` → email. `plan` is `plus` while `status` is `trialing` or `active`, and for
`past_due` until `currentPeriodEnd` passes.

Identity is a signed bearer token (HMAC-SHA256 over `{ email, exp }`, 180 days) kept in the app's
localStorage — cookies are avoided on purpose because Safari ITP blocks third-party cookies between
the ZapWorks origin and the Worker. Magic links carry a 30-minute token; opening one signs the device
back in, which is what "Restore purchase" does after a cleared browser or a new phone.

## Setup — same Stripe account as the other BCVR apps

Use the existing BCVR Stripe account (the one behind the BCVR Drama paywall) and the existing
Cloudflare account. Nothing here is Resonance-specific except the product and the Worker name.

1. **Stripe product.** Dashboard → Products → add **Resonance Plus**, recurring, **£3.99 / month** (GBP).
   Copy the `price_…` id. The 7-day trial is set per Checkout session by the Worker (`TRIAL_DAYS`),
   so no trial needs configuring on the price.
2. **Billing Portal.** Settings → Billing → Customer portal: enable cancel + update payment method.
   `Manage` in the app opens this portal.
3. **Worker.**
   ```sh
   cd api
   npm i
   npx wrangler login                          # BCVR Cloudflare account
   npx wrangler kv namespace create SUBS       # paste the ids into wrangler.toml
   npx wrangler kv namespace create SUBS --preview
   npx wrangler secret put STRIPE_SECRET_KEY   # sk_live_… (or sk_test_… for a test deploy)
   npx wrangler secret put STRIPE_PRICE_ID     # price_… from step 1
   npx wrangler secret put AUTH_SECRET         # openssl rand -base64 48
   npx wrangler secret put RESEND_API_KEY      # optional; magic links are logged if absent
   npx wrangler deploy                         # → https://resonance-api.<account>.workers.dev
   ```
   Set `APP_ORIGINS` in `wrangler.toml` to the ZapWorks project origin (and any staging origin).
   The Worker refuses checkout/portal/magic-link return URLs outside this list.
4. **Webhook.** Dashboard → Developers → Webhooks → add endpoint
   `https://resonance-api.<account>.workers.dev/api/webhook` with events
   `checkout.session.completed`, `customer.subscription.created`, `customer.subscription.updated`,
   `customer.subscription.deleted`, `invoice.payment_failed`. Then
   `npx wrangler secret put STRIPE_WEBHOOK_SECRET` with its `whsec_…`.
5. **Email (Resend).** Verify the sending domain, set `MAIL_FROM` in `wrangler.toml`. Without a key
   the Worker still answers `ok` to `/api/restore` and prints the link in `wrangler tail`.
6. **Point the app at it.** In `index.html` set `window.RZ_CONFIG.api` to the Worker origin and
   re-zip for ZapWorks.

## Local development

```sh
cd api && npm i
cat > .dev.vars <<EOF
STRIPE_SECRET_KEY=sk_test_…
STRIPE_PRICE_ID=price_…
STRIPE_WEBHOOK_SECRET=whsec_…
AUTH_SECRET=dev-secret
EOF
npx wrangler dev                       # http://localhost:8787
stripe listen --forward-to localhost:8787/api/webhook
```
Serve the app from the repo root (`npm run serve` → http://localhost:8080, already in `APP_ORIGINS`)
and set `RZ_CONFIG.api = 'http://localhost:8787'`.

`npm test` runs the handler tests with Stripe and KV stubbed (no network, no account needed).

## Entitlements (what `plan` unlocks in the app)

| | Free | Plus |
|---|---|---|
| Moods | Drift, Ember, Tide, Still | all 8 (+ Dawn, Hollow, Lumen, Vale) |
| Nature layers | — | Rain, Ocean, Wind, Fire, Night, Stream |
| Singing bowl, 528 Hz hum, breath guide | — | ✓ |
| Binaural beat, room tone | ✓ | ✓ |
| Session length | 10 / 15 / 20 min | 10 / 15 / 20 / 30 / 60 min |

Gates are enforced client-side from `plan`; the Worker is the source of truth and the app caches
the answer in localStorage (6 h for Plus, 1 h for free) before asking again.
