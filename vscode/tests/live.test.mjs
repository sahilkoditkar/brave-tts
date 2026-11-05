// Tests against the REAL Edge Read Aloud service (speech.platform.bing.com), through the VS Code
// engine and the shared connection client. It sends text to Microsoft, so it is not run in CI.
// Uses HTTPS_PROXY if set; ffmpeg (optional) checks that every MP3 decodes.
// Run: node vscode/tests/live.test.mjs [--root <checkout>]   (--root: test another checkout)
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const rootArg = process.argv.indexOf('--root');
const ROOT = path.resolve(rootArg > 0 ? process.argv[rootArg + 1] : path.join(path.dirname(new URL(import.meta.url).pathname), '../..'));
const engine = await import(path.join(ROOT, 'vscode/engine.mjs'));
const { DEFAULT_SETTINGS } = await import(path.join(ROOT, 'shared/constants.js'));
const { adjustClockSkew, generateSecMsGec } = await import(path.join(ROOT, 'shared/drm.js'));
const { mapWords } = await import(path.join(ROOT, 'shared/ssml.js'));
const { EdgeClient } = await import(path.join(ROOT, 'shared/edge-client.js'));
if (process.env.HTTPS_PROXY || process.env.https_proxy) engine.setProxy(process.env.HTTPS_PROXY || process.env.https_proxy);

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'read-aloud-live-'));
const HAVE_FFMPEG = spawnSync('ffprobe', ['-version'], { stdio: 'ignore' }).status === 0;
const base = { ...DEFAULT_SETTINGS };
const nonce = () => Math.random().toString(36).slice(2, 7); // the service caches audio for repeated text
let handshakes = 0;
const connect = EdgeClient.prototype.connect;
EdgeClient.prototype.connect = function () { if (!this.conn) handshakes++; return connect.call(this); };

// -> seconds of audio; asserts it's a valid MP3 that decodes without errors
function checkMp3(audio, label) {
  assert.ok(audio.length > 1000, `${label}: got audio`);
  if (!HAVE_FFMPEG) return audio.length / 6000;
  const file = path.join(TMP, `${nonce()}.mp3`);
  fs.writeFileSync(file, audio);
  const probe = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration:stream=codec_name,sample_rate,channels', '-of', 'json', file], { encoding: 'utf8' });
  const info = JSON.parse(probe.stdout);
  assert.equal(info.streams[0].codec_name, 'mp3', label);
  assert.equal(info.streams[0].sample_rate, '24000', label);
  const decode = spawnSync('ffmpeg', ['-v', 'error', '-i', file, '-f', 'null', '-'], { encoding: 'utf8' });
  assert.equal(decode.stderr.trim(), '', `${label}: decodes cleanly`);
  return Number(info.format.duration);
}
async function say(text, settings = {}, label = text.slice(0, 30)) {
  const t0 = Date.now();
  const r = await engine.synthesize(text, { ...base, ...settings });
  const seconds = checkMp3(r.audio, label);
  const mapped = mapWords(text, r.words);
  return { ...r, seconds, mapped, ms: Date.now() - t0 };
}

// 1) voice list
let t0 = Date.now();
const voices = await engine.listVoices(base);
assert.ok(voices.length > 100, `${voices.length} voices`);
for (const v of [base.voice, 'en-US-AriaNeural', 'fr-FR-DeniseNeural', 'ja-JP-NanamiNeural']) assert.ok(voices.some((x) => x.shortName === v), v);
assert.ok(voices.every((v) => v.shortName && v.label && v.locale && v.gender));
console.log(`✓ voice list: ${voices.length} voices in ${Date.now() - t0} ms`);

// 2) word timings map back onto the text, including punctuation, numbers and contractions
let r = await say(`Dr. Smith's report, number ${nonce()}, said it's "ready" — on 3 March 2025.`);
assert.ok(r.words.length >= 8, `${r.words.length} word timings`);
assert.ok(r.mapped.length / r.words.length >= 0.8, `mapped ${r.mapped.length}/${r.words.length} words`);
assert.ok(r.words.every((w, i) => i === 0 || w.offset >= r.words[i - 1].offset), 'word offsets in order');
const lastWordEnd = (r.words.at(-1).offset + r.words.at(-1).duration) / 1e7;
assert.ok(lastWordEnd <= r.seconds + 0.1, 'word timings within the audio');
console.log(`✓ word timings: ${r.mapped.length}/${r.words.length} words mapped to the text (${r.ms} ms)`);

// 3) text that must be escaped, and characters the service rejects
r = await say(`Tom & Jerry <script>alert(1)</script> "quoted" 'single' ${nonce()}\u000b done.`);
assert.ok(r.words.some((w) => /Jerry/.test(w.text)) && r.words.some((w) => /done/.test(w.text)), 'all of it was read');
console.log(`✓ XML special characters and control characters (${r.ms} ms)`);

