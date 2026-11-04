// Speech synthesis backends:
//  - edge:  Edge's online Read Aloud WebSocket endpoint (free, undocumented)
//  - azure: Azure Speech REST API with your own key (official; free tier available)

import { WSS_URL, VOICE_LIST_URL, SEC_MS_GEC_VERSION, OUTPUT_FORMAT } from './constants.js';
import { generateSecMsGec, adjustClockSkew } from './drm.js';
import {
  uuid, buildSsml, localeOf, parseHeaders, speechConfigMessage, ssmlMessage,
  requestIdOf, CONNECT_TIMEOUT_MS, IDLE_TIMEOUT_MS,
} from './ssml.js';

async function syncClockWithServer() {
  try {
    const res = await fetch(`${VOICE_LIST_URL}&Sec-MS-GEC=${generateSecMsGec()}&Sec-MS-GEC-Version=${SEC_MS_GEC_VERSION}`,
      { cache: 'no-store' });
    const date = res.headers.get('Date');
    if (date) adjustClockSkew(date);
  } catch { /* ignore */ }
}

// One WebSocket, reused for sentence after sentence (like Edge itself), with requests sent one at a
// time. Opening a new connection per sentence, several at once, makes the service stall.
const timeouts = { connect: CONNECT_TIMEOUT_MS, idle: IDLE_TIMEOUT_MS };
export function _setTimeoutsForTests(t) { Object.assign(timeouts, t); }

const abortError = () => new DOMException('Aborted', 'AbortError');

class EdgeConnection {
  constructor() {
    this.ws = null;
    this.ready = null;
    this.turn = null;
    this.chain = Promise.resolve();
  }

  connect() {
    if (this.ws && this.ws.readyState !== WebSocket.OPEN) { this.ws = null; this.ready = null; }
    if (this.ready) return this.ready;
    this.ready = new Promise((resolve, reject) => {
      const url = `${WSS_URL}&ConnectionId=${uuid()}&Sec-MS-GEC=${generateSecMsGec()}&Sec-MS-GEC-Version=${SEC_MS_GEC_VERSION}`;
      const ws = new WebSocket(url);
      ws.binaryType = 'arraybuffer';
      let opened = false;
      const fail = (message) => {
        clearTimeout(timer);
        const err = Object.assign(new Error(message), { handshake: true });
        this.drop(ws, err);
        reject(err);
      };
      const timer = setTimeout(() => fail('Timed out connecting to the Edge Read Aloud service'), timeouts.connect);
      ws.onopen = () => {
        opened = true;
        clearTimeout(timer);
        ws.send(speechConfigMessage());
        this.ws = ws;
        resolve(ws);
      };
      ws.onmessage = (ev) => this.onMessage(ws, ev);
      ws.onerror = () => { if (!opened) fail('Could not connect to the Edge Read Aloud service'); };
      ws.onclose = () => {
        if (!opened) fail('Could not connect to the Edge Read Aloud service');
        else this.drop(ws, new Error('Edge service closed the connection'));
      };
    });
    this.ready.catch(() => {});
    return this.ready;
  }

  // Connection unusable: forget it and fail any request in flight on it.
  drop(ws, err) {
    if (!this.ws || this.ws === ws) { this.ws = null; this.ready = null; }
    try { ws.close(); } catch { /* ignore */ }
    const t = this.turn;
    if (t && t.ws === ws) t.finish(err);
  }

  close() {
    if (this.ws) this.drop(this.ws, abortError());
  }

  onMessage(ws, ev) {
    const t = this.turn;
    if (!t || t.ws !== ws) return;
    let headers;
    let body = null;
    if (typeof ev.data === 'string') {
      const sep = ev.data.indexOf('\r\n\r\n');
      headers = parseHeaders(ev.data.slice(0, sep));
      body = ev.data.slice(sep + 4);
    } else {
      if (ev.data.byteLength < 2) return;
      const headerLen = new DataView(ev.data).getUint16(0, false);
      headers = parseHeaders(new TextDecoder().decode(new Uint8Array(ev.data, 2, headerLen)));
      body = ev.data.slice(2 + headerLen);
    }
    const rid = requestIdOf(headers);
    if (rid && rid.toLowerCase() !== t.requestId) return; // left over from an earlier request
    t.arm();
    if (headers.Path === 'audio') {
      if (headers['Content-Type'] === 'audio/mpeg' && body.byteLength) {
        t.chunks.push(body);
        t.hooks.onAudio?.(body); // lets the player start before the whole sentence arrives
      }
    } else if (headers.Path === 'audio.metadata') {
      try {
        for (const m of JSON.parse(body).Metadata || []) {
          if (m.Type !== 'WordBoundary') continue;
          const w = { offset: m.Data.Offset, duration: m.Data.Duration, text: m.Data.text.Text };
          t.words.push(w);
          t.hooks.onWord?.(w);
        }
      } catch { /* ignore malformed metadata */ }
    } else if (headers.Path === 'turn.end') {
      t.finish();
    }
  }

