// Wall-clock helpers. Everything is stored as UTC instants; the timezone only
// matters when reading a time Tony typed or when printing one back to him.

export function isValidTz(tz) {
  if (!tz || typeof tz !== 'string') return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

const dtfCache = new Map();
function dtf(tz) {
  let f = dtfCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      weekday: 'short',
    });
    dtfCache.set(tz, f);
  }
  return f;
}

export function wallParts(date, tz) {
  const out = {};
  for (const p of dtf(tz).formatToParts(date)) out[p.type] = p.value;
  return {
    y: +out.year,
    mo: +out.month,
    d: +out.day,
    h: +out.hour,
    mi: +out.minute,
    s: +out.second,
    weekday: out.weekday,
  };
}

export function tzOffsetMinutes(date, tz) {
  const p = wallParts(date, tz);
  const asUtc = Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.s);
  const real = Math.floor(date.getTime() / 1000) * 1000;
  return Math.round((asUtc - real) / 60000);
}

export function zonedToDate({ y, mo, d, h = 0, mi = 0, s = 0 }, tz) {
  const guess = Date.UTC(y, mo - 1, d, h, mi, s);
  let off = tzOffsetMinutes(new Date(guess), tz);
  let t = guess - off * 60000;
  const off2 = tzOffsetMinutes(new Date(t), tz);
  if (off2 !== off) t = guess - off2 * 60000;
  return new Date(t);
}

export function startOfDay(date, tz) {
  const p = wallParts(date, tz);
  return zonedToDate({ y: p.y, mo: p.mo, d: p.d }, tz);
}

export function addDays(date, n, tz) {
  const p = wallParts(date, tz);
  return zonedToDate({ y: p.y, mo: p.mo, d: p.d + n, h: p.h, mi: p.mi }, tz);
}

export function endOfDay(date, tz) {
  return addDays(startOfDay(date, tz), 1, tz);
}

export function sameDay(a, b, tz) {
  const pa = wallParts(a, tz);
  const pb = wallParts(b, tz);
  return pa.y === pb.y && pa.mo === pb.mo && pa.d === pb.d;
}

export function dayDiff(a, b, tz) {
  const pa = wallParts(a, tz);
  const pb = wallParts(b, tz);
  return Math.round((Date.UTC(pa.y, pa.mo - 1, pa.d) - Date.UTC(pb.y, pb.mo - 1, pb.d)) / 86400000);
}

const ISO_WALL = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?$/;

// Accepts a full ISO string with offset/Z, or a bare wall-clock string read in `tz`.
export function parseWhen(value, tz) {
  if (value instanceof Date) return value;
  if (typeof value !== 'string') return null;
  const s = value.trim();
  const m = ISO_WALL.exec(s);
  if (m) {
    return zonedToDate({ y: +m[1], mo: +m[2], d: +m[3], h: +(m[4] || 0), mi: +(m[5] || 0), s: +(m[6] || 0) }, tz);
  }
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function toIsoOffset(date, tz) {
  const p = wallParts(date, tz);
  const off = tzOffsetMinutes(date, tz);
  const sign = off < 0 ? '-' : '+';
  const abs = Math.abs(off);
  const pad = (n) => String(n).padStart(2, '0');
  return `${p.y}-${pad(p.mo)}-${pad(p.d)}T${pad(p.h)}:${pad(p.mi)}:${pad(p.s)}${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

export function ymd(date, tz) {
  const p = wallParts(date, tz);
  return `${p.y}-${String(p.mo).padStart(2, '0')}-${String(p.d).padStart(2, '0')}`;
}

export function fmtTime(date, tz) {
  return new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit' }).format(date);
}

export function fmtDay(date, tz, now = new Date()) {
  const diff = dayDiff(date, now, tz);
  if (diff === 0) return 'today';
  if (diff === 1) return 'tomorrow';
  if (diff === -1) return 'yesterday';
  const opts = diff > 0 && diff < 7
    ? { weekday: 'long' }
    : { weekday: 'short', day: 'numeric', month: 'short' };
  return new Intl.DateTimeFormat('en-GB', { timeZone: tz, ...opts }).format(date);
}

export function fmtWhen(date, tz, now = new Date()) {
  return `${fmtDay(date, tz, now)} at ${fmtTime(date, tz)}`;
}

export function fmtLongDate(date, tz) {
  return new Intl.DateTimeFormat('en-GB', { timeZone: tz, weekday: 'long', day: 'numeric', month: 'long' }).format(date);
}
