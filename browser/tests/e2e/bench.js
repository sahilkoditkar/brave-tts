// Performance benchmark against the local FAKE speech service, with simulated network latency.
// Same requirements as run.js. Usage: node tests/e2e/bench.js [--json]
//
// Measures (median of several runs where it makes sense):
//   - time to first spoken word: cold (browser just started) and warm (read again right after stop)
//   - extraction: time from "start" until the first sentence is requested, on a ~1.5 MB page
//   - gap between sentences: silence between one sentence's audio ending and the next starting
const { chromium } = require('playwright');
const { execSync, spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const HERE = __dirname;
const ROOT = path.resolve(HERE, '../..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'read-aloud-bench-'));
const LOG = path.join(TMP, 'server.log');
const readLog = () => (fs.existsSync(LOG) ? fs.readFileSync(LOG, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : []);
const HANDSHAKE_MS = 300; // typical TLS + WebSocket upgrade to the real service
const FIRST_AUDIO_MS = 150; // typical time until the service sends the first audio
const TONE_S = 1.2;
const median = (a) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };

function setup() {
  execSync(`openssl req -x509 -newkey rsa:2048 -nodes -keyout key.pem -out cert.pem -days 1 -subj "/CN=speech.platform.bing.com" -addext "subjectAltName=DNS:speech.platform.bing.com"`, { cwd: TMP, stdio: 'ignore' });
  execSync(`ffmpeg -loglevel error -y -f lavfi -i "sine=frequency=440:duration=${TONE_S}" -ar 24000 -ac 1 -b:a 48k tone.mp3`, { cwd: TMP });
  const ext = path.join(TMP, 'ext');
  fs.cpSync(ROOT, ext, { recursive: true, filter: (p) => !/[\\/](\.git|tests)([\\/]|$)/.test(p.slice(ROOT.length)) });
  const manifest = JSON.parse(fs.readFileSync(path.join(ext, 'manifest.json'), 'utf8'));
  manifest.host_permissions.push('<all_urls>');
  fs.writeFileSync(path.join(ext, 'manifest.json'), JSON.stringify(manifest, null, 2));
  return ext;
}

(async () => {
  const ext = setup();
  const server = spawn(process.execPath, [path.join(HERE, 'fake-server.mjs')], {
    env: { ...process.env, E2E_TMP: TMP, FAKE_CHUNK_DELAY_MS: '60', FAKE_HANDSHAKE_DELAY_MS: String(HANDSHAKE_MS), FAKE_FIRST_AUDIO_DELAY_MS: String(FIRST_AUDIO_MS) },
    stdio: 'ignore',
  });
  await new Promise((r) => setTimeout(r, 800));
  const ctx = await chromium.launchPersistentContext(path.join(TMP, 'profile'), {
    headless: true, channel: 'chromium', viewport: { width: 1000, height: 700 },
    args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`,
      '--host-resolver-rules=MAP speech.platform.bing.com 127.0.0.1', '--ignore-certificate-errors',
      '--no-proxy-server', '--autoplay-policy=no-user-gesture-required'],
  });
  const results = {};
  try {
    const sw = ctx.serviceWorkers()[0] || await ctx.waitForEvent('serviceworker');
    const extId = sw.url().split('/')[2];
    const page = await ctx.newPage();
    await page.goto('http://127.0.0.1:8080/');
    const ctl = await ctx.newPage();
    await ctl.goto(`chrome-extension://${extId}/popup.html`);
    await page.bringToFront();
    const tabOf = (url) => ctl.evaluate(async (u) => (await chrome.tabs.query({ url: u }))[0].id, url);
    const send = (msg) => ctl.evaluate((m) => chrome.runtime.sendMessage(m), msg);
    const firstWord = (p) => p.waitForFunction(() => CSS.highlights.get('read-aloud-word')?.size > 0, null, { timeout: 15000, polling: 5 });
    const playerGone = (p) => p.waitForFunction(() => !document.querySelector('read-aloud-player'), null, { timeout: 30000 });
    const stopAll = async (p) => { await send({ to: 'bg', type: 'stopAll' }); await playerGone(p); };
    // Headless Chrome never counts as audible, so it closes the audio player 30 s after it starts.
    const freshPlayer = async () => { await ctl.evaluate(() => chrome.offscreen.closeDocument().catch(() => {})); await page.waitForTimeout(100); };
    let tabId = await tabOf('http://127.0.0.1:8080/');

    // 1. Cold start: nothing warmed up yet (no offscreen document, no connection).
    let t0 = Date.now();
    await send({ to: 'bg', type: 'start', tabId, mode: 'page' });
    await firstWord(page);
    results.coldFirstWordMs = Date.now() - t0;
    await stopAll(page);

    // 2. Warm: read again (offscreen player still alive), after the first sentence has arrived.
    await freshPlayer();
    await send({ to: 'bg', type: 'start', tabId, mode: 'page' });
    await firstWord(page);
    await page.waitForTimeout(1500);
    await stopAll(page);
    const warm = [];
    for (let k = 0; k < 5; k++) {
      await page.waitForTimeout(300);
      t0 = Date.now();
      await send({ to: 'bg', type: 'start', tabId, mode: 'page' });
      await firstWord(page);
      warm.push(Date.now() - t0);
      await page.waitForTimeout(1500);
      await stopAll(page);
    }
    results.warmFirstWordMs = median(warm);
    if (process.env.BENCH_TRACE) {
      await page.waitForTimeout(300);
      fs.writeFileSync(LOG, '');
      await page.evaluate(() => {
        window.__tr = []; const t0 = performance.now(); let s = 0;
        window.__iv = setInterval(() => {
          const st = (document.querySelector('read-aloud-player') ? 1 : 0) + (CSS.highlights.get('read-aloud-sentence')?.size ? 2 : 0) + (CSS.highlights.get('read-aloud-word')?.size ? 4 : 0);
          if (st !== s) { s = st; window.__tr.push([Math.round(performance.now() - t0), st]); }
        }, 2);
      });
      const tt = Date.now();
      await send({ to: 'bg', type: 'start', tabId, mode: 'page' });
      await firstWord(page);
      console.log('trace (ms, state bits: 1 player 2 sentence 4 word):', JSON.stringify(await page.evaluate(() => window.__tr)));
      console.log('server:', readLog().map((e) => `${e.type}@${e.t - tt}${e.text ? ':' + e.text.slice(0, 20) : ''}`).join(' '));
      await stopAll(page);
    }

    // 3. Gaps between sentences: watch the sentence highlight move (main world can read CSS.highlights).
    await freshPlayer();
    await page.evaluate(() => {
      window.__changes = [];
      let last = null;
      const tick = () => {
        const h = CSS.highlights.get('read-aloud-sentence');
        const s = h && h.size ? [...h].map(String)[0] : null;
        if (s && s !== last) { last = s; window.__changes.push(performance.now()); }
      };
      window.__poll = setInterval(tick, 2);
    });
    await send({ to: 'bg', type: 'start', tabId, mode: 'page' });
    await playerGone(page);
    const changes = await page.evaluate(() => { clearInterval(window.__poll); return window.__changes; });
    const intervals = changes.slice(1).map((t, k) => t - changes[k]);
    // Each sentence is one tone; the interval minus the tone length is the silence between sentences.
    results.sentenceGapMs = Math.round(median(intervals) - TONE_S * 1000);

    // 4. A ~1.5 MB page: start -> first sentence highlighted (text extraction, splitting, handing
    //    20,000 sentences to the player).
    const big = await ctx.newPage();
    await big.goto('http://127.0.0.1:8080/big');
    await big.bringToFront();
    const bigTab = await tabOf('http://127.0.0.1:8080/big');
    await freshPlayer(); // then one short read, so the connection is open: this measures the page work
    await send({ to: 'bg', type: 'start', tabId: bigTab, mode: 'page' });
    await firstWord(big);
    await page.waitForTimeout(1500);
    await stopAll(big);
    const extract = [];
    for (let k = 0; k < 3; k++) {
      await big.waitForTimeout(300);
      t0 = Date.now();
      await send({ to: 'bg', type: 'start', tabId: bigTab, mode: 'page' });
      await big.waitForFunction(() => CSS.highlights.get('read-aloud-sentence')?.size > 0, null, { timeout: 60000, polling: 5 });
      extract.push(Date.now() - t0);
      await stopAll(big);
    }
    results.bigPageStartMs = median(extract);
    // Alt+click jump on the big page (maps a DOM point to a sentence).
    await send({ to: 'bg', type: 'start', tabId: bigTab, mode: 'page' });
    await firstWord(big);
    const jumpMs = await big.evaluate(async () => {
      const p = document.querySelectorAll('p')[4000];
      p.scrollIntoView({ block: 'center' });
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      const rect = p.getBoundingClientRect();
      const t = performance.now();
      p.dispatchEvent(new MouseEvent('click', { bubbles: true, altKey: true, clientX: rect.left + 5, clientY: rect.top + 5 }));
      for (let i = 0; i < 2000; i++) {
        const h = CSS.highlights.get('read-aloud-sentence');
        if (h && [...h].map(String)[0]?.startsWith('Paragraph 4000')) return performance.now() - t;
        await new Promise((r) => setTimeout(r, 1));
      }
      return -1;
    });
    results.bigPageAltClickMs = Math.round(jumpMs);
    await stopAll(big);
  } finally {
    await ctx.close();
    server.kill();
  }
  if (process.argv.includes('--json')) { console.log(JSON.stringify(results)); return; }
  console.log(`simulated latency: ${HANDSHAKE_MS} ms handshake, ${FIRST_AUDIO_MS} ms to first audio`);
  console.log(`  first word, cold start        ${results.coldFirstWordMs} ms`);
  console.log(`  first word, read again (warm) ${results.warmFirstWordMs} ms`);
  console.log(`  gap between sentences         ${results.sentenceGapMs} ms`);
  console.log(`  1.5 MB page: start -> sentence highlighted ${results.bigPageStartMs} ms`);
  console.log(`  1.5 MB page: alt+click jump   ${results.bigPageAltClickMs} ms`);
})().catch((e) => { console.error(e); process.exit(1); });
