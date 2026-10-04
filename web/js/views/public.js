/**
 * Public views — the pages a reader lands on. No account needed, no writes.
 *
 * The copy is written to be *read*, not scanned: each page opens with what the
 * page is for, then shows the evidence, then says plainly what it cannot prove.
 * A reader who arrives from a comment link should understand the verdict before
 * they understand the mechanism.
 */

import {
  h, card, kv, pill, weightPill, banner, bannerList, codeBlock, empty,
  fmtTime, fmtCountdown, stat, fixture, crest,
} from '../ui.js';
import { store } from '../store.js';
import { seals, commitments, matchById } from '../actions.js';
import { verifyReceipt, isMatchClosed } from '../../../core/protocol.js';
import { displayGame, PROVENANCE } from '../../../core/rank.js';

/* -------------------------------------------------------------------- home */

export async function homeView() {
  if (!store.usable) return brokenLedgerPage();

  const ledger = store.combinedLedger();
  const chain = await ledger.verifyChain();
  const allSeals = seals();
  const allCommitments = commitments();
  const now = Date.now();
  const openMatches = allSeals.filter((m) => !isMatchClosed(ledger, m, now));

  const pre = allCommitments.filter((c) => {
    const m = matchById(c.matchId);
    return m && c.anchoredAtMs < m.kickoffMs;
  }).length;
  const flipped = allCommitments.filter((c) => {
    const fp = c.fingerprint;
    return allCommitments.filter((o) => o.fingerprint === fp && o.matchId === c.matchId).length > 1;
  }).length;
  const weighted = allCommitments.filter((c) => c.weight && c.weight.band !== 'unverified').length;

  return h('div', {},
    h('section', { class: 'hero' },
      h('div', { class: 'hero-inner' },
        h('p', { class: 'eyebrow' }, 'Pre-match commitment · 赛前站队核对'),
        h('h1', { class: 'display' }, '赛前的立场，', h('br'), '赛后', h('em'), '算得清'),
        h('p', { class: 'lede' },
          '结果出来之后才补一句「我早就看好 X」——这种事没法靠自觉解决。'
          + '这里的做法是：开赛前签一条只能由你签的记录，'
          + '任何人点开你的评论都能当场验。'),
        h('div', { class: 'hero-actions' },
          h('a', { class: 'btn btn-primary', href: '#/start' }, '建立我的身份'),
          h('a', { class: 'btn btn-ghost', href: '#/how' }, '它凭什么可信')))),

    h('div', { class: 'stat-rail' },
      stat(allSeals.length, '已登记比赛'),
      stat(allCommitments.length, '条赛前承诺'),
      stat(pre, '条经得起时间检验'),
      stat(flipped, '次赛前改口')),

    chain.ok
      ? banner('ok', h('strong', {}, '账本完整。'),
        ` ${chain.length} 条记录构成一条哈希链，逐条校验通过。任何人下载后都能自己复算。`)
      : banner('bad', h('strong', {}, `账本在第 ${chain.brokenAt} 条断裂。`), ' 本页结论不可采信。'),

    h('p', { class: 'dim small', style: { marginTop: '-6px', marginBottom: '18px' } },
      store.mergeNote, store.ledgerNotice ? ` ${store.ledgerNotice}` : ''),

    // The bundled ledger is sample data. Saying so is the difference between a
    // demo and something a stranger would otherwise mistake for real results.
    !store.ledgerUrlIsRemote
      ? banner('warn',
        h('strong', {}, '你看到的比赛和承诺是随站点发布的示例数据，不是真实赛程。'),
        h('div', { class: 'muted small', style: { marginTop: '6px' } },
          '它由构建脚本生成，用来演示核对流程长什么样。',
          '要接真实赛程：',
          h('a', { href: '#/schedule' }, '导入你的赛程'),
          '（支持 CSV / JSON），或在 ',
          h('a', { href: '#/settings' }, '设置'), ' 里把账本指向你自己托管的 JSON。'))
      : null,

    card('时间锚：这套东西的软肋在哪',
      h('p', { style: { margin: '0 0 10px' } },
        h('strong', {}, store.anchor.label ?? store.anchor.kind), ' — ', store.anchor.trust),
      h('p', { class: 'muted small', style: { margin: 0 } }, store.anchor.note),
      store.anchor.trust === 'device'
        ? h('p', { class: 'muted small', style: { margin: '10px 0 0' } },
          '也就是说：现在你完全可以把自己的电脑时间调回去再签一条。'
          + '签名是真的，但「赛前」这件事还没有外部证据。'
          + '部署方接入时间锚服务、或改用 OpenTimestamps（比特币区块背书）之后，'
          + '这一条才会真正站得住。')
        : null),

    openMatches.length
      ? card('现在可以站队',
        h('div', { class: 'grid' },
          h('table', {},
            h('thead', {}, h('tr', {},
              h('th', {}, '比赛'), h('th', {}, '项目'), h('th', {}, '对阵'),
              h('th', {}, '开赛'), h('th', {}, '倒计时'))),
            h('tbody', {}, openMatches.map((m) => h('tr', {},
              h('td', {}, h('a', { href: `#/m/${encodeURIComponent(m.matchId)}` },
                h('span', { class: 'mono' }, m.matchId))),
              h('td', {}, displayGame(m.gameId)),
              h('td', {}, fixture(m.teams)),
              h('td', { class: 'num' }, fmtTime(m.kickoffMs)),
              h('td', {}, h('a', { class: 'num', href: '#/commit', style: { color: 'var(--gold)' } },
                fmtCountdown(m.kickoffMs)))))))),
        h('p', { class: 'muted small', style: { margin: '12px 0 0' } },
          '开赛前可以反复签，两条都会留着，核对页会标成改口——藏不住，也没必要藏。'))
      : null,

    card('已结束的清算',
      allSeals.length
        ? h('div', { class: 'grid' },
          h('table', {},
            h('thead', {}, h('tr', {},
              h('th', {}, '比赛'), h('th', {}, '对阵'), h('th', {}, '赛前'),
              h('th', {}, '赛后补记'), h('th', {}, '权重样本'))),
            h('tbody', {}, allSeals.filter((m) => isMatchClosed(ledger, m, now)).map((m) => {
              const rows = allCommitments.filter((c) => c.matchId === m.matchId);
              const preN = rows.filter((c) => c.anchoredAtMs < m.kickoffMs).length;
              const postN = rows.length - preN;
              return h('tr', {},
                h('td', {}, h('a', { href: `#/m/${encodeURIComponent(m.matchId)}` },
                  h('span', { class: 'mono' }, m.matchId))),
                h('td', {}, fixture(m.teams)),
                h('td', {}, h('span', { class: 'num', style: { color: preN ? 'var(--good)' : 'var(--text-3)' } },
                  String(preN))),
                h('td', {}, h('span', { class: 'num', style: { color: postN ? 'var(--bad)' : 'var(--text-3)' } },
                  String(postN))),
                h('td', {}, String(rows.filter((c) => c.weight && c.weight.band !== 'unverified').length)));
            }))))
        : h('p', { class: 'muted' }, '还没有已结束的比赛。'),
      h('p', { class: 'muted small', style: { margin: '12px 0 0' } },
        '只统计签名有效、且时间锚早于开赛的承诺。'
        + '改口的人会同时出现在两边的收据里——这正是它有意义的地方。')),

    allCommitments.length
      ? card('全部收据',
        h('div', { class: 'grid' },
          h('table', {},
            h('thead', {}, h('tr', {},
              h('th', {}, '收据'), h('th', {}, '比赛'), h('th', {}, '站队'),
              h('th', {}, '权重'), h('th', {}, '时间锚'))),
            h('tbody', {}, allCommitments
              .slice().sort((a, b) => b.anchoredAtMs - a.anchoredAtMs)
              .map((c) => h('tr', {},
                h('td', {}, h('a', { class: 'mono', href: `#/p/${encodeURIComponent(c.receiptId)}` },
                  c.receiptId)),
                h('td', { class: 'small dim' }, c.matchId),
                h('td', {}, c.team
                  ? h('span', { class: 'num', style: { color: 'var(--gold)' } }, c.team)
                  : h('em', { class: 'dim' }, '赛前保密')),
                h('td', {}, pill(c.weight.label,
                  { high: 'band-high', mid: 'band-mid', low: 'band-low' }[c.weight.band] ?? 'band-unverified')),
                h('td', { class: 'num small dim' }, fmtTime(c.anchoredAtMs))))))))
      : null,

    card('它能证明什么，不能证明什么',
      h('div', { class: 'grid' },
        h('table', {},
          h('thead', {}, h('tr', {}, h('th', { style: { width: '110px' } }, ''),
            h('th', {}, '说清楚'), h('th', {}, '理由'))),
          h('tbody', {},
            row('能', '这条支持记录确实是这把密钥在开赛前签的',
              '签名 + 时间锚写在哈希链里，改一个字就对不上。', 'good'),
            row('能', '这个号在这场比赛所属游戏里是什么水平',
              '只按本场游戏的开赛前段位算，不跨游戏借用。', 'good'),
            row('不能', '签名背后是真人',
              '一人多号、买号、代打都挡不住。这里只保证「可归因」，不保证「唯一」。', 'bad'),
            row('不能', '段位属实',
              '除非该游戏接了官方接口。接不上时页面上会明确写「自报」。', 'bad'),
            row('不能', '运营者本人没动过账本',
              '但账本公开可下载，改一条后面全断，断在第几条会直接显示出来。', 'warn'))))));
}

