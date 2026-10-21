# Resonance — WebAR sonic meditation · BCVR Immersive

Mobile WebAR piece for the Zappar platform. The phone camera scans the room; the point cloud, light
level and palette drive a generative ambient score synthesised on-device with Web Audio. **v0.6** adds
the cover screen with generated art and loop, one-tap sensor activation, a Home menu, a Stripe-billed
subscription (Resonance Plus, £3.99/month, 7-day trial) and the expanded soundscape
(8 moods, 6 nature layers, singing bowl, 528 Hz hum, 4 binaural bands, breath guide).

```
index.html            the whole app (HTML/CSS/JS, no bundler) — ZapWorks needs it at the zip root
fonts/                Audiowide, Space Grotesk, JetBrains Mono (bundled)
assets/               cover-pointcloud.jpg, cover-loop.mp4, home-sweep.jpg, paywall-rings.jpg, bcvr-roundel.png
api/                  Cloudflare Worker: Stripe Checkout, Billing Portal, webhooks, magic-link restore
tools/                make-zip.sh (ZapWorks upload), smoke.mjs (headless walk-through)
design/               the v0.6 handoff: spec, reference screenshots, clickable prototype, v0.5 build
```

## Screen flow

```
intro ──Activate──▶ sensor animation (≥3.7 s, real prompts) ──▶ paywall (free) ──▶ home
                                                               └──▶ home (Plus)
home ─▶ scan ─Compose─▶ listen ─End / timer─▶ library
nav (home · sounds · library · settings) on home, scan, sounds, library, settings
any locked tap on the free plan ─▶ paywall, close returns to the screen it came from
```

## Ship to ZapWorks

1. Set `window.RZ_CONFIG.api` at the top of `index.html` to the deployed Worker origin
   (see `api/README.md`). Leave it empty for a billing-free test build.
2. `sh tools/make-zip.sh` → `dist/resonance-webar-<version>.zip` (index.html at the root, as ZapWorks requires).
   Drop Zappar's `zappar.js` (from zappar-js.zip, needs a ZapWorks login) next to `index.html`
   before zipping to make the build self-contained; otherwise it loads from Zappar's CDN.
3. my.zap.works → New project → **Universal AR** → **JavaScript** → trigger (QR is easiest) → Experience → Upload ZIP → Publish.
   Camera and motion need HTTPS; ZapWorks provides it and no licence key is needed when hosted there.
4. Add the published origin to `APP_ORIGINS` in `api/wrangler.toml` and redeploy the Worker.

## Run locally

```sh
npm run serve                 # http://127.0.0.1:8080
npm i && npm run smoke        # headless Chromium: every screen, both plans, screenshots in tools/out/
cd api && npm i && npm test   # Worker handler tests (Stripe + KV stubbed)
```

Test-build conveniences (only when `RZ_CONFIG.api` is empty): `?plan=plus` / `?plan=free` set the plan
locally so the Plus features can be exercised without Stripe.

## What's real in this build

- Zappar camera pipeline + Instant World Tracking (v0.5, unchanged): the point cloud is anchored in
  the room; falls back to the plain browser camera with motion parallax, then to a simulated feed.
- One tap triggers the three browser prompts from the gesture (motion first, then camera, then mic).
  Each disc follows its real promise, with the handoff's timetable as the minimum display time; a
  denied sensor stays `Off` with a pink ring and the app continues.
- Live palette and light level from the camera; mic level shapes the room-tone layer.
- Generative score: sub drone, 6-voice pad, FM bell plucks on the mood scale, reverb, stereo delay;
  nature layers synthesised from shared pink/white noise; singing bowl; 528 Hz hum; binaural beat on
  the second drone oscillator; visual breath guide (Box, 4-7-8) that scales glow and point cloud.
- Sessions saved locally; Resume replays the last session's mood. Preferences persist.
- Subscription: Checkout → return → `/api/me` → plan cached with expiry; Settings → Manage opens the
  Billing Portal; Restore purchase sends a magic link.

## Notes on the port (deviations from the handoff, all deliberate)

- **Safe areas.** The prototype's 72/64 px top and 92/110 px bottom paddings include the iPhone
  status bar and home indicator. The build uses `env(safe-area-inset-*)` plus 24/16 px top and
  16/84 px bottom so the rhythm matches on devices where Safari's chrome already covers those areas.
- **Backdrops ship as JPEG** (~150 KB each instead of ~1.5 MB PNG); the loop is H.264 720×1280, 679 KB,
  `preload="metadata"`, and the poster is used instead under `prefers-reduced-motion` or data-saver.
- **Preview** on the Sounds screen stops when you leave the screen unless a session is playing.
- **Account row** in Settings shows the signed-in email with a sign-out, so QA can switch accounts.
- Library keeps the v0.5 copy ("saved on this device") and adds minutes listened this month.

Known limits are unchanged from v0.5: true LiDAR depth is not exposed to mobile browsers, so depth
is estimated from luminance; a native wrapper or WebXR depth sensing would be needed for real LiDAR.
