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

export function readTail(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const { size } = fs.fstatSync(fd);
    const start = Math.max(0, size - TAIL_BYTES);
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
  const entries = [];
  for (const line of jsonl.split('\n')) {
    if (!line.trim()) continue;
    try { entries.push(JSON.parse(line)); } catch { /* partial line being written */ }
  }
  let promptIdx = -1;
  for (let i = entries.length - 1; i >= 0; i--) if (isPrompt(entries[i])) { promptIdx = i; break; }
  const turn = entries.slice(promptIdx + 1).filter((e) => e.type === 'assistant' && !e.isSidechain && e.message);
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
export function assistantTexts(jsonl) {
  const out = [];
  for (const line of jsonl.split('\n')) {
    if (!line.trim()) continue;
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
        onReply(reply);
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
