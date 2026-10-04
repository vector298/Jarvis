import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, sleep } from './helpers.js';

let srv;
before(async () => { srv = await startServer({ JARVIS_DEMO: '1' }); });
after(async () => { await srv.stop(); });

const events = async (from, to) => (await srv.call(`/calendar/events?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&tz=UTC`)).data.events;
const wide = () => [new Date(Date.now() - 864e5).toISOString(), new Date(Date.now() + 40 * 864e5).toISOString()];

test('serves the console and reports every system', async () => {
  const html = await (await fetch(`${srv.base}/`)).text();
  assert.match(html, /J\.A\.R\.V\.I\.S\./);
  const { data } = await srv.call('/systems');
  assert.equal(data.demo, true);
  for (const k of ['calendar', 'drive', 'telegram', 'llm', 'reminders']) assert.ok(data[k].state, k);
});

test('a calendar command creates an event that the preview endpoint returns', async () => {
  const j = await srv.run('schedule a meeting with Bruce Banner tomorrow at 4 PM to discuss the gamma sample');
  assert.equal(j.state, 'done');
  assert.equal(j.steps[0].tool, 'calendar_create');
  const evs = await events(...wide());
  const ev = evs.find((e) => e.title === 'Meeting with Bruce Banner');
  assert.ok(ev, 'event is listed');
  assert.equal(ev.description, 'Discuss the gamma sample');
  assert.equal(new Date(ev.start).getUTCHours(), 16);
  assert.match(j.reply, /on the calendar for tomorrow at 4:00 PM/);
});

test('missing information is asked for, then the follow-up completes the command', async () => {
  const q = await srv.run('schedule a call with Rhodey');
  assert.equal(q.state, 'needs_input');
  assert.match(q.reply, /When should I schedule/);
  const done = await srv.run('friday at 11 am');
  assert.equal(done.state, 'done');
  assert.ok((await events(...wide())).some((e) => e.title === 'Call with Rhodey'));
});

test('viewing the schedule reports events and reminders', async () => {
  await srv.run('remind me to review the armour spec tomorrow at 10 am');
  const j = await srv.run('what do I have scheduled for tomorrow?');
  assert.equal(j.state, 'done');
  assert.match(j.reply, /events? for tomorrow/);
  assert.match(j.reply, /Plus 1 reminder: review the armour spec/i);
});

test('reminders are listed separately from events', async () => {
  const { data } = await srv.call('/reminders');
  assert.ok(data.active.some((r) => /armour spec/i.test(r.text)));
  const list = await srv.run('what reminders do I have?');
  assert.match(list.reply, /active reminder/);
});

test('the three-step request runs in order, asks before messaging, and reports each step', async () => {
  const j = await srv.command('JARVIS, schedule the Stark team meeting for tomorrow at 6 PM, remind me 30 minutes before it, and send Bruce a Telegram message about it.');
  const waiting = await srv.waitJob(j.id, (x) => x.state === 'awaiting_confirm');
  assert.deepEqual(waiting.steps.map((s) => s.status), ['done', 'done', 'awaiting_confirm']);
  assert.match(waiting.steps[2].confirm.text, /Stark team meeting is set for tomorrow at 6:00 PM/);
  const before = (await srv.call('/comms')).data.messages.length;
  await srv.call(`/jobs/${j.id}/confirm`, { method: 'POST', body: { approve: true } });
  const done = await srv.waitJob(j.id, srv.settled);
  assert.equal(done.state, 'done');
  assert.deepEqual(done.steps.map((s) => s.status), ['done', 'done', 'done']);
  assert.equal(done.summary, 'All 3 actions complete.');
  const msgs = (await srv.call('/comms')).data.messages;
  assert.equal(msgs.length, before + 1);
  assert.equal(msgs[0].status, 'sent');
  assert.equal(msgs[0].recipient, 'Bruce Banner');
  assert.equal(msgs[0].origin, 'command');
});

test('declining a consequential step sends nothing and is recorded', async () => {
  const before = (await srv.call('/comms')).data.messages.length;
  const j = await srv.run('tell Pepper the board deck is final', { approve: false });
  assert.equal(j.steps[0].status, 'declined');
  const msgs = (await srv.call('/comms')).data.messages;
  assert.equal(msgs.length, before + 1);
  assert.equal(msgs[0].status, 'declined');
});

test('dependent steps are skipped when their parent fails', async () => {
  await srv.call('/_demo/fault', { method: 'POST', body: { integration: 'calendar', code: 'API', times: 2 } });
  const j = await srv.run('schedule the lab inspection tomorrow at 2 PM and remind me 15 minutes before it');
  assert.equal(j.steps[0].status, 'failed');
  assert.equal(j.steps[1].status, 'skipped');
  assert.equal(j.state, 'failed');
});

