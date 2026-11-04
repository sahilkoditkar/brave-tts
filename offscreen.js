// Offscreen document: synthesizes sentences and plays them back.
// Content script (in the page) is the controller: it sends the list of sentences
// and commands; we report back which sentence/word is being spoken.

import { synthesize } from './lib/tts.js';

const PREFETCH_AHEAD = 3;
const audio = new Audio();

let tabId = null;
let texts = [];
let idx = 0;
let settings = {};
let gen = 0; // bumps whenever playback position changes, cancels stale async work
let cache = new Map(); // idx -> { promise, controller, url, words }
let wordTimer = null;
let lastWord = -1;
let consecutiveErrors = 0;
let wantPlaying = false; // true while playing or buffering (not paused/stopped)

function emit(event, data = {}) {
  if (tabId == null) return;
  chrome.runtime.sendMessage({ to: 'tab', tabId, event, ...data }).catch(() => {});
}

// Map word-boundary metadata (text + audio offset) to character offsets in the sentence.
function mapWords(text, words) {
  const out = [];
  const lower = text.toLowerCase();
  let cursor = 0;
  for (const w of words) {
    if (!w.text) continue;
    let at = text.indexOf(w.text, cursor);
    if (at === -1) at = lower.indexOf(w.text.toLowerCase(), cursor);
    if (at === -1) continue;
    out.push({ offset: w.offset, start: at, length: w.text.length });
    cursor = at + w.text.length;
  }
  return out;
}

function get(j) {
  let entry = cache.get(j);
  if (!entry) {
    const controller = new AbortController();
    entry = { controller };
    entry.promise = synthesize(texts[j], settings, controller.signal).then((r) => {
      entry.url = URL.createObjectURL(r.audio);
      entry.words = mapWords(texts[j], r.words);
      return entry;
    });
    entry.promise.catch(() => {});
    cache.set(j, entry);
  }
  return entry.promise;
}

function dropCache(predicate) {
  for (const [j, e] of cache) {
    if (predicate(j)) {
      e.controller.abort();
      if (e.url) URL.revokeObjectURL(e.url);
      cache.delete(j);
    }
  }
}

function stopWordTimer() {
  clearInterval(wordTimer);
  wordTimer = null;
}

function startWordTimer(entry, myGen) {
  stopWordTimer();
  lastWord = -1;
  if (!entry.words.length || settings.highlightWords === false) return;
  wordTimer = setInterval(() => {
    if (myGen !== gen) return stopWordTimer();
    const t = audio.currentTime * 1e7;
    let w = -1;
    for (let k = 0; k < entry.words.length && entry.words[k].offset <= t; k++) w = k;
    if (w !== lastWord && w >= 0) {
      lastWord = w;
      emit('word', { idx, start: entry.words[w].start, length: entry.words[w].length });
    }
  }, 40);
}

async function playFrom(i) {
  const myGen = ++gen;
  wantPlaying = true;
  stopWordTimer();
  audio.pause();
  if (i < 0) i = 0;
  if (i >= texts.length) {
    wantPlaying = false;
    emit('end');
    return;
  }
  idx = i;
  dropCache((j) => j < i - 1 || j > i + PREFETCH_AHEAD);
  emit('sentence', { idx });
  const cached = cache.get(i)?.url;
  if (!cached) emit('state', { state: 'buffering' });

  for (let j = i; j <= Math.min(i + PREFETCH_AHEAD, texts.length - 1); j++) get(j);

  let entry;
  try {
    entry = await get(i);
  } catch (err) {
    if (myGen !== gen || err.name === 'AbortError') return;
    cache.delete(i);
    consecutiveErrors++;
    if (consecutiveErrors >= 2 || i === texts.length - 1) {
      wantPlaying = false;
      emit('error', { message: err.message || String(err) });
      consecutiveErrors = 0;
      return;
    }
    playFrom(i + 1); // skip a single bad sentence
    return;
  }
  if (myGen !== gen) return;
  consecutiveErrors = 0;
  audio.src = entry.url;
  try {
    await audio.play();
  } catch (err) {
    if (myGen === gen) emit('error', { message: `Playback failed: ${err.message}` });
    return;
  }
  if (myGen !== gen) return;
  emit('state', { state: 'playing' });
  startWordTimer(entry, myGen);
  audio.onended = () => {
    if (myGen === gen) playFrom(idx + 1);
  };
}

function stop(notify = true) {
  gen++;
  wantPlaying = false;
  stopWordTimer();
  audio.pause();
  audio.removeAttribute('src');
  dropCache(() => true);
  if (notify) emit('stopped');
  texts = [];
  tabId = null;
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.to !== 'offscreen') return;
  switch (msg.type) {
    case 'load':
      if (tabId != null && tabId !== msg.tabId) stop(true);
      else stop(false);
      tabId = msg.tabId;
      texts = msg.texts;
      settings = msg.settings;
      playFrom(msg.start || 0);
      sendResponse({ ok: true });
      break;
    case 'pause':
      gen++; // invalidate any pending start
      wantPlaying = false;
      stopWordTimer();
      audio.pause();
      emit('state', { state: 'paused' });
      sendResponse({ ok: true });
      break;
    case 'resume':
      if (!texts.length || tabId !== msg.tabId) { sendResponse({ ok: false }); break; }
      if (audio.src && audio.paused && !audio.ended && cache.get(idx)?.url === audio.src) {
        const myGen = ++gen;
        wantPlaying = true;
        audio.play().then(() => {
          emit('state', { state: 'playing' });
          startWordTimer(cache.get(idx), myGen);
          audio.onended = () => { if (myGen === gen) playFrom(idx + 1); };
        });
      } else {
        playFrom(idx);
      }
      sendResponse({ ok: true });
      break;
    case 'seek':
      if (!texts.length || tabId !== msg.tabId) { sendResponse({ ok: false }); break; }
      playFrom(msg.idx);
      sendResponse({ ok: true });
      break;
    case 'settings':
      settings = msg.settings;
      if (texts.length) {
        dropCache(() => true);
        if (wantPlaying) playFrom(idx); // paused: new settings apply on resume
      }
      sendResponse({ ok: true });
      break;
    case 'stop':
      // notify the page so its player bar closes (e.g. Stop pressed in the popup)
      if (msg.tabId == null || msg.tabId === tabId) stop(true);
      sendResponse({ ok: true });
      break;
    case 'ping':
      sendResponse({ ok: true, tabId, idx, loaded: texts.length > 0 });
      break;
    default:
      return;
  }
  return true;
});
