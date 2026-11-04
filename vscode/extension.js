// VS Code side of Read Aloud: reads Markdown/docs, or only the comments in code,
// highlighting the sentence and word being spoken in the editor.
const vscode = require('vscode');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PREFETCH_AHEAD = 2;
const VOICE_CACHE_MS = 24 * 3600 * 1000;

let mods;
async function load() {
  if (!mods) {
    const [engine, text, player, ssml, claude] = await Promise.all([
      import('./engine.mjs'), import('./text.mjs'), import('./player.mjs'), import('../browser/lib/ssml.js'),
      import('./claude.mjs'),
    ]);
    mods = { engine, text, player, ssml, claude };
  }
  return mods;
}

let ctx;
let statusItem;
let stopItem;
let sentenceDeco;
let wordDeco;
let tmpDir;

// reading state
let session = null; // { doc (null for Claude replies), label, sentences, idx, playing, cache: Map, settings }
let claudeWatcher = null;
let gen = 0;
let currentPlayer = null;
let wordTimer = null;
let fileCounter = 0;

async function getSettings() {
  const c = vscode.workspace.getConfiguration('readAloud');
  return {
    backend: c.get('voiceSource', 'edge'),
    voice: c.get('voice', 'en-US-AvaMultilingualNeural'),
    rate: c.get('speed', 1),
    pitch: c.get('pitch', 0),
    azureRegion: c.get('azureRegion', 'eastus'),
    azureKey: (await ctx.secrets.get('readAloud.azureKey')) || '',
    highlightWords: c.get('highlightWords', true),
  };
}

// ---------------------------------------------------------------- UI helpers
function editorFor(doc) {
  return vscode.window.visibleTextEditors.find((e) => e.document === doc);
}

function rangeOf(doc, start, length) {
  return new vscode.Range(doc.positionAt(start), doc.positionAt(start + length));
}

function updateStatus(state) {
  if (!statusItem) return;
  if (!session) {
    statusItem.text = '$(unmute) Read Aloud';
    statusItem.tooltip = 'Read aloud from the cursor (or the selection)';
    stopItem.hide();
  } else {
    const pos = `${session.label ? `${session.label} ` : ''}${session.idx + 1}/${session.sentences.length}`;
    statusItem.text = state === 'loading' ? `$(loading~spin) ${pos}`
      : session.playing ? `$(debug-pause) ${pos}` : `$(play) ${pos}`;
    statusItem.tooltip = session.playing ? 'Pause reading' : 'Resume reading';
    stopItem.show();
  }
  vscode.commands.executeCommand('setContext', 'readAloud.active', !!session);
}

function highlightSentence() {
  if (!session.doc) return; // e.g. a Claude Code reply: nothing to highlight in an editor
  const editor = editorFor(session.doc);
  if (!editor) return;
  const s = session.sentences[session.idx];
  const range = rangeOf(session.doc, s.start, s.text.length);
  editor.setDecorations(sentenceDeco, [range]);
  editor.setDecorations(wordDeco, []);
  editor.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
}

function clearHighlights() {
  for (const editor of vscode.window.visibleTextEditors) {
    editor.setDecorations(sentenceDeco, []);
    editor.setDecorations(wordDeco, []);
  }
}

// ---------------------------------------------------------------- audio cache
function dropCache(predicate) {
  if (!session) return;
  for (const [i, entry] of session.cache) {
    if (predicate(i)) {
      entry.controller.abort();
      entry.promise.then((r) => fs.promises.rm(r.file, { force: true })).catch(() => {});
      session.cache.delete(i);
    }
  }
}

function getAudio(i) {
  let entry = session.cache.get(i);
  if (!entry) {
    const controller = new AbortController();
    const s = session.sentences[i];
    const settings = session.settings;
    entry = { controller };
    entry.promise = mods.engine.synthesize(s.speak, settings, controller.signal).then(async (r) => {
      const file = path.join(tmpDir, `s${process.pid}-${fileCounter++}.mp3`);
      await fs.promises.writeFile(file, r.audio);
      return { file, words: mods.ssml.mapWords(s.text, r.words) };
    });
    entry.promise.catch(() => {});
    session.cache.set(i, entry);
  }
  return entry.promise;
}

// ---------------------------------------------------------------- playback
function stopAudio() {
  clearInterval(wordTimer);
  wordTimer = null;
  if (currentPlayer) {
    currentPlayer.stop();
    currentPlayer = null;
  }
}

