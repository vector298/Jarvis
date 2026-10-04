import { h, icon, api, S, on, emit, fmt, toast, save, clear } from './util.js';
import { mountConsole, upsertJob, showDue } from './console.js';
import { createCalendarPane } from './panes/calendar.js';
import { createRemindersPane } from './panes/reminders.js';
import { createArchivePane } from './panes/archive.js';
import { createCommsPane } from './panes/comms.js';
import { createLogPane } from './panes/log.js';
import { isActive } from './job.js';

const $ = (id) => document.getElementById(id);

const TABS = [
  { id: 'calendar', label: 'Calendar', icon: 'calendar', make: createCalendarPane },
  { id: 'reminders', label: 'Reminders', icon: 'bell', make: createRemindersPane },
  { id: 'drive', label: 'Archive', icon: 'archive', make: createArchivePane },
  { id: 'comms', label: 'Comms', icon: 'comms', make: createCommsPane },
  { id: 'log', label: 'Log', icon: 'log', make: createLogPane },
];
const PANEL_ALIAS = { telegram: 'comms', drive: 'drive', calendar: 'calendar', reminders: 'reminders', log: 'log', comms: 'comms' };
const panes = {};
const tabButtons = {};
let activeTab = (() => { try { return localStorage.getItem('jarvis.tab') || 'calendar'; } catch { return 'calendar'; } })();
if (!TABS.some((t) => t.id === activeTab)) activeTab = 'calendar';

// ───── systems header ─────
const SYS_CHIPS = [
  { key: 'calendar', label: 'Calendar' },
  { key: 'drive', label: 'Archive' },
  { key: 'telegram', label: 'Comms' },
  { key: 'llm', label: 'Core' },
];

function renderChips() {
  const row = clear($('sysrow'));
  if (!S.systems) return;
  for (const c of SYS_CHIPS) {
    const sys = S.systems[c.key];
    row.append(h('button.chip', { data: { state: sys.state }, title: `${c.label}: ${sys.detail}`, 'aria-label': `${c.label}: ${sys.state}. Open systems`, on: { click: openSystems } },
      h('span.dot', { class: sys.state }), h('span.n', c.label)));
  }
  row.append(h('button.iconbtn', { 'aria-label': 'Systems and settings', title: 'Systems and settings', on: { click: openSystems } }, icon('gear', 17)));
  $('simflag').hidden = !S.systems.demo;
}

function renderStatus() {
  const el = $('status');
  const text = el.querySelector('.t');
  const busy = Boolean(S.queue.running) || S.queue.queued.length > 0;
  el.classList.toggle('lost', !S.live);
  el.classList.toggle('busy', S.live && busy);
  $('app').classList.toggle('busy', busy);
  text.textContent = !S.live ? 'LINK LOST' : busy ? 'PROCESSING' : 'ONLINE';
}

async function refreshSystems() {
  try {
    S.systems = await api('/systems');
    renderChips();
    emit('systems', S.systems);
  } catch { /* the status pill already shows a lost link */ }
}

// ───── popover ─────
const STATE_TEXT = { online: 'Online', degraded: 'Degraded', disconnected: 'Not connected', unconfigured: 'Not configured', expired: 'Authorisation expired', offline: 'Offline' };

