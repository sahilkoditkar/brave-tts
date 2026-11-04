// Turns a document into "spoken text": a string the SAME LENGTH as the document,
// where anything that shouldn't be read is replaced by spaces and paragraph breaks
// are "\n". Because offsets line up 1:1, sentences map straight back to editor ranges.
//
//  - Markdown: prose only (no syntax, URLs, fenced code blocks, HTML)
//  - Plain text / docs: everything, with soft-wrapped lines joined
//  - Code: comments and docstrings only, skipping lines that look like commented-out code

const PROSE_LANGUAGES = new Set(['plaintext', 'restructuredtext', 'asciidoc', 'text', 'log']);
const MARKDOWN_LANGUAGES = new Set(['markdown', 'mdx', 'quarto', 'rmd']);

const SYNTAX = {
  c: { line: ['//'], block: [['/*', '*/']], strings: ['"', "'", '`'] },
  hash: { line: ['#'], block: [], strings: ['"', "'"] },
  python: { line: ['#'], block: [], strings: ['"', "'"], docstrings: true },
  dash: { line: ['--'], block: [['--[[', ']]'], ['{-', '-}'], ['/*', '*/']], strings: ['"', "'"] },
  html: { line: [], block: [['<!--', '-->']], strings: [] },
  semicolon: { line: [';'], block: [], strings: ['"'] },
  percent: { line: ['%'], block: [], strings: [] },
};
const LANGUAGE_SYNTAX = {
  python: 'python',
  shellscript: 'hash', ruby: 'hash', perl: 'hash', r: 'hash', yaml: 'hash', toml: 'hash', dockerfile: 'hash',
  makefile: 'hash', powershell: 'hash', coffeescript: 'hash', elixir: 'hash', julia: 'hash', nim: 'hash',
  ini: 'semicolon', properties: 'hash', cmake: 'hash', terraform: 'hash', graphql: 'hash',
  sql: 'dash', lua: 'dash', haskell: 'dash', ada: 'dash', elm: 'dash',
  html: 'html', xml: 'html', svg: 'html', vue: 'html', svelte: 'html',
  clojure: 'semicolon', lisp: 'semicolon', scheme: 'semicolon',
  latex: 'percent', tex: 'percent', matlab: 'percent', erlang: 'percent',
};

export function documentKind(languageId) {
  if (MARKDOWN_LANGUAGES.has(languageId)) return 'markdown';
  if (PROSE_LANGUAGES.has(languageId)) return 'prose';
  return 'code';
}

export function spokenText(text, languageId) {
  const kind = documentKind(languageId);
  if (kind === 'markdown') return markdownSpoken(text);
  if (kind === 'prose') return proseSpoken(text);
  return commentsSpoken(text, SYNTAX[LANGUAGE_SYNTAX[languageId] || 'c']);
}

// ---------------------------------------------------------------- helpers
function lines(text) {
  const out = [];
  let start = 0;
  for (let i = 0; i <= text.length; i++) {
    if (i === text.length || text[i] === '\n') {
      out.push({ start, end: i, text: text.slice(start, i) });
      start = i + 1;
    }
  }
  return out;
}

const blank = (chars, a, b) => { for (let i = a; i < b; i++) if (chars[i] !== '\n') chars[i] = ' '; };

// Join a line to the previous one with a space unless `breakBefore[lineIndex]`.
function applyLineBreaks(chars, ls, breakBefore) {
  for (let k = 1; k < ls.length; k++) {
    const nl = ls[k].start - 1;
    chars[nl] = breakBefore[k] ? '\n' : ' ';
  }
}

const isBlank = (s) => !/\S/.test(s);

