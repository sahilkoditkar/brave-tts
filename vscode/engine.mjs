// Speech engine for VS Code, built only on Node's standard library (no npm packages).
// Shares the token, constants and SSML/protocol helpers with the browser extension.

import https from 'node:https';
import crypto from 'node:crypto';
import {
  WSS_URL, VOICE_LIST_URL, SEC_MS_GEC_VERSION, OUTPUT_FORMAT,
  EDGE_EXTENSION_ORIGIN, EDGE_USER_AGENT, EDGE_SEC_CH_UA,
} from '../shared/constants.js';
import { generateSecMsGec, generateMuid, adjustClockSkew } from '../shared/drm.js';
import {
  uuid, buildSsml, localeOf, parseHeaders, speechConfigMessage, ssmlMessage,
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
    });
    req.setTimeout(15000, () => req.destroy(new Error('Connection to the Edge service timed out')));
    req.on('response', (res) => {
      res.resume();
      reject(Object.assign(new Error(`Edge service refused the connection (HTTP ${res.statusCode})`),
        { status: res.statusCode, date: res.headers.date }));
    });
    req.on('error', reject);
    req.on('upgrade', (res, socket, head) => {
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
async function edgeSynthOnce(text, settings, signal) {
  const url = `${WSS_URL}&ConnectionId=${uuid()}&Sec-MS-GEC=${generateSecMsGec()}&Sec-MS-GEC-Version=${SEC_MS_GEC_VERSION}`;
  const ws = await wsConnect(url, { ...EDGE_HEADERS, Origin: EDGE_EXTENSION_ORIGIN });
  return new Promise((resolve, reject) => {
    const chunks = [];
    const words = [];
    let done = false;
    const finish = (err) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      ws.close();
      if (err) reject(err);
      else if (!chunks.length) reject(new Error('No audio received from the Edge service'));
      else resolve({ audio: Buffer.concat(chunks), words });
    };
    const onAbort = () => finish(Object.assign(new Error('Aborted'), { name: 'AbortError' }));
    if (signal?.aborted) { onAbort(); return; }
    signal?.addEventListener('abort', onAbort);
    const timer = setTimeout(() => finish(new Error('Edge service timed out')), 20000);

    ws.onmessage = (isBinary, data) => {
      if (!isBinary) {
        const s = data.toString('utf8');
        const sep = s.indexOf('\r\n\r\n');
        const headers = parseHeaders(s.slice(0, sep));
        if (headers.Path === 'audio.metadata') {
          try {
            for (const m of JSON.parse(s.slice(sep + 4)).Metadata || []) {
              if (m.Type === 'WordBoundary') words.push({ offset: m.Data.Offset, duration: m.Data.Duration, text: m.Data.text.Text });
            }
          } catch { /* ignore */ }
        } else if (headers.Path === 'turn.end') {
          finish();
        }
      } else if (data.length >= 2) {
        const hl = data.readUInt16BE(0);
        const headers = parseHeaders(data.subarray(2, 2 + hl).toString('utf8'));
        if (headers.Path === 'audio' && headers['Content-Type'] === 'audio/mpeg') {
          const audio = data.subarray(2 + hl);
          if (audio.length) chunks.push(Buffer.from(audio));
        }
      }
    };
    ws.onclose = () => finish(chunks.length ? undefined : new Error('Edge service closed the connection'));
    ws.send(speechConfigMessage());
    ws.send(ssmlMessage(text, settings));
  });
}

async function edgeSynth(text, settings, signal) {
  try {
    return await edgeSynthOnce(text, settings, signal);
  } catch (err) {
    if (err.status === 403 && err.date) {
      adjustClockSkew(err.date); // token is time-based: fix clock skew and retry once
      return edgeSynthOnce(text, settings, signal);
    }
    throw err;
  }
}

// ---------------------------------------------------------------- HTTPS helper
function request(url, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request({ hostname: u.hostname, port: u.port || 443, path: u.pathname + u.search, method, headers, ...transport }, (res) => {
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
  return settings.backend === 'azure' ? azureSynth(text, settings) : edgeSynth(text, settings, signal);
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
