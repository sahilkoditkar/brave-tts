# Read Aloud Anywhere — VS Code (personal)

> Personal project — not for use or distribution. Relies on an undocumented service and
> will break when it changes. All rights reserved.

Reads text aloud in the editor with natural neural voices, highlighting the sentence and the word
being spoken.

- **Markdown / plain text:** reads the prose. It skips Markdown syntax, URLs, images, HTML and
  fenced code blocks.
- **Code files:** reads **only comments and docstrings**, never the code itself. It also skips
  comment lines that look like commented-out code.
- **Claude Code replies:** reads the replies from your Claude Code sessions, skipping tool calls.

## Use

**Controls:** everything is in the status bar, bottom-right.
- Idle: a **🔈 Read Aloud** button opens a menu with every action: read, Claude replies,
  auto-read on/off, speed, voice and settings.
- While reading it becomes **‹ ⏸ title 3/12 › 1.25× ✕**:
  - **‹ / ›**: previous / next sentence
  - **⏸**: pause / resume
  - **1.25×**: click to change speed (or **⌘⌥=** / **⌘⌥-** to nudge it)
  - **✕**: stop
- Markdown files also get a 🔈 button in the editor's top-right corner.

**In any editor file:**
- Right-click and choose **Read Aloud from Here**: it starts at the word under the cursor.
- Or double-click a word and press **⌘⌥R** (Ctrl+Alt+R on Windows/Linux) to read from there.
- Select a longer passage and press ⌘⌥R to read just that passage.

**Claude Code replies:**
- **⌘⌥U**: read the last reply of **the session you're looking at**:
  1. The Claude Code tab in front, matched by its title.
  2. If no Claude tab is in front, the most recently active session in this workspace.
  3. Otherwise, the most recently active session anywhere.

  The status bar says which session it picked.
- **Read Aloud: Read Reply from a Claude Code Session…** (also in the menu): pick any session from a
  list.
- **In the Claude Code panel**, like the browser:
  - Right-click a word → **Read Aloud from Here** (on a Mac, right-click selects the word), or
    select a word and press **⌘⌥R**: reads from that word to the end of the reply.
  - Select a longer passage → right-click → **Read Aloud from Here** (or ⌘⌥R): reads just that
    passage, still skipping any code inside it.
  - Nothing selected: ⌘⌥R reads the session's last reply.
  - If that ever reads the whole last reply instead of your selection, press **⌘C** first, then
    **⌘⌥R**. The copied text is used, but only if it really appears in a Claude reply. Details of
    what happened go to **View → Output → Read Aloud**.
- **Auto-read** (menu, or **Read Aloud: Toggle Auto-Read Claude Code Replies**): speaks a reply as
  soon as Claude finishes it. By default only for the session you're looking at (setting
  `readAloud.claude.autoReadSessions`: `focused` or `all`).
- Only Claude's text is read, never tool calls, tool output, thinking or code blocks. By default
  only the final message of each turn is read; turn on `readAloud.claude.includeProgressUpdates` to
  also hear the short updates between tool calls.

How it works: Claude Code's chat panel is another extension's sandboxed view, so it can't be read
directly. Instead, replies are read (read-only) from the session files Claude Code saves in
`~/.claude/projects`. A selection in the panel is picked up by copying it, and your clipboard text
is restored right after.

Audio plays through the OS player: `afplay` on macOS and Windows Media on Windows (both built in),
or ffplay/mpg123/mpv on Linux. Editing a file while it's being read stops the reading, so
highlights never drift.

> **Privacy:** reading a Claude reply sends that text to Microsoft's speech service. Don't use it on
> confidential work output if your company doesn't allow that.

## Troubleshooting

- **"Timed out connecting" / "stopped responding":** run **Read Aloud: Test Connection** (also in
  the menu). It checks name lookup, normal HTTPS, and the speech connection, then tells you which
  step failed. The details go to **View → Output → Read Aloud**.
- **Company network or proxy:** Brave uses the Mac's proxy automatically; VS Code may need it set.
  Set VS Code's `http.proxy` setting (e.g. `http://proxy.company.com:8080`), or the `HTTPS_PROXY`
  environment variable. If normal HTTPS works but speech doesn't, the network probably blocks
  WebSockets. Use the Azure voice source, or another network.

## Install

Download `read-aloud-vscode-<version>.vsix` from the repo's latest release (built by GitHub
Actions), then in VS Code open **Extensions** → **⋯** → **Install from VSIX…**

It has no runtime dependencies. The token, protocol client and sentence splitting come from
`../shared` (shared with the browser extension), bundled into one `extension.js` at build time.
