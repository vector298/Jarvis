// Simulated back-ends, enabled only with JARVIS_DEMO=1. Same interface as the
// real adapters so the rest of the app can't tell the difference.
import fs from 'node:fs';
import crypto from 'node:crypto';
import { JarvisError } from '../errors.js';
import { FOLDER_MIME, kindOf, resolveFolder } from './shared.js';
import { zonedToDate, wallParts, addDays, startOfDay, ymd } from '../time.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const lag = (min = 350, max = 800) => sleep(min + Math.random() * (max - min));
const id = () => crypto.randomBytes(8).toString('hex');

const faults = new Map();
export const demoFaults = {
  set(integration, code, times = 1) {
    faults.set(integration, { code, left: times });
  },
  clear() {
    faults.clear();
  },
  take(integration) {
    const key = faults.has(integration) ? integration : '*';
    const fault = faults.get(key);
    if (!fault) return;
    if (--fault.left <= 0) faults.delete(key);
    const { code } = fault;
    const msg = {
      NETWORK: `Could not reach ${integration[0].toUpperCase() + integration.slice(1)}. Check the connection and try again.`,
      AUTH_EXPIRED: `${integration} rejected the saved authorisation. Reconnect to continue.`,
      API: `${integration} returned an error: backend unavailable.`,
    }[code] || `${integration} failed (${code}).`;
    throw new JarvisError(code, msg, { integration });
  },
};

export class DemoCalendar {
  constructor() {
    this.events = null;
    this.online = true;
  }

  status() {
    return { state: 'online', detail: 'simulated calendar', account: 'stark@simulation' };
  }

  async probe() {}

  seed(tz) {
    if (this.events) return;
    const now = new Date();
    const at = (dayOffset, h, mi = 0, durMin = 60) => {
      const p = wallParts(addDays(now, dayOffset, tz), tz);
      const start = zonedToDate({ y: p.y, mo: p.mo, d: p.d, h, mi }, tz);
      return { start: start.toISOString(), end: new Date(start.getTime() + durMin * 60000).toISOString() };
    };
    const mk = (title, when, extra = {}) => ({
      id: id(), title, ...when, allDay: false, startDate: null, description: '', location: '', attendees: [], link: null, ...extra,
    });
    this.events = [
      mk('Wayne Enterprises call', at(0, 15, 30, 30), { description: 'Licensing terms for the Mark 50 nanotech.' }),
      mk('Reactor calorimetry review', at(1, 10, 0, 90), { location: 'Lab 3, Malibu' }),
      mk('Board prep with Pepper', at(1, 14, 0, 60), { attendees: ['pepper@starkindustries.example'] }),
      mk('Suit diagnostics', at(2, 9, 30, 45)),
      mk('Avengers sync', at(3, 18, 0, 60), { location: 'Tower, level 80' }),
      mk('Lunch with Rhodey', at(4, 12, 30, 90)),
      mk('Shareholder dinner', at(6, 19, 30, 120)),
    ];
    const d = startOfDay(addDays(now, 5, tz), tz);
    this.events.push(mk('Stark Expo set-up', { start: d.toISOString(), end: addDays(d, 1, tz).toISOString() }, { allDay: true, startDate: ymd(d, tz) }));
  }

  async list({ from, to, tz }) {
    this.seed(tz);
    await lag();
    demoFaults.take('calendar');
    return this.events
      .filter((e) => new Date(e.end || e.start) > from && new Date(e.start) < to)
      .sort((a, b) => a.start.localeCompare(b.start))
      .map((e) => ({ ...e }));
  }

  async create({ title, start, end, allDay, description, location, attendees, tz }) {
    this.seed(tz);
    await lag(500, 1000);
    demoFaults.take('calendar');
    const ev = {
      id: id(),
      title,
      start: start.toISOString(),
      end: (end || new Date(start.getTime() + 3600000)).toISOString(),
      allDay: Boolean(allDay),
      startDate: allDay ? ymd(start, tz) : null,
      description: description || '',
      location: location || '',
      attendees: attendees || [],
      link: null,
    };
    this.events.push(ev);
    return { ...ev };
  }

