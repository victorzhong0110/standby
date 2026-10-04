/**
 * The protocol. Isomorphic: the browser signs with a key it holds, and the test
 * suite drives the identical code path.
 *
 * A fan performs two setup steps, then one action per match:
 *
 *   bind()     — tie a platform account to the long-term key. Once per
 *                platform. The signed challenge is posted on the platform, so a
 *                reader can check the binding rather than take a name on faith.
 *   snapshot() — record a rank in one game. Append-only, refreshed by
 *                re-authorising with the game's own API.
 *   commit()   — sign a stance for a match before kickoff. The match is sealed
 *                after the deadline and later commitments are refused.
 *
 * A comment then needs one line. Anyone can edit the readable text; the
 * signature decides.
 */

import { canonicalJson, sha256Hex, utf8 } from './canonical.js';
import { signFields, verifySignature, fingerprintOf } from './keys.js';
import { peakFor, weightForMatch, displayGame, isKnownGame, PROVENANCE } from './rank.js';

export const PROTOCOL_VERSION = 'v2';

/* ------------------------------------------------------------------ matches */

export function createMatch({ matchId, gameId, teams, kickoffAt }) {
  return {
    matchId,
    gameId,
    teams,
    kickoffAt,
    kickoffMs: new Date(kickoffAt).getTime(),
  };
}

export function validateMatch(match) {
  if (!match.matchId) throw new Error('matchId is required');
  if (!match.gameId) throw new Error('gameId is required');
  if (!Array.isArray(match.teams) || match.teams.length < 2) {
    throw new Error('a match needs at least two teams');
  }
  if (Number.isNaN(match.kickoffMs)) throw new Error('kickoffAt must be a valid date');
  return true;
}

/**
 * A match is defined by a `match-seal` record, which pins its kickoff time
 * inside the hash chain — move that time and every later link breaks. The
 * record's presence is therefore registration, not closure.
 *
 * A match stops accepting NEW commitments once kickoff has passed, because the
 * kickoff time is chain-pinned and therefore trustworthy. Records that landed
 * after kickoff another way are still verified and still displayed, labelled
 * 赛后补记 — refusing to render them would hide the very thing a reader needs
 * to see.
 */
export function isMatchClosed(ledger, match, now = Date.now()) {
  if (!match) return true;
  if (now >= match.kickoffMs) return true;
  // An operator may close a match early (cancelled, postponed).
  return Boolean(
    ledger.byType('match-closed').find((r) => r.fields.matchId === match.matchId),
  );
}

export function matchesFor(ledger) {
  return ledger.byType('match-seal').map((r) => ({
    matchId: r.fields.matchId,
    gameId: r.fields.gameId,
    teams: r.fields.teams,
    kickoffAt: r.fields.kickoffAt,
    kickoffMs: r.fields.kickoffMs,
    record: r,
  }));
}

/* ------------------------------------------------------- platform bindings */

export function bindingChallengeText({ fingerprint: fp, platform, handle, issuedAtMs }) {
  return [
    'fanverify 账号绑定 v2',
    `身份: ${fp}`,
    `平台: ${platform}`,
    `账号: ${handle}`,
    `签发: ${issuedAtMs}`,
    '',
    '到本服务的 /bind 页面粘贴本段，核对通过后这条绑定才生效。',
  ].join('\n');
}

export async function bindPlatform({
  ledger, anchor, publicKey, privateKey, platform, handle, issuedAtMs = Date.now(),
}) {
  if (!platform || !handle) throw new Error('platform and handle are required');
  const fp = await fingerprintOf(publicKey);
  const challenge = bindingChallengeText({ fingerprint: fp, platform, handle, issuedAtMs });
  const fields = { version: PROTOCOL_VERSION, fingerprint: fp, platform, handle, issuedAtMs, challenge };
  const signature = await signFields('binding', fields, privateKey);
  // publicKey travels unsigned so the binding is checkable from the ledger
  // alone, exactly like a commitment.
  return ledger.append('binding', { ...fields, signature, publicKey }, await anchor.now());
}

export function bindingsFor(ledger, fp) {
  return ledger.byType('binding')
    .filter((r) => r.fields.fingerprint === fp)
    .sort((a, b) => a.timeAnchor.unixMs - b.timeAnchor.unixMs);
}

