// Client for the Edge Read Aloud WebSocket protocol, shared by both extensions. Each extension
// passes in its own transport: the browser's WebSocket, or VS Code's hand-written client on https.
//
//  - One connection is reused for sentence after sentence (like Edge itself), with requests sent
//    one at a time. Opening a connection per sentence, several at once, made the service stall.
//  - When reading stops, the connection stays open for a while (LINGER_MS), and warm() opens one
//    ahead of time, so the next read doesn't wait for a new TLS + WebSocket handshake.
//  - A request that's cancelled mid-stream (stop, seek, speed change) is left to finish in the
//    background instead of closing the connection, unless that takes longer than DRAIN_MS.
//  - A request that gets no reply is abandoned quickly and retried once on a fresh connection.

import { WSS_URL, SEC_MS_GEC_VERSION } from './constants.js';
import { generateSecMsGec } from './drm.js';
import {
  uuid, parseHeaders, speechConfigMessage, ssmlMessage, requestIdOf, IDLE_TIMEOUT_MS,
} from './ssml.js';

export const LINGER_MS = 30000; // keep an idle connection this long (well under typical NAT/proxy timeouts)
// A connection that sat idle may have died silently: wait less for its first reply before retrying.
export const REUSED_REPLY_TIMEOUT_MS = 2500;
const QUIET_MS = 3000; // "sat idle" = nothing received for this long
// A cancelled request normally finishes arriving well within this; a new handshake costs more.
export const DRAIN_MS = 1500;
// ...but a new request waits at most this long for it (about the cost of a new handshake).
export const DRAIN_WAIT_MS = 300;

export const abortError = () => Object.assign(new Error('Aborted'), { name: 'AbortError' });

export function edgeUrl() {
  return `${WSS_URL}&ConnectionId=${uuid()}&Sec-MS-GEC=${generateSecMsGec()}&Sec-MS-GEC-Version=${SEC_MS_GEC_VERSION}`;
}

const utf8 = new TextDecoder();

// A protocol message -> { headers, body }. data: string (text frame) or Uint8Array (binary frame:
// 2-byte big-endian header length, headers, then the audio bytes).
export function parseMessage(data) {
  if (typeof data === 'string') {
    const sep = data.indexOf('\r\n\r\n');
    return { headers: parseHeaders(data.slice(0, sep)), body: data.slice(sep + 4) };
  }
  if (data.length < 2) return null;
  const headerLen = (data[0] << 8) | data[1];
  return { headers: parseHeaders(utf8.decode(data.subarray(2, 2 + headerLen))), body: data.subarray(2 + headerLen) };
}

export class EdgeClient {
  // open(url, { onMessage(string | Uint8Array), onClose() }) -> Promise<{ send(text), close() }>
  //   Opens the WebSocket (with the Edge headers and a connect timeout); rejects if it can't.
  // onHandshakeFailure(err): awaited before retrying a failed handshake (e.g. to fix clock skew).
  constructor({ open, onHandshakeFailure = async () => {} }) {
    this.open = open;
    this.onHandshakeFailure = onHandshakeFailure;
    this.timeouts = {
      idle: IDLE_TIMEOUT_MS, reused: REUSED_REPLY_TIMEOUT_MS, linger: LINGER_MS, drain: DRAIN_MS, drainWait: DRAIN_WAIT_MS,
    };
    this.conn = null; // { ready, sock, turns, lastHeard, closed }
    this.turn = null; // the request in flight (possibly a cancelled one, draining)
    this.turnDone = Promise.resolve();
    this.chain = Promise.resolve();
    this.lingerTimer = null;
  }

  connect() {
    if (this.conn) return this.conn.ready;
    const conn = { sock: null, turns: 0, lastHeard: Date.now(), closed: false };
    conn.ready = this.open(edgeUrl(), {
      onMessage: (data) => this.onMessage(conn, data),
      onClose: () => this.drop(conn, new Error('Edge service closed the connection')),
    }).then((sock) => {
      conn.sock = sock;
      if (conn.closed) { sock.close(); throw abortError(); } // dropped while still connecting
      conn.lastHeard = Date.now();
      sock.send(speechConfigMessage());
      return conn;
    }, (err) => {
      if (this.conn === conn) this.conn = null;
      throw err;
    });
    conn.ready.catch(() => {});
    this.conn = conn;
    return conn.ready;
  }

  // Open a connection now, so the first sentence doesn't wait for the handshake.
  warm() {
    if (this.turn) return;
    this.connect().then((conn) => { if (!this.turn) this.linger(conn); }, () => {});
  }

  // Close an idle connection after a while.
  linger(conn) {
    clearTimeout(this.lingerTimer);
    this.lingerTimer = setTimeout(() => {
      if (this.conn === conn && !this.turn) this.drop(conn, abortError());
    }, this.timeouts.linger);
    this.lingerTimer.unref?.(); // Node: don't keep the process alive just for this
  }