async function openSystems() {
  const pop = $('pop');
  if (pop.firstChild) { clear(pop); return; }
  await refreshSystems();
  const draw = () => {
    const sys = S.systems;
    const g = sys.google;
    const row = (key, name, extra) => h('div.sys', h('span.dot', { class: sys[key].state }), h('span.nm', name), h('span.tag', STATE_TEXT[sys[key].state] || sys[key].state), h('div.dt', sys[key].detail), extra);
    const probe = () => api('/systems?probe=1').then((r) => { S.systems = r; renderChips(); draw(); }).catch((e) => toast(e.message, 'err'));
    const zones = (Intl.supportedValuesOf ? Intl.supportedValuesOf('timeZone') : [S.tz]);
    if (!zones.includes(S.tz)) zones.unshift(S.tz);
    const tzSel = h('select.select', { 'aria-label': 'Timezone', on: { change: async (e) => { S.tz = e.target.value; await api('/settings', { method: 'POST', body: { timezone: S.tz } }); toast(`Timezone set to ${S.tz}.`, 'ok'); Object.values(panes).forEach((p) => p.refresh()); } } }, zones.map((z) => h('option', { value: z }, z)));
    tzSel.value = S.tz;
    clear(pop).append(h('div.pop', { role: 'dialog', 'aria-label': 'Systems and settings' },
      h('div', { style: 'display:flex;align-items:center;padding-right:10px' }, h('h3', { style: 'flex:1' }, 'Systems'), h('button.btn.sm', { on: { click: probe } }, icon('refresh', 11), 'Diagnostics'), h('button.iconbtn', { 'aria-label': 'Close', on: { click: () => clear(pop) } }, icon('x', 15))),
      row('calendar', 'Calendar', g.configured || sys.demo ? h('div.ac', g.state === 'online' ? [h('span.dim', { style: 'font-size:12px' }, `Google account: ${g.account || 'connected'}`), sys.demo ? null : h('button.btn.sm', { on: { click: () => fetch('/auth/google/disconnect', { method: 'POST' }).then(() => { refreshSystems().then(draw); }) } }, 'Disconnect')] : sys.demo ? null : h('a.btn.primary.sm', { href: '/auth/google' }, g.state === 'expired' ? 'Reconnect Google' : 'Connect Google')) : h('div.ac', h('span.dim', { style: 'font-size:12px' }, 'Create an OAuth client in Google Cloud, then set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET. See the README.'))),
      row('drive', 'Archive', null),
      row('telegram', 'Comms', null),
      row('llm', 'Language core', null),
      row('reminders', 'Reminders', null),
      h('div.prefs',
        h('label.toggle', h('input', { type: 'checkbox', checked: S.settings.confirmConsequential, on: { change: async (e) => { S.settings.confirmConsequential = e.target.checked; await api('/settings', { method: 'POST', body: { confirmConsequential: e.target.checked } }); } } }),
          h('span', 'Ask before consequential actions', h('small', 'Sending messages, inviting guests and cancelling events wait for your go-ahead.'))),
        h('div', { style: 'display:grid;gap:6px' }, h('span.label', 'Timezone'), tzSel),
        'Notification' in window && Notification.permission === 'default'
          ? h('button.btn', { on: { click: () => Notification.requestPermission().then(draw) } }, icon('bell', 12), 'Enable desktop reminder alerts')
          : h('span.faint', { style: 'font-size:12px' }, 'Notification' in window ? `Desktop alerts: ${Notification.permission}` : 'Desktop alerts unavailable in this browser.'),
      ),
    ));
  };
  draw();
}
document.addEventListener('open-systems', openSystems);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') clear($('pop')); });
document.addEventListener('click', (e) => {
  const pop = $('pop');
  if (pop.firstChild && !pop.contains(e.target) && !e.target.closest('.chip, .iconbtn, [data-keep-pop]') ) clear(pop);
});

// ───── tabs ─────
function buildPreview() {
  const root = $('preview');
  const tabs = h('div.tabs', { role: 'tablist', 'aria-label': 'Live preview' });
  const holder = h('div', { style: 'flex:1;min-height:0;display:flex;flex-direction:column' });
  for (const t of TABS) {
    const btn = h('button.tab', { role: 'tab', id: `tab-${t.id}`, 'aria-selected': 'false', 'aria-controls': `pane-${t.id}`, on: { click: () => selectTab(t.id) } },
      icon(t.icon, 14), h('span.l', t.label), h('span.count'));
    tabButtons[t.id] = btn;
    tabs.append(btn);
    const pane = t.make();
    pane.el.id = `pane-${t.id}`;
    pane.el.setAttribute('role', 'tabpanel');
    pane.el.hidden = true;
    panes[t.id] = pane;
    holder.append(pane.el);
  }
  tabs.append(h('span.tab.sp', { style: 'cursor:default' }));
  const follow = h('button.follow', { 'aria-pressed': String(S.follow), title: 'Jump to the panel JARVIS just acted on', on: { click: () => { S.follow = !S.follow; save('jarvis.follow', S.follow ? '1' : '0'); follow.setAttribute('aria-pressed', String(S.follow)); } } }, h('span.sw'), h('span.t', 'Follow JARVIS'));
  tabs.append(follow);
  root.append(tabs, holder);
}

function selectTab(id, { quiet = false } = {}) {
  activeTab = id;
  save('jarvis.tab', id);
  for (const t of TABS) {
    const on_ = t.id === id;
    tabButtons[t.id].setAttribute('aria-selected', String(on_));
    tabButtons[t.id].classList.remove('pulse');
    panes[t.id].el.hidden = !on_;
  }
  if (!quiet) panes[id].activate();
}

function pulse(id) {
  if (id !== activeTab) tabButtons[id]?.classList.add('pulse');
  if (S_viewIsConsole()) $('mnav').querySelector('.badge')?.removeAttribute('hidden');
}

function updateBadges() {
  for (const t of TABS) {
    const b = panes[t.id].badge();
    const c = tabButtons[t.id].querySelector('.count');
    if (b == null) { c.textContent = ''; continue; }
    const n = typeof b === 'object' ? b.n : b;
    c.textContent = n ? String(n) : '';
    c.classList.toggle('hot', typeof b === 'object' && b.hot);
  }
}