  runTurn(ws, text, settings, signal, hooks) {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) { reject(abortError()); return; }
      const requestId = uuid();
      let idle;
      const onAbort = () => this.drop(ws, abortError()); // the next request reconnects
      const turn = {
        ws, requestId, hooks, chunks: [], words: [],
        arm: () => {
          clearTimeout(idle);
          idle = setTimeout(() => this.drop(ws, new Error('The Edge service stopped responding')), timeouts.idle);
        },
        finish: (err) => {
          clearTimeout(idle);
          signal?.removeEventListener('abort', onAbort);
          if (this.turn === turn) this.turn = null;
          if (err) reject(Object.assign(err, { gotAudio: turn.chunks.length > 0 }));
          else if (!turn.chunks.length) reject(new Error('No audio received from the Edge service'));
          else resolve({ audio: new Blob(turn.chunks, { type: 'audio/mpeg' }), words: turn.words });
        },
      };
      signal?.addEventListener('abort', onAbort);
      this.turn = turn;
      turn.arm();
      ws.send(ssmlMessage(text, settings, requestId));
    });
  }

  async attempt(text, settings, signal, hooks) {
    for (let i = 0; ; i++) {
      if (signal?.aborted) throw abortError();
      let ws;
      try {
        ws = await this.connect();
      } catch (err) {
        if (i >= 1) throw err;
        await syncClockWithServer(); // a rejected handshake is usually clock skew in the token
        continue;
      }
      try {
        return await this.runTurn(ws, text, settings, signal, hooks);
      } catch (err) {
        // Stalled or dropped connection: retry once on a fresh one (unless audio already played).
        if (err.name === 'AbortError' || err.gotAudio || i >= 1) throw err;
      }
    }
  }

  synth(text, settings, signal, hooks = {}) {
    const run = this.chain.then(() => this.attempt(text, settings, signal, hooks));
    this.chain = run.catch(() => {});
    return run;
  }
}

const edge = new EdgeConnection();
export function closeConnection() { edge.close(); }

async function azureSynth(text, settings, signal, hooks = {}) {
  if (!settings.azureKey) throw new Error('Azure backend selected but no Azure key set (open the extension popup)');
  const region = settings.azureRegion || 'eastus';
  const res = await fetch(`https://${region}.tts.speech.microsoft.com/cognitiveservices/v1`, {
    method: 'POST',
    signal,
    headers: {
      'Ocp-Apim-Subscription-Key': settings.azureKey,
      'Content-Type': 'application/ssml+xml',
      'X-Microsoft-OutputFormat': OUTPUT_FORMAT,
    },
    body: buildSsml(text, settings.voice, localeOf(settings.voice), settings),
  });
  if (!res.ok) throw new Error(`Azure TTS error ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const chunks = [];
  const reader = res.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    hooks.onAudio?.(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength));
  }
  return { audio: new Blob(chunks, { type: 'audio/mpeg' }), words: [] }; // REST API gives no word timings
}

// hooks: { onAudio(ArrayBuffer), onWord({offset, duration, text}) } fire while audio streams in.
export function synthesize(text, settings, signal, hooks) {
  return settings.backend === 'azure'
    ? azureSynth(text, settings, signal, hooks)
    : edge.synth(text, settings, signal, hooks);
}

// Returns [{ shortName, label, locale, gender }]
export async function listVoices(settings) {
  if (settings.backend === 'azure') {
    if (!settings.azureKey) return [];
    const res = await fetch(
      `https://${settings.azureRegion || 'eastus'}.tts.speech.microsoft.com/cognitiveservices/voices/list`,
      { headers: { 'Ocp-Apim-Subscription-Key': settings.azureKey } },
    );
    if (!res.ok) throw new Error(`Azure voice list error ${res.status}`);
    return (await res.json()).map((v) => ({
      shortName: v.ShortName, label: `${v.DisplayName} (${v.LocaleName})`, locale: v.Locale, gender: v.Gender,
    }));
  }
  const fetchList = () => fetch(
    `${VOICE_LIST_URL}&Sec-MS-GEC=${generateSecMsGec()}&Sec-MS-GEC-Version=${SEC_MS_GEC_VERSION}`,
    { cache: 'no-store' },
  );
  let res = await fetchList();
  if (res.status === 403 && res.headers.get('Date')) {
    adjustClockSkew(res.headers.get('Date'));
    res = await fetchList();
  }
  if (!res.ok) throw new Error(`Edge voice list error ${res.status}`);
  return (await res.json()).map((v) => {
    // "en-US-AvaMultilingualNeural" -> "Ava Multilingual (en-US)"
    const name = v.ShortName.slice(v.Locale.length + 1).replace(/Neural$/, '').replace(/([a-z])([A-Z])/g, '$1 $2');
    return { shortName: v.ShortName, label: `${name} (${v.Locale})`, locale: v.Locale, gender: v.Gender };
  });
}
