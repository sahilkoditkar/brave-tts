// Speech engine for VS Code, built only on Node's standard library (no npm packages).
// Shares the token, constants and SSML/protocol helpers with the browser extension.

import https from 'node:https';
import http from 'node:http';
import tls from 'node:tls';
import dns from 'node:dns';
import crypto from 'node:crypto';
import {
  WSS_URL, VOICE_LIST_URL, SEC_MS_GEC_VERSION, OUTPUT_FORMAT,
  EDGE_EXTENSION_ORIGIN, EDGE_USER_AGENT, EDGE_SEC_CH_UA,
} from '../shared/constants.js';
import { generateSecMsGec, generateMuid, adjustClockSkew } from '../shared/drm.js';
import {
  uuid, buildSsml, localeOf, parseHeaders, speechConfigMessage, ssmlMessage,
  requestIdOf, CONNECT_TIMEOUT_MS, IDLE_TIMEOUT_MS,
} from '../shared/ssml.js';

const MUID = generateMuid();
const EDGE_HEADERS = {
  'User-Agent': EDGE_USER_AGENT,
  'Accept-Language': 'en-US,en;q=0.9',
  Pragma: 'no-cache',
  'Cache-Control': 'no-cache',
  Cookie: `muid=${MUID};`,
};

// Test hook only: lets the test suite point the engine at a local fake server.
let transport = {};
export function _setTransportForTests(options) { transport = options; }
const timeouts = { connect: CONNECT_TIMEOUT_MS, idle: IDLE_TIMEOUT_MS };
export function _setTimeoutsForTests(t) { Object.assign(timeouts, t); }

// ---------------------------------------------------------------- proxy (explicit http.proxy / HTTPS_PROXY)
let proxyUrl = '';
export function setProxy(url) { proxyUrl = url || ''; }

function tunnel(host, port) {
  return new Promise((resolve, reject) => {
    const p = new URL(proxyUrl);
    const headers = { Host: `${host}:${port}` };
    if (p.username) {
      headers['Proxy-Authorization'] = `Basic ${Buffer.from(`${decodeURIComponent(p.username)}:${decodeURIComponent(p.password)}`).toString('base64')}`;
    }
    const req = (p.protocol === 'https:' ? https : http).request({
      host: p.hostname, port: p.port || (p.protocol === 'https:' ? 443 : 80), method: 'CONNECT', path: `${host}:${port}`, headers,
    });
    req.setTimeout(timeouts.connect, () => req.destroy(new Error(`Timed out connecting through the proxy ${p.host}`)));
    req.on('connect', (res, socket) => {
      req.setTimeout(0);
      if (res.statusCode !== 200) { socket.destroy(); reject(new Error(`Proxy ${p.host} refused the connection (HTTP ${res.statusCode})`)); return; }
      resolve(socket);
    });
    req.on('error', (err) => reject(new Error(`Proxy ${p.host}: ${err.message}`)));
    req.end();
  });
}

// Tunnels each connection through the proxy (HTTP CONNECT), then does TLS to the real host.
class TunnelAgent extends https.Agent {
  createConnection(options, callback) {
    const host = options.servername || options.host;
    tunnel(host, options.port || 443).then((socket) => {
      callback(null, tls.connect({
        socket, servername: host, ...(transport.rejectUnauthorized === false ? { rejectUnauthorized: false } : {}),
      }));
    }, callback);
  }
}

// Extra https.request options: tunnel through the proxy when one is configured.
function viaProxy(host) {
  if (!proxyUrl) return {};
  return { agent: new TunnelAgent({ keepAlive: false }), servername: host };
}

