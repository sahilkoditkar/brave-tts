// End-to-end test against a local FAKE of the Edge speech service — nothing is sent to Microsoft.
// Requires: Linux/macOS, node 18+, `npm i playwright`, openssl, ffmpeg, and permission to bind port 443
// (run as root or with CAP_NET_BIND_SERVICE). Usage: node tests/e2e/run.js
const { chromium } = require('playwright');
const { execSync, spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert/strict');

const HERE = __dirname;
const ROOT = path.resolve(HERE, '../..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'read-aloud-e2e-'));
const LOG = path.join(TMP, 'server.log');
const readLog = () => (fs.existsSync(LOG) ? fs.readFileSync(LOG, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : []);
const ssmlTexts = () => readLog().filter((e) => e.type === 'ssml').map((e) => e.text);

function setup() {
  execSync(`openssl req -x509 -newkey rsa:2048 -nodes -keyout key.pem -out cert.pem -days 1 -subj "/CN=speech.platform.bing.com" -addext "subjectAltName=DNS:speech.platform.bing.com"`, { cwd: TMP, stdio: 'ignore' });
  execSync('ffmpeg -loglevel error -y -f lavfi -i "sine=frequency=440:duration=1.2" -ar 24000 -ac 1 -b:a 48k tone.mp3', { cwd: TMP });
  // Test copy of the extension with <all_urls> so it can be injected without a user gesture.
  const ext = path.join(TMP, 'ext');
  fs.cpSync(ROOT, ext, { recursive: true, filter: (p) => !/[\\/](\.git|tests)([\\/]|$)/.test(p.slice(ROOT.length)) });
  const manifest = JSON.parse(fs.readFileSync(path.join(ext, 'manifest.json'), 'utf8'));
  manifest.host_permissions.push('<all_urls>');
  fs.writeFileSync(path.join(ext, 'manifest.json'), JSON.stringify(manifest, null, 2));
  return ext;
}

(async () => {
  const ext = setup();
  // 250 ms between audio chunks: a sentence takes ~1 s to arrive, like the real streaming service.
  const server = spawn(process.execPath, [path.join(HERE, 'fake-server.mjs')], { env: { ...process.env, E2E_TMP: TMP, FAKE_CHUNK_DELAY_MS: '250' }, stdio: 'inherit' });
  await new Promise((r) => setTimeout(r, 800));
  const ctx = await chromium.launchPersistentContext(path.join(TMP, 'profile'), {
    headless: true, channel: 'chromium', viewport: { width: 1000, height: 700 },
    args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`,
      '--host-resolver-rules=MAP speech.platform.bing.com 127.0.0.1', '--ignore-certificate-errors',
      '--no-proxy-server', '--autoplay-policy=no-user-gesture-required'],
  });
  try {
    const sw = ctx.serviceWorkers()[0] || await ctx.waitForEvent('serviceworker');
    const extId = sw.url().split('/')[2];
    const page = await ctx.newPage();
    await page.goto('http://127.0.0.1:8080/');
    await page.waitForTimeout(800);
    const ctl = await ctx.newPage();
    await ctl.goto(`chrome-extension://${extId}/popup.html`);
    await page.bringToFront();
    const tabId = await ctl.evaluate(async () => (await chrome.tabs.query({ url: 'http://127.0.0.1:8080/*' }))[0].id);
    const send = (msg) => ctl.evaluate((m) => chrome.runtime.sendMessage(m), msg);
    const sentence = () => page.evaluate(() => { const h = CSS.highlights.get('read-aloud-sentence'); return h ? [...h].map(String)[0] : null; });
    const playerGone = () => page.waitForFunction(() => !document.querySelector('read-aloud-player'), null, { timeout: 20000 });

    // Read whole page
    await send({ to: 'bg', type: 'start', tabId, mode: 'page' });
    await playerGone();
    assert.deepEqual([...new Set(ssmlTexts())], [
      'The Quiet Lighthouse',
      'The lighthouse stood at the edge of the cliff.',
      'Its keeper, Dr. Mara Vale, climbed the stairs every night & lit the lamp.',
      'Nobody remembered when the ships stopped coming.',
      'Still, she kept the light burning for anyone who might be lost.',
      'First item in a list',
      'Second item here',
      'One night, a small boat appeared on the horizon.',
    ]);
    const ws = readLog().find((e) => e.type === 'ws');
    assert.equal(ws.origin, 'chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold', 'Origin rewritten by DNR');
    assert.match(ws.ua, /Edg\//, 'User-Agent rewritten by DNR');
    assert.match(ws.cookie, /^muid=[0-9A-F]{32};$/);
    assert.ok(readLog().filter((e) => e.type === 'ws').every((e) => e.gecValid), 'Sec-MS-GEC token valid');
    console.log('✓ page mode, headers, token');

    // Speed change mid-read + Alt+click jump
    fs.writeFileSync(LOG, '');
    await send({ to: 'bg', type: 'start', tabId, mode: 'page' });
    await page.waitForTimeout(500);
    await ctl.evaluate(async () => { const { settings } = await chrome.storage.local.get('settings'); await chrome.storage.local.set({ settings: { ...settings, rate: 1.2 } }); });
    await page.waitForTimeout(1000);
    await page.click('text=One night, a small boat', { modifiers: ['Alt'] });
    await page.waitForTimeout(400);
    assert.equal(await sentence(), 'One night, a small boat appeared on the horizon.');
    await playerGone();
    assert.ok(readLog().some((e) => e.type === 'ssml' && e.rate === '+20%'), 'rate change applied');
    console.log('✓ speed change, alt+click');

    // Selection only — and it must start speaking before the first sentence has fully arrived
    fs.writeFileSync(LOG, '');
    await page.evaluate(() => {
      const li = document.querySelectorAll('li');
      const r = document.createRange(); r.setStart(li[0].firstChild, 6); r.setEnd(li[1].firstChild, 6);
      getSelection().removeAllRanges(); getSelection().addRange(r);
    });
    await page.waitForTimeout(31000); // let the idle audio player close, like a real cold start
    const t0 = Date.now();
    await send({ to: 'bg', type: 'start', tabId, mode: 'selection' });
    await page.waitForFunction(() => CSS.highlights.get('read-aloud-word')?.size > 0, null, { timeout: 10000, polling: 20 });
    const firstWordMs = Date.now() - t0;
    console.log(`  time to first spoken word (cold start): ${firstWordMs} ms`);
    assert.ok(firstWordMs < 900, `streaming start should beat the ~1 s full-sentence wait (got ${firstWordMs} ms)`);
    await playerGone();
    assert.deepEqual(ssmlTexts(), ['item in a list', 'Second']);
    console.log('✓ selection mode');

    // Right-click a word -> "Read aloud from here" starts at that word.
    // (macOS selects the right-clicked word; simulate that selection here.)
    fs.writeFileSync(LOG, '');
    await page.evaluate(() => {
      const t = document.querySelectorAll('p')[1].firstChild;
      const i = t.data.indexOf('remembered');
      const r = document.createRange(); r.setStart(t, i); r.setEnd(t, i + 'remembered'.length);
      getSelection().removeAllRanges(); getSelection().addRange(r);
    });
    await send({ to: 'bg', type: 'start', tabId, mode: 'here' });
    await page.waitForTimeout(500);
    assert.equal(ssmlTexts()[0], 'remembered when the ships stopped coming.');
    await send({ to: 'bg', type: 'stopAll' });
    await playerGone();
    console.log('✓ read aloud from here (right-click)');

    // Read from caret, then Stop from popup closes the player bar
    fs.writeFileSync(LOG, '');
    await page.evaluate(() => { const p = document.querySelectorAll('p')[1]; getSelection().collapse(p.firstChild, 3); });
    await send({ to: 'bg', type: 'start', tabId, mode: 'toggle' });
    await page.waitForTimeout(500);
    assert.equal(ssmlTexts()[0], 'Nobody remembered when the ships stopped coming.');
    await send({ to: 'bg', type: 'stopAll' });
    await playerGone();
    console.log('✓ read from caret, stop');
    console.log('ALL PASSED');
  } finally {
    await ctx.close();
    server.kill();
  }
})().catch((e) => { console.error(e); process.exit(1); });
