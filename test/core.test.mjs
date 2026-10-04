/**
 * Core protocol tests. These run the *same* modules the browser loads, so a
 * pass here means the shipped code behaves, not a Node-only variant of it.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { canonicalJson, sha256Hex, b64uEncode, b64uDecode } from '../core/canonical.js';
import {
  generateIdentity, importPrivateKey, importPublicKey, signFields, verifySignature,
  fingerprintOf, verifyFingerprint,
} from '../core/keys.js';
import { Ledger, GENESIS } from '../core/ledger.js';
import { localClockAnchor, fixedClockAnchor, bestAvailableAnchor, serverAnchor } from '../core/anchor.js';
import { sealPrivateKey, openPrivateKey, passphraseStrength } from '../core/vault.js';
import { exportBundle, verifyBundle, mergeBundle, parseBundle, bundleToJson } from '../core/bundle.js';
import {
  createMatch, bindPlatform, recordRankSnapshot, commitStance, sealMatch,
  verifyReceipt, snapshotsFor, renderOneLiner, makeReceiptId,
} from '../core/protocol.js';
import { weightForMatch, peakFor, tierIndex, TIER_LADDERS } from '../core/rank.js';

const KICKOFF = '2026-10-10T12:00:00.000Z';
const KICKOFF_MS = Date.parse(KICKOFF);

const match = (over = {}) => createMatch({
  matchId: 'lck-final', gameId: 'league-of-legends', teams: ['T1', 'JDG'], kickoffAt: KICKOFF, ...over,
});

async function fixture() {
  const id = await generateIdentity();
  const privateKey = await importPrivateKey(id.privateKey);
  const ledger = new Ledger();
  const anchor = fixedClockAnchor(Date.parse('2026-10-01T00:00:00.000Z'));
  return { id, privateKey, ledger, anchor, at: (iso) => anchor.setTo(Date.parse(iso)) };
}

describe('canonical encoding', () => {
  test('key order does not change the digest', async () => {
    assert.equal(canonicalJson({ b: 1, a: 2 }), canonicalJson({ a: 2, b: 1 }));
    assert.equal(
      await sha256Hex(canonicalJson({ b: 1, a: 2 })),
      await sha256Hex(canonicalJson({ a: 2, b: 1 })),
    );
  });

  test('undefined members are dropped, nulls are kept', () => {
    assert.equal(canonicalJson({ a: 1, b: undefined }), '{"a":1}');
    assert.equal(canonicalJson({ a: null }), '{"a":null}');
  });

  test('array order is significant', () => {
    assert.notEqual(canonicalJson([1, 2]), canonicalJson([2, 1]));
  });

  test('base64url round-trips without padding', () => {
    for (const n of [0, 1, 31, 32, 33, 64, 255]) {
      const bytes = crypto.getRandomValues(new Uint8Array(n));
      assert.deepEqual(b64uDecode(b64uEncode(bytes)), bytes, `length ${n}`);
    }
    assert.ok(!b64uEncode(new Uint8Array(32)).includes('='));
  });
});

describe('identity', () => {
  test('a signature verifies with the matching public key and no other', async () => {
    const id = await generateIdentity();
    const priv = await importPrivateKey(id.privateKey);
    const other = await generateIdentity();
    const sig = await signFields('test', { a: 1 }, priv);

    assert.equal(await verifySignature('test', { a: 1 }, sig, id.publicKey), true);
    assert.equal(await verifySignature('test', { a: 1 }, sig, other.publicKey), false);
    assert.equal(await verifySignature('test', { a: 2 }, sig, id.publicKey), false);
  });

  test('domain separation blocks cross-type replay', async () => {
    const id = await generateIdentity();
    const priv = await importPrivateKey(id.privateKey);
    const fields = { matchId: 'm1', team: 'T1' };
    const stanceSig = await signFields('stance-commitment', fields, priv);
    assert.equal(await verifySignature('rank-snapshot', fields, stanceSig, id.publicKey), false);
    assert.equal(await verifySignature('binding', fields, stanceSig, id.publicKey), false);
  });

  test('fingerprint is derived from the public key and checkable', async () => {
    const id = await generateIdentity();
    assert.equal(await verifyFingerprint(id.publicKey, id.fingerprint), true);
    const other = await generateIdentity();
    assert.equal(await verifyFingerprint(other.publicKey, id.fingerprint), false);
  });

  test('a corrupt signature is a failed verification, not a crash', async () => {
    const id = await generateIdentity();
    assert.equal(await verifySignature('test', { a: 1 }, 'not-base64!!', id.publicKey), false);
    assert.equal(await verifySignature('test', { a: 1 }, '', id.publicKey), false);
  });
});

describe('vault', () => {
  test('a sealed key reopens with the right passphrase', async () => {
    const id = await generateIdentity();
    const sealed = await sealPrivateKey(id.privateKey, 'correct horse battery staple');
    assert.equal(await openPrivateKey(sealed, 'correct horse battery staple'), id.privateKey);
  });

  test('the wrong passphrase fails and says so', async () => {
    const id = await generateIdentity();
    const sealed = await sealPrivateKey(id.privateKey, 'right passphrase here');
    await assert.rejects(() => openPrivateKey(sealed, 'wrong passphrase!!'), /wrong passphrase|damaged/);
  });

  test('a short passphrase is refused up front', async () => {
    await assert.rejects(() => sealPrivateKey('x'.repeat(8), 'short'), /at least 8/);
  });

  test('a tampered vault cannot be decrypted', async () => {
    const id = await generateIdentity();
    const vault = JSON.parse(await sealPrivateKey(id.privateKey, 'a decent passphrase'));
    vault.data = vault.data.slice(0, -6) + 'AAAAAA';
    await assert.rejects(() => openPrivateKey(JSON.stringify(vault), 'a decent passphrase'));
  });

  test('strength meter flags a weak passphrase', () => {
    assert.ok(passphraseStrength('abc').score <= 2);
    assert.ok(passphraseStrength('Xk9$mQ2#pL7@vN4!').score >= 5);
  });
});

describe('ledger chain', () => {
  test('records link and verify in order', async () => {
    const { ledger, anchor } = await fixture();
    for (let i = 0; i < 5; i += 1) await ledger.append('note', { i }, await anchor.now());
    const res = await ledger.verifyChain();
    assert.equal(res.ok, true);
    assert.equal(ledger.records[0].prevHash, GENESIS);
    assert.equal(ledger.records[1].prevHash, ledger.records[0].hash);
  });

  test('editing a historical record breaks the chain at that index', async () => {
    const { ledger, anchor } = await fixture();
    await ledger.append('a', { v: 1 }, await anchor.now());
    await ledger.append('b', { v: 2 }, await anchor.now());
    await ledger.append('c', { v: 3 }, await anchor.now());
    ledger.records[1].fields.v = 999;
    const res = await ledger.verifyChain();
    assert.equal(res.ok, false);
    assert.equal(res.brokenAt, 1);
  });

  test('removing a record breaks the chain', async () => {
    const { ledger, anchor } = await fixture();
    for (let i = 0; i < 4; i += 1) await ledger.append('note', { i }, await anchor.now());
    ledger.records.splice(1, 1);
    const res = await ledger.verifyChain();
    assert.equal(res.ok, false);
  });

  test('append refuses a record with no anchor', async () => {
    const { ledger } = await fixture();
    await assert.rejects(() => ledger.append('x', {}, null), /timeAnchor/);
    await assert.rejects(() => ledger.append('x', {}, {}), /timeAnchor/);
  });

  test('merge extends a prefix and refuses a fork', async () => {
    const anchor = fixedClockAnchor(1000);
    const shorter = new Ledger();
    for (let i = 0; i < 2; i += 1) await shorter.append('note', { i }, await anchor.now());

    // A bundle that strictly extends the local chain.
    const longer = new Ledger(shorter.records);
    await longer.append('note', { i: 'extension' }, await anchor.now());
    const res = await shorter.merge(longer);
    assert.equal(res.added, 1);
    assert.equal((await shorter.verifyChain()).ok, true);

    // A bundle that disagrees past the shared prefix is a fork, not an update.
    const forked = new Ledger(shorter.records.slice(0, 2));
    await forked.append('note', { i: 'different' }, await anchor.now());
    await assert.rejects(() => shorter.merge(forked), /fork/);

    // Re-merging the same bundle is a no-op, not a duplication.
    assert.equal((await shorter.merge(longer)).added, 0);
  });
});

describe('anchors', () => {
  test('the local clock reports itself as the weakest option', () => {
    const a = localClockAnchor();
    assert.equal(a.trust, 'device');
    assert.match(a.note, /不具备防作弊能力/);
  });

  test('bestAvailableAnchor prefers the strongest available', () => {
    const local = localClockAnchor();
    const server = { kind: 'server-anchor' };
    const opentimestamps = { kind: 'opentimestamps' };
    assert.equal(bestAvailableAnchor({ opentimestamps, server, local }).kind, 'opentimestamps');
    assert.equal(bestAvailableAnchor({ server, local }).kind, 'server-anchor');
    assert.equal(bestAvailableAnchor({ local }).kind, 'local-clock');
    assert.equal(bestAvailableAnchor({}).kind, 'local-clock');
  });

  test('a server anchor must actually return a stamp', async () => {
    const bad = serverAnchor(async () => ({}));
    await assert.rejects(() => bad.now('digest'), /usable stamp/);
    const good = serverAnchor(async () => ({ unixMs: 123, kind: 'server-anchor' }));
    assert.equal((await good.now('digest')).unixMs, 123);
  });
});

describe('stance commitments', () => {
  test('a pre-kickoff commitment verifies and shows its side', async () => {
    const f = await fixture();
    const m = match();
    const { receiptId } = await commitStance({
      ledger: f.ledger, anchor: f.anchor, publicKey: f.id.publicKey, privateKey: f.privateKey,
      match: m, team: 'T1', committedAtMs: Date.parse('2026-10-10T09:00:00.000Z'),
    });
    const v = await verifyReceipt(f.ledger, { receiptId, match: m });
    assert.equal(v.ok, true);
    assert.equal(v.signatureOk, true);
    assert.equal(v.keyMatchesFingerprint, true);
    assert.equal(v.stance.team, 'T1');
    assert.equal(v.beforeKickoff, true);
    assert.equal(v.flipFlop, false);
  });

  test('backdating the claimed time does not beat the anchor', async () => {
    const f = await fixture();
    const m = match({ kickoffAt: '2020-01-01T00:00:00.000Z' });
    const { receiptId } = await commitStance({
      ledger: f.ledger, anchor: f.anchor, publicKey: f.id.publicKey, privateKey: f.privateKey,
      match: m, team: 'T1', committedAtMs: Date.parse('2019-12-31T00:00:00.000Z'),
      allowAfterKickoff: true, // operator-seeded late record, as in the demo data
    });
    f.at('2020-06-01T00:00:00Z');
    const v = await verifyReceipt(f.ledger, { receiptId, match: m });
    assert.equal(v.signatureOk, true, 'the lie is signed and genuine');
    assert.equal(v.beforeKickoff, false, 'but the anchor is after kickoff');
    assert.ok(v.anchoredAtMs > v.kickoffMs);
  });

  test('forking a pick keeps both and flags the flip', async () => {
    const f = await fixture();
    const m = match();
    await commitStance({
      ledger: f.ledger, anchor: f.anchor, publicKey: f.id.publicKey, privateKey: f.privateKey,
      match: m, team: 'T1', committedAtMs: Date.parse('2026-10-10T08:00:00.000Z'),
    });
    f.at('2026-10-10T09:00:00Z');
    const second = await commitStance({
      ledger: f.ledger, anchor: f.anchor, publicKey: f.id.publicKey, privateKey: f.privateKey,
      match: m, team: 'JDG', committedAtMs: Date.parse('2026-10-10T09:00:00.000Z'),
    });
    assert.equal(second.flipFlop, true);
    const v = await verifyReceipt(f.ledger, { receiptId: second.receiptId, match: m });
    assert.equal(v.flipFlop, true);
    assert.equal(v.commitmentCount, 2);
  });

  test('a flip before the deadline is allowed and kept, not hidden', async () => {
    const f = await fixture();
    const m = match();
    await commitStance({
      ledger: f.ledger, anchor: f.anchor, publicKey: f.id.publicKey, privateKey: f.privateKey,
      match: m, team: 'T1', committedAtMs: Date.parse('2026-10-10T08:00:00.000Z'),
    });
    f.at('2026-10-10T09:00:00Z');
    const second = await commitStance({
      ledger: f.ledger, anchor: f.anchor, publicKey: f.id.publicKey, privateKey: f.privateKey,
      match: m, team: 'JDG', committedAtMs: Date.parse('2026-10-10T09:00:00.000Z'),
    });
    assert.equal(second.flipFlop, true);
  });

  test('a match closes at kickoff and refuses further commitments', async () => {
    const f = await fixture();
    // A kickoff in the past: the chain-pinned time alone closes the match, with
    // no separate seal record involved.
    const m = match({ kickoffAt: '2020-01-01T00:00:00.000Z' });
    await assert.rejects(
      () => commitStance({
        ledger: f.ledger, anchor: f.anchor, publicKey: f.id.publicKey, privateKey: f.privateKey,
        match: m, team: 'T1',
      }),
      /kicked off/,
    );
  });

  test('a post-kickoff record can still be seeded, and is labelled 赛后补记', async () => {
    const f = await fixture();
    const m = match({ kickoffAt: '2020-01-01T00:00:00.000Z' });
    const { receiptId } = await commitStance({
      ledger: f.ledger, anchor: f.anchor, publicKey: f.id.publicKey, privateKey: f.privateKey,
      match: m, team: 'T1', allowAfterKickoff: true,
    });
    const v = await verifyReceipt(f.ledger, { receiptId, match: m });
    assert.equal(v.signatureOk, true, 'the record is still genuine');
    assert.equal(v.beforeKickoff, false, 'and still correctly labelled as late');
  });

  test('an operator can close a match before kickoff', async () => {
    const f = await fixture();
    const m = match();
    await f.ledger.append('match-closed', { matchId: m.matchId }, await f.anchor.now());
    await assert.rejects(
      () => commitStance({
        ledger: f.ledger, anchor: f.anchor, publicKey: f.id.publicKey, privateKey: f.privateKey,
        match: m, team: 'T1',
      }),
      /kicked off|closed/,
    );
  });

  test('a team not in the match is refused', async () => {
    const f = await fixture();
    await assert.rejects(() => commitStance({
      ledger: f.ledger, anchor: f.anchor, publicKey: f.id.publicKey, privateKey: f.privateKey,
      match: match(), team: 'GEN',
    }), /not playing/);
  });

  test('a sealed commitment hides the pick', async () => {
    const f = await fixture();
    const m = match();
    const { receiptId, oneLiner } = await commitStance({
      ledger: f.ledger, anchor: f.anchor, publicKey: f.id.publicKey, privateKey: f.privateKey,
      match: m, team: 'T1', salt: 'my-secret-salt',
      committedAtMs: Date.parse('2026-10-10T09:00:00.000Z'),
    });
    const v = await verifyReceipt(f.ledger, { receiptId, match: m });
    assert.equal(v.stance.mode, 'sealed');
    assert.equal(v.stance.team, null);
    assert.ok(!oneLiner.includes('T1'), 'readable line must not leak the pick');
    assert.ok(!v.oneLiner.includes('T1'));
  });

  test('a forged record signed by another key fails verification', async () => {
    const f = await fixture();
    const attacker = await generateIdentity();
    const m = match();
    const { receiptId } = await commitStance({
      ledger: f.ledger, anchor: f.anchor, publicKey: f.id.publicKey, privateKey: f.privateKey,
      match: m, team: 'T1',
    });
    // Attacker rewrites the stored public key to make the pick look like theirs.
    const rec = f.ledger.byType('stance-commitment').find((r) => r.fields.receiptId === receiptId);
    rec.fields.publicKey = attacker.publicKey;
    const v = await verifyReceipt(f.ledger, { receiptId, match: m });
    assert.equal(v.signatureOk, false, 'signature must fail against the swapped key');
  });

  test('two identical commitments in the same millisecond get distinct ids', async () => {
    // Guards a real regression: the id used to derive from
    // (fingerprint, matchId, committedAtMs), so signing the same claim twice
    // within one millisecond produced two records sharing one receipt id.
    const f = await fixture();
    const m = match();
    const sameMs = Date.parse('2026-10-10T08:00:00.000Z');
    const a = await commitStance({
      ledger: f.ledger, anchor: f.anchor, publicKey: f.id.publicKey, privateKey: f.privateKey,
      match: m, team: 'T1', committedAtMs: sameMs,
    });
    const b = await commitStance({
      ledger: f.ledger, anchor: f.anchor, publicKey: f.id.publicKey, privateKey: f.privateKey,
      match: m, team: 'T1', committedAtMs: sameMs,
    });
    assert.notEqual(a.receiptId, b.receiptId, 'receipt ids must be unique');
    const va = await verifyReceipt(f.ledger, { receiptId: a.receiptId, match: m });
    const vb = await verifyReceipt(f.ledger, { receiptId: b.receiptId, match: m });
    assert.equal(va.signatureOk, true);
    assert.equal(vb.signatureOk, true);
    assert.equal(va.stance.team, 'T1', 'each id still resolves to its own record');
    assert.equal(vb.stance.team, 'T1');
  });

  test('the receipt id is derived from the signed bytes', async () => {
    const f = await fixture();
    const m = match();
    const res = await commitStance({
      ledger: f.ledger, anchor: f.anchor, publicKey: f.id.publicKey, privateKey: f.privateKey,
      match: m, team: 'T1',
    });
    const rec = f.ledger.byType('stance-commitment')
      .find((r) => r.fields.receiptId === res.receiptId);
    const { signature, receiptId, publicKey, anchoredAtMs, ...signed } = rec.fields;
    const expected = await makeReceiptId(canonicalJson(signed));
    assert.equal(receiptId, expected, 'id must be reproducible from the signed payload');
  });

  test('an unknown receipt is rejected rather than guessed', async () => {
    const f = await fixture();
    const v = await verifyReceipt(f.ledger, { receiptId: '0xnope' });
    assert.equal(v.ok, false);
    assert.equal(v.error, 'receipt-not-found');
  });
});

describe('rank weighting', () => {
  test('weight comes only from the match game, never another game', async () => {
    const f = await fixture();
    const m = match();
    const before = Date.parse('2026-10-05T00:00:00.000Z');
    await recordRankSnapshot({
      ledger: f.ledger, anchor: f.anchor, publicKey: f.id.publicKey, privateKey: f.privateKey,
      gameId: 'honor-of-kings', tier: '最强王者', provenance: 'self', capturedAtMs: before,
    });
    await recordRankSnapshot({
      ledger: f.ledger, anchor: f.anchor, publicKey: f.id.publicKey, privateKey: f.privateKey,
      gameId: 'league-of-legends', tier: '不屈白银', queue: '单双排', provenance: 'self', capturedAtMs: before,
    });
    const { receiptId } = await commitStance({
      ledger: f.ledger, anchor: f.anchor, publicKey: f.id.publicKey, privateKey: f.privateKey,
      match: m, team: 'T1', committedAtMs: before,
    });
    const v = await verifyReceipt(f.ledger, { receiptId, match: m });
    assert.equal(v.gameSnapshot.tier, '不屈白银');
    assert.equal(v.weight.band, 'low');
    assert.equal(v.otherGames[0].gameId, 'honor-of-kings');
    assert.equal(v.otherGames[0].countsTowardThisMatch, false);
  });

  test('a newer other-game snapshot does not mask this game', async () => {
    const f = await fixture();
    const m = match();
    const before = Date.parse('2026-10-05T00:00:00.000Z');
    await recordRankSnapshot({
      ledger: f.ledger, anchor: f.anchor, publicKey: f.id.publicKey, privateKey: f.privateKey,
      gameId: 'league-of-legends', tier: '不屈白银', provenance: 'self', capturedAtMs: before,
    });
    f.at('2026-10-06T00:00:00Z');
    await recordRankSnapshot({
      ledger: f.ledger, anchor: f.anchor, publicKey: f.id.publicKey, privateKey: f.privateKey,
      gameId: 'honor-of-kings', tier: '最强王者', provenance: 'self',
      capturedAtMs: Date.parse('2026-10-06T00:00:00.000Z'),
    });
    const { receiptId } = await commitStance({
      ledger: f.ledger, anchor: f.anchor, publicKey: f.id.publicKey, privateKey: f.privateKey,
      match: m, team: 'T1', committedAtMs: before,
    });
    const v = await verifyReceipt(f.ledger, { receiptId, match: m });
    assert.equal(v.gameSnapshot.tier, '不屈白银');
  });

  test('a post-match rank gain does not rewrite the pre-match weight', async () => {
    const f = await fixture();
    const m = match();
    const before = Date.parse('2026-10-05T00:00:00.000Z');
    await recordRankSnapshot({
      ledger: f.ledger, anchor: f.anchor, publicKey: f.id.publicKey, privateKey: f.privateKey,
      gameId: 'league-of-legends', tier: '不屈白银', provenance: 'self', capturedAtMs: before,
    });
    const { receiptId } = await commitStance({
      ledger: f.ledger, anchor: f.anchor, publicKey: f.id.publicKey, privateKey: f.privateKey,
      match: m, team: 'T1', committedAtMs: before,
    });
    f.at('2026-10-12T00:00:00Z');
    await recordRankSnapshot({
      ledger: f.ledger, anchor: f.anchor, publicKey: f.id.publicKey, privateKey: f.privateKey,
      gameId: 'league-of-legends', tier: '宗师', provenance: 'self',
      capturedAtMs: Date.parse('2026-10-12T00:00:00.000Z'),
    });
    const v = await verifyReceipt(f.ledger, { receiptId, match: m });
    assert.equal(v.gameSnapshot.tier, '不屈白银', 'weight uses the pre-kickoff snapshot');
    assert.equal(v.weight.band, 'low');
    assert.equal(v.historicalPeak.tier, '宗师', 'peak is recorded separately');
  });

  test('no snapshot means unverified, never a high score', () => {
    assert.equal(weightForMatch({ gameId: 'league-of-legends', snapshot: null }).band, 'unverified');
  });

  test('an unknown tier is unverified, not silently high', () => {
    const w = weightForMatch({ gameId: 'league-of-legends', snapshot: { tier: '不存在的段位' } });
    assert.equal(w.band, 'unverified');
  });

  test('an unknown game is unverified', () => {
    assert.equal(weightForMatch({ gameId: 'chess', snapshot: { tier: '宗师' } }).band, 'unverified');
  });

  test('Steam has no ladder so it is capped, never high', () => {
    assert.equal(weightForMatch({ gameId: 'steam', snapshot: { tier: '时长充足' } }).band, 'mid');
  });

  test('provenance is carried into the stated rule', () => {
    const w = weightForMatch({
      gameId: 'league-of-legends',
      snapshot: { tier: '璀璨钻石', provenance: 'self' },
    });
    assert.match(w.rule, /自报/);
  });

  test('peak compares ladder position, not alphabetical order', () => {
    const snaps = [
      { gameId: 'league-of-legends', tier: '荣耀黄金', anchoredAtMs: 1 },
      { gameId: 'league-of-legends', tier: '璀璨钻石', anchoredAtMs: 2 },
      { gameId: 'league-of-legends', tier: '不屈白银', anchoredAtMs: 3 },
    ];
    assert.equal(peakFor(snaps, 'league-of-legends').tier, '璀璨钻石');
    assert.ok(tierIndex('league-of-legends', '璀璨钻石') > tierIndex('league-of-legends', '荣耀黄金'));
  });

  test('a cross-game tier name is not on the ladder', () => {
    assert.equal(tierIndex('league-of-legends', '星耀'), -1);
    assert.ok(tierIndex('honor-of-kings', '星耀') >= 0);
  });

  test('every game declares whether it has an official API', () => {
    for (const [id, l] of Object.entries(TIER_LADDERS)) {
      assert.equal(typeof l.official, 'boolean', `${id} must declare official support`);
    }
    assert.equal(TIER_LADDERS['honor-of-kings'].official, false);
    assert.equal(TIER_LADDERS['league-of-legends'].official, true);
  });
});

describe('bundles', () => {
  async function populated() {
    const f = await fixture();
    const m = match();
    await bindPlatform({
      ledger: f.ledger, anchor: f.anchor, publicKey: f.id.publicKey, privateKey: f.privateKey,
      platform: 'weibo', handle: 'u1',
    });
    f.at('2026-10-02T00:00:00Z');
    await recordRankSnapshot({
      ledger: f.ledger, anchor: f.anchor, publicKey: f.id.publicKey, privateKey: f.privateKey,
      gameId: 'league-of-legends', tier: '璀璨钻石', provenance: 'official', provider: 'riot',
    });
    f.at('2026-10-05T00:00:00Z');
    const c = await commitStance({
      ledger: f.ledger, anchor: f.anchor, publicKey: f.id.publicKey, privateKey: f.privateKey,
      match: m, team: 'T1',
    });
    f.at('2026-10-11T00:00:00Z');
    await sealMatch(f.ledger, f.anchor, m);
    return { ...f, m, receiptId: c.receiptId };
  }

  test('a well-formed bundle verifies and merges into an empty ledger', async () => {
    const f = await populated();
    const bundle = exportBundle(f.ledger);
    const check = await verifyBundle(bundle);
    assert.equal(check.chainOk, true);
    assert.equal(check.allSignaturesValid, true);
    assert.equal(check.badRecords.length, 0);
    assert.equal(check.signedCount, 3);
    assert.equal(check.operatorCount, 1);

    const fresh = new Ledger();
    const res = await mergeBundle(fresh, bundle);
    assert.equal(res.added, f.ledger.size);
    assert.equal((await fresh.verifyChain()).ok, true);
    const v = await verifyReceipt(fresh, { receiptId: f.receiptId, match: f.m });
    assert.equal(v.signatureOk, true);
  });

  test('a bundle round-trips through JSON text', async () => {
    const f = await populated();
    const parsed = parseBundle(bundleToJson(exportBundle(f.ledger)));
    assert.equal((await verifyBundle(parsed)).allSignaturesValid, true);
  });

  test('editing a committed pick is caught', async () => {
    const f = await populated();
    const b = exportBundle(f.ledger);
    b.records.find((r) => r.type === 'stance-commitment').fields.team = 'JDG';
    const check = await verifyBundle(b);
    assert.equal(check.chainOk, false);
    assert.equal(check.allSignaturesValid, false);
    await assert.rejects(() => mergeBundle(new Ledger(), b), /broken/);
  });

  test('editing a rank is caught', async () => {
    const f = await populated();
    const b = exportBundle(f.ledger);
    b.records.find((r) => r.type === 'rank-snapshot').fields.tier = '最强王者';
    const check = await verifyBundle(b);
    assert.equal(check.allSignaturesValid, false);
  });

  test('rewriting a kickoff time on a seal is caught by the chain', async () => {
    const f = await populated();
    const b = exportBundle(f.ledger);
    const seal = b.records.find((r) => r.type === 'match-seal');
    seal.fields.kickoffMs = Date.parse('2020-01-01T00:00:00.000Z');
    seal.fields.kickoffAt = '2020-01-01T00:00:00.000Z';
    const check = await verifyBundle(b);
    assert.equal(check.chainOk, false, 'moving a kickoff still breaks the chain');
  });

  test('garbage and wrong-format files are refused clearly', () => {
    assert.throws(() => parseBundle('not json'), /not valid JSON/);
    assert.throws(() => parseBundle('{"format":"something-else"}'), /unrecognised format/);
    assert.throws(() => parseBundle('{"format":"fanverify-ledger-bundle/v2","records":[]}'), /no records/);
  });
});

describe('one-liner', () => {
  test('reads naturally and always ends in the receipt path', () => {
    const line = renderOneLiner({
      mode: 'plain', team: 'T1', gameId: 'league-of-legends',
      tier: '璀璨钻石', receiptId: '0xabc…1234', baseUrl: 'https://example.org',
    });
    assert.equal(line, '赛前 T1 · 英雄联盟 璀璨钻石 · 认证 https://example.org/p/0xabc…1234');
  });

  test('a sealed commitment never names a team', () => {
    const line = renderOneLiner({
      mode: 'sealed', team: 'T1', gameId: 'valorant', tier: null, receiptId: '0xa…1', baseUrl: '',
    });
    assert.ok(!line.includes('T1'));
    assert.match(line, /赛前保密/);
  });
});
