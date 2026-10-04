/**
 * Client-side store.
 *
 * Two ledgers live side by side:
 *   public  — the published chain shipped with the site, read-only.
 *   mine    — this device's own records, extended as the fan signs things.
 *
 * The private key is held encrypted (see core/vault.js) and only decrypted in
 * memory for the duration of a session. Nothing signs behind the user's back:
 * every record appears the instant they confirm it.
 */

import { Ledger } from '../../core/ledger.js';
import { generateIdentity, importPrivateKey, fingerprintOf } from '../../core/keys.js';
import { sealPrivateKey, openPrivateKey } from '../../core/vault.js';
import { localClockAnchor, bestAvailableAnchor } from '../../core/anchor.js';
import { createRankSource } from '../../core/rank-source.js';
import { verifyBundle, mergeBundle, exportBundle } from '../../core/bundle.js';

const NS = 'fanverify.v2';
const KEY_IDENTITY = `${NS}.identity`;
const KEY_VAULT = `${NS}.vault`;
const KEY_MINE = `${NS}.mine`;
const KEY_PROXY = `${NS}.proxyUrl`;
const KEY_LEDGER_URL = `${NS}.ledgerUrl`;

/** Shipped with the site; the fallback when no remote source is configured. */
export const BUNDLED_LEDGER = './data/ledger.json';

