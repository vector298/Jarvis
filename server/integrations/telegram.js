import { config } from '../config.js';
import { store, uid } from '../store.js';
import { JarvisError } from '../errors.js';

const FRIENDLY = [
  [/bot was blocked by the user/i, 'CHAT_BLOCKED', 'The recipient has blocked the bot.'],
  [/chat not found/i, 'CHAT_NOT_FOUND', 'Telegram could not find that chat. The recipient must open the bot and press Start first, or the chat id is wrong.'],
  [/can't initiate conversation/i, 'CHAT_NOT_STARTED', 'That person has not started a conversation with the bot yet.'],
  [/user is deactivated/i, 'CHAT_NOT_FOUND', 'That Telegram account is deactivated.'],
  [/bot was kicked|not enough rights|have no rights/i, 'CHAT_FORBIDDEN', 'The bot no longer has permission to post in that chat.'],
  [/message is too long/i, 'MESSAGE_TOO_LONG', 'The message is too long for Telegram (4096 characters maximum).'],
];

export class Telegram {
  constructor() {
    this.botName = null;
    this.lastError = null;
  }

  get configured() {
    return Boolean(config.telegram.token);
  }

  status() {
    if (!this.configured) return { state: 'unconfigured', detail: 'TELEGRAM_BOT_TOKEN not set' };
    if (this.lastError) return { state: 'degraded', detail: this.lastError, account: this.botName };
    return { state: 'online', detail: this.botName ? `@${this.botName}` : 'bot token set', account: this.botName };
  }

  async call(method, payload = {}, { timeout = 15000 } = {}) {
    if (!this.configured) {
      throw new JarvisError('NOT_CONFIGURED', 'Telegram is not configured. No bot token has been set on this server.', {
        integration: 'telegram',
        hint: 'Set TELEGRAM_BOT_TOKEN and restart.',
      });
    }
    let res;
    try {
      res = await fetch(`${config.telegram.apiBase}/bot${config.telegram.token}/${method}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(timeout),
      });
    } catch (err) {
      this.lastError = 'network unreachable';
      const timedOut = err.name === 'TimeoutError';
      throw new JarvisError('NETWORK', timedOut ? 'Telegram did not respond in time.' : 'Could not reach Telegram. Check the connection.', {
        integration: 'telegram',
        cause: err,
      });
    }
    let body = null;
    try {
      body = await res.json();
    } catch {
      // handled below
    }
    if (!body?.ok) {
      const desc = body?.description || `HTTP ${res.status}`;
      if (res.status === 401 || res.status === 404) {
        this.lastError = 'bot token rejected';
        throw new JarvisError('AUTH_EXPIRED', 'Telegram rejected the bot token. It may have been revoked. Issue a new one with BotFather.', {
          integration: 'telegram',
        });
      }
      for (const [re, code, message] of FRIENDLY) {
        if (re.test(desc)) throw new JarvisError(code, message, { integration: 'telegram' });
      }
      if (res.status === 429) {
        const wait = body?.parameters?.retry_after;
        throw new JarvisError('RATE_LIMIT', `Telegram is rate-limiting the bot${wait ? `, retry in ${wait}s` : ''}.`, { integration: 'telegram' });
      }
      throw new JarvisError('API', `Telegram refused the request: ${desc}`, { integration: 'telegram' });
    }
    this.lastError = null;
    return body.result;
  }

  async probe() {
    const me = await this.call('getMe');
    this.botName = me.username;
    return me;
  }

  async send(chatId, text) {
    const r = await this.call('sendMessage', { chat_id: chatId, text, disable_web_page_preview: true });
    return { messageId: r.message_id, chatTitle: r.chat?.title || r.chat?.first_name || null };
  }

  // Bots can't look people up; they only learn about chats that wrote to them.
  async discover() {
    const updates = await this.call('getUpdates', { offset: store.data.telegram.offset || 0, timeout: 0, allowed_updates: ['message'] });
    const found = store.data.telegram.discovered;
    for (const u of updates) {
      store.data.telegram.offset = Math.max(store.data.telegram.offset || 0, u.update_id + 1);
      const chat = u.message?.chat;
      if (!chat) continue;
      const name = chat.title || [chat.first_name, chat.last_name].filter(Boolean).join(' ') || chat.username || String(chat.id);
      const existing = found.find((c) => c.chatId === String(chat.id));
      const entry = { chatId: String(chat.id), name, username: chat.username || null, type: chat.type, lastSeen: new Date((u.message.date || 0) * 1000).toISOString() };
      if (existing) Object.assign(existing, entry);
      else found.push({ id: uid('d_'), ...entry });
    }
    store.save();
    return found;
  }
}