// 4) other languages
r = await say(`Bonjour, ceci est un essai numéro ${nonce()} de la voix française.`, { voice: 'fr-FR-DeniseNeural' });
assert.ok(r.words.length >= 5);
const ja = await say(`これはテストです。番号${nonce()}。`, { voice: 'ja-JP-NanamiNeural' });
console.log(`✓ French (${r.words.length} words, ${r.ms} ms) and Japanese (${ja.seconds.toFixed(1)} s of audio, ${ja.ms} ms)`);

// 5) speed and pitch
const sample = `The quick brown fox, number ${nonce()}, jumps over the lazy dog today.`;
const normal = await say(sample, { voice: 'en-US-AriaNeural' });
const fast = await say(sample, { voice: 'en-US-AriaNeural', rate: 2 });
const slow = await say(sample, { voice: 'en-US-AriaNeural', rate: 0.5 });
await say(sample, { voice: 'en-US-AriaNeural', rate: 3, pitch: 50 });
await say(sample, { voice: 'en-US-AriaNeural', pitch: -50 });
assert.ok(fast.seconds < normal.seconds * 0.75, `2x: ${fast.seconds} vs ${normal.seconds} s`);
assert.ok(slow.seconds > normal.seconds * 1.4, `0.5x: ${slow.seconds} vs ${normal.seconds} s`);
console.log(`✓ speed: ${slow.seconds.toFixed(1)} s at 0.5x, ${normal.seconds.toFixed(1)} s at 1x, ${fast.seconds.toFixed(1)} s at 2x; pitch ±50 Hz`);

// 6) a long sentence (the longest the sentence splitter makes), with the default (slow) voice
const long = Array.from({ length: 95 }, (_, i) => ['river', 'garden', 'morning', 'letter', 'quiet', 'market'][i % 6]).join(' ');
r = await say(`Long ${nonce()}: ${long}.`);
assert.ok(r.seconds > 25, `${r.seconds} s of audio`);
console.log(`✓ a ${long.length + 12}-character sentence with ${base.voice}: ${r.seconds.toFixed(1)} s of audio in ${r.ms} ms`);

// 7) cancelled mid-stream, then the next request on the same connection
handshakes = 0;
const ac = new AbortController();
const cancelled = engine.synthesize(`This one is cancelled, number ${nonce()}, while it is arriving.`, base, ac.signal);
cancelled.catch(() => {});
await new Promise((res) => setTimeout(res, 300));
ac.abort();
await assert.rejects(cancelled, { name: 'AbortError' });
r = await say(`And this one is read, number ${nonce()}.`);
const conns = (n) => (n ? `${n} new connection${n === 1 ? '' : 's'}` : 'reused the open connection');
console.log(`✓ cancel, then the next sentence (${r.ms} ms, ${conns(handshakes)})`);

// 8) several requests at once on one connection: each gets its own audio and words
handshakes = 0;
const texts = ['Alpha', 'Bravo', 'Charlie'].map((w) => `${w} is the word in sentence ${nonce()}.`);
t0 = Date.now();
const all = await Promise.all(texts.map((t) => engine.synthesize(t, base)));
all.forEach((x, i) => {
  checkMp3(x.audio, texts[i]);
  assert.equal(x.words[0].text, texts[i].split(' ')[0], 'audio and words belong to the right request');
});
console.log(`✓ 3 requests at once, none mixed up (${Date.now() - t0} ms, ${conns(handshakes)})`);

// 9) clock off by an hour: the speech service rejects the token (403), and the clock is corrected
// from its reply. (The voice list doesn't check the token: it works with the wrong clock as is.)
const clockRight = () => generateSecMsGec() === generateSecMsGec(Date.now() / 1000);
engine.closeConnection();
adjustClockSkew(new Date(Date.now() + 3600e3).toUTCString());
assert.ok(!clockRight());
r = await say(`Clock check ${nonce()}.`);
assert.ok(clockRight(), 'clock corrected from the rejected handshake');
adjustClockSkew(new Date(Date.now() + 3600e3).toUTCString());
assert.ok((await engine.listVoices(base)).length > 100, 'voice list with a wrong clock');
adjustClockSkew(new Date().toUTCString());
console.log(`✓ wrong clock: speech handshake rejected, clock corrected from the reply, read in ${r.ms} ms; voice list unaffected`);

// 10) "Read Aloud: Test Connection"
const steps = await engine.diagnose(base);
assert.ok(steps.every((s) => s.ok), JSON.stringify(steps));
console.log(`✓ Test Connection: ${steps.map((s) => `${s.step} ${s.ms} ms`).join(', ')}`);

engine.closeConnection();
fs.rmSync(TMP, { recursive: true, force: true });
console.log('ALL PASSED');
process.exit(0);
