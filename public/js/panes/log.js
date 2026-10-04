import { h, icon, api, fmt, integrationTag, relDay, put } from '../util.js';
import { loading, emptyState, errorState } from './common.js';

const ICON = { ok: 'check', failed: 'x', declined: 'slash', cancelled: 'dash' };

export function createLogPane() {
  const el = h('div.pane');
  const st = { actions: [], only: 'all', error: null, loaded: false };

  async function load() {
    try { st.actions = (await api('/log?limit=150')).actions; st.error = null; } catch (err) { st.error = err; }
    st.loaded = true;
    draw();
  }

  function draw() {
    const shown = st.only === 'failed' ? st.actions.filter((a) => a.status === 'failed') : st.actions;
    const body = h('div.pane-body');
    if (st.error) body.append(errorState(st.error, { onRetry: load, what: 'Log' }));
    else if (!shown.length) body.append(emptyState({ glyph: 'log', title: st.only === 'failed' ? 'No failures' : 'Nothing logged yet', text: 'Every action JARVIS takes is recorded here, with what happened and where it came from.' }));
    else {
      let lastDay = '';
      for (const a of shown) {
        const day = fmt.day(a.ts);
        if (day !== lastDay) {
          body.append(h('div.sect', h('span.label', relDay(a.ts) ? `${relDay(a.ts)} · ${day}` : day), h('span.rule')));
          lastDay = day;
        }
        body.append(h('div.lrow', { class: a.status },
          h('span.lt', fmt.hm(a.ts)),
          h('span.li', integrationTag(a.integration)),
          h('div',
            h('div.ll', h('span.ico-s', { style: `color:${a.status === 'ok' ? 'var(--verd)' : a.status === 'failed' ? 'var(--red)' : 'var(--gold)'}` }, icon(ICON[a.status] || 'dash', 13)), a.label),
            h('div.ls', a.summary),
          ),
          h('span.tag', { class: a.origin === 'command' ? 'jarvis' : 'console' }, a.origin === 'command' ? 'JARVIS' : 'Console'),
        ));
      }
    }
    put(el,
      h('div.pane-bar',
        h('div.seg', { role: 'group' },
          h('button', { 'aria-pressed': String(st.only === 'all'), on: { click: () => { st.only = 'all'; draw(); } } }, 'All actions'),
          h('button', { 'aria-pressed': String(st.only === 'failed'), on: { click: () => { st.only = 'failed'; draw(); } } }, 'Failures'),
        ),
        h('span.sp'),
        h('span.faint', { style: 'font-size:12px' }, 'JARVIS = from a typed order · Console = clicked by hand'),
        h('button.iconbtn', { 'aria-label': 'Refresh', on: { click: load } }, icon('refresh', 15)),
      ),
      body,
    );
  }

  put(el, h('div.pane-body', loading('Reading log')));
  load();
  return { el, refresh: load, activate: load, focus: () => load(), badge: () => null };
}
