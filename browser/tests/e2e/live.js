// End-to-end test of the built browser extension against the REAL Edge Read Aloud service
// (speech.platform.bing.com), in Chromium. Unlike run.js, this sends text to Microsoft, so it is not
// run in CI. Needs Playwright. Uses HTTPS_PROXY if set. Usage:
//   node browser/tests/e2e/live.js [--voice <name>] [--runs <n>] [--root <checkout>] [--json]
//
// Checks that the real service accepts the extension's requests (the Edge headers set by
// declarativeNetRequest, the token), that the voice list loads, and that a page is read to the
// end with word highlighting. Measures, from the audio element in the player itself: time from
// "start" to the first sound, silence between and inside sentences, and sentences that failed.
// The article is generated fresh each run: the service caches audio for text it has seen.
//
// Headless Chromium never counts as audible, so it closes the player 30 s after it opens: each
// read is kept short (about 17 s of speech), with a fresh player each time.
const { chromium } = require('playwright');
const { execSync } = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const assert = require('assert/strict');

const arg = (name, dflt) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : dflt; };
const ROOT = path.resolve(arg('root', path.resolve(__dirname, '../../..')));
const VOICE = arg('voice', null);
const RUNS = Number(arg('runs', 1));
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'read-aloud-live-'));
const PROXY = process.env.HTTPS_PROXY || process.env.https_proxy || '';

// Records what the player's audio element does, and what the player reports to the page.
const PROBE = `(() => {
  const events = [];
  const Real = window.Audio;
  window.Audio = function (...a) {
    const el = new Real(...a);
    for (const ev of ['playing', 'waiting', 'ended']) el.addEventListener(ev, () => events.push({ t: Date.now(), ev }));
    return el;
  };
  window.Audio.prototype = Real.prototype;
  const send = chrome.runtime.sendMessage.bind(chrome.runtime);
  chrome.runtime.sendMessage = (msg, ...rest) => {
    if (msg && msg.to === 'tab' && msg.event !== 'word') events.push({ t: Date.now(), ev: msg.event, idx: msg.idx, state: msg.state, message: msg.message });
    if (msg && msg.event === 'word') events.push({ t: Date.now(), ev: 'word' });
    return send(msg, ...rest);
  };
  chrome.runtime.onMessage.addListener((msg, _s, reply) => { if (msg && msg.to === 'probe') reply(events.splice(0)); });
})();`;

function build() {
  const ext = path.join(TMP, 'ext');
  execSync(`node "${path.join(ROOT, 'scripts/build.mjs')}" --browser "${ext}"`, { stdio: 'ignore' });
  const manifest = JSON.parse(fs.readFileSync(path.join(ext, 'manifest.json'), 'utf8'));
  manifest.host_permissions.push('<all_urls>'); // inject without a user gesture
  fs.writeFileSync(path.join(ext, 'manifest.json'), JSON.stringify(manifest, null, 2));
  fs.writeFileSync(path.join(ext, 'probe.js'), PROBE);
  const html = fs.readFileSync(path.join(ext, 'offscreen.html'), 'utf8');
  fs.writeFileSync(path.join(ext, 'offscreen.html'), html.replace('<script type="module"', '<script src="probe.js"></script>\n<script type="module"'));
  return ext;
}

const VOCAB = ('city council river garden morning letter quiet market simple yellow travel number orange island pencil ' +
  'summer winter forest bridge planet engine window station teacher library careful bright ancient modern small ' +
  'early late often quickly slowly people children workers visitors').split(' ');
const LENGTHS = [10, 12, 8, 11]; // ~17 s of speech, plus a heading
function articleHtml() {
  const pick = () => VOCAB[Math.floor(Math.random() * VOCAB.length)];
  const sentences = LENGTHS.map((n) => {
    const w = Array.from({ length: n }, pick);
    w[0] = w[0][0].toUpperCase() + w[0].slice(1);
    return `${w.join(' ')}.`;
  });
  const heading = `Notes on the ${pick()} ${pick()}`; // read too, as the first sentence
  return { count: sentences.length + 1, html: `<!doctype html><meta charset="utf-8"><title>Live test</title><nav>Home | About</nav>` +
    `<article><h1>${heading}</h1><p>${sentences.slice(0, 2).join(' ')}</p><p>${sentences.slice(2).join(' ')}</p></article>` };
}

