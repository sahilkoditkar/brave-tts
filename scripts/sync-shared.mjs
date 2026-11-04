// shared/ is the single source of truth for the voice engine (token, constants, SSML/protocol).
// Brave only loads files inside the extension folder, so browser/lib keeps an exact copy.
//
//   node scripts/sync-shared.mjs          copy shared/ -> browser/lib/
//   node scripts/sync-shared.mjs --check  fail if browser/lib/ is out of date (used by tests)

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const SHARED_FILES = ['constants.js', 'drm.js', 'ssml.js', 'package.json'];
const check = process.argv.includes('--check');

let stale = [];
for (const f of SHARED_FILES) {
  const src = fs.readFileSync(path.join(ROOT, 'shared', f));
  const destPath = path.join(ROOT, 'browser/lib', f);
  const dest = fs.existsSync(destPath) ? fs.readFileSync(destPath) : null;
  if (dest && src.equals(dest)) continue;
  if (check) stale.push(f);
  else fs.writeFileSync(destPath, src);
}
if (check && stale.length) {
  console.error(`browser/lib is out of date (${stale.join(', ')}). Run: node scripts/sync-shared.mjs`);
  process.exit(1);
}
console.log(check ? '✓ browser/lib matches shared/' : '✓ synced shared/ -> browser/lib/');
