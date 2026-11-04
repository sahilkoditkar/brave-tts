// Offscreen document: synthesizes sentences and plays them back.
// Content script (in the page) is the controller: it sends the list of sentences
// and commands; we report back which sentence/word is being spoken.

import { synthesize } from './lib/tts.js';

const PREFETCH_AHEAD = 3;
const audio = new Audio();
// Stream audio into the player while it's still being synthesized (much faster start).
const CAN_STREAM = typeof MediaSource !== 'undefined' && MediaSource.isTypeSupported('audio/mpeg');

let tabId = null;
let texts = [];
let idx = 0;
let settings = {};
let gen = 0; // bumps whenever playback position changes, cancels stale async work
let cache = new Map(); // idx -> { promise, controller, chunks, words, listeners, done, url }
let playingUrl = null;
let streamCleanup = null;
let wordTimer = null;
let lastWord = -1;
let consecutiveErrors = 0;
let wantPlaying = false; // true while playing or buffering (not paused/stopped)

function emit(event, data = {}) {
  if (tabId == null) return;
  chrome.runtime.sendMessage({ to: 'tab', tabId, event, ...data }).catch(() => {});
}

function get(j) {
  let entry = cache.get(j);
  if (!entry) {
    const controller = new AbortController();
    const text = texts[j];
    const lower = text.toLowerCase();
    let cursor = 0;
    entry = { controller, chunks: [], words: [], listeners: new Set(), done: false };
    const hooks = {
      onAudio(chunk) {
        entry.chunks.push(chunk);
        for (const fn of entry.listeners) fn(chunk);
      },
      onWord(w) { // map each word to its character offset in the sentence as it arrives
        if (!w.text) return;
        let at = text.indexOf(w.text, cursor);
        if (at === -1) at = lower.indexOf(w.text.toLowerCase(), cursor);
        if (at === -1) return;
        entry.words.push({ offset: w.offset, start: at, length: w.text.length });
        cursor = at + w.text.length;
      },
    };
    entry.promise = synthesize(text, settings, controller.signal, hooks).then((r) => {
      entry.url = URL.createObjectURL(r.audio);
      entry.done = true;
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

function endStream() {
  streamCleanup?.();
  streamCleanup = null;
}

// Feed an in-progress entry into a MediaSource so playback starts with the first chunk.
function streamInto(entry) {
  return new Promise((resolve) => {
    const ms = new MediaSource();
    const url = URL.createObjectURL(ms);
    const queue = [...entry.chunks];
    let ended = false;
    let sb = null;
    const pump = () => {
      // keeps feeding while paused; streamCleanup() detaches it when playback moves on
      if (!sb || sb.updating || ms.readyState !== 'open') return;
      if (queue.length) sb.appendBuffer(queue.shift());
      else if (ended) ms.endOfStream();
    };
    const onChunk = (c) => { queue.push(c); pump(); };
    entry.listeners.add(onChunk);
    streamCleanup = () => {
      entry.listeners.delete(onChunk);
      URL.revokeObjectURL(url);
    };
    ms.addEventListener('sourceopen', () => {
      sb = ms.addSourceBuffer('audio/mpeg');
      sb.addEventListener('updateend', pump);
      pump();
      resolve(url);
    }, { once: true });
    const finishStream = () => { ended = true; pump(); };
    entry.promise.then(finishStream, finishStream);
    audio.src = url;
  });
}

function stopWordTimer() {
  clearInterval(wordTimer);
  wordTimer = null;
}

function startWordTimer(entry, myGen) {
  stopWordTimer();
  lastWord = -1;
  if (settings.highlightWords === false) return; // words may still be streaming in
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

// Resolves when the entry has its first audio chunk (or is complete); rejects on failure.
function firstAudio(entry) {
  return new Promise((resolve, reject) => {
    if (entry.done || entry.chunks.length) { resolve(); return; }
    const first = () => { entry.listeners.delete(first); resolve(); };
    entry.listeners.add(first);
    entry.promise.then(() => { entry.listeners.delete(first); resolve(); }, (err) => { entry.listeners.delete(first); reject(err); });
  });
}

async function playFrom(i) {
  const myGen = ++gen;
  wantPlaying = true;
  stopWordTimer();
  audio.pause();
  endStream();
  if (i < 0) i = 0;
  if (i >= texts.length) {
    wantPlaying = false;
    emit('end');
    return;
  }
  idx = i;
  dropCache((j) => j < i - 1 || j > i + PREFETCH_AHEAD);
  emit('sentence', { idx });
  for (let j = i; j <= Math.min(i + PREFETCH_AHEAD, texts.length - 1); j++) get(j);
  const entry = cache.get(i);
  if (!entry.done) emit('state', { state: 'buffering' });

  let url;
  try {
    if (CAN_STREAM) {
      await firstAudio(entry);
      if (myGen !== gen) return;
    }
    if (!entry.done && CAN_STREAM) {
      url = await streamInto(entry); // play while the rest of the sentence streams in
    } else {
      await entry.promise;
      url = entry.url;
    }
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
  if (audio.src !== url) audio.src = url;
  playingUrl = url;
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
  endStream();
  playingUrl = null;
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
      if (audio.src && audio.paused && !audio.ended && audio.src === playingUrl) {
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
