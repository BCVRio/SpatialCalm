# Handoff: Resonance v0.6 — WebAR sonic meditation app (BCVR Immersive)

## Overview
Resonance is a mobile WebAR piece for the Zappar platform. The phone camera (and depth where available) scans the user's room; the point cloud, light level and palette drive a generative ambient score synthesised on-device with Web Audio. v0.6 adds a cover screen with generated art and a video loop, a one-tap sensor activation flow, a Home menu, a Stripe-billed subscription paywall (Resonance Plus, £3.99/month, 7-day trial) and an expanded soundscape (8 moods, 6 nature layers, bowl, 528 Hz hum, 4 binaural bands, breath guide).

Your job: port the v0.6 design into the shipping WebAR build (`build/index.html`, currently v0.5) and add the backend it needs. Ship as a ZapWorks Universal AR (JavaScript) project; see `build/README.txt` for upload steps.

## About the design files
`ResonanceScreen.dc.html` and `Resonance.dc.html` are **design references written in HTML** — a clickable prototype showing intended look and behaviour, not production code. Recreate the screens in the build's existing environment (vanilla HTML/CSS/JS, single `index.html`, no bundler, Zappar Universal AR SDK loaded from CDN). The prototype's **logic class is directly reusable**: the audio engine (`makeEngine`), room point-cloud generator, projection maths, canvas renderers and state machine are plain JS and can be lifted with minimal changes. The v0.5 build already contains the Zappar camera pipeline, instant world tracking, camera colour sampling, mic level and localStorage sessions — keep all of that.

## Fidelity
**High-fidelity.** Colours, type, spacing, copy and motion are final. Match them exactly. Design system: BCVR (black canvas, sunset gradient as a finite accent, Audiowide display, Space Grotesk body, JetBrains Mono eyebrows/metadata, sharp corners).

## Screen flow
```
intro ──Activate──▶ (sensor animation 3.7 s) ──▶ paywall (if not subscribed) ──▶ home
                                                └──▶ home (if subscribed)
home ─▶ scan ─Compose─▶ listen ─End/timer─▶ library
nav (home / sounds / library / settings) visible on: home, scan, sounds, library, settings
any locked tap (free plan) ─▶ paywall, with `back` = the screen it came from
```

## Screens

