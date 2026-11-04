// Microbenchmarks for the VS Code side: Claude Code transcript scanning and text splitting.
// Generates ~100 MB of fake transcripts in the temp folder once. Run: node vscode/tests/bench.mjs
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
const R = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
const claude = await import(path.join(R, 'vscode/claude.mjs'));
const text = await import(path.join(R, 'vscode/text.mjs'));
const dir = path.join(os.tmpdir(), 'ra-bench-projects');
if (!fs.existsSync(dir)) {
  // 40 sessions x ~3 MB of transcript (prompts, tool calls, tool output, replies)
  for (let s = 0; s < 40; s++) {
    const pdir = path.join(dir, `-Users-me-proj${s % 5}`); fs.mkdirSync(pdir, { recursive: true });
    const lines = [JSON.stringify({ type: 'summary', summary: `Session ${s}` })];
    for (let t = 0; t < 120; t++) {
      lines.push(JSON.stringify({ type: 'user', message: { content: `Prompt ${t} please do the thing` } }));
      lines.push(JSON.stringify({ type: 'assistant', uuid: `a${s}-${t}`, message: { id: 'm', stop_reason: 'tool_use', content: [{ type: 'text', text: `Let me look at file ${t}.` }, { type: 'tool_use', name: 'Read', input: { file: 'x' } }] } }));
      lines.push(JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', content: 'x'.repeat(20000) }] } }));
      lines.push(JSON.stringify({ type: 'assistant', uuid: `b${s}-${t}`, timestamp: new Date().toISOString(), message: { id: 'm2', stop_reason: 'end_turn', content: [{ type: 'text', text: `Done with step ${t}. The **result** is in \`out.txt\`, and the tests pass. Unique phrase number ${s}-${t} here.` }] } }));
    }
    fs.writeFileSync(path.join(pdir, `sess${s}.jsonl`), lines.join('\n') + '\n');
  }
}
const time = (label, fn, n = 3) => { fn(); const t = performance.now(); for (let i = 0; i < n; i++) fn(); console.log(`${label.padEnd(44)} ${((performance.now() - t) / n).toFixed(1)} ms`); };
claude.listSessions(dir).slice(0, 40).forEach((s) => claude.sessionTitle(s.file)); // first call reads them all
time('listSessions + 40 titles (targetSession)', () => { for (const s of claude.listSessions(dir).slice(0, 40)) claude.sessionTitle(s.file); });
const newest = claude.listSessions(dir)[0].file;
time('lastReply(readTail(newest))', () => claude.lastReply(claude.readTail(newest)));
time('find phrase in 11 sessions (panel select)', () => {
  for (const s of claude.listSessions(dir).slice(0, 11)) {
    const texts = claude.assistantTexts(claude.readTail(s.file));
    for (let i = texts.length - 1; i >= 0; i--) if (text.findSpoken(text.spokenText(texts[i], 'markdown'), 'phrase number 0-3') >= 0) return;
  }
});
let md = '';
for (let k = 0; k < 4000; k++) md += `## Heading ${k}\n\nSome *prose* with a [link](http://x.y/${k}) and \`code\`. Dr. Who said hi. Another sentence follows here, for testing.\n\n\`\`\`js\nconst x = ${k};\n\`\`\`\n\n`;
console.log(`markdown doc: ${(md.length / 1e6).toFixed(2)} MB`);
time('spokenText(markdown)', () => text.spokenText(md, 'markdown'));
const spoken = text.spokenText(md, 'markdown');
time('sentencesInRange from start', () => text.sentencesInRange(spoken, 0, spoken.length, 'en'));
time('sentencesInRange from 90% (cursor)', () => text.sentencesInRange(spoken, Math.floor(spoken.length * 0.9), spoken.length, 'en'));
time('findSpoken in 1 MB', () => text.findSpoken(spoken, 'Heading 3999'));
