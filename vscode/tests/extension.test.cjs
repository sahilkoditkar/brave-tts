// Drives extension.js through a mocked `vscode` API, with the REAL engine (talking to the
// local fake speech server from browser/tests/e2e), real MP3 files and a real audio player.
// Needs: openssl, ffmpeg/ffplay (Linux), port 443. Run: node vscode/tests/extension.test.cjs
const Module = require('module');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execSync, spawn } = require('child_process');
const assert = require('assert/strict');

const ROOT = path.resolve(__dirname, '../..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'read-aloud-vscode-test-'));
process.env.SDL_AUDIODRIVER = 'dummy'; // ffplay without a sound card
for (const k of ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'ALL_PROXY']) delete process.env[k]; // tests talk to a local fake server

// ---------------------------------------------------------------- vscode mock
class Position { constructor(line, character) { this.line = line; this.character = character; } }
class Range { constructor(start, end) { this.start = start; this.end = end; } }
class Selection extends Range {
  constructor(anchor, active) { super(anchor, active); this.anchor = anchor; this.active = active; }
  get isEmpty() { return this.anchor.line === this.active.line && this.anchor.character === this.active.character; }
}
function makeDocument(text, languageId) {
  const lineStarts = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === '\n') lineStarts.push(i + 1);
  return {
    text, languageId, version: 1, uri: { toString: () => `file:///test.${languageId}` },
    getText(r) { return r ? text.slice(this.offsetAt(r.start), this.offsetAt(r.end)) : text; },
    offsetAt: (p) => lineStarts[p.line] + p.character,
    positionAt: (o) => { let l = 0; while (l + 1 < lineStarts.length && lineStarts[l + 1] <= o) l++; return new Position(l, o - lineStarts[l]); },
  };
}
const decorations = []; // { type, texts }
const listeners = {};
const commands = {};
const CLAUDE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-projects-'));
const config = { 'claude.projectsDir': CLAUDE_DIR, voice: 'en-US-AndrewNeural', speed: 1.5, pitch: 0, highlightWords: true, showStatusBar: true, voiceSource: 'edge', azureRegion: 'eastus' };
const messages = [];
let editor;
let clipboard = 'user clipboard';
let panelSelection = '';
let activeTab = null;
let copyWorks = true; // simulate the automatic copy failing in the webview
const logLines = []; // simulated active editor tab (Claude Code tabs are labelled with the session title) // what's selected in the (simulated) Claude Code webview
const mkEvent = (name) => (fn) => { (listeners[name] ||= []).push(fn); return { dispose() {} }; };
const statusItems = [];
const vscodeMock = {
  Position, Range, Selection,
  StatusBarAlignment: { Left: 1, Right: 2 },
  ProgressLocation: { Notification: 15 },
  TextEditorRevealType: { InCenterIfOutsideViewport: 2 },
  ConfigurationTarget: { Global: 1 },
  env: {
    language: 'en',
    clipboard: { readText: async () => clipboard, writeText: async (t) => { clipboard = t; } },
  },
  window: {
    get tabGroups() { return { activeTabGroup: { activeTab: activeTab }, all: [{ activeTab }] }; },
    get activeTextEditor() { return editor; },
    get visibleTextEditors() { return editor ? [editor] : []; },
    createTextEditorDecorationType: (opts) => ({ opts, dispose() {} }),
    createOutputChannel: () => ({ appendLine: (l) => logLines.push(l), show() {}, dispose() {} }),
    createStatusBarItem: () => { const s = { text: '', show() { this.visible = true; }, hide() { this.visible = false; }, dispose() {} }; statusItems.push(s); return s; },
    showInformationMessage: (m) => { messages.push(['info', m]); },
    showErrorMessage: (m) => { messages.push(['error', m]); },
    setStatusBarMessage: (m) => { messages.push(['status', m]); },
    showQuickPick: async (items) => items[0],
    withProgress: async (_opts, fn) => fn({ report() {} }),
    onDidChangeVisibleTextEditors: mkEvent('visible'),
  },
  workspace: {
    getConfiguration: () => ({ get: (k, d) => (k in config ? config[k] : d), update: async (k, v) => { config[k] = v; } }),
    onDidChangeTextDocument: mkEvent('change'),
    onDidCloseTextDocument: mkEvent('close'),
    onDidChangeConfiguration: mkEvent('config'),
  },
  commands: {
    registerCommand: (id, fn) => { commands[id] = fn; return { dispose() {} }; },
    executeCommand: async (id) => {
      // the real copy command copies the focused webview's selection (async, like a webview)
      if (id === 'editor.action.clipboardCopyAction' && panelSelection && copyWorks) setTimeout(() => { clipboard = panelSelection; }, 20);
    },
  },
};
const origLoad = Module._load;
Module._load = function (request, ...rest) { return request === 'vscode' ? vscodeMock : origLoad.call(this, request, ...rest); };

