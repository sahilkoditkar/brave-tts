// Client for the Edge Read Aloud WebSocket protocol, shared by both extensions. Each extension
// passes in its own transport: the browser's WebSocket, or VS Code's hand-written client on https.
//
//  - One connection is reused for sentence after sentence (like Edge itself). Up to MAX_IN_FLIGHT
//    requests are sent on it at once, without waiting for the one before to finish: the service
//    works on them in parallel (tagged by X-RequestId), so the sentences after the current one are
//    ready in time even with voices that take longer to synthesize than to play. More at once (or
//    bursts of new connections) can make the service stop answering for a while.
//  - Two kinds of timeout. The service acknowledges a request (turn.start) within ~100 ms, so no
//    reply at all within IDLE_TIMEOUT_MS means a dead connection: it's replaced and the request
//    retried. Once acknowledged, the audio itself can take many seconds (some voices need 3-13 s
//    before the first audio, with pauses of up to ~10 s inside long sentences), so then the client
//    waits up to SYNTH_TIMEOUT_MS between messages.
//  - When reading stops, the connection stays open for a while (LINGER_MS), and warm() opens one
//    ahead of time, so the next read doesn't wait for a new TLS + WebSocket handshake.
//  - A request that's cancelled (stop, seek, speed change) is left to finish in the background,
//    ignored, instead of closing the connection. Only if cancelled requests fill the connection
//    and something new is waiting is it replaced (after DRAIN_WAIT_MS).

import { WSS_URL, SEC_MS_GEC_VERSION } from './constants.js';
import { generateSecMsGec } from './drm.js';
import {
  uuid, parseHeaders, speechConfigMessage, ssmlMessage, requestIdOf, IDLE_TIMEOUT_MS,
} from './ssml.js';

export const LINGER_MS = 30000; // keep an idle connection this long (well under typical NAT/proxy timeouts)
// A connection that sat idle may have died silently: wait less for its first reply before retrying.
export const REUSED_REPLY_TIMEOUT_MS = 2500;
const QUIET_MS = 3000; // "sat idle" = nothing received for this long
// After the service acknowledged a request: longest wait for the next message (first audio, or
// the next part of a long sentence).
export const SYNTH_TIMEOUT_MS = 20000;
export const MAX_IN_FLIGHT = 3; // the current sentence and the next two
// Connection full of cancelled requests and a new one waiting: replace it after this long.
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

const hasLive = (conn) => { for (const t of conn.turns.values()) if (t.live) return true; return false; };

export class EdgeClient {
  // open(url, { onMessage(string | Uint8Array), onClose() }) -> Promise<{ send(text), close() }>
  //   Opens the WebSocket (with the Edge headers and a connect timeout); rejects if it can't.
  // onHandshakeFailure(err): awaited before retrying a failed handshake (e.g. to fix clock skew).
  constructor({ open, onHandshakeFailure = async () => {} }) {
    this.open = open;
    this.onHandshakeFailure = onHandshakeFailure;
    this.timeouts = {
      idle: IDLE_TIMEOUT_MS, reused: REUSED_REPLY_TIMEOUT_MS, synth: SYNTH_TIMEOUT_MS, linger: LINGER_MS, drainWait: DRAIN_WAIT_MS,
    };
    this.maxInFlight = MAX_IN_FLIGHT;
    this.conn = null; // { ready, sock, turns: Map(requestId -> turn), lastHeard, closed, used, finished }
    this.queue = []; // requests waiting to be sent, in the order they were made
    this.lingerTimer = null;
    this.drainTimer = null;
    this.recovering = false; // a failed handshake is being fixed (onHandshakeFailure)
  }