// ---------------------------------------------------------------- minimal WebSocket client
function wsConnect(url, headers) {
  return new Promise((resolve, reject) => {
    const u = new URL(url.replace(/^wss:/, 'https:'));
    const key = crypto.randomBytes(16).toString('base64');
    const req = https.request({
      hostname: u.hostname,
      port: u.port || 443,
      path: u.pathname + u.search,
      headers: {
        ...headers,
        Connection: 'Upgrade',
        Upgrade: 'websocket',
        'Sec-WebSocket-Key': key,
        'Sec-WebSocket-Version': '13',
      },
      ...transport,
      ...viaProxy(u.hostname),
    });
    const timer = setTimeout(() => req.destroy(Object.assign(new Error(
      `Timed out connecting to the Edge service${proxyUrl ? ' (through the proxy)' : ''}. Run "Read Aloud: Test Connection" for details.`,
    ), { handshake: true })), timeouts.connect);
    req.on('close', () => clearTimeout(timer));
    req.on('response', (res) => {
      res.resume();
      reject(Object.assign(new Error(`Edge service refused the connection (HTTP ${res.statusCode})`),
        { status: res.statusCode, date: res.headers.date, handshake: true }));
    });
    req.on('error', (err) => reject(Object.assign(err, { handshake: true })));
    req.on('upgrade', (res, socket, head) => {
      clearTimeout(timer);
      socket.setTimeout(0); // the connection is kept open between sentences
      const expected = crypto.createHash('sha1').update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
      if (res.headers['sec-websocket-accept'] !== expected) {
        socket.destroy();
        reject(new Error('Bad WebSocket handshake'));
        return;
      }
      resolve(new WsConnection(socket, head));
    });
    req.end();
  });
}

class WsConnection {
  constructor(socket, head) {
    this.socket = socket;
    this.buf = head?.length ? Buffer.from(head) : Buffer.alloc(0);
    this.fragments = [];
    this.fragOpcode = 0;
    this.onmessage = () => {};
    this.onclose = () => {};
    this.closed = false;
    socket.setNoDelay(true);
    socket.on('data', (d) => { this.buf = Buffer.concat([this.buf, d]); this.parse(); });
    socket.on('close', () => { if (!this.closed) { this.closed = true; this.onclose(); } });
    socket.on('error', () => socket.destroy());
    if (this.buf.length) setImmediate(() => this.parse());
  }

  send(data, opcode = 1) {
    const payload = Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8');
    const len = payload.length;
    let header;
    if (len < 126) header = Buffer.from([0x80 | opcode, 0x80 | len]);
    else if (len < 65536) { header = Buffer.alloc(4); header[0] = 0x80 | opcode; header[1] = 0x80 | 126; header.writeUInt16BE(len, 2); }
    else { header = Buffer.alloc(10); header[0] = 0x80 | opcode; header[1] = 0x80 | 127; header.writeBigUInt64BE(BigInt(len), 2); }
    const mask = crypto.randomBytes(4);
    const masked = Buffer.alloc(len);
    for (let i = 0; i < len; i++) masked[i] = payload[i] ^ mask[i & 3];
    this.socket.write(Buffer.concat([header, mask, masked]));
  }

  parse() {
    for (;;) {
      const b = this.buf;
      if (b.length < 2) return;
      const fin = b[0] & 0x80;
      const opcode = b[0] & 0x0f;
      let len = b[1] & 0x7f;
      let off = 2;
      if (len === 126) { if (b.length < 4) return; len = b.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (b.length < 10) return; len = Number(b.readBigUInt64BE(2)); off = 10; }
      const masked = b[1] & 0x80;
      let mask = null;
      if (masked) { if (b.length < off + 4) return; mask = b.subarray(off, off + 4); off += 4; }
      if (b.length < off + len) return;
      let payload = Buffer.from(b.subarray(off, off + len));
      if (mask) for (let i = 0; i < len; i++) payload[i] ^= mask[i & 3];
      this.buf = b.subarray(off + len);

      if (opcode === 8) { this.close(); return; }
      if (opcode === 9) { this.send(payload, 10); continue; } // ping -> pong
      if (opcode === 10) continue;
      if (opcode === 0) { this.fragments.push(payload); if (!fin) continue; payload = Buffer.concat(this.fragments); this.fragments = []; }
      else if (!fin) { this.fragOpcode = opcode; this.fragments = [payload]; continue; }
      const op = opcode === 0 ? this.fragOpcode : opcode;
      this.onmessage(op === 2, payload);
    }
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    try { this.send(Buffer.alloc(0), 8); } catch { /* ignore */ }
    this.socket.end();
    this.onclose();
  }
}

// ---------------------------------------------------------------- Edge backend
// One connection reused for sentence after sentence (like Edge itself), requests one at a time.
// Opening a new connection per sentence, several at once, makes the service stall.
const abortError = () => Object.assign(new Error('Aborted'), { name: 'AbortError' });

class EdgeConnection {
  constructor() {
    this.ws = null;
    this.ready = null;
    this.turn = null;
    this.chain = Promise.resolve();
  }

