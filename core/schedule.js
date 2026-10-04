/**
 * Schedule import — the piece that makes the site usable with real data.
 *
 * The bundled ledger is sample data. Without this, a real community would have
 * exactly one option: the operator hand-writes a ledger, which is the
 * hardcoding this module exists to remove.
 *
 * Two input shapes, because real schedules arrive in both:
 *
 *   JSON  [{ "matchId", "gameId", "teams": ["A","B"], "kickoffAt" }, ...]
 *   CSV   matchId,gameId,teams,kickoffAt
 *         lck-2026-s11-w1,league-of-legends,"T1,BLG",2026-11-01T12:00:00Z
 *
 * Every imported match becomes a chain-pinned registration record, so the
 * kickoff time cannot be moved later without breaking the chain — which is the
 * entire basis for calling a commitment "pre-match".
 *
 * Imports are validated up front and applied as one batch: a schedule with one
 * bad row is rejected whole, because half a schedule is worse than none.
 */

import { createMatch, validateMatch } from './protocol.js';
import { isKnownGame, ladderFor } from './rank.js';

/** Accepts ISO-8601 and the "YYYY-MM-DD HH:mm" form people actually paste. */
export function parseKickoff(value) {
  const raw = String(value ?? '').trim();
  if (!raw) throw new Error('缺少开赛时间');

  // Treat a bare local datetime as UTC rather than guessing a browser zone, so
  // the same input yields the same instant on every machine.
  const normalised = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2})?$/.test(raw)
    ? `${raw.replace(' ', 'T').length === 16 ? `${raw.replace(' ', 'T')}:00` : raw.replace(' ', 'T')}Z`
    : raw;

  const ms = new Date(normalised).getTime();
  if (Number.isNaN(ms)) throw new Error(`无法解析时间：${raw}`);
  return new Date(ms).toISOString();
}

/** One row -> a validated match object, with a message a human can act on. */
export function normaliseMatch(raw) {
  const teams = Array.isArray(raw.teams)
    ? raw.teams.map((t) => String(t).trim()).filter(Boolean)
    : String(raw.teams ?? '').split(/[,，]/).map((t) => t.trim()).filter(Boolean);

  if (!raw.matchId) throw new Error('缺少 matchId');
  if (!raw.gameId) throw new Error(`${raw.matchId}: 缺少 gameId`);
  if (!isKnownGame(raw.gameId)) {
    const known = Object.keys(Object.fromEntries(
      Object.entries(ladderFor(raw.gameId) ?? {}),
    ));
    throw new Error(`${raw.matchId}: 未知游戏 "${raw.gameId}"（可选：${KNOWN_GAMES.join(' / ')}）`);
  }
  if (teams.length < 2) {
    throw new Error(`${raw.matchId}: 至少需要两支队伍，收到 ${teams.length} 支`);
  }

  const match = createMatch({
    matchId: String(raw.matchId).trim(),
    gameId: raw.gameId,
    teams,
    kickoffAt: parseKickoff(raw.kickoffAt),
  });
  validateMatch(match);
  return match;
}

const KNOWN_GAMES = [
  'league-of-legends', 'valorant', 'honor-of-kings', 'steam', 'faceit',
];

/** Minimal RFC4180-ish CSV reader: quoted fields, escaped quotes, CRLF. */
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;

  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 1; } else quoted = false;
      } else field += c;
      continue;
    }
    if (c === '"') { quoted = true; continue; }
    if (c === ',' || c === '，') { row.push(field); field = ''; continue; }
    if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i += 1;
      row.push(field);
      if (row.some((f) => f.trim() !== '')) rows.push(row);
      row = []; field = '';
      continue;
    }
    field += c;
  }
  row.push(field);
  if (row.some((f) => f.trim() !== '')) rows.push(row);
  return rows;
}

