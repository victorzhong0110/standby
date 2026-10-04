/**
 * Tiny DOM helpers. No framework: the whole point of this app is that a reader
 * can trust the page, and a 4 KB renderer is easier to audit than a runtime.
 *
 * Every value that reaches the DOM goes through text() or attr(), never through
 * innerHTML. A tampered ledger must not be able to inject script.
 */

export function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props ?? {})) {
    if (value == null || value === false) continue;
    if (key === 'class') el.className = value;
    else if (key === 'style' && typeof value === 'object') Object.assign(el.style, value);
    else if (key.startsWith('on') && typeof value === 'function') {
      el.addEventListener(key.slice(2).toLowerCase(), value);
    } else if (key === 'value') el.value = value;
    else if (key === 'checked' || key === 'disabled' || key === 'selected') el[key] = Boolean(value);
    else el.setAttribute(key, value === true ? '' : String(value));
  }
  append(el, children);
  return el;
}

function append(parent, children) {
  for (const child of children.flat(Infinity)) {
    if (child == null || child === false) continue;
    parent.appendChild(child instanceof Node ? child : document.createTextNode(String(child)));
  }
}

export const text = (value) => document.createTextNode(String(value ?? ''));

export function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
  return node;
}

export function mount(node, ...children) {
  clear(node);
  append(node, children);
  return node;
}

/* ------------------------------------------------------------------ widgets */

export function card(title, ...body) {
  return h('section', { class: 'card' }, title ? h('h2', {}, title) : null, ...body);
}

export function kv(rows) {
  return h('table', { class: 'kv' },
    rows.filter(Boolean).map(([k, v]) => h('tr', {}, h('td', {}, k), h('td', {}, v))));
}

export function pill(text, tone = '') {
  return h('span', { class: `pill ${tone}`.trim() }, text);
}

/** A broadcast-style figure in the hero stat rail. */
export function stat(value, label) {
  return h('div', { class: 'stat' },
    h('b', {}, String(value)),
    h('span', {}, label));
}

const TONE = { high: 'band-high', mid: 'band-mid', low: 'band-low', unverified: 'band-unverified' };

export function weightPill(weight) {
  return pill(`发言权重 ${weight?.label ?? '未认证'}`, TONE[weight?.band] ?? '');
}

export function banner(tone, ...body) {
  return h('div', { class: `banner banner-${tone}` }, ...body);
}

export function bannerList(problems) {
  return banner(problems.some((p) => p.fatal) ? 'bad' : 'warn',
    h('ul', { class: 'verdict-list' },
      problems.map((p) => h('li', {}, h('strong', {}, p.title), ' ', p.detail))));
}

export function field(label, control, hint) {
  return h('label', { class: 'field' },
    h('span', { class: 'field-label' }, label),
    control,
    hint ? h('span', { class: 'field-hint' }, hint) : null);
}

export function input(props = {}) {
  return h('input', { class: 'input', ...props });
}

export function textarea(props = {}) {
  return h('textarea', { class: 'input textarea', ...props });
}

export function select(options, props = {}) {
  return h('select', { class: 'input', ...props },
    options.map((o) => h('option', { value: o.value, selected: o.selected }, o.label)));
}

export function button(label, props = {}) {
  return h('button', { class: `btn ${props.variant ? `btn-${props.variant}` : 'btn-primary'}`.trim(), ...props }, label);
}

export function copyable(value, label = '复制') {
  const btn = h('button', { class: 'btn btn-ghost btn-sm', type: 'button' }, label);
  btn.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(value);
      const prev = btn.textContent;
      btn.textContent = '已复制';
      setTimeout(() => { btn.textContent = prev; }, 1400);
    } catch {
      // Clipboard can be blocked; select the text so it can be copied by hand.
      const range = document.createRange();
      range.selectNodeContents(btn.previousSibling ?? btn);
      getSelection()?.removeAllRanges();
      getSelection()?.addRange(range);
      btn.textContent = '请手动复制';
      setTimeout(() => { btn.textContent = label; }, 2000);
    }
  });
  return btn;
}

export function codeBlock(value, cls = 'oneliner') {
  const pre = h('pre', { class: cls }, value);
  return h('div', { class: 'code-wrap' }, pre, copyable(value));
}

export function empty(message, action) {
  return h('div', { class: 'empty' }, h('p', {}, message), action ?? null);
}

export function spinner(label = '处理中') {
  return h('div', { class: 'spinner' }, h('span', { class: 'dot' }), label);
}

/* -------------------------------------------------------------- formatting */

export function fmtTime(ms) {
  if (ms == null) return '—';
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return '—';
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} `
    + `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}Z`;
}

export function fmtRelative(ms, now = Date.now()) {
  if (ms == null) return '—';
  const diff = ms - now;
  const abs = Math.abs(diff);
  const units = [[86400000, '天'], [3600000, '小时'], [60000, '分钟'], [1000, '秒']];
  for (const [size, name] of units) {
    if (abs >= size) {
      const n = Math.floor(abs / size);
      return diff >= 0 ? `${n}${name}后` : `${n}${name}前`;
    }
  }
  return '刚刚';
}

export function fmtCountdown(ms, now = Date.now()) {
  if (ms == null) return '未知';
  if (ms <= now) return '已开赛';
  return fmtRelative(ms, now);
}

/* ------------------------------------------------------------ team marks */

/**
 * A deterministic crest for a team name.
 *
 * Same name always yields the same colour and facet count, so a fixture reads
 * identically on the home page, the match page and a receipt. The hash is a
 * small local one on purpose: it only has to spread short strings, and pulling
 * in a crypto hash for a decorative colour would be nonsense.
 */
export function crest(team) {
  const name = String(team ?? '').toUpperCase();
  let hash = 0;
  for (let i = 0; i < name.length; i += 1) {
    hash = ((hash << 5) - hash + name.charCodeAt(i)) | 0;
  }
  // A curated hue set rather than the full wheel: a fixture palette that stays
  // inside the brand's world (steel, ice, teal, gold, ember) instead of turning
  // neon pink and lime at random.
  const HUES = [197, 210, 188, 168, 42, 28, 224, 250];
  const hue = HUES[Math.abs(hash) % HUES.length];
  const facets = 4 + (Math.abs(hash >> 8) % 4);
  const clip = [];
  for (let i = 0; i < facets; i += 1) {
    const a = (i / facets) * Math.PI * 2 - Math.PI / 2;
    const r = i % 2 === 0 ? 50 : 38;
    clip.push(`${(50 + r * Math.cos(a)).toFixed(1)}% ${(50 + r * Math.sin(a)).toFixed(1)}%`);
  }
  return h('span', {
    class: 'crest',
    title: name,
    style: {
      background: `linear-gradient(150deg, hsl(${hue} 74% 58%), hsl(${(hue + 22) % 360} 62% 34%))`,
      clipPath: `polygon(${clip.join(',')})`,
    },
  }, name.slice(0, 2));
}

/** A head-to-head fixture line: crest vs crest, with the name beside each. */
export function fixture(teams) {
  const list = Array.isArray(teams) ? teams : [teams];
  if (list.length < 2) {
    return h('span', { class: 'fixture' }, ...list.map((t) => h('span', { class: 'row' },
      crest(t), h('span', { class: 'num' }, t))));
  }
  const [a, b] = list;
  return h('span', { class: 'fixture' },
    crest(a), h('span', { class: 'num' }, a),
    h('span', { class: 'vs' }, 'vs'),
    h('span', { class: 'num' }, b), crest(b));
}
