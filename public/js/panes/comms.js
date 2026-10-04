import { h, icon, api, S, fmt, ago, toast, put, add } from '../util.js';
import { loading, emptyState, errorState } from './common.js';

const STATUS_LABEL = { sent: 'Delivered', failed: 'Failed', declined: 'Held back' };

export function createCommsPane() {
  const el = h('div.pane');
  const st = { messages: [], contacts: [], discovered: [], telegram: null, tab: 'history', error: null, loaded: false, scanning: false, highlight: null };

  async function load() {
    try {
      const d = await api('/comms');
      Object.assign(st, { messages: d.messages, contacts: d.contacts, discovered: d.discovered, telegram: d.telegram, error: null });
    } catch (err) { st.error = err; }
    st.loaded = true;
    draw();
  }

  async function scan() {
    st.scanning = true;
    draw();
    try {
      const r = await api('/telegram/discover', { method: 'POST' });
      st.discovered = r.discovered;
      if (!r.discovered.length) toast('No chats yet. Ask the person to open your bot and press Start, then scan again.');
    } catch (err) { toast(err.message, 'err'); }
    st.scanning = false;
    draw();
  }

  async function addContact(name, chatId, aliases) {
    try {
      await api('/contacts', { method: 'POST', body: { name, chatId, aliases } });
      toast(`${name} added to contacts.`, 'ok');
      await load();
    } catch (err) { toast(err.message, 'err'); }
  }

  function notice() {
    const t = st.telegram;
    if (!t || t.state === 'online') return null;
    return h('div.notice', { class: t.state === 'expired' || t.state === 'degraded' ? 'err' : '' },
      icon('shield', 16),
      h('div.grow', t.state === 'unconfigured' ? 'Telegram is not configured, so messages cannot go out. Set TELEGRAM_BOT_TOKEN and restart.' : t.detail),
      h('button.btn.sm', { on: { click: () => document.dispatchEvent(new CustomEvent('open-systems')) } }, 'Systems'),
    );
  }

  function history() {
    if (!st.messages.length) return emptyState({ glyph: 'comms', title: 'No transmissions', text: 'Messages JARVIS sends for you are logged here. Try “send Bruce a message saying the experiment is postponed”.' });
    return h('div', st.messages.map((m) => h('div.msg', { data: { id: m.id } },
      h('div.to', h('b', m.recipient), h('span.tag', { class: m.origin === 'command' ? 'jarvis' : 'console' }, m.origin === 'command' ? 'Sent by JARVIS' : 'Console')),
      h('div.tx', m.text),
      h('div.st',
        h('span.stat', { class: m.status }, icon(m.status === 'sent' ? 'check' : m.status === 'failed' ? 'x' : 'slash', 10), STATUS_LABEL[m.status] || m.status),
        h('span.time', { title: fmt.full(m.ts) }, `${fmt.time(m.ts)} · ${ago(m.ts)}`),
      ),
      m.status === 'failed' ? h('div.err', m.error || 'Delivery failed.', h('button.btn.sm', { on: { click: () => retry(m) } }, icon('retry', 11), 'Resend')) : null,
    )));
  }

  async function retry(m) {
    try { await api(`/comms/${m.id}/retry`, { method: 'POST', body: { tz: S.tz } }); toast('Resending. Progress is in the console.'); } catch (err) { toast(err.message, 'err'); }
  }

  function contacts() {
    const name = h('input.input', { placeholder: 'Name, e.g. Bruce Banner', 'aria-label': 'Contact name' });
    const chat = h('input.input', { placeholder: 'Telegram chat id', inputmode: 'numeric', 'aria-label': 'Chat id' });
    const alias = h('input.input', { placeholder: 'Nicknames, comma separated (optional)', 'aria-label': 'Nicknames' });
    const known = new Set(st.contacts.map((c) => c.chatId));
    const found = st.discovered.filter((d) => !known.has(d.chatId));
    return h('div',
      h('div.addc',
        name, chat,
        h('div.full', alias, h('button.btn.primary', { on: { click: () => name.value.trim() && chat.value.trim() ? addContact(name.value.trim(), chat.value.trim(), alias.value) : toast('A contact needs a name and a chat id.', 'err') } }, icon('plus', 12), 'Add')),
      ),
      st.contacts.length ? st.contacts.map((c) => h('div.crow',
        h('div', h('b', { style: 'font-weight:600' }, c.name), h('div.dim.mono', `chat ${c.chatId}${c.aliases?.length ? ` · ${c.aliases.join(', ')}` : ''}`)),
        h('button.iconbtn.sm', { 'aria-label': `Remove ${c.name}`, on: { click: () => api(`/contacts/${c.id}`, { method: 'DELETE' }).then(load) } }, icon('trash', 13)),
      )) : h('div', { style: 'padding:16px 14px' }, h('span.faint', 'No contacts yet. Add one above, or scan for people who have messaged the bot.')),
      h('div.sect', h('span.label', 'Chats that reached the bot'), h('span.rule'),
        h('button.btn.sm', { disabled: st.scanning, on: { click: scan } }, icon('refresh', 11), st.scanning ? 'Scanning' : 'Scan')),
      found.length ? found.map((d) => h('div.crow',
        h('div', h('b', { style: 'font-weight:600' }, d.name), h('div.dim.mono', `chat ${d.chatId} · ${d.type}${d.username ? ` · @${d.username}` : ''}`)),
        h('button.btn.sm', { on: { click: () => addContact(d.name, d.chatId, '') } }, icon('plus', 11), 'Add'),
      )) : h('div', { style: 'padding:6px 14px 16px' }, h('span.faint', { style: 'font-size:12.5px' }, 'Telegram bots can only write to people who started a chat with them. Ask them to open your bot and press Start, then scan.')),
    );
  }

  function draw() {
    const body = h('div.pane-body');
    if (st.error) body.append(errorState(st.error, { onRetry: load, what: 'Comms' }));
    else add(body, notice(), st.tab === 'history' ? history() : contacts());
    put(el,
      h('div.pane-bar',
        h('div.subtabs', { role: 'group' },
          h('button', { 'aria-pressed': String(st.tab === 'history'), on: { click: () => { st.tab = 'history'; draw(); } } }, `History (${st.messages.length})`),
          h('button', { 'aria-pressed': String(st.tab === 'contacts'), on: { click: () => { st.tab = 'contacts'; draw(); } } }, `Contacts (${st.contacts.length})`),
        ),
        h('span.sp'),
        st.telegram?.account ? h('span.sync', `bot ${st.telegram.state === 'online' ? '@' : ''}${st.telegram.account}`) : null,
        h('button.iconbtn', { 'aria-label': 'Refresh', on: { click: load } }, icon('refresh', 15)),
      ),
      body,
    );
    if (st.highlight) {
      const t = el.querySelector(`[data-id="${CSS.escape(st.highlight)}"]`);
      if (t) { t.scrollIntoView({ block: 'center' }); t.classList.add('flash'); }
      st.highlight = null;
    }
  }

  put(el, h('div.pane-body', loading('Reading comms log')));
  load();
  return {
    el,
    refresh: load,
    activate: load,
    focus() { st.tab = 'history'; st.highlight = null; load().then(() => { const first = el.querySelector('.msg'); first?.classList.add('flash'); }); },
    badge: () => null,
  };
}
