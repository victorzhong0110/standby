/**
 * Build the public ledger shipped with the site.
 *
 * Deterministic: the same input always produces the same chain, so rebuilding
 * and redeploying does not churn the published records. Uses a fixed clock, so
 * timestamps in the seed data are chosen rather than observed — that is a demo
 * artefact and the anchor kind says so.
 *
 *   node tools/make-public-ledger.mjs
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Ledger } from '../core/ledger.js';
import { fixedClockAnchor } from '../core/anchor.js';
import { generateIdentity, importPrivateKey } from '../core/keys.js';
import {
  createMatch, bindPlatform, recordRankSnapshot, commitStance, sealMatch, verifyReceipt,
} from '../core/protocol.js';
import { verifyBundle, exportBundle } from '../core/bundle.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = join(__dirname, '..', 'web', 'data', 'ledger.json');

// Kickoffs are computed from the build time rather than hard-coded dates.
//
// The demo only makes sense if, whenever it is deployed, two matches have
// already finished (so 赛后清算 and the 改口 / 赛后补记 verdicts are visible)
// and two are still open (so a first-time visitor has something to commit to).
// Fixed dates would silently drift until every match read 未开赛 and the whole
// point of the site disappeared.
const NOW = Date.now();
const HOUR = 3600_000;
const daysFromNow = (d) => new Date(NOW + d * 24 * HOUR).toISOString();

const MATCHES = {
  // Finished: supports the settled-result views.
  lck: createMatch({
    matchId: 'lck-2026-s10-final',
    gameId: 'league-of-legends',
    teams: ['T1', 'JDG'],
    kickoffAt: daysFromNow(-3),
  }),
  vct: createMatch({
    matchId: 'vct-cn-2026-final',
    gameId: 'valorant',
    teams: ['EDG', 'TE'],
    kickoffAt: daysFromNow(-1),
  }),
  // Open: what a new visitor commits to, so the shipped site is usable rather
  // than only readable.
  open: createMatch({
    matchId: 'lck-2026-s11-week1',
    gameId: 'league-of-legends',
    teams: ['BLG', 'WBG'],
    kickoffAt: daysFromNow(6),
  }),
  openV: createMatch({
    matchId: 'vct-cn-2026-week1',
    gameId: 'valorant',
    teams: ['AG', 'FPX'],
    kickoffAt: daysFromNow(7),
  }),
};

const FANS = {};
for (const name of ['diamond', 'silver', 'flipper', 'liar', 'quiet']) {
  FANS[name] = await generateIdentity();
}

const ledger = new Ledger();
const clock = fixedClockAnchor(NOW - 20 * 24 * HOUR);
const at = (iso) => clock.setTo(Date.parse(iso));
/** Commit at the clock's current time, so demo timestamps are deterministic. */
const stamp = () => clock.currentMs;

/* 1. diamond — clean, high weight, real API-sourced rank */
{
  const { publicKey, privateKey } = FANS.diamond;
  const priv = await importPrivateKey(privateKey);
  at(daysFromNow(-19));
  await bindPlatform({ ledger, anchor: clock, publicKey, privateKey: priv, platform: 'weibo', handle: 'ts_fan_01' });
  await bindPlatform({ ledger, anchor: clock, publicKey, privateKey: priv, platform: 'bilibili', handle: 'tsfan01' });
  at(daysFromNow(-14));
  await recordRankSnapshot({
    ledger, anchor: clock, publicKey, privateKey: priv,
    gameId: 'league-of-legends', gameAccount: 'riot-7788', tier: '璀璨钻石',
    queue: '单双排', provider: 'Riot League Account API', provenance: 'official',
    capturedAtMs: NOW - 14 * 24 * HOUR,
  });
  at(daysFromNow(-4));
  await commitStance({
    ledger, anchor: clock, publicKey, privateKey: priv, match: MATCHES.lck, team: 'T1',
    committedAtMs: stamp(),
    allowAfterKickoff: true, // history, written by the operator after the fact
  });
}

/* 2. silver — LoL silver, Honor of Kings king. Only LoL counts for an LoL match. */
{
  const { publicKey, privateKey } = FANS.silver;
  const priv = await importPrivateKey(privateKey);
  at(daysFromNow(-18));
  await bindPlatform({ ledger, anchor: clock, publicKey, privateKey: priv, platform: 'weibo', handle: 'koc_fan_9' });
  at(daysFromNow(-13));
  await recordRankSnapshot({
    ledger, anchor: clock, publicKey, privateKey: priv,
    gameId: 'honor-of-kings', gameAccount: 'ow#998877', tier: '最强王者',
    provider: 'self-reported', provenance: 'self',
    capturedAtMs: NOW - 13 * 24 * HOUR,
  });
  await recordRankSnapshot({
    ledger, anchor: clock, publicKey, privateKey: priv,
    gameId: 'league-of-legends', gameAccount: 'riot-1234', tier: '不屈白银',
    queue: '单双排', provider: 'self-reported', provenance: 'self',
    capturedAtMs: NOW - 13 * 24 * HOUR,
  });
  at(daysFromNow(-3.5));
  await commitStance({
    ledger, anchor: clock, publicKey, privateKey: priv, match: MATCHES.lck, team: 'JDG',
    committedAtMs: stamp(),
    allowAfterKickoff: true,
  });
  // Climbs to Master *after* the demo point; must not rewrite the past.
  at(daysFromNow(-1));
  await recordRankSnapshot({
    ledger, anchor: clock, publicKey, privateKey: priv,
    gameId: 'league-of-legends', gameAccount: 'riot-1234', tier: '宗师',
    queue: '单双排', provider: 'self-reported', provenance: 'self',
    capturedAtMs: NOW - 1 * 24 * HOUR,
  });
}

