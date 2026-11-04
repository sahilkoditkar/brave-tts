// Reads Claude Code replies from its local session transcripts.
// The Claude Code chat panel is another extension's sandboxed webview, so its content can't be
// read directly — but Claude Code writes every session to ~/.claude/projects/<project>/<id>.jsonl.
// We only ever READ these files, and only take the assistant's text (no tool calls/output/thinking).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TAIL_BYTES = 4 * 1024 * 1024;

export function projectsDir(override) {
  if (override) return override.replace(/^~(?=$|[\\/])/, os.homedir());
  const base = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
  return path.join(base, 'projects');
}

// Session title as shown on the Claude Code tab (latest custom title / agent name / summary).
const TITLE_KEYS = ['customTitle', 'agentName', 'summary'];
const TITLE_RES = TITLE_KEYS.map((key) => new RegExp(`"${key}":"((?:[^"\\\\]|\\\\.)*)"`, 'g'));

// -> { customTitle?, agentName?, summary? }: the last value of each key in `text`
function titleKeys(text) {
  const out = {};
  TITLE_KEYS.forEach((key, k) => {
    const re = TITLE_RES[k];
    re.lastIndex = 0;
    let m;
    let last = null;
    while ((m = re.exec(text))) last = m[1];
    if (last != null) {
      try { out[key] = JSON.parse(`"${last}"`); } catch { out[key] = last; }
    }
  });
  return out;
}
const pickTitle = (keys) => TITLE_KEYS.map((k) => keys[k]).find((v) => v != null) ?? '';

function readHead(file, bytes = 512 * 1024) {
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(bytes);
    const n = fs.readSync(fd, buf, 0, bytes, 0);
    return buf.subarray(0, n).toString('utf8');
  } finally {
    fs.closeSync(fd);
  }
}

// -> [{ file, project, title, mtimeMs }] newest first (top-level transcripts only)
export function listSessions(dir) {
  const out = [];
  let projects;
  try { projects = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const p of projects) {
    if (!p.isDirectory()) continue;
    const pdir = path.join(dir, p.name);
    let entries;
    try { entries = fs.readdirSync(pdir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (!e.isFile() || !e.name.endsWith('.jsonl')) continue;
      const file = path.join(pdir, e.name);
      try { out.push({ file, project: p.name, mtimeMs: fs.statSync(file).mtimeMs }); } catch { /* ignore */ }
    }
  }
  out.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return out;
}

function readRange(file, start, end) {
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(end - start);
    const n = fs.readSync(fd, buf, 0, buf.length, start);
    return buf.subarray(0, n).toString('utf8');
  } finally {
    fs.closeSync(fd);
  }
}

// Titles are looked up for many sessions at once (to match the tab you're looking at), so they're
// cached per file, and when a transcript grows only the new part is read.
const titleCache = new Map(); // file -> { size, mtimeMs, keys, title }
export function sessionTitle(file) {
  try {
    const { size, mtimeMs } = fs.statSync(file);
    const cached = titleCache.get(file);
    if (cached && cached.size === size && cached.mtimeMs === mtimeMs) return cached.title;
    let keys;
    if (cached && size > cached.size) {
      // a little overlap, in case the last write was cut mid-line
      keys = { ...cached.keys, ...titleKeys(readRange(file, Math.max(0, cached.size - 4096), size)) };
    } else {
      keys = titleKeys(readTail(file, 1024 * 1024));
      if (!pickTitle(keys)) keys = titleKeys(readHead(file));
    }
    const title = pickTitle(keys);
    titleCache.set(file, { size, mtimeMs, keys, title });
    return title;
  } catch {
    return '';
  }
}

// Claude Code names project folders after the workspace path, e.g. /Users/me/proj -> -Users-me-proj
export function projectSlug(fsPath) {
  return fsPath.replace(/[^a-zA-Z0-9]/g, '-');
}

