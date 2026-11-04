// Unit tests for the shared connection client, with a fake in-memory transport (no network).
// Run: node shared/tests/edge-client.test.mjs
import assert from 'node:assert/strict';
import { EdgeClient } from '../edge-client.js';

const sockets = [];
const open = async (url, handlers) => {
  const s = { url, handlers, sent: [], closed: false, send(t) { this.sent.push(t); }, close() { this.closed = true; } };
  sockets.push(s);
  return s;
};
const settings = { voice: 'en-US-AvaMultilingualNeural', rate: 1, pitch: 0 };
const tick = (ms = 15) => new Promise((r) => setTimeout(r, ms));
const lastRequestId = (s) => /X-RequestId:(\w+)/.exec(s.sent.at(-1))[1];
const audio = (s, id, bytes = [1, 2, 3]) => {
  const hdr = new TextEncoder().encode(`X-RequestId:${id}\r\nContent-Type:audio/mpeg\r\nPath:audio\r\n`);
  const msg = new Uint8Array(2 + hdr.length + bytes.length);
  msg[1] = hdr.length;
  msg.set(hdr, 2);
  msg.set(bytes, 2 + hdr.length);
  s.handlers.onMessage(msg);
};
const words = (s, id) => s.handlers.onMessage(`X-RequestId:${id}\r\nPath:audio.metadata\r\n\r\n` +
  JSON.stringify({ Metadata: [{ Type: 'WordBoundary', Data: { Offset: 100, Duration: 50, text: { Text: 'Hi' } } }] }));
const end = (s, id) => s.handlers.onMessage(`X-RequestId:${id}\r\nPath:turn.end\r\n\r\n{}`);
const answer = async (k) => { await tick(); const s = sockets.at(k); const id = lastRequestId(s); audio(s, id); words(s, id); end(s, id); };

// One connection for several sentences; the speech config is sent once, first.
let client = new EdgeClient({ open });
let p = client.synth('One.', settings);
await answer(0);
let r = await p;
assert.deepEqual([...r.chunks[0]], [1, 2, 3]);
assert.deepEqual(r.words, [{ offset: 100, duration: 50, text: 'Hi' }]);
p = client.synth('Two.', settings);
await answer(0);
await p;
assert.equal(sockets.length, 1);
assert.match(sockets[0].sent[0], /Path:speech\.config/);
assert.equal(sockets[0].sent.filter((m) => m.includes('Path:ssml')).length, 2);
assert.match(sockets[0].url, /Sec-MS-GEC=[0-9A-F]{16}-[0-9A-F]{64}/);
console.log('✓ one connection, config once, audio + word timings');

// Stays open after reading (linger), then closes by itself.
client.timeouts.linger = 60;
p = client.synth('Three.', settings);
await answer(0);
await p;
assert.equal(sockets[0].closed, false);
await tick(100);
assert.equal(sockets[0].closed, true, 'idle connection closed after the linger time');
console.log('✓ idle connection kept open, then closed after the linger time');

// warm() opens a connection before the first request; the request then reuses it.
client = new EdgeClient({ open });
sockets.length = 0;
client.warm();
await tick();
assert.equal(sockets.length, 1);
p = client.synth('Warm.', settings);
await answer(0);
await p;
assert.equal(sockets.length, 1);
console.log('✓ warm() connects ahead of the first request');

// Cancelled mid-stream, finishes soon: caller gets AbortError at once, connection is reused.
let ac = new AbortController();
p = client.synth('Cancelled.', settings, ac.signal);
await tick();
const cancelledId = lastRequestId(sockets[0]);
audio(sockets[0], cancelledId);
ac.abort();
await assert.rejects(p, { name: 'AbortError' });
const ssmlCount = () => sockets[0].sent.filter((m) => m.includes('Path:ssml')).length;
const before = ssmlCount();
p = client.synth('Next.', settings);
await tick();
assert.equal(ssmlCount(), before, 'waits for the cancelled one to finish');
end(sockets[0], cancelledId);
await answer(0);
await p;
assert.equal(sockets.length, 1);
console.log('✓ cancelled request drains in the background; connection reused');

// Cancelled, keeps streaming: the next request closes it after drainWait and reconnects.
ac = new AbortController();
p = client.synth('Long.', settings, ac.signal);
p.catch(() => {});
await tick();
audio(sockets[0], lastRequestId(sockets[0]));
ac.abort();
const t0 = Date.now();
p = client.synth('After.', settings);
while (sockets.length < 2) await tick(5);
await answer(1);
await p;
assert.ok(sockets[0].closed);
assert.ok(Date.now() - t0 < client.timeouts.drainWait + 200);
console.log(`✓ slow drain: closed and reconnected after ${Date.now() - t0} ms`);

// Stalled request: abandoned after the idle timeout and retried once on a fresh connection.
client.timeouts.idle = 80;
p = client.synth('Stalls.', settings);
while (sockets.length < 3) await tick(5); // never answered on sockets[1]: retried on a new one
assert.ok(sockets[1].closed);
await answer(2);
await p;
console.log('✓ stalled request retried on a fresh connection');

// Service closes the connection mid-request: retried on a fresh one.
p = client.synth('Dropped.', settings);
await tick();
sockets[2].handlers.onClose();
await answer(3);
await p;
console.log('✓ dropped connection: retried');

// Failed handshake: onHandshakeFailure runs (clock skew fix), then one retry.
let fails = 1;
let fixed = 0;
client = new EdgeClient({
  open: (url, h) => (fails-- > 0 ? Promise.reject(Object.assign(new Error('403'), { status: 403 })) : open(url, h)),
  onHandshakeFailure: async (err) => { fixed += err.status === 403; },
});
p = client.synth('Retry.', settings);
await tick();
await answer(-1);
await p;
assert.equal(fixed, 1);
console.log('✓ failed handshake: onHandshakeFailure, then retried');
client.close();
console.log('ALL PASSED');