test('an integration failure is reported with a code, and retry re-runs only what failed', async () => {
  await srv.call('/_demo/fault', { method: 'POST', body: { integration: 'telegram', code: 'NETWORK' } });
  const j = await srv.run('tell Bruce the lab is clear and remind me at 11pm to lock up');
  assert.equal(j.state, 'partial');
  assert.equal(j.steps[0].error.code, 'NETWORK');
  assert.match(j.steps[0].error.message, /Could not reach Telegram/);
  assert.equal(j.steps[1].status, 'done');
  const failedEntry = (await srv.call('/comms')).data.messages[0];
  assert.equal(failedEntry.status, 'failed');
  const retry = await srv.call(`/jobs/${j.id}/retry`, { method: 'POST', body: {} });
  assert.equal(retry.status, 202);
  const r = await srv.waitJob(retry.data.id, (x) => x.state === 'awaiting_confirm' || srv.settled(x));
  assert.equal(r.steps.length, 1, 'only the failed step is retried');
  await srv.call(`/jobs/${r.id}/confirm`, { method: 'POST', body: { approve: true } });
  assert.equal((await srv.waitJob(r.id, srv.settled)).state, 'done');
});

test('commands are queued and run one at a time, in order', async () => {
  const ids = [];
  for (const t of ['what do I have scheduled today', 'find the reactor design report', 'what reminders do I have today']) ids.push((await srv.command(t)).id);
  const jobs = [];
  for (const id of ids) jobs.push(await srv.waitJob(id, srv.settled));
  for (let i = 1; i < jobs.length; i++) {
    assert.ok(jobs[i].startedAt >= jobs[i - 1].finishedAt, `job ${i} started only after job ${i - 1} finished`);
  }
});

test('interrupt mode cancels the running command and runs the new one first', async () => {
  const a = await srv.command('tell Bruce I will be late');
  await srv.waitJob(a.id, (x) => x.state === 'awaiting_confirm');
  const queued = await srv.command('remind me to eat at 11:55 pm');
  const b = await srv.command('remind me to hydrate at 11:56 pm', { mode: 'interrupt' });
  const bj = await srv.waitJob(b.id, srv.settled);
  const aj = await srv.job(a.id);
  assert.equal(aj.state, 'cancelled');
  assert.equal(aj.steps[0].status, 'cancelled');
  assert.equal(bj.state, 'done');
  const qj = await srv.waitJob(queued.id, srv.settled);
  assert.ok(bj.startedAt <= qj.startedAt, 'interrupting command jumps the queue');
});

test('a queued command can be cancelled before it runs', async () => {
  const a = await srv.command('tell Pepper hello');
  await srv.waitJob(a.id, (x) => x.state === 'awaiting_confirm');
  const b = await srv.command('what time is it, what do I have today');
  assert.equal((await srv.call(`/jobs/${b.id}/cancel`, { method: 'POST' })).data.ok, true);
  assert.equal((await srv.job(b.id)).state, 'cancelled');
  await srv.call(`/jobs/${a.id}/confirm`, { method: 'POST', body: { approve: false } });
  await srv.waitJob(a.id, srv.settled);
});

test('reschedule works from a time alone and cancel needs confirmation', async () => {
  const mv = await srv.run('reschedule my meeting with Bruce Banner to 5pm');
  assert.equal(mv.state, 'done', mv.reply);
  const ev = (await events(...wide())).find((e) => e.title === 'Meeting with Bruce Banner');
  assert.equal(new Date(ev.start).getUTCHours(), 17);
  assert.equal(new Date(ev.end) - new Date(ev.start), 3600000, 'duration preserved');

  const j = await srv.command('cancel the suit diagnostics');
  const w = await srv.waitJob(j.id, (x) => x.state === 'awaiting_confirm');
  assert.match(w.steps[0].label, /Cancel event “Suit diagnostics”/);
  await srv.call(`/jobs/${j.id}/confirm`, { method: 'POST', body: { approve: true } });
  assert.equal((await srv.waitJob(j.id, srv.settled)).state, 'done');
  assert.ok(!(await events(...wide())).some((e) => e.title === 'Suit diagnostics'));
});

test('drive search returns name, type, folder and modified time', async () => {
  const j = await srv.run('JARVIS, find the reactor design report');
  assert.equal(j.state, 'done');
  const { data } = await srv.call('/drive/search?q=reactor%20design%20report');
  assert.equal(data.files.length, 1);
  const f = data.files[0];
  assert.equal(f.name, 'Reactor Design Report v3.pdf');
  assert.equal(f.kind, 'pdf');
  assert.equal(f.folderPath, 'My Drive / Research / Arc Reactor');
  assert.ok(f.modifiedTime && f.link);
  const partial = (await srv.call('/drive/search?q=reactor%20banana')).data;
  assert.equal(partial.mode, 'partial');
});

test('uploading to a new folder stages the file, files it, and shows it in the listing', async () => {
  const staged = await srv.stage('Reactor_Notes_Q4.txt', 'chamber pressure nominal');
  assert.ok(staged.id);
  const up = await srv.call('/drive/upload', { method: 'POST', body: { attachmentId: staged.id, newFolder: 'Q4 Notes', parentId: 'root', folderLabel: 'My Drive', tz: 'UTC' } });
  assert.equal(up.status, 202);
  const j = await srv.waitJob(up.data.id, srv.settled);
  assert.equal(j.state, 'done');
  assert.equal(j.origin, 'console');
  assert.deepEqual(j.steps[0].data.links.length, 1);
  const { data: root } = await srv.call('/drive/list?folder=root');
  const folder = root.items.find((i) => i.name === 'Q4 Notes');
  assert.ok(folder);
  const { data: inside } = await srv.call(`/drive/list?folder=${folder.id}`);
  assert.equal(inside.items[0].name, 'Reactor_Notes_Q4.txt');
  assert.equal(inside.items[0].kind, 'text');
});

