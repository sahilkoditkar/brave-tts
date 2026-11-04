# Read Aloud for VS Code (personal)

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

**In any editor file:**
- Right-click and choose **Read Aloud from Here**: it starts at the word under the cursor.
- Or double-click a word and press **⌘⌥R** (Ctrl+Alt+R on Windows/Linux) to read from there.
- Select a longer passage and press ⌘⌥R to read just that passage.
- While reading, ⌘⌥R pauses and resumes, **Ctrl+Alt+→ / ←** jumps between sentences, and **✕** in
  the status bar stops.

**Claude Code replies:**
- **⌘⌥U**: read the latest Claude Code reply.
- In the Claude Code panel, select a word and press **⌘⌥R** to read from that word to the end of the
  reply. Select a longer passage to read just that. With nothing selected, ⌘⌥R reads the latest
  reply.
- **Read Aloud: Toggle Auto-Read Claude Code Replies**: speak each reply as soon as Claude finishes
  it.
- Only Claude's text is read, never tool calls, tool output, thinking or code blocks. By default
  only the final message of each turn is read; turn on `readAloud.claude.includeProgressUpdates` to
  also hear the short updates between tool calls.

How it works: Claude Code's chat panel is another extension's sandboxed view, so it can't be read
directly. Instead, replies are read (read-only) from the session files Claude Code saves in
`~/.claude/projects`. A selection in the panel is picked up by copying it, and your clipboard text
is restored right after.

**Settings:** Command Palette → **Read Aloud: Choose Voice** / **Set Speed**, or search "Read Aloud"
in Settings.

Audio plays through the OS player: `afplay` on macOS and Windows Media on Windows (both built in),
or ffplay/mpg123/mpv on Linux. Editing a file while it's being read stops the reading, so
highlights never drift.

> **Privacy:** reading a Claude reply sends that text to Microsoft's speech service. Don't use it on
> confidential work output if your company doesn't allow that.

## Install

From the repo root:

```bash
node vscode/scripts/pack-vsix.mjs
```

Then in VS Code, open **Extensions** → **⋯** → **Install from VSIX…** → pick
`vscode/dist/read-aloud-<version>.vsix`.

It has no npm dependencies. The token, voices and protocol code are shared with the browser
extension in `../browser/lib`.
