# shared

The voice engine used by both extensions. Edit the files here, never the copies in `browser/lib`.

| File | What it does |
|---|---|
| `constants.js` | Endpoint URLs, the Edge client version, and default settings |
| `drm.js` | The time-based `Sec-MS-GEC` request token (a port of edge-tts) |
| `ssml.js` | SSML building, protocol messages, and word-timing mapping |

- **VS Code** (`vscode/`) imports these directly. The `.vsix` packer bundles them.
- **Browser** (`browser/`): Brave can only load files inside the extension folder, so
  `browser/lib/` holds an exact copy. After editing here, run:

  ```bash
  node scripts/sync-shared.mjs
  ```

  `node scripts/sync-shared.mjs --check` fails if the copy is out of date.

Each extension keeps its own transport: the browser uses `WebSocket`/`fetch` (`browser/lib/tts.js`),
and VS Code uses Node's `https` (`vscode/engine.mjs`).
