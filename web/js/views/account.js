/**
 * Account views: everything that writes. All of them require an unlocked
 * identity, and every one of them shows the exact record being signed.
 */

import {
  h, card, kv, pill, banner, codeBlock, empty, input, textarea, select, field, button,
  copyable, fmtTime, fmtCountdown, fixture,
} from '../ui.js';
import { store } from '../store.js';
import {
  bindAccount, reportRank, commit, registerMatch, myRecords,
  openMatchesForMe, matchById, seals, importSchedule,
} from '../actions.js';
import { passphraseStrength, sealPrivateKey } from '../../../core/vault.js';
import { TIER_LADDERS, displayGame, PROVENANCE, ladderFor } from '../../../core/rank.js';

const PLATFORMS = [
  { value: 'weibo', label: '微博' },
  { value: 'bilibili', label: 'B 站' },
  { value: 'nga', label: 'NGA' },
  { value: 'discord', label: 'Discord' },
  { value: 'x', label: 'X / Twitter' },
  { value: 'tieba', label: '贴吧' },
  { value: 'other', label: '其他' },
];

function toast(message, tone = 'ok') {
  return banner(tone, message);
}

/* -------------------------------------------------------------- onboarding */

export function startView(navigate) {
  if (store.identity && store.unlocked) {
    return h('div', {},
      h('div', { class: 'page-head' }, h('h1', {}, '你已经有一个身份')),
      card('当前身份', kv([
        ['身份指纹', h('code', {}, store.identity.fingerprint)],
        ['创建时间', fmtTime(Date.parse(store.identity.createdAt))],
      ])),
      h('div', { class: 'row' },
        button('去站队', { onclick: () => navigate('/commit') }),
        button('身份与备份', { variant: 'ghost', onclick: () => navigate('/me') })));
  }

  if (store.identity && !store.unlocked) return unlockView(navigate);

  return h('div', {},
    h('div', { class: 'page-head' }, h('h1', {}, '开始使用')),
    card('两步',
      h('ol', { class: 'plain-list' },
        h('li', {}, '在这台设备上生成一把长期密钥。'),
        h('li', {}, '给密钥设一个口令，它会被加密后存在本机。')),
      h('p', { class: 'muted small' },
        '私钥不离开这台设备。丢了密钥就等于丢了全部历史站队记录——'
        + '所以第三步会请你导出一份备份。')),

    createForm(navigate),
    card('已经有备份了？',
      h('p', { class: 'muted' }, '粘贴之前导出的备份文件内容，然后输入口令恢复。'),
      restoreForm(navigate)));
}

function createForm(navigate) {
  const pw = input({ type: 'password', placeholder: '至少 8 位，建议 14 位以上', autocomplete: 'new-password' });
  const pw2 = input({ type: 'password', placeholder: '再输一次', autocomplete: 'new-password' });
  const meter = h('p', { class: 'muted small' }, '口令强度：—');
  const out = h('div');

  pw.addEventListener('input', () => {
    const s = passphraseStrength(pw.value);
    meter.textContent = `口令强度：${s.label} — ${s.advice}`;
    meter.className = `small ${s.score <= 2 ? 'warn' : 'good'}`;
  });

  const submit = button('生成身份', {
    onclick: async () => {
      if (pw.value !== pw2.value) return show(out, toast('两次输入的口令不一致', 'bad'), 'warn');
      if (pw.value.length < 8) return show(out, toast('口令至少 8 位', 'bad'), 'warn');
      try {
        submit.disabled = true;
        const id = await store.createIdentity(pw.value);
        const backup = store.exportBackup();
        show(out, h('div', {},
          toast('身份已生成：' + id.fingerprint),
          h('p', {}, '现在把下面的备份存下来。只有这把备份加口令能恢复你的身份。'),
          codeBlock(backup, 'key'),
          h('p', { class: 'muted small' },
            '存在你自己的密码管理器或离线设备上。不要只留在这一台机器里。')), 'ok');
        setTimeout(() => navigate('/bind'), 400);
      } catch (e) {
        show(out, toast(e.message, 'bad'), 'bad');
      } finally {
        submit.disabled = false;
      }
    },
  });

  return card('生成新身份',
    field('口令', pw, '这个口令保护的是你全部历史站队记录。丢了没有找回。'),
    field('确认口令', pw2),
    meter,
    h('div', { class: 'row' }, submit),
    out);
}

