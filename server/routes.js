import express from 'express';
import { config } from './config.js';
import { store, uid } from './store.js';
import { bus } from './bus.js';
import { integrations, account } from './integrations/index.js';
import { queue } from './brain/queue.js';
import { llmStatus } from './brain/llm.js';
import { demoFaults } from './integrations/demo.js';
import * as attachments from './attachments.js';
import { JarvisError, describeError } from './errors.js';
import { isValidTz, startOfDay, addDays, parseWhen } from './time.js';
import { resolveContact } from './brain/contacts.js';

const wrap = (fn) => async (req, res) => {
  try {
    await fn(req, res);
  } catch (err) {
    const e = describeError(err);
    if (!(err instanceof JarvisError)) console.error(`${req.method} ${req.path}`, err);
    const status = err instanceof JarvisError ? (['NOT_CONNECTED', 'NOT_CONFIGURED', 'AUTH_EXPIRED', 'AUTH_SCOPE'].includes(e.code) ? 409 : 502) : 500;
    res.status(status).json({ error: e });
  }
};

const tzOf = (req) => (isValidTz(req.query.tz) ? req.query.tz : store.data.settings.timezone || 'UTC');

export function systems() {
  const state = (s) => s;
  const googleState = account?.state();
  return {
    demo: config.demo,
    calendar: state(integrations.calendar.status()),
    drive: state(integrations.drive.status()),
    telegram: state(integrations.telegram.status()),
    llm: llmStatus(),
    reminders: { state: 'online', detail: 'local scheduler' },
    google: config.demo
      ? { configured: true, state: 'online', account: 'simulation' }
      : { configured: account.configured, state: googleState.state, account: googleState.account || null },
  };
}

function view(job) {
  const { presetSteps, attachmentIds, ...rest } = job;
  return rest;
}

// The server holds live Google and Telegram credentials; only the page it serves may drive it.
function originGuard(req, res, next) {
  if (req.method === 'GET' || req.method === 'HEAD') return next();
  const origin = req.headers.origin;
  if (origin) {
    try {
      if (new URL(origin).host !== req.headers.host) return res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Cross-origin request refused.' } });
    } catch {
      return res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Bad origin.' } });
    }
  }
  next();
}

