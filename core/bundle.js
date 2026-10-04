/**
 * Ledger bundles: how a fan's locally-signed records become a public record.
 *
 * A static site accepts no writes, so publishing runs in two halves. The fan
 * signs everything on their own device and exports a bundle. The operator
 * appends it to the public ledger and redeploys. Anyone can then pull the
 * ledger and re-verify every signature and every chain link themselves — the
 * site never has to be believed.
 *
 * A bundle therefore needs no secret signing key of its own. Its integrity
 * comes from the per-record signatures inside it plus the hash chain they form.
 */

import { Ledger } from './ledger.js';

export const BUNDLE_FORMAT = 'fanverify-ledger-bundle/v2';

/**
 * Export records as a portable, self-describing file.
 *
 * `records` must be a contiguous run starting at seq 0 (the whole ledger) or a
 * suffix that links back into a ledger the recipient already has. The bundle
 * carries the full chain so a recipient can verify without trusting the sender.
 */
export function exportBundle(ledger, { note = '', exportedAt = new Date().toISOString() } = {}) {
  return {
    format: BUNDLE_FORMAT,
    note,
    exportedAt,
    recordCount: ledger.records.length,
    records: ledger.records,
  };
}

export function bundleToJson(bundle) {
  return JSON.stringify(bundle, null, 2);
}

export function parseBundle(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('this file is not valid JSON');
  }
  if (parsed?.format !== BUNDLE_FORMAT) {
    throw new Error(`unrecognised format: ${parsed?.format ?? 'missing'}`);
  }
  if (!Array.isArray(parsed.records) || parsed.records.length === 0) {
    throw new Error('bundle contains no records');
  }
  return parsed;
}

/** Record types a fan signs, mapped to their signing domain. */
const SIGNED_TYPES = {
  'rank-snapshot': 'rank-snapshot',
  'stance-commitment': 'stance-commitment',
  binding: 'binding',
};

/**
 * Verify a bundle end to end and return it as a Ledger.
 *
 * Fan-signed records are re-checked against their own embedded public key, and
 * the public key is re-hashed to confirm it matches the fingerprint the record
 * claims — so swapping in someone else's key only produces a failure.
 *
 * Operator records (match seals) carry no fan key and are deliberately not
 * signature-checked. Their integrity comes from the hash chain: rewriting a
 * seal to move a kickoff time still breaks every link after it.
 */
export async function verifyBundle(bundle) {
  const { verifySignature, fingerprintOf } = await import('./keys.js');
  const ledger = new Ledger(bundle.records);
  const chain = await ledger.verifyChain();

  const badRecords = [];
  let signedCount = 0;
  let operatorCount = 0;

  for (const rec of ledger.records) {
    const f = rec.fields ?? {};
    const type = SIGNED_TYPES[rec.type];

    if (!type) {
      operatorCount += 1;
      continue;
    }

    signedCount += 1;
    const { publicKey, signature, receiptId, anchoredAtMs, ...signed } = f;

    let sigOk = false;
    if (publicKey && signature) {
      sigOk = await verifySignature(type, signed, signature, publicKey);
    }
    let fpOk = false;
    if (publicKey && f.fingerprint) {
      fpOk = (await fingerprintOf(publicKey)) === f.fingerprint;
    }
    if (!sigOk || !fpOk) {
      badRecords.push({ seq: rec.seq, type: rec.type, signatureOk: sigOk, fingerprintOk: fpOk });
    }
  }

  return {
    chainOk: chain.ok,
    chainBrokenAt: chain.brokenAt,
    recordCount: ledger.records.length,
    signedCount,
    operatorCount,
    allSignaturesValid: badRecords.length === 0,
    badRecords,
    ledger,
  };
}

/**
 * Merge a verified bundle into a local ledger, refusing forks.
 * Used both by the fan importing a colleague's records and by the operator
 * appending submitted bundles to the public ledger.
 */
export async function mergeBundle(localLedger, bundle) {
  const check = await verifyBundle(bundle);
  if (!check.chainOk) {
    throw new Error(`bundle chain is broken at record ${check.chainBrokenAt}; refusing`);
  }
  if (!check.allSignaturesValid) {
    const first = check.badRecords[0];
    throw new Error(`bundle has ${check.badRecords.length} invalid record(s), first at seq ${first.seq}; refusing`);
  }
  return localLedger.merge(check.ledger);
}

/** Split a ledger into one bundle per contributor, for review before publishing. */
export function bundlesByContributor(ledger) {
  const byFp = new Map();
  for (const rec of ledger.records) {
    const fp = rec.fields?.fingerprint;
    if (!fp) continue; // seals and matches carry no contributor
    if (!byFp.has(fp)) byFp.set(fp, []);
    byFp.get(fp).push(rec);
  }
  return [...byFp.entries()].map(([fingerprint, records]) => ({
    fingerprint,
    recordCount: records.length,
    records,
  }));
}