  async update(eventId, patch, tz) {
    this.seed(tz);
    await lag();
    demoFaults.take('calendar');
    const ev = this.events.find((e) => e.id === eventId);
    if (!ev) throw new JarvisError('NOT_FOUND', 'That event no longer exists.', { integration: 'calendar' });
    if (patch.title) ev.title = patch.title;
    if (patch.start) ev.start = patch.start.toISOString();
    if (patch.end) ev.end = patch.end.toISOString();
    if (patch.description !== undefined) ev.description = patch.description;
    if (patch.location !== undefined) ev.location = patch.location;
    return { ...ev };
  }

  async remove(eventId) {
    await lag();
    demoFaults.take('calendar');
    const i = this.events.findIndex((e) => e.id === eventId);
    if (i < 0) throw new JarvisError('NOT_FOUND', 'That event no longer exists.', { integration: 'calendar' });
    this.events.splice(i, 1);
  }
}

export class DemoDrive {
  constructor() {
    const ago = (d) => new Date(Date.now() - d * 86400000).toISOString();
    this.nodes = new Map();
    const folder = (name, parent) => {
      const n = { id: id(), name, mimeType: FOLDER_MIME, parents: [parent], modifiedTime: ago(2), size: null };
      this.nodes.set(n.id, n);
      return n.id;
    };
    const file = (name, mimeType, parent, days, size) => {
      const n = { id: id(), name, mimeType, parents: [parent], modifiedTime: ago(days), size };
      this.nodes.set(n.id, n);
    };
    this.rootId = 'root';
    const research = folder('Research', 'root');
    const reactor = folder('Arc Reactor', research);
    const suits = folder('Suit Archive', 'root');
    const mk50 = folder('Mark 50', suits);
    const finance = folder('Board & Finance', 'root');
    folder('Schematics', 'root');
    file('Reactor Design Report v3.pdf', 'application/pdf', reactor, 3, 4_820_113);
    file('Palladium Core - Decay Analysis.pdf', 'application/pdf', reactor, 41, 2_104_552);
    file('Reactor test log - September.txt', 'text/plain', reactor, 9, 18_204);
    file('Nanotech housing notes', 'application/vnd.google-apps.document', research, 6, null);
    file('Mark 50 - Weight Distribution.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', mk50, 12, 88_031);
    file('Mark 50 - Armour Plating.step', 'application/step', mk50, 15, 31_220_990);
    file('Gauntlet Actuator Spec.pdf', 'application/pdf', suits, 20, 1_320_409);
    file('Q3 Board Deck.pptx', 'application/vnd.openxmlformats-officedocument.presentationml.presentation', finance, 1, 12_330_221);
    file('Licensing Terms - Wayne Enterprises.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', finance, 4, 61_920);
    file('Workshop floor plan.png', 'image/png', 'root', 80, 940_201);
    file('To do.txt', 'text/plain', 'root', 1, 412);
  }

  status() {
    return { state: 'online', detail: 'simulated drive', account: 'stark@simulation' };
  }

  pathOf(parentId) {
    if (!parentId || parentId === 'root') return 'My Drive';
    const n = this.nodes.get(parentId);
    return n ? `${this.pathOf(n.parents[0])} / ${n.name}` : 'My Drive';
  }

  shape(n) {
    return {
      id: n.id,
      name: n.name,
      mimeType: n.mimeType,
      kind: kindOf(n.mimeType, n.name),
      modifiedTime: n.modifiedTime,
      size: n.size,
      folderId: n.parents[0],
      folderPath: this.pathOf(n.parents[0]),
      link: `https://drive.google.com/open?id=${n.id}`,
    };
  }

  async listFolder(folderId = 'root') {
    await lag();
    demoFaults.take('drive');
    const items = [...this.nodes.values()].filter((n) => n.parents[0] === folderId);
    items.sort((a, b) => (b.mimeType === FOLDER_MIME) - (a.mimeType === FOLDER_MIME) || a.name.localeCompare(b.name));
    const crumbs = [];
    let cur = folderId;
    while (cur && cur !== 'root') {
      const n = this.nodes.get(cur);
      if (!n) break;
      crumbs.unshift({ id: n.id, name: n.name });
      cur = n.parents[0];
    }
    crumbs.unshift({ id: 'root', name: 'My Drive' });
    return { folderId, breadcrumbs: crumbs, items: items.map((n) => this.shape(n)) };
  }

