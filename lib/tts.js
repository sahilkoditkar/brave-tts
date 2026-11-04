// Speech synthesis backends:
//  - edge:  Edge's online Read Aloud WebSocket endpoint (free, undocumented)
//  - azure: Azure Speech REST API with your own key (official; free tier available)

import {
  WSS_URL, VOICE_LIST_URL, SEC_MS_GEC_VERSION, OUTPUT_FORMAT,
} from './constants.js';
import { generateSecMsGec, adjustClockSkew } from './drm.js';

const uuid = () => crypto.randomUUID().replaceAll('-', '');

function escapeXml(s) {
  return s
    // characters the service rejects (e.g. vertical tab from OCR'd PDFs)
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, ' ')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

function localeOf(voice) {
  const m = /^([a-z]{2,})-([A-Z]{2,})/.exec(voice);
  return m ? `${m[1]}-${m[2]}` : 'en-US';
}

// "en-US-AriaNeural" -> "Microsoft Server Speech Text to Speech Voice (en-US, AriaNeural)"
function edgeLongVoiceName(voice) {
  const m = /^([a-z]{2,})-([A-Z]{2,})-(.+Neural)$/.exec(voice);
  if (!m) return voice;
  let [, lang, region, name] = m;
  const dash = name.indexOf('-');
  if (dash !== -1) {
    region = `${region}-${name.slice(0, dash)}`;
    name = name.slice(dash + 1);
  }
  return `Microsoft Server Speech Text to Speech Voice (${lang}-${region}, ${name})`;
}

function prosody({ rate = 1, pitch = 0 }) {
  const r = Math.round((rate - 1) * 100);
  const p = Math.round(pitch);
  return { rate: `${r >= 0 ? '+' : ''}${r}%`, pitch: `${p >= 0 ? '+' : ''}${p}Hz` };
}

function buildSsml(text, voiceName, locale, settings) {
  const { rate, pitch } = prosody(settings);
  return (
    `<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='${locale}'>` +
    `<voice name='${voiceName}'><prosody pitch='${pitch}' rate='${rate}' volume='+0%'>` +
    `${escapeXml(text)}</prosody></voice></speak>`
  );
}

// JS-style date string the Edge client sends.
function dateString() {
  return new Date().toUTCString().replace(/^(\w+), (\d+) (\w+) (\d+) (.+) GMT$/,
    (_, wd, d, mo, y, t) => `${wd} ${mo} ${d} ${y} ${t} GMT+0000 (Coordinated Universal Time)`);
}

function parseHeaders(text) {
  const headers = {};
  for (const line of text.split('\r\n')) {
    const i = line.indexOf(':');
    if (i > 0) headers[line.slice(0, i)] = line.slice(i + 1);
  }
  return headers;
}

async function syncClockWithServer() {
  try {
    const res = await fetch(`${VOICE_LIST_URL}&Sec-MS-GEC=${generateSecMsGec()}&Sec-MS-GEC-Version=${SEC_MS_GEC_VERSION}`,
      { cache: 'no-store' });
    const date = res.headers.get('Date');
    if (date) adjustClockSkew(date);
  } catch { /* ignore */ }
}

function edgeSynthOnce(text, settings, signal) {
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
      ws.send(
        `X-Timestamp:${dateString()}\r\nContent-Type:application/json; charset=utf-8\r\nPath:speech.config\r\n\r\n` +
        '{"context":{"synthesis":{"audio":{"metadataoptions":{"sentenceBoundaryEnabled":"false","wordBoundaryEnabled":"true"},' +
        `"outputFormat":"${OUTPUT_FORMAT}"}}}}\r\n`,
      );
      const ssml = buildSsml(text, edgeLongVoiceName(settings.voice), localeOf(settings.voice), settings);
      ws.send(
        `X-RequestId:${uuid()}\r\nContent-Type:application/ssml+xml\r\nX-Timestamp:${dateString()}Z\r\nPath:ssml\r\n\r\n${ssml}`,
      );
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
                words.push({ offset: m.Data.Offset, duration: m.Data.Duration, text: m.Data.text.Text });
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
          if (audio.byteLength) chunks.push(audio);
        }
      }
    };
    ws.onerror = () => finish(new Error(opened
      ? 'Edge service connection error'
      : 'Could not connect to the Edge Read Aloud service'));
    ws.onclose = () => finish(chunks.length ? undefined : new Error('Edge service closed the connection'));
  });
}

async function edgeSynth(text, settings, signal) {
  try {
    return await edgeSynthOnce(text, settings, signal);
  } catch (err) {
    if (err.name === 'AbortError' || err.opened) throw err;
    // Handshake rejected: most often a clock-skew problem with the token. Sync and retry once.
    await syncClockWithServer();
    return edgeSynthOnce(text, settings, signal);
  }
}

async function azureSynth(text, settings, signal) {
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
  return { audio: await res.blob(), words: [] }; // REST API gives no word timings
}

export function synthesize(text, settings, signal) {
  return settings.backend === 'azure'
    ? azureSynth(text, settings, signal)
    : edgeSynth(text, settings, signal);
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
