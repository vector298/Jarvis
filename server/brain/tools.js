// Every capability JARVIS has. A tool validates raw arguments (from the LLM or
// the built-in parser), describes itself, says whether it needs Tony's go-ahead,
// and executes against an integration.
import fs from 'node:fs';
import { store, uid } from '../store.js';
import { JarvisError, NeedsInput } from '../errors.js';
import { resolveContact, contactNames } from './contacts.js';
import {
  parseWhen, startOfDay, addDays, endOfDay, fmtTime, fmtDay, fmtWhen, fmtLongDate, sameDay, wallParts, zonedToDate,
} from '../time.js';

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const str = (v) => (typeof v === 'string' ? v.trim() : '');
const clean = (s) => str(s).replace(/\s+/g, ' ');
const listify = (items) => (items.length <= 1 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`);
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

const STOP = new Set(['the', 'a', 'an', 'my', 'that', 'this', 'of', 'to', 'for', 'about', 'with', 'and', 'on', 'at', 'in']);
const words = (s) => String(s || '').toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 1 && !STOP.has(w));

// Score items by how many of the query's words appear in their text.
function fuzzy(items, query, text) {
  const q = words(query);
  if (!q.length) return [];
  const scored = items
    .map((item) => {
      const hay = String(text(item)).toLowerCase();
      return { item, score: q.filter((w) => hay.includes(w)).length / q.length };
    })
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score);
  if (!scored.length) return [];
  const top = scored[0].score;
  if (top < 0.5) return [];
  return scored.filter((s) => s.score === top).map((s) => s.item);
}

function needTime(raw, field, tz, ask) {
  const v = raw?.[field];
  if (!v) throw new NeedsInput(ask);
  const d = parseWhen(v, tz);
  if (!d) throw new NeedsInput(`I couldn't read “${v}” as a date and time. When exactly?`);
  return d;
}

const eventLine = (e, tz, now) => {
  if (e.allDay) return `All day · ${e.title}`;
  return `${fmtTime(new Date(e.start), tz)}–${fmtTime(new Date(e.end || e.start), tz)} · ${e.title}`;
};

async function findEvents(ctx, match) {
  const { tz, now } = ctx;
  let from;
  let to;
  if (match.date) {
    const d = parseWhen(match.date, tz);
    from = startOfDay(d, tz);
    to = endOfDay(d, tz);
  } else {
    from = startOfDay(now, tz);
    to = addDays(from, 120, tz);
  }
  const events = await ctx.integrations.calendar.list({ from, to, tz });
  if (match.id) return events.filter((e) => e.id === match.id);
  if (!match.title) return match.date ? events : [];
  return fuzzy(events, match.title, (e) => e.title);
}

async function pickEvent(ctx, match, verb) {
  const found = await findEvents(ctx, match);
  if (found.length === 0) {
    throw new JarvisError('NOT_FOUND', `I couldn't find an event matching “${match.title || 'that'}” ${match.date ? 'on that day' : 'in the next four months'}.`, { integration: 'calendar' });
  }
  if (found.length > 1) {
    const lines = found.slice(0, 5).map((e) => `${fmtWhen(new Date(e.start), ctx.tz, ctx.now)} · ${e.title}`);
    throw new NeedsInput(`Several events match. Which one should I ${verb}?\n${lines.join('\n')}`);
  }
  return found[0];
}

function pickReminder(match, ctx) {
  const open = store.data.reminders.filter((r) => r.status === 'pending' || r.status === 'due');
  if (match.id) return open.find((r) => r.id === match.id) || null;
  const found = fuzzy(open, match.text, (r) => r.text);
  if (found.length === 0) {
    throw new JarvisError('NOT_FOUND', `No active reminder matches “${match.text}”.`, { integration: 'reminders' });
  }
  if (found.length > 1) {
    throw new NeedsInput(`More than one reminder fits. Which one?\n${found.map((r) => `${fmtWhen(new Date(r.at), ctx.tz, ctx.now)} · ${r.text}`).join('\n')}`);
  }
  return found[0];
}

