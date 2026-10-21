// Headless smoke test for the WebAR build: walks every screen with a fake camera/mic,
// captures screenshots to tools/out/ and fails on console errors.
// Usage: node tools/smoke.mjs [http://localhost:8080]   (serve the repo root first)
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const BASE = process.argv[2] || 'http://localhost:8080';
const OUT = new URL('./out/', import.meta.url).pathname; mkdirSync(OUT, { recursive: true });
const errors = [];
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined, args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required'] });
const ctx = await browser.newContext({ viewport: { width: 402, height: 874 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, permissions: ['camera', 'microphone'], reducedMotion: 'no-preference' });
const page = await ctx.newPage();
page.on('console', m => { if (m.type() !== 'error') return; const u = (m.location() && m.location().url) || ''; if (/zappar\.js$/.test(u)) return; /* local SDK probe before the CDN fallback */ errors.push(m.text() + (u ? ' @ ' + u : '')); });
page.on('pageerror', e => errors.push('pageerror: ' + e.message));
const shot = n => page.screenshot({ path: OUT + n + '.png' });
const screen = () => page.evaluate(() => document.querySelector('.screen.on').id);
const expect = async (want, step) => { const got = await screen(); if (got !== want) throw new Error(`${step}: expected screen ${want}, got ${got}`); };

async function flow(plan) {
  await page.goto(BASE + (plan === 'plus' ? '/?plan=plus' : '/?plan=free'), { waitUntil: 'load' });
  await page.waitForTimeout(600);
  await expect('intro', 'boot'); await page.waitForTimeout(2500); await shot(`${plan}-01-cover`);
  await page.click('#actBtn'); await page.waitForTimeout(1500); await shot(`${plan}-01b-waking`);
  await page.waitForFunction(() => document.querySelector('.screen.on').id !== 'intro', null, { timeout: 16000 }); // sensors + 10 s sequence
  if (plan === 'free') { await expect('paywall', 'after activation'); await shot(`${plan}-02-paywall`); await page.click('#pwSkip'); }
  await expect('home', 'home'); await shot(`${plan}-03-home`);
  await page.click('nav [data-go="sounds"]'); await expect('sounds', 'sounds'); await shot(`${plan}-06-sounds`);
  await page.click('#moodCards [data-mood="Vale"]');
  if (plan === 'free') { await expect('paywall', 'locked mood gates'); await page.click('#pwClose'); await expect('sounds', 'paywall back'); }
  else { const on = await page.$eval('#moodCards .mcard.on', e => e.dataset.mood); if (on !== 'Vale') throw new Error('plus mood not applied'); }
  await page.click('#layerList [data-layer="Rain"]');
  if (plan === 'free') { await expect('paywall', 'locked layer gates'); await page.click('#pwSkip'); }
  await page.click('nav [data-go="library"]'); await expect('library', 'library'); await shot(`${plan}-07-library`);
  await page.click('nav [data-go="settings"]'); await expect('settings', 'settings'); await shot(`${plan}-08-settings`);
  if (plan === 'free') { // QA unlock: five taps on the version row flips to Plus, five more removes it
    for (let i = 0; i < 5; i++) await page.click('#verRow'); await page.waitForTimeout(200);
    if (!/QA override/.test(await page.textContent('#subDesc'))) throw new Error('QA unlock failed');
    if (!(await page.$$eval('#lenSeg button', b => b.map(x => x.textContent))).includes('60')) throw new Error('QA unlock did not widen lengths');
    for (let i = 0; i < 5; i++) await page.click('#verRow'); await page.waitForTimeout(200);
    if (/QA override/.test(await page.textContent('#subDesc'))) throw new Error('QA unlock did not clear');
  }
  const lens = await page.$$eval('#lenSeg button', b => b.map(x => x.textContent));
  if ((plan === 'plus') !== lens.includes('60')) throw new Error('length options wrong for ' + plan + ': ' + lens);
  await page.click('nav [data-go="home"]'); await page.click('#hScan'); await expect('scan', 'scan'); await page.waitForTimeout(2000); await shot(`${plan}-04-scan`);
  await page.evaluate(() => new Promise(r => { const t = setInterval(() => { if (!document.querySelector('#compose').classList.contains('off')) { clearInterval(t); r(); } }, 200); }));
  await page.click('#compose'); await expect('listen', 'listen'); await page.waitForTimeout(1500); await shot(`${plan}-05-listen`);
  const label = await page.textContent('#stateLabel');
  await page.click('#breathBtn');
  if (plan === 'free') { await expect('paywall', 'breath gates'); await page.click('#pwClose'); await expect('listen', 'paywall back to listen'); }
  else { await page.waitForTimeout(800); const l2 = await page.textContent('#stateLabel'); if (!/INHALE|HOLD|EXHALE/.test(l2)) throw new Error('breath label missing: ' + l2); await shot(`${plan}-05b-breath`); }
  if (plan === 'plus') { await page.waitForTimeout(2500); const n = await page.evaluate(() => RZ.engine().voiceCount(RZ.state.voice)); if (n < 11) throw new Error('breath voice clips not loaded: ' + n); }
  await page.click('#beatBtn'); await page.click('#play'); await page.waitForTimeout(300); if ((await page.textContent('#stateLabel')) !== 'PAUSED') throw new Error('pause label');
  await page.click('#play'); await page.click('#end'); await expect('library', 'finish -> library');
  const n = await page.$$eval('#sessList .sess', s => s.length); if (n < 1) throw new Error('session not saved');
  console.log(`${plan}: ok (label ${label.trim()}, ${n} session(s))`);
}

try {
  await flow('free');
  await flow('plus');
} finally {
  await browser.close();
}
if (errors.length) { console.error('console errors:\n' + errors.join('\n')); process.exit(1); }
console.log('smoke ok →', OUT);
