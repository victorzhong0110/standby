/**
 * Publish — the operator's side of the loop.
 *
 * A static site cannot accept writes, so growing the public ledger is a
 * deliberate act: drop submitted bundles in, verify everything, and write out
 * one file that anyone can re-verify.
 *
 *   node tools/publish.mjs --inbox ./inbox
 *   node tools/publish.mjs --inbox ./inbox --reset
 *
 * Rules the script will not bend:
 *   - Every incoming bundle is verified (chain + per-record signatures) before
 *     a single record is taken. One bad bundle fails the run; nothing partial.
 *   - A bundle that forks the chain is refused. Two histories disagreeing is
 *     not something to resolve by picking a side.
 *   - Already-present records are skipped, so re-running is safe and cheap.
 */

import { readdirSync, readFileSync, writeFileSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { dirname, join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Ledger } from '../core/ledger.js';
import { verifyBundle } from '../core/bundle.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const OUT = join(ROOT, 'web', 'data', 'ledger.json');

const argv = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : fallback;
};
const has = (name) => argv.includes(`--${name}`);

const inbox = flag('inbox', join(ROOT, 'inbox'));
const reset = has('reset');

function loadCurrent() {
  if (!existsSync(OUT)) return new Ledger();
  const bundle = JSON.parse(readFileSync(OUT, 'utf8'));
  return new Ledger(bundle.records ?? bundle);
}

async function main() {
  const ledger = loadCurrent();
  const before = ledger.size;
  console.log(`current ledger: ${before} records`);

  if (reset) {
    if (existsSync(inbox)) {
      const files = readdirSync(inbox).filter((f) => f.endsWith('.json'));
      console.log(`--reset: starting from scratch, ignoring ${files.length} file(s) in inbox`);
    }
    ledger.records = [];
  } else if (existsSync(inbox)) {
    const files = readdirSync(inbox)
      .filter((f) => f.endsWith('.json') && statSync(join(inbox, f)).isFile());

    if (files.length === 0) {
      console.log('inbox is empty; nothing to merge');
    }

    // Verify everything first, merge second. A rejected bundle must not leave
    // the chain half-updated.
    const accepted = [];
    for (const file of files) {
      const path = join(inbox, file);
      let parsed;
      try {
        parsed = JSON.parse(readFileSync(path, 'utf8'));
      } catch (e) {
        console.error(`  REJECT ${basename(file)}: not valid JSON (${e.message})`);
        continue;
      }
      if (parsed?.format !== 'fanverify-ledger-bundle/v2') {
        console.error(`  REJECT ${basename(file)}: not a fanverify bundle`);
        continue;
      }
      try {
        const res = await ledger.merge(new Ledger(parsed.records ?? []));
        accepted.push([basename(file), res.added]);
        console.log(`  merged ${basename(file)}: +${res.added} records`);
      } catch (e) {
        console.error(`  REJECT ${basename(file)}: ${e.message}`);
        process.exitCode = 1;
      }
    }
    console.log(`merged ${accepted.length} bundle(s)`);
  }

  // Final gate before writing anything to disk.
  const chain = await ledger.verifyChain();
  if (!chain.ok) {
    console.error(`refusing to publish: chain broken at ${chain.brokenAt} (${chain.reason})`);
    process.exit(1);
  }
  if (!before && ledger.size === 0) {
    console.error('refusing to publish an empty ledger');
    process.exit(1);
  }

  const bundle = {
    format: 'fanverify-ledger-bundle/v2',
    note: 'fanverify public ledger v2',
    exportedAt: new Date().toISOString(),
    recordCount: ledger.size,
    records: ledger.records,
  };

  const recheck = await verifyBundle(bundle);
  if (!recheck.chainOk || !recheck.allSignaturesValid) {
    console.error('refusing to publish: the output bundle does not re-verify');
    process.exit(1);
  }

  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, `${JSON.stringify(bundle, null, 2)}\n`);

  console.log(`\nwrote ${OUT}`);
  console.log(`  ${ledger.size} records (${recheck.signedCount} signed, ${recheck.operatorCount} operator)`);
  console.log('  chain OK, all signatures OK');
  console.log('\nnext: npm run build && redeploy');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
