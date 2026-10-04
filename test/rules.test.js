import test from 'node:test';
import assert from 'node:assert/strict';

process.env.JARVIS_DEMO = '1';
const { store } = await import('../server/store.js');
const { DEMO_CONTACTS } = await import('../server/integrations/demo.js');
const { makePlan } = await import('../server/brain/planner.js');
const { splitClauses } = await import('../server/brain/rules.js');

store.data.contacts = DEMO_CONTACTS.map((c) => ({ ...c }));
const tz = 'America/Los_Angeles';
const now = new Date('2026-10-04T20:30:00Z'); // Sun 4 Oct 2026, 1:30 PM PDT

const plan = (text, pending = null) => makePlan(text, { tz, now, pending, attachments: [], history: [] });
const local = (iso) => new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(new Date(iso));

test('schedules a meeting with title, date and time', async () => {
  const p = await plan('Schedule a meeting with Bruce tomorrow at 5 PM.');
  assert.equal(p.steps.length, 1);
  assert.equal(p.steps[0].tool, 'calendar_create');
  assert.equal(p.steps[0].args.title, 'Meeting with Bruce');
  assert.equal(local(p.steps[0].args.start), 'Mon, Oct 5, 5:00 PM');
  assert.equal(local(p.steps[0].args.end), 'Mon, Oct 5, 6:00 PM');
});

test('pulls a description and duration out of the request', async () => {
  const p = await plan('schedule a call with Pepper next Tuesday at 3pm for 45 minutes to discuss the board deck');
  const a = p.steps[0].args;
  assert.equal(a.title, 'Call with Pepper');
  assert.equal(a.description, 'Discuss the board deck');
  assert.equal(new Date(a.end) - new Date(a.start), 45 * 60000);
});

test('asks when the time is missing, then accepts the answer', async () => {
  const q1 = await plan('schedule a meeting with Bruce');
  assert.match(q1.clarify, /When should I schedule/);
  const q2 = await plan('tomorrow', q1.pending);
  assert.match(q2.clarify, /What time tomorrow/);
  const q3 = await plan('4:30 pm', q2.pending);
  assert.equal(q3.steps[0].tool, 'calendar_create');
  assert.equal(local(q3.steps[0].args.start), 'Mon, Oct 5, 4:30 PM');
});

test('asks AM or PM when it is ambiguous', async () => {
  const q1 = await plan('remind me to call Pepper at 7');
  assert.match(q1.clarify, /7 AM or 7 PM/);
  const q2 = await plan('pm', q1.pending);
  assert.equal(q2.steps[0].tool, 'reminder_create');
  assert.equal(local(q2.steps[0].args.at), 'Sun, Oct 4, 7:00 PM');
});

test('reminders: absolute time, and morning defaults to 9 AM', async () => {
  const a = await plan('Remind me to check the Mark 50 at 7 PM');
  assert.equal(a.steps[0].args.text, 'check the Mark 50');
  assert.equal(local(a.steps[0].args.at), 'Sun, Oct 4, 7:00 PM');
  const b = await plan('Remind me tomorrow morning about the reactor test');
  assert.equal(b.steps[0].args.text, 'the reactor test');
  assert.equal(local(b.steps[0].args.at), 'Mon, Oct 5, 9:00 AM');
});

test('the brief\'s chained request becomes three dependent steps', async () => {
  const p = await plan('JARVIS, schedule the Stark team meeting for tomorrow at 6 PM, remind me 30 minutes before it, and send Bruce a Telegram message about it.');
  assert.deepEqual(p.steps.map((s) => s.tool), ['calendar_create', 'reminder_create', 'telegram_send']);
  assert.equal(p.steps[0].args.title, 'Stark team meeting');
  assert.equal(local(p.steps[1].args.at), 'Mon, Oct 5, 5:30 PM');
  assert.deepEqual(p.steps[1].dependsOn, [0]);
  assert.equal(p.steps[2].args.recipient, 'Bruce Banner');
  assert.match(p.steps[2].args.text, /Stark team meeting is set for tomorrow at 6:00 PM/);
  assert.deepEqual(p.steps[2].dependsOn, [0]);
});

test('telegram: recipient and message are extracted; missing pieces are asked for', async () => {
  const a = await plan('send Bruce a message saying the experiment is postponed');
  assert.equal(a.steps[0].args.recipient, 'Bruce Banner');
  assert.equal(a.steps[0].args.text, 'The experiment is postponed.');

  const b = await plan('Send a message to the team.');
  assert.match(b.clarify, /What should I tell Stark Team/);
  const b2 = await plan('Standup moved to ten', b.pending);
  assert.equal(b2.steps[0].args.text, 'Standup moved to ten.');

  const c = await plan('message Natasha: be there at 6');
  assert.match(c.clarify, /don't have a Telegram contact for “Natasha”/);
  assert.match(c.clarify, /Bruce Banner/);
});

test('drive: search, upload destinations, folders', async () => {
  assert.equal((await plan('JARVIS, find the reactor design report')).steps[0].args.query, 'reactor design report');
  const up = await plan('upload this to the Research folder');
  assert.equal(up.steps[0].args.folder, 'Research');
  const nf = await plan('upload it to a new folder called Mark 51 Drafts');
  assert.equal(nf.steps[0].args.newFolder, 'Mark 51 Drafts');
  assert.equal((await plan('Upload this document to my Drive.')).steps[0].args.folder, '');
});

test('views: tomorrow, next week, reminders today', async () => {
  const t = await plan('What do I have scheduled for tomorrow?');
  assert.equal(t.steps[0].tool, 'calendar_list');
  assert.equal(local(t.steps[0].args.start), 'Mon, Oct 5, 12:00 AM');
  assert.equal(local(t.steps[0].args.end), 'Tue, Oct 6, 12:00 AM');
  const w = await plan("what's on my calendar next week");
  assert.equal(local(w.steps[0].args.start), 'Mon, Oct 5, 12:00 AM');
  assert.equal(local(w.steps[0].args.end), 'Mon, Oct 12, 12:00 AM');
  assert.equal((await plan('What reminders do I have today?')).steps[0].args.scope, 'today');
});

test('reschedule and cancel keep the event reference', async () => {
  const m = await plan('move the Avengers sync to Friday at 4pm');
  assert.equal(m.steps[0].tool, 'calendar_update');
  assert.equal(m.steps[0].args.match.title, 'Avengers sync');
  assert.equal(local(m.steps[0].args.changes.start), 'Fri, Oct 9, 4:00 PM');
  const t = await plan('reschedule my meeting with Bruce to 3pm');
  assert.equal(t.steps[0].args.changes.keepDate, true);
  const c = await plan('cancel my meeting with Bruce tomorrow');
  assert.equal(c.steps[0].tool, 'calendar_delete');
});

test('a message body in quotes survives clause splitting', () => {
  const parts = splitClauses('message Bruce "bring the files and send me the results", remind me at 9pm');
  assert.equal(parts.length, 2);
  assert.match(parts[0], /bring the files and send me the results/);
});

test('small talk and nonsense get a reply, not a plan', async () => {
  assert.equal((await plan('hello')).steps.length, 0);
  assert.match((await plan('what can you do')).reply, /Calendar/);
  assert.match((await plan('blah blah')).reply, /not sure/);
});

test('past times are refused and the answer re-resolves the day', async () => {
  const q1 = await plan('remind me to stretch at 8 AM today');
  assert.match(q1.clarify, /already passed/);
  const q2 = await plan('tomorrow at 8 am', q1.pending);
  assert.equal(local(q2.steps[0].args.at), 'Mon, Oct 5, 8:00 AM');
});
