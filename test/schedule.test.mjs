/**
 * Schedule import tests.
 *
 * The importer is the escape hatch from the bundled sample data, so its
 * rejection behaviour matters more than its happy path: a half-applied schedule
 * would leave a community committing to matches that exist on one page and not
 * the other.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  parseSchedule, prepareSchedule, normaliseMatch, parseKickoff, parseCsv,
} from '../core/schedule.js';

const SAMPLE_CSV = `matchId,gameId,teams,kickoffAt
lck-w1,league-of-legends,"T1,BLG",2026-11-01T12:00:00Z
lck-w2,league-of-legends,GEN,JDG,2026-11-02T12:00:00Z`;

describe('kickoff parsing', () => {
  test('accepts ISO with a zone', () => {
    assert.equal(parseKickoff('2026-11-01T12:00:00Z'), '2026-11-01T12:00:00.000Z');
  });

  test('accepts a bare local datetime and pins it to UTC', () => {
    // The same input must mean the same instant on every machine, so a bare
    // datetime is read as UTC rather than the visitor's local zone.
    assert.equal(parseKickoff('2026-11-01 12:00'), '2026-11-01T12:00:00.000Z');
    assert.equal(parseKickoff('2026-11-01 12:00:30'), '2026-11-01T12:00:30.000Z');
  });

  test('rejects junk with a usable message', () => {
    assert.throws(() => parseKickoff('明天晚上'), /无法解析时间/);
    assert.throws(() => parseKickoff(''), /缺少开赛时间/);
  });
});

describe('csv reader', () => {
  test('handles quoted fields containing the separator', () => {
    const rows = parseCsv('a,"b,c",d\n');
    assert.deepEqual(rows, [['a', 'b,c', 'd']]);
  });

  test('handles escaped quotes and CRLF', () => {
    assert.deepEqual(parseCsv('a,"say ""hi""",c\r\n'), [['a', 'say "hi"', 'c']]);
  });

  test('skips blank lines', () => {
    assert.equal(parseCsv('a,b\n\n\nc,d\n').length, 2);
  });
});

describe('schedule parsing', () => {
  test('reads CSV with a header row', () => {
    const { matches, errors } = prepareSchedule(SAMPLE_CSV);
    assert.equal(errors.length, 0);
    assert.equal(matches.length, 2);
    assert.deepEqual(matches[0].teams, ['T1', 'BLG']);
    assert.deepEqual(matches[1].teams, ['GEN', 'JDG']);
  });

  test('reads a JSON array', () => {
    const { matches } = prepareSchedule(JSON.stringify([
      { matchId: 'j1', gameId: 'valorant', teams: ['EDG', 'TE'], kickoffAt: '2026-11-03T12:00:00Z' },
    ]));
    assert.equal(matches.length, 1);
    assert.equal(matches[0].matchId, 'j1');
  });

  test('reads a { matches: [...] } wrapper', () => {
    const { matches } = prepareSchedule(JSON.stringify({
      matches: [{ matchId: 'j2', gameId: 'valorant', teams: ['AG', 'FPX'], kickoffAt: '2026-11-04T12:00:00Z' }],
    }));
    assert.equal(matches[0].matchId, 'j2');
  });

  test('reads CSV without a header row', () => {
    const { matches, errors } = prepareSchedule('x1,valorant,"A,B",2026-12-01T10:00:00Z');
    assert.equal(errors.length, 0);
    assert.equal(matches[0].matchId, 'x1');
  });
});

describe('rejection behaviour', () => {
  test('one bad row rejects only that row, and reports the line', () => {
    const csv = `matchId,gameId,teams,kickoffAt
ok-1,valorant,"A,B",2026-11-01T12:00:00Z
bad-1,not-a-game,"C,D",2026-11-02T12:00:00Z`;
    const { matches, errors } = prepareSchedule(csv);
    assert.equal(matches.length, 1, 'the good row still parses');
    assert.equal(errors.length, 1);
    assert.match(errors[0], /第 3 行/);
    assert.match(errors[0], /未知游戏/);
  });

  test('a match with one team is rejected', () => {
    assert.throws(
      () => normaliseMatch({ matchId: 'x', gameId: 'valorant', teams: ['A'], kickoffAt: '2026-11-01T00:00:00Z' }),
      /至少需要两支队伍/,
    );
  });

  test('a duplicate matchId inside one file is rejected', () => {
    const csv = `matchId,gameId,teams,kickoffAt
dup,valorant,"A,B",2026-11-01T12:00:00Z
dup,valorant,"C,D",2026-11-02T12:00:00Z`;
    const { matches, errors } = prepareSchedule(csv);
    assert.equal(matches.length, 1);
    assert.match(errors[0], /重复/);
  });

  test('empty and unrecognised input fails loudly', () => {
    assert.throws(() => parseSchedule(''), /内容是空的/);
    assert.throws(() => parseSchedule('{not json'), /JSON 解析失败/);
    assert.throws(() => parseSchedule('[]'), /没有找到比赛数组/);
  });
});

describe('teams column spanning', () => {
  test('quoted and unquoted team lists both parse', () => {
    // Regression: a fixed column index dropped the second team for an
    // unquoted "GEN,JDG", which then shifted the kickoff time.
    const csv = `matchId,gameId,teams,kickoffAt
a,valorant,"EDG,TE",2026-11-01T12:00:00Z
b,league-of-legends,GEN,JDG,2026-11-02T12:00:00Z
c,valorant,AG,FPX,TE,2026-11-03T12:00:00Z`;
    const { matches, errors } = prepareSchedule(csv);
    assert.equal(errors.length, 0, errors.join('; '));
    assert.deepEqual(matches[0].teams, ['EDG', 'TE']);
    assert.deepEqual(matches[1].teams, ['GEN', 'JDG']);
    assert.deepEqual(matches[2].teams, ['AG', 'FPX', 'TE']);
    assert.equal(matches[1].kickoffAt, '2026-11-02T12:00:00.000Z');
  });

  test('teamA/teamB columns are honoured', () => {
    const csv = `matchId,gameId,teamA,teamB,kickoffAt
a,valorant,EDG,TE,2026-11-01T12:00:00Z`;
    const { matches, errors } = prepareSchedule(csv);
    assert.equal(errors.length, 0, errors.join('; '));
    assert.deepEqual(matches[0].teams, ['EDG', 'TE']);
  });

  test('headerless rows with a split team list still parse', () => {
    const { matches, errors } = prepareSchedule('a,valorant,EDG,TE,2026-11-01T12:00:00Z');
    assert.equal(errors.length, 0, errors.join('; '));
    assert.deepEqual(matches[0].teams, ['EDG', 'TE']);
    assert.equal(matches[0].kickoffAt, '2026-11-01T12:00:00.000Z');
  });
});