function row(tone, what, why, cls) {
  return h('tr', {},
    h('td', {}, h('span', { class: `num ${cls}` }, tone)),
    h('td', {}, h('strong', {}, what)),
    h('td', { class: 'muted small' }, why));
}

function brokenLedgerPage() {
  return h('div', {},
    h('section', { class: 'hero' }, h('div', { class: 'hero-inner' },
      h('p', { class: 'eyebrow' }, 'Chain verification failed'),
      h('h1', { class: 'display' }, '公开账本', h('em'), '校验失败'),
      h('p', { class: 'lede' }, store.mergeNote))),
    banner('bad', h('strong', {}, `哈希链在第 ${store.publicLedgerBroken} 条断裂。`),
      ' 本站不会基于一条校验不过的账本给出任何站队或权重的判定。'),
    card('这意味着什么',
      h('p', { class: 'muted' },
        '账本是追加写的哈希链：每条记录都包含前一条的摘要。改动其中任何一条，'
        + '从它开始后面所有记录的链接都会对不上，而断裂的位置会被精确指出来。'),
      h('p', { class: 'muted small' },
        '这不是「某个收据坏了」，而是「有人动过历史记录」。'
        + '在你比对清楚之前，请不要相信这里显示的任何内容。'),
      h('p', { style: { margin: 0 } },
        '下载 ', h('a', { href: './data/ledger.json', download: '' }, 'data/ledger.json'),
        '，找到对应序号改动一条，然后回来刷新，结论会立刻变成拒绝展示。')));
}

