/**
 * Rank sources: where a tier actually comes from.
 *
 * A published app that claims to check "real" ranks has to be honest about the
 * difference between a number it fetched from Riot's API and a number a fan
 * typed in. Both are allowed; they are never conflated, and the tier's
 * provenance travels with it into the signature and onto every page.
 *
 * OFFICIAL mode needs a small proxy that holds the game vendor's API key:
 *
 *   - Riot keys are short-lived and must not be shipped in a static bundle, or
 *     every visitor can read and abuse them.
 *   - Steam and FACEIT keys are long-lived but equally secret.
 *   - Tencent does not expose a public rank API at all, so Honor of Kings can
 *     only ever be self-reported here. TIER_LADDERS says so out loud.
 *
 * With no proxy configured the app degrades to SELF mode and labels every
 * affected receipt accordingly. It never silently pretends otherwise.
 */

import { isKnownGame, ladderFor } from './rank.js';

export const SOURCE = {
  official: 'official',
  self: 'self',
};

/**
 * Games we can fetch from a vendor API through a proxy. Kept as a literal so
 * the site has no import graph beyond core/, and deliberately separate from
 * TIER_LADDERS[].official — that flag says the vendor exposes an API, this set
 * says we have wired a proxy for it.
 */
export const OFFICIAL_CAPABLE = new Set(['league-of-legends', 'valorant', 'steam', 'faceit']);

/**
 * Build a rank fetcher.
 *
 * `proxyUrl` is the base URL of a service that holds the vendor key, e.g.
 * https://rank-proxy.example.workers.dev. Passing null means self-report only.
 */
export function createRankSource({ proxyUrl = null, fetchImpl = globalThis.fetch } = {}) {
  const configured = Boolean(proxyUrl);

  return {
    configured,
    proxyUrl,

    /** Can this game be fetched from a vendor API at all? */
    supportsOfficial(gameId) {
      return configured && OFFICIAL_CAPABLE.has(gameId);
    },

    /** Why official is unavailable, phrased for the UI. */
    unavailableReason(gameId) {
      const ladder = ladderFor(gameId);
      if (!ladder) return `未知游戏 ${gameId}`;
      if (!OFFICIAL_CAPABLE.has(gameId)) {
        return `${ladder.display} 没有公开的段位接口（${ladder.source} 未对公众开放），只能自报`;
      }
      if (!configured) return '本站未配置段位代理服务，只能自报';
      return null;
    },

    /**
     * Fetch a tier from the official API.
     *
     * The caller must have obtained the account via the vendor's own OAuth or
     * the in-game client; this only turns that account into a rank. Any failure
     * is surfaced verbatim — a rank we cannot fetch is never downgraded into a
     * plausible-looking guess.
     */
    async fetchOfficial({ gameId, accountId }) {
      if (!this.supportsOfficial(gameId)) {
        throw new Error(this.unavailableReason(gameId));
      }
      const ladder = ladderFor(gameId);
      const res = await fetchImpl(`${proxyUrl.replace(/\/$/, '')}/rank`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ gameId, accountId }),
      });
      if (!res.ok) {
        const detail = await res.text().catch(() => '');
        throw new Error(`段位服务返回 ${res.status}${detail ? `：${detail.slice(0, 200)}` : ''}`);
      }
      const data = await res.json();
      if (!data?.tier) throw new Error('段位服务没有返回段位');
      if (ladder && !ladder.tiers.includes(data.tier)) {
        throw new Error(`段位服务返回了「${data.tier}」，不在 ${ladder.display} 段位表内`);
      }
      return {
        tier: data.tier,
        queue: data.queue ?? null,
        provider: data.provider ?? ladder?.source ?? 'official',
        provenance: SOURCE.official,
        gameAccount: accountId,
        capturedAtMs: data.capturedAtMs ?? Date.now(),
      };
    },
  };
}

/**
 * Validate a self-reported tier. Kept strict on purpose: an unknown tier string
 * would silently become "unverified" at weighting time, which is a worse
 * outcome for the fan than being told the value is wrong.
 */
export function validateSelfReport({ gameId, tier }) {
  if (!isKnownGame(gameId)) throw new Error(`未知游戏 ${gameId}`);
  const ladder = ladderFor(gameId);
  if (!tier) throw new Error('请选择段位');
  if (!ladder.tiers.includes(tier)) {
    throw new Error(`「${tier}」不在 ${ladder.display} 段位表内`);
  }
  return {
    tier,
    queue: null,
    provider: 'self-reported',
    provenance: SOURCE.self,
    capturedAtMs: Date.now(),
  };
}
