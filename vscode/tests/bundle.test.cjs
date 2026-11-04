// Smoke test of the BUILT extension: loads extension.js from inside the .vsix (one bundled file),
// activates it against a minimal mocked `vscode` API, and checks that every command declared in
// the manifest gets registered. Catches bundling mistakes (a missing module, a broken import).
// Run after `npm run build`: node vscode/tests/bundle.test.cjs
const Module = require('module');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const assert = require('assert/strict');

const ROOT = path.resolve(__dirname, '../..');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'vscode/package.json'), 'utf8'));
const vsix = path.join(ROOT, 'dist', `read-aloud-vscode-${pkg.version}.vsix`);
assert.ok(fs.existsSync(vsix), `${path.relative(ROOT, vsix)} missing: run npm run build first`);

// Unzip the .vsix (central directory -> each deflated entry).
const zipBuf = fs.readFileSync(vsix);
const eocd = zipBuf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
const entries = new Map();
for (let p = zipBuf.readUInt32LE(eocd + 16), n = zipBuf.readUInt16LE(eocd + 10); n > 0; n--) {
  const nameLen = zipBuf.readUInt16LE(p + 28);
  const name = zipBuf.toString('utf8', p + 46, p + 46 + nameLen);
  const local = zipBuf.readUInt32LE(p + 42);
  const size = zipBuf.readUInt32LE(p + 20);
  const dataAt = local + 30 + zipBuf.readUInt16LE(local + 26) + zipBuf.readUInt16LE(local + 28);
  entries.set(name, zlib.inflateRawSync(zipBuf.subarray(dataAt, dataAt + size)));
  p += 46 + nameLen + zipBuf.readUInt16LE(p + 30) + zipBuf.readUInt16LE(p + 32);
}
const manifest = JSON.parse(entries.get('extension/package.json'));
assert.equal(manifest.main, './extension.js');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'read-aloud-bundle-'));
fs.writeFileSync(path.join(dir, 'extension.js'), entries.get('extension/extension.js'));

const commands = new Set();
const disposable = { dispose() {} };
const event = () => () => disposable;
const vscodeMock = {
  StatusBarAlignment: { Left: 1, Right: 2 },
  ConfigurationTarget: { Global: 1 },
  env: { language: 'en', clipboard: { readText: async () => '', writeText: async () => {} } },
  window: {
    tabGroups: { activeTabGroup: {}, all: [] },
    visibleTextEditors: [],
    createTextEditorDecorationType: () => disposable,
    createOutputChannel: () => ({ appendLine() {}, show() {}, dispose() {} }),
    createStatusBarItem: () => ({ show() {}, hide() {}, dispose() {} }),
    onDidChangeVisibleTextEditors: event(),
  },
  workspace: {
    getConfiguration: () => ({ get: (_k, d) => d, update: async () => {} }),
    onDidChangeTextDocument: event(),
    onDidCloseTextDocument: event(),
    onDidChangeConfiguration: event(),
  },
  commands: { registerCommand: (id) => { commands.add(id); return disposable; }, executeCommand: async () => {} },
};
const origLoad = Module._load;
Module._load = function (request, ...rest) { return request === 'vscode' ? vscodeMock : origLoad.call(this, request, ...rest); };

(async () => {
  const ext = require(path.join(dir, 'extension.js'));
  ext.activate({ subscriptions: [], secrets: { get: async () => '' }, globalState: new Map() });
  await new Promise((r) => setTimeout(r, 300)); // lazy-loaded modules (engine, text, …) resolve
  const declared = manifest.contributes.commands.map((c) => c.command);
  const missing = declared.filter((c) => !commands.has(c));
  assert.deepEqual(missing, [], 'every declared command is registered');
  ext.deactivate();
  console.log(`✓ bundled extension loads from the .vsix and registers all ${declared.length} commands`);
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
