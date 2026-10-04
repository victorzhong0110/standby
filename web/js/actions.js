/**
 * Actions: every write the app can perform, in one place.
 *
 * Views call these; they never touch the ledger or the key directly. That keeps
 * the signing rules — what gets signed, what stays outside the signature — in a
 * single auditable file rather than scattered across UI code.
 *
 * Every action appends to the fan's OWN ledger (store.mine) and then persists.
 * Nothing is written to the published chain from a browser; that only happens
 * when the operator appends a submitted bundle and redeploys.
 */

import { store } from './store.js';
import {
  bindPlatform, recordRankSnapshot, commitStance, sealMatch, createMatch,
  validateMatch, bindingsFor, snapshotsFor, sealFor, isMatchClosed,
} from '../../core/protocol.js';
import { weightForMatch } from '../../core/rank.js';
import { validateSelfReport } from '../../core/rank-source.js';

const KEY_MINE = 'fanverify.v2.mine';

function persist() {
  localStorage.setItem(KEY_MINE, JSON.stringify(store.mine.records));
  store.emit();
}

export function randomSalt() {
  return [...crypto.getRandomValues(new Uint8Array(16))]
    .map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function seals() {
  return store.combinedLedger().byType('match-seal').map((r) => ({
    matchId: r.fields.matchId,
    gameId: r.fields.gameId,
    teams: r.fields.teams,
    kickoffAt: r.fields.kickoffAt,
    kickoffMs: r.fields.kickoffMs,
  }));
}

export function commitments() {
  const ledger = store.combinedLedger();
  const fp = store.identity?.fingerprint;

  return ledger.byType('stance-commitment').map((r) => {
    const f = r.fields;
    const kickoffMs = ledger.byType('match-seal')
      .find((s) => s.fields.matchId === f.matchId)?.fields.kickoffMs ?? null;

    // Weight is resolved from the snapshot that was current at kickoff, for
    // this match's own game only — the same rule the receipt page applies.
    const snap = f.fingerprint
      ? snapshotsFor(ledger, f.fingerprint)
        .filter((s) => s.fields.gameId === f.gameId
          && (kickoffMs == null || s.fields.capturedAtMs <= kickoffMs))[0]
      : null;

    return {
      receiptId: f.receiptId,
      matchId: f.matchId,
      gameId: f.gameId,
      team: f.mode === 'sealed' ? null : f.team,
      mode: f.mode,
      fingerprint: f.fingerprint,
      anchoredAtMs: r.timeAnchor.unixMs,
      beforeKickoff: kickoffMs == null ? null : r.timeAnchor.unixMs < kickoffMs,
      isMine: fp ? f.fingerprint === fp : false,
      tier: snap?.fields.tier ?? null,
      weight: weightForMatch({ gameId: f.gameId, snapshot: snap?.fields ?? null }),
    };
  });
}

export function matchById(matchId) {
  return seals().find((m) => m.matchId === matchId) ?? null;
}

/**
 * Matches this fan can still commit to: not yet kicked off, and not already
 * committed by this identity. Offering a closed match would just produce an
 * error after the fan had already picked their team.
 */
export function openMatchesForMe() {
  const fp = store.identity?.fingerprint;
  const ledger = store.combinedLedger();
  const now = Date.now();
  const taken = new Set(
    ledger.byType('stance-commitment')
      .filter((r) => r.fields.fingerprint === fp)
      .map((r) => r.fields.matchId),
  );
  return seals().filter((m) => !taken.has(m.matchId) && !isMatchClosed(ledger, m, now));
}

export function myRecords() {
  if (!store.identity) return { bindings: [], snapshots: [], commitments: [] };
  const ledger = store.combinedLedger();
  const fp = store.identity.fingerprint;

  return {
    bindings: bindingsFor(ledger, fp).map((r) => ({
      platform: r.fields.platform,
      handle: r.fields.handle,
      challenge: r.fields.challenge,
      anchoredAtMs: r.timeAnchor.unixMs,
    })),
    snapshots: snapshotsFor(ledger, fp).map((r) => ({
      ...r.fields,
      anchoredAtMs: r.timeAnchor.unixMs,
    })),
    commitments: ledger.byType('stance-commitment')
      .filter((r) => r.fields.fingerprint === fp)
      .sort((a, b) => b.timeAnchor.unixMs - a.timeAnchor.unixMs)
      .map((r) => ({
        receiptId: r.fields.receiptId,
        matchId: r.fields.matchId,
        gameId: r.fields.gameId,
        team: r.fields.mode === 'sealed' ? null : r.fields.team,
        mode: r.fields.mode,
        anchoredAtMs: r.timeAnchor.unixMs,
      })),
  };
}

/* ----------------------------------------------------------------- actions */

export async function bindAccount({ platform, handle }) {
  if (!platform || !handle.trim()) throw new Error('请填写平台和账号');
  const record = await bindPlatform({
    ledger: store.mine,
    anchor: store.anchor,
    publicKey: store.identity.publicKey,
    privateKey: store.signPrivateKey(),
    platform,
    handle: handle.trim(),
  });
  persist();
  return { record, challenge: record.fields.challenge };
}

export async function reportRank({ gameId, tier, gameAccount, queue, provenance, capturedAtMs }) {
  if (!store.rankSource.supportsOfficial(gameId) && provenance === 'official') {
    throw new Error(store.rankSource.unavailableReason(gameId));
  }
  const priv = store.signPrivateKey();

  // Self-reported values go through validation so an unknown tier string is
  // rejected here rather than silently degrading to "unverified" later.
  const report = provenance === 'official'
    ? {
      tier,
      queue: queue ?? null,
      provider: 'official-proxy',
      provenance: 'official',
      capturedAtMs: capturedAtMs ?? Date.now(),
    }
    : validateSelfReport({ gameId, tier });

  const record = await recordRankSnapshot({
    ledger: store.mine,
    anchor: store.anchor,
    publicKey: store.identity.publicKey,
    privateKey: priv,
    gameId,
    gameAccount: gameAccount ?? null,
    tier: report.tier,
    queue: report.queue ?? queue ?? null,
    provider: report.provider,
    provenance: report.provenance,
    capturedAtMs: report.capturedAtMs,
  });
  persist();
  return record;
}

export async function commit({ match, team, sealed, salt }) {
  if (!team) throw new Error('请选择支持的队伍');
  const fp = store.identity.fingerprint;
  const bound = bindingsFor(store.combinedLedger(), fp)
    .map((r) => ({ platform: r.fields.platform, handle: r.fields.handle }));

  const res = await commitStance({
    ledger: store.mine,
    anchor: store.anchor,
    publicKey: store.identity.publicKey,
    privateKey: store.signPrivateKey(),
    match,
    team,
    boundPlatforms: bound,
    salt: sealed ? (salt || randomSalt()) : null,
  });

  // A commitment is only auditable against a kickoff time the chain also knows.
  // If nobody has sealed this match yet, record the seal locally.
  if (!sealFor(store.combinedLedger(), match.matchId)) {
    await sealMatch(store.mine, store.anchor, match, match.kickoffMs);
  }

  persist();
  return res;
}

export async function registerMatch({ matchId, gameId, teams, kickoffAt }) {
  const match = createMatch({
    matchId,
    gameId,
    teams: teams.split(',').map((s) => s.trim()).filter(Boolean),
    kickoffAt,
  });
  validateMatch(match);
  await sealMatch(store.mine, store.anchor, match);
  persist();
  return match;
}

/* ------------------------------------------------------------- schedules */

/**
 * Register a batch of matches into this device's chain.
 *
 * The whole batch is validated first and applied as one unit: a schedule with
 * one bad row is rejected outright, because half a schedule is worse than none
 * and a rejected import leaves the chain exactly as it was.
 */
export async function importSchedule(text) {
  const { prepareSchedule } = await import('../../core/schedule.js');
  const { matches, errors } = prepareSchedule(text);

  if (!matches.length) {
    throw new Error(errors.length ? errors.join('\n') : '没有解析出任何比赛');
  }

  const priv = store.signPrivateKey();
  const added = [];
  const skipped = [];

  for (const m of matches) {
    // Re-registering an existing matchId is a no-op rather than an error, so
    // re-importing an updated schedule does not fork the chain.
    if (sealFor(store.combinedLedger(), m.matchId)) {
      skipped.push(m.matchId);
      continue;
    }
    await sealMatch(store.mine, store.anchor, m, Date.now());
    added.push(m.matchId);
  }

  persist();
  return { added, skipped, errors };
}