test('uploading into an existing folder by id', async () => {
  const folders = (await srv.call('/drive/folders')).data.folders;
  const target = folders.find((f) => f.name === 'Schematics');
  const staged = await srv.stage('hull.step', 'x'.repeat(2048));
  const up = await srv.call('/drive/upload', { method: 'POST', body: { attachmentId: staged.id, folderId: target.id, folderLabel: target.path } });
  const j = await srv.waitJob(up.data.id, srv.settled);
  assert.equal(j.state, 'done');
  assert.match(j.reply, /My Drive \/ Schematics/);
});

test('an attached file plus a typed order: unknown folder asks, "create it" finishes', async () => {
  const staged = await srv.stage('Thruster_Test.txt', 'burn complete');
  const q = await srv.run('upload this to the Propulsion folder', { attachmentIds: [staged.id] });
  assert.equal(q.state, 'needs_input');
  assert.match(q.reply, /no folder called “Propulsion”/);
  const done = await srv.run('create it');
  assert.equal(done.state, 'done', done.reply);
  const folders = (await srv.call('/drive/folders')).data.folders;
  assert.ok(folders.some((f) => f.name === 'Propulsion'));
});

test('"upload this document" with nothing attached prompts for a file instead of failing', async () => {
  const j = await srv.run('JARVIS, upload this research report to my Drive');
  assert.equal(j.state, 'needs_input');
  assert.match(j.reply, /Select the document/);
});

test('the activity log records who did what', async () => {
  const { data } = await srv.call('/log?limit=300');
  assert.ok(data.actions.some((a) => a.integration === 'telegram' && a.status === 'declined'));
  assert.ok(data.actions.some((a) => a.integration === 'drive' && a.origin === 'console' && a.status === 'ok'));
  assert.ok(data.actions.some((a) => a.integration === 'calendar' && a.status === 'failed'));
  assert.ok(data.actions.every((a) => a.ts && a.label && a.summary));
});

test('reminders become due and can be snoozed or completed', async () => {
  const at = new Date(Date.now() + 1200).toISOString();
  const { data: r } = await srv.call('/reminders', { method: 'POST', body: { text: 'Run diagnostics', at } });
  await sleep(6500);
  let list = (await srv.call('/reminders')).data.active;
  assert.equal(list.find((x) => x.id === r.id).status, 'due');
  await srv.call(`/reminders/${r.id}/snooze`, { method: 'POST', body: { minutes: 10 } });
  list = (await srv.call('/reminders')).data.active;
  const snoozed = list.find((x) => x.id === r.id);
  assert.equal(snoozed.status, 'pending');
  assert.ok(new Date(snoozed.at) - Date.now() > 9 * 60000);
  await srv.call(`/reminders/${r.id}/done`, { method: 'POST' });
  assert.ok(!(await srv.call('/reminders')).data.active.some((x) => x.id === r.id));
});

test('contacts: add, reject bad ids, and use immediately', async () => {
  assert.equal((await srv.call('/contacts', { method: 'POST', body: { name: 'Happy Hogan', chatId: 'not-a-number' } })).status, 400);
  await srv.call('/contacts', { method: 'POST', body: { name: 'Happy Hogan', chatId: '1004' } });
  const j = await srv.run('message Happy: car is waiting');
  assert.equal(j.state, 'done', j.reply);
});

test('unknown chat ids fail with a plain-language reason', async () => {
  await srv.call('/contacts', { method: 'POST', body: { name: 'Ghost Rider', chatId: '5555' } });
  const j = await srv.run('message Ghost hello there');
  assert.equal(j.state, 'failed');
  assert.equal(j.steps[0].error.code, 'CHAT_NOT_FOUND');
});

test('cross-origin writes are refused', async () => {
  const res = await fetch(`${srv.base}/api/commands`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example' }, body: JSON.stringify({ text: 'tell Bruce hi' }) });
  assert.equal(res.status, 403);
});

test('requests addressed to an unknown host name are refused', async () => {
  const { request } = await import('node:http');
  const port = new URL(srv.base).port;
  const status = await new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path: '/api/state', headers: { Host: `rebind.attacker.example:${port}` } }, (res) => { res.resume(); resolve(res.statusCode); });
    req.on('error', reject);
    req.end();
  });
  assert.equal(status, 403);
});

test('empty and oversized input is handled', async () => {
  assert.equal((await srv.call('/commands', { method: 'POST', body: { text: '   ' } })).status, 400);
  const long = await srv.run('hello '.repeat(1000));
  assert.ok(['done', 'needs_input'].includes(long.state));
});
