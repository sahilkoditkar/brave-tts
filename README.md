# brave-tts

> **Personal project — not for use or distribution.**
> I built this for myself and published it only to show how it works. It isn't supported and isn't
> on any extension store. It relies on an **undocumented** service that can change or disappear at any
> time, and **it will break** when that happens. Please don't use, fork, or redistribute it.
> All rights reserved — no license is granted.

## Why

I moved from Edge to Brave for everything else, but I missed one Edge feature: **Read Aloud**. Its
natural neural voices are far better than the robotic system voices other browsers use. Switching
browsers for one feature didn't make sense, so I rebuilt the feature as a small Brave/Chromium
extension.

## What it does

- Reads the current page (main article content, skipping nav, sidebars, footers, and hidden text),
  or just the selected text
- Highlights the sentence being read, and the current **word** in real time
- Floating player bar: play/pause, previous/next sentence, voice picker, speed control
- "Read from here": click in the text, then press the shortcut (Ctrl+Shift+U). Alt+click any
  sentence while reading to jump to it
- Popup with language and voice picker, voice preview, speed, pitch, and highlight/scroll options

![Player bar](docs/player.png)

## How it works

```
page (content.js)            background.js               offscreen.html (offscreen.js)
─────────────────            ─────────────               ─────────────────────────────
extract text → sentences ──▶ routes messages,      ──▶  WebSocket per sentence → MP3 + word timings
CSS Custom Highlight API ◀── relays player events  ◀──  plays audio, prefetches next 3 sentences,
floating player (shadow DOM) context menu, shortcut      reports sentence/word progress
```

A few problems were more interesting than they first looked:

- **Speaking like Edge.** The voice service expects Edge's own client. The extension uses
  `declarativeNetRequest` to set the WebSocket handshake headers (Origin, User-Agent) that browser
  JavaScript isn't normally allowed to set. It also generates the time-based request token the
  service requires (`lib/drm.js`). That's a port of the open-source
  [edge-tts](https://github.com/rany2/edge-tts) project's implementation, checked against its output
  (`tests/token.test.mjs`).
- **Mapping audio back to the page.** Text is pulled from DOM text nodes into a flat string, with a
  1:1 offset map back to the nodes. Sentences come from `Intl.Segmenter`, with a fix-up so "Dr." or
  "J." don't end a sentence. Word-boundary events from the service become character offsets, then DOM
  `Range`s, highlighted with the CSS Custom Highlight API. The page's DOM is never modified.
- **Working on any site.** Styles are injected through extension APIs and constructable stylesheets
  (no inline styles), and UI is built with DOM APIs (no `innerHTML`). That keeps it working on pages
  with strict Content-Security-Policy or Trusted Types.
- **Manifest V3 lifetimes.** Audio lives in an offscreen document, which Chrome closes when idle. The
  page keeps the reading position, so resume rebuilds the player if it was closed.
- **Testable without the real service.** `tests/e2e` runs a fake speech server locally (TLS +
  hand-rolled WebSocket framing). Chromium is pointed at it with `--host-resolver-rules`, so the
  whole pipeline gets exercised end to end: header rewriting, token, protocol, playback,
  highlighting, selection mode, speed changes, and jumping.

## When it breaks

The free endpoint is unofficial, so expect breakage. The usual fix is to bump the version constants
in `lib/constants.js` and/or port the latest token change into `lib/drm.js` from a newer edge-tts
release.

There's also an official fallback built in: popup → **Voice source** → *My Azure Speech key*. Azure
Speech has a free tier with the same neural voices. Word highlighting isn't available there, because
the REST API doesn't return word timings.

## Running it locally (for myself)

1. `brave://extensions` → enable **Developer mode** → **Load unpacked** → select this folder.
2. Open an article and press **Ctrl+Shift+U** (change it at `brave://extensions/shortcuts`), or use
   the toolbar popup, or right-click → *Read aloud this page / selection*.

It can't run on browser pages (`brave://…`), the extension store, or the built-in PDF viewer.

Tests: `node tests/token.test.mjs` and `node tests/e2e/run.js` (needs Playwright, openssl, ffmpeg,
and port 443).
