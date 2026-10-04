import test from 'node:test';
import assert from 'node:assert/strict';
import { startServer, mockServer } from './helpers.js';

// ───────── Telegram, real adapter against a mock Bot API ─────────
test('telegram: sends to the contact\'s chat id, reports delivery, maps API errors', async () => {
  const bot = await mockServer(({ url, body }) => {
    if (url.endsWith('/getMe')) return { json: { ok: true, result: { username: 'stark_bot' } } };
    if (url.endsWith('/sendMessage')) {
      if (String(body.chat_id) === '9') return { status: 400, json: { ok: false, error_code: 400, description: 'Bad Request: chat not found' } };
      if (String(body.chat_id) === '8') return { status: 403, json: { ok: false, error_code: 403, description: 'Forbidden: bot was blocked by the user' } };
      return { json: { ok: true, result: { message_id: 77, chat: { first_name: 'Bruce' } } } };
    }
    if (url.endsWith('/getUpdates')) return { json: { ok: true, result: [{ update_id: 5, message: { date: 1760000000, chat: { id: 4242, type: 'private', first_name: 'Happy', last_name: 'Hogan', username: 'hhogan' } } }] } };
    return { status: 404, json: { ok: false, description: 'Not Found' } };
  });
  const srv = await startServer({ TELEGRAM_BOT_TOKEN: 'TKN', TELEGRAM_API_BASE: bot.url, TELEGRAM_CONTACTS: 'Bruce Banner=1001,Ghost=9,Blocker=8' });
  try {
    await new Promise((r) => setTimeout(r, 300));
    const sys = (await srv.call('/systems')).data;
    assert.equal(sys.telegram.state, 'online');
    assert.equal(sys.telegram.account, 'stark_bot');
    assert.equal(sys.calendar.state, 'unconfigured');

    const ok = await srv.run('send Bruce a message saying the experiment is postponed');
    assert.equal(ok.state, 'done');
    const sent = bot.requests.find((r) => r.url.endsWith('/sendMessage'));
    assert.equal(String(sent.body.chat_id), '1001');
    assert.equal(sent.body.text, 'The experiment is postponed.');
    assert.equal(sent.url, '/botTKN/sendMessage');

    const bad = await srv.run('message Ghost are you there');
    assert.equal(bad.steps[0].error.code, 'CHAT_NOT_FOUND');
    assert.match(bad.steps[0].error.message, /press Start first/);
    const blocked = await srv.run('message Blocker hello');
    assert.equal(blocked.steps[0].error.code, 'CHAT_BLOCKED');

    const { data } = await srv.call('/comms');
    assert.deepEqual(data.messages.map((m) => m.status), ['failed', 'failed', 'sent']);

    const found = (await srv.call('/telegram/discover', { method: 'POST' })).data.discovered;
    assert.equal(found[0].name, 'Happy Hogan');
    assert.equal(found[0].chatId, '4242');
  } finally {
    await srv.stop();
    await bot.close();
  }
});

test('telegram: a rejected token reads as expired authorisation', async () => {
  const bot = await mockServer(() => ({ status: 401, json: { ok: false, error_code: 401, description: 'Unauthorized' } }));
  const srv = await startServer({ TELEGRAM_BOT_TOKEN: 'BAD', TELEGRAM_API_BASE: bot.url, TELEGRAM_CONTACTS: 'Bruce=1001' });
  try {
    const j = await srv.run('tell Bruce hello');
    assert.equal(j.steps[0].error.code, 'AUTH_EXPIRED');
    assert.match(j.steps[0].error.message, /rejected the bot token/);
    await new Promise((r) => setTimeout(r, 100));
    assert.equal((await srv.call('/systems')).data.telegram.state, 'degraded');
  } finally {
    await srv.stop();
    await bot.close();
  }
});

test('telegram: an unreachable API is a network error, not a crash', async () => {
  const srv = await startServer({ TELEGRAM_BOT_TOKEN: 'T', TELEGRAM_API_BASE: 'http://127.0.0.1:1', TELEGRAM_CONTACTS: 'Bruce=1001' });
  try {
    const j = await srv.run('tell Bruce hello');
    assert.equal(j.steps[0].error.code, 'NETWORK');
  } finally {
    await srv.stop();
  }
});

test('telegram: with no token every send fails clearly and nothing is logged as sent', async () => {
  const srv = await startServer({ TELEGRAM_CONTACTS: 'Bruce=1001' });
  try {
    const j = await srv.run('tell Bruce hello');
    assert.equal(j.steps[0].error.code, 'NOT_CONFIGURED');
    assert.equal((await srv.call('/comms')).data.messages[0].status, 'failed');
  } finally {
    await srv.stop();
  }
});