async function playFrom(i) {
  const myGen = ++gen;
  stopAudio();
  if (!session) return;
  if (i >= session.sentences.length) { stopReading(); return; }
  session.idx = Math.max(0, i);
  session.playing = true;
  dropCache((j) => j < session.idx || j > session.idx + PREFETCH_AHEAD);
  highlightSentence();
  updateStatus(session.cache.has(session.idx) ? 'playing' : 'loading');
  for (let j = session.idx; j <= Math.min(session.idx + PREFETCH_AHEAD, session.sentences.length - 1); j++) getAudio(j);

  let audio;
  try {
    audio = await getAudio(session.idx);
  } catch (err) {
    if (myGen !== gen || err.name === 'AbortError') return;
    vscode.window.showErrorMessage(`Read Aloud: ${err.message}`);
    stopReading();
    return;
  }
  if (myGen !== gen || !session) return;
  updateStatus('playing');
  let p;
  try {
    p = mods.player.play(audio.file);
  } catch (err) {
    vscode.window.showErrorMessage(`Read Aloud: ${err.message}`);
    stopReading();
    return;
  }
  currentPlayer = p;
  const startedAt = await p.started;
  if (myGen === gen && session.settings.highlightWords && audio.words.length) {
    const s = session.sentences[session.idx];
    let last = -1;
    wordTimer = setInterval(() => {
      const editor = session?.doc && editorFor(session.doc);
      if (!editor || myGen !== gen) return;
      const t = (Date.now() - startedAt) * 10000; // ms -> 100ns ticks
      let w = -1;
      for (let k = 0; k < audio.words.length && audio.words[k].offset <= t; k++) w = k;
      if (w >= 0 && w !== last) {
        last = w;
        editor.setDecorations(wordDeco, [rangeOf(session.doc, s.start + audio.words[w].start, audio.words[w].length)]);
      }
    }, 40);
  }
  try {
    await p.done;
  } catch (err) {
    if (myGen === gen) { vscode.window.showErrorMessage(`Read Aloud: ${err.message}`); stopReading(); }
    return;
  }
  if (myGen === gen) playFrom(session.idx + 1);
}

function pause() {
  if (!session?.playing) return;
  gen++;
  stopAudio();
  session.playing = false;
  if (session.doc && editorFor(session.doc)) editorFor(session.doc).setDecorations(wordDeco, []);
  updateStatus();
}

function stopReading() {
  gen++;
  stopAudio();
  if (session) dropCache(() => true);
  session = null;
  clearHighlights();
  updateStatus();
}

// ---------------------------------------------------------------- commands
async function start(editor) {
  editor = editor || vscode.window.activeTextEditor;
  if (!editor) { vscode.window.showInformationMessage('Read Aloud: open a file first.'); return; }
  await load();
  stopReading();
  const doc = editor.document;
  const spoken = mods.text.spokenText(doc.getText(), doc.languageId);
  const sel = editor.selection;
  // Cursor, or a short selection (double-clicked word): read from there. Longer selection: just it.
  const fromHere = sel.isEmpty || mods.text.isShortSelection(doc.getText(sel));
  const from = doc.offsetAt(sel.isEmpty ? sel.active : sel.start);
  const to = fromHere ? spoken.length : doc.offsetAt(sel.end);
  const lang = vscode.env.language || 'en';
  const sentences = mods.text.quickStart(mods.text.sentencesInRange(spoken, from, to, lang));
  if (!sentences.length) {
    const kind = mods.text.documentKind(doc.languageId);
    vscode.window.showInformationMessage(kind === 'code'
      ? 'Read Aloud: no comments to read here (code itself is skipped).'
      : 'Read Aloud: nothing to read after the cursor.');
    return;
  }
  session = { doc, label: '', sentences, idx: 0, playing: true, cache: new Map(), settings: await getSettings() };
  playFrom(0);
}

// Read Markdown that isn't in an editor (a Claude Code reply).
async function startMarkdown(markdown, label, { from = 0, languageId = 'markdown' } = {}) {
  await load();
  stopReading();
  const spoken = mods.text.spokenText(markdown, languageId);
  const sentences = mods.text.quickStart(mods.text.sentencesInRange(spoken, from, spoken.length, vscode.env.language || 'en'));
  if (!sentences.length) return false;
  session = { doc: null, label, sentences, idx: 0, playing: true, cache: new Map(), settings: await getSettings() };
  playFrom(0);
  return true;
}

// ---------------------------------------------------------------- Claude Code replies
function claudeConfig() {
  const c = vscode.workspace.getConfiguration('readAloud');
  return {
    autoRead: c.get('claude.autoRead', false),
    includeProgress: c.get('claude.includeProgressUpdates', false),
    dir: mods.claude.projectsDir(c.get('claude.projectsDir', '')),
  };
}

