// Sec-MS-GEC token generation for Edge's online Read Aloud service.
// JavaScript port of the "v2" token from the open-source edge-tts project
// (edge_tts/drm.py, v7.3.1). If Microsoft changes the scheme again, compare
// against the latest edge-tts release and update this file + constants.js.

import { TRUSTED_CLIENT_TOKEN } from './constants.js';

const WIN_EPOCH = 11644473600n;

const SHA256_INITIAL = [
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
  0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
];
const SHA256_STATE = [
  0xfd9fbea2, 0x91243ce7, 0xbe499094, 0xcd2e1e0a,
  0x6c006f49, 0x04bd35ab, 0xfeb0a7e4, 0x03effbd2,
];
const SHA256_SCHEDULE = [
  0xeb24bf9e, 0x1558691f, 0xa0c09ee2, 0x0cfa32ba, 0xa622ee8c, 0xd1dd9491, 0xc0dd25a0,
  0xf9e70ab6, 0xf0c31573, 0x7058ce4e, 0x7188e606, 0x00e5ab33, 0xd258b060, 0x72766564,
];
const K = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];
const SHA256_ADJUSTMENT = 0xc9dc06a7;
const K_BLOCK = K.slice(0, 14).concat([SHA256_ADJUSTMENT], K.slice(15));
const SIGMA0_ADJ = 0x059c0b80;
const SIGMA1_ADJ = 0x000b92c0;

const CS64_COEFFICIENTS = [
  [0xe82e91b1, 0xb32700d0], [0x44de24c6, 0x88dff51d], [0x3beb65bc, 0x29514038],
  [0xc89c5933, 0xb328cbdf], [0x8d1ec211, 0xd405b4d5], [0x314ef5d5, 0x26e55f3c],
  [0xe92491b1, 0x607801c6], [0xf0a5b9d5, 0x82b2c1fb], [0x06064cf3, 0xfa51a3da],
  [0xda79fa60, 0x207cc464], [0xbed20560, 0x3c3c74f3], [0x89f9c9f8, 0xd2d14b61],
  [0x35fa38c6, 0xbb04a2c1], [0xcb49e3c6, 0xc5626167],
];
const CS64_FACTOR = 0x82893933;
const CS64_ADJ0 = 0xf2f90b1a;
const CS64_ADJ1 = 0x0b1a0000;

const u = (x) => x >>> 0;
const mul = (a, b) => Math.imul(a, b) >>> 0;
const rotr = (v, n) => ((v >>> n) | (v << (32 - n))) >>> 0;
const rol16 = (v) => ((v << 16) | (v >>> 16)) >>> 0;
const sig0 = (v) => (rotr(v, 7) ^ rotr(v, 18) ^ (v >>> 3)) >>> 0;
const sig1 = (v) => (rotr(v, 17) ^ rotr(v, 19) ^ (v >>> 10)) >>> 0;
const bigSig0 = (a) => (rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) >>> 0;
const bigSig1 = (e) => (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) >>> 0;

function rounds(state, w, firstRound = 0) {
  let [a, b, c, d, e, f, g, h] = state;
  const k = firstRound === 14 ? K_BLOCK : K;
  for (let i = firstRound; i < 64; i++) {
    const t1 = u(h + bigSig1(e) + u(g ^ (e & (f ^ g))) + k[i] + w[i]);
    const t2 = u(bigSig0(a) + u((a & b) | (c & (a | b))));
    h = g; g = f; f = e; e = u(d + t1);
    d = c; c = b; b = a; a = u(t1 + t2);
  }
  return [a, b, c, d, e, f, g, h];
}

function expand(w, first = 16) {
  for (let i = first; i < 64; i++) {
    w.push(u(sig1(w[i - 2]) + w[i - 7] + sig0(w[i - 15]) + w[i - 16]));
  }
}

function be(bytes, start, end) {
  let v = 0;
  for (let i = start; i < end; i++) v = v * 256 + bytes[i];
  return v >>> 0;
}

function sha256Init(d7) {
  const w = new Array(14).fill(0);
  w.push(be(d7, 0, 3));
  w.push(be(d7, 3, 7));
  for (let i = 16; i < 30; i++) {
    let v = SHA256_SCHEDULE[i - 16];
    if (i - 2 >= 14) v += i === 16 ? u(sig1(w[i - 2]) ^ SIGMA1_ADJ) : sig1(w[i - 2]);
    if (i - 7 >= 14) v += w[i - 7];
    if (i - 15 >= 14) v += i === 29 ? u(sig0(w[i - 15]) ^ SIGMA0_ADJ) : sig0(w[i - 15]);
    w.push(u(v));
  }
  w.push(u(sig1(w[28]) + w[23] + sig0(w[15]) + w[14] + SHA256_ADJUSTMENT - K[14]));
  expand(w, 31);
  const working = rounds(SHA256_STATE, w, 14);
  return SHA256_INITIAL.map((x, i) => u(x + working[i]));
}