/** Detect the shape and return raw match objects, or throw with a reason. */
export function parseSchedule(text) {
  const trimmed = String(text ?? '').trim();
  if (!trimmed) throw new Error('内容是空的');

  // JSON
  if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
    let parsed;
    try {
      parsed = JSON.parse(trimmed);
    } catch (e) {
      throw new Error(`JSON 解析失败：${e.message}`);
    }
    const list = Array.isArray(parsed) ? parsed : (parsed.matches ?? parsed.records ?? []);
    if (!Array.isArray(list) || list.length === 0) {
      throw new Error('JSON 里没有找到比赛数组');
    }
    return list;
  }

  // CSV with a header row
  const rows = parseCsv(trimmed);
  if (rows.length === 0) throw new Error('没有解析出任何行');

  const header = rows[0].map((h) => h.trim().toLowerCase());
  const hasHeader = header.includes('matchid') || header.includes('gameid');
  const body = hasHeader ? rows.slice(1) : rows;

  /*
   * `teams` is the ambiguous column. "EDG,TE" may arrive quoted (one field) or
   * bare (two fields), and both must mean the same two teams. Reading a fixed
   * column index silently drops the second team and shifts the kickoff time —
   * the kind of bug that makes a match look like it already kicked off.
   *
   * Resolution: the kickoff is the last field that parses as a time, and every
   * field between the game column and the kickoff is team material. Each such
   * field is then split on commas, so quoted and bare forms converge.
   */
  const col = (name) => (hasHeader ? header.indexOf(name) : -1);
  const idxGame = col('gameid');
  const idxTeams = col('teams');
  const idxKickoff = col('kickoffat');
  const lineNo = (i) => i + (hasHeader ? 2 : 1);

  const looksLikeTime = (v) => {
    try { parseKickoff(v); return true; } catch { return false; }
  };

  const flattenTeams = (cells) => cells
    .flatMap((c) => String(c ?? '').split(/[,，]/))
    .map((t) => t.trim())
    .filter(Boolean);

  return body.map((r, i) => {
    // Explicit two-column form wins when present.
    if (col('teama') >= 0 && col('teamb') >= 0) {
      return {
        matchId: r[col('matchid')] ?? r[0],
        gameId: r[idxGame] ?? r[1],
        teams: [r[col('teama')], r[col('teamb')]].map((t) => String(t ?? '').trim()).filter(Boolean),
        kickoffAt: r[idxKickoff] ?? r[3],
        _line: lineNo(i),
      };
    }

    // Locate the kickoff by position rather than trusting a fixed index.
    let kickIdx = -1;
    for (let k = r.length - 1; k >= 0; k -= 1) {
      if (looksLikeTime(r[k])) { kickIdx = k; break; }
    }
    const kickoffAt = kickIdx >= 0 ? r[kickIdx] : (r[idxKickoff] ?? r[r.length - 1]);

    // Everything after the game column and before the kickoff is team material.
    const gameAt = idxGame >= 0 ? idxGame : 1;
    const teamsFrom = hasHeader && idxTeams >= 0 ? idxTeams : gameAt + 1;
    const teamsTo = kickIdx >= 0 ? kickIdx : (hasHeader ? idxKickoff : r.length - 1);

    return {
      matchId: r[col('matchid')] ?? r[0],
      gameId: r[gameAt] ?? r[1],
      teams: flattenTeams(r.slice(teamsFrom, teamsTo)),
      kickoffAt,
      _line: lineNo(i),
    };
  });
}

/**
 * Validate a whole batch before writing any of it.
 * Returns { matches, errors }. Never partially applies.
 */
export function prepareSchedule(text) {
  const raw = parseSchedule(text);
  const matches = [];
  const errors = [];
  const seen = new Set();

  raw.forEach((item, i) => {
    try {
      const m = normaliseMatch(item);
      if (seen.has(m.matchId)) {
        throw new Error(`${m.matchId}: 赛程里出现了重复的 matchId`);
      }
      seen.add(m.matchId);
      matches.push(m);
    } catch (e) {
      errors.push(item?._line ? `第 ${item._line} 行：${e.message}` : `第 ${i + 1} 条：${e.message}`);
    }
  });

  return { matches, errors };
}