async function readLastClaudeReply() {
  await load();
  const { dir, includeProgress } = claudeConfig();
  const file = mods.claude.latestTranscript(dir);
  const reply = file && mods.claude.lastReply(mods.claude.readTail(file), { includeProgress });
  if (!reply) {
    vscode.window.showInformationMessage(file
      ? 'Read Aloud: the latest Claude Code session has no reply text yet.'
      : `Read Aloud: no Claude Code sessions found in ${dir}.`);
    return;
  }
  if (!(await startMarkdown(reply.text, 'Claude'))) vscode.window.showInformationMessage('Read Aloud: nothing readable in the last reply.');
}

// Copy whatever is selected in the focused panel (e.g. the Claude Code chat webview, which other
// extensions can't read directly). The previous clipboard text is restored afterwards.
async function copyFocusedSelection() {
  const previous = await vscode.env.clipboard.readText();
  const sentinel = `\u2063read-aloud-${Date.now()}`;
  await vscode.env.clipboard.writeText(sentinel);
  await vscode.commands.executeCommand('editor.action.clipboardCopyAction');
  let text = sentinel;
  for (let i = 0; i < 20 && text === sentinel; i++) {
    await new Promise((r) => setTimeout(r, 30));
    text = await vscode.env.clipboard.readText();
  }
  await vscode.env.clipboard.writeText(previous);
  return text === sentinel ? '' : text;
}

// Find a selected word/phrase in the latest Claude Code session -> read from there to the end of that message.
function findInClaudeSession(selected) {
  const { dir } = claudeConfig();
  const file = mods.claude.latestTranscript(dir);
  if (!file) return null;
  const texts = mods.claude.assistantTexts(mods.claude.readTail(file));
  for (let i = texts.length - 1; i >= 0; i--) {
    const pos = mods.text.findSpoken(mods.text.spokenText(texts[i], 'markdown'), selected);
    if (pos >= 0) return { markdown: texts[i], from: pos };
  }
  return null;
}

async function readPanelSelection() {
  await load();
  const selected = (await copyFocusedSelection()).trim();
  if (!selected) return readLastClaudeReply();
  if (mods.text.isShortSelection(selected)) {
    const hit = findInClaudeSession(selected);
    if (hit) return startMarkdown(hit.markdown, 'Claude', { from: hit.from });
  }
  return startMarkdown(selected, 'Selection', { languageId: 'plaintext' });
}

async function updateClaudeWatcher() {
  await load();
  claudeWatcher?.dispose();
  claudeWatcher = null;
  const { autoRead, includeProgress, dir } = claudeConfig();
  if (!autoRead) return;
  claudeWatcher = mods.claude.watchReplies(dir, {
    includeProgress,
    onReply: (reply) => startMarkdown(reply.text, 'Claude'),
    onError: (err) => vscode.window.showErrorMessage(`Read Aloud: can't watch Claude Code sessions in ${dir}: ${err.message}`),
  });
}

async function toggleAutoRead() {
  const c = vscode.workspace.getConfiguration('readAloud');
  const next = !c.get('claude.autoRead', false);
  await c.update('claude.autoRead', next, vscode.ConfigurationTarget.Global);
  vscode.window.showInformationMessage(`Read Aloud: auto-read Claude Code replies ${next ? 'ON' : 'OFF'}.`);
}

async function toggle() {
  if (!session) return start();
  if (session.playing) pause();
  else playFrom(session.idx); // resumes at the start of the current sentence
}

function step(delta) {
  if (!session) return;
  playFrom(Math.min(Math.max(session.idx + delta, 0), session.sentences.length - 1));
}

async function voices(force) {
  const settings = await getSettings();
  const key = `voices:${settings.backend}:${settings.backend === 'azure' ? settings.azureRegion : ''}`;
  const cached = ctx.globalState.get(key);
  if (!force && cached && Date.now() - cached.at < VOICE_CACHE_MS && cached.list.length) return cached.list;
  const list = await mods.engine.listVoices(settings);
  list.sort((a, b) => a.locale.localeCompare(b.locale) || a.label.localeCompare(b.label));
  await ctx.globalState.update(key, { at: Date.now(), list });
  return list;
}

async function chooseVoice() {
  await load();
  let list;
  try {
    list = await voices();
  } catch (err) {
    vscode.window.showErrorMessage(`Read Aloud: couldn't load voices: ${err.message}`);
    return;
  }
  const current = vscode.workspace.getConfiguration('readAloud').get('voice');
  const items = list.map((v) => ({ label: v.label, description: v.gender, detail: v.shortName === current ? 'current voice' : undefined, shortName: v.shortName }));
  const pick = await vscode.window.showQuickPick(items, { placeHolder: 'Choose a voice (type to filter by name or language)', matchOnDescription: true });
  if (pick) await vscode.workspace.getConfiguration('readAloud').update('voice', pick.shortName, vscode.ConfigurationTarget.Global);
}

