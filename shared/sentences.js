// Sentence splitting, shared by both extensions: the browser (page text) and VS Code (documents,
// Claude Code replies). Input is one string where "\n" separates paragraphs; sentences never
// cross a paragraph. Offsets in the result index into that string, so they map back to the
// page or the editor.
//
// Uses the built-in Intl.Segmenter, then glues back splits after abbreviations ("Dr.", "J."),
// skips text with no letters or digits, and splits very long sentences at a natural pause.

const MAX_SENTENCE = 600;
const ABBREVIATION_END = /(?:\b(?:Mr|Mrs|Ms|Mx|Dr|Prof|Sr|Jr|St|Mt|Gen|Col|Lt|Sgt|Capt|Rev|Hon|vs|approx|Fig|No|e\.g|i\.e|etc)|(?:^|\s)\p{Lu})\.$/u;

// -> [{ start, text }] with offsets into `spoken`, for the paragraphs that overlap [from, to)
// (segmenting is the slow part, so the rest of a long document is skipped).
export function sentencesOf(spoken, lang = 'en', from = 0, to = spoken.length) {
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
