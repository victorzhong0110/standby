/**
 * Game "成分" (composition): which games a fan plays and at what level.
 *
 * Three rules carry the weight:
 *
 * 1. Snapshots are append-only. A rank never overwrites an earlier one, so a
 *    snapshot taken before kickoff still says what it said at that moment. A
 *    fan who climbs to Master after the match does not rewrite the past.
 *
 * 2. A snapshot counts for a match only if it was captured before kickoff, and
 *    only for *that match's own game*. Being a King in Honor of Kings says
 *    nothing about a League of Legends match, and weighting never borrows
 *    across games.
 *
 * 3. Provenance is part of the data, not a footnote. A rank pulled from Riot's
 *    API and a rank typed in by the fan are not the same claim, so every
 *    snapshot carries how it was obtained and the page renders that plainly.
 */

/**
 * Tier ladders, ordered worst -> best. Weight bands read off the first tiers;
 * the full ladder matters for peak tracking and display.
 */
export const TIER_LADDERS = {
  'league-of-legends': {
    display: '英雄联盟',
    source: 'Riot',
    official: true,
    tiers: [
      '坚韧黑铁', '英勇黄铜', '不屈白银', '荣耀黄金', '华贵铂金', '璀璨钻石',
      '翡翠大师', '大师', '宗师', '最强王者',
    ],
  },
  valorant: {
    display: '瓦洛兰特',
    source: 'Riot',
    official: true,
    tiers: ['铁', '铜', '银', '金', '铂金', '钻石', '超铸', '神话', 'Radiant'],
  },
  'honor-of-kings': {
    display: '王者荣耀',
    source: '—',
    // Tencent does not expose a public rank API. Declared up front rather than
    // discovered later, so nobody ships a fake "official" claim for it.
    official: false,
    tiers: ['青铜', '白银', '黄金', '铂金', '钻石', '星耀', '荣耀王者', '最强王者'],
  },
  steam: {
    display: 'Steam',
    source: 'Steam',
    official: true,
    // Steam has no ladder. Ownership is the only honest claim, so this game
    // can never produce a high weight.
    cap: 'mid',
    tiers: ['未授权', '已授权', '时长充足'],
  },
  faceit: {
    display: 'FACEIT',
    source: 'FACEIT',
    official: true,
    tiers: ['未授权', '银', '黄金', '白金', '钻石', '大师'],
  },
};

/** Public, fixed, auditable. Decided by the match's own game only. */
export const WEIGHT_BANDS = {
  high: { label: '高', minTier: 7, note: '大师及以上' },
  mid: { label: '中', minTier: 4, note: '翡翠到钻石' },
  low: { label: '低', minTier: 0, note: '铂金及以下' },
  unverified: { label: '未认证', minTier: -1, note: '该游戏没有开赛前已锚定的账号快照' },
};

/** How much a snapshot can be trusted, worst to best. Shown on every page. */
export const PROVENANCE = {
  official: { label: '官方接口', trust: 'high', note: '直接来自游戏厂商接口' },
  attested: { label: '他人背书', trust: 'medium', note: '由其他已认证用户签名担保' },
  self: { label: '自报', trust: 'low', note: '用户自行填写，未经第三方核验' },
};

export function ladderFor(gameId) {
  return TIER_LADDERS[gameId] ?? null;
}

export function isKnownGame(gameId) {
  return Boolean(TIER_LADDERS[gameId]);
}

export function tierIndex(gameId, tierName) {
  const ladder = ladderFor(gameId);
  if (!ladder) return -1;
  return ladder.tiers.indexOf(tierName);
}

export function displayGame(gameId) {
  return ladderFor(gameId)?.display ?? gameId;
}

/**
 * Weight for one specific match, from the snapshot that was current at kickoff.
 * Returns the band plus the sentence that produced it, because a reader should
 * be able to check the rule instead of trusting a number.
 */
export function weightForMatch({ gameId, snapshot }) {
  const ladder = ladderFor(gameId);
  if (!ladder) {
    return {
      band: 'unverified', label: WEIGHT_BANDS.unverified.label,
      reason: `未知游戏 ${gameId}`, sourceTier: null,
      rule: `${gameId} 不在已知游戏表内，按未认证处理`,
    };
  }
  if (!snapshot) {
    return {
      band: 'unverified', label: WEIGHT_BANDS.unverified.label,
      reason: WEIGHT_BANDS.unverified.note, sourceTier: null,
      rule: `${ladder.display} 没有开赛前已锚定的账号快照`,
    };
  }
  const idx = tierIndex(gameId, snapshot.tier);
  if (idx < 0) {
    return {
      band: 'unverified', label: WEIGHT_BANDS.unverified.label,
      reason: '快照段位无法在该游戏段位表里定位', sourceTier: snapshot.tier,
      rule: `快照段位「${snapshot.tier}」不在 ${ladder.display} 段位表内，按未认证处理，不上调权重`,
    };
  }
  let band = 'low';
  if (idx >= WEIGHT_BANDS.high.minTier) band = 'high';
  else if (idx >= WEIGHT_BANDS.mid.minTier) band = 'mid';

  // A ladder-less game carries no rank signal at all, so its "low" would be a
  // claim about a ranking that does not exist. Neutral is the honest answer,
  // and it is a ceiling as well: no Steam hours can ever read as "high".
  if (ladder.cap === 'mid') {
    return {
      band: 'mid',
      label: WEIGHT_BANDS.mid.label,
      reason: `${ladder.display} 没有段位体系，权重固定为「中」`,
      sourceTier: snapshot.tier,
      provenance: PROVENANCE[snapshot.provenance] ?? PROVENANCE.self,
      rule: `${ladder.display} ${snapshot.tier} → 中（无段位体系，权重固定，不参与高/低判定）`,
    };
  }

  const prov = PROVENANCE[snapshot.provenance] ?? PROVENANCE.self;
  return {
    band,
    label: WEIGHT_BANDS[band].label,
    reason: WEIGHT_BANDS[band].note,
    sourceTier: snapshot.tier,
    provenance: prov,
    rule: `${ladder.display} ${snapshot.tier} → ${WEIGHT_BANDS[band].label}（${WEIGHT_BANDS[band].note}，来源：${prov.label}）`,
  };
}

/**
 * Highest tier ever observed for this identity in this game, and when it was
 * first anchored. Compared by ladder position, not string order, so 钻石
 * correctly outranks 黄金 in a ladder whose names are not alphabetical.
 */
export function peakFor(snapshots, gameId) {
  const mine = snapshots.filter((s) => s.gameId === gameId);
  if (!mine.length) return null;
  let best = null;
  for (const s of mine) {
    const idx = tierIndex(gameId, s.tier);
    const bestIdx = best ? tierIndex(gameId, best.tier) : -1;
    if (best === null || idx > bestIdx || (idx === bestIdx && s.anchoredAtMs < best.anchoredAtMs)) {
      best = s;
    }
  }
  return {
    tier: best.tier,
    firstAnchoredAtMs: best.anchoredAtMs,
    snapshotId: best.snapshotId,
  };
}