  async folders() {
    await lag(150, 300);
    demoFaults.take('drive');
    return [...this.nodes.values()]
      .filter((n) => n.mimeType === FOLDER_MIME)
      .map((n) => ({ id: n.id, name: n.name, parentId: n.parents[0], path: `${this.pathOf(n.parents[0])} / ${n.name}` }))
      .sort((a, b) => a.path.localeCompare(b.path));
  }

  async findFolder(spec) {
    return resolveFolder(await this.folders(), spec);
  }

  async createFolder(name, parentId = 'root') {
    await lag();
    demoFaults.take('drive');
    const n = { id: id(), name, mimeType: FOLDER_MIME, parents: [parentId], modifiedTime: new Date().toISOString(), size: null };
    this.nodes.set(n.id, n);
    return { id: n.id, name, path: `${this.pathOf(parentId)} / ${name}` };
  }

  async search(query) {
    await lag();
    demoFaults.take('drive');
    const tokens = String(query).toLowerCase().split(/[^a-z0-9._-]+/i).filter((t) => t.length > 1);
    const files = [...this.nodes.values()].filter((n) => n.mimeType !== FOLDER_MIME);
    const hay = (n) => `${n.name} ${this.pathOf(n.parents[0])}`.toLowerCase();
    let hits = files.filter((n) => tokens.every((t) => n.name.toLowerCase().includes(t)));
    let mode = 'name';
    if (!hits.length && tokens.length > 1) {
      hits = files.filter((n) => tokens.some((t) => hay(n).includes(t)));
      mode = 'partial';
    }
    hits.sort((a, b) => b.modifiedTime.localeCompare(a.modifiedTime));
    return { files: hits.slice(0, 25).map((n) => this.shape(n)), mode, tokens };
  }

  async upload({ filePath, name, mimeType, folderId = 'root', onProgress }) {
    demoFaults.take('drive');
    const total = fs.statSync(filePath).size || 1;
    const steps = 12;
    for (let i = 1; i <= steps; i++) {
      await sleep(110);
      onProgress?.(Math.round((total * i) / steps), total);
    }
    const n = { id: id(), name, mimeType: mimeType || 'application/octet-stream', parents: [folderId], modifiedTime: new Date().toISOString(), size: total };
    this.nodes.set(n.id, n);
    return this.shape(n);
  }
}

export class DemoTelegram {
  constructor() {
    this.configured = true;
    this.known = new Set(['1001', '1002', '-1003', '1004']);
  }

  status() {
    return { state: 'online', detail: 'simulated bot', account: 'jarvis_sim_bot' };
  }

  async probe() {
    return { username: 'jarvis_sim_bot' };
  }

  async send(chatId) {
    await lag(500, 1100);
    demoFaults.take('telegram');
    if (!this.known.has(String(chatId))) {
      throw new JarvisError('CHAT_NOT_FOUND', 'Telegram could not find that chat. The recipient must open the bot and press Start first, or the chat id is wrong.', { integration: 'telegram' });
    }
    return { messageId: Math.floor(Math.random() * 9000) + 1000, chatTitle: null };
  }

  async discover() {
    await lag(300, 600);
    return [
      { id: 'd_demo1', chatId: '1004', name: 'Happy Hogan', username: 'hhogan', type: 'private', lastSeen: new Date(Date.now() - 3600000).toISOString() },
    ];
  }
}

export const DEMO_CONTACTS = [
  { id: 'c_bruce', name: 'Bruce Banner', aliases: ['bruce', 'banner', 'dr banner'], chatId: '1001' },
  { id: 'c_pepper', name: 'Pepper Potts', aliases: ['pepper'], chatId: '1002' },
  { id: 'c_team', name: 'Stark Team', aliases: ['the team', 'team', 'stark team'], chatId: '-1003' },
];
