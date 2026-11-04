# shared

Code used by both extensions. Both import it directly (`import … from '../shared/…'`), and the
build (`scripts/build.mjs`, run by GitHub Actions) bundles it into each extension. There are no
copies to keep in sync.

| File | What it does |
|---|---|
| `constants.js` | Endpoint URLs, the Edge client version, and default settings |
| `drm.js` | The time-based `Sec-MS-GEC` request token (a port of edge-tts) |
| `ssml.js` | SSML building, protocol messages, and word-timing mapping |
| `edge-client.js` | The connection: one reused WebSocket, requests one at a time, stall detection and retry, keeping it open between reads, warming it up early |
| `sentences.js` | Splitting text into sentences (abbreviations, very long sentences) for the page reader and VS Code |

Only the transport differs, and it's passed in to `EdgeClient`: the browser uses its `WebSocket`
(`browser/tts.js`), and VS Code uses a small WebSocket client on Node's `https`
(`vscode/engine.mjs`).

Rules for code that goes here: standard JavaScript modules only, no Node-only or browser-only APIs
(`TextDecoder`, `crypto.getRandomValues`, `Intl.Segmenter` and timers are fine in both).
