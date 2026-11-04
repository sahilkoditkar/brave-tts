// Pure helpers shared by the browser extension and the VS Code extension:
// building SSML and the text frames of the Edge Read Aloud WebSocket protocol.

import { OUTPUT_FORMAT } from './constants.js';

export const uuid = () => crypto.randomUUID().replaceAll('-', '');

export function escapeXml(s) {
  return s
    // characters the service rejects (e.g. vertical tab from OCR'd PDFs)
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, ' ')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

export function localeOf(voice) {
  const m = /^([a-z]{2,})-([A-Z]{2,})/.exec(voice);
  return m ? `${m[1]}-${m[2]}` : 'en-US';
}

// "en-US-AriaNeural" -> "Microsoft Server Speech Text to Speech Voice (en-US, AriaNeural)"
export function edgeLongVoiceName(voice) {
  const m = /^([a-z]{2,})-([A-Z]{2,})-(.+Neural)$/.exec(voice);
  if (!m) return voice;
  let [, lang, region, name] = m;
  const dash = name.indexOf('-');
  if (dash !== -1) {
    region = `${region}-${name.slice(0, dash)}`;
    name = name.slice(dash + 1);
  }
  return `Microsoft Server Speech Text to Speech Voice (${lang}-${region}, ${name})`;
}

export function prosody({ rate = 1, pitch = 0 }) {
  const r = Math.round((rate - 1) * 100);
  const p = Math.round(pitch);
  return { rate: `${r >= 0 ? '+' : ''}${r}%`, pitch: `${p >= 0 ? '+' : ''}${p}Hz` };
}

export function buildSsml(text, voiceName, locale, settings) {
  const { rate, pitch } = prosody(settings);
  return (
    `<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='${locale}'>` +
    `<voice name='${voiceName}'><prosody pitch='${pitch}' rate='${rate}' volume='+0%'>` +
    `${escapeXml(text)}</prosody></voice></speak>`
  );
}

// JS-style date string the Edge client sends.
export function dateString() {
  return new Date().toUTCString().replace(/^(\w+), (\d+) (\w+) (\d+) (.+) GMT$/,
    (_, wd, d, mo, y, t) => `${wd} ${mo} ${d} ${y} ${t} GMT+0000 (Coordinated Universal Time)`);
}

export function parseHeaders(text) {
  const headers = {};
  for (const line of text.split('\r\n')) {
    const i = line.indexOf(':');
    if (i > 0) headers[line.slice(0, i)] = line.slice(i + 1);
  }
  return headers;
}

export function speechConfigMessage() {
  return `X-Timestamp:${dateString()}\r\nContent-Type:application/json; charset=utf-8\r\nPath:speech.config\r\n\r\n` +
    '{"context":{"synthesis":{"audio":{"metadataoptions":{"sentenceBoundaryEnabled":"false","wordBoundaryEnabled":"true"},' +
    `"outputFormat":"${OUTPUT_FORMAT}"}}}}\r\n`;
}

export function ssmlMessage(text, settings, requestId = uuid()) {
  const ssml = buildSsml(text, edgeLongVoiceName(settings.voice), localeOf(settings.voice), settings);
  return `X-RequestId:${requestId}\r\nContent-Type:application/ssml+xml\r\nX-Timestamp:${dateString()}Z\r\nPath:ssml\r\n\r\n${ssml}`;
}

// Map word-boundary metadata (text + audio offset) to character offsets in the sentence.
export function mapWords(text, words) {
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

// Timeouts for the Edge connection: fail fast and retry instead of hanging.
export const CONNECT_TIMEOUT_MS = 6000; // WebSocket handshake
export const IDLE_TIMEOUT_MS = 5000; // no message from the service for this long mid-turn

// The request a protocol message belongs to (several sentences share one connection).
export function requestIdOf(headers) {
  return (headers['X-RequestId'] || '').trim();
}