### 01 Intro / cover (`screen: intro`)
- Full-bleed `<video>` loop (`assets/cover-loop.mp4`, poster `assets/cover-pointcloud.png`), `object-fit: cover`, `autoplay muted loop playsinline`.
- Overlay gradient: `linear-gradient(180deg, rgba(0,0,0,.55) 0%, transparent 22%, transparent 40%, rgba(0,0,0,.92) 66%, #000 100%)`.
- Padding 72px top / 24px sides / 44px bottom. Top row: roundel 36px (rotating 8 s linear infinite) left, eyebrow `WebAR · Zappar` right.
- Bottom-anchored block: eyebrow `01 — Scan to sound` (JetBrains Mono 12px, 0.18em, uppercase, #9B9BAE); H1 `RESONANCE` Audiowide 46px/1, gradient text `linear-gradient(180deg,#6840E8 0%,#BD31D6 18%,#F742C5 38%,#FF4A88 50%,#FF6A3D 70%,#FF8410 85%,#FFC845 100%)`; body 16px #C9C9D6 max 30ch: "Your room, rendered as sound. We scan the space around you and compose a slow ambient score from its shape, light, and colour."
- Sensor row (margin-top 28px): 3-col grid, gap 12. Each: 64px disc (ring layer + 2px inset black disc with 22px Lucide-style icon: camera / mic / scan-corners), label 13px/500, sublabel mono 10px uppercase (`Off` → `Waking` → `Live`).
- Primary CTA (margin-top 24px): 1px gradient border `linear-gradient(135deg,#3096FB,#834AE7,#CB13A9)`, black fill, 15px padding, 15px/500 text with a 6px status dot. Label states: `Activate camera, mic and depth` → `Waking the sensors` → `Sensors live`. Dot: #3096FB → #F742C5 → #25E0A1. While waking: `box-shadow: 0 0 28px rgba(247,66,197,.35)`.
- Footer mono 11px #3F3F50: `One tap · Camera, mic and depth · No install`.

**Activation animation** (one tap triggers all three permission requests):
| t (ms) | event |
|---|---|
| 0 | act=1, CTA label → "Waking the sensors", glow on |
| 120 | camera disc → waking: ring `conic-gradient(from 0deg,#3096FB,#834AE7,#CB13A9,transparent 72%)` spinning 1.1 s linear; icon #ECECF2 |
| 880 | camera → live: ring `linear-gradient(135deg,#3096FB,#834AE7)` solid, label "Live" |
| 1020 / 1780 | microphone waking / live |
| 1920 / 2680 | depth waking / live |
| 2900 | act=2, CTA "Sensors live", dot green |
| 3700 | navigate → paywall (free) or home (subscribed) |

In the real build, call `getUserMedia({video, audio})` and `DeviceMotionEvent.requestPermission()` from the tap handler (user gesture required). Drive each disc's state from the actual promise resolution instead of the fixed timetable; keep the fixed timings as the *minimum* display time so the animation reads. If a permission is denied, leave that disc at `Off` with a #F742C5 ring and let the user continue (camera-less fallback exists in v0.5).

### 02 Paywall (`screen: paywall`)
- Backdrop image `assets/paywall-rings.png` 402×520 at top, `object-position: center 30%`; gradient overlay `rgba(0,0,0,.5) 0%, transparent 20%, rgba(0,0,0,.6) 38%, #000 56%`.
- Header: eyebrow `Resonance Plus` left; close X (20px) right → goes back to `back` screen.
- Bottom block: H1 Audiowide 34px/1.04 `EVERY ROOM, EVERY MOOD` (two lines). Three benefit rows, 15px #C9C9D6 with `◆` #F742C5 bullet, gap 12:
  1. All 8 moods and 6 nature layers — rain, ocean, forest wind, fire, night, stream
  2. Singing bowl, three binaural bands and guided breath
  3. Sessions up to 60 minutes, every one saved as an artefact
- Price row (margin-top 28): `£3.99` mono 36px, `/ MONTH` mono 12px #9B9BAE, right-aligned pill `7 DAYS FREE` mono 10px #25E0A1, border `rgba(37,224,161,.35)`, radius 999, padding 4/10.
- CTA `Start free trial`: 1px border `linear-gradient(180deg,#6840E8,#F742C5 50%,#FFC845)` (the one full-gradient moment on this screen), black fill. Hover glow `0 0 28px rgba(247,66,197,.4)`.
- Secondary `Continue with the free plan`: 14px/500 #9B9BAE, 1px #2A2A38 border, 13px padding.
- Footer links mono 10px #3F3F50: `Restore purchase · Terms · Privacy`. Legal 11px #3F3F50: "Billed monthly after the trial via Stripe. Cancel anytime from Settings."

### 03 Home (`screen: home`)
- Backdrop `assets/home-sweep.png` 402×480, `object-position: center 60%`; overlay `rgba(0,0,0,.6) 0%, rgba(0,0,0,.1) 24%, rgba(0,0,0,.75) 42%, #000 54%`.
- Padding 64/24/110. Header: roundel 32px; plan pill right (mono 10px, radius 999, padding 4/10): free → `FREE PLAN` #9B9BAE border #2A2A38; subscribed → `PLUS · TRIAL` #FFC845 border `rgba(255,200,69,.35)`.
- margin-top 150: eyebrow greeting (`Good morning` / `Good afternoon` / `Good evening` by local hour), H1 Audiowide 30px `WHERE ARE YOU LISTENING?`.
- Primary tile `Scan a new room` (margin-top 24): gradient-border card, 18px padding, title 17px/500, sub 13px #9B9BAE `About 14 seconds · {mood} · {length} min`, arrow icon right.
- 2×2 grid (gap 10) of cards #14141C, 1px `rgba(255,255,255,.06)`, radius 4, padding 16, `inset 0 1px 0 rgba(255,255,255,.05)`; hover border #3F3F50. Each has a 10px-tall glyph row, then title 15px/500 and sub 12px #6B6B7E:
  - **Sounds** — six 10px dots (#3096FB #FF7B10 #7859EB #F742C5 #FFC845 #25E0A1); sub `{mood} · {layers or "no layers"}` (subscribed) / `{mood} · 4 of 8 moods` (free)
  - **Library** — four 16×10 swatches (#1E2A44 #6B4A3A #2B3A2E #3A2E4A); sub `{n} sessions`
  - **Resume** — 28×10 bar in the last session's gradient; sub `{last.name} · {last.mood}`; tap → scan with that mood
  - **Settings** — mono text `{beat} · {hz} Hz`; sub `{length} min · {density} density`

### 04 Live scan (`screen: scan`) — unchanged from v0.5
Keep the v0.5 build's implementation (Zappar camera, point cloud, sweep band, stats panel, Compose CTA gated at 60 % coverage).

### 05 Listening (`screen: listen`)
Changes from v0.5:
- Mood chips are now a horizontally scrolling row (8 chips, `overflow:auto`, hidden scrollbar, 24px side padding). Chip: 1px border (active gradient `135deg,#3096FB,#834AE7,#CB13A9`, inactive #2A2A38), black fill, 8/14 padding, 13px/500, a 6px dot in the mood hue, and a 10px lock icon on locked moods.
- New layer row under the chips: centred wrapping pills `Rain Ocean Wind Fire Night Stream`, 12px/500, 1px border (#3096FB on, #2A2A38 off), text #ECECF2 on / #6B6B7E off, 9px lock when free.
- Transport: left button cycles binaural (`No beat` / `Delta 2 Hz` / `Theta 4 Hz` / `Alpha 10 Hz`), centre 64px play/pause, right cycles breath (`No breath` / `Breath Box` / `Breath 4-7-8`). Inactive label colour #3F3F50.
- Ring label under the clock shows the mood name, or while a breath guide is active: `INHALE · 4`, `HOLD · 3`, `EXHALE · 8` counting down.
- Canvas: breath phase `breathK` (0–1) scales the glow radius (+80px), glow alpha (+.06) and zooms the point cloud (−6 %).

### 06 Sounds (`screen: sounds`) — new
- Padding 72/24/110, scrolling. Header: eyebrow `03 — Soundscape`, H1 `SOUNDS` 32px; right-aligned `Preview` pill button (play/pause glyph, 1px #3F3F50 border, radius 999) that starts/stops the engine without a session timer.
- Intro 14px #9B9BAE: "Pick a mood for the score, then fold in nature and tone layers. Everything is synthesised live from the room scan."
- Section eyebrow mono 10px #6B6B7E `MOOD · THE SCORE`; 2-col grid gap 8 of mood cards: 1px border (active gradient / inactive `rgba(255,255,255,.06)`), #14141C fill, 14px padding, min-height 92, hue dot 10px with `0 0 10px` glow top-left, lock top-right, name 15px/500, description 12px #6B6B7E.
- `NATURE · LAYERS` list card: 6 rows, name + description + 44×26 toggle (track #3096FB on / #2A2A38 off, 20px thumb, thumb easing `cubic-bezier(.5,1.6,.4,1)` 220 ms). Free plan shows a `PLUS` tag (mono 9px #F742C5) and tapping opens the paywall.
- `TONES & GUIDES` card: Binaural segmented control (`Off / Delta 2Hz / Theta 4Hz / Alpha 10Hz`, active #2A2A38 fill); Breath guide segmented (`Off / Box / 4-7-8`, Plus); Singing bowl toggle (Plus); 528 Hz hum toggle (Plus); Room tone toggle (free).

### 07 Library — unchanged (eyebrow now `04 — Sessions`).

### 08 Settings
- New top section `SUBSCRIPTION`: card with 1px border (gradient `135deg,#6840E8,#F742C5,#FFC845` when subscribed / hairline when free). Free: `Free plan` / `4 moods · 20 min sessions · no layers` / tag `UPGRADE` #F742C5. Plus: `Resonance Plus` / `£3.99 / month · trial ends {date}` / tag `MANAGE` #9B9BAE. Tap → paywall (free) or Stripe customer portal (Plus).
- `SESSION`: default mood as wrapping chips (8); session length segmented `10 15 20` (free) or `10 15 20 30 60` (Plus).
- Binaural / room tone toggles moved to Sounds. Version string `Resonance 0.6 · BCVR Immersive`.

### Bottom nav (home, scan, sounds, library, settings)
Height 92, padding 0 16 26, 4-col grid, `rgba(0,0,0,.7)` + `blur(20px) saturate(140%)`, hairline top border. Each item: 4px dot (#F742C5 when active, else transparent), 20px 1.5-stroke icon (home / equaliser bars / 2×2 grid / sliders), mono 9px 0.18em uppercase label. Colour #ECECF2 active, #6B6B7E inactive. Minimum hit area 44px.

## Subscription — Stripe Checkout
- Product: **Resonance Plus**, recurring £3.99/month GBP, `trial_period_days: 7`. (Optional later: annual plan.)
- Flow: `Start free trial` → `POST /api/checkout` → create Checkout Session (`mode: subscription`, `payment_method_collection: always`, `success_url: <app>/?checkout=success&session_id={CHECKOUT_SESSION_ID}`, `cancel_url: <app>/?checkout=cancel`) → redirect. On return, `GET /api/me` resolves plan from the stored customer. Zappar hosting is static, so the API must live elsewhere (Cloudflare Worker / Vercel function); set CORS for the zapworks origin.
- Webhooks to handle: `checkout.session.completed`, `customer.subscription.updated`, `customer.subscription.deleted`, `invoice.payment_failed`. Persist `{ userId, stripeCustomerId, status, trialEnd, currentPeriodEnd }`.
- Identity: WebAR has no app-store account. Use a lightweight magic-link email login (or Stripe's customer email + a signed cookie) so purchases survive a cleared browser. `Restore purchase` = re-send magic link.
- `Manage` in Settings → Stripe Billing Portal session.
- Entitlement gates (client reads `plan`): moods Dawn/Hollow/Lumen/Vale; all six nature layers; singing bowl; 528 Hz hum; breath guide; session lengths 30 and 60. Free: Drift/Ember/Tide/Still, 10/15/20 min, binaural and room tone.
- Trial copy: pill `7 DAYS FREE`; Settings shows `trial ends {trialEnd}`.

## Audio engine additions (lift from `ResonanceScreen.dc.html` → `makeEngine`)
- `MOODS` table now has 8 entries: `{ root, chord[], scale[], gap[a,b], cut, hue, desc }`. New: Dawn (65.41 Hz, major 9/13), Hollow (61.74, dorian), Lumen (87.31, whole-tone), Vale (58.27, pentatonic).
- Nature layers (all synthesised, no samples): shared 4 s pink and white noise buffers; each layer is a filter chain + gain into master, faded with `setTargetAtTime(v, now, 1.5)`. Rain = white → HP 1.5 kHz → LP 7 kHz + random 50 ms sine blips 2.2–4.8 kHz; Ocean = pink → LP 500 Hz with 0.07 Hz LFO on cutoff and tremolo; Wind = pink → BP 500 Hz with two LFOs; Fire = pink → LP 320 Hz + random band-passed noise bursts; Night = pink → LP 260 Hz + 6 % chance per 60 ms of a 3.9–4.4 kHz chirp train; Stream = white → BP 1.3 kHz (1.3 Hz + 0.21 Hz LFOs) → LP 4.2 kHz + blips. Event scheduler runs on a 60 ms `setInterval`.
- Singing bowl: 4 partials (1, 2.76, 5.4, 8.9) × 2 slightly detuned sines, 9 s decay, into the reverb bus; struck every 15–20 s on the mood root ×4.
- 528 Hz hum: 528 + 264 Hz sines, 0.25 Hz tremolo, gain .02 into bus.
- Binaural: second drone oscillator at `root/2 + beatHz`; beat ∈ {0, 2, 4, 10}.
- Breath guide is visual only (no audio), phase table `Box [4,4,4,4]`, `4-7-8 [4,7,8,0]`.
- `E.setLayer(name, bool)`, `E.setBowl`, `E.setHum`, `E.setBeat(hz)`, `E.stop()` (clears the interval) are the new API surface.

## State
```
screen: intro|paywall|home|scan|listen|sounds|library|settings
back: screen to return to from paywall
act: 0|1|2             sensor activation phase
cam|mic|motion: false|'on'|true
sub: boolean           from /api/me; cache in localStorage with expiry
mood, length (10|15|20|30|60), beat (Off|Delta|Theta|Alpha), breath (Off|Box|4-7-8)
layers: {Rain,Ocean,Wind,Fire,Night,Stream: boolean}
bowl, hum, roomtone: boolean
coverage 0–1, playing, preview, remaining (s), sessions[], sessionNo, density
```

## Design tokens
Colours: ink #000 / #0A0A0F / #14141C (card) / #2A2A38 / #3F3F50; text #ECECF2 / #C9C9D6 / #9B9BAE / #6B6B7E / #3F3F50 (disabled); brand blue #3096FB, indigo #834AE7, magenta #CB13A9, pink #F742C5, orange #FF7B10, gold #FFC845, violet #6840E8, success #25E0A1. Hairline `rgba(255,255,255,.06)`.
Gradients: wordmark (vertical, 7 stops above); cool CTA `135deg,#3096FB,#834AE7,#CB13A9`; Plus `135deg,#6840E8,#F742C5,#FFC845`.
Type: Audiowide 400 (display, uppercase); Space Grotesk 300–700 (body 15/1.5; UI 13–17); JetBrains Mono 400–600 (eyebrows 10–12px, 0.18em uppercase; numerals 18–40px). Fonts are bundled in `build/fonts/`.
Radii: 0 (buttons, panels), 4 (cards), 999 (pills, toggles), 50 % (discs).
Motion: ease `cubic-bezier(.16,1,.3,1)`; 120 ms hover, 220 ms state, 420 ms screen entry (fade + 12px rise); toggle thumb `cubic-bezier(.5,1.6,.4,1)`. No scale transforms; press = `brightness(.92)` + 1px translateY.

## Assets (in `assets/` of this bundle)
Generated with Higgsfield (GPT Image 2 for stills, Seedance 2.0 for the loop) from the BCVR gradient. Download from the URLs in `assets/SOURCES.txt` into `build/assets/` as the filenames below; the hosted URLs may expire.
- `cover-pointcloud.png` — intro poster (9:16)
- `cover-loop.mp4` — 5 s intro loop; transcode to H.264 ≤ 2 MB, 720×1280, add `preload="metadata"`, fall back to the poster on `prefers-reduced-motion` or data-saver
- `home-sweep.png` — Home backdrop
- `paywall-rings.png` — Paywall backdrop
- `bcvr-roundel.png` — existing brand mark (already in build)
Icons: Lucide-style 1.5px strokes drawn inline as SVG in the prototype; copy them verbatim.

## Screenshots (`screenshots/`, 402×874, free plan, mood Still)
01-cover · 02-paywall · 03-home · 04-scan · 05-listen · 06-sounds · 07-library · 08-settings. The cover capture shows a black background because the cross-origin video frame could not be rasterised; the real screen has `cover-loop.mp4` playing behind the type (see `assets/SOURCES.txt`).

## Files in this bundle
- `ResonanceScreen.dc.html` — the full clickable prototype; the `<script data-dc-script>` block holds the reusable JS (engine, renderers, state)
- `Resonance.dc.html` — the canvas that lays out all screens (turn 2 = v0.6, turn 1 = v0.5 for reference)
- `build/` — the shipping v0.5 WebAR build to extend (`index.html`, `README.txt`, fonts)
- `assets/SOURCES.txt` — Higgsfield URLs for the generated art and video

## Added after handoff (v0.6 build)
- `assets/cover-intro.mp4` / `.webm` — 10 s intro sequence (Higgsfield Seedance 2.5, image-to-video from `cover-pointcloud`), job `100b6111-4a76-470b-8ba4-f7ba6ee4c7f6`; alternate take `0e398a89-bf36-462c-9db8-be50aa4043aa`. Plays once over the cover while the type reveals on a timeline, then crossfades to `cover-loop`.