function restoreForm(navigate) {
  const text = textarea({ placeholder: '{ "format": "fanverify-backup/v2", ... }', rows: 6 });
  const pw = input({ type: 'password', placeholder: '当初设置的口令' });
  const out = h('div');
  const submit = button('恢复身份', {
    onclick: async () => {
      try {
        submit.disabled = true;
        await store.restoreIdentity(text.value.trim(), pw.value);
        navigate('/bind');
      } catch (e) {
        show(out, toast(e.message, 'bad'), 'bad');
      } finally {
        submit.disabled = false;
      }
    },
  });
  return h('div', {},
    field('备份文件内容', text),
    field('口令', pw),
    h('div', { class: 'row' }, submit),
    out);
}

export function unlockView(navigate) {
  const pw = input({ type: 'password', placeholder: '口令', autocomplete: 'current-password' });
  const out = h('div');
  const submit = button('解锁', {
    onclick: async () => {
      try {
        await store.unlock(pw.value);
        navigate('/me');
      } catch (e) {
        show(out, toast(e.message, 'bad'), 'bad');
      }
    },
  });
  return h('div', {},
    h('div', { class: 'page-head' }, h('h1', {}, '解锁身份')),
    card('输入口令继续',
      field('口令', pw),
      h('div', { class: 'row' }, submit),
      out,
      h('p', { class: 'muted small' },
        '私钥一直加密存在本机，只有你解锁的这段时间才在内存里可用。')));
}

/* --------------------------------------------------------------- my account */

export function meView(navigate) {
  if (!store.identity) return needAccount(navigate);
  if (!store.unlocked) return unlockView(navigate);

  const { bindings, snapshots, commitments } = myRecords();
  const games = new Set(snapshots.map((s) => s.gameId));

  return h('div', {},
    h('div', { class: 'page-head' },
      h('div', {},
        h('h1', {}, '身份与记录'),
        h('p', { class: 'muted' }, store.identity.fingerprint)),
      h('div', { class: 'head-right' },
        button('锁定', { variant: 'ghost', onclick: () => { store.lock(); navigate('/start'); } }))),

    h('div', { class: 'quick-links' },
      h('a', { class: 'btn btn-primary', href: '#/bind' }, '绑定账号'),
      h('a', { class: 'btn btn-ghost', href: '#/rank' }, '报段位'),
      h('a', { class: 'btn btn-ghost', href: '#/commit' }, '赛前站队'),
      h('a', { class: 'btn btn-ghost', href: '#/submit' }, '提交我的记录')),

    card(`已绑定账号（${bindings.length}）`,
      bindings.length
        ? h('ul', { class: 'plain-list' }, bindings.map((b) => h('li', {},
          h('code', {}, b.platform), ' / ', b.handle,
          h('span', { class: 'muted small' }, ` 锚定 ${fmtTime(b.anchoredAtMs)}`))))
        : h('p', { class: 'muted' }, '还没有绑定。绑定后别人才能核对「这个收据是不是你发的」。',
          ' ', h('a', { href: '#/bind' }, '去绑定')),
      h('p', { class: 'muted small' },
        '绑定的作用：别人复制你的收据链接时，页面上会显示它绑定的是哪个账号。')),

    card(`段位快照（${snapshots.length}）`,
      snapshots.length
        ? h('table', { class: 'grid' },
          h('thead', {}, h('tr', {},
            h('th', {}, '游戏'), h('th', {}, '段位'), h('th', {}, '来源'),
            h('th', {}, '快照时间'))),
          h('tbody', {}, snapshots.map((s) => h('tr', {},
            h('td', {}, displayGame(s.gameId)),
            h('td', {}, h('strong', {}, s.tier)),
            h('td', {}, pill(PROVENANCE[s.provenance]?.label ?? s.provenance,
              s.provenance === 'official' ? 'band-high' : s.provenance === 'attested' ? 'band-mid' : 'band-unverified')),
            h('td', {}, fmtTime(s.capturedAtMs))))))
        : h('p', { class: 'muted' }, '还没有段位快照。', ' ', h('a', { href: '#/rank' }, '去报一个')),
      games.size ? h('p', { class: 'muted small' },
        '快照是追加写的，旧的不会被覆盖。讨论某场比赛时用的是开赛前最近的一份。') : null),

    card(`我的赛前承诺（${commitments.length}）`,
      commitments.length
        ? h('table', { class: 'grid' },
          h('thead', {}, h('tr', {},
            h('th', {}, '收据'), h('th', {}, '比赛'), h('th', {}, '站队'), h('th', {}, '时间锚'))),
          h('tbody', {}, commitments.map((c) => h('tr', {},
            h('td', {}, h('a', { href: `#/p/${encodeURIComponent(c.receiptId)}` }, h('code', {}, c.receiptId))),
            h('td', {}, c.matchId),
            h('td', {}, c.team ?? h('em', { class: 'muted' }, '保密')),
            h('td', {}, fmtTime(c.anchoredAtMs))))))
        : h('p', { class: 'muted' }, '还没有承诺过。', ' ', h('a', { href: '#/commit' }, '去站队'))),

    card('备份',
      h('p', { class: 'muted' },
        '这把私钥只在这台设备上。导出备份存到别处，否则清缓存或换设备就找不回来了。'),
      codeBlock(store.exportBackup(), 'key')));
}