// ───────── Google, real adapter without credentials ─────────
test('google: unconfigured install explains itself everywhere', async () => {
  const srv = await startServer();
  try {
    const sys = (await srv.call('/systems')).data;
    assert.equal(sys.google.configured, false);
    assert.equal(sys.calendar.state, 'unconfigured');
    assert.equal(sys.drive.state, 'unconfigured');

    const cal = await srv.run('schedule a meeting with Bruce tomorrow at 5 PM');
    assert.equal(cal.state, 'failed');
    assert.equal(cal.steps[0].error.code, 'NOT_CONFIGURED');
    assert.match(cal.reply, /Google credentials are not configured/);

    const events = await srv.call('/calendar/events');
    assert.equal(events.status, 409);
    assert.equal(events.data.error.code, 'NOT_CONFIGURED');
    const drive = await srv.call('/drive/list');
    assert.equal(drive.status, 409);

    const redirect = await fetch(`${srv.base}/auth/google`, { redirect: 'manual' });
    assert.match(redirect.headers.get('location'), /google=error/);

    // reminders need no outside service and must still work
    const rem = await srv.run('remind me to check the reactor at 11:58 pm');
    assert.equal(rem.state, 'done');
  } finally {
    await srv.stop();
  }
});

test('google: consent URL asks for Calendar + Drive offline access with a one-time state', async () => {
  const srv = await startServer({ GOOGLE_CLIENT_ID: 'cid.apps.googleusercontent.com', GOOGLE_CLIENT_SECRET: 'sec', PUBLIC_URL: 'http://localhost:4567' });
  try {
    const sys = (await srv.call('/systems')).data;
    assert.equal(sys.calendar.state, 'disconnected');
    const res = await fetch(`${srv.base}/auth/google`, { redirect: 'manual' });
    const url = new URL(res.headers.get('location'));
    assert.equal(url.host, 'accounts.google.com');
    assert.equal(url.searchParams.get('client_id'), 'cid.apps.googleusercontent.com');
    assert.equal(url.searchParams.get('redirect_uri'), 'http://localhost:4567/auth/google/callback');
    assert.equal(url.searchParams.get('access_type'), 'offline');
    const scopes = url.searchParams.get('scope').split(' ');
    assert.ok(scopes.includes('https://www.googleapis.com/auth/calendar'));
    assert.ok(scopes.includes('https://www.googleapis.com/auth/drive'));
    assert.ok(url.searchParams.get('state').length >= 16);

    const forged = await fetch(`${srv.base}/auth/google/callback?code=abc&state=forged`, { redirect: 'manual' });
    assert.match(forged.headers.get('location'), /google=error/);
    const ev = await srv.call('/calendar/events');
    assert.equal(ev.data.error.code, 'NOT_CONNECTED');
  } finally {
    await srv.stop();
  }
});

test('google: API failures translate into messages Tony can act on', async () => {
  process.env.GOOGLE_CLIENT_ID = 'x';
  process.env.GOOGLE_CLIENT_SECRET = 'y';
  process.env.DATA_DIR = (await import('node:os')).tmpdir() + '/jarvis-unit-' + process.pid;
  const { GoogleAccount } = await import('../server/integrations/google.js');
  const { store } = await import('../server/store.js');
  const acct = new GoogleAccount();
  store.data.google = { tokens: { refresh_token: 'r' }, status: 'ok', email: 'tony@stark.example' };
  assert.equal(acct.state().state, 'online');

  const gerr = (status, message, reason) => Object.assign(new Error(message), { code: status, response: { status, data: { error: { message, errors: [{ reason }] } } } });

  const expired = acct.translate(Object.assign(new Error('invalid_grant'), { response: { status: 400, data: { error: 'invalid_grant', error_description: 'Token has been expired or revoked.' } } }), 'calendar');
  assert.equal(expired.code, 'AUTH_EXPIRED');
  assert.equal(acct.state().state, 'expired', 'account is marked expired so the UI asks to reconnect');
  assert.throws(() => acct.client(), (e) => e.code === 'AUTH_EXPIRED');

  store.data.google.status = 'ok';
  assert.equal(acct.translate(gerr(401, 'Invalid Credentials'), 'drive').code, 'AUTH_EXPIRED');
  assert.equal(acct.translate(gerr(403, 'Request had insufficient authentication scopes.', 'insufficientPermissions'), 'drive').code, 'AUTH_SCOPE');
  const off = acct.translate(gerr(403, 'Google Calendar API has not been used in project 123 before or it is disabled.', 'accessNotConfigured'), 'calendar');
  assert.equal(off.code, 'API_DISABLED');
  assert.match(off.hint, /Cloud Console/);
  assert.equal(acct.translate(gerr(429, 'Rate Limit Exceeded', 'rateLimitExceeded'), 'calendar').code, 'RATE_LIMIT');
  assert.equal(acct.translate(gerr(404, 'Not Found', 'notFound'), 'drive').code, 'NOT_FOUND');
  assert.equal(acct.translate(Object.assign(new Error('getaddrinfo ENOTFOUND www.googleapis.com'), { code: 'ENOTFOUND' }), 'drive').code, 'NETWORK');
  assert.equal(acct.translate(gerr(500, 'Backend Error', 'backendError'), 'calendar').code, 'API');
});

