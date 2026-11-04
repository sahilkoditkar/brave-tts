// Speech synthesis backends:
//  - edge:  Edge's online Read Aloud WebSocket endpoint (free, undocumented)
//  - azure: Azure Speech REST API with your own key (official; free tier available)

import { WSS_URL, VOICE_LIST_URL, SEC_MS_GEC_VERSION, OUTPUT_FORMAT } from './constants.js';
import { generateSecMsGec, adjustClockSkew } from './drm.js';
import {
  uuid, buildSsml, localeOf, parseHeaders, speechConfigMessage, ssmlMessage,
} from './ssml.js';

async function syncClockWithServer() {
  try {
    const res = await fetch(`${VOICE_LIST_URL}&Sec-MS-GEC=${generateSecMsGec()}&Sec-MS-GEC-Version=${SEC_MS_GEC_VERSION}`,
      { cache: 'no-store' });
    const date = res.headers.get('Date');
    if (date) adjustClockSkew(date);
  } catch { /* ignore */ }
}

function edgeSynthOnce(text, settings, signal, hooks = {}) {
  return new Promise((resolve, reject) => {
    const url = `${WSS_URL}&ConnectionId=${uuid()}&Sec-MS-GEC=${generateSecMsGec()}` +
      `&Sec-MS-GEC-Version=${SEC_MS_GEC_VERSION}`;
    const ws = new WebSocket(url);
    ws.binaryType = 'arraybuffer';
    const chunks = [];
    const words = [];
    let opened = false;
    let done = false;
    const finish = (err) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      try { ws.close(); } catch { /* ignore */ }
      if (err) { err.opened = opened; reject(err); return; }
      if (!chunks.length) { reject(new Error('No audio received from Edge service')); return; }
      resolve({ audio: new Blob(chunks, { type: 'audio/mpeg' }), words });
    };
    const onAbort = () => finish(new DOMException('Aborted', 'AbortError'));
    signal?.addEventListener('abort', onAbort);
    const timer = setTimeout(() => finish(new Error('Edge service timed out')), 20000);

    ws.onopen = () => {
      opened = true;
      ws.send(speechConfigMessage());
      ws.send(ssmlMessage(text, settings));
    };
    ws.onmessage = (ev) => {
      if (typeof ev.data === 'string') {
        const sep = ev.data.indexOf('\r\n\r\n');
        const headers = parseHeaders(ev.data.slice(0, sep));
        const body = ev.data.slice(sep + 4);
        if (headers.Path === 'audio.metadata') {
          try {
            for (const m of JSON.parse(body).Metadata || []) {
              if (m.Type === 'WordBoundary') {
                const w = { offset: m.Data.Offset, duration: m.Data.Duration, text: m.Data.text.Text };
                words.push(w);
                hooks.onWord?.(w);
              }
            }
          } catch { /* ignore malformed metadata */ }
        } else if (headers.Path === 'turn.end') {
          finish();
        }
      } else {
        const view = new DataView(ev.data);
        if (ev.data.byteLength < 2) return;
        const headerLen = view.getUint16(0, false);
        const headerText = new TextDecoder().decode(new Uint8Array(ev.data, 2, headerLen));
        const headers = parseHeaders(headerText);
        if (headers.Path === 'audio' && headers['Content-Type'] === 'audio/mpeg') {
          const audio = ev.data.slice(2 + headerLen);
          if (audio.byteLength) {
            chunks.push(audio);
            hooks.onAudio?.(audio); // lets the player start before the whole sentence arrives
          }
        }
      }
    };
    ws.onerror = () => finish(new Error(opened
      ? 'Edge service connection error'
      : 'Could not connect to the Edge Read Aloud service'));
    ws.onclose = () => finish(chunks.length ? undefined : new Error('Edge service closed the connection'));
  });
}

async function edgeSynth(text, settings, signal, hooks) {
  try {
    return await edgeSynthOnce(text, settings, signal, hooks);
  } catch (err) {
    if (err.name === 'AbortError' || err.opened) throw err;
    // Handshake rejected: most often a clock-skew problem with the token. Sync and retry once.
    await syncClockWithServer();
    return edgeSynthOnce(text, settings, signal, hooks);
  }
}

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
    : edgeSynth(text, settings, signal, hooks);
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
