# shared

The voice engine used by both extensions. Edit the files here, never the copies in `browser/lib`.

| File | What it does |
|---|---|
| `constants.js` | Endpoint URLs, the Edge client version, and default settings |
| `drm.js` | The time-based `Sec-MS-GEC` request token (a port of edge-tts) |
| `ssml.js` | SSML building, protocol messages, and word-timing mapping |
| `edge-client.js` | The connection: one reused WebSocket, requests one at a time, stall detection and retry, keeping it open between reads, warming it up early |

- **VS Code** (`vscode/`) imports these directly. The `.vsix` packer bundles them.
- **Browser** (`browser/`): Brave can only load files inside the extension folder, so
  `browser/lib/` holds an exact copy. After editing here, run:

  ```bash
  node scripts/sync-shared.mjs
  ```

  `node scripts/sync-shared.mjs --check` fails if the copy is out of date. Every `.js` file in
  this folder is copied, so a new shared module is picked up automatically.

Only the transport differs, and it's passed in to `EdgeClient`: the browser uses its `WebSocket`
(`browser/lib/tts.js`), and VS Code uses a small WebSocket client on Node's `https`
(`vscode/engine.mjs`). Rules for code that goes here: standard JavaScript modules only, no Node or
browser-only APIs (`TextDecoder`, `crypto.getRandomValues` and timers are fine in both).
