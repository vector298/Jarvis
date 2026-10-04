import { h, icon, api, S, fmt, ymd, dayDiff, relDay, startOfDay, addDays, toast, put } from '../util.js';
import { loading, errorState } from './common.js';

const HOUR_PX = 48;

export function createCalendarPane() {
  const el = h('div.pane');
  const st = {
    view: (() => { try { return localStorage.getItem('jarvis.calview') || 'agenda'; } catch { return 'agenda'; } })(),
    anchor: startOfDay(new Date()),
    events: [],
    reminders: [],
    showRem: true,
    error: null,
    loaded: false,
    syncedAt: null,
    highlight: null,
    open: null,
    confirmDelete: null,
  };
  let seq = 0;

  // Monday of the week containing `d`, in the user's timezone.
  function mondayOf(d) {
    const sod = startOfDay(d);
    const label = new Intl.DateTimeFormat('en-US', { timeZone: S.tz, weekday: 'short' }).format(sod);
    const idx = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].indexOf(label);
    return addDays(sod, -idx);
  }

  const range = () => {
    if (st.view === 'week') {
      const from = mondayOf(st.anchor);
      return { from, to: addDays(from, 7) };
    }
    return { from: st.anchor, to: addDays(st.anchor, 14) };
  };

  async function load({ quiet = false } = {}) {
    const mine = ++seq;
    if (!quiet && !st.loaded) { put(el, bar(), h('div.pane-body', loading('Reading calendar'))); }
    const { from, to } = range();
    try {
      const [ev, rem] = await Promise.all([
        api(`/calendar/events?from=${encodeURIComponent(from.toISOString())}&to=${encodeURIComponent(to.toISOString())}&tz=${encodeURIComponent(S.tz)}`),
        api('/reminders').catch(() => ({ active: [] })),
      ]);
      if (mine !== seq) return;
      st.events = ev.events;
      st.reminders = rem.active;
      st.error = null;
      st.syncedAt = new Date();
    } catch (err) {
      if (mine !== seq) return;
      st.error = err;
    }
    st.loaded = true;
    draw();
  }

  function setView(v) {
    st.view = v;
    try { localStorage.setItem('jarvis.calview', v); } catch { /* ignore */ }
    load();
  }

  function shift(days) {
    st.anchor = addDays(st.view === 'week' ? mondayOf(st.anchor) : st.anchor, days);
    load();
  }

  function bar() {
    const { from, to } = range();
    const last = addDays(to, -1);
    const label = `${fmt.dnum(from)} ${fmt.mon(from)} – ${fmt.dnum(last)} ${fmt.mon(last)}`;
    return h('div.pane-bar',
      h('button.iconbtn', { 'aria-label': 'Previous', on: { click: () => shift(-7) } }, icon('left', 16)),
      h('button.btn.sm', { on: { click: () => { st.anchor = startOfDay(new Date()); load(); } } }, 'Today'),
      h('button.iconbtn', { 'aria-label': 'Next', on: { click: () => shift(7) } }, icon('right', 16)),
      h('span.range', label),
      h('span.sp'),
      h('div.seg', { role: 'group', 'aria-label': 'Calendar view' },
        h('button', { 'aria-pressed': String(st.view === 'agenda'), on: { click: () => setView('agenda') } }, 'Agenda'),
        h('button', { 'aria-pressed': String(st.view === 'week'), on: { click: () => setView('week') } }, 'Week'),
      ),
      h('button.btn.sm', { 'aria-pressed': String(st.showRem), title: 'Show personal reminders alongside events', on: { click: () => { st.showRem = !st.showRem; draw(); } }, style: st.showRem ? 'color:var(--verd);border-color:#2c5a49' : '' }, icon('diamond', 10), 'Reminders'),
      h('button.iconbtn', { 'aria-label': 'Refresh', title: 'Refresh', on: { click: () => load() } }, icon('refresh', 15)),
      st.syncedAt ? h('span.sync', `synced ${fmt.clock(st.syncedAt)}`) : null,
    );
  }

  function remsInRange() {
    const { from, to } = range();
    return st.showRem ? st.reminders.filter((r) => new Date(r.at) >= from && new Date(r.at) < to) : [];
  }

  function eventRow(e) {
    const past = new Date(e.end || e.start) < new Date();
    const open = st.open === e.id;
    const when = e.allDay ? 'ALL DAY' : fmt.range(e.start, e.end || e.start);
    const row = h('button.ev', { class: `${past ? 'past' : ''}`, data: { id: e.id }, 'aria-expanded': String(open), on: { click: () => { st.open = open ? null : e.id; st.confirmDelete = null; draw(); } } },
      h('span.when', when),
      h('div', h('div.ttl', e.title), e.location && !open ? h('div.sub', e.location) : null),
    );
    if (open) {
      row.append(h('div.more',
        e.location ? h('div.row', icon('diamond', 8), e.location) : null,
        e.description ? h('div', e.description) : null,
        e.attendees?.length ? h('div.row', h('span.label', 'Guests'), e.attendees.join(', ')) : null,
        h('div.row',
          e.link ? h('a.btn.sm', { href: e.link, target: '_blank', rel: 'noopener', on: { click: (ev) => ev.stopPropagation() } }, icon('external', 11), 'Open in Google') : null,
          st.confirmDelete === e.id
            ? [
              h('span.dim', 'Cancel this event?'),
              h('span.btn.sm.danger', { role: 'button', tabindex: '0', on: { click: (ev) => { ev.stopPropagation(); remove(e); } } }, 'Yes, cancel it'),
              h('span.btn.sm', { role: 'button', tabindex: '0', on: { click: (ev) => { ev.stopPropagation(); st.confirmDelete = null; draw(); } } }, 'Keep'),
            ]
            : h('span.btn.sm.danger', { role: 'button', tabindex: '0', on: { click: (ev) => { ev.stopPropagation(); st.confirmDelete = e.id; draw(); } } }, icon('trash', 11), 'Cancel event'),
        ),
      ));
    }
    return row;
  }

  async function remove(e) {
    try {
      await api(`/calendar/events/${encodeURIComponent(e.id)}/delete`, { method: 'POST', body: { title: e.title, tz: S.tz } });
      st.open = null;
      st.confirmDelete = null;
      draw();
      toast('Cancelling the event. Progress is in the console.');
    } catch (err) { toast(err.message, 'err'); }
  }

  function agenda() {
    const { from } = range();
    const days = [];
    for (let i = 0; i < 14; i++) days.push(addDays(from, i));
    const rems = remsInRange();
    const wrap = h('div.agenda');
    let shown = 0;
    for (const d of days) {
      const key = ymd(d);
      const evs = st.events.filter((e) => ymd(e.start) === key);
      const rs = rems.filter((r) => ymd(r.at) === key);
      const today = dayDiff(d) === 0;
      if (!evs.length && !rs.length && !today) continue;
      shown++;
      const rel = relDay(d);
      const items = [];
      for (const e of evs.filter((x) => x.allDay)) items.push({ t: -1, n: eventRow(e) });
      for (const e of evs.filter((x) => !x.allDay)) items.push({ t: new Date(e.start).getTime(), n: eventRow(e) });
      for (const r of rs) {
        items.push({
          t: new Date(r.at).getTime(),
          n: h('div.rem', { data: { id: r.id } }, icon('diamond', 11), h('span.rt', fmt.time(r.at)), h('span.rx', r.text), h('span.tag.reminders', 'Reminder')),
        });
      }
      items.sort((a, b) => a.t - b.t);
      wrap.append(h('div.day', { class: today ? 'today' : '' },
        h('div.day-h', h('div.dow', fmt.dow(d)), h('div.dnum', fmt.dnum(d)), rel ? h('div.rel', rel) : h('div.rel.faint', fmt.mon(d))),
        h('div.day-items', { class: items.length ? '' : 'nothing' }, items.length ? items.map((i) => i.n) : 'Nothing scheduled.'),
      ));
    }
    if (!shown || !st.events.length && !rems.length) {
      wrap.append(h('div', { style: 'padding:14px' }, h('span.faint', 'No events in this window.')));
    }
    return wrap;
  }

  function lanes(evs) {
    const sorted = [...evs].sort((a, b) => a.s - b.s);
    const out = [];
    let cluster = [];
    let clusterEnd = -1;
    const flush = () => {
      if (!cluster.length) return;
      const laneEnds = [];
      for (const e of cluster) {
        let l = laneEnds.findIndex((end) => end <= e.s);
        if (l < 0) { l = laneEnds.length; laneEnds.push(0); }
        laneEnds[l] = e.e;
        e.lane = l;
      }
      for (const e of cluster) e.lanes = laneEnds.length;
      out.push(...cluster);
      cluster = [];
    };
    for (const e of sorted) {
      if (e.s >= clusterEnd) flush();
      cluster.push(e);
      clusterEnd = Math.max(clusterEnd === -1 || e.s >= clusterEnd ? 0 : clusterEnd, e.e);
    }
    flush();
    return out;
  }

  function week() {
    const from = mondayOf(st.anchor);
    const days = Array.from({ length: 7 }, (_, i) => addDays(from, i));
    const rems = remsInRange();
    const timed = st.events.filter((e) => !e.allDay);
    const mins = (iso, d) => (new Date(iso) - d) / 60000;
    let startH = 7;
    let endH = 21;
    for (const e of timed) {
      const d = days.find((x) => ymd(x) === ymd(e.start));
      if (!d) continue;
      startH = Math.min(startH, Math.floor(mins(e.start, startOfDay(d)) / 60));
      endH = Math.max(endH, Math.ceil(mins(e.end || e.start, startOfDay(d)) / 60));
    }
    startH = Math.max(0, startH);
    endH = Math.min(24, endH);
    const total = (endH - startH) * HOUR_PX;

    const head = h('div.week-head', h('div'), ...days.map((d) => h('div', { class: dayDiff(d) === 0 ? 'today' : '' }, h('span.dow', fmt.dow(d)), h('span.dn', fmt.dnum(d)))));
    const allDay = h('div.allday', h('div'), ...days.map((d) => h('div', st.events.filter((e) => e.allDay && ymd(e.start) === ymd(d)).map((e) => h('div.chipad', { title: e.title }, e.title)))));
    const hours = h('div.hours', { style: `height:${total}px` }, ...Array.from({ length: endH - startH + 1 }, (_, i) => h('span', { style: `top:${i * HOUR_PX}px` }, i === 0 ? '' : `${String((startH + i) % 24).padStart(2, '0')}:00`)));
    const cols = days.map((d) => {
      const sod = startOfDay(d);
      const col = h('div.col', { class: dayDiff(d) === 0 ? 'today' : '', style: `height:${total}px` });
      const mine = lanes(timed.filter((e) => ymd(e.start) === ymd(d)).map((e) => ({ ev: e, s: mins(e.start, sod), e: mins(e.end || e.start, sod) })));
      for (const m of mine) {
        const top = ((m.s - startH * 60) / 60) * HOUR_PX;
        const hgt = Math.max(((m.e - m.s) / 60) * HOUR_PX - 2, 20);
        const w = 100 / m.lanes;
        col.append(h('button.blk', {
          data: { id: m.ev.id },
          title: `${m.ev.title}\n${fmt.time(m.ev.start)} – ${fmt.time(m.ev.end)}`,
          style: `top:${top}px;height:${hgt}px;left:calc(${m.lane * w}% + 2px);right:auto;width:calc(${w}% - 4px)`,
          on: { click: () => { st.view = 'agenda'; st.anchor = startOfDay(m.ev.start); st.open = m.ev.id; load(); } },
        }, h('span.bt', fmt.time(m.ev.start)), m.ev.title));
      }
      for (const r of rems.filter((x) => ymd(x.at) === ymd(d))) {
        const top = (mins(r.at, sod) / 60 - startH) * HOUR_PX;
        if (top < 0 || top > total) continue;
        col.append(h('div.blk.rm', { data: { id: r.id }, title: `Reminder: ${r.text}`, style: `top:${top}px;left:2px;right:2px` }, h('span.bt', { style: 'color:var(--verd)' }, fmt.time(r.at)), r.text));
      }
      if (dayDiff(d) === 0) {
        const nowTop = (mins(new Date(), sod) / 60 - startH) * HOUR_PX;
        if (nowTop >= 0 && nowTop <= total) col.append(h('div.nowline', { style: `top:${nowTop}px` }));
      }
      return col;
    });
    return h('div.week', head, allDay, hours, ...cols);
  }

  function draw() {
    const body = h('div.pane-body');
    if (st.error) body.append(errorState(st.error, { onRetry: () => load(), what: 'Calendar link' }));
    else if (st.view === 'week') body.append(week());
    else body.append(agenda());
    put(el, bar(), body);
    if (st.highlight) {
      const target = el.querySelector(`[data-id="${CSS.escape(st.highlight)}"]`);
      if (target) {
        target.scrollIntoView({ block: 'center', behavior: 'smooth' });
        target.classList.add('flash');
      }
      st.highlight = null;
    }
  }

  return {
    el,
    refresh: () => load({ quiet: true }),
    activate: () => { if (!st.loaded) load(); else load({ quiet: true }); },
    focus({ date, highlight }) {
      if (date) {
        const d = new Date(date);
        const { from, to } = range();
        if (d < from || d >= to) st.anchor = startOfDay(d);
      }
      st.highlight = highlight || null;
      load({ quiet: true });
    },
    badge: () => st.events.filter((e) => ymd(e.start) === ymd(new Date())).length,
  };
}
