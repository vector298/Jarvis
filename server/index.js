import express from 'express';
import path from 'node:path';
import { config } from './config.js';
import { store, uid } from './store.js';
import { buildRouter, buildAuthRouter } from './routes.js';
import { startReminderClock } from './reminders.js';
import { integrations } from './integrations/index.js';
import { DEMO_CONTACTS } from './integrations/demo.js';

if (config.demo) {
  store.data.contacts = DEMO_CONTACTS.map((c) => ({ ...c }));
} else if (config.telegram.seedContacts && !store.data.contacts.length) {
  for (const pair of config.telegram.seedContacts.split(',')) {
    const [name, chatId] = pair.split('=').map((s) => s.trim());
    if (name && /^-?\d+$/.test(chatId || '')) {
      store.data.contacts.push({ id: uid('c_'), name, chatId, aliases: [name.split(/\s+/)[0].toLowerCase()] });
    }
  }
  store.save();
}

const app = express();
app.disable('x-powered-by');

// Only answer to the names this install is meant to be reached by. Without this,
// a web page could rebind its own domain to 127.0.0.1 and read the API.
const allowedHosts = new Set(['localhost', '127.0.0.1', '[::1]', new URL(config.publicUrl).hostname]);
app.use((req, res, next) => {
  const host = String(req.headers.host || '').replace(/:\d+$/, '').toLowerCase();
  if (allowedHosts.has(host)) return next();
  res.status(403).type('text').send(`Unrecognised host "${host}". Set PUBLIC_URL to the address you use to reach JARVIS.`);
});
app.use('/api', buildRouter());
app.use('/auth', buildAuthRouter());
app.use(express.static(path.join(config.root, 'public'), { extensions: ['html'] }));
app.use('/api', (req, res) => res.status(404).json({ error: { code: 'NOT_FOUND', message: 'No such endpoint.' } }));

startReminderClock();
integrations.telegram.probe?.().catch(() => {});

const server = app.listen(config.port, config.host, () => {
  console.log(`JARVIS online at http://${config.host === '0.0.0.0' ? 'localhost' : config.host}:${config.port}${config.demo ? '  (simulation mode)' : ''}`);
});

const shutdown = () => {
  store.flush();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1500).unref();
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
