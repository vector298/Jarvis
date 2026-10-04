// Built-in command parser. Used when no LLM key is configured, or when the LLM
// is unreachable. It is deliberately conservative: when it isn't sure, it asks.
import * as chrono from 'chrono-node';
import { resolveContact } from './contacts.js';
import {
  zonedToDate, tzOffsetMinutes, startOfDay, addDays, wallParts, fmtWhen, toIsoOffset,
} from '../time.js';

const VERBS = 'remind|schedule|send|message|text|upload|find|search|show|what|whats|cancel|delete|remove|move|reschedule|postpone|push|set|create|add|book|tell|ping|list|mark|complete|check|open|notify|let|arrange|put|save|file|store|locate|dm|rename|do|am|how|give';
const SPLIT = new RegExp(
  `(?:\\s*[,;.]\\s*(?:and\\s+(?:then\\s+)?|then\\s+|also\\s+)?|\\s+and\\s+(?:then\\s+)?|\\s+then\\s+|\\s+also\\s+|\\s+after that\\s+)(?=(?:please\\s+)?(?:${VERBS})\\b)`,
  'i',
);

const unquote = (s) => String(s || '').trim().replace(/^["“'‘]+|["”'’]+$/g, '').trim();
const tidy = (s) => String(s || '').replace(/\s+/g, ' ').replace(/^[\s,.:;-]+|[\s,.:;-]+$/g, '');
const stripArticle = (s) => s.replace(/^(?:a|an|the|my|our)\s+/i, '');
const upFirst = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);
const sentence = (s) => {
  const t = upFirst(tidy(s));
  return /[.!?]$/.test(t) || !t ? t : `${t}.`;
};

function refFor(ctx) {
  return { instant: ctx.now, timezone: tzOffsetMinutes(ctx.now, ctx.tz) };
}

// -> { date, hasTime, ambiguousMeridiem, match: {index, text}, endDate } | null
export function findDate(text, ctx) {
  const results = chrono.parse(text, refFor(ctx), { forwardDate: true });
  const r = results[0];
  if (!r) return null;
  const s = r.start;
  const hasTime = s.isCertain('hour');
  const lower = r.text.toLowerCase();
  const p = { y: s.get('year'), mo: s.get('month'), d: s.get('day'), h: s.get('hour'), mi: s.get('minute') || 0 };
  if (!hasTime) {
    if (/morning/.test(lower)) Object.assign(p, { h: 9, mi: 0 });
    else if (/afternoon/.test(lower)) Object.assign(p, { h: 14, mi: 0 });
    else if (/evening/.test(lower)) Object.assign(p, { h: 18, mi: 0 });
    else if (/tonight|night/.test(lower)) Object.assign(p, { h: 20, mi: 0 });
  }
  const timeKnown = hasTime || /morning|afternoon|evening|night/.test(lower);
  let date = zonedToDate(p, ctx.tz);
  // "tonight"/"in 5 minutes" style results already carry an exact instant
  if (/^in\s/.test(lower) || /\bfrom now\b/.test(lower)) date = s.date();
  let endDate = null;
  if (r.end) {
    endDate = /^in\s/.test(lower)
      ? r.end.date()
      : zonedToDate({ y: r.end.get('year'), mo: r.end.get('month'), d: r.end.get('day'), h: r.end.get('hour'), mi: r.end.get('minute') || 0 }, ctx.tz);
  }
  const ambiguousMeridiem = hasTime && !s.isCertain('meridiem') && p.h >= 1 && p.h <= 11 && !/\b(am|pm|a\.m\.|p\.m\.)\b/i.test(r.text);
  return { date, hasTime: timeKnown, ambiguousMeridiem, hour: p.h, match: { index: r.index, text: r.text }, endDate };
}

const EXPLICIT_DAY = /\b(today|tomorrow|tonight|monday|tuesday|wednesday|thursday|friday|saturday|sunday|next|this|jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\b|\b\d{1,2}(?:st|nd|rd|th)\b|\b\d{1,2}[/-]\d{1,2}\b|\bin\s+\d/i;
const explicitDay = (text) => EXPLICIT_DAY.test(text);

function cutMatch(text, match) {
  return text.slice(0, match.index) + ' ' + text.slice(match.index + match.text.length);
}

function wallTimeOnDay(day, time, tz) {
  const d = wallParts(day, tz);
  const t = wallParts(time, tz);
  return zonedToDate({ y: d.y, mo: d.mo, d: d.d, h: t.h, mi: t.mi }, tz);
}

const DUR = /\bfor\s+(?:(\d+(?:\.\d+)?)|(an?|half an?|one|two|three))\s*(hours?|hrs?|h|minutes?|mins?|m)\b/i;
function takeDuration(text) {
  const m = DUR.exec(text);
  if (!m) return { text, minutes: null };
  const words = { a: 1, an: 1, one: 1, two: 2, three: 3, 'half a': 0.5, 'half an': 0.5 };
  const n = m[1] ? Number(m[1]) : words[m[2].toLowerCase()];
  const unit = /^h/i.test(m[3]) ? 60 : 1;
  return { text: text.replace(m[0], ' '), minutes: Math.round(n * unit) };
}

const EMAIL_G = /[^\s@,;]+@[^\s@,;]+\.[^\s@,;.]+/g;

// ---------- clause builders -------------------------------------------------

function buildTelegram(clause, plan, ctx) {
  let recipient = '';
  let body = '';
  let m;
  const SAYING = '(?:saying|that says|stating|to say|that|about|with the message|with|:)';
  if ((m = new RegExp(`^(?:please\\s+)?(?:send|shoot|drop|fire off)\\s+(?:a\\s+|the\\s+)?(?:telegram\\s+|tg\\s+)?(?:message|msg|text|note|dm)\\s+to\\s+(.+?)(?:\\s+(?:on|via|over)\\s+telegram)?(?:\\s+${SAYING}\\s*(.+)|\\s*:\\s*(.+))?$`, 'i').exec(clause))) {
    recipient = m[1];
    body = m[2] || m[3] || '';
  } else if ((m = new RegExp(`^(?:please\\s+)?(?:send|shoot|drop|fire off)\\s+(.+?)\\s+(?:a\\s+|an\\s+)?(?:telegram\\s+|tg\\s+)?(?:message|msg|text|note|dm)(?:\\s+(?:on|via|over)\\s+telegram)?(?:\\s+${SAYING}\\s*(.+)|\\s*:\\s*(.+))?$`, 'i').exec(clause))) {
    recipient = m[1];
    body = m[2] || m[3] || '';
  } else if ((m = new RegExp(`^(?:please\\s+)?(?:message|text|ping|dm|telegram)\\s+(.+?)(?:\\s+${SAYING}\\s*(.+)|\\s*:\\s*(.+))$`, 'i').exec(clause))) {
    recipient = m[1];
    body = m[2] || m[3] || '';
  } else if ((m = /^(?:please\s+)?(?:message|text|ping|dm|telegram)\s+(.+)$/i.exec(clause))) {
    // "message Bruce the experiment is postponed" or just "message Bruce"
    const split = splitRecipient(m[1]);
    recipient = split.recipient;
    body = split.rest;
  } else if ((m = /^(?:please\s+)?(?:tell|notify|let)\s+(.+)$/i.exec(clause))) {
    let rest = m[1];
    const know = /^(.+?)\s+know\s*(?:that\s+)?(.*)$/i.exec(rest);
    if (know && /^let\b/i.test(clause)) {
      recipient = know[1];
      body = know[2];
    } else {
      const split = splitRecipient(rest);
      recipient = split.recipient;
      body = split.rest.replace(/^that\s+/i, '');
    }
  }
  recipient = tidy(recipient).replace(/\s+(?:on|via)\s+telegram$/i, '');
  body = unquote(tidy(body));

  const ev = plan.lastEvent;
  // "about it" / "about the meeting" -> compose from the event scheduled earlier in this request
  if (ev && /^(?:about\s+)?(?:it|that|this|the (?:meeting|event|call|session|appointment)|the schedule)$/i.test(body)) {
    const title = ev.title;
    body = `${upFirst(title)} is set for ${fmtWhen(new Date(ev.start), ctx.tz, ctx.now)}.`;
    return { tool: 'telegram_send', args: { recipient, text: body }, dependsOn: [ev.index] };
  }
  if (/^about\s+/i.test(body)) {
    return { tool: 'telegram_send', args: { recipient, text: '' }, ask: `What should I tell ${recipient || 'them'} ${body}?` };
  }
  return { tool: 'telegram_send', args: { recipient, text: body ? sentence(body) : '' } };
}

// For "tell bruce the experiment ...": longest leading run of words that names a contact.
function splitRecipient(rest) {
  const w = rest.trim().split(/\s+/);
  for (let k = Math.min(3, w.length); k >= 1; k--) {
    const head = w.slice(0, k).join(' ');
    const r = resolveContact(head);
    if (r.contact || r.many) return { recipient: head, rest: w.slice(k).join(' ').replace(/^(?:to\s+)?/, '') };
  }
  return { recipient: w[0] || '', rest: w.slice(1).join(' ') };
}

function buildReminder(clause, plan, ctx) {
  let t = clause.replace(/^(?:please\s+)?remind\s+(?:me|us)?\s*/i, '').trim();

  // "30 minutes before it" -> relative to the event scheduled earlier in this request
  const rel = /\b(\d+(?:\.\d+)?|an?|half an?|one|two)\s*(hours?|hrs?|minutes?|mins?)\s+(?:before|prior to|ahead of)\s+(?:it|that|the (?:meeting|event|call|session|appointment)|then)\b/i.exec(t);
  if (rel) {
    const ev = plan.lastEvent;
    if (!ev) {
      return { tool: 'reminder_create', args: { text: '', at: null }, ask: 'Before what? There is no event in this request to count back from.' };
    }
    const n = /^\d/.test(rel[1]) ? Number(rel[1]) : { a: 1, an: 1, one: 1, two: 2, 'half a': 0.5, 'half an': 0.5 }[rel[1].toLowerCase()];
    const mins = Math.round(n * (/^h/i.test(rel[2]) ? 60 : 1));
    const at = new Date(new Date(ev.start).getTime() - mins * 60000);
    const label = mins % 60 === 0 && mins >= 60 ? `${mins / 60} hour${mins === 60 ? '' : 's'}` : `${mins} minutes`;
    return { tool: 'reminder_create', args: { text: `${upFirst(ev.title)} starts in ${label}`, at: toIsoOffset(at, ctx.tz) }, dependsOn: [ev.index] };
  }

  const found = findDate(t, ctx);
  let text = t;
  if (found) text = cutMatch(t, found.match);
  text = tidy(text).replace(/^(?:to|about|that|of)\s+/i, '').replace(/\s+(?:at|on|by|for|in)$/i, '');
  text = tidy(text);

  if (!found || !found.hasTime) {
    const day = found ? `${fmtWhen(found.date, ctx.tz, ctx.now).split(' at ')[0]}` : '';
    return {
      tool: 'reminder_create',
      args: { text, at: found ? toIsoOffset(found.date, ctx.tz) : null, dateOnly: Boolean(found) },
      ask: text ? `What time${day ? ` ${day}` : ''} should I remind you${text ? ` to ${text}` : ''}?` : 'What should I remind you about, and when?',
    };
  }
  if (found.ambiguousMeridiem) {
    return { tool: 'reminder_create', args: { text, at: toIsoOffset(found.date, ctx.tz), dayImplied: !explicitDay(found.match.text) }, ask: `Is that ${found.hour} AM or ${found.hour} PM?`, slot: 'meridiem' };
  }
  return { tool: 'reminder_create', args: { text, at: toIsoOffset(found.date, ctx.tz) } };
}

function buildEvent(clause, plan, ctx) {
  let t = clause;
  const emails = t.match(EMAIL_G) || [];
  for (const e of emails) t = t.replace(e, ' ');
  t = t.replace(/\b(?:and\s+)?invite\s+(?:him|her|them)?\s*/i, ' ').replace(/\bwith\s+(?=\s|$)/i, ' ');

  let description = '';
  const d = /\b(?:to discuss|regarding|agenda:?|description:?|notes?:?)\s+(.+)$/i.exec(t);
  if (d) {
    description = /^to discuss/i.test(d[0]) ? `Discuss ${tidy(d[1])}` : tidy(d[1]);
    t = t.slice(0, d.index);
  }
  let location = '';
  const l = /\b(?:location:?|venue:?)\s+(.+)$/i.exec(t);
  if (l) {
    location = tidy(l[1]);
    t = t.slice(0, l.index);
  }

  const dur = takeDuration(t);
  t = dur.text;
  const found = findDate(t, ctx);
  if (found) t = cutMatch(t, found.match);

  t = t
    .replace(/^(?:please\s+)?(?:schedule|book|arrange|set\s*up|add|create|put|block(?:\s+out)?|plan|organi[sz]e)\s+/i, '')
    .replace(/\b(?:on|to|in|into)\s+(?:my|the)\s+(?:google\s+)?calendar\b/gi, ' ')
    .replace(/\bcalendar\s+(?:event|entry)\s*(?:for|called|named)?\b/gi, ' ')
    .replace(/\b(?:an?\s+)?(?:event|entry)\s+(?:called|named|titled)\s+/i, ' ');
  let title = tidy(t).replace(/\s+(?:for|at|on|in|by|from|until|till|to|and)$/i, '');
  title = tidy(stripArticle(tidy(title)).replace(/^(?:for|about)\s+/i, ''));
  if (!title) title = 'Meeting';
  title = upFirst(title);

  const args = { title, description, location, attendees: emails };
  if (dur.minutes) args.durationMinutes = dur.minutes;
  if (!found) {
    return { tool: 'calendar_create', args: { ...args, start: null }, ask: `When should I schedule “${title}”?`, slot: 'time' };
  }
  if (!found.hasTime) {
    return {
      tool: 'calendar_create',
      args: { ...args, start: toIsoOffset(found.date, ctx.tz), dateOnly: true },
      ask: `What time on ${fmtWhen(found.date, ctx.tz, ctx.now).split(' at ')[0]} for “${title}”?`,
      slot: 'time',
    };
  }
  if (found.ambiguousMeridiem) {
    return { tool: 'calendar_create', args: { ...args, start: toIsoOffset(found.date, ctx.tz), dayImplied: !explicitDay(found.match.text) }, ask: `Is that ${found.hour} AM or ${found.hour} PM for “${title}”?`, slot: 'meridiem' };
  }
  args.start = toIsoOffset(found.date, ctx.tz);
  if (found.endDate && found.endDate > found.date) args.end = toIsoOffset(found.endDate, ctx.tz);
  return { tool: 'calendar_create', args };
}

function buildCalendarList(clause, plan, ctx) {
  const lower = clause.toLowerCase();
  const found = findDate(clause, ctx);
  let start;
  let end;
  let label = '';
  const now = ctx.now;
  if (/\b(this|next)\s+week\b/.test(lower)) {
    const weekStart = (() => {
      const base = startOfDay(now, ctx.tz);
      const dow = (wallParts(base, ctx.tz).weekday);
      const idx = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].indexOf(dow);
      return addDays(base, -idx, ctx.tz);
    })();
    const next = /\bnext\s+week\b/.test(lower);
    start = next ? addDays(weekStart, 7, ctx.tz) : startOfDay(now, ctx.tz);
    end = addDays(weekStart, next ? 14 : 7, ctx.tz);
    label = next ? 'next week' : 'the rest of this week';
  } else if (found) {
    start = startOfDay(found.date, ctx.tz);
    end = addDays(start, 1, ctx.tz);
    label = '';
    if (/\bafter\s+(?:noon|lunch)|afternoon/.test(lower)) start = zonedToDate({ ...pick(wallParts(start, ctx.tz)), h: 12 }, ctx.tz);
  } else if (/\btoday\b/.test(lower)) {
    start = startOfDay(now, ctx.tz);
    end = addDays(start, 1, ctx.tz);
    label = 'today';
  } else {
    start = now;
    end = addDays(startOfDay(now, ctx.tz), 7, ctx.tz);
    label = 'the next seven days';
  }
  return { tool: 'calendar_list', args: { start: toIsoOffset(start, ctx.tz), end: toIsoOffset(end, ctx.tz), label } };
}

const pick = (p) => ({ y: p.y, mo: p.mo, d: p.d });

function buildCalendarUpdate(clause, plan, ctx) {
  const rename = /^(?:please\s+)?rename\s+(.+?)\s+(?:to|as)\s+(.+)$/i.exec(clause);
  if (rename) {
    return { tool: 'calendar_update', args: { match: { title: tidy(stripArticle(rename[1])) }, changes: { title: upFirst(unquote(tidy(rename[2]))) } } };
  }
  const m = /^(?:please\s+)?(?:move|reschedule|push|postpone|shift|change)\s+(.+?)\s+(?:to|until|till|for|back to|forward to)\s+(.+)$/i.exec(clause);
  if (!m) {
    return { tool: 'calendar_update', args: { match: { title: '' }, changes: {} }, ask: 'Which event should I change, and to when?' };
  }
  let title = tidy(stripArticle(m[1]));
  let when = m[2];
  const srcDate = findDate(title, ctx);
  let matchDate = '';
  if (srcDate) {
    title = tidy(cutMatch(title, srcDate.match)).replace(/\s+(?:on|from|at)$/i, '');
    matchDate = toIsoOffset(srcDate.date, ctx.tz);
  }
  const found = findDate(when, ctx);
  if (!found) return { tool: 'calendar_update', args: { match: { title, date: matchDate }, changes: {} }, ask: `I couldn't read “${when}” as a time. When should “${title}” move to?` };
  const changes = {};
  const dateGiven = /\b(today|tomorrow|tonight|monday|tuesday|wednesday|thursday|friday|saturday|sunday|next|jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec|\d{1,2}(?:st|nd|rd|th)|\d{1,2}[/-]\d{1,2})/i.test(found.match.text);
  if (found.ambiguousMeridiem) {
    return { tool: 'calendar_update', args: { match: { title, date: matchDate }, changes: { start: toIsoOffset(found.date, ctx.tz) } }, ask: `Is that ${found.hour} AM or ${found.hour} PM?`, slot: 'meridiem' };
  }
  if (found.hasTime) {
    changes.start = toIsoOffset(found.date, ctx.tz);
    if (!dateGiven) changes.keepDate = true;
  } else {
    changes.start = toIsoOffset(found.date, ctx.tz);
    changes.keepTime = true;
  }
  return { tool: 'calendar_update', args: { match: { title, date: matchDate }, changes } };
}

function buildCalendarDelete(clause, plan, ctx) {
  let t = clause.replace(/^(?:please\s+)?(?:cancel|delete|remove|scrap|drop|clear)\s+/i, '');
  const found = findDate(t, ctx);
  let date = '';
  if (found) {
    t = cutMatch(t, found.match);
    date = toIsoOffset(found.date, ctx.tz);
  }
  t = tidy(t).replace(/\s+(?:on|for|at|from)$/i, '');
  t = tidy(stripArticle(t).replace(/^(?:event|entry)\s+(?:called|named)?\s*/i, ''));
  return { tool: 'calendar_delete', args: { match: { title: t, date } } };
}

function buildReminderList(clause, plan, ctx) {
  const lower = clause.toLowerCase();
  const found = findDate(clause, ctx);
  if (/\btoday\b|\bthis (?:morning|afternoon|evening)\b|\btonight\b/.test(lower)) return { tool: 'reminder_list', args: { scope: 'today' } };
  if (found && /\b(tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday|next)\b/.test(lower)) {
    return { tool: 'reminder_list', args: { scope: 'date', date: toIsoOffset(found.date, ctx.tz) } };
  }
  if (/\ball\b|\bevery\b/.test(lower)) return { tool: 'reminder_list', args: { scope: 'all' } };
  return { tool: 'reminder_list', args: { scope: 'upcoming' } };
}

function buildDriveSearch(clause) {
  let q = clause
    .replace(/^(?:please\s+)?(?:can you\s+)?(?:find|search(?:\s+for)?|look\s+for|locate|where(?:'s| is)|get me|pull up|fetch|show me|dig up|retrieve)\s+/i, '')
    .replace(/\b(?:in|from|on|inside)\s+(?:my|the)\s+(?:google\s+)?(?:drive|archive|stark archive|files?)\b/gi, ' ')
    .replace(/\b(?:in|from)\s+(?:drive|the archive)\b/gi, ' ')
    .replace(/\b(?:for me|please)\b/gi, ' ');
  q = tidy(q).replace(/^(?:the|my|a|an|any|all|file|files|document|documents|doc|docs)\s+/gi, '');
  q = tidy(q.replace(/^(?:the|my)\s+/i, '').replace(/\b(?:file|files|document|documents)\b$/i, ''));
  return { tool: 'drive_search', args: { query: q } };
}

function buildUpload(clause, plan, ctx) {
  let folder = '';
  let newFolder = '';
  let m;
  if ((m = /\b(?:in|into|to|under|inside)\s+(?:a\s+)?(?:new|fresh)\s+folder\s*(?:called|named|titled)?\s*["“]?(.+?)["”]?(?:\s+(?:in|inside|under)\s+(.+))?$/i.exec(clause))) {
    newFolder = tidy(m[1]);
    folder = tidy(m[2] || '');
  } else if ((m = /\b(?:create|make)\s+(?:a\s+)?(?:new\s+)?folder\s*(?:called|named|titled)?\s*["“]?(.+?)["”]?(?:\s+and\b.*)?$/i.exec(clause))) {
    newFolder = tidy(m[1]);
  } else if ((m = /\b(?:in|into|to|under|inside)\s+(?:my\s+|the\s+)?["“]?(.+?)["”]?\s+(?:folder|directory)\b/i.exec(clause))) {
    folder = tidy(m[1]);
  } else if ((m = /\bfolder\s*(?:called|named)?\s*["“]?([^"”]+?)["”]?\s*$/i.exec(clause))) {
    folder = tidy(m[1]);
  }
  folder = folder.replace(/^(?:my|the)\s+/i, '');
  if (/^(?:my\s+)?drive$|^root$/i.test(folder)) folder = '';
  return { tool: 'drive_upload', args: { folder, newFolder } };
}

// ---------- classification --------------------------------------------------

const CAL_NOUN = '(?:meeting|call|event|appointment|lunch|dinner|breakfast|sync|review|session|briefing|demo|interview|standup|stand-up|conference|test|launch|check-in|catch-?up|workshop|fitting|flight|trip)';

function classify(c) {
  const l = c.toLowerCase().trim();
  if (/^(?:please\s+)?(?:forget it|never ?mind|cancel that|scratch that|stand down|abort)\b/.test(l)) return 'dismiss';
  if (/\bremind(?:er)?s?\b/.test(l)) {
    if (/^(?:please\s+)?remind\s+(?:me|us)\b|^(?:please\s+)?set\s+(?:a\s+)?reminder|^(?:please\s+)?add\s+(?:a\s+)?reminder|^(?:please\s+)?create\s+(?:a\s+)?reminder/.test(l)) {
      return 'reminder_create';
    }
    if (/^(?:please\s+)?(?:mark|complete|finish|tick off|check off)\b/.test(l)) return 'reminder_complete';
    if (/^(?:please\s+)?(?:delete|remove|clear|dismiss|cancel|forget)\b/.test(l)) return 'reminder_delete';
    if (/\b(?:what|which|show|list|any|do i have|check|view|open|see|tell me|how many)\b/.test(l)) return 'reminder_list';
    return 'reminder_create';
  }
  if (/^(?:please\s+)?(?:send|shoot|drop|fire off)\b.*\b(?:message|msg|text|note|dm|telegram|tg)\b/.test(l) || /^(?:please\s+)?(?:message|text|ping|dm|telegram|notify)\s+\S/.test(l) || /^(?:please\s+)?tell\s+\S+\s+\S/.test(l) || /^(?:please\s+)?let\s+\S+.*\bknow\b/.test(l)) {
    if (!/^(?:please\s+)?tell me\b/.test(l)) return 'telegram_send';
  }
  if (/\b(?:message|comms?|communications?|telegram)\b.*\b(?:history|log|recent|sent)\b|^(?:show|open|view)\s+(?:my\s+)?(?:messages|comms|communications|message log)/.test(l) || /\bwhat (?:messages|did you send)\b/.test(l)) return 'comms_history';
  if (/^(?:please\s+)?(?:upload|save|store|archive|file|put|add)\b.*\b(?:drive|archive|folder|document|file|doc|report|pdf|attachment|this|it)\b/.test(l) && /\b(?:upload|drive|archive|folder|file|store)\b/.test(l) && !/\b(?:calendar|reminder|event)\b/.test(l)) return 'drive_upload';
  if (/^(?:please\s+)?(?:upload)\b/.test(l)) return 'drive_upload';
  if (/^(?:please\s+)?(?:create|make|add|new)\s+(?:a\s+)?(?:new\s+)?folder\b/.test(l)) return 'drive_create_folder';
  if (/^(?:please\s+)?(?:open|show|browse|list|go to)\b.*\b(?:folder|drive|archive|files)\b/.test(l) && !/\b(?:find|search)\b/.test(l)) return 'drive_list';
  if (/^(?:please\s+)?(?:can you\s+)?(?:find|search|look for|locate|dig up|retrieve|pull up|fetch|get me)\b|^(?:where(?:'s| is))\b/.test(l)) return 'drive_search';
  if (/^(?:please\s+)?(?:move|reschedule|push|postpone|shift|change|rename)\b/.test(l) && !/\bfolder|file|document\b/.test(l)) return 'calendar_update';
  if (/^(?:please\s+)?(?:cancel|delete|remove|scrap|drop|clear)\b/.test(l)) return 'calendar_delete';
  if (/^(?:please\s+)?(?:schedule|book|arrange|set\s*up|setup|block(?:\s+out)?|organi[sz]e|plan)\b/.test(l)) return 'calendar_create';
  if (/^(?:please\s+)?(?:add|put|create|make)\b/.test(l) && (new RegExp(`\\b${CAL_NOUN}\\b|\\bcalendar\\b|\\bevent\\b`).test(l))) return 'calendar_create';
  if (/\b(?:what|what's|whats|show|list|do i have|have i got|am i|anything|check|view|open|tell me|how(?:'s| is)|any)\b/.test(l) && /\b(?:schedule|scheduled|calendar|agenda|meetings?|events?|plans?|busy|free|on|diary|day|appointments?|today|tomorrow)\b/.test(l)) return 'calendar_list';
  if (/^(?:hi|hello|hey|yo|good (?:morning|afternoon|evening|night)|jarvis|are you there|you there|status|help|what can you do|who are you|thanks|thank you|cheers)\b/.test(l) || /\bwhat can you do\b|\bhelp me\b/.test(l)) return 'chat';
  return 'unknown';
}

const HELP = [
  'I can run your day from here, sir:',
  '  Calendar · “schedule a meeting with Bruce tomorrow at 4 PM”, “what do I have tomorrow?”, “move the Avengers sync to Friday at 3”',
  '  Reminders · “remind me to check the reactor at 8 PM”, “what reminders do I have today?”',
  '  Archive · “find the reactor design report”, or “upload this document to my Drive” (attach a file with the paperclip)',
  '  Comms · “send Bruce a message saying the experiment is postponed”',
  'Chain them in one go and I will run them in order.',
].join('\n');

function chatReply(clause) {
  const l = clause.toLowerCase();
  if (/thank|cheers/.test(l)) return 'Always, sir.';
  if (/help|what can you do|who are you/.test(l)) return HELP;
  if (/status/.test(l)) return 'All systems report below. Anything marked offline will say why.';
  if (/good (morning|afternoon|evening|night)/.test(l)) return `${upFirst(l.match(/good (morning|afternoon|evening|night)/)[0])}, sir. What do you need?`;
  return 'At your disposal, sir.';
}

const BUILDERS = {
  telegram_send: buildTelegram,
  reminder_create: buildReminder,
  calendar_create: buildEvent,
  calendar_list: buildCalendarList,
  calendar_update: buildCalendarUpdate,
  calendar_delete: buildCalendarDelete,
  reminder_list: buildReminderList,
  drive_search: buildDriveSearch,
  drive_upload: buildUpload,
  drive_create_folder: (c) => {
    const m = /folder\s*(?:called|named|titled)?\s*["“]?(.+?)["”]?(?:\s+(?:in|inside|under)\s+(?:my\s+|the\s+)?(.+?))?$/i.exec(c);
    return { tool: 'drive_create_folder', args: { name: tidy(m?.[1] || ''), parent: tidy(m?.[2] || '') } };
  },
  drive_list: (c) => {
    const m = /\b(?:open|show|browse|list|go to)\s+(?:my\s+|the\s+)?(.+?)\s+folder\b/i.exec(c);
    return { tool: 'drive_list', args: { folder: m ? tidy(m[1]) : '' } };
  },
  comms_history: () => ({ tool: 'comms_history', args: {} }),
  reminder_complete: (c) => {
    const m = /\b(?:mark|complete|finish|tick off|check off)\s+(?:my\s+|the\s+)?(?:reminder\s+(?:to|about|for)?\s*)?(.+?)(?:\s+reminder)?(?:\s+(?:as\s+)?(?:done|complete[d]?|finished))?$/i.exec(c);
    return { tool: 'reminder_complete', args: { match: { text: tidy(m?.[1] || '').replace(/^(?:to|about)\s+/i, '') } } };
  },
  reminder_delete: (c) => {
    const m = /\b(?:delete|remove|clear|dismiss|cancel|forget)\s+(?:my\s+|the\s+)?(?:reminder\s+(?:to|about|for)?\s*)?(.+?)(?:\s+reminder)?$/i.exec(c);
    return { tool: 'reminder_delete', args: { match: { text: tidy(m?.[1] || '').replace(/^(?:to|about)\s+/i, '') } } };
  },
};

// Pull out quoted spans so a message body containing "and send" survives splitting.
function maskQuotes(text) {
  const spans = [];
  const masked = text.replace(/["“][^"”]+["”]/g, (m) => {
    spans.push(m);
    return `\u0000${spans.length - 1}\u0000`;
  });
  return { masked, restore: (s) => s.replace(/\u0000(\d+)\u0000/g, (_, i) => spans[+i]) };
}

export function splitClauses(text) {
  const { masked, restore } = maskQuotes(text);
  return masked.split(SPLIT).map((s) => restore(tidy(s))).filter(Boolean);
}

const CANCEL_WORDS = /^(?:no|nope|cancel|never ?mind|forget it|skip it|stop|leave it)\b/i;
const NEW_COMMAND = new RegExp(`^(?:jarvis[,\\s]+)?(?:please\\s+)?(?:schedule|remind|send|message|upload|find|search|what|whats|show|cancel|delete|remove|move|reschedule|create|book|tell|ping|list|mark|open|let me|let)\\b`, 'i');

// Fill the slot Tony was asked about. Returns an updated pending, or null if this is a fresh command.
function applyAnswer(text, pending, ctx) {
  if (NEW_COMMAND.test(text) && !(pending.slot === 'folder' && /^(?:create)/i.test(text))) return null;
  const steps = JSON.parse(JSON.stringify(pending.steps));
  const step = steps[pending.index];
  const answer = unquote(tidy(text));
  const a = step.args;
  const slot = pending.slot;

  if (slot === 'recipient') a.recipient = answer.replace(/^(?:to\s+)?/i, '');
  else if (slot === 'text') a.text = sentence(answer);
  else if (slot === 'query') a.query = answer;
  else if (slot === 'title') {
    if (step.tool === 'reminder_create') a.text = answer;
    else a.title = upFirst(answer);
  } else if (slot === 'folder') {
    if (/^(?:yes|yep|yeah|sure|please do|do it|go ahead|create(?: it)?|make it|okay|ok)\b/i.test(answer)) {
      a.newFolder = a.folder;
      a.folder = '';
    } else a.folder = answer.replace(/^(?:use|into|in|to)\s+/i, '');
  } else if (slot === 'meridiem') {
    const pm = /\bp\.?m\.?\b|\bevening|night|afternoon\b|^pm$/i.test(answer);
    const am = /\ba\.?m\.?\b|morning\b|^am$/i.test(answer);
    if (!pm && !am) return { retry: true, message: 'AM or PM, sir?' };
    delete a.dateOnly;
    const field = step.tool === 'reminder_create' ? 'at' : 'start';
    const key = step.tool === 'calendar_update' ? 'changes' : null;
    const holder = key ? a[key] : a;
    const cur = new Date(new Date(holder[field]).getTime());
    const w = wallParts(cur, ctx.tz);
    let h = w.h;
    if (pm && h < 12) h += 12;
    if (am && h >= 12) h -= 12;
    let when = zonedToDate({ y: w.y, mo: w.mo, d: w.d, h, mi: w.mi }, ctx.tz);
    if (a.dayImplied) {
      // "at 7" was rolled to tomorrow because 7 AM had passed; 7 PM may still be tonight
      const t = wallParts(ctx.now, ctx.tz);
      const tonight = zonedToDate({ y: t.y, mo: t.mo, d: t.d, h, mi: w.mi }, ctx.tz);
      if (tonight > ctx.now) when = tonight;
    }
    delete a.dayImplied;
    holder[field] = toIsoOffset(when, ctx.tz);
  } else if (slot === 'time') {
    const f = findDate(answer, ctx) || (/^\d{1,2}(?::\d{2})?\s*(?:am|pm|a\.m\.|p\.m\.)?$/i.test(answer) ? findDate(`at ${answer}`, ctx) : null);
    if (!f) return { retry: true, message: "I still can't read that as a time. Try something like “5 PM” or “Friday at 3”." };
    const field = step.tool === 'reminder_create' ? 'at' : 'start';
    const prior = a[field] ? new Date(a[field]) : null;
    let when = f.date;
    // "5 PM" answering "what time tomorrow?" keeps the day we already had
    if (prior && a.dateOnly && f.hasTime && !/\b(today|tomorrow|tonight|monday|tuesday|wednesday|thursday|friday|saturday|sunday|next|\d{1,2}(?:st|nd|rd|th))\b/i.test(answer)) {
      when = wallTimeOnDay(prior, f.date, ctx.tz);
    }
    a[field] = toIsoOffset(when, ctx.tz);
    if (!f.hasTime) {
      a.dateOnly = true;
      return { steps, index: pending.index, slot: 'time', question: `What time ${fmtWhen(when, ctx.tz, ctx.now).split(' at ')[0]}?` };
    }
    if (f.ambiguousMeridiem) {
      delete a.dateOnly;
      a.dayImplied = !explicitDay(answer) && !prior;
      return { steps, index: pending.index, slot: 'meridiem', question: `Is that ${f.hour} AM or ${f.hour} PM?` };
    }
    delete a.dateOnly;
  } else {
    return null;
  }
  return { steps, index: pending.index };
}

// Which slot is missing from this raw step? Used to build `pending`.
export function slotFor(step, err) {
  if (err?.pending?.slot) return err.pending.slot;
  const a = step.args || {};
  switch (step.tool) {
    case 'telegram_send':
      if (!a.recipient || /contact|Which/.test(err?.message || '')) return 'recipient';
      return 'text';
    case 'calendar_create':
      return a.title || a.start ? 'time' : 'title';
    case 'reminder_create':
      return a.text ? 'time' : 'title';
    case 'drive_search':
      return 'query';
    case 'drive_upload':
      return 'folder';
    default:
      return null;
  }
}

export function planWithRules(rawText, ctx) {
  let text = tidy(rawText)
    .replace(/^(?:hey\s+|ok(?:ay)?\s+)?jarvis[,:!\s]+/i, '')
    .replace(/^(?:could|can|would) you (?:please\s+)?/i, '')
    .replace(/^i(?:'d| would) like you to\s+/i, '')
    .replace(/^i need you to\s+/i, '')
    .replace(/^i want you to\s+/i, '')
    .replace(/^please\s+/i, '')
    .replace(/\s*(?:please|thanks|thank you)[.!]*$/i, '');
  text = text.replace(/[?!]+$/, '');

  // Answering a question from the previous turn?
  if (ctx.pending?.steps) {
    if (CANCEL_WORDS.test(text) && text.length < 24) return { reply: 'Understood, sir. Standing down on that one.', steps: [], cleared: true };
    const filled = applyAnswer(text, ctx.pending, ctx);
    if (filled?.retry) return { clarify: filled.message, steps: [], pending: ctx.pending };
    if (filled?.question) return { clarify: filled.question, steps: [], pending: { ...ctx.pending, steps: filled.steps, index: filled.index, slot: filled.slot } };
    if (filled) {
      return { steps: filled.steps.map(({ tool, args, dependsOn }) => ({ tool, args: stripInternal(args), dependsOn })), resumed: true };
    }
  }

  const clauses = splitClauses(text);
  const plan = { steps: [], lastEvent: null };
  const replies = [];

  for (const clause of clauses) {
    const intent = classify(clause);
    if (intent === 'dismiss') return { reply: 'Understood, sir.', steps: [], cleared: true };
    if (intent === 'chat') {
      replies.push(chatReply(clause));
      continue;
    }
    if (intent === 'unknown') {
      if (clauses.length === 1) {
        return {
          reply: `I'm not sure what to do with that, sir. I handle the calendar, reminders, the Archive and Telegram. Try “schedule a meeting with Bruce tomorrow at 4 PM”, or ask me what I can do.`,
          steps: [],
        };
      }
      replies.push(`I skipped “${clause}”. I couldn't tell what it asked for.`);
      continue;
    }
    const built = BUILDERS[intent](clause, plan, ctx);
    const index = plan.steps.length;
    plan.steps.push(built);
    if (built.tool === 'calendar_create' && built.args.start && !built.ask) {
      plan.lastEvent = { index, title: built.args.title, start: built.args.start };
    }
    // an event with a known title but unresolved time can still anchor "remind me before it" later
  }

  if (!plan.steps.length) return { reply: replies.join('\n') || 'At your disposal, sir.', steps: [] };

  const asks = plan.steps.findIndex((s) => s.ask);
  const steps = plan.steps.map(({ tool, args, dependsOn }) => ({ tool, args: stripInternal(args), dependsOn }));
  const out = { steps, notes: replies };
  if (asks >= 0) {
    out.askAt = asks;
    out.askText = plan.steps[asks].ask;
    out.slot = plan.steps[asks].slot || slotFor(plan.steps[asks]);
    out.rawSteps = plan.steps.map(({ tool, args, dependsOn }) => ({ tool, args, dependsOn }));
  }
  if (steps.length > 1) out.reply = `On it, sir. ${steps.length} actions, in order.`;
  return out;
}

// args kept `dateOnly` only to remember that a time was still owed
function stripInternal(args) {
  const { dateOnly, dayImplied, ...rest } = args;
  return rest;
}