// Newest top-level transcript (<project>/<session>.jsonl); subagent transcripts live deeper.
export function latestTranscript(dir) {
  let best = null;
  let projects;
  try { projects = fs.readdirSync(dir, { withFileTypes: true }); } catch { return null; }
  for (const p of projects) {
    if (!p.isDirectory()) continue;
    const pdir = path.join(dir, p.name);
    let entries;
    try { entries = fs.readdirSync(pdir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (!e.isFile() || !e.name.endsWith('.jsonl')) continue;
      const file = path.join(pdir, e.name);
      try {
        const { mtimeMs } = fs.statSync(file);
        if (!best || mtimeMs > best.mtimeMs) best = { file, mtimeMs };
      } catch { /* ignore */ }
    }
  }
  return best?.file || null;
}

export function readTail(file, bytes = TAIL_BYTES) {
  const fd = fs.openSync(file, 'r');
  try {
    const { size } = fs.fstatSync(fd);
    const start = Math.max(0, size - bytes);
    const buf = Buffer.alloc(size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    let text = buf.toString('utf8');
    if (start > 0) text = text.slice(text.indexOf('\n') + 1); // drop partial first line
    return text;
  } finally {
    fs.closeSync(fd);
  }
}

const isPrompt = (e) => {
  if (e.type !== 'user' || e.isMeta || e.isSidechain) return false;
  const c = e.message?.content;
  if (typeof c === 'string') return c.trim().length > 0;
  return Array.isArray(c) && c.some((b) => b?.type === 'text');
};

// -> { text, done, id, timestamp } for the latest turn, or null.
//    includeProgress=false: only the final message (text after the last tool call).
export function lastReply(jsonl, { includeProgress = false } = {}) {
  // Walk back from the end and parse only the latest turn (transcripts are mostly older turns).
  const entries = [];
  for (let end = jsonl.length; end > 0;) {
    const start = jsonl.lastIndexOf('\n', end - 1) + 1;
    const line = jsonl.slice(start, end);
    end = start - 1;
    if (!line.trim()) continue;
    let e;
    try { e = JSON.parse(line); } catch { continue; } // partial line being written
    if (isPrompt(e)) break;
    entries.push(e);
  }
  entries.reverse();
  const turn = entries.filter((e) => e.type === 'assistant' && !e.isSidechain && e.message);
  if (!turn.length) return null;

  let blocks = [];
  for (const e of turn) {
    for (const b of Array.isArray(e.message.content) ? e.message.content : []) blocks.push({ ...b, entry: e });
  }
  if (!includeProgress) {
    let lastTool = -1;
    blocks.forEach((b, i) => { if (b.type === 'tool_use') lastTool = i; });
    blocks = blocks.slice(lastTool + 1);
  }
  const texts = blocks.filter((b) => b.type === 'text' && b.text?.trim());
  if (!texts.length) return null;
  const last = turn[turn.length - 1];
  const lastText = texts[texts.length - 1].entry;
  return {
    text: texts.map((b) => b.text.trim()).join('\n\n'),
    done: last.message.stop_reason === 'end_turn',
    id: lastText.uuid || lastText.message.id,
    timestamp: Date.parse(lastText.timestamp || '') || 0,
  };
}

// All assistant text blocks in a transcript, oldest first (for finding a selected phrase).
const ASSISTANT_LINE = /"type"\s*:\s*"assistant"/;
export function assistantTexts(jsonl) {
  const out = [];
  for (const line of jsonl.split('\n')) {
    if (!ASSISTANT_LINE.test(line)) continue; // skip parsing tool output etc. (most of the bytes)
    let e;
    try { e = JSON.parse(line); } catch { continue; }
    if (e.type !== 'assistant' || e.isSidechain || !Array.isArray(e.message?.content)) continue;
    for (const b of e.message.content) if (b?.type === 'text' && b.text?.trim()) out.push(b.text);
  }
  return out;
}

// Calls onReply(reply) when a session finishes a new reply (debounced after writes settle).
export function watchReplies(dir, { includeProgress, since = Date.now(), onReply, onError }) {
  const timers = new Map();
  const spoken = new Set();
  let watcher;
  try {
    watcher = fs.watch(dir, { recursive: true }, (_event, rel) => {
      if (!rel || !rel.endsWith('.jsonl') || rel.split(/[\\/]/).length !== 2) return;
      const file = path.join(dir, rel);
      clearTimeout(timers.get(file));
      timers.set(file, setTimeout(() => {
        timers.delete(file);
        let reply;
        try { reply = lastReply(readTail(file), { includeProgress }); } catch { return; }
        if (!reply?.done || reply.timestamp < since || spoken.has(reply.id)) return;
        spoken.add(reply.id);
        onReply(reply, file);
      }, 1200));
    });
  } catch (err) {
    onError?.(err);
    return { dispose() {} };
  }
  return {
    dispose() {
      watcher.close();
      for (const t of timers.values()) clearTimeout(t);
    },
  };
}
