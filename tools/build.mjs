/**
 * Build the deployable static site into dist/.
 *
 * No bundler and no transpiler on purpose: the browser loads the same ES
 * modules the test suite runs, so what ships is what was tested. The build
 * only copies files, checks the ones that must exist, and refuses to emit a
 * site whose ledger does not verify — publishing a broken chain would be worse
 * than not publishing.
 *
 *   node tools/build.mjs
 */

import {
  cpSync, mkdirSync, rmSync, existsSync, readFileSync, writeFileSync, statSync, readdirSync,
  copyFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { verifyBundle } from '../core/bundle.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const WEB = join(ROOT, 'web');
const DIST = join(ROOT, 'dist');

/* ------------------------------------------------------------------ checks */

const REQUIRED = [
  'index.html',
  'styles.css',
  'manifest.webmanifest',
  'icon.svg',
  'js/app.js',
  'js/store.js',
  'js/actions.js',
  'js/ui.js',
  'js/views/public.js',
  'js/views/account.js',
  'data/ledger.json',
  'fonts.css',
  'img/hero-2400.webp',
  'fonts/BarlowCondensed-800.woff2',
];

const missing = REQUIRED.filter((f) => !existsSync(join(WEB, f)));
if (missing.length) {
  console.error(`missing required files: ${missing.join(', ')}`);
  process.exit(1);
}

/* ------------------------------------------------- verify the shipped ledger */

const ledgerPath = join(WEB, 'data', 'ledger.json');
const bundle = JSON.parse(readFileSync(ledgerPath, 'utf8'));
const check = await verifyBundle(bundle);

if (!check.chainOk) {
  console.error(`refusing to build: ledger chain is broken at record ${check.chainBrokenAt}`);
  process.exit(1);
}
if (!check.allSignaturesValid) {
  console.error(`refusing to build: ${check.badRecords.length} record(s) fail signature checks`);
  console.error(check.badRecords.slice(0, 5));
  process.exit(1);
}

/* ------------------------------------------------------------------- build */

rmSync(DIST, { recursive: true, force: true });
mkdirSync(DIST, { recursive: true });

for (const entry of ['index.html', 'styles.css', 'fonts.css', 'manifest.webmanifest', 'icon.svg', 'js', 'data', 'fonts', 'img']) {
  cpSync(join(WEB, entry), join(DIST, entry), { recursive: true });
}
cpSync(join(ROOT, 'core'), join(DIST, 'core'), { recursive: true });

// The site imports the protocol core directly so the browser runs the exact
// modules the test suite covers. In `web/` the core sits above the app, so the
// right number of "../" depends on how deep the importing file is. dist/core is
// a sibling of dist/js, so depth is rewritten per file rather than copied
// blind — a wrong depth would silently ship a broken site.
const toCorePath = (fileDir) => {
  const depth = relative(DIST, fileDir).split(/[\\/]/).filter(Boolean).length;
  return '../'.repeat(depth) + 'core/';
};

const rewriteCoreImports = (dir) => {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) { rewriteCoreImports(p); continue; }
    if (!p.endsWith('.js')) continue;
    const src = readFileSync(p, 'utf8');
    const target = toCorePath(dir);
    const out = src.replace(/(from\s+')((?:\.\.\/)+core\/)/g, `$1${target}`);
    if (out !== src) writeFileSync(p, out);
  }
};
rewriteCoreImports(join(DIST, 'js'));

// Stamp the build so a deployed site can be traced back to a commit.
writeFileSync(join(DIST, 'build-info.json'), `${JSON.stringify({
  builtAt: new Date().toISOString(),
  protocol: 'fanverify/v2',
  records: check.recordCount,
  chainOk: check.chainOk,
  allSignaturesValid: check.allSignaturesValid,
}, null, 2)}\n`);

/* ------------------------------------------------------------------ report */

let files = 0;
let bytes = 0;
const walkDir = (dir) => {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    const st = statSync(p);
    if (st.isDirectory()) walkDir(p);
    else { files += 1; bytes += st.size; }
  }
};
walkDir(DIST);

console.log(`built dist/  (${files} files, ${(bytes / 1024).toFixed(1)} KB)`);
console.log(`ledger: ${check.recordCount} records, chain OK, all signatures OK`);

// Catch the classic static-deploy failure: an import path that only resolves
// because of a build step that does not exist here.
const html = readFileSync(join(DIST, 'index.html'), 'utf8');
const moduleRefs = [...html.matchAll(/(?:src|href)="\.\/([^"]+)"/g)].map((m) => m[1]);
const brokenRefs = moduleRefs.filter((r) => !existsSync(join(DIST, r)));
if (brokenRefs.length) {
  console.error(`index.html references missing files: ${brokenRefs.join(', ')}`);
  process.exit(1);
}

// The @font-face src paths must resolve too, or the page silently falls back
// to system fonts and the whole typographic direction collapses.
const fontCss = readFileSync(join(DIST, 'fonts.css'), 'utf8');
const badFonts = [...fontCss.matchAll(/url\(([^)]+)\)/g)]
  .map((m) => m[1])
  .filter((u) => !existsSync(join(DIST, 'fonts', u.replace('./fonts/', ''))));
if (badFonts.length) {
  console.error(`fonts.css references missing files: ${badFonts.join(', ')}`);
  process.exit(1);
}

