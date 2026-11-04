# Read Aloud Anywhere (personal)

> **Personal project — not for use or distribution.**
> I built this for myself and published it only to show how it works. It isn't supported and isn't
> on any extension store. It relies on an **undocumented** service that can change or disappear at any
> time, and **it will break** when that happens. Please don't use, fork, or redistribute it.
> All rights reserved — no license is granted.

## Why

I moved from Edge to Brave for everything else, but I missed one Edge feature: **Read Aloud**. Its
natural neural voices are far better than the robotic system voices other browsers use. Switching
browsers for one feature didn't make sense, so I rebuilt the feature as a small extension. Then I
brought the same voices into VS Code for reading docs.

| Folder | What it is |
|---|---|
| [`browser/`](browser) | Brave/Chromium extension: reads web pages with sentence and word highlighting |
| [`vscode/`](vscode) | VS Code extension: reads Markdown/docs, only the comments in code, and Claude Code replies |
| [`shared/`](shared) | The voice engine both use: request token, constants, SSML/protocol |

`shared/` is the single source of truth. Brave can only load files inside the extension folder, so
`browser/lib/` holds an exact copy. `node scripts/sync-shared.mjs` refreshes it, and `--check` fails
if it's stale.

## Browser extension

- Reads the main article on a page (skipping nav, sidebars, footers and hidden text), or just the
  selected text
- Highlights the sentence being read, and the current **word** in real time
- Floating player bar: play/pause, previous/next sentence, voice picker, speed
- **Right-click → "Read aloud from here"** starts at that word and reads on through the page
- **Ctrl+Shift+U** (⇧⌘U on Mac) to start, pause or resume. Alt/Option+click a sentence while
  reading to jump to it
- Popup with language and voice picker, voice preview, speed, pitch, and highlight/scroll options

![Player bar](docs/player.png)

```
page (content.js)            background.js               offscreen.html (offscreen.js)
─────────────────            ─────────────               ─────────────────────────────
extract text → sentences ──▶ routes messages,      ──▶  WebSocket per sentence → MP3 + word timings
CSS Custom Highlight API ◀── relays player events  ◀──  plays audio, prefetches next 3 sentences,
floating player (shadow DOM) context menu, shortcut      reports sentence/word progress
```

## VS Code extension

- **Markdown / plain text:** reads the prose. It skips syntax, URLs, images, HTML and fenced code.
- **Code:** reads **only comments and docstrings**, and skips lines that look like commented-out
  code.
- **Claude Code replies:** reads the latest reply of the session you're looking at (⌘⌥U), reads
  from a word you select or right-click in the Claude panel, or auto-reads each reply when it
  finishes. Tool calls, thinking and code are
  skipped. Replies come from Claude Code's local session files (read-only), since its chat panel
  can't be read by other extensions.
- Right-click → **Read Aloud from Here** (or **Read Aloud Selection**), ⌘⌥R to start or pause,
  and the sentence and word are highlighted in the editor.
- No npm dependencies at all. It uses a hand-written WebSocket client on Node's `https`, the OS
  audio player (`afplay` on macOS), and a dependency-free `.vsix` packer.

## Interesting problems

- **Speaking like Edge.** The voice service expects Edge's own client. In the browser,
  `declarativeNetRequest` sets the WebSocket handshake headers (Origin, User-Agent) that browser
  JavaScript isn't normally allowed to set. In VS Code, the hand-rolled WebSocket client sets them
  directly. Both generate the time-based request token the service requires (`shared/drm.js`).
  That's a port of the open-source [edge-tts](https://github.com/rany2/edge-tts) project's
  implementation, checked against its output.
- **Mapping audio back to text.** In the browser, text from DOM text nodes goes into a flat string
  with a 1:1 offset map back to the nodes. In VS Code, the document becomes "spoken text" of the
  *same length*, with skipped syntax and code blanked out, so offsets map straight back to editor
  ranges. Word-boundary events from the service become ranges, highlighted live.
- **Working on any site.** Styles come from extension APIs and constructable stylesheets (no inline
  styles), and UI is built with DOM APIs (no `innerHTML`). That keeps it working on pages with strict
  Content-Security-Policy or Trusted Types.
- **No stalls between sentences.** Both extensions keep **one** connection open and request
  sentences one at a time over it, the way Edge does, while the current one plays. A stalled
  request is abandoned after 5 s and retried on a fresh connection. (Opening a connection per
  sentence, several at once, made the service stall.)
- **Fast start.** The browser streams audio into a `MediaSource` as it arrives, so speech starts
  with the first chunk rather than after the whole sentence. The audio player is also warmed up while
  the page script loads. In VS Code, where the OS player needs whole files, a long first sentence is
  split at a natural pause.
- **Testable without the real service.** A local fake speech server (TLS + hand-rolled WebSocket
  framing) runs end-to-end tests for both extensions. That covers header rewriting, the token, the
  protocol, playback, highlighting, selection, speed changes, and jumping.

## Security & privacy

Extensions are a common attack route, so this one is kept deliberately small:

- **Minimal browser permissions.** It uses `activeTab`, so it can only touch the tab you invoke it
  on, at that moment. There's no "read all sites" access and no always-on script; "Read aloud from
  here" uses the word your right-click selects. Network access is limited to the voice service's
  domains.
- **No remote code, no tracking.** All code ships in the folder: no `eval`, no external scripts, no
  analytics.
- **Web pages can't control it.** There's no `externally_connectable`. Page text is XML-escaped
  before going into SSML, and the player UI never uses `innerHTML`.
- **No silent updates.** It's loaded from a local folder, not a store, so nobody can push an update
  to it. Updating means reviewing and pulling a change yourself.
- **No dependencies.** The extensions have no npm packages, so there's no supply chain to compromise.
  (Tests use Playwright, which is dev-only.)
- **What leaves your machine:** the text being read goes to Microsoft's speech service, the same as
  Edge's Read Aloud. That includes Claude Code replies when you read them aloud, so don't use it on
  confidential content. Claude Code session files are only read locally, never uploaded or
  modified. An Azure key (optional) stays in the
  browser's local extension storage, or in VS Code's encrypted secret storage.

## When it breaks

The free endpoint is unofficial, so expect breakage. The usual fix is to bump the version constants
in `shared/constants.js` and/or port the latest token change into `shared/drm.js` from a newer
edge-tts release, then run `node scripts/sync-shared.mjs`. That fixes both extensions.

There's an official fallback built into both: switch the voice source to *Azure Speech key*. Azure
Speech has a free tier with the same neural voices. Word highlighting isn't available there.

## Running it locally (for myself)

**Browser:** `brave://extensions` → **Developer mode** → **Load unpacked** → select the `browser`
folder. It can't run on `brave://` pages, the extension store, or the built-in PDF viewer.

**VS Code:** `node vscode/scripts/pack-vsix.mjs`, then in VS Code go to **Extensions** → **⋯** →
**Install from VSIX…** → `vscode/dist/read-aloud-<version>.vsix`.

**Tests:**

```bash
node scripts/sync-shared.mjs --check
node shared/tests/token.test.mjs
node vscode/tests/text.test.mjs
node vscode/tests/claude.test.mjs
node browser/tests/e2e/run.js         # needs Playwright, openssl, ffmpeg, port 443
node vscode/tests/extension.test.cjs  # needs openssl, ffmpeg, port 443
```
