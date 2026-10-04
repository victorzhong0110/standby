/**
 * App shell and hash router.
 *
 * Hash routing is deliberate: the site is served as static files, so every
 * receipt URL must resolve on a plain file server with no rewrite rules.
 * /p/<receipt> therefore lives at #/p/<receipt>.
 */

import { h, mount, spinner } from './ui.js';
import { store, BUNDLED_LEDGER } from './store.js';
import { homeView, receiptView, matchView, howView } from './views/public.js';
import {
  startView, meView, bindView, rankView, commitView, newMatchView, submitView,
  importView, settingsView, scheduleView,
} from './views/account.js';

const ROUTES = [
  { pattern: /^\/?$/, view: () => homeView() },
  { pattern: /^\/p\/(.+)$/, view: (m) => receiptView(decodeURIComponent(m[1])) },
  { pattern: /^\/m\/(.+)$/, view: (m) => matchView(decodeURIComponent(m[1])) },
  { pattern: /^\/how$/, view: () => howView() },
  { pattern: /^\/start$/, view: (m, nav) => startView(nav) },
  { pattern: /^\/me$/, view: (m, nav) => meView(nav) },
  { pattern: /^\/bind$/, view: (m, nav) => bindView(nav) },
  { pattern: /^\/rank$/, view: (m, nav) => rankView(nav) },
  { pattern: /^\/commit$/, view: (m, nav) => commitView(nav) },
  { pattern: /^\/newmatch$/, view: (m, nav) => newMatchView(nav) },
  { pattern: /^\/submit$/, view: (m, nav) => submitView(nav) },
  { pattern: /^\/import$/, view: (m, nav) => importView(nav) },
  { pattern: /^\/settings$/, view: (m, nav) => settingsView(nav) },
  { pattern: /^\/schedule$/, view: (m, nav) => scheduleView(nav) },
];

function navigate(path) {
  location.hash = `#${path}`;
}

const NAV = [
  { href: '#/', label: '首页', match: /^\/?$/ },
  { href: '#/how', label: '原理', match: /^\/how$/ },
  { href: '#/start', label: '开始使用', match: /^\/(start|bind|rank|commit|newmatch|submit)$/ },
  { href: '#/import', label: '导入账本包', match: /^\/(import|schedule)$/ },
  { href: '#/me', label: '我的身份', match: /^\/me$/, private: true },
];

function renderNav() {
  const path = currentPath();
  return h('header', { class: 'topbar' },
    h('a', { class: 'brand', href: '#/' },
      h('span', { class: 'brand-mark' }, 'FV'),
      h('span', { class: 'brand-text' }, '赛前站队核对')),
    h('nav', { class: 'nav' },
      NAV.filter((n) => !n.private || store.identity).map((n) => h('a', {
        href: n.href,
        class: n.match.test(path) ? 'is-active' : '',
      }, n.label))),
    h('a', {
      class: 'lock-state',
      href: '#/settings',
      title: store.ledgerUrl,
    }, h('span', { class: store.ledgerUrlIsRemote ? 'dot-live' : 'dot-local' }, ''),
      store.ledgerUrlIsRemote ? '远程账本' : '内置账本'),
    store.unlocked
      ? h('span', { class: 'lock-state' }, h('span', { class: 'dot-live' }, ''), '已解锁')
      : store.identity
        ? h('a', { class: 'btn btn-ghost btn-sm', href: '#/start' }, '解锁')
        : null);
}

function currentPath() {
  return location.hash.replace(/^#/, '') || '/';
}

async function render() {
  const path = currentPath();
  const main = document.getElementById('view');
  const nav = document.getElementById('nav');
  mount(nav, renderNav());
  document.title = titleFor(path);

  for (const route of ROUTES) {
    const m = path.match(route.pattern);
    if (m) {
      try {
        mount(main, await route.view(m, navigate));
      } catch (err) {
        console.error(err);
        mount(main, h('div', {},
          h('div', { class: 'page-head' }, h('h1', {}, '页面出错了')),
          h('div', { class: 'banner banner-bad' },
            h('strong', {}, '渲染失败。'), ' ', String(err?.message ?? err))));
      }
      return;
    }
  }

  mount(main, h('div', {},
    h('div', { class: 'page-head' }, h('h1', {}, '找不到页面')),
    h('p', {}, h('a', { href: '#/' }, '回到首页'))));
}

function titleFor(path) {
  if (path.startsWith('/p/')) return '收据核对 · 赛前站队';
  if (path.startsWith('/m/')) return '比赛 · 赛前站队';
  if (path === '/how') return '原理 · 赛前站队';
  if (path === '/start') return '开始使用 · 赛前站队';
  return '赛前站队核对';
}

async function boot() {
  const main = document.getElementById('view');
  mount(main, spinner('正在载入公开账本'));

  const source = store.ledgerUrl;
  try {
    const res = await fetch(source, { cache: 'no-cache' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const payload = await res.json();
    const records = Array.isArray(payload) ? payload : (payload.records ?? payload);
    if (!Array.isArray(records) || records.length === 0) throw new Error('empty ledger');
    const check = await store.loadPublicLedger(records);
    store.ledgerSource = source;
    if (!check.chainOk) console.warn('public ledger failed chain verification');
  } catch (err) {
    // A remote ledger that is unreachable must not take the site down. Fall
    // back to the bundled copy and say so, rather than rendering an empty page
    // that looks like "no records exist".
    console.warn(`failed to load ledger from ${source}:`, err);
    if (source !== BUNDLED_LEDGER) {
      try {
        const res = await fetch(BUNDLED_LEDGER, { cache: 'no-cache' });
        const payload = await res.json();
        const records = Array.isArray(payload) ? payload : (payload.records ?? payload);
        await store.loadPublicLedger(records ?? []);
        store.ledgerSource = BUNDLED_LEDGER;
        store.ledgerNotice = `远程账本加载失败（${err.message}），已回退到随站点发布的账本`;
      } catch (err2) {
        store.ledgerNotice = `账本加载失败：${err2.message}`;
      }
    } else {
      store.ledgerNotice = `账本加载失败：${err.message}`;
    }
  }

  store.subscribe(() => {
    mount(document.getElementById('nav'), renderNav());
  });

  window.addEventListener('hashchange', render);
  await render();
}

boot();