/* ---------------------------------------------------------------- receipt */

export async function receiptView(receiptId) {
  if (!store.usable) return brokenLedgerPage();

  const match = (() => {
    const rec = store.combinedLedger().byType('stance-commitment')
      .find((r) => r.fields.receiptId === receiptId);
    return rec ? matchById(rec.fields.matchId) : null;
  })();

  const v = await verifyReceipt(store.combinedLedger(), {
    receiptId, match, baseUrl: location.origin,
  });

  if (!v.ok) {
    return h('div', {},
      h('div', { class: 'page-head' },
        h('div', {},
          h('p', { class: 'eyebrow' }, 'Receipt not found'),
          h('h1', {}, '这条收据不在账本里'))),
      empty('也可能是它来自一份还没被收录的账本包。',
        h('a', { class: 'btn btn-ghost', href: '#/' }, '回到首页')));
  }

  const problems = [];
  if (!v.chain.ok) {
    problems.push({ title: `账本链在第 ${v.chain.brokenAt} 条断裂。`, detail: '历史记录被改动过，本页所有结论不可采信。' });
  }
  if (!v.signatureOk) {
    problems.push({ title: '签名无效。', detail: '无法用记录自带的公钥验证，内容被改写或公钥被掉包。' });
  }
  if (!v.keyMatchesFingerprint) {
    problems.push({ title: '公钥与指纹不符。', detail: '记录的指纹不是它自带的公钥算出来的，至少有一个是假的。' });
  }
  if (v.beforeKickoff === false) {
    problems.push({
      title: '赛后补记。',
      detail: `时间锚 ${fmtTime(v.anchoredAtMs)} 晚于开赛 ${fmtTime(v.kickoffMs)}。`
        + '签名是真的，但它证明不了赛前站队。',
    });
  }
  if (v.flipFlop) {
    problems.push({
      title: '赛前改口。',
      detail: `同一身份为这场比赛提交了 ${v.commitmentCount} 次承诺，全部保留，全部可查。`,
    });
  }

  const prov = v.gameSnapshot ? (PROVENANCE[v.gameSnapshot.provenance] ?? PROVENANCE.self) : null;

  return h('div', {},
    h('div', { class: 'page-head' },
      h('div', {},
        h('p', { class: 'eyebrow' }, 'Receipt · 收据核对'),
        h('h1', { class: 'display', style: { fontSize: '32px' } }, v.match.matchId),
        h('p', { class: 'muted' }, displayGame(v.match.gameId)),
        h('div', { style: { marginTop: '10px' } }, fixture(v.match.teams ?? []))),
      h('div', { class: 'head-right' },
        weightPill(v.weight),
        h('div', { class: 'num small dim', style: { marginTop: '6px' } }, `开赛 ${fmtTime(v.kickoffMs)}`))),

    problems.length
      ? bannerList(problems)
      : banner('ok', h('strong', {}, '赛前站队已锁定。'),
        ` 时间锚 ${fmtTime(v.anchoredAtMs)}，早于开赛 ${fmtTime(v.kickoffMs)}。`),

    card('赛前锁定',
      h('p', { class: 'stance-line' },
        v.stance.mode === 'sealed'
          ? h('em', { class: 'dim' }, '赛前保密（只发了哈希，赛后揭示站了谁）')
          : h('span', {}, '这场站 ', h('span', { class: 'team' }, v.stance.team))),
      kv([
        ['时间锚', h('span', {},
          h('span', { class: 'num' }, fmtTime(v.anchoredAtMs)),
          h('div', { class: 'muted small' }, `来源：${v.anchorTrust.label}`))],
        ['早于开赛', v.beforeKickoff === null
          ? h('span', { class: 'dim' }, '未知（这场比赛没有登记开赛时间）')
          : (v.beforeKickoff
            ? h('strong', { class: 'good' }, '是')
            : h('strong', { class: 'bad' }, '否'))],
        ['这一场的承诺次数', h('span', { class: 'num' }, String(v.commitmentCount))],
        ['链完整性', v.chain.ok
          ? h('strong', { class: 'good' }, `通过（${v.chain.length} 条）`)
          : h('strong', { class: 'bad' }, `断裂 @ ${v.chain.brokenAt}`)],
      ])),

    card('他在这场比赛里算不算内行',
      kv([
        v.gameSnapshot
          ? ['本场游戏成分', h('span', {},
            h('strong', {}, `${displayGame(v.match.gameId)} ${v.gameSnapshot.tier}`),
            v.gameSnapshot.queue ? h('span', { class: 'dim' }, ` · ${v.gameSnapshot.queue}`) : null,
            h('div', { class: 'muted small' },
              `快照 ${fmtTime(v.gameSnapshot.capturedAtMs)} · 来源：`,
              v.gameSnapshot.provenance === 'official'
                ? h('span', { class: 'good' }, '官方接口')
                : (prov?.label ?? '自报')))]
          : ['本场游戏成分', h('span', {},
            h('strong', { class: 'dim' }, '未认证'),
            h('div', { class: 'muted small' },
              `${displayGame(v.match.gameId)} 没有开赛前已锚定的账号快照，不上调权重`))],
        v.historicalPeak
          ? ['同游戏历史最高', h('span', {},
            h('span', { class: 'num' }, v.historicalPeak.tier),
            h('div', { class: 'muted small' }, `首次锚定于 ${fmtTime(v.historicalPeak.firstAnchoredAtMs)}`))]
          : null,
        v.otherGames.length
          ? ['其他游戏', h('span', {},
            v.otherGames.map((g) => `${g.display} ${g.tier}`).join('，'),
            h('div', { class: 'muted small' }, '不计入本场权重'))]
          : null,
        ['本场发言权重', h('span', {},
          h('strong', {}, v.weight.label),
          h('div', { class: 'muted small' }, v.weight.rule))],
      ])),

    card('这是哪个号',
      v.boundPlatforms.length
        ? h('ul', { class: 'plain-list' }, v.boundPlatforms.map((b) => h('li', {},
          h('code', {}, b.platform), ' / ', h('strong', {}, b.handle),
          h('span', { class: 'muted small' }, `  绑定锚定 ${fmtTime(b.anchoredAtMs)}`))))
        : h('p', { class: 'muted' }, '没有已记录的账号绑定。'),
      h('p', { class: 'muted small', style: { margin: '10px 0 0' } },
        '如果这条收据不是出现在你自己的账号下，那就是有人复制了别人的链接。')),

    v.allReceiptIds.length > 1
      ? card('这场比赛的全部承诺',
        h('ol', { class: 'plain-list' }, v.allReceiptIds.map((id) => h('li', {},
          h('a', { class: 'mono', href: `#/p/${encodeURIComponent(id)}` }, id)))))
      : null,

    card('他自己贴的那一行',
      codeBlock(v.oneLiner),
      h('p', { class: 'muted small', style: { margin: '10px 0 0' } },
        '前面几个字是给人看的，改成「最强王者」也没有用——'
        + '本页展示的全部内容都来自签名，文字与签名不一致时以签名为准。')),

    card('原始记录',
      kv([
        ['收据号', h('code', {}, v.receiptId)],
        ['身份指纹', h('code', {}, v.fingerprint)],
        ['承诺模式', v.stance.mode === 'sealed' ? '密封（盐哈希）' : '明文签名'],
        ['时间锚类型', h('code', {}, v.anchorTrust.kind)],
      ])));
}