  connect() {
    if (this.ws?.closed) { this.ws = null; this.ready = null; }
    if (this.ready) return this.ready;
    const url = `${WSS_URL}&ConnectionId=${uuid()}&Sec-MS-GEC=${generateSecMsGec()}&Sec-MS-GEC-Version=${SEC_MS_GEC_VERSION}`;
    this.ready = wsConnect(url, { ...EDGE_HEADERS, Origin: EDGE_EXTENSION_ORIGIN }).then((ws) => {
      ws.onmessage = (isBinary, data) => this.onMessage(ws, isBinary, data);
      ws.onclose = () => this.drop(ws, new Error('Edge service closed the connection'));
      ws.send(speechConfigMessage());
      this.ws = ws;
      return ws;
    }, (err) => {
      this.ready = null;
      throw err;
    });
    return this.ready;
  }

  drop(ws, err) {
    if (!this.ws || this.ws === ws) { this.ws = null; this.ready = null; }
    ws.close();
    const t = this.turn;
    if (t && t.ws === ws) t.finish(err);
  }

  close() {
    if (this.ws) this.drop(this.ws, abortError());
  }

  onMessage(ws, isBinary, data) {
    const t = this.turn;
    if (!t || t.ws !== ws) return;
    let headers;
    let body;
    if (!isBinary) {
      const str = data.toString('utf8');
      const sep = str.indexOf('\r\n\r\n');
      headers = parseHeaders(str.slice(0, sep));
      body = str.slice(sep + 4);
    } else {
      if (data.length < 2) return;
      const hl = data.readUInt16BE(0);
      headers = parseHeaders(data.subarray(2, 2 + hl).toString('utf8'));
      body = data.subarray(2 + hl);
    }
    const rid = requestIdOf(headers);
    if (rid && rid.toLowerCase() !== t.requestId) return; // left over from an earlier request
    t.arm();
    if (headers.Path === 'audio') {
      if (headers['Content-Type'] === 'audio/mpeg' && body.length) t.chunks.push(Buffer.from(body));
    } else if (headers.Path === 'audio.metadata') {
      try {
        for (const m of JSON.parse(body).Metadata || []) {
          if (m.Type === 'WordBoundary') t.words.push({ offset: m.Data.Offset, duration: m.Data.Duration, text: m.Data.text.Text });
        }
      } catch { /* ignore */ }
    } else if (headers.Path === 'turn.end') {
      t.finish();
    }
  }

  runTurn(ws, text, settings, signal) {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) { reject(abortError()); return; }
      const requestId = uuid();
      let idle;
      const onAbort = () => this.drop(ws, abortError()); // the next request reconnects
      const turn = {
        ws, requestId, chunks: [], words: [],
        arm: () => {
          clearTimeout(idle);
          idle = setTimeout(() => this.drop(ws, new Error('The Edge service stopped responding')), timeouts.idle);
        },
        finish: (err) => {
          clearTimeout(idle);
          signal?.removeEventListener('abort', onAbort);
          if (this.turn === turn) this.turn = null;
          if (err) reject(err);
          else if (!turn.chunks.length) reject(new Error('No audio received from the Edge service'));
          else resolve({ audio: Buffer.concat(turn.chunks), words: turn.words });
        },
      };
      signal?.addEventListener('abort', onAbort);
      this.turn = turn;
      turn.arm();
      ws.send(ssmlMessage(text, settings, requestId));
    });
  }

  async attempt(text, settings, signal) {
    for (let i = 0; ; i++) {
      if (signal?.aborted) throw abortError();
      let ws;
      try {
        ws = await this.connect();
      } catch (err) {
        if (i >= 1) throw err;
        if (err.status === 403 && err.date) adjustClockSkew(err.date); // token is time-based
        continue;
      }
      try {
        return await this.runTurn(ws, text, settings, signal);
      } catch (err) {
        if (err.name === 'AbortError' || i >= 1) throw err; // stalled/dropped: retry once, fresh connection
      }
    }
  }

  synth(text, settings, signal) {
    const run = this.chain.then(() => this.attempt(text, settings, signal));
    this.chain = run.catch(() => {});
    return run;
  }
}

const edge = new EdgeConnection();
export function closeConnection() { edge.close(); }