  connect() {
    if (this.conn) return this.conn.ready;
    const conn = { sock: null, turns: new Map(), lastHeard: Date.now(), closed: false, used: false, finished: 0 };
    conn.ready = this.open(edgeUrl(), {
      onMessage: (data) => this.onMessage(conn, data),
      onClose: () => this.drop(conn, Object.assign(new Error('Edge service closed the connection'), { closed: true })),
    }).then((sock) => {
      conn.sock = sock;
      if (conn.closed) { sock.close(); throw abortError(); } // dropped while still connecting
      conn.lastHeard = Date.now();
      sock.send(speechConfigMessage());
      return conn;
    }, (err) => {
      conn.closed = true;
      if (this.conn === conn) this.conn = null;
      throw err;
    });
    this.conn = conn;
    conn.ready.then(() => this.pump(), (err) => (err.name === 'AbortError' ? this.pump() : this.connectFailed(err)));
    return conn.ready;
  }

  // Each waiting request gets one more try after a failed handshake (a rejected handshake is
  // usually clock skew in the token, which onHandshakeFailure fixes).
  async connectFailed(err) {
    const retry = [];
    for (const job of this.queue) {
      if (job.settled) continue;
      if (job.handshakeFails++ >= 1) job.fail(err); else retry.push(job);
    }
    this.queue = retry;
    if (!retry.length) return;
    this.recovering = true; // no new handshake until it's fixed (each would use up a retry)
    try { await this.onHandshakeFailure(err); } catch { /* retry anyway */ }
    this.recovering = false;
    this.pump();
  }

  // Open a connection now, so the first sentence doesn't wait for the handshake.
  warm() {
    if (!this.conn) this.connect().catch(() => {});
  }

  // Close an idle connection after a while.
  linger(conn) {
    clearTimeout(this.lingerTimer);
    this.lingerTimer = setTimeout(() => {
      if (this.conn === conn && !conn.turns.size && !this.queue.length) this.drop(conn, abortError());
    }, this.timeouts.linger);
    this.lingerTimer.unref?.(); // Node: don't keep the process alive just for this
  }

  // Connection unusable: forget it, and retry (or fail) the requests in flight on it.
  drop(conn, err) {
    if (conn.closed && !conn.turns.size) return; // already dropped (e.g. our own close() fires onClose)
    conn.closed = true;
    if (this.conn === conn) this.conn = null;
    const turns = [...conn.turns.values()];
    conn.turns.clear();
    try { conn.sock?.close(); } catch { /* ignore */ }
    // Stalled or dropped: retry once on a fresh connection (never once its audio started playing).
    // If the service closed it after finishing some other request since this one was sent, this
    // one wasn't at fault (it was just waiting its turn): that doesn't use up its retry. Each such
    // free retry needs a finished request, so this can't loop.
    const retry = [];
    for (const t of turns) {
      clearTimeout(t.timer);
      if (!t.live) continue;
      const { job } = t;
      job.turn = null;
      const bystander = err.closed && conn.finished > t.finishedBefore;
      if (err.name !== 'AbortError' && (bystander || job.attempts++ < 1) && !(t.chunks.length && job.hooks.onAudio)) retry.push(job);
      else job.fail(err);
    }
    this.queue.unshift(...retry);
    this.pump();
  }

  // Close the connection now. Requests in flight on it fail (AbortError); any still waiting to be
  // sent go out on a new connection.
  close() {
    clearTimeout(this.lingerTimer);
    if (this.conn) this.drop(this.conn, abortError());
  }

  // Send waiting requests while there is room on the connection (connecting first if needed).
  pump() {
    this.queue = this.queue.filter((job) => !job.settled);
    const conn = this.conn;
    if (!this.queue.length) {
      if (conn?.sock && !conn.turns.size) this.linger(conn);
      return;
    }
    clearTimeout(this.lingerTimer);
    if (!conn) { if (!this.recovering) this.connect().catch(() => {}); return; }
    if (!conn.sock) return; // still connecting: pumped again when it's ready
    while (this.queue.length && conn.turns.size < this.maxInFlight) this.send(conn, this.queue.shift());
    // Full of cancelled requests still arriving: wait briefly, then start over on a new connection.
    if (this.queue.length && !hasLive(conn) && !this.drainTimer) {
      this.drainTimer = setTimeout(() => {
        this.drainTimer = null;
        if (this.conn === conn && this.queue.length && !hasLive(conn) && conn.turns.size >= this.maxInFlight) this.drop(conn, abortError());
        else this.pump();
      }, this.timeouts.drainWait);
    }
  }