// ---------------------------------------------------------------- markdown
function markdownSpoken(text) {
  const chars = text.replace(/\r/g, ' ').split('');
  const ls = lines(text);
  const breakBefore = new Array(ls.length).fill(false);
  let fence = null;
  let k0 = 0;

  // YAML front matter
  if (ls[0]?.text.trim() === '---') {
    const end = ls.findIndex((l, k) => k > 0 && /^(---|\.\.\.)\s*$/.test(l.text));
    if (end > 0) {
      for (let k = 0; k <= end; k++) { blank(chars, ls[k].start, ls[k].end); breakBefore[k] = true; }
      k0 = end + 1;
      breakBefore[k0] = true;
    }
  }

  for (let k = k0; k < ls.length; k++) {
    const { start, end, text: line } = ls[k];
    const fenceMatch = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
    if (fence) {
      blank(chars, start, end);
      breakBefore[k] = true;
      if (fenceMatch && fenceMatch[1][0] === fence[0] && fenceMatch[1].length >= fence.length) fence = null;
      continue;
    }
    if (fenceMatch) { fence = fenceMatch[1]; blank(chars, start, end); breakBefore[k] = true; continue; }
    if (isBlank(line)) { breakBefore[k] = true; continue; }
    if (/^ {4,}\S/.test(line) && (k === 0 || isBlank(ls[k - 1].text) || breakBefore[k])) {
      // indented code block
      blank(chars, start, end); breakBefore[k] = true; if (k + 1 < ls.length) breakBefore[k + 1] = true; continue;
    }
    if (/^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(line)) { blank(chars, start, end); breakBefore[k] = true; continue; }
    if (/^\s*<\/?[a-zA-Z][^>]*>\s*$/.test(line)) { blank(chars, start, end); breakBefore[k] = true; continue; }
    // setext underline (=== / ---) under a heading line
    if (/^\s{0,3}(=+|-+)\s*$/.test(line)) { blank(chars, start, end); breakBefore[k] = true; continue; }

    let body = start;
    let m;
    if ((m = /^\s{0,3}(#{1,6})(\s+|$)/.exec(line))) {
      body = start + m[0].length;
      blank(chars, start, body);
      // trailing #'s
      const t = /\s#+\s*$/.exec(line);
      if (t) blank(chars, start + t.index, end);
      breakBefore[k] = true;
      if (k + 1 < ls.length) breakBefore[k + 1] = true;
    } else if (line.includes('|') && /^\s*\|/.test(line)) {
      if (/^\s*\|?\s*:?-{2,}/.test(line)) { blank(chars, start, end); breakBefore[k] = true; continue; }
      for (let i = start; i < end; i++) if (text[i] === '|') chars[i] = ' ';
      breakBefore[k] = true;
      if (k + 1 < ls.length) breakBefore[k + 1] = true;
    } else {
      if ((m = /^(\s*>+\s?)+/.exec(line))) { blank(chars, start, start + m[0].length); body = start + m[0].length; }
      const rest = text.slice(body, end);
      if ((m = /^(\s*)([-*+]|\d{1,9}[.)])\s+(\[[ xX]\]\s+)?/.exec(rest))) {
        blank(chars, body, body + m[0].length);
        body += m[0].length;
        breakBefore[k] = true;
      }
    }
    inlineMarkdown(text, chars, body, end);
  }
  applyLineBreaks(chars, ls, breakBefore);
  return chars.join('');
}

function inlineMarkdown(text, chars, a, b) {
  const seg = text.slice(a, b);
  const blankRel = (i, j) => blank(chars, a + i, a + j);
  let m;
  // images: drop entirely
  for (const re = /!\[[^\]]*\]\([^)]*\)/g; (m = re.exec(seg));) blankRel(m.index, m.index + m[0].length);
  // links [text](url) / [text][ref]: keep text
  for (const re = /\[([^\]]*)\](\([^)]*\)|\[[^\]]*\])/g; (m = re.exec(seg));) {
    if (seg[m.index - 1] === '!') continue;
    blankRel(m.index, m.index + 1);
    blankRel(m.index + 1 + m[1].length, m.index + m[0].length);
  }
  // footnote refs, autolinks, bare URLs, inline HTML tags
  for (const re = /\[\^[^\]]+\]|<https?:[^>]+>|https?:\/\/\S+|<\/?[a-zA-Z][^>]*>/g; (m = re.exec(seg));) {
    blankRel(m.index, m.index + m[0].length);
  }
  // inline code: keep the words, drop the backticks
  for (const re = /`+/g; (m = re.exec(seg));) blankRel(m.index, m.index + m[0].length);
  // emphasis markers next to non-space
  for (const re = /(\*\*|__|~~|\*|_)(?=\S)|(?<=\S)(\*\*|__|~~|\*|_)/g; (m = re.exec(seg));) {
    blankRel(m.index, m.index + m[0].length);
  }
  // escapes like \* -> *
  for (const re = /\\(?=[\\`*_{}[\]()#+\-.!|])/g; (m = re.exec(seg));) blankRel(m.index, m.index + 1);
}