/* ------------------------------------------------------------------ match */

export async function matchView(matchId) {
  const match = matchById(matchId);
  if (!match) {
    return h('div', {},
      h('div', { class: 'page-head' }, h('h1', {}, '找不到这场比赛')),
      empty('这个比赛 ID 不在账本里。', h('a', { class: 'btn btn-ghost', href: '#/' }, '回到首页')));
  }

  const ledger = store.combinedLedger();
  const now = Date.now();
  const open = !isMatchClosed(ledger, match, now);
  const all = commitments().filter((c) => c.matchId === matchId)
    .sort((a, b) => a.anchoredAtMs - b.anchoredAtMs);

  const tally = {};
  for (const c of all) {
    if (!c.team) continue;
    const bucket = (tally[c.team] ??= { pre: 0, post: 0, receipts: [] });
    if (c.anchoredAtMs < match.kickoffMs) bucket.pre += 1; else bucket.post += 1;
    bucket.receipts.push(c.receiptId);
  }

  return h('div', {},
    h('div', { class: 'page-head' },
      h('div', {},
        h('p', { class: 'eyebrow' }, 'Match · 清算'),
        h('h1', { class: 'display', style: { fontSize: '32px' } }, match.matchId),
        h('p', { class: 'muted' }, `${displayGame(match.gameId)} · ${match.teams.join('  ·  ')}`)),
      h('div', { class: 'head-right' },
        pill(open ? '未开赛' : '已开赛', open ? 'band-low' : 'band-unverified'),
        h('div', { class: 'num small dim', style: { marginTop: '6px' } }, fmtCountdown(match.kickoffMs)))),

    open
      ? banner('ok', h('strong', {}, '这场比赛还可以站队。'),
        ' 开赛前提交的承诺会被时间锚证明早于开赛。',
        h('div', { style: { marginTop: '10px' } },
          h('a', { class: 'btn btn-primary', href: '#/commit' }, '去站队')))
      : banner('warn', h('strong', {}, '这场比赛已经开赛。'),
        ' 之后的承诺会被标成「赛后补记」——签名仍然有效，但它证明不了赛前站队。'),

    card('赛前站队分布',
      all.length
        ? h('div', { class: 'grid' },
          h('table', {},
            h('thead', {}, h('tr', {},
              h('th', {}, '队伍'), h('th', {}, '赛前'), h('th', {}, '赛后补记'),
              h('th', {}, '收据'))),
            h('tbody', {}, match.teams.map((team) => {
              const b = tally[team] ?? { pre: 0, post: 0, receipts: [] };
              return h('tr', {},
                h('td', { class: b.pre ? 'lead' : '' }, h('span', { class: 'num', style: { fontSize: '17px' } }, team)),
                h('td', {}, h('span', { class: 'num', style: { color: b.pre ? 'var(--good)' : 'var(--text-3)' } },
                  String(b.pre))),
                h('td', {}, b.post
                  ? h('span', { class: 'num bad' }, String(b.post))
                  : h('span', { class: 'num dim' }, '0')),
                h('td', {}, b.receipts.length
                  ? h('span', {}, b.receipts.map((id) => h('a', {
                    class: 'chip', href: `#/p/${encodeURIComponent(id)}`,
                  }, id.slice(0, 12))))
                  : h('span', { class: 'dim' }, '—')));
            }))))
        : h('p', { class: 'muted' }, '还没有人提交赛前承诺。'),
      h('p', { class: 'muted small', style: { margin: '12px 0 0' } },
        '只统计签名有效、且时间锚早于开赛的承诺。改口的人会同时出现在两边的收据里。')),

    all.length
      ? card('全部收据',
        h('div', { class: 'grid' },
          h('table', {},
            h('thead', {}, h('tr', {},
              h('th', {}, '收据'), h('th', {}, '站队'), h('th', {}, '时间锚'), h('th', {}, '判定'))),
            h('tbody', {}, all.map((c) => h('tr', {},
              h('td', {}, h('a', { class: 'mono', href: `#/p/${encodeURIComponent(c.receiptId)}` }, c.receiptId)),
              h('td', {}, c.team ? h('span', { class: 'num' }, c.team) : h('em', { class: 'dim' }, '保密')),
              h('td', { class: 'num small dim' }, fmtTime(c.anchoredAtMs)),
              h('td', {}, c.anchoredAtMs < match.kickoffMs
                ? pill('赛前', 'band-low')
                : pill('赛后补记', 'band-high'))))))))
      : null);
}

