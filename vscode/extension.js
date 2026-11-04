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
      import('./engine.mjs'), import('./text.mjs'), import('./player.mjs'), import('../shared/ssml.js'),
      import('./claude.mjs'),
    ]);
    mods = { engine, text, player, ssml, claude };
  }
  return mods;
}

let ctx;
let log = { appendLine() {} }; // "Read Aloud" output channel (View → Output) for troubleshooting
const trace = (msg) => log.appendLine(`[${new Date().toLocaleTimeString()}] ${msg}`);
let statusItem; // main button: menu when idle, play/pause while reading
let stopItem;
let prevItem;
let nextItem;
let speedItem;
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

const short = (t, n = 18) => (t.length > n ? `${t.slice(0, n - 1)}…` : t);

function updateStatus(state) {
  if (!statusItem) return;
  const controls = [prevItem, nextItem, speedItem, stopItem];
  if (!session) {
    statusItem.text = '$(unmute) Read Aloud';
    statusItem.tooltip = 'Read Aloud: open menu (read, Claude replies, voice, speed)';
    statusItem.command = 'readAloud.menu';
    controls.forEach((i) => i.hide());
  } else {
    const pos = `${session.label ? `${short(session.label)} ` : ''}${session.idx + 1}/${session.sentences.length}`;
    statusItem.text = state === 'loading' ? `$(loading~spin) ${pos}`
      : session.playing ? `$(debug-pause) ${pos}` : `$(play) ${pos}`;
    statusItem.tooltip = `${session.playing ? 'Pause' : 'Resume'} reading${session.label ? ` — ${session.label}` : ''}`;
    statusItem.command = 'readAloud.toggle';
    speedItem.text = `${Number(session.settings.rate).toFixed(2).replace(/0$/, '')}×`;
    controls.forEach((i) => i.show());
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
    autoReadSessions: c.get('claude.autoReadSessions', 'focused'),
    includeProgress: c.get('claude.includeProgressUpdates', false),
    dir: mods.claude.projectsDir(c.get('claude.projectsDir', '')),
  };
}

const norm = (t) => String(t || '').trim().toLowerCase();

// The Claude Code tab you're looking at, if any: its label is the session's title.
function activeClaudeTabTitle(sessions) {
  const groups = vscode.window.tabGroups;
  if (!groups) return null;
  const titles = new Map(sessions.map((s) => [norm(s.title), s]));
  const active = groups.activeTabGroup?.activeTab;
  if (active && titles.has(norm(active.label))) return active.label;
  // Otherwise a Claude tab that's visible in another editor group (split view)
  const visible = groups.all.map((g) => g.activeTab).filter((t) => t && titles.has(norm(t.label)));
  return visible.length === 1 ? visible[0].label : null;
}

function workspaceSlugs() {
  return (vscode.workspace.workspaceFolders || []).map((f) => mods.claude.projectSlug(f.uri.fsPath));
}

// Which session to read:
//  1. the Claude Code tab you're looking at (matched by its title), else
//  2. the most recently active session of this workspace's folder, else
//  3. the most recently active session anywhere.
function targetSession() {
  const { dir } = claudeConfig();
  const sessions = mods.claude.listSessions(dir).slice(0, 40);
  for (const s of sessions) s.title = mods.claude.sessionTitle(s.file);
  const tabTitle = activeClaudeTabTitle(sessions);
  if (tabTitle) return { ...sessions.find((s) => norm(s.title) === norm(tabTitle)), how: 'open tab' };
  const slugs = workspaceSlugs();
  const inWorkspace = sessions.find((s) => slugs.includes(s.project));
  if (inWorkspace) return { ...inWorkspace, how: 'latest in this workspace' };
  return sessions[0] ? { ...sessions[0], how: 'latest anywhere' } : null;
}

async function readReplyFrom(target) {
  const { dir, includeProgress } = claudeConfig();
  if (!target) {
    vscode.window.showInformationMessage(`Read Aloud: no Claude Code sessions found in ${dir}.`);
    return;
  }
  const title = target.title || 'Claude';
  const reply = mods.claude.lastReply(mods.claude.readTail(target.file), { includeProgress });
  if (!reply) {
    vscode.window.showInformationMessage(`Read Aloud: "${title}" has no finished reply text yet.`);
    return;
  }
  if (await startMarkdown(reply.text, title)) vscode.window.setStatusBarMessage(`$(unmute) Reading reply from "${title}" (${target.how})`, 4000);
  else vscode.window.showInformationMessage('Read Aloud: nothing readable in that reply.');
}

async function readLastClaudeReply() {
  await load();
  return readReplyFrom(targetSession());
}