/* ----------------------------------------------------------------- binding */

export function bindView(navigate) {
  if (!store.identity) return needAccount(navigate);
  if (!store.unlocked) return unlockView(navigate);

  const platform = select(PLATFORMS.map((p) => ({ value: p.value, label: p.label })));
  const handle = input({ placeholder: '你的账号名' });
  const out = h('div');

  const submit = button('生成绑定凭证', {
    onclick: async () => {
      try {
        submit.disabled = true;
        const { challenge } = await bindAccount({ platform: platform.value, handle: handle.value });
        show(out, h('div', {},
          toast('绑定已记录。现在把下面这段发到你的' + platform.selectedOptions[0].text + '上。'),
          codeBlock(challenge, 'key'),
          h('p', { class: 'muted small' },
            '别人在他们的账号下看到这段，就能确认这个账号确实由这把密钥控制。'
            + '发完回来继续下一步。'),
          h('div', { class: 'row' }, button('去报段位', { onclick: () => navigate('/rank') }))), 'ok');
      } catch (e) {
        show(out, toast(e.message, 'bad'), 'bad');
      } finally {
        submit.disabled = false;
      }
    },
  });

  return h('div', {},
    h('div', { class: 'page-head' }, h('h1', {}, '绑定平台账号')),
    card('绑定一个账号',
      h('p', { class: 'muted' },
        '绑定是把「这个平台账号」和「你手里这把密钥」钉在一起。'
        + '没有绑定，别人复制一条收据链接就能冒用。'),
      field('平台', platform),
      field('账号', handle, '填你在该平台的 ID 或用户名'),
      h('div', { class: 'row' }, submit),
      out),
    card('为什么不能自动关联',
      h('p', { class: 'muted small' },
        '任何自动抓取账号的方案都要平台配合，公开平台都不提供。'
        + '所以这一步只能由你本人在平台上发一条带签名的内容，'
        + '这条内容就是绑定的凭据。')));
}

/* ------------------------------------------------------------------- rank */

