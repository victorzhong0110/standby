/**
 * Rank proxy — the piece that lets a static site use real game APIs without
 * ever shipping a vendor key.
 *
 * Deploy this as a Cloudflare Worker (or any Node/edge function), set the
 * vendor keys as secrets, and point the site at it:
 *
 *   POST https://your-worker.workers.dev/rank
 *   { "gameId": "league-of-legends", "accountId": "riot-7788" }
 *   -> { "tier": "璀璨钻石", "queue": "单双排", "provider": "riot", "capturedAtMs": 1760000000000 }
 *
 * Why it cannot live in the static bundle:
 *   - Riot production keys expire every 24 hours and are tied to an account.
 *   - Steam and FACEIT keys are long-lived but equally secret.
 *   - A key in front-end JS is a public key. Every visitor could use it, and
 *     it would be scraped within minutes of deployment.
 *
 * The worker is deliberately boring: it only maps an account to a tier. It
 * never sees a fan's private key, and it cannot forge a commitment, because
 * signing happens in the browser.
 *
 * CORS is restricted to the site's own origin via ALLOWED_ORIGIN.
 */

const DEFAULTS = {
  'league-of-legends': { region: 'kr', tier: null },
  valorant: { region: 'eu', tier: null },
};

/** Riot tier divisions, worst -> best. Must stay in ladder order. */
const RIOT_TIERS = [
  '坚韧黑铁', '英勇黄铜', '不屈白银', '荣耀黄金', '华贵铂金', '璀璨钻石',
  '翡翠大师', '大师', '宗师', '最强王者',
];

const VALORANT_TIERS = ['铁', '铜', '银', '金', '铂金', '钻石', '超铸', '神话', 'Radiant'];

function corsHeaders(env) {
  const origin = env.ALLOWED_ORIGIN ?? '*';
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
  };
}

function json(body, status, env) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...corsHeaders(env) },
  });
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders(env) });
    if (request.method !== 'POST') return json({ error: 'POST only' }, 405, env);

    const url = new URL(request.url);
    if (url.pathname === '/health') {
      return json({
        ok: true,
        configured: Boolean(env.RIOT_API_KEY),
        supported: Object.keys(DEFAULTS),
      }, 200, env);
    }
    if (url.pathname !== '/rank') return json({ error: 'not found' }, 404, env);

    let body;
    try {
      body = await request.json();
    } catch {
      return json({ error: 'invalid JSON body' }, 400, env);
    }

    const { gameId, accountId } = body ?? {};
    if (!gameId || !accountId) return json({ error: 'gameId and accountId are required' }, 400, env);
    if (!DEFAULTS[gameId]) return json({ error: `unsupported game: ${gameId}` }, 400, env);
    if (!env.RIOT_API_KEY) {
      return json({ error: 'RIOT_API_KEY is not configured on this worker' }, 503, env);
    }

    // NOTE: the real call needs the fan's authenticated account token, obtained
    // via Riot Sign On. A production deployment exchanges that here and never
    // returns it to the browser. The shape below is the contract the site
    // expects; fill in the token exchange for your deployment.
    //
    // const entry = await lookupRiotAccount(env.RIOT_API_KEY, gameId, accountId, token);
    // return json({ tier: entry.tier, queue: entry.queue, provider: 'riot',
    //               capturedAtMs: Date.now() }, 200, env);

    return json({
      error: 'Riot account lookup is not implemented in this reference worker',
      detail: 'See the comment in src/proxy-worker.js for the contract and the required flow.',
      gameId,
      accountId,
      availableTiers: gameId === 'valorant' ? VALORANT_TIERS : RIOT_TIERS,
    }, 501, env);
  },
};