const S_viewIsConsole = () => $('app').dataset.view === 'console' && matchMedia('(max-width: 860px)').matches;

// ───── mobile nav ─────
function buildMobileNav() {
  const nav = $('mnav');
  const mk = (id, label, ic) => h('button', { role: 'tab', 'aria-selected': String(id === 'console'), data: { view: id }, on: { click: () => setView(id) } }, icon(ic, 18), label, id === 'preview' ? h('span.badge', { hidden: true }) : null);
  nav.append(mk('console', 'Console', 'console'), mk('preview', 'Preview', 'calendar'));
}
function setView(v) {
  $('app').dataset.view = v;
  for (const b of $('mnav').children) b.setAttribute('aria-selected', String(b.dataset.view === v));
  if (v === 'preview') $('mnav').querySelector('.badge')?.setAttribute('hidden', '');
}

// ───── splitter ─────
function wireSplit() {
  const split = $('split');
  const main = $('main');
  try { const saved = localStorage.getItem('jarvis.split'); if (saved) main.style.setProperty('--split', `${saved}%`); } catch { /* ignore */ }
  const set = (pct) => { pct = Math.max(30, Math.min(66, pct)); main.style.setProperty('--split', `${pct}%`); save('jarvis.split', pct.toFixed(1)); };
  split.addEventListener('pointerdown', (e) => {
    split.setPointerCapture(e.pointerId);
    split.classList.add('drag');
    const move = (ev) => { const r = main.getBoundingClientRect(); set(((ev.clientX - r.left) / r.width) * 100); };
    const up = () => { split.classList.remove('drag'); split.removeEventListener('pointermove', move); split.removeEventListener('pointerup', up); };
    split.addEventListener('pointermove', move);
    split.addEventListener('pointerup', up);
  });
  split.addEventListener('keydown', (e) => {
    const cur = parseFloat(getComputedStyle(main).getPropertyValue('--split')) || 46;
    if (e.key === 'ArrowLeft') set(cur - 2);
    if (e.key === 'ArrowRight') set(cur + 2);
  });
}

// ───── live events ─────
function connect() {
  const es = new EventSource('/api/events');
  es.addEventListener('open', () => { S.live = true; renderStatus(); resync(); });
  es.addEventListener('error', () => { S.live = false; renderStatus(); });
  es.addEventListener('job', (e) => {
    const job = JSON.parse(e.data);
    upsertJob(job);
    emit('job', job);
  });
  es.addEventListener('queue', (e) => { S.queue = JSON.parse(e.data); emit('queue'); renderStatus(); });
  es.addEventListener('focus', (e) => {
    const f = JSON.parse(e.data);
    const id = PANEL_ALIAS[f.panel];
    if (!id || !panes[id]) return;
    if (S.follow) { selectTab(id, { quiet: true }); }
    panes[id].focus(f);
    pulse(id);
    updateBadgesSoon();
  });
  es.addEventListener('refresh', (e) => {
    const { panels } = JSON.parse(e.data);
    for (const p of panels) {
      if (p === 'status') { refreshSystems(); continue; }
      const id = PANEL_ALIAS[p];
      if (id && panes[id] && id !== 'log') panes[id].refresh();
      if (id === 'log' && activeTab === 'log') panes.log.refresh();
    }
    refreshSystemsDebounced();
    updateBadgesSoon();
  });
  es.addEventListener('ui', (e) => {
    const u = JSON.parse(e.data);
    if (u.action === 'openUpload') {
      selectTab('drive', { quiet: true });
      panes.drive.openUpload(u.folder);
      if (S_viewIsConsole()) setView('preview');
    }
  });
  es.addEventListener('reminder.due', (e) => {
    const r = JSON.parse(e.data);
    toast(`Reminder: ${r.text}`, 'info', 12000);
    if ('Notification' in window && Notification.permission === 'granted') {
      try { new Notification('JARVIS · Reminder', { body: r.text }); } catch { /* some browsers need a service worker */ }
    }
    panes.reminders.refresh();
  });
}

let sysTimer = null;
const refreshSystemsDebounced = () => { clearTimeout(sysTimer); sysTimer = setTimeout(refreshSystems, 400); };
let badgeTimer = null;
const updateBadgesSoon = () => { clearTimeout(badgeTimer); badgeTimer = setTimeout(updateBadges, 600); };

