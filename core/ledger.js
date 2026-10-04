/**
 * Append-only hash-chained ledger. Isomorphic and async because hashing goes
 * through WebCrypto.
 *
 * Every record carries the digest of its predecessor, so the log is a chain:
 * editing or removing any historical record breaks every link after it, and
 * verifyChain() names the exact index where the break occurs. Records are never
 * updated in place — a correction is a new record referencing the one it
 * supersedes.
 *
 * The chain alone does NOT stop backdating. Anyone can write a record claiming
 * a commitment happened yesterday. What makes time checkable is the
 * `timeAnchor` stamp the record carries, supplied by an anchor authority and
 * recorded here verbatim — never invented by the ledger.
 */

import { canonicalJson, sha256Hex } from './canonical.js';

export const GENESIS = 'GENESIS';

export class Ledger {
  constructor(records = []) {
    this.records = records.map(normalizeRecord);
  }

  static async fromRecords(records) {
    return new Ledger(records);
  }

  get head() {
    return this.records.length ? this.records[this.records.length - 1] : null;
  }

  get size() {
    return this.records.length;
  }

  currentChainHash() {
    return this.head ? this.head.hash : GENESIS;
  }

  /**
   * Append a record. `timeAnchor` must come from an anchor authority — the
   * ledger refuses a record that has none, so time can never be self-asserted.
   */
  async append(type, fields, timeAnchor) {
    if (!timeAnchor || typeof timeAnchor.unixMs !== 'number') {
      throw new Error('append() requires a timeAnchor from an anchor authority');
    }
    const body = {
      seq: this.records.length,
      type,
      timeAnchor,
      prevHash: this.currentChainHash(),
      fields,
    };
    const record = { ...body, hash: `rec_${await sha256Hex(canonicalJson(body))}` };
    this.records.push(record);
    return record;
  }

  byType(type) {
    return this.records.filter((r) => r.type === type);
  }

  findOne(predicate) {
    return this.records.find(predicate) ?? null;
  }

  find(predicate) {
    return this.records.filter(predicate);
  }

  /**
   * Recompute every link. `brokenAt` is the first record whose stored hash does
   * not match its contents, which is where an editor's change shows up.
   */
  async verifyChain() {
    let prev = GENESIS;
    for (let i = 0; i < this.records.length; i += 1) {
      const r = this.records[i];
      const body = {
        seq: r.seq,
        type: r.type,
        timeAnchor: r.timeAnchor,
        prevHash: r.prevHash,
        fields: r.fields,
      };
      const expected = `rec_${await sha256Hex(canonicalJson(body))}`;
      if (r.hash !== expected) {
        return { ok: false, length: this.records.length, brokenAt: i, reason: 'hash-mismatch' };
      }
      if (r.prevHash !== prev) {
        return { ok: false, length: this.records.length, brokenAt: i, reason: 'prev-hash-mismatch' };
      }
      if (r.seq !== i) {
        return { ok: false, length: this.records.length, brokenAt: i, reason: 'seq-mismatch' };
      }
      prev = r.hash;
    }
    return { ok: true, length: this.records.length, brokenAt: null, reason: null, headHash: prev };
  }

  /**
   * Merge another ledger's records onto this one.
   *
   * Only the extension of the common prefix is taken, and every borrowed
   * record is re-verified against its own hash first. A bundle claiming to
   * extend the chain cannot smuggle in an edited record, and a bundle
   * rewritten from scratch cannot be grafted on.
   */
  async merge(other) {
    const otherChain = await other.verifyChain();
    if (!otherChain.ok) {
      throw new Error(`refusing to merge a broken chain (breaks at ${otherChain.brokenAt})`);
    }
    let shared = 0;
    while (
      shared < this.records.length
      && shared < other.records.length
      && this.records[shared].hash === other.records[shared].hash
    ) shared += 1;

    const incoming = other.records.slice(shared);
    if (incoming.length === 0) return { added: 0, divergedAt: null };

    if (shared < this.records.length) {
      // Both sides have records past the shared prefix, and they differ. This
      // is a fork, not an extension; refuse rather than silently pick a side.
      throw new Error(`ledger fork at seq ${shared}: existing and incoming disagree`);
    }

    for (const rec of incoming) {
      if (rec.prevHash !== this.currentChainHash()) {
        throw new Error(`record ${rec.seq} does not link to the local head`);
      }
      this.records.push(rec);
    }
    return { added: incoming.length, divergedAt: null };
  }
}

function normalizeRecord(r) {
  return {
    seq: r.seq,
    type: r.type,
    timeAnchor: r.timeAnchor,
    prevHash: r.prevHash,
    fields: r.fields,
    hash: r.hash,
  };
}