function sha256Digest(data) {
  const length = 57 + data.length;
  const padLen = (((55 - length) % 64) + 64) % 64;
  const tail = data.slice(7);
  const padded = new Uint8Array(tail.length + 1 + padLen + 8);
  padded.set(tail, 0);
  padded[tail.length] = 0x80;
  const bits = BigInt(length) * 8n;
  const dv = new DataView(padded.buffer);
  dv.setBigUint64(padded.length - 8, bits, false);
  let state = sha256Init(data.slice(0, 7));
  for (let off = 0; off < padded.length; off += 64) {
    const w = [];
    for (let j = 0; j < 16; j++) w.push(dv.getUint32(off + j * 4, false));
    expand(w);
    const working = rounds(state, w);
    state = state.map((x, i) => u(x + working[i]));
  }
  const out = new Uint8Array(32);
  const odv = new DataView(out.buffer);
  state.forEach((x, i) => odv.setUint32(i * 4, x, false));
  return out;
}

function wordsLe4Even(bytes) {
  const len = Math.ceil(bytes.length / 4) * 4;
  if (len === 0) return [];
  const padded = new Uint8Array(len);
  padded.set(bytes);
  const dv = new DataView(padded.buffer);
  const words = [];
  for (let i = 0; i < len; i += 4) words.push(dv.getUint32(i, true));
  if (words.length % 2) words.push(0);
  return words;
}

function cs64Digest(data, digest) {
  const ddv = new DataView(digest.buffer);
  const keyA = u(ddv.getUint32(0, true) | 1);
  const keyB = u(ddv.getUint32(4, true) | 1);
  const factors = [mul(keyA, CS64_FACTOR), mul(keyB, CS64_FACTOR)];
  const terms = CS64_COEFFICIENTS.map(([c], i) => mul(c, factors[i % 2]));
  const offsets = CS64_COEFFICIENTS.map(([, o]) => o);
  const withZero = new Uint8Array(data.length + 1);
  withZero.set(data, 1);
  wordsLe4Even(withZero).forEach((word, i) => {
    const even = i % 2 === 0;
    let term = mul(word, even ? keyA : keyB);
    let offset = mul(rol16(word), even ? 0xef0569fb : 0xc31713db);
    if (i === 0) {
      term = u(term + mul(CS64_ADJ0, factors[0]));
      offset = u(offset + CS64_ADJ1);
    }
    terms.push(term);
    offsets.push(offset);
  });
  let swapAcc = 0, swapLast = 0, state = 0, acc = 0;
  for (let i = 0; i < terms.length; i += 2) {
    const x = terms[i], y = terms[i + 1];
    let t = rol16(u(offsets[i] + x));
    let q = mul(t, 0x76f50f34);
    swapAcc = u(swapAcc + u(mul(rol16(q), 0xc3efea97) + q));
    t = rol16(u(offsets[i + 1] + y));
    q = mul(t, 0x1881ce3c);
    swapLast = u(mul(rol16(q), 0x35bd1ec9) + q);
    swapAcc = u(swapAcc + swapLast);

    state = u(mul(state, keyA) + x);
    state = mul(rol16(state), 0xcf98b111);
    state = mul(rol16(state), 0x87085b9f);
    state = mul(rol16(state), 0x12ceb96d);
    state = mul(rol16(state), 0x257e1d83);
    acc = u(acc + state);
    t = u(mul(state, keyB) + y);
    t = mul(rol16(t), 0xa27416f5);
    t = mul(rol16(t), 0xd38396ff);
    state = mul(rol16(mul(rol16(t), 0x7c932b89)), 0xbfa49f69);
    acc = u(acc + state);
  }
  return [u(swapLast ^ state), u(swapAcc ^ acc)];
}

const hex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('').toUpperCase();

// Clock skew correction (seconds), adjusted from the server's Date header on 403s.
let clockSkewSeconds = 0;
export function adjustClockSkew(serverDateHeader) {
  const server = Date.parse(serverDateHeader);
  if (!Number.isNaN(server)) clockSkewSeconds = (server - Date.now()) / 1000;
}

export function generateSecMsGec(unixSeconds) {
  const now = unixSeconds ?? Date.now() / 1000 + clockSkewSeconds;
  let ticks = BigInt(Math.floor(now)) + WIN_EPOCH;
  ticks -= ticks % 300n;
  ticks *= 10000000n;
  const data = new TextEncoder().encode(`${ticks}${TRUSTED_CLIENT_TOKEN}`);
  const digest = sha256Digest(data);
  const [c0, c1] = cs64Digest(data, digest);
  const cs = new Uint8Array(8);
  const cdv = new DataView(cs.buffer);
  cdv.setUint32(0, c0, true);
  cdv.setUint32(4, c1, true);
  return `${hex(cs)}-${hex(digest)}`;
}

export function generateMuid() {
  return hex(crypto.getRandomValues(new Uint8Array(16)));
}
