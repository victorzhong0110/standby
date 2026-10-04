/**
 * Time anchors: the clock that makes "this existed before kickoff" checkable.
 *
 * A commit hash alone cannot prevent backdating — anyone can hash "I supported
 * T1" today and submit it tomorrow. What is missing is a clock nobody can rewind.
 *
 * Four implementations, one interface. `trust` states plainly how much a stamp
 * is worth, because a UI that hides this is lying by omission:
 *
 *   local-clock     — browser Date.now(). Zero infrastructure, and worthless
 *                     against anyone who controls their own clock. Demo only.
 *   server-anchor   — an append-only service with server-side monotonic time.
 *                     Defeats a fan re-setting their clock, not a compromised
 *                     host. The realistic default for a real deployment.
 *   opentimestamps  — the digest is proven to exist inside a Bitcoin block.
 *                     Cannot be backdated without rewriting the chain, and needs
 *                     no trust in whoever runs the site. Free per stamp, but
 *                     confirmation takes minutes to hours.
 *   fixed-clock     — deterministic, for tests and reproducible demo data.
 */

import { sha256Hex, utf8 } from './canonical.js';

/** Browser clock. Explicitly the weakest option; the UI must say so. */
export function localClockAnchor() {
  return {
    kind: 'local-clock',
    trust: 'device',
    label: '设备本地时钟',
    note: '设备本地时钟。用户可自行改表，不具备防作弊能力。',
    async now() {
      const unixMs = Date.now();
      return {
        kind: 'local-clock',
        unixMs,
        stamp: `anc_${(await sha256Hex(utf8(`lc|${unixMs}`))).slice(0, 24)}`,
      };
    },
  };
}

/**
 * Server-anchored stamps. `fetchStamp(postBody, endpoint)` performs the request
 * and resolves with the stamp the service wrote. Used when a deployment pairs
 * the static site with a tiny anchoring service.
 */
export function serverAnchor(fetchStamp, { endpoint = '/api/anchor' } = {}) {
  if (typeof fetchStamp !== 'function') {
    throw new Error('serverAnchor requires a fetchStamp implementation');
  }
  return {
    kind: 'server-anchor',
    trust: 'service',
    label: '服务端时间锚',
    note: '服务端单调时钟。用户改本地时间无效；服务被攻破则失效。',
    async now(pendingDigest) {
      const stamp = await fetchStamp(pendingDigest, endpoint);
      if (!stamp || typeof stamp.unixMs !== 'number') {
        throw new Error('anchor service did not return a usable stamp');
      }
      return stamp;
    },
  };
}

/** OpenTimestamps: submit the digest, receive a pending proof to upgrade later. */
export function openTimestampsAnchor(submit, { pool = 'https://a.pool.opentimestamps.org' } = {}) {
  if (typeof submit !== 'function') {
    throw new Error('openTimestampsAnchor requires a submit implementation');
  }
  return {
    kind: 'opentimestamps',
    trust: 'bitcoin',
    label: '比特币时间戳',
    note: '由比特币区块证明存在，无需信任本站。确认需数分钟到数小时。',
    async now(pendingDigest) {
      const res = await submit(pendingDigest, pool);
      return {
        kind: 'opentimestamps',
        unixMs: res.unixMs,
        pending: res.pending !== false,
        otsProof: res.otsProof ?? null,
        stamp: `ots_${(await sha256Hex(utf8(`ots|${pendingDigest}`))).slice(0, 24)}`,
      };
    },
  };
}

/** Deterministic anchor for tests and for building reproducible demo data. */
export function fixedClockAnchor(startMs) {
  let current = startMs;
  let counter = 0;
  return {
    kind: 'fixed-clock',
    trust: 'replayable',
    label: '固定时钟（演示）',
    note: '固定时钟，仅用于测试与可复现的演示数据。',
    setTo(ms) { current = ms; return this; },
    async now() {
      counter += 1;
      return {
        kind: 'fixed-clock',
        unixMs: current,
        counter,
        stamp: `anc_${(await sha256Hex(utf8(`fc|${current}|${counter}`))).slice(0, 24)}`,
      };
    },
  };
}

/**
 * Pick the strongest anchor actually available. Order matters: OpenTimestamps
 * beats a service we run, which beats the fan's own clock. Anything better than
 * local-clock should be a deliberate deployment decision, not a silent default.
 */
export function bestAvailableAnchor({ opentimestamps, server, local } = {}) {
  if (opentimestamps) return opentimestamps;
  if (server) return server;
  return local ?? localClockAnchor();
}
