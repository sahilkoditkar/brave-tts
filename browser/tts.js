// Speech synthesis backends:
//  - edge:  Edge's online Read Aloud WebSocket endpoint (free, undocumented)
//  - azure: Azure Speech REST API with your own key (official; free tier available)

import { VOICE_LIST_URL, SEC_MS_GEC_VERSION, OUTPUT_FORMAT } from '../shared/constants.js';
import { generateSecMsGec, adjustClockSkew } from '../shared/drm.js';
import { buildSsml, localeOf, CONNECT_TIMEOUT_MS } from '../shared/ssml.js';
import { EdgeClient } from '../shared/edge-client.js';

async function syncClockWithServer() {
  try {
    const res = await fetch(`${VOICE_LIST_URL}&Sec-MS-GEC=${generateSecMsGec()}&Sec-MS-GEC-Version=${SEC_MS_GEC_VERSION}`,
      { cache: 'no-store' });
    const date = res.headers.get('Date');
    if (date) adjustClockSkew(date);
  } catch { /* ignore */ }
}

// The protocol (one reused connection, retries, linger) lives in shared/edge-client.js; this is the
// browser transport. The handshake headers Edge expects are set by declarativeNetRequest rules.
const timeouts = { connect: CONNECT_TIMEOUT_MS };

function openSocket(url, { onMessage, onClose }) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.binaryType = 'arraybuffer';
    let opened = false;
    const fail = (message) => {
      clearTimeout(timer);
      try { ws.close(); } catch { /* ignore */ }
      reject(Object.assign(new Error(message), { handshake: true }));
    };
    const timer = setTimeout(() => fail('Timed out connecting to the Edge Read Aloud service'), timeouts.connect);
    ws.onopen = () => {
      opened = true;
      clearTimeout(timer);
      resolve({ send: (text) => ws.send(text), close: () => ws.close() });
    };
    ws.onmessage = (ev) => onMessage(typeof ev.data === 'string' ? ev.data : new Uint8Array(ev.data));
    ws.onerror = () => { if (!opened) fail('Could not connect to the Edge Read Aloud service'); };
    ws.onclose = () => {
      if (!opened) fail('Could not connect to the Edge Read Aloud service');
      else onClose();
    };
  });
}

const edge = new EdgeClient({ open: openSocket, onHandshakeFailure: syncClockWithServer });

export function _setTimeoutsForTests({ connect, ...rest }) {
  if (connect) timeouts.connect = connect;
  Object.assign(edge.timeouts, rest);
}
// Close the connection now (normally it's kept open for a while, so the next read starts at once).
export function closeConnection() { edge.close(); }
// Open the connection ahead of the first request (e.g. while the page text is being extracted).
export function warmUp(settings) { if (settings?.backend !== 'azure') edge.warm(); }

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
    hooks.onAudio?.(value);
  }
  return { audio: new Blob(chunks, { type: 'audio/mpeg' }), words: [] }; // REST API gives no word timings
}

// hooks: { onAudio(Uint8Array), onWord({offset, duration, text}) } fire while audio streams in.
export async function synthesize(text, settings, signal, hooks) {
  if (settings.backend === 'azure') return azureSynth(text, settings, signal, hooks);
  const { chunks, words } = await edge.synth(text, settings, signal, hooks);
  return { audio: new Blob(chunks, { type: 'audio/mpeg' }), words };
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
