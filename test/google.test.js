// Runs the real Google adapters (googleapis client, OAuth credentials, query
// building, path resolution, upload streaming) against an in-process stand-in
// for googleapis.com, so request shapes and response handling are exercised.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { startServer } from './helpers.js';

const FOLDER = 'application/vnd.google-apps.folder';
const files = new Map();
const events = new Map();
const seen = [];
let failAuth = false;
let nextId = 1;
const id = (p) => `${p}${nextId++}`;

const seedFile = (f) => files.set(f.id, { modifiedTime: '2026-09-30T10:00:00.000Z', parents: ['ROOT'], ...f });
seedFile({ id: 'F_RES', name: 'Research', mimeType: FOLDER });
seedFile({ id: 'F_REA', name: 'Arc Reactor', mimeType: FOLDER, parents: ['F_RES'] });
seedFile({ id: 'D1', name: "Reactor Design Report v3.pdf", mimeType: 'application/pdf', parents: ['F_REA'], size: '4820113', webViewLink: 'https://drive.google.com/file/d/D1/view' });
seedFile({ id: 'D2', name: "Tony's notes.txt", mimeType: 'text/plain', parents: ['ROOT'], size: '40', fullText: 'palladium decay curve' });

function matchQuery(q, f) {
  let ok = true;
  const parent = /'([^']+)' in parents/.exec(q);
  if (parent) ok &&= f.parents.includes(parent[1]);
  if (/trashed=false/.test(q)) ok &&= !f.trashed;
  if (new RegExp(`mimeType='${FOLDER}'`).test(q)) ok &&= f.mimeType === FOLDER;
  if (new RegExp(`mimeType != '${FOLDER}'`).test(q)) ok &&= f.mimeType !== FOLDER;
  const terms = [...q.matchAll(/(name|fullText) contains '((?:[^'\\]|\\.)*)'/g)].map((m) => ({ k: m[1], v: m[2].replace(/\\(.)/g, '$1').toLowerCase() }));
  if (terms.length) {
    const test = (t) => (t.k === 'name' ? f.name.toLowerCase().includes(t.v) : `${f.name} ${f.fullText || ''}`.toLowerCase().includes(t.v));
    ok &&= / or /.test(q) ? terms.some(test) : terms.every(test);
  }
  return ok;
}

const pick = (obj, fields) => {
  if (!fields) return obj;
  const m = /files\(([^)]*)\)/.exec(fields);
  const want = (m ? m[1] : fields).split(',');
  return Object.fromEntries(want.filter((k) => k in obj).map((k) => [k, obj[k]]));
};

const fake = http.createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks);
  const url = new URL(req.url, 'http://x');
  const send = (status, json) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(json === undefined ? '' : JSON.stringify(json)); };
  seen.push({ method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), auth: req.headers.authorization, type: req.headers['content-type'], raw });
  if (failAuth) return send(401, { error: { code: 401, message: 'Invalid Credentials', errors: [{ reason: 'authError' }] } });

  const p = url.pathname;
  let m;
  if (p === '/calendar/v3/users/me/calendarList') return send(200, { items: [] });
  if (p === '/calendar/v3/calendars/primary/events' && req.method === 'GET') {
    const min = new Date(url.searchParams.get('timeMin'));
    const max = new Date(url.searchParams.get('timeMax'));
    const items = [...events.values()].filter((e) => new Date(e.end.dateTime || e.end.date) > min && new Date(e.start.dateTime || e.start.date) < max);
    return send(200, { items });
  }
  if (p === '/calendar/v3/calendars/primary/events' && req.method === 'POST') {
    const body = JSON.parse(raw);
    const ev = { id: id('ev'), status: 'confirmed', htmlLink: 'https://calendar.google.com/event?eid=x', ...body };
    events.set(ev.id, ev);
    return send(200, ev);
  }
  if ((m = /^\/calendar\/v3\/calendars\/primary\/events\/([^/]+)$/.exec(p))) {
    const ev = events.get(m[1]);
    if (!ev) return send(404, { error: { code: 404, message: 'Not Found', errors: [{ reason: 'notFound' }] } });
    if (req.method === 'PATCH') { Object.assign(ev, JSON.parse(raw)); return send(200, ev); }
    if (req.method === 'DELETE') { events.delete(m[1]); res.writeHead(204); return res.end(); }
  }
  if (p === '/drive/v3/files/root') return send(200, { id: 'ROOT' });
  if (p === '/drive/v3/files' && req.method === 'GET') {
    const q = url.searchParams.get('q') || '';
    const list = [...files.values()].filter((f) => matchQuery(q, f)).map((f) => pick(f, url.searchParams.get('fields')));
    return send(200, { files: list });
  }
  if (p === '/drive/v3/files' && req.method === 'POST') {
    const body = JSON.parse(raw);
    const f = { id: id('fld'), modifiedTime: new Date().toISOString(), ...body };
    files.set(f.id, f);
    return send(200, pick(f, url.searchParams.get('fields')));
  }
  if ((m = /^\/drive\/v3\/files\/([^/]+)$/.exec(p)) && req.method === 'GET') {
    const f = files.get(m[1]);
    return f ? send(200, pick(f, url.searchParams.get('fields'))) : send(404, { error: { code: 404, message: 'File not found', errors: [{ reason: 'notFound' }] } });
  }
  if (p === '/upload/drive/v3/files' && req.method === 'POST') {
    const boundary = /boundary=(.+)$/.exec(req.headers['content-type'])[1].replace(/"/g, '');
    const parts = raw.toString('latin1').split(`--${boundary}`).filter((s) => /Content-Type/i.test(s));
    const meta = JSON.parse(parts[0].split(/\r\n\r\n/)[1].trim());
    const media = parts[1].split(/\r\n\r\n/).slice(1).join('\r\n\r\n').replace(/\r\n$/, '');
    const f = { id: id('up'), modifiedTime: new Date().toISOString(), mimeType: 'text/plain', size: String(media.length), webViewLink: 'https://drive.google.com/file/d/up/view', content: media, ...meta };
    files.set(f.id, f);
    return send(200, pick(f, url.searchParams.get('fields')));
  }
  return send(404, { error: { code: 404, message: `fake google: no route for ${req.method} ${p}` } });
});