/* ---------------------------------------------------------- rank snapshots */

/**
 * Record one game's rank. `provenance` is required and must be honest: `official`
 * only when the tier actually came back from the game's API, otherwise `self`.
 * The page shows this verbatim, so faking it just makes your own receipt worse.
 */
export async function recordRankSnapshot({
  ledger, anchor, publicKey, privateKey, gameId, gameAccount, tier, queue, provider,
  provenance = 'self', capturedAtMs = Date.now(),
}) {
  if (!isKnownGame(gameId)) throw new Error(`unknown game "${gameId}"`);
  if (!tier) throw new Error('tier is required');

  const fp = await fingerprintOf(publicKey);
  const snapshotId = `snap_${(await sha256Hex(utf8(`${fp}|${gameId}|${capturedAtMs}|${tier}`))).slice(0, 20)}`;
  const fields = {
    version: PROTOCOL_VERSION,
    snapshotId,
    fingerprint: fp,
    gameId,
    gameAccount: gameAccount ?? null,
    tier,
    queue: queue ?? null,
    provider: provider ?? null,
    provenance,
    capturedAtMs,
  };
  const signature = await signFields('rank-snapshot', fields, privateKey);
  const anchorStamp = await anchor.now();
  // publicKey travels unsigned so the snapshot is checkable from the ledger
  // alone. It is excluded from the signed payload, so substituting it only
  // produces a failing verification.
  return ledger.append(
    'rank-snapshot',
    { ...fields, signature, publicKey, anchoredAtMs: anchorStamp.unixMs },
    anchorStamp,
  );
}

export function snapshotsFor(ledger, fp) {
  return ledger.byType('rank-snapshot')
    .filter((r) => r.fields.fingerprint === fp)
    .sort((a, b) => b.fields.anchoredAtMs - a.fields.anchoredAtMs);
}

/** Newest snapshot of (identity, game) that existed at or before `atMs`. */
export function currentSnapshotFor(ledger, fp, gameId, atMs) {
  const hit = snapshotsFor(ledger, fp)
    .filter((s) => s.fields.gameId === gameId && s.fields.capturedAtMs <= atMs);
  return hit[0] ?? null;
}

/* ------------------------------------------------------ stance commitments */

export function commitmentsFor(ledger, fp, matchId) {
  return ledger.byType('stance-commitment')
    .filter((r) => r.fields.fingerprint === fp && r.fields.matchId === matchId)
    .sort((a, b) => a.fields.committedAtMs - b.fields.committedAtMs);
}

export async function commitStance({
  ledger, anchor, publicKey, privateKey, match, team, boundPlatforms = [],
  salt = null, committedAtMs = Date.now(), nonce = null, allowAfterKickoff = false,
}) {
  validateMatch(match);
  if (!match.teams.includes(team)) {
    throw new Error(`team "${team}" is not playing in ${match.matchId}`);
  }

  const fp = await fingerprintOf(publicKey);
  const existing = commitmentsFor(ledger, fp, match.matchId);
  const mode = salt ? 'sealed' : 'plain';

  // After kickoff the match is closed to new commitments. Before kickoff a
  // second commitment IS allowed and both are kept — that is what makes a flip
  // visible rather than hidden. `allowAfterKickoff` exists for the operator
  // seeding historical records, and the resulting record is still labelled
  // 赛后补记 by the verifier.
  if (!allowAfterKickoff && isMatchClosed(ledger, match, Date.now())) {
    throw new Error(`match ${match.matchId} has kicked off; no further commitments are accepted`);
  }

  // A random nonce is part of the signed payload. It makes every commitment
  // unique even when the same person signs the identical claim twice in the
  // same millisecond, so two receipts can never share an id and one receipt can
  // never be replayed as another.
  const commitmentNonce = nonce ?? randomNonce();

  const fields = mode === 'plain'
    ? {
      version: PROTOCOL_VERSION,
      fingerprint: fp,
      matchId: match.matchId,
      gameId: match.gameId,
      team,
      boundPlatforms,
      mode,
      nonce: commitmentNonce,
      committedAtMs,
    }
    : {
      version: PROTOCOL_VERSION,
      fingerprint: fp,
      matchId: match.matchId,
      gameId: match.gameId,
      boundPlatforms,
      mode,
      nonce: commitmentNonce,
      committedAtMs,
      // Hiding the pick: the team is only revealed by opening this hash.
      commitment: await sha256Hex(canonicalJson({ matchId: match.matchId, team, salt })),
    };

  const signature = await signFields('stance-commitment', fields, privateKey);
  const anchorStamp = await anchor.now();

  // The id is derived from the exact bytes that were signed, so it is unique
  // per commitment and cannot be pointed at a different record.
  const receiptId = await makeReceiptId(canonicalJson(fields));

  // publicKey travels unsigned so a verifier holding only the ledger can check
  // the signature. Swapping it only produces a failing verification.
  const record = await ledger.append(
    'stance-commitment',
    {
      ...fields,
      signature,
      receiptId,
      publicKey,
      anchoredAtMs: anchorStamp.unixMs,
    },
    anchorStamp,
  );

  return {
    record,
    receiptId,
    flipFlop: existing.length > 0,
    priorReceiptIds: existing.map((r) => r.fields.receiptId),
    oneLiner: renderOneLiner({
      mode,
      team,
      gameId: match.gameId,
      tier: currentSnapshotFor(ledger, fp, match.gameId, committedAtMs)?.fields.tier ?? null,
      receiptId,
      baseUrl: '',
    }),
  };
}

