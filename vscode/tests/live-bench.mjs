// Benchmark against the REAL Edge Read Aloud service (speech.platform.bing.com), not the fake one.
// It sends text to Microsoft, so it is not run in CI. Run: node vscode/tests/live-bench.mjs [options]
//
// It reads a generated article (new random words every run, because the service caches audio for
// text it has seen: a repeated sentence comes back in ~150 ms instead of seconds) through the real
// engine and connection client, and plays it back in real time the way each extension does:
//   --mode file    VS Code: a sentence plays once all of its audio has arrived (OS player)
//   --mode stream  browser: a sentence starts with its first chunk, and stalls if audio arrives late
// Like both extensions, it asks for the current sentence and the next 2 when a sentence starts.
//
// Options: --voice <name> (default: the extensions' default voice), --runs <n>, --json,
//          --root <dir> to benchmark another checkout (e.g. a git worktree of an older commit).
// Uses HTTPS_PROXY if it is set.
import path from 'node:path';

const arg = (name, dflt) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : dflt; };
const ROOT = path.resolve(arg('root', path.join(path.dirname(new URL(import.meta.url).pathname), '../..')));
const engine = await import(path.join(ROOT, 'vscode/engine.mjs'));
const { DEFAULT_SETTINGS } = await import(path.join(ROOT, 'shared/constants.js'));
const shared = await import(path.join(ROOT, 'shared/sentences.js'));
const text = await import(path.join(ROOT, 'vscode/text.mjs'));

const MODE = arg('mode', 'stream');
const RUNS = Number(arg('runs', 1));
const PREFETCH_AHEAD = 2; // both extensions
const settings = { ...DEFAULT_SETTINGS, voice: arg('voice', DEFAULT_SETTINGS.voice), rate: Number(arg('rate', 1)) };
if (process.env.HTTPS_PROXY || process.env.https_proxy) engine.setProxy(process.env.HTTPS_PROXY || process.env.https_proxy);
const audioMs = (bytes) => bytes / 6; // audio-24khz-48kbitrate-mono-mp3: 6000 bytes per second
const sleepUntil = (t) => new Promise((r) => setTimeout(r, Math.max(0, t - performance.now())));

// A ~200-word article with realistic sentence lengths, random words (so nothing is cached).
// --first <n>: make the first sentence n words long.
const LENGTHS = [Number(arg('first', 14)), 22, 9, 31, 18, 12, 26, 7, 20, 16, 24, 11];
const VOCAB = ('the a city council river garden morning letter quiet market simple yellow travel number orange island ' +
  'pencil summer winter forest bridge planet engine window station teacher library careful bright ancient modern ' +
  'small large early late often rarely quickly slowly people children workers visitors builds opens follows ' +
  'carries reaches finds keeps makes').split(' ');
function article() {
  const pick = () => VOCAB[Math.floor(Math.random() * VOCAB.length)];
  return LENGTHS.map((n) => {
    const w = Array.from({ length: n }, pick);
    if (n > 12) w[Math.floor(n / 2) - 1] += ','; // a natural pause, like real prose
    w[0] = w[0][0].toUpperCase() + w[0].slice(1);
    return `${w.join(' ')}.`;
  }).join(' ');
}

async function read() {
  const doc = article();
  const t0 = performance.now();
  engine.warmUp(settings); // both extensions connect while the text is being prepared
  let sentences = shared.sentencesOf(doc, 'en').map((s) => ({ ...s, speak: s.text }));
  // Both split a long first sentence at a pause (older browser builds didn't: no shared quickStart).
  const quickStart = MODE === 'file' ? text.quickStart : shared.quickStart;
  if (quickStart) sentences = quickStart(sentences);
  const entries = new Map();
  const request = (j) => {
    if (j >= sentences.length || entries.has(j)) return;
    const e = { chunks: [], bytes: 0, first: null, done: null, err: null };
    e.promise = engine.synthesize(sentences[j].speak, settings, undefined, {
      onAudio: (c) => { e.first ??= performance.now(); e.chunks.push([performance.now(), e.bytes]); e.bytes += c.length; },
    }).then((r) => { e.done = performance.now(); e.bytes = r.audio.length; },
      (err) => { e.done = performance.now(); e.err = err; });
    entries.set(j, e);
  };
  const out = { firstAudioMs: null, gaps: [], stallMs: 0, failed: 0, audioMs: 0, sentences: sentences.length };
  let prevEnd = null;
  for (let i = 0; i < sentences.length; i++) {
    for (let j = i; j <= i + PREFETCH_AHEAD; j++) request(j); // playFrom(i)
    const e = entries.get(i);
    await e.promise; // (stream mode: playback started at the first chunk, computed below)
    if (e.err) { out.failed++; out.errors = [...(out.errors || []), e.err.message]; continue; }
    const dur = audioMs(e.bytes);
    let start;
    let stall = 0;
    if (MODE === 'stream') {
      start = Math.max(e.first ?? e.done, prevEnd ?? 0);
      // Chunk k can't play before it arrives: playback falls behind by the worst shortfall.
      for (const [at, before] of e.chunks) stall = Math.max(stall, at - (start + audioMs(before)));
    } else {
      start = Math.max(e.done, prevEnd ?? 0);
    }
    if (prevEnd == null) out.firstAudioMs = start - t0;
    else out.gaps.push(start - prevEnd);
    out.stallMs += stall;
    out.audioMs += dur;
    prevEnd = start + stall + dur;
    await sleepUntil(prevEnd); // the next sentence is requested when this one ends, as in the apps
  }
  out.wallMs = (prevEnd ?? performance.now()) - t0;
  engine.closeConnection();
  return out;
}

const r0 = (x) => Math.round(x);
const median = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : 0; };
const results = [];
for (let k = 0; k < RUNS; k++) {
  const r = await read();
  results.push(r);
  const silence = r.gaps.reduce((a, b) => a + b, 0) + r.stallMs;
  if (!process.argv.includes('--json')) {
    console.log(`[${MODE}] ${settings.voice}: first audio ${r0(r.firstAudioMs)} ms | silence between sentences: total ${r0(silence)} ms ` +
      `(median gap ${r0(median(r.gaps))}, max ${r0(Math.max(0, ...r.gaps))}, mid-sentence stalls ${r0(r.stallMs)}) | ` +
      `failed sentences ${r.failed}/${r.sentences} | ${(r.audioMs / 1000).toFixed(1)} s of speech in ${(r.wallMs / 1000).toFixed(1)} s`);
    if (r.errors) console.log(`   errors: ${[...new Set(r.errors)].join('; ')}`);
  }
}
if (process.argv.includes('--json')) console.log(JSON.stringify({ mode: MODE, voice: settings.voice, results }));
process.exit(0);