let google;
let srv;
before(async () => {
  await new Promise((r) => fake.listen(0, '127.0.0.1', r));
  google = `http://127.0.0.1:${fake.address().port}/`;
  srv = await startServer(
    { GOOGLE_CLIENT_ID: 'cid', GOOGLE_CLIENT_SECRET: 'sec', GOOGLE_API_ROOT_URL: google },
    { seed: { google: { tokens: { access_token: 'AT-1', refresh_token: 'RT-1', expiry_date: Date.now() + 3600e3 }, email: 'tony@stark.example', status: 'ok' } } },
  );
});
after(async () => { await srv.stop(); await new Promise((r) => fake.close(r)); });

test('connected account reports online with the signed-in address', async () => {
  const { data } = await srv.call('/systems?probe=1');
  assert.equal(data.calendar.state, 'online');
  assert.equal(data.drive.account, 'tony@stark.example');
  assert.ok(seen.some((r) => r.path === '/calendar/v3/users/me/calendarList' && r.auth === 'Bearer AT-1'));
});

test('calendar: create goes to the primary calendar with title, times, description and timezone', async () => {
  const j = await srv.run('schedule a meeting with Bruce Banner tomorrow at 4 PM to discuss the gamma sample');
  assert.equal(j.state, 'done', j.reply);
  const post = seen.find((r) => r.method === 'POST' && r.path === '/calendar/v3/calendars/primary/events');
  const body = JSON.parse(post.raw);
  assert.equal(body.summary, 'Meeting with Bruce Banner');
  assert.equal(body.description, 'Discuss the gamma sample');
  assert.equal(body.start.timeZone, 'UTC');
  assert.equal(new Date(body.end.dateTime) - new Date(body.start.dateTime), 3600000);
  assert.equal(post.query.sendUpdates, 'none');
  // and it comes straight back through the preview endpoint
  const from = new Date(Date.now() - 864e5).toISOString();
  const to = new Date(Date.now() + 5 * 864e5).toISOString();
  const { data } = await srv.call(`/calendar/events?from=${from}&to=${to}&tz=UTC`);
  assert.equal(data.events[0].title, 'Meeting with Bruce Banner');
  assert.equal(data.events[0].link, 'https://calendar.google.com/event?eid=x');
});

test('calendar: inviting guests is confirmed first and sends updates', async () => {
  const j = await srv.run('schedule lunch with pepper@stark.example tomorrow at noon');
  assert.equal(j.state, 'done');
  const post = seen.filter((r) => r.method === 'POST' && r.path === '/calendar/v3/calendars/primary/events').at(-1);
  assert.deepEqual(JSON.parse(post.raw).attendees, [{ email: 'pepper@stark.example' }]);
  assert.equal(post.query.sendUpdates, 'all');
});

test('calendar: an overlapping event is flagged in the confirmation', async () => {
  const j = await srv.run('schedule the gamma review tomorrow at 4:30 PM');
  assert.match(j.reply, /Overlaps with “Meeting with Bruce Banner”/);
});

test('calendar: reschedule patches the event; cancel deletes it after approval', async () => {
  const mv = await srv.run('move the gamma review to 6pm');
  assert.equal(mv.state, 'done', mv.reply);
  const patch = seen.find((r) => r.method === 'PATCH');
  assert.equal(new Date(JSON.parse(patch.raw).start.dateTime).getUTCHours(), 18);
  const del = await srv.run('cancel the gamma review');
  assert.equal(del.state, 'done');
  assert.ok(seen.some((r) => r.method === 'DELETE'));
});