/* 3. flipper — two commitments before kickoff; both are kept and flagged */
{
  const { publicKey, privateKey } = FANS.flipper;
  const priv = await importPrivateKey(privateKey);
  at(daysFromNow(-17));
  await bindPlatform({ ledger, anchor: clock, publicKey, privateKey: priv, platform: 'nga', handle: 'nga_user_22' });
  at(daysFromNow(-1.2));
  await commitStance({
    ledger, anchor: clock, publicKey, privateKey: priv, match: MATCHES.vct, team: 'EDG',
    committedAtMs: stamp(),
    allowAfterKickoff: true,
  });
  at(daysFromNow(-0.5));
  await commitStance({
    ledger, anchor: clock, publicKey, privateKey: priv, match: MATCHES.vct, team: 'TE',
    committedAtMs: stamp(),
    allowAfterKickoff: true,
  });
}

/* 4. liar — backdates a claimed timestamp; the anchor refuses to be fooled */
{
  const { publicKey, privateKey } = FANS.liar;
  const priv = await importPrivateKey(privateKey);
  at(daysFromNow(0.2)); // after the VCT match started
  await commitStance({
    ledger, anchor: clock, publicKey, privateKey: priv, match: MATCHES.vct, team: 'EDG',
    committedAtMs: NOW - 1.5 * 24 * HOUR, // the lie
    // Seeded by the operator after the fact; the verifier still calls it
    // 赛后补记 because the anchor, not the claimed time, decides.
    allowAfterKickoff: true,
  });
}

/* 5. quiet — pre-kickoff, but no rank snapshot for this game at all */
{
  const { publicKey, privateKey } = FANS.quiet;
  const priv = await importPrivateKey(privateKey);
  at(daysFromNow(-16));
  await bindPlatform({ ledger, anchor: clock, publicKey, privateKey: priv, platform: 'discord', handle: 'quiet_one' });
  at(daysFromNow(-2));
  await commitStance({
    ledger, anchor: clock, publicKey, privateKey: priv, match: MATCHES.lck, team: 'T1',
    committedAtMs: stamp(),
    allowAfterKickoff: true, // history, written by the operator after the fact
  });
}

/* Seals last so every commitment has a kickoff time to be judged against. */
at(daysFromNow(-2.9));
await sealMatch(ledger, clock, MATCHES.lck, MATCHES.lck.kickoffMs);
at(daysFromNow(-0.9));
await sealMatch(ledger, clock, MATCHES.vct, MATCHES.vct.kickoffMs);
at(daysFromNow(-1));
await sealMatch(ledger, clock, MATCHES.open, MATCHES.open.kickoffMs);
await sealMatch(ledger, clock, MATCHES.openV, MATCHES.openV.kickoffMs);

/* ------------------------------------------------------------------ output */

const bundle = exportBundle(ledger, {
  note: 'fanverify public ledger v2 — seeded demo records',
  exportedAt: new Date(NOW).toISOString(),
});

const check = await verifyBundle(bundle);
if (!check.chainOk) throw new Error(`generated ledger chain is broken at ${check.chainBrokenAt}`);
if (!check.allSignaturesValid) {
  throw new Error(`generated ledger has ${check.badRecords.length} invalid signature(s)`);
}

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, `${JSON.stringify(bundle, null, 2)}\n`);

console.log(`wrote ${OUT}`);
console.log(`  records: ${check.recordCount} (${check.signedCount} signed, ${check.operatorCount} operator)`);
console.log(`  chain: OK   all signatures: OK`);

for (const m of Object.values(MATCHES)) {
  const rows = ledger.byType('stance-commitment').filter((r) => r.fields.matchId === m.matchId);
  console.log(`\n${m.matchId} (${m.teams.join(' vs ')})`);
  for (const r of rows) {
    const v = await verifyReceipt(ledger, { receiptId: r.fields.receiptId, match: m, baseUrl: '' });
    const flags = [
      v.beforeKickoff ? '赛前' : '赛后补记',
      v.flipFlop ? '改口' : null,
      `权重:${v.weight.label}`,
    ].filter(Boolean).join(' / ');
    console.log(`  ${r.fields.receiptId}  ${(v.stance.team ?? '保密').padEnd(4)}  ${flags}`);
  }
}