function readJSON(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function writeJSON(key, value) {
  localStorage.setItem(key, JSON.stringify(value));
}

export class Store {
  constructor() {
    this.anchor = bestAvailableAnchor({ local: localClockAnchor() });
    this.rankSource = createRankSource({ proxyUrl: this.proxyUrl });
    this.publicLedger = new Ledger();
    this.mine = new Ledger(readJSON(KEY_MINE, []));
    this.identity = readJSON(KEY_IDENTITY, null);
    this.listeners = new Set();
    /** In-memory only. Never persisted in the clear. */
    this._privateKey = null;
  }

  /**
   * Where the public chain is read from.
   *
   * Order: ?ledger= on the URL, then a saved setting, then the copy shipped
   * with the site. Pointing this at a remote JSON means the public ledger can
   * grow without rebuilding or redeploying the page — which is what turns the
   * site from a hardcoded demo into something a community can actually extend.
   */
  get ledgerUrl() {
    const fromQuery = new URLSearchParams(location.search).get('ledger');
    return fromQuery || localStorage.getItem(KEY_LEDGER_URL) || BUNDLED_LEDGER;
  }

  get ledgerUrlIsRemote() {
    return /^https?:/i.test(this.ledgerUrl);
  }

  set ledgerUrl(value) {
    if (value && value !== BUNDLED_LEDGER) localStorage.setItem(KEY_LEDGER_URL, value);
    else localStorage.removeItem(KEY_LEDGER_URL);
  }

  get proxyUrl() {
    return localStorage.getItem(KEY_PROXY) || null;
  }

  set proxyUrl(value) {
    if (value) localStorage.setItem(KEY_PROXY, value);
    else localStorage.removeItem(KEY_PROXY);
    this.rankSource = createRankSource({ proxyUrl: value });
  }

  get unlocked() {
    return Boolean(this._privateKey);
  }

  subscribe(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  emit() {
    for (const fn of this.listeners) fn();
  }

  /* ------------------------------------------------------------- onboarding */

  /**
   * Create an identity and seal its private key. The passphrase is the only way
   * back in, so it is confirmed twice before anything is written.
   */
  async createIdentity(passphrase) {
    if (this.identity) throw new Error('这个设备已经有身份了');
    const id = await generateIdentity();
    const vault = await sealPrivateKey(id.privateKey, passphrase);
    localStorage.setItem(KEY_VAULT, vault);
    this.identity = { publicKey: id.publicKey, fingerprint: id.fingerprint, createdAt: new Date().toISOString() };
    writeJSON(KEY_IDENTITY, this.identity);
    this._privateKey = await importPrivateKey(id.privateKey);
    this.emit();
    return this.identity;
  }

  /** Restore an identity from a backup file plus the passphrase. */
  async restoreIdentity(backup, passphrase) {
    if (typeof backup === 'string') backup = JSON.parse(backup);
    if (!backup?.vault) throw new Error('备份文件里没有密钥库');
    if (backup.identity?.fingerprint) {
      const check = await fingerprintOf(backup.identity.publicKey);
      if (check !== backup.identity.fingerprint) {
        throw new Error('备份文件里的公钥与指纹对不上，文件可能损坏');
      }
    }
    const privateKey = await openPrivateKey(backup.vault, passphrase);
    localStorage.setItem(KEY_VAULT, backup.vault);
    this.identity = backup.identity;
    writeJSON(KEY_IDENTITY, this.identity);
    this._privateKey = await importPrivateKey(privateKey);
    this.emit();
    return this.identity;
  }

  async unlock(passphrase) {
    const vault = localStorage.getItem(KEY_VAULT);
    if (!vault) throw new Error('这个设备还没有身份');
    const privateKey = await openPrivateKey(vault, passphrase);
    this._privateKey = await importPrivateKey(privateKey);
    this.emit();
    return true;
  }

  lock() {
    this._privateKey = null;
    this.emit();
  }

  /** Portable backup: identity plus encrypted key. Safe to store anywhere. */
  exportBackup() {
    return JSON.stringify({
      format: 'fanverify-backup/v2',
      exportedAt: new Date().toISOString(),
      identity: this.identity,
      vault: localStorage.getItem(KEY_VAULT),
    }, null, 2);
  }

  /* ----------------------------------------------------------------- ledger */

  /**
   * Load the chain published with the site.
   *
   * The published records are merged INTO this device's chain rather than kept
   * beside it. A single chain is the only honest model: a fan's first record
   * has to link to the published head, otherwise their commitments form a
   * separate history that nobody else can verify against.
   *
   * A published chain that fails verification is NOT merged and NOT hidden. It
   * is surfaced: an empty chain would otherwise present every receipt as
   * "not found", which reads like a broken link rather than an attack.
   */
  async loadPublicLedger(records) {
    const check = await verifyBundle({ format: 'fanverify-ledger-bundle/v2', records });
    this.publicLedger = check.ledger;
    this.publicCheck = check;

    if (!check.chainOk) {
      this.publicLedgerBroken = check.chainBrokenAt;
      this.mergeNote = `公开账本链在第 ${check.chainBrokenAt} 条断裂，已拒绝并入；本站不会基于它给出任何判定。`;
      this.emit();
      return check;
    }
    this.publicLedgerBroken = null;

    try {
      const res = await this.mine.merge(this.publicLedger);
      this.mergeNote = res.added
        ? `已并入公开账本 ${res.added} 条记录`
        : '本机账本已包含全部公开记录';
    } catch (err) {
      // A rebuilt or forked public chain would silently corrupt this fan's
      // history. Keep the local records and say so instead.
      this.mergeNote = `公开账本与本机记录分叉，本机记录保持原样：${err.message}`;
    }
    this.emit();
    return check;
  }

  /**
   * Whether this device can render a verdict at all.
   *
   * A broken published chain is a reason to stop, not a reason to show an
   * empty page: every conclusion drawn from a chain that does not verify is
   * worthless, and saying "not found" would hide that.
   */
  get usable() {
    return this.publicLedgerBroken === null;
  }

  /** Fold a colleague's bundle into this chain, refusing forks and bad data. */
  async importMine(bundleJson) {
    const { parseBundle } = await import('../../core/bundle.js');
    const bundle = typeof bundleJson === 'string' ? parseBundle(bundleJson) : bundleJson;
    const res = await mergeBundle(this.mine, bundle);
    writeJSON(KEY_MINE, this.mine.records);
    this.emit();
    return res;
  }

  /** Records this device contributed beyond what the site already publishes. */
  myContribution() {
    const published = new Set(this.publicLedger.records.map((r) => r.hash));
    return this.mine.records.filter((r) => !published.has(r.hash));
  }

  /**
   * The one chain to read from: this device's ledger, which already contains
   * the published prefix. There is deliberately no "combine" step, because
   * concatenating two chains is exactly how a receipt ends up unverifiable.
   */
  combinedLedger() {
    return this.mine;
  }

  /** The fan's own records, ready to hand in for publication. */
  exportMineBundle() {
    return exportBundle(this.mine, { note: 'submitted for the public ledger' });
  }

  async append(type, fields) {
    if (!this._privateKey) throw new Error('请先解锁身份');
    const record = await this.mine.append(
      type,
      fields,
      await this.anchor.now(),
    );
    writeJSON(KEY_MINE, this.mine.records);
    this.emit();
    return record;
  }

  signPrivateKey() {
    if (!this._privateKey) throw new Error('请先解锁身份');
    return this._privateKey;
  }
}

export const store = new Store();