test('drive: browse shows names, types, sizes and a path for each file', async () => {
  const { data } = await srv.call('/drive/list?folder=F_REA');
  assert.deepEqual(data.breadcrumbs.map((c) => c.name), ['My Drive', 'Research', 'Arc Reactor']);
  const f = data.items[0];
  assert.equal(f.name, 'Reactor Design Report v3.pdf');
  assert.equal(f.kind, 'pdf');
  assert.equal(f.folderPath, 'My Drive / Research / Arc Reactor');
  assert.equal(f.size, 4820113);
  assert.equal(f.link, 'https://drive.google.com/file/d/D1/view');
  const root = (await srv.call('/drive/list')).data;
  assert.deepEqual(root.items.map((i) => i.name).sort(), ["Research", "Tony's notes.txt"]);
});

test('drive: search builds keyword queries, falls back to contents, then to partial matches', async () => {
  const byName = (await srv.call('/drive/search?q=reactor%20design')).data;
  assert.equal(byName.mode, 'name');
  assert.equal(byName.files[0].folderPath, 'My Drive / Research / Arc Reactor');
  const apos = (await srv.call(`/drive/search?q=${encodeURIComponent("tony's notes")}`)).data;
  assert.equal(apos.files[0].name, "Tony's notes.txt");
  const sentQ = seen.filter((r) => r.path === '/drive/v3/files').map((r) => r.query.q).find((q) => q?.includes("name contains 'notes'"));
  assert.match(sentQ, /^name contains 'tony' and name contains 'notes' and trashed=false and mimeType != /, 'every keyword must be in the name, trashed files excluded');
  const byContent = (await srv.call('/drive/search?q=palladium')).data;
  assert.equal(byContent.mode, 'content');
  assert.equal(byContent.files[0].name, "Tony's notes.txt");
  const partial = (await srv.call('/drive/search?q=reactor%20banana')).data;
  assert.equal(partial.mode, 'partial');
  const none = (await srv.call('/drive/search?q=zzzz')).data;
  assert.equal(none.files.length, 0);
});

test('drive: upload streams the file into a newly created folder and reports progress', async () => {
  const content = 'palladium core readings\n'.repeat(4000);
  const staged = await srv.stage('Core_Readings.txt', content);
  const up = await srv.call('/drive/upload', { method: 'POST', body: { attachmentId: staged.id, newFolder: 'Mark 51', parentId: 'root', folderLabel: 'My Drive' } });
  const j = await srv.waitJob(up.data.id, srv.settled);
  assert.equal(j.state, 'done', j.reply + srv.log());
  const folderCreate = seen.find((r) => r.method === 'POST' && r.path === '/drive/v3/files');
  assert.deepEqual(JSON.parse(folderCreate.raw), { name: 'Mark 51', mimeType: FOLDER, parents: ['ROOT'] });
  const upload = seen.find((r) => r.path === '/upload/drive/v3/files');
  assert.match(upload.type, /^multipart\/related/);
  const stored = [...files.values()].find((f) => f.name === 'Core_Readings.txt');
  assert.equal(stored.content, content, 'file bytes arrive intact');
  assert.equal(stored.parents.length, 1);
  assert.equal(files.get(stored.parents[0]).name, 'Mark 51');
  assert.equal(j.steps[0].data.links.length, 1);
  assert.match(j.reply, /My Drive \/ Mark 51/);
});

test('drive: upload to an existing folder chosen by name', async () => {
  const staged = await srv.stage('Decay.txt', 'half-life 138 days');
  const j = await srv.run('upload this to the Arc Reactor folder', { attachmentIds: [staged.id] });
  assert.equal(j.state, 'done', j.reply);
  const stored = [...files.values()].find((f) => f.name === 'Decay.txt');
  assert.deepEqual(stored.parents, ['F_REA']);
  assert.match(j.reply, /My Drive \/ Research \/ Arc Reactor/);
});

test('drive: destination list contains nested folders with full paths', async () => {
  const { data } = await srv.call('/drive/folders');
  assert.ok(data.folders.some((f) => f.path === 'My Drive / Research / Arc Reactor'));
  assert.ok(data.folders.some((f) => f.path === 'My Drive / Mark 51'));
});

test('a Google 401 marks the account expired, tells Tony, and offers reconnect', async () => {
  failAuth = true;
  const j = await srv.run('what do I have scheduled tomorrow');
  failAuth = false;
  assert.equal(j.state, 'failed');
  assert.equal(j.steps[0].error.code, 'AUTH_EXPIRED');
  assert.match(j.reply, /Reconnect your Google account/);
  const sys = (await srv.call('/systems')).data;
  assert.equal(sys.calendar.state, 'expired');
  assert.equal(sys.drive.state, 'expired');
  // while expired, nothing reaches Google and the message is immediate
  const before = seen.length;
  const again = await srv.run('what do I have scheduled today');
  assert.equal(again.steps[0].error.code, 'AUTH_EXPIRED');
  assert.equal(seen.length, before);
  const ev = await srv.call('/calendar/events');
  assert.equal(ev.status, 409);
});
