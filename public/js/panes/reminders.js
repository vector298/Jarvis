import { h, icon, api, S, fmt, dayDiff, until, zoned, toast, emit, put, add } from '../util.js';
import { loading, emptyState, errorState } from './common.js';

function defaultWhen() {
  const d = new Date(Date.now() + 60 * 60000);
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: S.tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' }).formatToParts(d).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}T${p.hour}:00`;
}

export function createRemindersPane() {
  const el = h('div.pane');
  const st = { active: [], closed: [], loaded: false, error: null, highlight: null, showDone: false };

  async function load() {
    try {
      const data = await api('/reminders');
      st.active = data.active;
      st.closed = data.closed;
      st.error = null;
      emit('due', st.active.filter((r) => r.status === 'due'));
    } catch (err) {
      st.error = err;
    }
    st.loaded = true;
    draw();
  }

  const act = (id, action, body) => api(`/reminders/${id}/${action}`, { method: 'POST', body }).then(load).catch((e) => toast(e.message, 'err'));

  async function addReminder(textEl, whenEl) {
    const text = textEl.value.trim();
    const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(whenEl.value);
    if (!text) return textEl.focus();
    if (!m) return toast('Pick a date and time for the reminder.', 'err');
    const at = zoned(+m[1], +m[2], +m[3], +m[4], +m[5]);
    try {
      await api('/reminders', { method: 'POST', body: { text, at: at.toISOString() } });
      textEl.value = '';
      await load();
    } catch (err) { toast(err.message, 'err'); }
  }

  function item(r, done = false) {
    const due = r.status === 'due';
    return h('div.ritem', { class: `${due ? 'due' : ''} ${done ? 'done' : ''}`, data: { id: r.id } },
      h('span.dm', icon('diamond', 13)),
      h('div',
        h('div.rtx', r.text),
        h('div.rwh', done ? `Completed ${fmt.day(r.doneAt)} ${fmt.time(r.doneAt)}` : [fmt.day(r.at), ' · ', fmt.time(r.at), ' · ', h('span.in', due ? 'due now' : until(r.at))]),
      ),
      done
        ? h('div.racts', h('button.iconbtn.sm', { title: 'Reopen', 'aria-label': 'Reopen', on: { click: () => act(r.id, 'reopen') } }, icon('retry', 13)))
        : h('div.racts',
          h('button.iconbtn.sm', { title: 'Mark done', 'aria-label': 'Mark done', on: { click: () => act(r.id, 'done') } }, icon('check', 14)),
          h('button.iconbtn.sm', { title: 'Snooze 10 minutes', 'aria-label': 'Snooze 10 minutes', on: { click: () => act(r.id, 'snooze', { minutes: 10 }) } }, icon('snooze', 14)),
          h('button.iconbtn.sm', { title: 'Delete', 'aria-label': 'Delete', on: { click: () => act(r.id, 'delete') } }, icon('trash', 13)),
        ),
    );
  }

  function section(label, list, cls = '') {
    if (!list.length) return null;
    return h('div', h('div.sect', { class: cls }, h('span.label', label), h('span.n', String(list.length)), h('span.rule')), list.map((r) => item(r)));
  }

  function draw() {
    const textEl = h('input.input', { placeholder: 'Remind me to…', 'aria-label': 'Reminder text', on: { keydown: (e) => e.key === 'Enter' && addReminder(textEl, whenEl) } });
    const whenEl = h('input.input', { type: 'datetime-local', value: defaultWhen(), 'aria-label': 'When', style: 'width:200px' });
    const body = h('div.pane-body');
    if (st.error) body.append(errorState(st.error, { onRetry: load, what: 'Reminder store' }));
    else {
      const due = st.active.filter((r) => r.status === 'due');
      const pending = st.active.filter((r) => r.status !== 'due');
      const today = pending.filter((r) => dayDiff(r.at) === 0);
      const tomorrow = pending.filter((r) => dayDiff(r.at) === 1);
      const later = pending.filter((r) => dayDiff(r.at) > 1);
      add(body,
        section('Due now', due, 'due'),
        section('Today', today),
        section('Tomorrow', tomorrow),
        section('Later', later),
      );
      if (!st.active.length) {
        body.append(emptyState({ glyph: 'bell', title: 'No active reminders', text: 'Try “remind me to check the reactor at 8 PM”, or add one above.' }));
      }
      if (st.closed.length) {
        body.append(h('div',
          h('div.sect', h('button.btn.sm', { on: { click: () => { st.showDone = !st.showDone; draw(); } } }, st.showDone ? 'Hide completed' : `Completed (${st.closed.length})`), h('span.rule')),
          st.showDone ? st.closed.map((r) => item(r, true)) : null,
        ));
      }
    }
    put(el,
      h('div.addrem', textEl, whenEl, h('button.btn.primary', { on: { click: () => addReminder(textEl, whenEl) } }, icon('plus', 12), 'Add')),
      body,
    );
    if (st.highlight) {
      const t = el.querySelector(`[data-id="${CSS.escape(st.highlight)}"]`);
      if (t) { t.scrollIntoView({ block: 'center', behavior: 'smooth' }); t.classList.add('flash'); }
      st.highlight = null;
    }
  }

  put(el, h('div.pane-body', loading('Reading reminders')));
  load();
  setInterval(() => { if (st.loaded && !st.error) { if (el.isConnected && el.offsetParent) draw(); } }, 30000);

  return {
    el,
    refresh: load,
    activate: load,
    focus({ highlight }) { st.highlight = highlight || null; load(); },
    badge: () => ({ n: st.active.length, hot: st.active.some((r) => r.status === 'due') }),
  };
}