/* -------------------------------------------------------------------- how */

export function howView() {
  return h('div', {},
    h('section', { class: 'hero' }, h('div', { class: 'hero-inner' },
      h('p', { class: 'eyebrow' }, 'How it works'),
      h('h1', { class: 'display' }, '凭什么', h('em'), '可信'),
      h('p', { class: 'lede' },
        '不是靠平台担保，也不是靠运营者守信。而是每条结论都能被任何人、'
        + '用任何工具、离线复算一遍。')))),

    card('评论里贴的那一行',
      codeBlock('赛前 T1 · 英雄联盟 璀璨钻石 · 认证 https://…/p/0x714eacef…7fb2'),
      h('p', { class: 'muted small', style: { margin: '10px 0 0' } },
        '前面几个字是给人看的。改成「最强王者」也没用——核对页只认签名里的内容。'
        + '复制别人的链接也不行：页面上会显示那把指纹绑定的是哪个账号。')),

    card('发言权重怎么算',
      h('p', { style: { marginTop: 0 } },
        '只由', h('strong', { style: { color: 'var(--gold)' } }, '这场比赛所属游戏'), '的开赛前段位决定。规则公开、固定：'),
      h('div', { class: 'grid' },
        h('table', {},
          h('thead', {}, h('tr', {}, h('th', {}, '权重'), h('th', {}, '段位'), h('th', {}, '怎么理解'))),
          h('tbody', {},
            h('tr', {}, h('td', {}, pill('高', 'band-high')),
              h('td', { class: 'num' }, '大师及以上'),
              h('td', { class: 'muted small' }, '这个人在这个游戏里确实到过那个水平')),
            h('tr', {}, h('td', {}, pill('中', 'band-mid')),
              h('td', { class: 'num' }, '翡翠 — 钻石'),
              h('td', { class: 'muted small' }, '打过很多，对局理解可能靠谱')),
            h('tr', {}, h('td', {}, pill('低', 'band-low')),
              h('td', { class: 'num' }, '铂金及以下'),
              h('td', { class: 'muted small' }, '发言仍然保留，但读者看到的是低权重')),
            h('tr', {}, h('td', {}, pill('未认证', 'band-unverified')),
              h('td', { class: 'num' }, '没有开赛前快照'),
              h('td', { class: 'muted small' }, '不上调权重，也不会被显示成高分段'))))),
      h('p', { class: 'muted small', style: { margin: '14px 0 0' } },
        '王者荣耀的最强王者不会抬高一个人在英雄联盟话题下的分量。'
        + '段位比较按段位表位置，不按字典序——「钻石」一定排在「黄金」前面。')),

    card('段位从哪来',
      h('p', { style: { marginTop: 0 } }, '每个快照都带一个来源标记，页面上原样显示，不会混为一谈：'),
      h('ul', { class: 'plain-list' },
        h('li', {}, h('strong', { class: 'good' }, '官方接口'), '：直接来自游戏厂商接口。'),
        h('li', {}, h('strong', { class: 'warn' }, '他人背书'), '：由其他已认证用户签名担保。'),
        h('li', {}, h('strong', { class: 'dim' }, '自报'), '：用户自己填，未经核验。')),
      h('p', { class: 'muted small', style: { margin: '14px 0 0' } },
        '厂商密钥不能放进静态网页，所以官方段位需要部署方另外提供一个只做查询的代理服务。'
        + '没接上的时候，本站不会假装能拉到官方数据——只会退回自报并如实标注。')),

    card('它挡不住什么',
      h('ul', { class: 'plain-list' },
        h('li', {}, h('strong', { class: 'bad' }, '挡不住一人多号。'),
          ' 签名只证明「这把钥匙签过」，不证明背后是一个真人。'),
        h('li', {}, h('strong', { class: 'bad' }, '挡不住借号。'),
          '只能靠周期性重新授权让借号失效。'),
        h('li', {}, h('strong', { class: 'warn' }, '本地时间锚挡不住改表。'),
          ' 用户可以把设备时钟调回去。接入时间锚服务或 OpenTimestamps 才有意义。'),
        h('li', {}, h('strong', { class: 'warn' }, '挡不住运营者。'),
          ' 但账本公开、链可复算：改一条后面全断，断裂位置会直接显示在页面上。'))),

    card('自己验一遍',
      h('p', { style: { marginTop: 0 } },
        '本站的每一条结论都可以离线复算，不需要相信这个网站：'),
      h('ol', { class: 'plain-list' },
        h('li', {}, '下载 ', h('a', { href: './data/ledger.json', download: '' }, 'data/ledger.json'),
          '，它是一条哈希链。'),
        h('li', {}, '改动其中任何一条记录。'),
        h('li', {}, '刷新同一张收据页。'),
        h('li', {}, '你会看到站点拒绝给出任何判定，并告诉你链断在第几条。')));
}