async function setSpeed() {
  const current = vscode.workspace.getConfiguration('readAloud').get('speed', 1);
  const options = ['0.75', '1.0', '1.1', '1.25', '1.5', '1.75', '2.0', '2.5'];
  const pick = await vscode.window.showQuickPick(options.map((o) => ({ label: `${o}×`, value: Number(o), description: Number(o) === current ? 'current' : undefined })), { placeHolder: 'Reading speed' });
  if (pick) await vscode.workspace.getConfiguration('readAloud').update('speed', pick.value, vscode.ConfigurationTarget.Global);
}

async function setAzureKey() {
  const key = await vscode.window.showInputBox({ prompt: 'Azure Speech key (stored in VS Code\'s encrypted secret storage). Leave empty to remove.', password: true, ignoreFocusOut: true });
  if (key === undefined) return;
  if (key.trim()) await ctx.secrets.store('readAloud.azureKey', key.trim());
  else await ctx.secrets.delete('readAloud.azureKey');
  vscode.window.showInformationMessage(key.trim() ? 'Read Aloud: Azure key saved.' : 'Read Aloud: Azure key removed.');
}

// ---------------------------------------------------------------- lifecycle
function activate(context) {
  ctx = context;
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'read-aloud-'));

  sentenceDeco = vscode.window.createTextEditorDecorationType({
    backgroundColor: 'rgba(255, 214, 102, 0.22)', borderRadius: '2px',
  });
  wordDeco = vscode.window.createTextEditorDecorationType({
    backgroundColor: 'rgba(255, 200, 40, 0.55)', borderRadius: '2px',
  });
  statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusItem.command = 'readAloud.toggle';
  stopItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 99);
  stopItem.text = '$(close)';
  stopItem.tooltip = 'Stop reading';
  stopItem.command = 'readAloud.stop';
  if (vscode.workspace.getConfiguration('readAloud').get('showStatusBar', true)) statusItem.show();
  updateStatus();

  const reg = (id, fn) => context.subscriptions.push(vscode.commands.registerCommand(id, fn));
  reg('readAloud.readFromHere', () => start());
  reg('readAloud.readSelection', () => start());
  reg('readAloud.toggle', toggle);
  reg('readAloud.stop', stopReading);
  reg('readAloud.next', () => step(1));
  reg('readAloud.previous', () => step(-1));
  reg('readAloud.chooseVoice', chooseVoice);
  reg('readAloud.setSpeed', setSpeed);
  reg('readAloud.setAzureKey', setAzureKey);
  reg('readAloud.readLastClaudeReply', readLastClaudeReply);
  reg('readAloud.readPanelSelection', readPanelSelection);
  reg('readAloud.toggleAutoReadClaude', toggleAutoRead);
  updateClaudeWatcher();
  context.subscriptions.push({ dispose: () => claudeWatcher?.dispose() });

  context.subscriptions.push(
    statusItem, stopItem, sentenceDeco, wordDeco,
    // Offsets go stale if the document is edited while reading: stop rather than mis-highlight.
    vscode.workspace.onDidChangeTextDocument((e) => {
      if (session && e.document === session.doc && e.contentChanges.length) {
        stopReading();
        vscode.window.setStatusBarMessage('Read Aloud stopped: the document changed', 3000);
      }
    }),
    vscode.workspace.onDidCloseTextDocument((d) => { if (session?.doc === d) stopReading(); }),
    vscode.window.onDidChangeVisibleTextEditors(() => { if (session) highlightSentence(); }),
    vscode.workspace.onDidChangeConfiguration(async (e) => {
      if (!e.affectsConfiguration('readAloud')) return;
      if (e.affectsConfiguration('readAloud.claude')) updateClaudeWatcher();
      if (e.affectsConfiguration('readAloud.showStatusBar')) {
        if (vscode.workspace.getConfiguration('readAloud').get('showStatusBar', true)) statusItem.show(); else statusItem.hide();
      }
      if (session) {
        session.settings = await getSettings();
        dropCache((j) => j > session.idx); // new voice/speed applies from the next sentence
      }
    }),
  );
}

function deactivate() {
  stopReading();
  claudeWatcher?.dispose();
  claudeWatcher = null;
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
}

module.exports = { activate, deactivate };