  send(conn, job) {
    const quiet = conn.used && !conn.turns.size && Date.now() - conn.lastHeard > QUIET_MS;
    conn.used = true;
    const turn = { conn, job, requestId: uuid(), live: true, chunks: [], words: [], timer: null, finishedBefore: conn.finished };
    turn.arm = (ms) => {
      clearTimeout(turn.timer);
      turn.timer = setTimeout(() => this.stalled(turn), ms);
    };
    job.turn = turn;
    conn.turns.set(turn.requestId, turn);
    turn.arm(quiet ? Math.min(this.timeouts.reused, this.timeouts.idle) : this.timeouts.idle);
    conn.sock.send(ssmlMessage(job.text, job.settings, turn.requestId));
  }

  stalled(turn) {
    const { conn } = turn;
    if (turn.live) { this.drop(conn, new Error('The Edge service stopped responding')); return; }
    // A cancelled request stopped arriving: forget it, and the connection too if nothing else uses it.
    conn.turns.delete(turn.requestId);
    if (!hasLive(conn)) this.drop(conn, abortError());
    else this.pump();
  }

  onMessage(conn, data) {
    conn.lastHeard = Date.now();
    const msg = parseMessage(data);
    if (!msg) return;
    const { headers, body } = msg;
    const rid = requestIdOf(headers).toLowerCase();
    let turn = conn.turns.get(rid);
    if (!turn && !rid && conn.turns.size === 1) [turn] = conn.turns.values(); // no id: only one it can be
    if (!turn) return; // left over from an earlier request
    turn.arm(this.timeouts.synth); // acknowledged: the audio may take a while
    switch (headers.Path) {
      case 'audio':
        if (turn.live && headers['Content-Type'] === 'audio/mpeg' && body.length) {
          turn.chunks.push(body);
          turn.job.hooks.onAudio?.(body); // lets the player start before the whole sentence arrives
        }
        break;
      case 'audio.metadata':
        if (!turn.live) break;
        try {
          for (const m of JSON.parse(body).Metadata || []) {
            if (m.Type !== 'WordBoundary') continue;
            const w = { offset: m.Data.Offset, duration: m.Data.Duration, text: m.Data.text.Text };
            turn.words.push(w);
            turn.job.hooks.onWord?.(w);
          }
        } catch { /* ignore malformed metadata */ }
        break;
      case 'turn.end':
        clearTimeout(turn.timer);
        conn.turns.delete(turn.requestId);
        conn.finished++;
        if (turn.live) {
          const { job } = turn;
          job.turn = null;
          if (turn.chunks.length) job.done({ chunks: turn.chunks, words: turn.words });
          else if (job.attempts++ < 1) this.queue.unshift(job);
          else job.fail(new Error('No audio received from the Edge service'));
        }
        this.pump();
        break;
      default:
    }
  }

  // -> Promise<{ chunks: (Uint8Array)[], words: [{ offset, duration, text }] }>
  // hooks: { onAudio(Uint8Array), onWord(word) } fire while the audio streams in.
  synth(text, settings, signal, hooks = {}) {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) { reject(abortError()); return; }
      const job = { text, settings, hooks, attempts: 0, handshakeFails: 0, settled: false, turn: null };
      const settle = () => {
        job.settled = true;
        signal?.removeEventListener('abort', onAbort);
      };
      job.done = (value) => { if (!job.settled) { settle(); resolve(value); } };
      job.fail = (err) => { if (!job.settled) { settle(); reject(err); } };
      // Cancelled: the caller gets an AbortError now. A request already sent is left to finish
      // arriving, ignored, so the connection can be reused.
      const onAbort = () => {
        if (job.turn) job.turn.live = false;
        job.fail(abortError());
        this.pump();
      };
      signal?.addEventListener('abort', onAbort);
      this.queue.push(job);
      this.pump();
    });
  }
}
