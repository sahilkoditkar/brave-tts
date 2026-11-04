// shared/ is the single source of truth for the voice engine (token, constants, SSML, protocol client).
// Brave only loads files inside the extension folder, so browser/lib keeps an exact copy.
//
//   node scripts/sync-shared.mjs          copy shared/ -> browser/lib/
//   node scripts/sync-shared.mjs --check  fail if browser/lib/ is out of date (used by tests)
//
// Every .js file directly in shared/ is copied (plus package.json), so a new shared module can't be
// forgotten. browser/lib/ may also hold browser-only files (tts.js); those are left alone.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SHARED = path.join(ROOT, 'shared');
const DEST = path.join(ROOT, 'browser/lib');
export const SHARED_FILES = fs.readdirSync(SHARED, { withFileTypes: true })
  .filter((e) => e.isFile() && (e.name.endsWith('.js') || e.name === 'package.json'))
  .map((e) => e.name)
  .sort();
const check = process.argv.includes('--check');

const stale = [];
for (const f of SHARED_FILES) {
  const src = fs.readFileSync(path.join(SHARED, f));
  const destPath = path.join(DEST, f);
  const dest = fs.existsSync(destPath) ? fs.readFileSync(destPath) : null;
  if (dest && src.equals(dest)) continue;
  if (check) stale.push(f);
  else fs.writeFileSync(destPath, src);
}
if (check && stale.length) {
  console.error(`browser/lib is out of date (${stale.join(', ')}). Run: node scripts/sync-shared.mjs`);
  process.exit(1);
}
console.log(check ? `✓ browser/lib matches shared/ (${SHARED_FILES.length} files)` : `✓ synced shared/ -> browser/lib/ (${SHARED_FILES.length} files)`);