export function buildRouter() {
  const r = express.Router();
  r.use(express.json({ limit: '256kb' }));

  r.use(originGuard);

  r.get('/events', (req, res) => {
    bus.attach(req, res);
    res.write(`event: hello\ndata: ${JSON.stringify({ queue: queue.snapshot() })}\n\n`);
  });

  r.get('/state', (req, res) => {
    if (!store.data.settings.timezone && isValidTz(req.query.tz)) {
      store.data.settings.timezone = req.query.tz;
      store.save();
    }
    res.json({
      now: new Date().toISOString(),
      settings: { ...store.data.settings, timezone: store.data.settings.timezone || (isValidTz(req.query.tz) ? req.query.tz : 'UTC') },
      systems: systems(),
      jobs: store.data.jobs.slice(-60).map(view),
      queue: queue.snapshot(),
    });
  });

  r.get('/systems', wrap(async (req, res) => {
    if (req.query.probe) {
      await Promise.allSettled([integrations.calendar.probe?.(), integrations.telegram.probe?.()]);
    }
    res.json(systems());
  }));

  r.post('/settings', (req, res) => {
    const { timezone, confirmConsequential } = req.body || {};
    if (timezone !== undefined) {
      if (!isValidTz(timezone)) return res.status(400).json({ error: { code: 'BAD_REQUEST', message: 'Unknown timezone.' } });
      store.data.settings.timezone = timezone;
    }
    if (typeof confirmConsequential === 'boolean') store.data.settings.confirmConsequential = confirmConsequential;
    store.save();
    res.json(store.data.settings);
  });

  // ---- commands & queue
  r.post('/commands', (req, res) => {
    const text = String(req.body?.text || '').trim().slice(0, 2000);
    const attachmentIds = (req.body?.attachmentIds || []).filter((id) => attachments.get(id));
    if (!text) return res.status(400).json({ error: { code: 'BAD_REQUEST', message: 'Say something first.' } });
    const mode = req.body?.mode === 'interrupt' ? 'interrupt' : 'queue';
    const job = queue.submit({ text, mode, tz: req.body?.tz, attachmentIds });
    res.status(202).json(view(job));
  });
  r.post('/jobs/:id/cancel', (req, res) => res.json({ ok: queue.cancel(req.params.id) }));
  r.post('/jobs/:id/confirm', (req, res) => res.json({ ok: queue.confirm(req.params.id, Boolean(req.body?.approve)) }));
  r.post('/jobs/:id/retry', (req, res) => {
    const job = queue.retry(req.params.id, req.body?.tz);
    if (!job) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Nothing to retry.' } });
    res.status(202).json(view(job));
  });
  r.post('/queue/clear', (req, res) => res.json({ cleared: queue.clearQueued() }));

  // ---- calendar
  r.get('/calendar/events', wrap(async (req, res) => {
    const tz = tzOf(req);
    const from = parseWhen(req.query.from, tz) || startOfDay(new Date(), tz);
    const to = parseWhen(req.query.to, tz) || addDays(from, 14, tz);
    const events = await integrations.calendar.list({ from, to, tz });
    res.json({ events, from: from.toISOString(), to: to.toISOString() });
  }));
  r.post('/calendar/events/:id/delete', (req, res) => {
    const job = queue.submit({
      text: `Cancel event “${req.body?.title || 'selected event'}”`,
      tz: req.body?.tz,
      origin: 'console',
      steps: [{ tool: 'calendar_delete', args: { match: { id: req.params.id, title: req.body?.title || '' } }, approved: true }],
    });
    res.status(202).json(view(job));
  });

  // ---- reminders
  const activeFirst = (a, b) => a.at.localeCompare(b.at);
  r.get('/reminders', (req, res) => {
    const all = store.data.reminders;
    res.json({
      active: all.filter((x) => x.status === 'pending' || x.status === 'due').sort(activeFirst),
      closed: all.filter((x) => x.status === 'done').sort((a, b) => (b.doneAt || '').localeCompare(a.doneAt || '')).slice(0, 15),
    });
  });
  const logManual = (integration, label, summary) =>
    store.push('actions', { id: uid('a_'), ts: new Date().toISOString(), jobId: null, integration, tool: 'manual', label, summary, status: 'ok', origin: 'console' });
  r.post('/reminders', (req, res) => {
    const text = String(req.body?.text || '').trim();
    const at = new Date(req.body?.at);
    if (!text || Number.isNaN(at.getTime())) return res.status(400).json({ error: { code: 'BAD_REQUEST', message: 'A reminder needs text and a valid time.' } });
    const rem = { id: uid('r_'), text, at: at.toISOString(), status: 'pending', createdAt: new Date().toISOString(), jobId: null };
    store.push('reminders', rem);
    logManual('reminders', `Remind · ${text}`, 'Reminder set from the console.');
    bus.publish('refresh', { panels: ['reminders', 'log'] });
    res.status(201).json(rem);
  });
  r.post('/reminders/:id/:action', (req, res) => {
    const rem = store.data.reminders.find((x) => x.id === req.params.id);
    if (!rem) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'No such reminder.' } });
    const { action } = req.params;
    if (action === 'done') {
      rem.status = 'done';
      rem.doneAt = new Date().toISOString();
    } else if (action === 'reopen') {
      rem.status = new Date(rem.at) <= new Date() ? 'due' : 'pending';
    } else if (action === 'snooze') {
      const mins = Math.min(Math.max(Number(req.body?.minutes) || 10, 1), 1440);
      rem.at = new Date(Date.now() + mins * 60000).toISOString();
      rem.status = 'pending';
    } else if (action === 'delete') {
      store.data.reminders = store.data.reminders.filter((x) => x !== rem);
    } else return res.status(400).json({ error: { code: 'BAD_REQUEST', message: 'Unknown action.' } });
    store.save();
    logManual('reminders', `Reminder · ${rem.text}`, `Reminder ${action === 'snooze' ? 'snoozed' : action === 'done' ? 'completed' : action === 'delete' ? 'removed' : 'reopened'} from the console.`);
    bus.publish('refresh', { panels: ['reminders', 'log'] });
    res.json({ ok: true });
  });

  // ---- drive
  r.get('/drive/list', wrap(async (req, res) => {
    res.json(await integrations.drive.listFolder(String(req.query.folder || 'root')));
  }));
  r.get('/drive/search', wrap(async (req, res) => {
    const q = String(req.query.q || '').trim();
    if (!q) return res.json({ files: [], mode: 'name', tokens: [] });
    res.json(await integrations.drive.search(q));
  }));
  r.get('/drive/folders', wrap(async (req, res) => {
    res.json({ folders: await integrations.drive.folders() });
  }));
  r.post('/attachments', attachments.uploader.single('file'), (req, res) => {
    if (!req.file) return res.status(400).json({ error: { code: 'BAD_REQUEST', message: 'No file received.' } });
    res.status(201).json(attachments.publicView(attachments.register(req.file)));
  });
  r.delete('/attachments/:id', (req, res) => {
    attachments.drop(req.params.id);
    res.json({ ok: true });
  });
  r.post('/drive/upload', (req, res) => {
    const { attachmentId, folderId, folderLabel, newFolder, parentId, tz } = req.body || {};
    const file = attachments.get(attachmentId);
    if (!file) return res.status(400).json({ error: { code: 'NO_FILE', message: 'That file is no longer staged. Choose it again.' } });
    const args = newFolder
      ? { newFolder: String(newFolder).trim(), parentId: parentId || '', folder: '', folderLabel: folderLabel || '' }
      : { folderId: folderId || 'root', folderLabel: folderLabel || 'My Drive' };
    const job = queue.submit({
      text: `Upload ${file.name}`,
      tz,
      origin: 'console',
      attachmentIds: [file.id],
      steps: [{ tool: 'drive_upload', args }],
    });
    res.status(202).json(view(job));
  });
  r.post('/drive/folders', (req, res) => {
    const name = String(req.body?.name || '').trim();
    if (!name) return res.status(400).json({ error: { code: 'BAD_REQUEST', message: 'Name the folder first.' } });
    const job = queue.submit({ text: `Create folder ${name}`, tz: req.body?.tz, origin: 'console', steps: [{ tool: 'drive_create_folder', args: { name, parent: '', parentId: req.body?.parentId || '' } }] });
    res.status(202).json(view(job));
  });

  // ---- comms
  r.get('/comms', (req, res) => {
    res.json({
      messages: [...store.data.messages].reverse().slice(0, 100),
      contacts: store.data.contacts,
      discovered: store.data.telegram.discovered,
      telegram: integrations.telegram.status(),
    });
  });
  r.post('/contacts', (req, res) => {
    const name = String(req.body?.name || '').trim();
    const chatId = String(req.body?.chatId || '').trim();
    if (!name || !/^-?\d+$/.test(chatId)) {
      return res.status(400).json({ error: { code: 'BAD_REQUEST', message: 'A contact needs a name and a numeric Telegram chat id.' } });
    }
    const aliases = String(req.body?.aliases || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
    const first = name.split(/\s+/)[0].toLowerCase();
    if (!aliases.includes(first) && !resolveContact(first).contact) aliases.push(first);
    const existing = store.data.contacts.find((c) => c.chatId === chatId || c.name.toLowerCase() === name.toLowerCase());
    if (existing) Object.assign(existing, { name, chatId, aliases });
    else store.data.contacts.push({ id: uid('c_'), name, chatId, aliases });
    store.save();
    res.status(201).json({ contacts: store.data.contacts });
  });
  r.delete('/contacts/:id', (req, res) => {
    store.data.contacts = store.data.contacts.filter((c) => c.id !== req.params.id);
    store.save();
    res.json({ contacts: store.data.contacts });
  });
  r.post('/telegram/discover', wrap(async (req, res) => {
    const found = await integrations.telegram.discover();
    if (config.demo) store.data.telegram.discovered = found;
    res.json({ discovered: store.data.telegram.discovered });
  }));
  r.post('/comms/:id/retry', (req, res) => {
    const m = store.data.messages.find((x) => x.id === req.params.id);
    if (!m) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'No such message.' } });
    const job = queue.submit({
      text: `Resend to ${m.recipient}`,
      tz: req.body?.tz,
      origin: 'console',
      steps: [{ tool: 'telegram_send', args: { recipient: m.recipient, contactId: null, chatId: m.chatId, text: m.text }, approved: true }],
    });
    res.status(202).json(view(job));
  });

  r.get('/log', (req, res) => {
    res.json({ actions: [...store.data.actions].reverse().slice(0, Math.min(Number(req.query.limit) || 100, 300)) });
  });

  if (config.demo) {
    r.post('/_demo/fault', (req, res) => {
      if (req.body?.clear) demoFaults.clear();
      else demoFaults.set(req.body?.integration || '*', req.body?.code || 'NETWORK', Number(req.body?.times) || 1);
      res.json({ ok: true });
    });
  }

  return r;
}

export function buildAuthRouter() {
  const r = express.Router();
  r.use(originGuard);
  r.get('/google', (req, res) => {
    if (config.demo) return res.redirect('/?google=demo');
    try {
      res.redirect(account.authUrl());
    } catch (err) {
      res.redirect(`/?google=error&reason=${encodeURIComponent(err.message)}`);
    }
  });
  r.get('/google/callback', async (req, res) => {
    if (req.query.error) return res.redirect(`/?google=error&reason=${encodeURIComponent(String(req.query.error))}`);
    try {
      await account.handleCallback(String(req.query.code || ''), String(req.query.state || ''));
      bus.publish('refresh', { panels: ['status', 'calendar', 'drive'] });
      res.redirect('/?google=connected');
    } catch (err) {
      console.error('google callback', err.message);
      res.redirect(`/?google=error&reason=${encodeURIComponent(err.message)}`);
    }
  });
  r.post('/google/disconnect', express.json(), async (req, res) => {
    await account?.revoke();
    bus.publish('refresh', { panels: ['status'] });
    res.json({ ok: true });
  });
  return r;
}