  // Connection unusable: forget it and fail the request in flight on it.
  drop(conn, err) {
    if (this.conn === conn) this.conn = null;
    conn.closed = true;
    try { conn.sock?.close(); } catch { /* ignore */ }
    const t = this.turn;
    if (t && t.conn === conn) t.finish(err);
  }

  close() {
    clearTimeout(this.lingerTimer);
    if (this.conn) this.drop(this.conn, abortError());
  }

  onMessage(conn, data) {
    conn.lastHeard = Date.now();
    const t = this.turn;
    if (!t || t.conn !== conn) return;
    const msg = parseMessage(data);
    if (!msg) return;
    const { headers, body } = msg;
    const rid = requestIdOf(headers);
    if (rid && rid.toLowerCase() !== t.requestId) return; // left over from an earlier request
    t.arm();
    switch (headers.Path) {
      case 'audio':
        if (headers['Content-Type'] === 'audio/mpeg' && body.length) {
          t.chunks.push(body);
          t.hooks.onAudio?.(body); // lets the player start before the whole sentence arrives
        }
        break;
      case 'audio.metadata':
        try {
          for (const m of JSON.parse(body).Metadata || []) {
            if (m.Type !== 'WordBoundary') continue;
            const w = { offset: m.Data.Offset, duration: m.Data.Duration, text: m.Data.text.Text };
            t.words.push(w);
            t.hooks.onWord?.(w);
          }
        } catch { /* ignore malformed metadata */ }
        break;
      case 'turn.end':
        t.finish();
        break;
      default:
    }
  }

  runTurn(conn, text, settings, signal, hooks) {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) { reject(abortError()); return; }
      clearTimeout(this.lingerTimer);
      const quiet = conn.turns > 0 && Date.now() - conn.lastHeard > QUIET_MS;
      conn.turns++;
      let timer;
      let drainTimer;
      let settled = false;
      let ended;
      const settle = (err, value) => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener('abort', onAbort);
        if (err) reject(err); else resolve(value);
      };
      // Cancelled: the caller gets an AbortError now. Let the rest of the audio arrive and be
      // ignored, so the connection can be reused; close it only if that takes too long.
      const onAbort = () => {
        turn.hooks = {};
        settle(abortError());
        drainTimer = setTimeout(() => this.drop(conn, abortError()), this.timeouts.drain);
      };
      const turn = {
        conn, requestId: uuid(), hooks, chunks: [], words: [],
        arm: (ms = this.timeouts.idle) => {
          clearTimeout(timer);
          timer = setTimeout(() => this.drop(conn, new Error('The Edge service stopped responding')), ms);
        },
        finish: (err) => {
          clearTimeout(timer);
          clearTimeout(drainTimer);
          if (this.turn === turn) this.turn = null;
          ended();
          if (this.conn === conn) this.linger(conn);
          if (err) settle(Object.assign(err, { gotAudio: turn.chunks.length > 0 }));
          else if (!turn.chunks.length) settle(new Error('No audio received from the Edge service'));
          else settle(null, { chunks: turn.chunks, words: turn.words });
        },
      };
      this.turnDone = new Promise((r) => { ended = r; });
      signal?.addEventListener('abort', onAbort);
      this.turn = turn;
      turn.arm(quiet ? Math.min(this.timeouts.reused, this.timeouts.idle) : this.timeouts.idle);
      conn.sock.send(ssmlMessage(text, settings, turn.requestId));
    });
  }

  // A cancelled request may still be finishing on the connection: wait briefly, else close it.
  async waitForDrain() {
    const t = this.turn;
    if (!t) return;
    let timer;
    const finished = await Promise.race([
      this.turnDone.then(() => true),
      new Promise((r) => { timer = setTimeout(() => r(false), this.timeouts.drainWait); }),
    ]);
    clearTimeout(timer);
    if (!finished && this.turn === t) this.drop(t.conn, abortError());
  }

  async attempt(text, settings, signal, hooks) {
    for (let i = 0; ; i++) {
      await this.waitForDrain();
      if (signal?.aborted) throw abortError();
      let conn;
      try {
        conn = await this.connect();
      } catch (err) {
        if (i >= 1) throw err;
        await this.onHandshakeFailure(err); // a rejected handshake is usually clock skew in the token
        continue;
      }
      try {
        return await this.runTurn(conn, text, settings, signal, hooks);
      } catch (err) {
        // Stalled or dropped: retry once on a fresh connection (unless the audio already started playing).
        if (err.name === 'AbortError' || i >= 1 || (err.gotAudio && hooks.onAudio)) throw err;
      }
    }
  }

  // -> Promise<{ chunks: (Uint8Array)[], words: [{ offset, duration, text }] }>
  // hooks: { onAudio(Uint8Array), onWord(word) } fire while the audio streams in.
  synth(text, settings, signal, hooks = {}) {
    const run = this.chain.then(() => this.attempt(text, settings, signal, hooks));
    this.chain = run.catch(() => {});
    return run;
  }
}
