// Run: node vscode/tests/text.test.mjs
import assert from 'node:assert/strict';
import { spokenText, splitSentences, sentencesInRange, quickStart } from '../text.mjs';

const speak = (src, lang) => {
  const spoken = spokenText(src, lang);
  assert.equal(spoken.length, src.length, 'spoken text keeps document offsets');
  return splitSentences(spoken).map((s) => s.speak);
};

// ---- Markdown
const md = `---
title: Notes
---
# Getting **started**

This tool reads your *notes* aloud. It skips [links](https://example.com) but
keeps their text, and joins soft-wrapped lines.

- First \`item\` here
- Second item, see https://example.com/x

\`\`\`js
const secret = "never read code blocks";
\`\`\`

| Name | Value |
|------|-------|
| Speed | Fast |

![diagram](img.png)
> Quoted wisdom ends here.
`;
assert.deepEqual(speak(md, 'markdown'), [
  'Getting started',
  'This tool reads your notes aloud.',
  'It skips links but keeps their text, and joins soft-wrapped lines.',
  'First item here',
  'Second item, see',
  'Name Value',
  'Speed Fast',
  'Quoted wisdom ends here.',
]);

// ---- JavaScript: comments only
const js = `#!/usr/bin/env node
// Parse the config file and return defaults.
// Missing keys fall back to sensible values.
import fs from 'node:fs';
const url = "http://not-a-comment"; // trailing note
/**
 * Loads a user by id.
 * @param id the user id
 */
function load(id) {
  // return cache.get(id);
  return db.find(id); /* inline block */
}
`;
assert.deepEqual(speak(js, 'javascript'), [
  'Parse the config file and return defaults.',
  'Missing keys fall back to sensible values.',
  'trailing note',
  'Loads a user by id.',
  '@param id the user id',
  'inline block',
]);

// ---- Python: comments + docstrings, not strings
const py = `def area(r):
    """Compute the area of a circle.

    Uses pi from the math module.
    """
    s = """not a docstring"""
    # Square the radius first.
    return math.pi * r ** 2  # tiny
`;
assert.deepEqual(speak(py, 'python'), [
  'Compute the area of a circle.',
  'Uses pi from the math module.',
  'Square the radius first.',
  'tiny',
]);

// ---- start from cursor (mid-word) and selection
const prose = 'The first sentence is here. The second one follows after it.';
const sp = spokenText(prose, 'plaintext');
const fromCursor = sentencesInRange(sp, prose.indexOf('cond'));
assert.deepEqual(fromCursor.map((s) => s.text), ['second one follows after it.']);
assert.equal(fromCursor[0].start, prose.indexOf('second'));
const sel = sentencesInRange(sp, prose.indexOf('sentence'), prose.indexOf('second') + 3);
assert.deepEqual(sel.map((s) => s.text), ['sentence is here.', 'The second']);

// ---- long first sentence is split for a fast start; offsets still map back
const longText = 'When you open a long document and start reading from the top, the first sentence is often quite long, which delays the first sound. Next one.';
const qs = quickStart(sentencesInRange(spokenText(longText, 'plaintext'), 0));
assert.equal(qs.length, 3);
assert.ok(qs[0].text.length <= 120 && qs[0].text.endsWith(','));
for (const q of qs) assert.equal(longText.slice(q.start, q.start + q.text.length), q.text);
// ...or the sentence reading starts at (browser: "read from here", caret), leaving the others alone
const two = sentencesInRange(spokenText(`Short one. ${longText}`, 'plaintext'), 0);
const qs2 = quickStart(two, 120, 1);
assert.equal(qs2.length, 4);
assert.equal(qs2[0], two[0]);
assert.ok(qs2[1].text.endsWith(',') && qs2[2].text.startsWith('which'));
assert.equal(quickStart(two, 120, 5), two, 'no such sentence: unchanged');

console.log('✓ text extraction tests passed');
