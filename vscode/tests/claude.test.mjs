// Run: node vscode/tests/claude.test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { lastReply, latestTranscript, readTail, watchReplies } from '../claude.mjs';

const t0 = Date.now();
const iso = (ms) => new Date(t0 + ms).toISOString();
const line = (o) => JSON.stringify(o);
const user = (content, ms, extra = {}) => line({ type: 'user', uuid: `u${ms}`, timestamp: iso(ms), message: { role: 'user', content }, ...extra });
const asst = (block, stop, ms, extra = {}) => line({ type: 'assistant', uuid: `a${ms}`, timestamp: iso(ms), message: { role: 'assistant', content: [block], stop_reason: stop }, ...extra });

const session = [
  user('old question', 1),
  asst({ type: 'text', text: 'Old answer.' }, 'end_turn', 2),
  user('please push the PR', 10),
  asst({ type: 'thinking', thinking: 'secret thoughts' }, 'tool_use', 11),
  asst({ type: 'text', text: "I'm pushing the branch next." }, 'tool_use', 12),
  asst({ type: 'tool_use', name: 'Bash', input: { command: 'git push' } }, 'tool_use', 13),
  user([{ type: 'tool_result', content: 'Exit code 1' }], 14),
  asst({ type: 'text', text: 'subagent noise' }, 'end_turn', 15, { isSidechain: true }),
  line({ type: 'attachment', uuid: 'x', timestamp: iso(16) }),
  asst({ type: 'thinking', thinking: 'more' }, 'end_turn', 17),
  asst({ type: 'text', text: 'Nothing got pushed. **Run** `gh auth refresh` yourself.' }, 'end_turn', 18),
].join('\n');

let r = lastReply(session);
assert.equal(r.text, 'Nothing got pushed. **Run** `gh auth refresh` yourself.');
assert.equal(r.done, true);
r = lastReply(session, { includeProgress: true });
assert.equal(r.text, "I'm pushing the branch next.\n\nNothing got pushed. **Run** `gh auth refresh` yourself.");
// mid-turn (last block is a tool call) -> not done, nothing final yet
const midTurn = session.split('\n').slice(0, 6).join('\n');
assert.equal(lastReply(midTurn), null);
assert.equal(lastReply(midTurn, { includeProgress: true }).done, false);
console.log('✓ reply extraction: final-only, progress, sidechain/thinking/tool skipping, mid-turn');

// latest transcript + watcher
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-projects-'));
fs.mkdirSync(path.join(dir, '-Users-me-proj'));
const file = path.join(dir, '-Users-me-proj', 'abc.jsonl');
fs.writeFileSync(file, session.split('\n').slice(0, 2).join('\n') + '\n');
assert.equal(latestTranscript(dir), file);
assert.equal(lastReply(readTail(file)).text, 'Old answer.');

const heard = [];
const w = watchReplies(dir, { since: t0 + 5, onReply: (rep) => heard.push(rep.text) });
await new Promise((res) => setTimeout(res, 200));
fs.appendFileSync(file, session.split('\n').slice(2, 6).join('\n') + '\n'); // in progress: should not speak
await new Promise((res) => setTimeout(res, 1600));
assert.deepEqual(heard, []);
fs.appendFileSync(file, session.split('\n').slice(6).join('\n') + '\n'); // finished
await new Promise((res) => setTimeout(res, 1800));
w.dispose();
assert.deepEqual(heard, ['Nothing got pushed. **Run** `gh auth refresh` yourself.']);
console.log('✓ watcher speaks only finished, new replies');