// ---------------------------------------------------------------- HTTPS helper
function request(url, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request({ hostname: u.hostname, port: u.port || 443, path: u.pathname + u.search, method, headers, ...transport, ...viaProxy(u.hostname) }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.setTimeout(20000, () => req.destroy(new Error('Request timed out')));
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

// ---------------------------------------------------------------- Azure backend
async function azureSynth(text, settings) {
  if (!settings.azureKey) throw new Error('Azure voice source selected but no key set. Run "Read Aloud: Set Azure Speech Key".');
  const res = await request(`https://${settings.azureRegion || 'eastus'}.tts.speech.microsoft.com/cognitiveservices/v1`, {
    method: 'POST',
    headers: {
      'Ocp-Apim-Subscription-Key': settings.azureKey,
      'Content-Type': 'application/ssml+xml',
      'X-Microsoft-OutputFormat': OUTPUT_FORMAT,
      'User-Agent': 'read-aloud-vscode',
    },
    body: buildSsml(text, settings.voice, localeOf(settings.voice), settings),
  });
  if (res.status !== 200) throw new Error(`Azure TTS error ${res.status}: ${res.body.toString('utf8').slice(0, 200)}`);
  return { audio: res.body, words: [] };
}

// ---------------------------------------------------------------- public API
export function synthesize(text, settings, signal) {
  return settings.backend === 'azure' ? azureSynth(text, settings) : edge.synth(text, settings, signal);
}

export async function listVoices(settings) {
  if (settings.backend === 'azure') {
    if (!settings.azureKey) return [];
    const res = await request(`https://${settings.azureRegion || 'eastus'}.tts.speech.microsoft.com/cognitiveservices/voices/list`,
      { headers: { 'Ocp-Apim-Subscription-Key': settings.azureKey } });
    if (res.status !== 200) throw new Error(`Azure voice list error ${res.status}`);
    return JSON.parse(res.body).map((v) => ({ shortName: v.ShortName, label: `${v.DisplayName} (${v.Locale})`, locale: v.Locale, gender: v.Gender }));
  }
  const get = () => request(`${VOICE_LIST_URL}&Sec-MS-GEC=${generateSecMsGec()}&Sec-MS-GEC-Version=${SEC_MS_GEC_VERSION}`,
    { headers: { ...EDGE_HEADERS, Origin: EDGE_EXTENSION_ORIGIN, 'Sec-CH-UA': EDGE_SEC_CH_UA, Accept: '*/*' } });
  let res = await get();
  if (res.status === 403 && res.headers.date) { adjustClockSkew(res.headers.date); res = await get(); }
  if (res.status !== 200) throw new Error(`Edge voice list error ${res.status}`);
  return JSON.parse(res.body).map((v) => {
    const name = v.ShortName.slice(v.Locale.length + 1).replace(/Neural$/, '').replace(/([a-z])([A-Z])/g, '$1 $2');
    return { shortName: v.ShortName, label: `${name} (${v.Locale})`, locale: v.Locale, gender: v.Gender };
  });
}

// Step-by-step connection check for "Read Aloud: Test Connection".
// -> [{ step, ok, ms, detail }]
export async function diagnose(settings) {
  const steps = [];
  const run = async (step, fn) => {
    const t0 = Date.now();
    try {
      const detail = await fn();
      steps.push({ step, ok: true, ms: Date.now() - t0, detail });
      return true;
    } catch (err) {
      steps.push({ step, ok: false, ms: Date.now() - t0, detail: err.message });
      return false;
    }
  };
  const host = new URL(VOICE_LIST_URL).hostname;
  steps.push({ step: 'Proxy', ok: true, ms: 0, detail: proxyUrl ? new URL(proxyUrl).host : 'none configured (direct, or VS Code\'s system proxy support)' });
  if (proxyUrl) {
    steps.push({ step: `DNS lookup ${host}`, ok: true, ms: 0, detail: 'skipped: the proxy looks up names' });
  } else {
    await run(`DNS lookup ${host}`, () => new Promise((resolve, reject) => {
      (transport.lookup || dns.lookup)(host, {}, (err, address) => (err ? reject(err) : resolve(address)));
    }));
  }
  await run('Voice list (HTTPS)', async () => `${(await listVoices({ ...settings, backend: 'edge' })).length} voices`);
  closeConnection();
  await run('Speech (WebSocket)', async () => {
    const t0 = Date.now();
    const r = await edge.synth('Testing the connection.', { ...settings, backend: 'edge' });
    return `${r.audio.length} bytes of audio in ${Date.now() - t0} ms`;
  });
  return steps;
}