// ---------------------------------------------------------------- prose
function proseSpoken(text) {
  const chars = text.replace(/[\r\t\f\v]/g, ' ').split('');
  const ls = lines(text);
  const breakBefore = ls.map((l, k) => k > 0 && (isBlank(l.text) || isBlank(ls[k - 1].text)
    || /^\s*([-*•]|\d{1,3}[.)])\s/.test(l.text)));
  applyLineBreaks(chars, ls, breakBefore);
  return chars.join('');
}

// ---------------------------------------------------------------- code comments
function looksLikeCode(s) {
  const t = s.trim();
  if (!t) return false;
  if (/[;{}]$/.test(t)) return true;
  if (/^(import|export|const|let|var|def|class|function|fn|func|return|if|for|while|elif|else|try|catch|#include|using|package)\b.*[({=:]\s*$/.test(t)) return true;
  if (/^[\w$.]+(\[[^\]]*\])?\s*\(.*\)\s*;?$/.test(t) && !/\s/.test(t.replace(/\(.*\)/, ''))) return true; // foo.bar(x)
  if (/^[\w$.[\]]+\s*[+\-*/]?=\s*\S/.test(t) && !/\s\w+\s\w+\s\w+/.test(t)) return true; // x = 1
  if (/^<\/?\w+[^>]*>$/.test(t)) return true;
  return false;
}

function commentsSpoken(text, syntax) {
  const chars = new Array(text.length).fill(' ');
  for (let i = 0; i < text.length; i++) if (text[i] === '\n') chars[i] = '\n';
  const lineKind = []; // per line: 'comment' (comment-only line), 'mixed', or undefined
  const ls = lines(text);
  const lineOf = (pos) => {
    let lo = 0, hi = ls.length - 1;
    while (lo < hi) { const m = (lo + hi + 1) >> 1; if (ls[m].start <= pos) lo = m; else hi = m - 1; }
    return lo;
  };
  const codeBefore = (pos) => { const l = ls[lineOf(pos)]; return /\S/.test(text.slice(l.start, pos)); };
  const keep = (a, b, kind) => {
    // copy text [a,b) into spoken, per line, stripping leading "*" decoration and code-like lines
    let i = a;
    while (i < b) {
      let j = text.indexOf('\n', i);
      if (j === -1 || j > b) j = b;
      let s = i;
      const m = /^[ \t]*(\*+(?!\/)|\/\/+!?|#+|--+|;+|%+)?/.exec(text.slice(i, j));
      if (m) s = i + m[0].length;
      const content = text.slice(s, j);
      if (!looksLikeCode(content)) for (let x = s; x < j; x++) chars[x] = text[x] === '\t' || text[x] === '\r' ? ' ' : text[x];
      const k = lineOf(i);
      if (/\S/.test(content)) lineKind[k] = lineKind[k] || kind;
      i = j + 1;
    }
  };

  let i = 0;
  const startsWith = (tok) => text.startsWith(tok, i);
  while (i < text.length) {
    const ch = text[i];
    // shebang
    if (i === 0 && startsWith('#!')) { i = text.indexOf('\n'); if (i < 0) break; continue; }
    // python docstrings: triple-quoted strings that start a line
    if (syntax.docstrings && (startsWith('"""') || startsWith("'''"))) {
      const q = text.slice(i, i + 3);
      const close = text.indexOf(q, i + 3);
      const end = close === -1 ? text.length : close;
      if (!codeBefore(i)) keep(i + 3, end, 'comment');
      i = end + 3;
      continue;
    }
    const block = syntax.block.find(([open]) => startsWith(open));
    if (block) {
      const close = text.indexOf(block[1], i + block[0].length);
      const end = close === -1 ? text.length : close;
      let s = i + block[0].length;
      while (text[s] === '*' || text[s] === '!') s++; // /** and /*!
      keep(s, end, codeBefore(i) ? 'mixed' : 'comment');
      i = end + block[1].length;
      continue;
    }
    const lineTok = syntax.line.find((tok) => startsWith(tok));
    if (lineTok) {
      let end = text.indexOf('\n', i);
      if (end === -1) end = text.length;
      keep(i, end, codeBefore(i) ? 'mixed' : 'comment');
      i = end;
      continue;
    }
    if (syntax.strings.includes(ch)) {
      // skip string literal (single line unless template string)
      let j = i + 1;
      while (j < text.length && text[j] !== ch) {
        if (text[j] === '\\') j++;
        else if (text[j] === '\n' && ch !== '`') break;
        j++;
      }
      i = j + 1;
      continue;
    }
    i++;
  }

  // Join consecutive comment-only lines into paragraphs; break around everything else.
  for (let k = 1; k < ls.length; k++) {
    const nl = ls[k].start - 1;
    const join = lineKind[k - 1] === 'comment' && lineKind[k] === 'comment'
      && !/^\s*(\*|\/\/+|#+|--)?\s*([@-]|\d+[.)])/.test(ls[k].text);
    chars[nl] = join ? ' ' : '\n';
  }
  return chars.join('');
}

// ---------------------------------------------------------------- sentences
const MAX_SENTENCE = 600;
const ABBREVIATION_END = /(?:\b(?:Mr|Mrs|Ms|Mx|Dr|Prof|Sr|Jr|St|Mt|Gen|Col|Lt|Sgt|Capt|Rev|Hon|vs|approx|Fig|No|e\.g|i\.e|etc)|(?:^|\s)\p{Lu})\.$/u;

// -> [{ start, text }] with offsets into `spoken` (== document offsets), for the paragraphs that
// overlap [from, to) (segmenting is the slow part, so the rest of a long document is skipped).
function sentencesOf(spoken, lang, from = 0, to = spoken.length) {
  let segmenter;
  try { segmenter = new Intl.Segmenter(lang, { granularity: 'sentence' }); } catch { segmenter = new Intl.Segmenter('en', { granularity: 'sentence' }); }
  const out = [];
  const push = (start, text) => {
    const lead = text.length - text.trimStart().length;
    text = text.trim();
    start += lead;
    if (!/[\p{L}\p{N}]/u.test(text)) return;
    while (text.length > MAX_SENTENCE) {
      const win = text.slice(0, MAX_SENTENCE);
      let cut = Math.max(win.lastIndexOf(', '), win.lastIndexOf('; '), win.lastIndexOf(': '));
      if (cut < MAX_SENTENCE / 3) cut = win.lastIndexOf(' ');
      if (cut < 1) cut = MAX_SENTENCE - 1;
      out.push({ start, text: text.slice(0, cut + 1).trim() });
      const rest = text.slice(cut + 1);
      start += cut + 1 + (rest.length - rest.trimStart().length);
      text = rest.trim();
    }
    if (text) out.push({ start, text });
  };
  const a = from > 0 ? spoken.lastIndexOf('\n', from - 1) + 1 : 0;
  let b = spoken.indexOf('\n', Math.max(to, a));
  if (b === -1) b = spoken.length;
  let pos = a;
  for (const para of spoken.slice(a, b).split('\n')) {
    if (!/\S/.test(para)) { pos += para.length + 1; continue; } // blank (or skipped code)
    let pendStart = -1;
    let pendEnd = 0;
    for (const { segment, index } of segmenter.segment(para)) {
      if (pendStart >= 0 && ABBREVIATION_END.test(para.slice(pendStart, pendEnd).trimEnd())) {
        pendEnd = index + segment.length;
        continue;
      }
      if (pendStart >= 0) push(pos + pendStart, para.slice(pendStart, pendEnd));
      pendStart = index;
      pendEnd = index + segment.length;
    }
    if (pendStart >= 0) push(pos + pendStart, para.slice(pendStart, pendEnd));
    pos += para.length + 1;
  }
  return out;
}

// -> [{ start, text, speak }] with offsets into `spoken` (== document offsets)
export function splitSentences(spoken, lang = 'en') {
  // Text inside one sentence may span skipped regions (spaces) — collapse for speech.
  return sentencesOf(spoken, lang).map((s) => ({ ...s, speak: s.text.replace(/\s+/g, ' ') }));
}

// Sentences to read from `from` (cursor, starting at the word under it) up to `to`.
export function sentencesInRange(spoken, from, to = spoken.length, lang = 'en') {
  const all = sentencesOf(spoken, lang, from, to);
  const out = [];
  for (const s of all) {
    const sEnd = s.start + s.text.length;
    if (sEnd <= from || s.start >= to) continue;
    let a = s.start;
    let b = sEnd;
    if (from > a) {
      a = from;
      while (a > s.start && !/\s/.test(spoken[a - 1])) a--; // back to word start
    }
    if (to < b) {
      b = to;
      while (b < sEnd && !/\s/.test(spoken[b])) b++; // forward to word end
    }
    const text = spoken.slice(a, b);
    const lead = text.length - text.trimStart().length;
    const trimmed = text.trim();
    if (!/[\p{L}\p{N}]/u.test(trimmed)) continue;
    out.push({ start: a + lead, text: trimmed, speak: trimmed.replace(/\s+/g, ' ') });
  }
  return out;
}

// "Short" selections (a word or a few) mean "read from here", like right-click in the browser.
export function isShortSelection(text) {
  const t = text.trim();
  return t.length > 0 && t.length <= 60 && !t.includes('\n') && t.split(/\s+/).length <= 3;
}

// Last occurrence of `needle` in `spoken`, ignoring whitespace differences (rendered text vs
// source) and, as a fallback, case. Returns an offset into `spoken`, or -1.
export function findSpoken(spoken, needle) {
  const n = needle.replace(/\s+/g, ' ').trim();
  if (!n) return -1;
  const lead = spoken.length - spoken.trimStart().length;
  const collapsed = spoken.slice(lead).replace(/\s+/g, ' ');
  let k = collapsed.lastIndexOf(n);
  if (k < 0) k = collapsed.toLowerCase().lastIndexOf(n.toLowerCase());
  if (k < 0) return -1;
  // Map offset k in `collapsed` back to `spoken`: each whitespace run became one space.
  let i = lead; // position in spoken
  let c = 0; // matching position in collapsed
  const ws = /\s+/g;
  ws.lastIndex = lead;
  for (let m; (m = ws.exec(spoken));) {
    if (c + (m.index - i) > k) break;
    c += m.index - i;
    if (c === k) return m.index;
    c += 1;
    i = m.index + m[0].length;
  }
  return i + (k - c);
}

// Cheap pre-check before rendering a whole Markdown message to spoken text: could `needle`
// (copied from the rendered reply) be in `markdown`? Checks its longest word.
export function mightContain(markdown, needle) {
  const words = needle.match(/[\p{L}\p{N}]+/gu);
  if (!words) return true;
  const longest = words.reduce((x, y) => (y.length > x.length ? y : x));
  return markdown.toLowerCase().includes(longest.toLowerCase());
}

// The OS audio player needs a complete file, so the first sound waits for the whole first
// sentence to be synthesized. Split a long first sentence at a natural pause to start sooner.
export function quickStart(sentences, max = 120) {
  const first = sentences[0];
  if (!first || first.text.length <= max) return sentences;
  const head = first.text.slice(0, max);
  let cut = Math.max(head.lastIndexOf(', '), head.lastIndexOf('; '), head.lastIndexOf(': '), head.lastIndexOf(' – '), head.lastIndexOf(' — '));
  if (cut < 30) cut = head.lastIndexOf(' ');
  if (cut < 30) return sentences;
  const a = first.text.slice(0, cut + 1).trim();
  const restRaw = first.text.slice(cut + 1);
  const b = restRaw.trim();
  const bStart = first.start + cut + 1 + (restRaw.length - restRaw.trimStart().length);
  const speak = (t) => t.replace(/\s+/g, ' ');
  return [{ start: first.start, text: a, speak: speak(a) }, { start: bStart, text: b, speak: speak(b) }, ...sentences.slice(1)];
}
