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

// Cancelled mid-stream: caller gets AbortError at once; the rest is ignored, and the next request
// goes out on the same connection right away (the service handles several at once).
const ssmlIds = (s) => s.sent.filter((m) => m.includes('Path:ssml')).map((m) => /X-RequestId:(\w+)/.exec(m)[1]);
const answerId = (s, id) => { audio(s, id); words(s, id); end(s, id); };
let ac = new AbortController();
p = client.synth('Cancelled.', settings, ac.signal);
await tick();
const cancelledId = lastRequestId(sockets[0]);
audio(sockets[0], cancelledId);
ac.abort();
await assert.rejects(p, { name: 'AbortError' });
p = client.synth('Next.', settings);
await tick();
const nextId = lastRequestId(sockets[0]);
assert.notEqual(nextId, cancelledId, 'sent without waiting for the cancelled one');
audio(sockets[0], cancelledId, [9, 9]); // late audio of the cancelled request: ignored
answerId(sockets[0], nextId);
r = await p;
assert.deepEqual(r.chunks.map((c) => [...c]), [[1, 2, 3]]);
end(sockets[0], cancelledId);
assert.equal(sockets.length, 1);
console.log('✓ cancelled request ignored while it finishes; next request sent at once on the same connection');

// Pipelining: up to maxInFlight requests at once, in order; the next waits for a free slot.
const sentBefore = ssmlIds(sockets[0]).length;
const ps = ['A.', 'B.', 'C.', 'D.'].map((t) => client.synth(t, settings));
await tick();
let ids = ssmlIds(sockets[0]).slice(-3);
assert.equal(ssmlIds(sockets[0]).length, sentBefore + 3, '3 sent at once, the 4th waits');
assert.match(sockets[0].sent.at(-3), /A\.</);
answerId(sockets[0], ids[1]); // the service may finish them in any order
r = await ps[1];
await tick();
assert.equal(ssmlIds(sockets[0]).length, sentBefore + 4, 'the 4th goes out when a slot frees up');
assert.match(sockets[0].sent.at(-1), /D\.</);
ids = ssmlIds(sockets[0]).slice(-4);
for (const k of [0, 2, 3]) answerId(sockets[0], ids[k]);
await Promise.all(ps);
assert.equal(sockets.length, 1);
console.log('✓ pipelining: 3 requests in flight on one connection, the 4th sent when one finishes');

// Acknowledged but slow (some voices take many seconds): not mistaken for a stall.
client.timeouts.idle = 60;
client.timeouts.synth = 400;
p = client.synth('Slow voice.', settings);
await tick();
let id = lastRequestId(sockets[0]);
sockets[0].handlers.onMessage(`X-RequestId:${id}\r\nPath:turn.start\r\n\r\n{}`);
await tick(200); // well past the idle timeout
assert.equal(sockets.length, 1, 'no retry while the service is working on it');
answerId(sockets[0], id);
await p;
console.log('✓ acknowledged request waits for slow audio instead of being retried');

// ...but an acknowledged request that then goes silent for too long is retried.
p = client.synth('Goes quiet.', settings);
await tick();
id = lastRequestId(sockets[0]);
sockets[0].handlers.onMessage(`X-RequestId:${id}\r\nPath:turn.start\r\n\r\n{}`);
while (sockets.length < 2) await tick(5);
assert.ok(sockets[0].closed);
await answer(1);
await p;
client.timeouts.synth = 20000;
console.log('✓ acknowledged request that goes silent is retried after the synthesis timeout');

// Connection full of cancelled requests still arriving, and a new one waiting: replaced after drainWait.
client.timeouts.idle = 5000;
const acs = [0, 1, 2].map(() => new AbortController());
const cancelled = acs.map((a, k) => client.synth(`Long ${k}.`, settings, a.signal));
cancelled.forEach((c) => c.catch(() => {}));
await tick();
for (const a of acs) a.abort();
const t0 = Date.now();
p = client.synth('After.', settings);
while (sockets.length < 3) await tick(5);
assert.ok(sockets[1].closed);
await answer(2);
await p;
assert.ok(Date.now() - t0 < client.timeouts.drainWait + 200);
console.log(`✓ connection full of cancelled requests: replaced after ${Date.now() - t0} ms`);
sockets.splice(0, 2); // keep indexes below as before

// Stalled request: abandoned after the idle timeout and retried once on a fresh connection.
client.timeouts.idle = 80;
p = client.synth('Stalls.', settings);
while (sockets.length < 2) await tick(5); // never answered on sockets[0]: retried on a new one
assert.ok(sockets[0].closed);
await answer(1);
await p;
console.log('✓ stalled request retried on a fresh connection');

// Service closes the connection mid-request: retried on a fresh one.
p = client.synth('Dropped.', settings);
await tick();
sockets[1].handlers.onClose();
await answer(2);
await p;
console.log('✓ dropped connection: retried');

// The service closes the connection after every request: the ones waiting behind it on the same
// connection are resent each time without using up their retry, and all of them get read.
{
  const socks = [];
  const c3 = new EdgeClient({ open: (url, h) => open(url, h).then((s) => { socks.push(s); return s; }) });
  const all = ['1.', '2.', '3.', '4.', '5.'].map((t) => c3.synth(t, settings));
  for (let k = 0; k < 5; k++) {
    while (socks.length <= k) await tick(5);
    await tick();
    const s = socks[k];
    answerId(s, ssmlIds(s)[0]);
    s.handlers.onClose();
  }
  assert.equal((await Promise.all(all)).length, 5);
  c3.close();
}
console.log('✓ service closing after every request: queued requests resent, none lost');

// Our own close() mustn't be reported as "the service closed the connection" (the transport may
// fire onClose synchronously from close()).
client.timeouts.idle = 40;
// close() is idempotent and fires onClose synchronously, like VS Code's WsConnection.close().
const reentrant = (url, h) => open(url, h).then((s) => { s.close = () => { if (s.closed) return; s.closed = true; h.onClose(); }; return s; });
const c2 = new EdgeClient({ open: reentrant });
c2.timeouts.idle = 40;
p = c2.synth('Never answered.', settings);
await assert.rejects(p, { message: 'The Edge service stopped responding' });
c2.close();
console.log('✓ a stall is reported as a stall, even when the transport closes synchronously');

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

// A request made while a failed handshake is being fixed waits for the fix instead of trying
// (and failing) with the old clock, which would use up its retry.
{
  let clockFixed = false;
  let attemptsBeforeFix = 0;
  const c4 = new EdgeClient({
    open: (url, h) => {
      if (!clockFixed) { attemptsBeforeFix++; return Promise.reject(Object.assign(new Error('403'), { status: 403 })); }
      return open(url, h);
    },
    onHandshakeFailure: async () => { await tick(60); clockFixed = true; },
  });
  const first = c4.synth('First.', settings);
  await tick(20);
  const second = c4.synth('Second.', settings); // arrives mid-fix
  while (!clockFixed) await tick(5);
  await tick();
  const s = sockets.at(-1);
  for (const id of ssmlIds(s)) answerId(s, id);
  await Promise.all([first, second]);
  assert.equal(attemptsBeforeFix, 1, 'no second handshake with the wrong clock');
  c4.close();
}
console.log('✓ requests made while a failed handshake is fixed wait for the fix');
client.close();
console.log('ALL PASSED');