// Every relative import inside the shipped JS must also resolve.
let badImports = [];
const checkImports = (dir) => {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) { checkImports(p); continue; }
    if (!p.endsWith('.js')) continue;
    const src = readFileSync(p, 'utf8');
    for (const m of src.matchAll(/from\s+'(\.[^']+)'/g)) {
      const target = join(dirname(p), m[1]);
      if (!existsSync(target)) badImports.push(`${relative(DIST, p)} -> ${m[1]}`);
    }
  }
};
checkImports(join(DIST, 'js'));
checkImports(join(DIST, 'core'));
if (badImports.length) {
  console.error(`unresolvable imports:\n  ${badImports.join('\n  ')}`);
  process.exit(1);
}
console.log('all relative imports resolve');

/* --------------------------------------------------- route handler gate */
// A route can reference a view that was never imported: the module still
// parses, every import still resolves, and the failure only appears when a
// visitor opens that page. Verify each handler name is actually bound.
const appJs = readFileSync(join(DIST, 'js', 'app.js'), 'utf8');
const routeBlock = appJs.slice(appJs.indexOf('const ROUTES'));
const handlerNames = [...routeBlock.matchAll(/view:\s*\(\s*\w+\s*,\s*\w+\s*\)\s*=>\s*([A-Za-z_$][\w$]*)/g)]
  .map((m) => m[1]);
const importBlock = appJs.slice(0, appJs.indexOf('const ROUTES'));
const unbound = handlerNames.filter((name) => {
  const imported = new RegExp(`import[\\s\\S]*?\\b${name}\\b[\\s\\S]*?from`).test(importBlock)
    || new RegExp(`\\b${name}\\b\\s*,?\\s*\\n?\\s*\\}`).test(importBlock);
  const declared = new RegExp(`(?:const|let|function)\\s+${name}\\b`).test(appJs);
  return !imported && !declared;
});
if (handlerNames.length === 0) {
  console.error('route gate found no handlers to check — the ROUTES block format changed');
  process.exit(1);
}
if (unbound.length) {
  console.error(`routes reference views that are never bound: ${unbound.join(', ')}`);
  process.exit(1);
}
console.log(`routes OK (${handlerNames.length} handlers bound)`);

/* ---------------------------------------------------- encoding gate */
// A single U+FFFD from a truncated heredoc reaches the browser as visible
// garbage inside a sentence, and nothing else in the pipeline notices. Treat
// any replacement character in shipped text as a build failure.
const textFiles = ['index.html', 'styles.css', 'fonts.css'];
const jsText = jsFilesForEncoding();
function jsFilesForEncoding() {
  const acc = [];
  const walk = (dir) => {
    for (const e of readdirSync(dir)) {
      const p = join(dir, e);
      if (statSync(p).isDirectory()) walk(p);
      else if (p.endsWith('.js')) acc.push(p);
    }
  };
  walk(join(DIST, 'js'));
  walk(join(DIST, 'core'));
  return acc;
}
const mojibake = [];
for (const rel of textFiles) {
  const p = join(DIST, rel);
  if (!existsSync(p)) continue;
  readFileSync(p, 'utf8').split('\n').forEach((line, i) => {
    if (line.includes('\uFFFD')) mojibake.push(`${rel}:${i + 1}`);
  });
}
for (const p of jsText) {
  readFileSync(p, 'utf8').split('\n').forEach((line, i) => {
    if (line.includes('\uFFFD')) mojibake.push(`${relative(DIST, p)}:${i + 1}`);
  });
}
if (mojibake.length) {
  console.error(`replacement characters (U+FFFD) found in:\n  ${mojibake.join('\n  ')}`);
  process.exit(1);
}
console.log('encoding OK (no U+FFFD in shipped text)');

/* ------------------------------------------------------- syntax gate */
// A single stray paren in a view file is invisible until the browser refuses to
// run the module — and the site then looks broken with no explanation.
//
// The check MUST parse as an ES module, which is what the browser does.
// `node --check foo.js` can take a different path when package.json has no
// "type": "module", and that difference let a real syntax error ship once.
// Copying to .mjs removes the ambiguity.
import { execFileSync } from 'node:child_process';
const jsFiles = [];
const collectJs = (dir) => {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) collectJs(p);
    else if (p.endsWith('.js')) jsFiles.push(p);
  }
};
collectJs(join(DIST, 'js'));
collectJs(join(DIST, 'core'));

const tmpCheck = join(tmpdir(), `fv-syntax-check-${process.pid}.mjs`);
const syntaxErrors = [];
try {
  for (const file of jsFiles) {
    copyFileSync(file, tmpCheck);
    try {
      execFileSync(process.execPath, ['--check', tmpCheck], { stdio: 'pipe' });
    } catch (e) {
      const detail = String(e.stderr ?? e.message).split('\n').slice(0, 5).join('\n');
      syntaxErrors.push(`${relative(DIST, file)}\n${detail}`);
    }
  }
} finally {
  try { rmSync(tmpCheck, { force: true }); } catch { /* best effort */ }
}

if (syntaxErrors.length) {
  console.error(`syntax errors in ${syntaxErrors.length} file(s):\n\n${syntaxErrors.join('\n\n')}`);
  process.exit(1);
}
console.log(`syntax OK across ${jsFiles.length} modules (parsed as ESM)`);