// ───────── LLM planner against a mock Messages API ─────────
test('llm: plans come from the model, go through the same validation, and reach the integrations', async () => {
  const api = await mockServer(({ method, url, body }) => {
    if (method === 'GET' && url.startsWith('/v1/models')) return { json: { data: [{ id: 'opus-big' }, { id: 'sonnet-mid' }, { id: 'haiku-small' }] } };
    const last = body.messages.at(-1).content;
    if (/Bruce at once/.test(last)) {
      return { json: { content: [{ type: 'tool_use', name: 'submit_plan', input: { steps: [
        { tool: 'calendar_create', args: { title: 'Gamma review', start: '2099-03-02T16:00:00+00:00', durationMinutes: 30 } },
        { tool: 'reminder_create', args: { text: 'Gamma review starts soon', at: '2099-03-02T15:45:00+00:00' }, dependsOn: [0] },
      ] } }] } };
    }
    if (/ambiguous/.test(last)) return { json: { content: [{ type: 'tool_use', name: 'submit_plan', input: { clarify: 'Which Bruce, sir?', steps: [] } }] } };
    if (/explode/.test(last)) return { status: 529, json: { error: { message: 'Overloaded' } } };
    return { json: { content: [{ type: 'tool_use', name: 'submit_plan', input: { reply: 'Quite well, sir.', steps: [] } }] } };
  });
  const srv = await startServer({ JARVIS_DEMO: '1', ANTHROPIC_API_KEY: 'sk-test', ANTHROPIC_BASE_URL: api.url });
  try {
    const j = await srv.run('Book the gamma review with Bruce at once');
    assert.equal(j.source, 'llm');
    assert.equal(j.state, 'done');
    assert.deepEqual(j.steps.map((s) => s.tool), ['calendar_create', 'reminder_create']);
    assert.deepEqual(j.steps[1].dependsOn, [0]);
    const call = api.requests.find((r) => r.url === '/v1/messages');
    assert.equal(call.headers['x-api-key'], 'sk-test');
    assert.equal(call.body.model, 'sonnet-mid', 'picks a mid-tier model when none is configured');
    assert.deepEqual(call.body.tool_choice, { type: 'tool', name: 'submit_plan' });
    assert.match(call.body.system, /Bruce Banner/, 'contacts are given to the model');
    assert.match(call.body.system, /ISO 8601/);

    const ask = await srv.run('something ambiguous');
    assert.equal(ask.state, 'needs_input');
    assert.equal(ask.reply, 'Which Bruce, sir?');

    const chat = await srv.run('how are you');
    assert.equal(chat.reply, 'Quite well, sir.');

    // model outage: fall back to the built-in parser and say so
    const fb = await srv.run('explode: remind me to check the reactor at 11:50 pm');
    assert.equal(fb.source, 'rules');
    assert.equal(fb.state, 'done');
    assert.match(fb.notes.join(' '), /built-in parser/);
    assert.equal((await srv.call('/systems')).data.llm.state, 'degraded');
  } finally {
    await srv.stop();
    await api.close();
  }
});

test('llm: a plan that fails validation asks instead of acting', async () => {
  const api = await mockServer(({ method, url }) => {
    if (method === 'GET') return { json: { data: [{ id: 'sonnet-x' }] } };
    return { json: { content: [{ type: 'tool_use', name: 'submit_plan', input: { steps: [
      { tool: 'calendar_create', args: { title: 'Mystery meeting' } },
    ] } }] } };
  });
  const srv = await startServer({ JARVIS_DEMO: '1', ANTHROPIC_API_KEY: 'k', ANTHROPIC_BASE_URL: api.url });
  try {
    const j = await srv.run('set up the mystery meeting');
    assert.equal(j.state, 'needs_input');
    assert.match(j.reply, /When should “Mystery meeting” start/);
    assert.equal(j.steps.length, 0, 'nothing ran');
  } finally {
    await srv.stop();
    await api.close();
  }
});
