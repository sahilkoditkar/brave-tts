// Builds both extensions from source into dist/ (GitHub Actions runs this for every release):
//
//   dist/read-aloud-browser-<version>.zip   unzip, then brave://extensions → Load unpacked
//   dist/read-aloud-vscode-<version>.vsix   VS Code → Extensions → ⋯ → Install from VSIX…
//
// esbuild bundles each entry point with the shared/ modules it imports, so there are no copies
// of shared/ anywhere. The output is not minified, so what gets installed stays readable.
//
// Usage: npm ci --ignore-scripts && npm run build      (Node 18+)
//        node scripts/build.mjs --browser <dir>        browser extension only, unpacked (tests)

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';
import { zip } from './zip.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BROWSER = path.join(ROOT, 'browser');
const VSCODE = path.join(ROOT, 'vscode');
const DIST = path.join(ROOT, 'dist');
const readJson = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));

const common = { bundle: true, charset: 'utf8', legalComments: 'none', logLevel: 'warning' };

// -> the unpacked browser extension in outDir
export async function buildBrowser(outDir) {
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });
  const target = `chrome${readJson(path.join(BROWSER, 'manifest.json')).minimum_chrome_version}`;
  // Extension pages and the service worker load ES modules...
  await esbuild.build({
    ...common, target, format: 'esm', outdir: outDir,
    entryPoints: ['background.js', 'offscreen.js', 'popup.js'].map((f) => path.join(BROWSER, f)),
  });
  // ...but the page script is injected as a classic script.
  await esbuild.build({ ...common, target, format: 'iife', outfile: path.join(outDir, 'content.js'), entryPoints: [path.join(BROWSER, 'content.js')] });
  for (const f of ['manifest.json', 'popup.html', 'popup.css', 'offscreen.html', 'content.css', 'icons']) {
    fs.cpSync(path.join(BROWSER, f), path.join(outDir, f), { recursive: true });
  }
  return outDir;
}

// Every file under dir -> Map<prefix/relative path, Buffer>
function filesIn(dir, prefix) {
  const files = new Map();
  for (const rel of fs.readdirSync(dir, { recursive: true })) {
    const full = path.join(dir, rel);
    if (fs.statSync(full).isFile()) files.set(`${prefix}/${rel.split(path.sep).join('/')}`, fs.readFileSync(full));
  }
  return files;
}

async function packBrowser() {
  const { version } = readJson(path.join(BROWSER, 'manifest.json'));
  const name = `read-aloud-browser-${version}`;
  const dir = await buildBrowser(path.join(DIST, 'browser'));
  const out = path.join(DIST, `${name}.zip`);
  // Unzips into "read-aloud-browser/" (no version in it): Brave keys an unpacked extension by its
  // folder, so unzipping each update over the same folder keeps it the same extension.
  fs.writeFileSync(out, zip(filesIn(dir, 'read-aloud-browser')));
  return out;
}

const xmlEscape = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

async function packVscode() {
  const pkg = readJson(path.join(VSCODE, 'package.json'));
  // One file: extension.js with engine, text, player, claude and shared/ inside it.
  const bundle = path.join(DIST, 'vscode', 'extension.js');
  await esbuild.build({
    ...common, platform: 'node', target: 'node18', format: 'cjs', outfile: bundle,
    entryPoints: [path.join(VSCODE, 'extension.js')], external: ['vscode'],
  });
  const files = new Map();
  files.set('extension/package.json', Buffer.from(JSON.stringify({ ...pkg, main: './extension.js', icon: 'icon.png' }, null, 2)));
  files.set('extension/extension.js', fs.readFileSync(bundle));
  files.set('extension/readme.md', fs.readFileSync(path.join(VSCODE, 'README.md')));
  files.set('extension/icon.png', fs.readFileSync(path.join(BROWSER, 'icons/icon128.png')));
  files.set('extension.vsixmanifest', Buffer.from(`<?xml version="1.0" encoding="utf-8"?>
<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011" xmlns:d="http://schemas.microsoft.com/developer/vsx-schema-design/2011">
  <Metadata>
    <Identity Language="en-US" Id="${xmlEscape(pkg.name)}" Version="${xmlEscape(pkg.version)}" Publisher="${xmlEscape(pkg.publisher)}" />
    <DisplayName>${xmlEscape(pkg.displayName)}</DisplayName>
    <Description xml:space="preserve">${xmlEscape(pkg.description)}</Description>
    <Tags></Tags>
    <Categories>Other</Categories>
    <GalleryFlags>Public</GalleryFlags>
    <Properties>
      <Property Id="Microsoft.VisualStudio.Code.Engine" Value="${xmlEscape(pkg.engines.vscode)}" />
      <Property Id="Microsoft.VisualStudio.Code.ExtensionDependencies" Value="" />
      <Property Id="Microsoft.VisualStudio.Code.ExtensionPack" Value="" />
      <Property Id="Microsoft.VisualStudio.Code.ExtensionKind" Value="${xmlEscape((pkg.extensionKind || ['workspace']).join(','))}" />
      <Property Id="Microsoft.VisualStudio.Code.LocalizedLanguages" Value="" />
      <Property Id="Microsoft.VisualStudio.Code.ExecutesCode" Value="true" />
    </Properties>
    <Icon>extension/icon.png</Icon>
  </Metadata>
  <Installation>
    <InstallationTarget Id="Microsoft.VisualStudio.Code"/>
  </Installation>
  <Dependencies/>
  <Assets>
    <Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json" Addressable="true" />
    <Asset Type="Microsoft.VisualStudio.Services.Content.Details" Path="extension/readme.md" Addressable="true" />
    <Asset Type="Microsoft.VisualStudio.Services.Icons.Default" Path="extension/icon.png" Addressable="true" />
  </Assets>
</PackageManifest>
`));
  files.set('[Content_Types].xml', Buffer.from(`<?xml version="1.0" encoding="utf-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension=".json" ContentType="application/json"/>
  <Default Extension=".js" ContentType="application/javascript"/>
  <Default Extension=".md" ContentType="text/markdown"/>
  <Default Extension=".png" ContentType="image/png"/>
  <Default Extension=".vsixmanifest" ContentType="text/xml"/>
</Types>
`));
  const out = path.join(DIST, `read-aloud-vscode-${pkg.version}.vsix`);
  fs.writeFileSync(out, zip(files));
  return out;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const i = process.argv.indexOf('--browser');
  if (i !== -1) {
    console.log(`Built ${await buildBrowser(path.resolve(process.argv[i + 1]))}`);
  } else {
    fs.rmSync(DIST, { recursive: true, force: true });
    for (const out of [await packBrowser(), await packVscode()]) {
      console.log(`Built ${path.relative(ROOT, out)} (${Math.round(fs.statSync(out).size / 1024)} KB)`);
    }
  }
}