function openEditor(text, languageId, cursorOffset) {
  const doc = makeDocument(text, languageId);
  const p = doc.positionAt(cursorOffset);
  editor = {
    document: doc,
    selection: new Selection(p, p),
    setDecorations(type, ranges) { decorations.push({ type, texts: ranges.map((r) => text.slice(doc.offsetAt(r.start), doc.offsetAt(r.end))) }); },
    revealRange() {},
  };
  return editor;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (fn, ms = 20000) => { const t = Date.now(); while (!fn()) { if (Date.now() - t > ms) throw new Error('timeout'); await sleep(50); } };
const readLog = () => fs.readFileSync(path.join(TMP, 'server.log'), 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);

(async () => {
  execSync('openssl req -x509 -newkey rsa:2048 -nodes -keyout key.pem -out cert.pem -days 1 -subj "/CN=speech.platform.bing.com" -addext "subjectAltName=DNS:speech.platform.bing.com"', { cwd: TMP, stdio: 'ignore' });
  execSync('ffmpeg -loglevel error -y -f lavfi -i "sine=frequency=440:duration=0.8" -ar 24000 -ac 1 -b:a 48k tone.mp3', { cwd: TMP });
  const server = spawn(process.execPath, [path.join(ROOT, 'browser/tests/e2e/fake-server.mjs')], { env: { ...process.env, E2E_TMP: TMP }, stdio: 'ignore' });
  await sleep(700);
  try {
    // Point the real engine at the fake server.
    const engine = await import(path.join(ROOT, 'vscode/engine.mjs'));
    engine._setTransportForTests({
      lookup: (host, opts, cb) => (opts.all ? cb(null, [{ address: '127.0.0.1', family: 4 }]) : cb(null, '127.0.0.1', 4)),
      rejectUnauthorized: false,
    });
    const ext = require(path.join(ROOT, 'vscode/extension.js'));
    const secrets = new Map();
    const globalState = new Map();
    ext.activate({
      subscriptions: [],
      secrets: { get: async (k) => secrets.get(k), store: async (k, v) => secrets.set(k, v), delete: async (k) => secrets.delete(k) },
      globalState: { get: (k) => globalState.get(k), update: async (k, v) => globalState.set(k, v) },
    });
    const statusItem = statusItems[1]; // [prev, main, next, speed, stop]
    assert.match(statusItem.text, /Read Aloud/);

    // 1) Markdown, from the cursor in the middle of a word
    const md = '# Title\n\nFirst sentence here. The cursor starts in this one.\n\n```js\nconst code = 1;\n```\n\nLast line.\n';
    openEditor(md, 'markdown', md.indexOf('ursor'));
    await commands['readAloud.readFromHere']();
    await waitFor(() => /Read Aloud/.test(statusItem.text) && decorations.length > 3);
    const ssml = readLog().filter((e) => e.type === 'ssml');
    assert.deepEqual(ssml.map((e) => e.text).sort(), ['Last line.', 'cursor starts in this one.']);
    assert.ok(ssml.every((e) => e.voice === 'Microsoft Server Speech Text to Speech Voice (en-US, AndrewNeural)'));
    assert.ok(ssml.every((e) => e.rate === '+50%'));
    const ws = readLog().find((e) => e.type === 'ws');
    assert.equal(ws.origin, 'chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold');
    assert.match(ws.ua, /Edg\//);
    assert.ok(ws.gecValid, 'token valid');
    const sentenceHl = decorations.filter((d) => d.texts.length).map((d) => d.texts[0]);
    assert.ok(sentenceHl.includes('cursor starts in this one.'), 'sentence highlighted');
    assert.ok(sentenceHl.includes('starts'), 'word highlighted');
    console.log('✓ markdown from cursor: headers, token, voice, speed, highlights');

    // 2) Code file: comments only, then pause/resume/stop
    fs.writeFileSync(path.join(TMP, 'server.log'), '');
    const js = '// Adds two numbers together.\nfunction add(a, b) {\n  return a + b; // simple sum\n}\n/* The end of the file. */\n';
    openEditor(js, 'javascript', 0);
    await commands['readAloud.toggle']();
    await waitFor(() => /debug-pause/.test(statusItem.text));
    await commands['readAloud.toggle'](); // pause
    assert.match(statusItem.text, /\$\(play\)/);
    await commands['readAloud.toggle'](); // resume
    await waitFor(() => /Read Aloud/.test(statusItem.text));
    // (sentences are prefetched in parallel, so request order isn't fixed)
    assert.deepEqual([...new Set(readLog().filter((e) => e.type === 'ssml').map((e) => e.text))].sort(),
      ['Adds two numbers together.', 'The end of the file.', 'simple sum']);
    console.log('✓ code file reads comments only; pause/resume');

    // 3) Editing the document while reading stops it
    openEditor(md, 'markdown', 0);
    await commands['readAloud.readFromHere']();
    await waitFor(() => /debug-pause|loading/.test(statusItem.text));
    listeners.change.forEach((fn) => fn({ document: editor.document, contentChanges: [{}] }));
    assert.match(statusItem.text, /Read Aloud/);
    console.log('✓ edit stops reading');

    // 4) No comments -> friendly message
    openEditor('const x = 1;\n', 'javascript', 0);
    await commands['readAloud.readFromHere']();
    assert.match(messages.at(-1)[1], /no comments/);
    console.log('✓ no-comments message');

    // 5) Voice picker
    await commands['readAloud.chooseVoice']();
    assert.equal(config.voice, 'en-US-AndrewNeural');
    console.log('✓ voice list + picker');

    // 6) Claude Code replies
    const transcript = path.join(CLAUDE_DIR, '-Users-me-proj', 'sess.jsonl');
    fs.mkdirSync(path.dirname(transcript));
    const L = (o) => JSON.stringify({ timestamp: new Date().toISOString(), uuid: Math.random().toString(36), ...o });
    fs.writeFileSync(transcript, [
      L({ type: 'user', message: { content: 'push the PR' } }),
      L({ type: 'assistant', message: { content: [{ type: 'text', text: 'Pushing now.' }], stop_reason: 'tool_use' } }),
      L({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: {} }], stop_reason: 'tool_use' } }),
      L({ type: 'user', message: { content: [{ type: 'tool_result', content: 'Exit code 1' }] } }),
      L({ type: 'assistant', message: { content: [{ type: 'text', text: 'Nothing got pushed. GitHub rejected the push because the token lacks the **workflow** scope.\n\n```bash\ngh auth refresh -s workflow\n```\n\nRun that, then tell me.' }], stop_reason: 'end_turn' } }),
    ].join('\n') + '\n');
    const spokenNow = async (fn) => {
      fs.writeFileSync(path.join(TMP, 'server.log'), '');
      await fn();
      await waitFor(() => /Read Aloud/.test(statusItem.text));
      return [...new Set(readLog().filter((e) => e.type === 'ssml').map((e) => e.text))].sort();
    };
    assert.deepEqual(await spokenNow(() => commands['readAloud.readLastClaudeReply']()),
      ['GitHub rejected the push because the token lacks the workflow scope.', 'Nothing got pushed.', 'Run that, then tell me.']);
    console.log('✓ last Claude reply: final message only, code block skipped');

    // 7) select a word in the Claude panel -> read from there
    panelSelection = 'rejected';
    assert.deepEqual(await spokenNow(() => commands['readAloud.readPanelSelection']()),
      ['Run that, then tell me.', 'rejected the push because the token lacks the workflow scope.']);
    assert.equal(clipboard, 'user clipboard', 'clipboard restored');
    console.log('✓ panel word selection reads from that word; clipboard restored');

    // 8) longer selection -> just that
    panelSelection = 'Nothing got pushed. GitHub rejected the push';
    assert.deepEqual(await spokenNow(() => commands['readAloud.readPanelSelection']()),
      ['GitHub rejected the push', 'Nothing got pushed.']);
    // 9) nothing selected -> latest reply
    panelSelection = '';
    assert.equal((await spokenNow(() => commands['readAloud.readPanelSelection']())).length, 3);
    console.log('✓ long selection reads only it; empty selection reads latest reply');

    // 10) editor: double-clicked word -> from there
    const prose = 'Alpha one is here. Beta two follows. Gamma three ends.';
    const ed = openEditor(prose, 'plaintext', 0);
    ed.selection = new Selection(ed.document.positionAt(prose.indexOf('two')), ed.document.positionAt(prose.indexOf('two') + 3));
    assert.deepEqual(await spokenNow(() => commands['readAloud.readFromHere']()), ['Gamma three ends.', 'two follows.']);
    console.log('✓ editor: selected word reads from there');

    // 11) auto-read finished replies
    fs.writeFileSync(path.join(TMP, 'server.log'), '');
    config['claude.autoRead'] = true;
    listeners.config.forEach((fn) => fn({ affectsConfiguration: (k) => k.startsWith('readAloud') }));
    await sleep(400);
    fs.appendFileSync(transcript, [
      L({ type: 'user', message: { content: 'done' } }),
      L({ type: 'assistant', message: { content: [{ type: 'text', text: 'Great, the PR is merged.' }], stop_reason: 'end_turn' } }),
    ].join('\n') + '\n');
    await waitFor(() => readLog().some((e) => e.type === 'ssml' && e.text === 'Great, the PR is merged.'), 8000);
    console.log('✓ auto-read speaks a newly finished reply');

    // 12) several sessions open: read the one whose tab you're looking at
    config['claude.autoRead'] = false;
    listeners.config.forEach((fn) => fn({ affectsConfiguration: (k) => k.startsWith('readAloud') }));
    const mkSession = (name, title, replyText, ageMs) => {
      const f = path.join(CLAUDE_DIR, '-Users-me-other', `${name}.jsonl`);
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.writeFileSync(f, [
        JSON.stringify({ type: 'custom-title', customTitle: title }),
        L({ type: 'user', message: { content: 'hi' } }),
        L({ type: 'assistant', message: { content: [{ type: 'text', text: replyText }], stop_reason: 'end_turn' } }),
      ].join('\n') + '\n');
      const t = new Date(Date.now() - ageMs);
      fs.utimesSync(f, t, t);
    };
    mkSession('a', 'ml sidechat', 'Reply from the side chat.', 5000);
    mkSession('b', 'vulnhub reviewer', 'Reply from the reviewer.', 1000); // most recently active
    fs.utimesSync(transcript, new Date(Date.now() - 60000), new Date(Date.now() - 60000));
    activeTab = null;
    assert.deepEqual(await spokenNow(() => commands['readAloud.readLastClaudeReply']()), ['Reply from the reviewer.']);
    activeTab = { label: 'ml sidechat' };
    assert.deepEqual(await spokenNow(() => commands['readAloud.readLastClaudeReply']()), ['Reply from the side chat.']);
    console.log('✓ reads the session of the tab you are looking at; else the most recent');

    // 13) controls appear while reading; speed shown and adjustable
    activeTab = null;
    const [prevI, mainI, nextI, speedI, stopI] = statusItems;
    openEditor('One. Two. Three. Four.', 'plaintext', 0);
    await commands['readAloud.readFromHere']();
    await waitFor(() => /debug-pause/.test(mainI.text));
    assert.ok(prevI.visible && nextI.visible && speedI.visible && stopI.visible, 'controls visible while reading');
    assert.equal(speedI.text, '1.5×');
    await commands['readAloud.faster']();
    listeners.config.forEach((fn) => fn({ affectsConfiguration: (k) => k.startsWith('readAloud') }));
    await sleep(50);
    assert.equal(config.speed, 1.6);
    assert.equal(speedI.text, '1.6×');
    await commands['readAloud.stop']();
    assert.ok(!prevI.visible && !speedI.visible && mainI.command === 'readAloud.menu', 'idle: just the menu button');
    console.log('✓ status bar controls (prev / pause / next / speed / stop) and speed nudge');

    // 14) automatic copy fails -> text the user copied (⌘C) is used, if it's from a Claude reply
    activeTab = { label: 'ml sidechat' };
    copyWorks = false;
    panelSelection = 'side';
    clipboard = 'side';
    assert.deepEqual(await spokenNow(() => commands['readAloud.readPanelSelection']()), ['side chat.']);
    clipboard = 'some unrelated thing I copied earlier';
    assert.deepEqual(await spokenNow(() => commands['readAloud.readPanelSelection']()), ['Reply from the side chat.'],
      'unrelated clipboard is ignored -> last reply of the focused session');
    assert.equal(clipboard, 'some unrelated thing I copied earlier', 'clipboard untouched');
    copyWorks = true;
    console.log('✓ ⌘C fallback when automatic copy fails; unrelated clipboard ignored');

    // 15) right-click "Read Aloud from Here" in the panel; long selection spanning a code block skips the code
    activeTab = null;
    panelSelection = 'rejected';
    assert.deepEqual(await spokenNow(() => commands['readAloud.readPanelFromHere']()),
      ['Run that, then tell me.', 'rejected the push because the token lacks the workflow scope.']);
    panelSelection = 'GitHub rejected the push because the token lacks the workflow scope.\ngh auth refresh -s workflow\nRun that, then tell me.';
    assert.deepEqual(await spokenNow(() => commands['readAloud.readPanelSelection']()),
      ['GitHub rejected the push because the token lacks the workflow scope.', 'Run that, then tell me.']);
    assert.ok(logLines.some((l) => l.includes('read selection')), 'troubleshooting log written');
    console.log('✓ panel right-click; long selection maps to the reply and skips code');

    // 16) one connection for many sentences; recovers from stalls and dropped connections
    const setMode = (q) => new Promise((res) => require('http').get(`http://127.0.0.1:8080/__mode?${q}`, (r) => { r.resume(); r.on('end', res); }));
    const many = 'One is here. Two is here. Three is here. Four is here. Five is here.';
    fs.writeFileSync(path.join(TMP, 'server.log'), '');
    openEditor(many, 'plaintext', 0);
    assert.equal((await spokenNow(() => commands['readAloud.readFromHere']())).length, 5);
    const conns = readLog().filter((e) => e.type === 'ws').length;
    assert.equal(conns, 1, `5 sentences over one connection (opened ${conns})`);
    await setMode('closeAfterTurn=1');
    openEditor(many, 'plaintext', 0);
    assert.equal((await spokenNow(() => commands['readAloud.readFromHere']())).length, 5, 'reconnects after each dropped connection');
    await setMode('stallNext=1');
    openEditor(many, 'plaintext', 0);
    const tStall = Date.now();
    assert.equal((await spokenNow(() => commands['readAloud.readFromHere']())).length, 5, 'stalled request retried');
    assert.ok(readLog().some((e) => e.type === 'stalled'));
    await setMode('');
    console.log(`✓ 1 connection for 5 sentences; survives dropped connections; stall recovered (${((Date.now() - tStall) / 1000).toFixed(1)} s total)`);

    // 17) explicit proxy (VS Code "http.proxy"): traffic is tunnelled through it
    const net = require('net');
    const tunnels = [];
    const proxy = require('http').createServer().on('connect', (req, client, head) => {
      tunnels.push(req.url);
      const upstream = net.connect(443, '127.0.0.1', () => {
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        upstream.write(head);
        upstream.pipe(client);
        client.pipe(upstream);
      });
      upstream.on('error', () => client.destroy());
      client.on('error', () => upstream.destroy());
    });
    await new Promise((r) => proxy.listen(0, '127.0.0.1', r));
    config.proxy = `http://127.0.0.1:${proxy.address().port}`;
    for (const fn of listeners.config) await fn({ affectsConfiguration: (k) => k === 'http.proxy' || k.startsWith('readAloud') });
    openEditor('Through the proxy we go.', 'plaintext', 0);
    assert.deepEqual(await spokenNow(() => commands['readAloud.readFromHere']()), ['Through the proxy we go.']);
    assert.ok(tunnels.includes('speech.platform.bing.com:443'), `tunnelled via proxy (${tunnels.join(', ')})`);
    console.log('✓ explicit proxy: speech tunnelled through http.proxy');

    // 18) Test Connection reports each step
    messages.length = 0;
    await commands['readAloud.testConnection']();
    assert.match(messages.at(-1)[1], /connection OK/);
    assert.ok(logLines.some((l) => l.includes('✓ Speech (WebSocket)')) && logLines.some((l) => l.includes('✓ Voice list')));
    config.proxy = 'http://127.0.0.1:1'; // nothing listening there
    for (const fn of listeners.config) await fn({ affectsConfiguration: (k) => k === 'http.proxy' });
    await commands['readAloud.testConnection']();
    assert.equal(messages.at(-1)[0], 'error');
    assert.match(messages.at(-1)[1], /Voice list.*failed|failed/);
    console.log(`✓ Test Connection: OK path, and a clear error for a broken proxy ("${messages.at(-1)[1].slice(0, 70)}…")`);
    delete config.proxy;
    for (const fn of listeners.config) await fn({ affectsConfiguration: (k) => k === 'http.proxy' });
    proxy.close();

    ext.deactivate();
    console.log('ALL PASSED');
    setTimeout(() => process.exit(0), 100); // audio player children may linger a moment
  } finally {
    server.kill();
  }
})().catch((e) => { console.error(e); process.exit(1); });