// Silence while the player wanted to be playing: before the first sound, between sentences, and
// stalls inside a sentence (audio arriving slower than it plays).
function analyse(events, t0) {
  const out = { firstSoundMs: null, betweenMs: 0, insideMs: 0, gaps: [], played: 0, words: 0, errors: [], ended: false };
  let playing = false;
  let stoppedAt = null;
  let stoppedBy = null;
  for (const e of events) {
    if (e.ev === 'playing') {
      if (out.firstSoundMs == null) out.firstSoundMs = e.t - t0;
      else if (!playing && stoppedAt != null) {
        out[stoppedBy === 'waiting' ? 'insideMs' : 'betweenMs'] += e.t - stoppedAt;
        if (stoppedBy !== 'waiting') out.gaps.push(e.t - stoppedAt);
      }
      if (stoppedBy !== 'waiting') out.played++;
      playing = true;
      stoppedAt = null;
    } else if (e.ev === 'ended' || e.ev === 'waiting') {
      if (playing) { playing = false; stoppedAt = e.t; stoppedBy = e.ev; }
    } else if (e.ev === 'word') out.words++;
    else if (e.ev === 'error') out.errors.push(e.message);
    else if (e.ev === 'end') out.ended = true;
  }
  return out;
}

(async () => {
  const ext = build();
  let article = articleHtml();
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(article.html);
  }).listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const url = `http://127.0.0.1:${server.address().port}/`;
  const ctx = await chromium.launchPersistentContext(path.join(TMP, 'profile'), {
    headless: true, channel: 'chromium', viewport: { width: 1000, height: 700 },
    args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`, '--autoplay-policy=no-user-gesture-required',
      ...(PROXY ? [`--proxy-server=${PROXY}`] : [])],
  });
  const results = [];
  try {
    const sw = ctx.serviceWorkers()[0] || await ctx.waitForEvent('serviceworker');
    const extId = sw.url().split('/')[2];
    const page = await ctx.newPage();
    const ctl = await ctx.newPage();
    await ctl.goto(`chrome-extension://${extId}/popup.html`);
    const send = (msg) => ctl.evaluate((m) => chrome.runtime.sendMessage(m), msg);

    // Voice list from the real service (HTTPS, with the Edge headers and the token).
    let t = Date.now();
    const voices = await send({ to: 'bg', type: 'getVoices', force: true });
    assert.ok(Array.isArray(voices) && voices.length > 100, `voice list: ${JSON.stringify(voices).slice(0, 200)}`);
    const voiceListMs = Date.now() - t;
    const voice = VOICE || (await send({ to: 'bg', type: 'getSettings' })).voice;
    assert.ok(voices.some((v) => v.shortName === voice), `${voice} is in the voice list`);
    await ctl.evaluate(async (v) => { const { settings } = await chrome.storage.local.get('settings'); await chrome.storage.local.set({ settings: { ...settings, voice: v } }); }, voice);
    if (!process.argv.includes('--json')) console.log(`✓ voice list from the real service: ${voices.length} voices in ${voiceListMs} ms`);

    for (let k = 0; k < RUNS; k++) {
      article = articleHtml(); // new words: nothing cached by the service
      await ctl.evaluate(() => chrome.offscreen.closeDocument().catch(() => {})); // fresh player: cold start
      await page.goto(url);
      await page.bringToFront();
      const tabId = await ctl.evaluate(async (u) => (await chrome.tabs.query({ url: u }))[0].id, url);
      const t0 = Date.now();
      await send({ to: 'bg', type: 'start', tabId, mode: 'page' });
      const events = [];
      let highlighted = false;
      for (;;) {
        await page.waitForTimeout(250);
        try { events.push(...(await send({ to: 'probe' })) || []); } catch { /* player not open yet */ }
        highlighted ||= await page.evaluate(() => CSS.highlights.get('read-aloud-word')?.size > 0);
        if (events.some((e) => e.ev === 'end' || e.ev === 'error' || e.ev === 'stopped')) break;
        if (Date.now() - t0 > 29000) break; // headless closes the player at 30 s
      }
      const r = { ...analyse(events, t0), sentences: article.count, highlighted, wallMs: Date.now() - t0 };
      results.push(r);
      if (!process.argv.includes('--json')) {
        console.log(`[browser] ${voice}: first sound ${r.firstSoundMs ?? '-'} ms | silence between sentences ${r.betweenMs} ms, ` +
          `inside sentences ${r.insideMs} ms (gaps: ${r.gaps.join(', ')}) | played ${r.played}/${r.sentences} sentences, ${r.words} words highlighted | ` +
          `${r.ended ? 'read to the end' : 'DID NOT FINISH'} in ${(r.wallMs / 1000).toFixed(1)} s` +
          `${r.errors.length ? ` | errors: ${[...new Set(r.errors)].join('; ')}` : ''}`);
      }
      await send({ to: 'bg', type: 'stopAll' }).catch(() => {});
    }
  } finally {
    await ctx.close();
    server.close();
  }
  if (process.argv.includes('--json')) console.log(JSON.stringify({ voice: VOICE, results }));
  const bad = results.filter((r) => !r.ended || r.errors.length || r.played < r.sentences || !r.highlighted);
  if (bad.length) { console.error(`✗ ${bad.length}/${results.length} reads did not complete cleanly`); process.exit(1); }
  if (!process.argv.includes('--json')) console.log('ALL PASSED');
})().catch((e) => { console.error(e); process.exit(1); });