async function pickSessionAndRead() {
  await load();
  const { dir } = claudeConfig();
  const sessions = mods.claude.listSessions(dir).slice(0, 25);
  if (!sessions.length) { vscode.window.showInformationMessage(`Read Aloud: no Claude Code sessions found in ${dir}.`); return; }
  const ago = (ms) => { const m = Math.round((Date.now() - ms) / 60000); return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} d ago`; };
  const pick = await vscode.window.showQuickPick(sessions.map((s) => {
    const title = mods.claude.sessionTitle(s.file) || '(untitled session)';
    return { label: title, description: ago(s.mtimeMs), detail: s.project.replace(/^-/, '/').replace(/-/g, '/'), session: { ...s, title, how: 'picked' } };
  }), { placeHolder: 'Read the last reply of which Claude Code session?' });
  if (pick) return readReplyFrom(pick.session);
}

// Copy whatever is selected in the focused panel (e.g. the Claude Code chat webview, which other
// extensions can't read directly). The previous clipboard text is restored afterwards.
// -> { copied: text from the automatic copy ('' if it didn't work), previous: clipboard before }
async function copyFocusedSelection() {
  const previous = await vscode.env.clipboard.readText();
  const sentinel = `\u2063read-aloud-${Date.now()}`;
  await vscode.env.clipboard.writeText(sentinel);
  let text = sentinel;
  for (const command of ['editor.action.clipboardCopyAction', 'execCopy']) {
    try {
      await vscode.commands.executeCommand(command);
    } catch (err) {
      trace(`copy via ${command} failed: ${err.message}`);
      continue;
    }
    for (let i = 0; i < 20 && text === sentinel; i++) {
      await new Promise((r) => setTimeout(r, 30));
      text = await vscode.env.clipboard.readText();
    }
    if (text !== sentinel) { trace(`copied ${text.length} chars via ${command}`); break; }
  }
  await vscode.env.clipboard.writeText(previous);
  return { copied: text === sentinel ? '' : text, previous };
}

// Find a selected word/phrase in the session you're looking at (then other recent ones)
// -> read from there to the end of that message.
function findInClaudeSession(selected) {
  const target = targetSession();
  const { dir } = claudeConfig();
  const files = [target?.file, ...mods.claude.listSessions(dir).slice(0, 10).map((s) => s.file)].filter(Boolean);
  for (const file of [...new Set(files)]) {
    const texts = mods.claude.assistantTexts(mods.claude.readTail(file));
    for (let i = texts.length - 1; i >= 0; i--) {
      const pos = mods.text.findSpoken(mods.text.spokenText(texts[i], 'markdown'), selected);
      if (pos >= 0) return { markdown: texts[i], from: pos, title: file === target?.file ? target.title : mods.claude.sessionTitle(file) };
    }
  }
  return null;
}

// ⌘⌥R / right-click in the Claude Code panel:
//   a word or short phrase selected -> read from there to the end of that reply
//   a longer passage selected      -> read just that
//   nothing selected               -> read the session's last reply
// If the automatic copy doesn't work, text you copied yourself (⌘C) is used instead, but only
// if it really appears in a Claude reply, so random clipboard contents are never read.
async function readPanelSelection() {
  await load();
  const { copied, previous } = await copyFocusedSelection();
  let selected = copied.trim();
  let source = 'selection';
  if (!selected && previous?.trim() && previous.trim().length <= 20000) {
    const probe = previous.trim().split('\n').find((l) => l.trim().length > 0)?.trim().slice(0, 80) || '';
    if (probe && findInClaudeSession(probe)) {
      selected = previous.trim();
      source = 'clipboard';
    }
  }
  trace(`read selection: source=${selected ? source : 'none'} chars=${selected.length}`);
  if (!selected) {
    vscode.window.setStatusBarMessage('Read Aloud: no selection detected — reading the last reply (tip: ⌘C the text, then ⌘⌥R)', 5000);
    return readLastClaudeReply();
  }
  if (mods.text.isShortSelection(selected)) {
    const hit = findInClaudeSession(selected);
    trace(hit ? `found "${selected}" in "${hit.title}"` : `"${selected}" not found in recent Claude replies`);
    if (hit) return startMarkdown(hit.markdown, hit.title || 'Claude', { from: hit.from });
  }
  if (!mods.text.isShortSelection(selected)) {
    // A longer selection copied from a reply: read it, starting where it starts in the reply
    const hit = findInClaudeSession(selected.split('\n')[0].trim().slice(0, 80));
    if (hit) {
      const spoken = mods.text.spokenText(hit.markdown, 'markdown');
      const end = mods.text.findSpoken(spoken, selected.split('\n').filter((l) => l.trim()).pop().trim().slice(-60));
      if (end >= hit.from) {
        const tail = selected.split('\n').filter((l) => l.trim()).pop().trim().slice(-60);
        return startMarkdown(hit.markdown.slice(0, end + tail.length), hit.title || 'Claude', { from: hit.from });
      }
    }
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
    onReply: (reply, file) => {
      // "focused" (default): only the session you're looking at — or, if no Claude tab is in
      // front, sessions of this workspace. "all": any session that finishes.
      const title = mods.claude.sessionTitle(file) || 'Claude';
      if (claudeConfig().autoReadSessions !== 'all') {
        const target = targetSession();
        const isTarget = target?.file === file;
        const tabOpen = target?.how === 'open tab';
        const inWorkspace = workspaceSlugs().includes(path.basename(path.dirname(file)));
        if (tabOpen ? !isTarget : !(inWorkspace || isTarget)) return;
      }
      startMarkdown(reply.text, title);
    },
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

async function nudgeSpeed(delta) {
  const c = vscode.workspace.getConfiguration('readAloud');
  const next = Math.min(3, Math.max(0.5, Math.round((c.get('speed', 1) + delta) * 10) / 10));
  await c.update('speed', next, vscode.ConfigurationTarget.Global);
  vscode.window.setStatusBarMessage(`Read Aloud speed: ${next}×`, 1500);
}

async function setSpeed() {
  const current = vscode.workspace.getConfiguration('readAloud').get('speed', 1);
  const options = ['0.75', '1.0', '1.1', '1.25', '1.5', '1.75', '2.0', '2.5'];
  const pick = await vscode.window.showQuickPick(options.map((o) => ({ label: `${o}×`, value: Number(o), description: Number(o) === current ? 'current' : undefined })), { placeHolder: 'Reading speed' });
  if (pick) await vscode.workspace.getConfiguration('readAloud').update('speed', pick.value, vscode.ConfigurationTarget.Global);
}

// One menu for everything (status bar button when idle).
async function menu() {
  await load();
  const c = vscode.workspace.getConfiguration('readAloud');
  const target = (() => { try { return targetSession(); } catch { return null; } })();
  const voice = c.get('voice', '').replace(/^[a-z]{2,}-[A-Z]{2,}-/, '').replace(/Neural$/, '').replace(/([a-z])([A-Z])/g, '$1 $2');
  const items = [
    { label: '$(play) Read from cursor / selection', description: '⌘⌥R', run: () => start() },
    { label: '$(comment-discussion) Read last Claude Code reply', description: target ? `"${target.title || 'untitled'}" · ${target.how}` : 'no sessions found', run: readLastClaudeReply },
    { label: '$(list-selection) Read a reply from another session…', run: pickSessionAndRead },
    { label: `$(sync) Auto-read Claude replies: ${c.get('claude.autoRead', false) ? 'On' : 'Off'}`, description: 'toggle', run: toggleAutoRead },
    { label: '', kind: vscode.QuickPickItemKind?.Separator ?? -1 },
    { label: `$(dashboard) Speed: ${c.get('speed', 1)}×`, run: setSpeed },
    { label: `$(person) Voice: ${voice}`, run: chooseVoice },
    { label: '$(settings-gear) All Read Aloud settings', run: () => vscode.commands.executeCommand('workbench.action.openSettings', 'readAloud') },
  ];
  const pick = await vscode.window.showQuickPick(items, { placeHolder: 'Read Aloud' });
  if (pick?.run) await pick.run();
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
  log = vscode.window.createOutputChannel('Read Aloud');
  context.subscriptions.push(log);
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'read-aloud-'));

  sentenceDeco = vscode.window.createTextEditorDecorationType({
    backgroundColor: 'rgba(255, 214, 102, 0.22)', borderRadius: '2px',
  });
  wordDeco = vscode.window.createTextEditorDecorationType({
    backgroundColor: 'rgba(255, 200, 40, 0.55)', borderRadius: '2px',
  });
  // Status bar while reading:  [⏮] [⏸ title 3/12] [⏭] [1.25×] [✕]
  const item = (priority, text, tooltip, command) => {
    const it = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, priority);
    Object.assign(it, { text, tooltip, command });
    return it;
  };
  prevItem = item(104, '$(chevron-left)', 'Previous sentence', 'readAloud.previous');
  statusItem = item(103, '', '', 'readAloud.menu');
  nextItem = item(102, '$(chevron-right)', 'Next sentence', 'readAloud.next');
  speedItem = item(101, '1×', 'Reading speed (click to change)', 'readAloud.setSpeed');
  stopItem = item(100, '$(close)', 'Stop reading', 'readAloud.stop');
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
  reg('readAloud.readPanelFromHere', readPanelSelection); // right-click menu inside webviews (Claude Code panel)
  reg('readAloud.toggleAutoReadClaude', toggleAutoRead);
  reg('readAloud.readClaudeSession', pickSessionAndRead);
  reg('readAloud.menu', menu);
  reg('readAloud.faster', () => nudgeSpeed(0.1));
  reg('readAloud.slower', () => nudgeSpeed(-0.1));
  updateClaudeWatcher();
  context.subscriptions.push({ dispose: () => claudeWatcher?.dispose() });

  context.subscriptions.push(
    statusItem, stopItem, prevItem, nextItem, speedItem, sentenceDeco, wordDeco,
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
        updateStatus(session.playing ? 'playing' : undefined);
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
