import { h, icon } from '../util.js';

export const loading = (text = 'Reading') => h('div.loading', h('span.scanning', text));

export function emptyState({ glyph = 'circle', title, text, action }) {
  return h('div.empty',
    h('span.glyph', icon(glyph, 28)),
    h('div.big', title),
    text ? h('p', text) : null,
    action || null,
  );
}

// Turns a failed fetch into something Tony can act on.
export function errorState(err, { onRetry, what = 'link' } = {}) {
  const code = err.code;
  const reconnect = ['AUTH_EXPIRED', 'AUTH_SCOPE', 'NOT_CONNECTED'].includes(code);
  const title = {
    NOT_CONNECTED: `${what} not connected`,
    AUTH_EXPIRED: 'Authorisation expired',
    AUTH_SCOPE: 'Permissions missing',
    NOT_CONFIGURED: `${what} not configured`,
    NETWORK: `${what} unreachable`,
    API_DISABLED: 'API switched off',
    RATE_LIMIT: 'Rate limited',
  }[code] || `${what} fault`;
  return h('div.empty.err',
    h('span.glyph', { style: 'color:var(--red)' }, icon('shield', 28)),
    h('div.big', title),
    h('p', err.message),
    err.hint ? h('p.faint', err.hint) : null,
    h('div', { style: 'display:flex;gap:8px;margin-top:6px' },
      reconnect ? h('a.btn.primary', { href: '/auth/google' }, code === 'NOT_CONNECTED' ? 'Connect Google' : 'Reconnect Google') : null,
      code === 'NOT_CONFIGURED' ? h('button.btn', { on: { click: () => document.dispatchEvent(new CustomEvent('open-systems')) } }, 'Open systems') : null,
      onRetry ? h('button.btn', { on: { click: onRetry } }, icon('retry', 12), 'Retry') : null,
    ),
  );
}