function randomNonce() {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Receipt id derived from the signed bytes, so it is unique and unforgeable. */
export async function makeReceiptId(signedFieldsJson) {
  const digest = await sha256Hex(utf8(signedFieldsJson));
  return `0x${digest.slice(0, 16)}…${digest.slice(16, 20)}`;
}

export async function sealMatch(ledger, anchor, match, sealedAtMs = Date.now()) {
  validateMatch(match);
  return ledger.append(
    'match-seal',
    {
      version: PROTOCOL_VERSION,
      matchId: match.matchId,
      gameId: match.gameId,
      teams: match.teams,
      kickoffAt: match.kickoffAt,
      kickoffMs: match.kickoffMs,
      sealedAtMs,
    },
    await anchor.now(),
  );
}

export function sealFor(ledger, matchId) {
  return ledger.byType('match-seal').find((r) => r.fields.matchId === matchId) ?? null;
}

/* ------------------------------------------------------------- verification */

/**
 * The one function a receipt page calls. Everything it returns is recomputed
 * from the ledger and re-checked against signatures — nothing is read from a
 * stored boolean, so a doctored field cannot talk its way past this.
 */
export async function verifyReceipt(ledger, { receiptId, match, baseUrl = '' }) {
  const record = ledger.byType('stance-commitment').find((r) => r.fields.receiptId === receiptId);
  if (!record) return { ok: false, error: 'receipt-not-found' };

  const f = record.fields;
  const chain = await ledger.verifyChain();

  // 1. signature over the commitment itself
  const signatureOk = await verifySignature('stance-commitment', stripNonSigned(f), f.signature, f.publicKey);

  // 2. was it committed before kickoff? The *anchor* decides, never the
  //    self-declared committedAtMs — otherwise backdating would be free.
  const seal = sealFor(ledger, f.matchId);
  const kickoffMs = match?.kickoffMs ?? seal?.fields.kickoffMs ?? null;
  const anchoredAtMs = record.timeAnchor.unixMs;
  const beforeKickoff = kickoffMs == null ? null : anchoredAtMs < kickoffMs;

  // 3. is the recorded public key actually the claimed fingerprint?
  const keyMatchesFingerprint = f.publicKey
    ? (await fingerprintOf(f.publicKey)) === f.fingerprint
    : false;

  // 4. did this identity commit more than once for the same match?
  const all = commitmentsFor(ledger, f.fingerprint, f.matchId);
  const flipFlop = all.length > 1;

  // 5. this match's own game, as of kickoff
  const snaps = snapshotsFor(ledger, f.fingerprint);
  const gameSnaps = snaps.filter((s) => s.fields.gameId === f.gameId);
  const atKickoff = kickoffMs == null
    ? gameSnaps[0] ?? null
    : gameSnaps.filter((s) => s.fields.capturedAtMs <= kickoffMs)[0] ?? null;

  const gameSnapshot = atKickoff
    ? {
      tier: atKickoff.fields.tier,
      queue: atKickoff.fields.queue,
      provider: atKickoff.fields.provider,
      provenance: atKickoff.fields.provenance,
      capturedAtMs: atKickoff.fields.capturedAtMs,
      snapshotId: atKickoff.fields.snapshotId,
    }
    : null;

  const weight = weightForMatch({ gameId: f.gameId, snapshot: gameSnapshot });
  const peak = gameSnapshot ? peakFor(snaps.map((s) => s.fields), f.gameId) : null;

  // 6. other games — listed, explicitly not counted toward this match
  const otherGames = gameSnaps.length
    ? groupByGame(snaps.filter((s) => s.fields.gameId !== f.gameId))
    : [];

  const bindings = bindingsFor(ledger, f.fingerprint).map((r) => ({
    platform: r.fields.platform,
    handle: r.fields.handle,
    anchoredAtMs: r.timeAnchor.unixMs,
  }));
  const claimedBindingHonest = (f.boundPlatforms ?? []).every((claimed) =>
    bindings.some((b) => b.platform === claimed.platform && b.handle === claimed.handle));

  const anchorTrust = describeAnchor(record.timeAnchor);

  return {
    ok: true,
    receiptId,
    chain,
    signatureOk,
    keyMatchesFingerprint,
    fingerprint: f.fingerprint,
    match: match ?? { matchId: f.matchId, gameId: f.gameId, teams: f.team ? [f.team] : [] },
    stance: f.mode === 'sealed' ? { mode: 'sealed', team: null } : { mode: 'plain', team: f.team },
    committedAtMs: f.committedAtMs,
    anchoredAtMs,
    anchorTrust,
    kickoffMs,
    beforeKickoff,
    flipFlop,
    commitmentCount: all.length,
    allReceiptIds: all.map((r) => r.fields.receiptId),
    boundPlatforms: bindings,
    claimedBindingHonest,
    gameSnapshot,
    historicalPeak: peak,
    otherGames,
    weight,
    oneLiner: renderOneLiner({
      mode: f.mode,
      team: f.team,
      gameId: f.gameId,
      tier: gameSnapshot?.tier ?? null,
      receiptId,
      baseUrl,
    }),
  };
}

function describeAnchor(timeAnchor) {
  const kind = timeAnchor?.kind ?? 'unknown';
  const table = {
    'opentimestamps': { trust: 'bitcoin', label: '比特币时间戳' },
    'server-anchor': { trust: 'service', label: '服务端时间锚' },
    'local-clock': { trust: 'device', label: '设备本地时钟' },
    'fixed-clock': { trust: 'replayable', label: '固定时钟（演示）' },
  };
  return { kind, ...(table[kind] ?? { trust: 'unknown', label: '未知锚点' }) };
}

function groupByGame(records) {
  const seen = new Map();
  for (const r of records) {
    const gid = r.fields.gameId;
    if (!seen.has(gid)) {
      seen.set(gid, {
        gameId: gid,
        display: displayGame(gid),
        tier: r.fields.tier,
        provenance: r.fields.provenance,
        countsTowardThisMatch: false,
      });
    }
  }
  return [...seen.values()];
}

function stripNonSigned(f) {
  const { signature, receiptId, publicKey, anchoredAtMs, ...rest } = f;
  return rest;
}

/**
 * The single line a fan pastes under a comment.
 *
 * The leading words are for humans and are NOT trusted. Someone can edit "白银"
 * to "王者" and the URL still resolves; the page renders from the signature and
 * flags the mismatch. Everything after 认证 is the only part that carries
 * meaning, and even that only because it resolves to a signed record.
 */
export function renderOneLiner({ mode, team, gameId, tier, receiptId, baseUrl }) {
  const label = mode === 'sealed' ? '赛前保密' : `赛前 ${team}`;
  const tierPart = tier ? ` · ${displayGame(gameId)} ${tier}` : '';
  return `${label}${tierPart} · 认证 ${baseUrl}/p/${receiptId}`;
}

export { PROVENANCE };