export function rankView(navigate) {
  if (!store.identity) return needAccount(navigate);
  if (!store.unlocked) return unlockView(navigate);

  const out = h('div');
  const gameSel = select(Object.entries(TIER_LADDERS).map(([id, l]) => ({
    value: id, label: l.display + (l.official ? '' : '（无官方接口）'),
  })));
  const tierSel = select([]);
  const account = input({ placeholder: '游戏 ID / 召唤师名（官方模式需要）' });
  const modeNote = h('p', { class: 'muted small' });
  const officialBtn = button('从官方接口拉取', { variant: 'ghost' });
  const capturedAt = { value: null };

  const refreshTiers = () => {
    const ladder = ladderFor(gameSel.value);
    tierSel.replaceChildren(...ladder.tiers.map((t) => h('option', { value: t }, t)));
    const reason = store.rankSource.unavailableReason(gameSel.value);
    officialBtn.disabled = Boolean(reason);
    modeNote.textContent = reason
      ? `无法使用官方接口：${reason}`
      : '可以从厂商接口拉取真实段位（需要一个已配置的段位代理服务）。';
  };
  gameSel.addEventListener('change', refreshTiers);

  officialBtn.addEventListener('click', async () => {
    try {
      officialBtn.disabled = true;
      officialBtn.textContent = '拉取中…';
      const r = await store.rankSource.fetchOfficial({
        gameId: gameSel.value, accountId: account.value.trim(),
      });
      tierSel.value = r.tier;
      capturedAt.value = r.capturedAtMs;
      show(out, toast(`已从官方接口取得段位：${r.tier}（${r.provider}）`), 'ok');
    } catch (e) {
      show(out, toast(e.message, 'bad'), 'bad');
    } finally {
      officialBtn.textContent = '从官方接口拉取';
      refreshTiers();
    }
  });

  const submit = button('记录这个段位', {
    onclick: async () => {
      try {
        submit.disabled = true;
        const usedOfficial = capturedAt.value != null;
        await reportRank({
          gameId: gameSel.value,
          tier: tierSel.value,
          gameAccount: account.value.trim() || null,
          provenance: usedOfficial ? 'official' : 'self',
          capturedAtMs: capturedAt.value ?? undefined,
        });
        capturedAt.value = null;
        show(out, h('div', {},
          toast('段位快照已写入并签名。'),
          h('p', { class: 'muted small' },
            '它不会覆盖旧快照。讨论某场比赛时，系统会取开赛前最近的那一份。'),
          h('div', { class: 'row' }, button('去赛前站队', { onclick: () => navigate('/commit') }))), 'ok');
      } catch (e) {
        show(out, toast(e.message, 'bad'), 'bad');
      } finally {
        submit.disabled = false;
      }
    },
  });

  return h('div', {},
    h('div', { class: 'page-head' }, h('h1', {}, '记录段位')),
    card('这个游戏的段位',
      field('游戏', gameSel, '权重只看这场比赛所属游戏'),
      field('段位', tierSel),
      field('游戏账号', account, '可选。官方模式必须填，昵称不够，要能对应到平台账号。'),
      modeNote,
      h('div', { class: 'row' }, officialBtn, submit),
      out),
    card('来源会被如实记录',
      h('ul', { class: 'plain-list' },
        h('li', {}, h('strong', {}, '官方接口'), '：页面上标为「官方接口」。'),
        h('li', {}, h('strong', {}, '自报'), '：页面上标为「自报」，不会混进官方数据里。')),
      h('p', { class: 'muted small' },
        '厂商的 API 密钥不能放在静态网页里，所以官方段位需要部署方另外提供一个'
        + '只做查询的代理服务。没有配置时本站不会假装能拉到官方数据。')));
}

/* ----------------------------------------------------------------- commit */