async function resync() {
  try {
    const state = await api(`/state?tz=${encodeURIComponent(S.tz)}`);
    S.queue = state.queue;
    S.systems = state.systems;
    for (const j of state.jobs) upsertJob(j);
    renderChips();
    Object.values(panes).forEach((p) => p.refresh());
  } catch { /* connection banner already shows */ }
}

// ───── clock ─────
function tickClock() {
  const now = new Date();
  const c = $('clock');
  c.querySelector('.t').textContent = fmt.clock(now);
  c.querySelector('.d').textContent = fmt.day(now);
}

// ───── boot ─────
const WORD = { online: ['ONLINE', 'ok'], degraded: ['DEGRADED', 'warn'], disconnected: ['NOT CONNECTED', 'warn'], unconfigured: ['NOT CONFIGURED', 'warn'], expired: ['AUTH EXPIRED', 'bad'], offline: ['OFFLINE', 'bad'] };

function runBoot(systems) {
  const boot = $('boot');
  const seen = (() => { try { return sessionStorage.getItem('jarvis.booted'); } catch { return null; } })();
  if (seen || matchMedia('(prefers-reduced-motion: reduce)').matches) return Promise.resolve();
  try { sessionStorage.setItem('jarvis.booted', '1'); } catch { /* ignore */ }
  boot.hidden = false;
  const lines = [
    ['Core', 'ONLINE', 'ok'],
    ['Calendar link', ...(WORD[systems.calendar.state] || ['UNKNOWN', 'warn'])],
    ['Stark archive', ...(WORD[systems.drive.state] || ['UNKNOWN', 'warn'])],
    ['Comms relay', ...(WORD[systems.telegram.state] || ['UNKNOWN', 'warn'])],
    ['Language core', systems.llm.state === 'online' ? 'ONLINE' : 'BUILT-IN PARSER', systems.llm.state === 'online' ? 'ok' : 'warn'],
    ['Doomsday protocol', 'READY', 'ok'],
  ];
  const log = h('div.log');
  boot.append(reactor(), h('div.title', 'J.A.R.V.I.S.'), log, h('div.skip', 'click to skip'));
  return new Promise((resolve) => {
    let i = 0;
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      boot.classList.add('out');
      setTimeout(() => { boot.hidden = true; resolve(); }, 520);
    };
    boot.addEventListener('click', finish, { once: true });
    const next = () => {
      if (done) return;
      if (i >= lines.length) return setTimeout(finish, 520);
      const [name, word, cls] = lines[i++];
      log.append(h('div', h('span', name.toUpperCase()), h('span.lead'), h('span', { class: cls }, word)));
      setTimeout(next, 230);
    };
    setTimeout(next, 500);
  });
}

function reactor() {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 32 32');
  svg.setAttribute('class', 'big');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.innerHTML = '<circle class="r1" cx="16" cy="16" r="13.5" stroke-width=".8"/><circle class="seg" cx="16" cy="16" r="9.2" stroke-width="2.4" stroke-dasharray="4.3 1.8"/><circle cx="16" cy="16" r="4.6" stroke-width=".8"/><circle cx="16" cy="16" r="1.8" fill="currentColor" stroke="none"/>';
  return svg;
}

// ───── start ─────
async function start() {
  buildMobileNav();
  buildPreview();
  wireSplit();
  mountConsole($('console'));
  tickClock();
  setInterval(tickClock, 1000);
  on('due', (list) => { showDue(list); updateBadgesSoon(); });

  let state;
  try {
    state = await api(`/state?tz=${encodeURIComponent(S.tz)}`);
  } catch (err) {
    S.live = false;
    renderStatus();
    toast(err.message, 'err', 0);
    return;
  }
  S.tz = state.settings.timezone || S.tz;
  S.settings = state.settings;
  S.systems = state.systems;
  S.queue = state.queue;
  S.loaded = true;
  renderChips();
  renderStatus();
  selectTab(activeTab);
  emit('jobs-loaded', state.jobs);
  connect();
  await runBoot(state.systems);
  setInterval(updateBadges, 20000);
  // if the stream drops, keep the transcript moving by polling
  setInterval(() => { if (!S.live && [...S.jobs.values()].some(isActive)) resync(); }, 2500);
  setTimeout(updateBadges, 1200);

  const params = new URLSearchParams(location.search);
  if (params.has('google')) {
    const r = params.get('google');
    if (r === 'connected') {
      toast('Google account connected. Calendar and Archive are live.', 'ok');
      selectTab('drive');
      if (S_viewIsConsole()) setView('preview');
    }
    else if (r === 'error') toast(`Google sign-in did not complete: ${params.get('reason') || 'unknown reason'}`, 'err', 9000);
    else if (r === 'demo') toast('Simulation mode: no real Google account is used.');
    history.replaceState({}, '', '/');
  }
}

start();
