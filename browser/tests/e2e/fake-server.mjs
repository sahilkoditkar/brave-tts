// Fake speech.platform.bing.com for local testing (no traffic to Microsoft).
import https from 'node:https';
import http from 'node:http';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { generateSecMsGec } from '../../lib/drm.js';

const dir = new URL('.', import.meta.url).pathname;
const tmp = process.env.E2E_TMP;
const log = (o) => fs.appendFileSync(tmp + '/server.log', JSON.stringify(o) + '\n');
const mp3 = fs.readFileSync(tmp + '/tone.mp3');

const VOICES = [
  { Name: 'x', ShortName: 'en-US-AvaMultilingualNeural', Gender: 'Female', Locale: 'en-US', FriendlyName: 'Microsoft AvaMultilingual Online (Natural) - English (United States)' },
  { Name: 'y', ShortName: 'en-US-AndrewNeural', Gender: 'Male', Locale: 'en-US', FriendlyName: 'Microsoft Andrew Online (Natural) - English (United States)' },
  { Name: 'z', ShortName: 'fr-FR-DeniseNeural', Gender: 'Female', Locale: 'fr-FR', FriendlyName: 'Microsoft Denise Online (Natural) - French (France)' },
];

function frame(opcode, payload) {
  const len = payload.length;
  let head;
  if (len < 126) head = Buffer.from([0x80 | opcode, len]);
  else if (len < 65536) { head = Buffer.alloc(4); head[0] = 0x80 | opcode; head[1] = 126; head.writeUInt16BE(len, 2); }
  else { head = Buffer.alloc(10); head[0] = 0x80 | opcode; head[1] = 127; head.writeBigUInt64BE(BigInt(len), 2); }
  return Buffer.concat([head, payload]);
}
function parseFrames(buf, onMsg) {
  while (buf.length >= 2) {
    const opcode = buf[0] & 0x0f;
    let len = buf[1] & 0x7f; let off = 2;
    if (len === 126) { if (buf.length < 4) break; len = buf.readUInt16BE(2); off = 4; }
    else if (len === 127) { if (buf.length < 10) break; len = Number(buf.readBigUInt64BE(2)); off = 10; }
    const masked = buf[1] & 0x80;
    const mask = masked ? buf.subarray(off, off + 4) : null; if (masked) off += 4;
    if (buf.length < off + len) break;
    const payload = Buffer.from(buf.subarray(off, off + len));
    if (mask) for (let i = 0; i < len; i++) payload[i] ^= mask[i % 4];
    onMsg(opcode, payload);
    buf = buf.subarray(off + len);
  }
  return buf;
}

const server = https.createServer({ key: fs.readFileSync(tmp + '/key.pem'), cert: fs.readFileSync(tmp + '/cert.pem') }, (req, res) => {
  const url = new URL(req.url, 'https://x');
  log({ type: 'http', path: url.pathname, gecValid: url.searchParams.get('Sec-MS-GEC') === generateSecMsGec(), ua: req.headers['user-agent'], origin: req.headers.origin, cookie: req.headers.cookie });
  if (url.pathname.endsWith('/voices/list')) {
    res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
    res.end(JSON.stringify(VOICES));
  } else { res.writeHead(404); res.end(); }
});

server.on('upgrade', (req, socket) => {
  const url = new URL(req.url, 'https://x');
  const entry = { type: 'ws', path: url.pathname, gec: url.searchParams.get('Sec-MS-GEC'), gecVersion: url.searchParams.get('Sec-MS-GEC-Version'),
    gecValid: url.searchParams.get('Sec-MS-GEC') === generateSecMsGec(), origin: req.headers.origin, ua: req.headers['user-agent'], cookie: req.headers.cookie, pragma: req.headers.pragma };
  log(entry);
  const accept = crypto.createHash('sha1').update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  let pending = Buffer.alloc(0);
  socket.on('data', (d) => {
    pending = parseFrames(Buffer.concat([pending, d]), (op, payload) => {
      if (op === 8) { socket.end(frame(8, Buffer.alloc(0))); return; }
      if (op !== 1) return;
      const text = payload.toString('utf8');
      if (!text.includes('Path:ssml')) { log({ type: 'config', ok: text.includes('wordBoundaryEnabled') }); return; }
      const m = /<voice name='([^']+)'><prosody pitch='([^']+)' rate='([^']+)'[^>]*>([\s\S]*)<\/prosody>/.exec(text);
      const spoken = m[4].replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'");
      log({ type: 'ssml', voice: m[1], pitch: m[2], rate: m[3], text: spoken });
      const rid = /X-RequestId:(\w+)/.exec(text)[1];
      const hdr = (p) => `X-RequestId:${rid}\r\nContent-Type:application/json; charset=utf-8\r\nPath:${p}\r\n\r\n`;
      socket.write(frame(1, Buffer.from(hdr('turn.start') + '{}')));
      const words = spoken.split(/\s+/).map((w) => w.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '')).filter(Boolean);
      const meta = { Metadata: words.map((w, k) => ({ Type: 'WordBoundary', Data: { Offset: 500000 + k * (11000000 / Math.max(words.length, 1)), Duration: 1000000, text: { Text: w, Length: w.length, BoundaryType: 'WordBoundary' } } })) };
      socket.write(frame(1, Buffer.from(hdr('audio.metadata') + JSON.stringify(meta))));
      const audioHdr = Buffer.from(`X-RequestId:${rid}\r\nContent-Type:audio/mpeg\r\nX-StreamId:1\r\nPath:audio\r\n`);
      // FAKE_CHUNK_DELAY_MS simulates the real service streaming audio as it synthesizes.
      const delay = Number(process.env.FAKE_CHUNK_DELAY_MS || 0);
      const parts = [];
      const step = Math.ceil(mp3.length / 4);
      for (let p = 0; p < mp3.length; p += step) parts.push(mp3.subarray(p, p + step));
      const endHdr = Buffer.from(`X-RequestId:${rid}\r\nX-StreamId:1\r\nPath:audio\r\n`);
      const sendAll = async () => {
        for (const part of parts) {
          const len = Buffer.alloc(2); len.writeUInt16BE(audioHdr.length);
          socket.write(frame(2, Buffer.concat([len, audioHdr, part])));
          if (delay) await new Promise((r) => setTimeout(r, delay));
        }
        const len2 = Buffer.alloc(2); len2.writeUInt16BE(endHdr.length);
        socket.write(frame(2, Buffer.concat([len2, endHdr])));
        socket.write(frame(1, Buffer.from(hdr('turn.end') + '{}')));
      };
      sendAll();
    });
  });
  socket.on('error', () => {});
});
server.listen(443, '127.0.0.1');

// Test article page
http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': "default-src 'self'; style-src 'self'" });
  res.end(fs.readFileSync(dir + 'article.html'));
}).listen(8080, '127.0.0.1');
console.log('fake server up');