export function commitView(navigate) {
  if (!store.identity) return needAccount(navigate);
  if (!store.unlocked) return unlockView(navigate);

  const out = h('div');
  const available = openMatchesForMe();
  const now = Date.now();
  const all = seals();
  const finished = all.filter((m) => !available.some((a) => a.matchId === m.matchId));

  if (!available.length) {
    return h('div', {},
      h('div', { class: 'page-head' }, h('h1', {}, '赛前站队')),
      empty('现在没有可以站队的比赛。',
        h('a', { class: 'btn btn-ghost', href: '#/newmatch' }, '登记一场比赛')),
      finished.length ? h('div', { class: 'card' },
        h('h2', {}, '已结束的比赛'),
        h('p', { class: 'muted small' },
          '这些比赛已经开赛，不再接受新承诺。但你可以查看已有收据。'),
        h('ul', { class: 'link-list' }, finished.map((m) => h('li', {},
          h('a', { href: `#/m/${encodeURIComponent(m.matchId)}` }, m.matchId),
          ' · ', displayGame(m.gameId))))) : null);
  }

  const matchSel = select(available.map((m) => {
    const closed = m.kickoffMs <= now;
    return {
      value: m.matchId,
      label: `${m.matchId} · ${displayGame(m.gameId)} · ${closed ? '已开赛' : fmtCountdown(m.kickoffMs)}`,
    };
  }));

  const teamWrap = h('div', { class: 'team-grid' });
  const refreshTeams = () => {
    const m = matchById(matchSel.value);
    teamWrap.replaceChildren(...m.teams.map((t) => button(t, {
      variant: 'team',
      onclick: () => {
        teamWrap.querySelectorAll('button').forEach((b) => b.classList.remove('is-picked'));
        event.currentTarget.classList.add('is-picked');
        picked.team = t;
      },
    })));
  };
  matchSel.addEventListener('change', refreshTeams);

  const sealedBox = h('input', { type: 'checkbox' });
  const saltInput = input({ placeholder: '留空自动生成', style: { display: 'none' } });
  sealedBox.addEventListener('change', () => {
    saltInput.style.display = sealedBox.checked ? '' : 'none';
  });

  const picked = { team: null };

  const submit = button('签下这条站队', {
    onclick: async () => {
      if (!picked.team) return show(out, toast('请先选择你支持的队伍', 'warn'), 'warn');
      try {
        submit.disabled = true;
        const match = matchById(matchSel.value);
        const res = await commit({
          match, team: picked.team, sealed: sealedBox.checked, salt: saltInput.value.trim(),
        });
        show(out, h('div', {},
          toast(res.flipFlop
            ? '已记录。注意：这场你此前已经承诺过，两条都保留，页面会标为改口。'
            : '站队已签下。'),
          h('p', {}, '把这一行贴到你的评论末尾：'),
          codeBlock(res.oneLiner.replace(/\/p\//, `${location.origin}/p/`)),
          h('p', { class: 'muted small' },
            '时间锚 ', fmtTime(res.record.timeAnchor.unixMs),
            '，开赛 ', fmtTime(match.kickoffMs), '。'),
          h('div', { class: 'row' },
            h('a', { class: 'btn btn-ghost', href: `#/p/${encodeURIComponent(res.receiptId)}` }, '查看收据'),
            button('提交我的记录', { variant: 'ghost', onclick: () => navigate('/submit') }))), 'ok');
      } catch (e) {
        show(out, toast(e.message, 'bad'), 'bad');
      } finally {
        submit.disabled = false;
      }
    },
  });

  refreshTeams();

  return h('div', {},
    h('div', { class: 'page-head' }, h('h1', {}, '赛前站队')),
    card('这场你站哪边',
      field('比赛', matchSel),
      h('p', { class: 'field-label' }, '支持'),
      teamWrap,
      field('', h('label', { class: 'check' },
        sealedBox,
        h('span', {}, '赛前保密：只发哈希，赛后揭示我站了谁'))),
      field('随机盐', saltInput, '只有你知道。留空自动生成。'),
      h('div', { class: 'row' }, submit),
      out),
    card('签下之后',
      h('ul', { class: 'plain-list' },
        h('li', {}, '这条承诺进入账本，时间锚由本站记录。'),
        h('li', {}, '开赛前你还可以改签一次——但两条都会留着，页面会标成改口。'),
        h('li', {}, '开赛并封存后就不能再提交了。'),
        h('li', {}, '评论里只贴那一行链接，前面的字随便别人怎么改。'))));
}

export function newMatchView(navigate) {
  if (!store.identity) return needAccount(navigate);
  if (!store.unlocked) return unlockView(navigate);

  const out = h('div');
  const matchId = input({ placeholder: 'lck-2026-s10-final' });
  const gameSel = select(Object.entries(TIER_LADDERS).map(([id, l]) => ({ value: id, label: l.display })));
  const teams = input({ placeholder: 'T1,JDG' });
  const kickoff = input({ type: 'datetime-local' });

  const submit = button('登记并封存', {
    onclick: async () => {
      try {
        submit.disabled = true;
        const iso = kickoff.value ? new Date(kickoff.value).toISOString() : '';
        const m = await registerMatch({
          matchId: matchId.value.trim(),
          gameId: gameSel.value,
          teams: teams.value,
          kickoffAt: iso,
        });
        show(out, h('div', {},
          toast(`已登记 ${m.matchId} 并记录开赛时间。`),
          h('p', { class: 'muted small' },
            '开赛时间写进了哈希链，之后任何人改动它都会导致链断裂。'),
          h('div', { class: 'row' }, button('去站队', { onclick: () => navigate('/commit') }))), 'ok');
      } catch (e) {
        show(out, toast(e.message, 'bad'), 'bad');
      } finally {
        submit.disabled = false;
      }
    },
  });

  return h('div', {},
    h('div', { class: 'page-head' }, h('h1', {}, '登记比赛')),
    card('新比赛',
      field('比赛 ID', matchId),
      field('游戏', gameSel, '决定发言权重看哪个游戏的段位'),
      field('队伍', teams, '用逗号分隔，例如 T1,JDG'),
      field('开赛时间', kickoff, '本站按 UTC+8 解读这个输入'),
      h('div', { class: 'row' }, submit),
      out),
    card('为什么开赛时间要写进账本',
      h('p', { class: 'muted small' },
        '「是否赛前」完全由这个时间和时间锚比较得出。'
        + '如果开赛时间本身可以被随便改，这条记录就没有意义了。')));
}

/* ----------------------------------------------------------------- submit */

export function submitView(navigate) {
  if (!store.identity) return needAccount(navigate);
  const bundle = store.exportMineBundle();
  const text = JSON.stringify(bundle, null, 2);
  const out = h('div');

  return h('div', {},
    h('div', { class: 'page-head' }, h('h1', {}, '提交我的记录')),
    h('div', {}, banner('warn',
      h('strong', {}, '这个静态站点不接收写入。'),
      ' 你的记录先留在本机。要让它出现在公开账本上，'
      + '把下面的账本包发给站点维护方，他们审核后会追加并重新发布。')),
    card(`我这台设备上的记录（${bundle.recordCount} 条）`,
      codeBlock(text, 'key'),
      h('div', { class: 'row' },
        h('a', {
          class: 'btn btn-primary',
          download: `fanverify-${store.identity.fingerprint.slice(4, 12)}.json`,
          href: URL.createObjectURL(new Blob([text], { type: 'application/json' })),
        }, '下载账本包')),
      out),
    card('审核时他们会看什么',
      h('ul', { class: 'plain-list' },
        h('li', {}, '每条记录的签名是否都能用记录里自带的公钥验过。'),
        h('li', {}, '公钥算出的指纹是否和记录声明的一致。'),
        h('li', {}, '整条哈希链是否自洽。'),
        h('li', {}, '有没有明显刷量或异常时间。')),
      h('p', { class: 'muted small' },
        '这些检查不需要信任他们：你可以自己下载公开账本，'
        + '改动任何一条，看后面所有链接是否对不上。')));
}

function needAccount(navigate) {
  return h('div', {},
    h('div', { class: 'page-head' }, h('h1', {}, '需要先有身份')),
    empty('写记录需要一把属于你自己的密钥。',
      h('a', { class: 'btn btn-primary', href: '#/start' }, '去创建')),
    h('p', { class: 'muted small' }, '看完别人的收据不需要身份，直接回 ',
      h('a', { href: '#/' }, '首页'), '。'));
}

function show(node, content, tone) {
  node.replaceChildren();
  if (content instanceof Node) node.appendChild(content);
  else node.appendChild(toast(content, tone));
  node.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

/* ----------------------------------------------------------------- import */

/**
 * Read someone else's published bundle.
 *
 * This is the other half of publishing: a fan exports a bundle, hands it over,
 * and anyone can verify and display its records. A fork is refused rather than
 * resolved, because silently picking a side is how a "merged" ledger quietly
 * stops meaning anything.
 */
export function importView(navigate) {
  const out = h('div');
  const area = textarea({ placeholder: '把对方给你的账本包内容粘贴到这里', rows: 8 });
  const file = input({ type: 'file', accept: '.json,application/json' });

  const apply = async (text) => {
    if (!text.trim()) return show(out, toast('内容是空的', 'warn'), 'warn');
    try {
      const res = await store.importMine(text);
      show(out, h('div', {},
        toast(res.added
          ? `已并入 ${res.added} 条记录。`
          : '这些记录你已经有了，没有新增。'),
        h('p', { class: 'muted small' },
          '导入前会逐条验签并检查哈希链。分叉的账本会被拒绝——'
          + '两条历史不一致时，静默选一边会让整条链失去意义。'),
        h('div', { class: 'row' },
          h('a', { class: 'btn btn-ghost', href: '#/' }, '去首页看看'))), 'ok');
    } catch (e) {
      show(out, toast(e.message, 'bad'), 'bad');
    }
  };

  file.addEventListener('change', async () => {
    const f = file.files?.[0];
    if (!f) return;
    apply(await f.text());
  });

  return h('div', {},
    h('div', { class: 'page-head' },
      h('div', {},
        h('p', { class: 'eyebrow' }, 'Import'),
        h('h1', { class: 'display', style: { fontSize: '30px' } }, '导入账本包'),
        h('p', { class: 'muted' }, '把别人给你的账本包拖进来，合并进你本机的账本。'))),

    card('从文件导入', field('选择文件', file, '对方导出的是一个 .json 文件'),
      h('p', { class: 'muted small', style: { margin: 0 } },
        '合并时会重新验证每条签名、每个公钥与指纹的对应关系，以及整条哈希链。'
        + '任何一项不过，整份包都会被拒绝。')),

    card('或直接粘贴', field('账本包内容', area),
      h('div', { class: 'row' },
        button('导入', { onclick: () => apply(area.value) })),
      out),

    card('怎么让别人也看到你的记录',
      h('ol', { class: 'plain-list' },
        h('li', {}, '在 ', h('a', { href: '#/submit' }, '提交我的记录'), ' 里导出账本包。'),
        h('li', {}, '把文件发给站点维护方，或者直接发给任何你想让看到的人。'),
        h('li', {}, '对方导入后，你签的东西在他们页面上就可核对了——不需要信任你，也不需要信任本站。')),
      h('p', { class: 'muted small', style: { margin: '12px 0 0' } },
        '这个站点本身不接收写入。要让记录进入公开账本，维护方需要审核并重新发布；'
        + '但你随时可以直接把包发给任何人。')));
}

/* --------------------------------------------------------------- settings */

export function settingsView(navigate) {
  const out = h('div');
  const url = input({
    value: store.ledgerUrl,
    placeholder: 'https://…/ledger.json',
  });

  const applyUrl = async () => {
    const value = url.value.trim();
    store.ledgerUrl = value || undefined;
    show(out, h('div', {},
      toast(value ? '已保存，正在重新载入…' : '已恢复为随站点发布的账本'),
      h('p', { class: 'muted small' }, '刷新后生效。')), 'ok');
    setTimeout(() => location.reload(), 700);
  };

  return h('div', {},
    h('div', { class: 'page-head' },
      h('div', {},
        h('p', { class: 'eyebrow' }, 'Settings'),
        h('h1', { class: 'display', style: { fontSize: '30px' } }, '账本来源与段位服务'),
        h('p', { class: 'muted' }, '这个页面能改的只有「从哪里读公开账本」和「段位走哪个代理」。'))),

    card('公开账本',
      h('p', { class: 'muted', style: { marginTop: 0 } },
        '默认读随站点发布的那份。要让公开账本持续增长而不必重新发布整站，'
        + '把这里指向一个自己托管的 JSON——它必须是同一条链，'
        + '并且以追加方式增长。'),
      field('账本地址', url, '也可以用 ?ledger=<地址> 临时指定，只影响这一次访问'),
      h('div', { class: 'row' }, button('保存并重新载入', { onclick: applyUrl })),
      out,
      h('p', { class: 'muted small', style: { margin: '14px 0 0' } },
        '当前：', h('code', {}, store.ledgerUrl),
        store.ledgerUrlIsRemote ? '' : '（随站点发布的副本）')),

    card('段位代理',
      h('p', { class: 'muted', style: { marginTop: 0 } },
        '官方段位需要一个单独部署的服务来保管厂商密钥，'
        + '密钥不能放进静态网页。没配之前，段位一律标为「自报」。'),
      field('代理地址', input({
        value: store.proxyUrl ?? '',
        placeholder: 'https://your-worker.workers.dev',
        onchange: (e) => { store.proxyUrl = e.target.value.trim() || null; },
      }), '填了之后，报段位页面的「从官方接口拉取」才会启用'),
      h('p', { class: 'muted small', style: { margin: '0' } },
        '参考实现见仓库里的 proxy/ 目录。王者荣耀没有公开接口，任何配置下都只能自报。')),

    card('危险操作',
      h('p', { class: 'muted', style: { marginTop: 0 } },
        '清掉这台设备上的身份和本机账本。',
        '私钥一旦删除，没有备份就再也找不回来——你签过的所有记录也就再也证明不了是你的。'),
      h('div', { class: 'row' },
        button('清空这台设备', {
          variant: 'ghost',
          onclick: () => {
            if (!confirm('确定要删除这台设备上的身份和本机账本吗？\n没有备份的话将无法恢复。')) return;
            localStorage.clear();
            location.hash = '#/';
            location.reload();
          },
        }))));
}

/* -------------------------------------------------------------- schedule */

/**
 * Import a real schedule.
 *
 * This is the escape hatch from the bundled sample data: paste a JSON array or
 * a CSV, and those matches become real, chain-pinned registrations on this
 * device, exportable like any other record.
 */
export function scheduleView(navigate) {
  if (!store.identity) return needAccount(navigate);
  if (!store.unlocked) return unlockView(navigate);

  const out = h('div');
  const area = textarea({
    placeholder: 'lck-2026-s11-w1,league-of-legends,"T1,BLG",2026-11-01T12:00:00Z',
    rows: 7,
  });
  const file = input({ type: 'file', accept: '.json,.csv,.txt,text/csv,application/json' });
  const preview = h('div');

  const SAMPLE_CSV = `matchId,gameId,teams,kickoffAt
lck-2026-s11-w1,league-of-legends,"T1,BLG",2026-11-01T12:00:00Z
lck-2026-s11-w2,league-of-legends,"GEN,JDG",2026-11-02T12:00:00Z
vct-cn-2026-w1,valorant,"EDG,TE",2026-11-03T12:00:00Z`;

  const showPreview = async (text) => {
    const { prepareSchedule } = await import('../../../core/schedule.js');
    const { matches, errors } = prepareSchedule(text);
    preview.replaceChildren();
    if (errors.length) {
      preview.appendChild(banner('bad',
        h('strong', {}, `有 ${errors.length} 行无法解析，整批都不会被写入：`),
        h('ul', { class: 'verdict-list' }, errors.slice(0, 8).map((e) => h('li', {}, e)))));
    }
    if (matches.length) {
      preview.appendChild(card(`可以登记 ${matches.length} 场`,
        h('div', { class: 'grid' },
          h('table', {},
            h('thead', {}, h('tr', {},
              h('th', {}, '比赛'), h('th', {}, '项目'), h('th', {}, '对阵'), h('th', {}, '开赛'))),
            h('tbody', {}, matches.map((m) => h('tr', {},
              h('td', {}, h('span', { class: 'mono small' }, m.matchId)),
              h('td', {}, displayGame(m.gameId)),
              h('td', {}, fixture(m.teams)),
              h('td', { class: 'num small' }, fmtTime(m.kickoffMs))))))),
        errors.length
          ? h('p', { class: 'muted small', style: { margin: '12px 0 0' } },
            '先修掉上面的问题再导入。')
          : null));
    }
  };

  const run = async (text) => {
    try {
      const res = await importSchedule(text);
      out.replaceChildren();
      out.appendChild(h('div', {},
        toast(res.added.length
          ? `已登记 ${res.added.length} 场比赛。`
          : '这些比赛都已经登记过了，没有新增。'),
        res.skipped.length
          ? h('p', { class: 'muted small' }, `跳过 ${res.skipped.length} 个已存在的 matchId：${res.skipped.join('、')}`)
          : null,
        res.errors.length
          ? h('p', { class: 'muted small' }, `${res.errors.length} 行被跳过。`)
          : null,
        h('div', { class: 'row' },
          h('a', { class: 'btn btn-primary', href: '#/commit' }, '去站队'),
          h('a', { class: 'btn btn-ghost', href: '#/submit' }, '提交我的记录'))));
      await showPreview(text);
    } catch (e) {
      out.replaceChildren(toast(e.message, 'bad'));
    }
  };

  area.addEventListener('input', () => { showPreview(area.value); });
  file.addEventListener('change', async () => {
    const f = file.files?.[0];
    if (!f) return;
    const text = await f.text();
    area.value = text;
    showPreview(text);
  });

  return h('div', {},
    h('div', { class: 'page-head' },
      h('div', {},
        h('p', { class: 'eyebrow' }, 'Schedule import'),
        h('h1', { class: 'display', style: { fontSize: '30px' } }, '导入赛程'),
        h('p', { class: 'muted' },
          '随站点发布的是示例赛程。把真实赛程贴进来，它就会变成这条链上真实的比赛登记。'))),

    card('支持两种格式',
      h('p', { class: 'muted', style: { marginTop: 0 } }, 'CSV（带表头，最省事）：'),
      codeBlock(SAMPLE_CSV, 'key'),
      h('p', { class: 'muted', style: { marginBottom: 0 } },
        'JSON 也可以：',
        h('code', {}, '[{ "matchId": "...", "gameId": "league-of-legends", "teams": ["T1","BLG"], "kickoffAt": "2026-11-01T12:00:00Z" }]'),
        '。没有时区的时间按 UTC 处理。')),

    card('可选项目', h('div', { class: 'row' },
      Object.entries(TIER_LADDERS).map(([id, l]) => h('span', { class: 'chip' },
        h('code', {}, id), ' ', l.display)))),

    card('粘贴赛程',
      field('赛程内容', area, '边输入边校验'),
      h('div', { class: 'row' },
        button('导入', { onclick: () => run(area.value) })),
      out,
      preview),

    card('从文件导入', field('选择文件', file, '.csv 或 .json'),
      h('p', { class: 'muted small', style: { margin: 0 } },
        '整批校验通过才会写入。有一行不对就整批拒绝——'
        + '半个赛程比没有赛程更糟。已存在的 matchId 会被跳过，不会造成分叉。')),

    preview);
}
