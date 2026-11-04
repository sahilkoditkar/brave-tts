// Values that mimic Microsoft Edge's built-in Read Aloud client.
// Taken from edge-tts v7.3.1. If the Edge voices stop working, the usual fix is
// to bump these (and/or drm.js) to match the latest edge-tts release.

export const TRUSTED_CLIENT_TOKEN = '6A5AA1D4EAFF4E9FB37E23D68491D6F4';
export const CHROMIUM_FULL_VERSION = '143.0.3650.75';
export const CHROMIUM_MAJOR_VERSION = CHROMIUM_FULL_VERSION.split('.')[0];
export const SEC_MS_GEC_VERSION = `2-${CHROMIUM_FULL_VERSION}`;

const BASE = 'speech.platform.bing.com/consumer/speech/synthesize/readaloud';
export const WSS_URL = `wss://${BASE}/edge/v1?TrustedClientToken=${TRUSTED_CLIENT_TOKEN}`;
export const VOICE_LIST_URL = `https://${BASE}/voices/list?trustedclienttoken=${TRUSTED_CLIENT_TOKEN}`;

export const EDGE_EXTENSION_ORIGIN = 'chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold';
export const EDGE_USER_AGENT =
  `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) ` +
  `Chrome/${CHROMIUM_MAJOR_VERSION}.0.0.0 Safari/537.36 Edg/${CHROMIUM_MAJOR_VERSION}.0.0.0`;
export const EDGE_SEC_CH_UA =
  `" Not;A Brand";v="99", "Microsoft Edge";v="${CHROMIUM_MAJOR_VERSION}", "Chromium";v="${CHROMIUM_MAJOR_VERSION}"`;

export const OUTPUT_FORMAT = 'audio-24khz-48kbitrate-mono-mp3';

export const DEFAULT_SETTINGS = {
  backend: 'edge', // 'edge' (free Edge Read Aloud endpoint) or 'azure' (your own Azure Speech key)
  voice: 'en-US-AvaMultilingualNeural',
  rate: 1.0, // 0.5 – 3.0
  pitch: 0, // Hz offset, -50 – 50
  azureKey: '',
  azureRegion: 'eastus',
  highlightWords: true,
  autoScroll: true,
};
