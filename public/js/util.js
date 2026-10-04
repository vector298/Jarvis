// Shared state, DOM helpers and formatting. Nothing here touches the network
// except `api`.

export const S = {
  tz: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
  settings: { confirmConsequential: true },
  systems: null,
  jobs: new Map(),
  queue: { running: null, queued: [], pending: false },
  live: false,
  mode: (() => { try { return localStorage.getItem('jarvis.mode') === 'interrupt' ? 'interrupt' : 'queue'; } catch { return 'queue'; } })(),
  follow: (() => { try { return localStorage.getItem('jarvis.follow') !== '0'; } catch { return true; } })(),
};

const listeners = new Map();
export const on = (ev, fn) => {
  if (!listeners.has(ev)) listeners.set(ev, new Set());
  listeners.get(ev).add(fn);
  return () => listeners.get(ev).delete(fn);
};
export const emit = (ev, data) => listeners.get(ev)?.forEach((fn) => fn(data));

export function save(key, value) {
  try { localStorage.setItem(key, value); } catch { /* private mode */ }
}

// h('div.card#x', { text, on: { click }, data: { a: 1 }, class: 'extra' }, ...children)
export function h(spec, props, ...kids) {
  const m = /^([a-z0-9]+)((?:[.#][\w-]+)*)$/i.exec(spec);
  const el = document.createElement(m ? m[1] : spec);
  if (m && m[2]) {
    for (const part of m[2].match(/[.#][\w-]+/g)) {
      if (part[0] === '.') el.classList.add(part.slice(1));
      else el.id = part.slice(1);
    }
  }
  if (props && (props.nodeType || typeof props === 'string' || Array.isArray(props))) {
    kids.unshift(props);
    props = null;
  }
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') v.split(' ').filter(Boolean).forEach((c) => el.classList.add(c));
    else if (k === 'text') el.textContent = v;
    else if (k === 'on') for (const [ev, fn] of Object.entries(v)) el.addEventListener(ev, fn);
    else if (k === 'data') Object.assign(el.dataset, v);
    else if (k === 'style') el.style.cssText = v;
    else if (k === 'value') el.value = v;
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, v);
  }
  append(el, kids);
  return el;
}

function append(el, kids) {
  for (const k of kids.flat(Infinity)) {
    if (k == null || k === false) continue;
    el.append(k.nodeType ? k : document.createTextNode(String(k)));
  }
}

export const clear = (el) => { el.replaceChildren(); return el; };
const real = (kids) => kids.flat(Infinity).filter((k) => k != null && k !== false);
export const put = (el, ...kids) => { el.replaceChildren(...real(kids)); return el; };
export const add = (el, ...kids) => { el.append(...real(kids)); return el; };

const ICONS = {
  check: '<path d="M4 12.5l5 5L20 6.5"/>',
  x: '<path d="M6 6l12 12M18 6L6 18"/>',
  dash: '<path d="M6 12h12"/>',
  circle: '<circle cx="12" cy="12" r="7.5"/>',
  spin: '<path d="M12 4.5a7.5 7.5 0 1 1-7.5 7.5" />',
  ask: '<circle cx="12" cy="12" r="8.5"/><path d="M9.6 9.6a2.6 2.6 0 1 1 3.6 2.4c-.8.4-1.2 1-1.2 1.8M12 16.6v.1"/>',
  shield: '<path d="M12 3.5l7 2.8v5.4c0 4.2-2.9 7.4-7 8.8-4.1-1.4-7-4.6-7-8.8V6.3z"/><path d="M12 8.5v4M12 15.2v.1"/>',
  slash: '<circle cx="12" cy="12" r="8"/><path d="M6.5 17.5l11-11"/>',
  clip: '<path d="M19 11.5l-7 7a4.5 4.5 0 0 1-6.4-6.4l7.4-7.4a3 3 0 0 1 4.3 4.3l-7.4 7.4a1.5 1.5 0 0 1-2.2-2.2l6.7-6.7"/>',
  mic: '<rect x="9" y="3.5" width="6" height="11" rx="3"/><path d="M5.5 11.5a6.5 6.5 0 0 0 13 0M12 18v3"/>',
  send: '<path d="M4 12l16-7-6 15-2.6-6.2z"/>',
  left: '<path d="M14.5 6l-6 6 6 6"/>',
  right: '<path d="M9.5 6l6 6-6 6"/>',
  refresh: '<path d="M19.5 12a7.5 7.5 0 1 1-2.2-5.3M19.5 4.5v4h-4"/>',
  external: '<path d="M14 4.5h5.5V10M19 5l-8 8M18 14v4.5a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V8a1 1 0 0 1 1-1h4.5"/>',
  trash: '<path d="M5 7h14M10 7V4.5h4V7M7 7l.8 12.5h8.4L17 7"/>',
  snooze: '<circle cx="12" cy="13" r="7"/><path d="M12 9.5V13l2.5 1.5M5 5l3-2M19 5l-3-2"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  folder: '<path d="M3.5 7a1 1 0 0 1 1-1h4.8l2 2.2h8.2a1 1 0 0 1 1 1V18a1 1 0 0 1-1 1h-15a1 1 0 0 1-1-1z"/>',
  search: '<circle cx="11" cy="11" r="6"/><path d="M16 16l4 4"/>',
  upload: '<path d="M12 16V5M7.5 9.5L12 5l4.5 4.5M5 19h14"/>',
  calendar: '<rect x="4" y="5.5" width="16" height="14" rx="1"/><path d="M4 10h16M8.5 3.5v4M15.5 3.5v4"/>',
  bell: '<path d="M6 17.5h12l-1.5-2V11a4.5 4.5 0 0 0-9 0v4.5zM10 20h4"/>',
  archive: '<path d="M4 7.5h16V19H4zM3 4.5h18v3H3zM10 12h4"/>',
  comms: '<path d="M4 12l16-7-6 15-2.6-6.2z"/><path d="M11.4 13.8L20 5"/>',
  log: '<path d="M7 6.5h13M7 12h13M7 17.5h13M3.8 6.5h.1M3.8 12h.1M3.8 17.5h.1"/>',
  console: '<rect x="3.5" y="5" width="17" height="14" rx="1"/><path d="M7 10l3 2.5L7 15M12.5 15H17"/>',
  gear: '<circle cx="12" cy="12" r="3"/><path d="M12 3.5v2.5M12 18v2.5M3.5 12H6M18 12h2.5M6 6l1.8 1.8M16.2 16.2L18 18M18 6l-1.8 1.8M7.8 16.2L6 18"/>',
  diamond: '<path d="M12 4l7 8-7 8-7-8z"/>',
  retry: '<path d="M4.5 12a7.5 7.5 0 1 1 2.2 5.3M4.5 19.5v-4h4"/>',
  link: '<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>',
};

export function icon(name, size = 14, cls = '') {
  const wrap = document.createElement('span');
  wrap.style.display = 'inline-flex';
  wrap.innerHTML = `<svg class="${cls}" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="square" stroke-linejoin="miter" aria-hidden="true">${ICONS[name] || ''}</svg>`;
  return wrap.firstElementChild;
}

export async function api(path, { method = 'GET', body, signal } = {}) {
  let res;
  try {
    res = await fetch(`/api${path}`, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal,
    });
  } catch (err) {
    const e = new Error('Cannot reach the JARVIS server.');
    e.code = 'NETWORK';
    throw e;
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const e = new Error(data?.error?.message || `Request failed (${res.status})`);
    e.code = data?.error?.code || 'ERROR';
    e.hint = data?.error?.hint;
    throw e;
  }
  return data;
}

// ───── time ─────
const dtf = (opts) => new Intl.DateTimeFormat('en-US', { timeZone: S.tz, ...opts });
export const fmt = {
  time: (d) => dtf({ hour: 'numeric', minute: '2-digit' }).format(new Date(d)),
  clock: (d) => dtf({ hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).format(new Date(d)),
  hm: (d) => dtf({ hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(d)),
  dow: (d) => dtf({ weekday: 'short' }).format(new Date(d)).toUpperCase(),
  dnum: (d) => dtf({ day: 'numeric' }).format(new Date(d)),
  mon: (d) => dtf({ month: 'short' }).format(new Date(d)).toUpperCase(),
  day: (d) => dtf({ weekday: 'short', day: 'numeric', month: 'short' }).format(new Date(d)),
  long: (d) => dtf({ weekday: 'long', day: 'numeric', month: 'long' }).format(new Date(d)),
  range: (a, b) => {
    const A = dtf({ hour: 'numeric', minute: '2-digit' }).format(new Date(a));
    const B = dtf({ hour: 'numeric', minute: '2-digit' }).format(new Date(b));
    const [, ta, ma] = /^(.*) (AM|PM)$/.exec(A) || [];
    const [, tb, mb] = /^(.*) (AM|PM)$/.exec(B) || [];
    return ma && ma === mb ? `${ta} – ${tb} ${mb}` : `${A} – ${B}`;
  },
  full: (d) => dtf({ day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' }).format(new Date(d)),
  shortDate: (d) => dtf({ day: 'numeric', month: 'short', year: 'numeric' }).format(new Date(d)),
};

export function ymd(d) {
  const p = Object.fromEntries(dtf({ year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(d)).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}`;
}

export function dayDiff(d, ref = new Date()) {
  const a = ymd(d).split('-').map(Number);
  const b = ymd(ref).split('-').map(Number);
  return Math.round((Date.UTC(a[0], a[1] - 1, a[2]) - Date.UTC(b[0], b[1] - 1, b[2])) / 86400000);
}

export function relDay(d) {
  const n = dayDiff(d);
  return n === 0 ? 'Today' : n === 1 ? 'Tomorrow' : n === -1 ? 'Yesterday' : '';
}

// tz-aware wall time -> UTC Date (same approach as the server)
export function zoned(y, mo, d, h = 0, mi = 0) {
  const guess = Date.UTC(y, mo - 1, d, h, mi);
  const off = (t) => {
    const p = Object.fromEntries(dtf({ year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(t)).map((x) => [x.type, x.value]));
    return (Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - Math.floor(t / 1000) * 1000) / 60000;
  };
  let t = guess - off(guess) * 60000;
  const o2 = off(t);
  if (o2 !== off(guess)) t = guess - o2 * 60000;
  return new Date(t);
}

export function startOfDay(d) {
  const [y, m, dd] = ymd(d).split('-').map(Number);
  return zoned(y, m, dd);
}

export function addDays(d, n) {
  const [y, m, dd] = ymd(d).split('-').map(Number);
  return zoned(y, m, dd + n);
}

export function until(iso) {
  const ms = new Date(iso) - Date.now();
  const abs = Math.abs(ms);
  const m = Math.round(abs / 60000);
  const txt = m < 1 ? 'now' : m < 60 ? `${m}m` : m < 1440 ? `${Math.floor(m / 60)}h ${m % 60 ? `${m % 60}m` : ''}`.trim() : `${Math.floor(m / 1440)}d ${Math.floor((m % 1440) / 60)}h`;
  if (m < 1) return 'now';
  return ms >= 0 ? `in ${txt}` : `${txt} ago`;
}

export function ago(iso) {
  const m = Math.round((Date.now() - new Date(iso)) / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  if (m < 1440) return `${Math.floor(m / 60)} h ago`;
  const d = Math.floor(m / 1440);
  return d < 30 ? `${d} d ago` : fmt.shortDate(iso);
}

export function bytes(n) {
  if (n == null) return '—';
  if (n < 1024) return `${n} B`;
  if (n < 1048576) return `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} KB`;
  if (n < 1073741824) return `${(n / 1048576).toFixed(n < 10485760 ? 1 : 0)} MB`;
  return `${(n / 1073741824).toFixed(1)} GB`;
}

export function toast(message, kind = 'info', ms = 5000) {
  const root = document.getElementById('toasts');
  const t = h('div.toast', { class: kind === 'err' ? 'err' : kind === 'ok' ? 'ok' : '', role: kind === 'err' ? 'alert' : 'status' },
    h('span.ico', icon(kind === 'err' ? 'x' : kind === 'ok' ? 'check' : 'shield', 14)),
    h('div', message),
    h('button.iconbtn.sm', { 'aria-label': 'Dismiss', on: { click: () => t.remove() } }, icon('x', 12)),
  );
  root.append(t);
  if (ms) setTimeout(() => t.remove(), ms);
  return t;
}

export const KIND_LABEL = { pdf: 'PDF', doc: 'DOC', sheet: 'XLS', slides: 'PPT', image: 'IMG', video: 'VID', audio: 'AUD', archive: 'ZIP', text: 'TXT', code: 'SRC', cad: 'CAD', folder: 'DIR', file: 'FILE' };
export function kindBadge(kind) {
  return h('span.kind', { class: kind }, KIND_LABEL[kind] || 'FILE');
}

export const INTEGRATION_LABEL = { calendar: 'Calendar', reminders: 'Reminders', drive: 'Archive', telegram: 'Comms' };
export const integrationTag = (i) => h('span.tag', { class: i }, (INTEGRATION_LABEL[i] || i).toUpperCase());