export const TOOLS = {
  calendar_create: {
    integration: 'calendar',
    verb: 'Schedule',
    prepare(raw, ctx) {
      const title = clean(raw.title);
      if (!title) throw new NeedsInput('What should I call the event?');
      const start = needTime(raw, 'start', ctx.tz, `When should “${title}” start?`);
      const allDay = Boolean(raw.allDay);
      let end = raw.end ? parseWhen(raw.end, ctx.tz) : null;
      if (!allDay && !end) {
        const mins = Math.min(Math.max(Number(raw.durationMinutes) || 60, 5), 24 * 60);
        end = new Date(start.getTime() + mins * 60000);
      }
      if (end && end <= start) throw new NeedsInput('That event would end before it starts. What end time did you want?');
      if (!allDay && start.getTime() < ctx.now.getTime() - 5 * 60000) {
        throw new NeedsInput(`${fmtWhen(start, ctx.tz, ctx.now)} has already passed. Did you mean a later date?`);
      }
      const attendees = (raw.attendees || []).map(str).filter((a) => EMAIL.test(a));
      return {
        title,
        start: start.toISOString(),
        end: end ? end.toISOString() : null,
        allDay,
        description: str(raw.description),
        location: str(raw.location),
        attendees,
      };
    },
    risk: (a) => (a.attendees.length ? 'confirm' : 'safe'),
    label: (a, ctx) => `Schedule “${a.title}” · ${a.allDay ? `${fmtDay(new Date(a.start), ctx.tz, ctx.now)}, all day` : fmtWhen(new Date(a.start), ctx.tz, ctx.now)}`,
    confirmText: (a) => `This invites ${listify(a.attendees)} by email.`,
    async run(a, ctx) {
      const start = new Date(a.start);
      const end = a.end ? new Date(a.end) : null;
      const notes = [];
      if (!a.allDay) {
        try {
          const clash = (await ctx.integrations.calendar.list({ from: start, to: end, tz: ctx.tz })).filter((e) => !e.allDay);
          if (clash.length) notes.push(`Overlaps with ${listify(clash.map((e) => `“${e.title}” (${fmtTime(new Date(e.start), ctx.tz)})`))}.`);
        } catch {
          // the conflict check is advisory; the create call will report real problems
        }
      }
      const ev = await ctx.integrations.calendar.create({ ...a, start, end, tz: ctx.tz });
      const when = a.allDay ? `${fmtDay(start, ctx.tz, ctx.now)}, all day` : fmtWhen(start, ctx.tz, ctx.now);
      return {
        say: `“${a.title}” is on the calendar for ${when}.${notes.length ? ` ${notes.join(' ')}` : ''}`,
        short: 'event scheduled',
        notes,
        data: { eventId: ev.id },
        focus: { panel: 'calendar', date: a.start, highlight: ev.id },
      };
    },
  },

  calendar_list: {
    integration: 'calendar',
    verb: 'Check calendar',
    prepare(raw, ctx) {
      let start = raw.start ? parseWhen(raw.start, ctx.tz) : null;
      let end = raw.end ? parseWhen(raw.end, ctx.tz) : null;
      if (!start) start = ctx.now;
      if (!end || end <= start) end = addDays(startOfDay(start, ctx.tz), 7, ctx.tz);
      return { start: start.toISOString(), end: end.toISOString(), label: clean(raw.label) };
    },
    risk: () => 'safe',
    label: (a, ctx) => `Check calendar · ${a.label || fmtDay(new Date(a.start), ctx.tz, ctx.now)}`,
    async run(a, ctx) {
      const start = new Date(a.start);
      const end = new Date(a.end);
      const events = await ctx.integrations.calendar.list({ from: start, to: end, tz: ctx.tz });
      const reminders = store.data.reminders.filter((r) => ['pending', 'due'].includes(r.status) && new Date(r.at) >= start && new Date(r.at) < end);
      const label = a.label || fmtDay(start, ctx.tz, ctx.now);
      const lines = [];
      if (!events.length) lines.push(`Nothing on the calendar for ${label}.`);
      else {
        lines.push(`${plural(events.length, 'event')} for ${label}:`);
        const multiDay = !sameDay(start, new Date(end.getTime() - 1), ctx.tz);
        let lastDay = '';
        for (const e of events) {
          const day = fmtDay(new Date(e.start), ctx.tz, ctx.now);
          if (multiDay && day !== lastDay) {
            lines.push(`${day[0].toUpperCase()}${day.slice(1)}`);
            lastDay = day;
          }
          lines.push(`  ${eventLine(e, ctx.tz, ctx.now)}`);
        }
      }
      if (reminders.length) lines.push(`Plus ${plural(reminders.length, 'reminder')}: ${listify(reminders.map((r) => `${r.text} (${fmtTime(new Date(r.at), ctx.tz)})`))}.`);
      return {
        say: lines.join('\n'),
        short: `${plural(events.length, 'event')} found`,
        focus: { panel: 'calendar', date: a.start },
      };
    },
  },

  calendar_update: {
    integration: 'calendar',
    verb: 'Reschedule',
    prepare(raw, ctx) {
      const match = { id: str(raw.match?.id), title: clean(raw.match?.title), date: raw.match?.date || '' };
      if (!match.id && !match.title) throw new NeedsInput('Which event do you mean?');
      const c = raw.changes || {};
      const changes = {};
      if (c.title) changes.title = clean(c.title);
      if (c.start) changes.start = needTime(c, 'start', ctx.tz, 'To when?').toISOString();
      if (c.end) changes.end = needTime(c, 'end', ctx.tz, 'Until when?').toISOString();
      if (c.durationMinutes) changes.durationMinutes = Number(c.durationMinutes);
      if (c.keepDate) changes.keepDate = true;
      if (c.keepTime) changes.keepTime = true;
      if (c.description !== undefined) changes.description = str(c.description);
      if (c.location !== undefined) changes.location = str(c.location);
      if (!Object.keys(changes).filter((k) => k !== 'keepDate' && k !== 'keepTime').length) throw new NeedsInput(`What should change about “${match.title || 'that event'}”?`);
      return { match, changes };
    },
    risk: () => 'safe',
    label: (a, ctx) => `Update “${a.match.title || 'event'}”${a.changes.start ? ` · move to ${fmtWhen(new Date(a.changes.start), ctx.tz, ctx.now)}` : ''}`,
    async run(a, ctx) {
      const ev = await pickEvent(ctx, a.match, 'change');
      const patch = { ...a.changes };
      const { keepDate, keepTime } = patch;
      delete patch.keepDate;
      delete patch.keepTime;
      if (patch.start && (keepDate || keepTime)) {
        // only one half of the date-time was given: borrow the other from the existing event
        const given = wallParts(new Date(patch.start), ctx.tz);
        const old = wallParts(new Date(ev.start), ctx.tz);
        patch.start = (keepDate
          ? zonedToDate({ y: old.y, mo: old.mo, d: old.d, h: given.h, mi: given.mi }, ctx.tz)
          : zonedToDate({ y: given.y, mo: given.mo, d: given.d, h: old.h, mi: old.mi }, ctx.tz)
        ).toISOString();
      }
      if (patch.start) {
        const oldLen = new Date(ev.end || ev.start) - new Date(ev.start);
        const start = new Date(patch.start);
        const dur = patch.durationMinutes ? patch.durationMinutes * 60000 : oldLen || 3600000;
        patch.start = start;
        patch.end = patch.end ? new Date(patch.end) : new Date(start.getTime() + dur);
      } else if (patch.end) patch.end = new Date(patch.end);
      else if (patch.durationMinutes) patch.end = new Date(new Date(ev.start).getTime() + patch.durationMinutes * 60000);
      const updated = await ctx.integrations.calendar.update(ev.id, patch, ctx.tz);
      return {
        say: `“${updated.title}” is now ${fmtWhen(new Date(updated.start), ctx.tz, ctx.now)}.`,
        short: 'event updated',
        focus: { panel: 'calendar', date: updated.start, highlight: updated.id },
      };
    },
  },

  calendar_delete: {
    integration: 'calendar',
    verb: 'Cancel',
    prepare(raw) {
      const match = { id: str(raw.match?.id), title: clean(raw.match?.title), date: raw.match?.date || '' };
      if (!match.id && !match.title) throw new NeedsInput('Which event should I cancel?');
      return { match };
    },
    risk: () => 'confirm',
    label: (a) => `Cancel event “${a.match.title || 'selected event'}”`,
    async resolve(a, ctx) {
      const ev = await pickEvent(ctx, a.match, 'cancel');
      return { ...a, match: { id: ev.id, title: ev.title }, resolved: { title: ev.title, start: ev.start } };
    },
    confirmText: (a, ctx) => (a.resolved ? `${fmtWhen(new Date(a.resolved.start), ctx.tz, ctx.now)}. Guests will be notified if there are any.` : ''),
    async run(a, ctx) {
      await ctx.integrations.calendar.remove(a.match.id);
      return { say: `“${a.match.title}” has been removed from the calendar.`, short: 'event cancelled', focus: { panel: 'calendar' } };
    },
  },

  reminder_create: {
    integration: 'reminders',
    verb: 'Remind',
    prepare(raw, ctx) {
      const text = clean(raw.text).replace(/^(to|about)\s+/i, '');
      if (!text) throw new NeedsInput('What should I remind you about?');
      const at = needTime(raw, 'at', ctx.tz, `When should I remind you${text ? ` to ${text}` : ''}?`);
      if (at.getTime() < ctx.now.getTime() - 60000) {
        throw new NeedsInput(`${fmtWhen(at, ctx.tz, ctx.now)} has already passed. What time should I use?`);
      }
      return { text, at: at.toISOString() };
    },
    risk: () => 'safe',
    label: (a, ctx) => `Remind · ${a.text} · ${fmtWhen(new Date(a.at), ctx.tz, ctx.now)}`,
    async run(a, ctx) {
      const text = a.text.replace(/^./, (c) => c.toUpperCase());
      const r = { id: uid('r_'), text, at: a.at, status: 'pending', createdAt: new Date().toISOString(), jobId: ctx.job.id };
      store.push('reminders', r);
      return {
        say: `Reminder set for ${fmtWhen(new Date(a.at), ctx.tz, ctx.now)}: ${text}.`,
        short: 'reminder set',
        data: { reminderId: r.id },
        focus: { panel: 'reminders', highlight: r.id },
      };
    },
  },

  reminder_list: {
    integration: 'reminders',
    verb: 'Check reminders',
    prepare(raw, ctx) {
      const scope = ['today', 'upcoming', 'all', 'date'].includes(raw.scope) ? raw.scope : 'upcoming';
      let date = '';
      if (scope === 'date') {
        const d = needTime(raw, 'date', ctx.tz, 'Which day?');
        date = d.toISOString();
      }
      return { scope, date };
    },
    risk: () => 'safe',
    label: (a) => `Check reminders · ${a.scope === 'date' ? 'selected day' : a.scope}`,
    async run(a, ctx) {
      let open = store.data.reminders.filter((r) => r.status === 'pending' || r.status === 'due');
      let label = 'coming up';
      if (a.scope === 'today') {
        open = open.filter((r) => sameDay(new Date(r.at), ctx.now, ctx.tz) || new Date(r.at) < ctx.now);
        label = 'today';
      } else if (a.scope === 'date') {
        open = open.filter((r) => sameDay(new Date(r.at), new Date(a.date), ctx.tz));
        label = fmtDay(new Date(a.date), ctx.tz, ctx.now);
      } else if (a.scope === 'all') label = 'in total';
      open.sort((x, y) => x.at.localeCompare(y.at));
      const say = open.length
        ? `${plural(open.length, 'active reminder')} ${label}:\n${open.map((r) => `  ${fmtWhen(new Date(r.at), ctx.tz, ctx.now)} · ${r.text}`).join('\n')}`
        : `No active reminders ${label === 'in total' ? '' : label}`.trim() + '.';
      return { say, short: `${plural(open.length, 'reminder')} listed`, focus: { panel: 'reminders' } };
    },
  },

  reminder_complete: {
    integration: 'reminders',
    verb: 'Complete reminder',
    prepare(raw) {
      const text = clean(raw.match?.text || raw.text);
      if (!text) throw new NeedsInput('Which reminder is done?');
      return { match: { text } };
    },
    risk: () => 'safe',
    label: (a) => `Mark reminder done · ${a.match.text}`,
    async run(a, ctx) {
      const r = pickReminder(a.match, ctx);
      r.status = 'done';
      r.doneAt = new Date().toISOString();
      store.save();
      return { say: `Marked “${r.text}” as done.`, short: 'reminder completed', focus: { panel: 'reminders' } };
    },
  },

  reminder_delete: {
    integration: 'reminders',
    verb: 'Remove reminder',
    prepare(raw) {
      const text = clean(raw.match?.text || raw.text);
      if (!text) throw new NeedsInput('Which reminder should I remove?');
      return { match: { text } };
    },
    risk: () => 'safe',
    label: (a) => `Remove reminder · ${a.match.text}`,
    async run(a, ctx) {
      const r = pickReminder(a.match, ctx);
      store.data.reminders = store.data.reminders.filter((x) => x.id !== r.id);
      store.save();
      return { say: `Removed the reminder “${r.text}”.`, short: 'reminder removed', focus: { panel: 'reminders' } };
    },
  },

  drive_search: {
    integration: 'drive',
    verb: 'Search Archive',
    prepare(raw) {
      const query = clean(raw.query);
      if (!query) throw new NeedsInput('What should I look for?');
      return { query };
    },
    risk: () => 'safe',
    label: (a) => `Search Archive · “${a.query}”`,
    async run(a, ctx) {
      const { files, mode } = await ctx.integrations.drive.search(a.query);
      if (!files.length) {
        return { say: `Nothing in the Archive matches “${a.query}”. Try fewer or different keywords.`, short: 'no matches', focus: { panel: 'drive', search: a.query } };
      }
      const top = files.slice(0, 3).map((f) => `  ${f.name} · ${f.folderPath}`);
      const lead = mode === 'partial' ? `No exact match for “${a.query}”, but ${plural(files.length, 'file')} share some of the terms` : `${plural(files.length, 'file')} match “${a.query}”`;
      return {
        say: `${lead}:\n${top.join('\n')}${files.length > 3 ? `\n  …and ${files.length - 3} more in the Archive panel.` : ''}`,
        short: `${plural(files.length, 'file')} found`,
        focus: { panel: 'drive', search: a.query },
      };
    },
  },

  drive_list: {
    integration: 'drive',
    verb: 'Open folder',
    prepare(raw) {
      return { folder: clean(raw.folder) };
    },
    risk: () => 'safe',
    label: (a) => `Open folder · ${a.folder || 'My Drive'}`,
    async run(a, ctx) {
      const f = await resolveFolderOrThrow(ctx, a.folder);
      const listing = await ctx.integrations.drive.listFolder(f.id);
      return {
        say: `${f.path || f.name} holds ${plural(listing.items.length, 'item')}.`,
        short: 'folder opened',
        focus: { panel: 'drive', folder: f.id },
      };
    },
  },

  drive_create_folder: {
    integration: 'drive',
    verb: 'Create folder',
    prepare(raw) {
      const name = clean(raw.name);
      if (!name) throw new NeedsInput('What should the folder be called?');
      return { name, parent: clean(raw.parent), parentId: str(raw.parentId) };
    },
    risk: () => 'safe',
    label: (a) => `Create folder · ${a.name}${a.parent ? ` in ${a.parent}` : ''}`,
    async run(a, ctx) {
      const parent = a.parentId ? { id: a.parentId } : await resolveFolderOrThrow(ctx, a.parent);
      const f = await ctx.integrations.drive.createFolder(a.name, parent.id);
      return { say: `Created the folder ${f.path}.`, short: 'folder created', focus: { panel: 'drive', folder: f.id } };
    },
  },

  drive_upload: {
    integration: 'drive',
    verb: 'Upload',
    prepare(raw) {
      return {
        folder: clean(raw.folder),
        newFolder: clean(raw.newFolder),
        folderId: str(raw.folderId),
        folderLabel: clean(raw.folderLabel),
        parentId: str(raw.parentId),
      };
    },
    risk: () => 'safe',
    label: (a, ctx) => {
      const names = (ctx.attachments || []).map((f) => f.name);
      const where = a.folderLabel || a.folder;
      const dest = a.newFolder ? `new folder “${a.newFolder}”${where ? ` in ${where}` : ''}` : where || 'My Drive';
      return `Upload ${names.length ? listify(names) : 'document'} → ${dest}`;
    },
    async run(a, ctx) {
      const files = ctx.attachments || [];
      if (!files.length) {
        ctx.ui('openUpload', { folder: a.newFolder || a.folder || '' });
        throw new NeedsInput('Select the document in the Archive panel and I will file it' + (a.folder ? ` under ${a.folder}` : '') + '.', {});
      }
      let dest;
      if (a.newFolder) {
        const parent = a.parentId ? { id: a.parentId } : a.folder ? await resolveFolderOrThrow(ctx, a.folder) : { id: 'root' };
        dest = await ctx.integrations.drive.createFolder(a.newFolder, parent.id);
      } else if (a.folderId) {
        dest = { id: a.folderId, path: a.folderLabel || 'the selected folder' };
      } else {
        const found = await ctx.integrations.drive.findFolder(a.folder);
        if (!found) {
          throw new NeedsInput(
            `There's no folder called “${a.folder}” in your Drive. Say “create it” and I'll make it, or name another destination.`,
            { pending: { slot: 'folder', attachmentIds: files.map((f) => f.id) } },
          );
        }
        if (found.ambiguous) {
          throw new NeedsInput(`“${a.folder}” matches several folders. Which one?\n${found.ambiguous.map((f) => f.path).join('\n')}`, { pending: { slot: 'folder', attachmentIds: files.map((f) => f.id) } });
        }
        dest = found;
      }
      const uploaded = [];
      for (let i = 0; i < files.length; i++) {
        const f = files[i];
        ctx.progress(0, `Archiving ${f.name}`);
        const out = await ctx.integrations.drive.upload({
          filePath: f.path,
          name: f.name,
          mimeType: f.mime,
          folderId: dest.id,
          onProgress: (done, total) => ctx.progress(((i + done / total) / files.length) * 100, `Archiving ${f.name}`),
        });
        uploaded.push(out);
        fs.rm(f.path, { force: true }, () => {});
        ctx.consumeAttachment(f.id);
      }
      const path = dest.path || dest.name;
      return {
        say: uploaded.length === 1
          ? `“${uploaded[0].name}” is in the Archive: ${uploaded[0].folderPath}.`
          : `${plural(uploaded.length, 'document')} filed in ${path}.`,
        short: uploaded.length === 1 ? 'document archived' : `${uploaded.length} documents archived`,
        data: { fileIds: uploaded.map((u) => u.id), links: uploaded.map((u) => u.link) },
        focus: { panel: 'drive', folder: dest.id, highlight: uploaded[0].id },
      };
    },
  },

  telegram_send: {
    integration: 'telegram',
    verb: 'Message',
    prepare(raw) {
      const recipient = clean(raw.recipient);
      const text = str(raw.text);
      if (!recipient) throw new NeedsInput('Who should I send it to?');
      const r = resolveContact(recipient);
      if (r.none) {
        const known = contactNames();
        throw new NeedsInput(
          `I don't have a Telegram contact for “${recipient}”.${known.length ? ` I know ${listify(known)}.` : ''} You can add contacts under Comms.`,
          { pending: { slot: 'recipient' } },
        );
      }
      if (r.many) {
        throw new NeedsInput(`Which ${recipient} do you mean: ${listify(r.many.map((c) => c.name))}?`, { pending: { slot: 'recipient' } });
      }
      if (!text) {
        throw new NeedsInput(`What should I tell ${r.contact.name}?`, { pending: { slot: 'text' } });
      }
      return { recipient: r.contact.name, contactId: r.contact.id, chatId: r.contact.chatId, text };
    },
    risk: () => 'confirm',
    label: (a) => `Telegram → ${a.recipient}`,
    confirmText: (a) => `“${a.text}”`,
    async run(a, ctx) {
      const entry = { id: uid('m_'), ts: new Date().toISOString(), recipient: a.recipient, chatId: a.chatId, text: a.text, status: 'sent', jobId: ctx.job.id, origin: ctx.job.origin || 'command' };
      try {
        const res = await ctx.integrations.telegram.send(a.chatId, a.text);
        entry.messageId = res.messageId;
      } catch (err) {
        entry.status = 'failed';
        entry.error = err.message;
        store.push('messages', entry);
        throw err;
      }
      store.push('messages', entry);
      return {
        say: `Message delivered to ${a.recipient}.`,
        short: `${a.recipient.split(' ')[0]} notified`,
        data: { messageId: entry.id },
        focus: { panel: 'comms' },
      };
    },
    onDeclined(a, ctx) {
      store.push('messages', { id: uid('m_'), ts: new Date().toISOString(), recipient: a.recipient, chatId: a.chatId, text: a.text, status: 'declined', jobId: ctx.job.id, origin: ctx.job.origin || 'command' });
    },
  },

  comms_history: {
    integration: 'telegram',
    verb: 'Show comms',
    prepare: () => ({}),
    risk: () => 'safe',
    label: () => 'Open communication log',
    async run() {
      const msgs = store.data.messages;
      const sent = msgs.filter((m) => m.status === 'sent').length;
      return {
        say: msgs.length ? `${plural(msgs.length, 'message')} on record, ${sent} delivered. The log is open.` : 'No messages have gone out through me yet.',
        short: 'log opened',
        focus: { panel: 'comms' },
      };
    },
  },
};

export const TOOL_NAMES = Object.keys(TOOLS);

async function resolveFolderOrThrow(ctx, spec) {
  const found = await ctx.integrations.drive.findFolder(spec);
  if (!found) {
    throw new JarvisError('NOT_FOUND', `There's no folder called “${spec}” in your Drive.`, { integration: 'drive' });
  }
  if (found.ambiguous) {
    throw new NeedsInput(`“${spec}” matches several folders. Which one?\n${found.ambiguous.map((f) => f.path).join('\n')}`);
  }
  return found;
}

export { fmtLongDate, listify, plural };
