import fs from 'node:fs';
import crypto from 'node:crypto';
import { OAuth2Client } from 'google-auth-library';
import { calendar as calendarApi } from '@googleapis/calendar';
import { drive as driveApi } from '@googleapis/drive';
import { config } from '../config.js';
import { store } from '../store.js';
import { JarvisError } from '../errors.js';
import { FOLDER_MIME, kindOf, resolveFolder } from './shared.js';
import { ymd, addDays, startOfDay, zonedToDate } from '../time.js';

const SCOPES = [
  'openid',
  'email',
  'https://www.googleapis.com/auth/calendar',
  'https://www.googleapis.com/auth/drive',
];

// Shared OAuth session behind both Calendar and Drive.
export class GoogleAccount {
  constructor() {
    this.oauth = null;
    this.pendingStates = new Map();
    this.lastError = null;
  }

  get configured() {
    return Boolean(config.google.clientId && config.google.clientSecret);
  }

  get tokens() {
    return store.data.google?.tokens || null;
  }

  state() {
    if (!this.configured) {
      return { state: 'unconfigured', detail: 'GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET not set' };
    }
    const g = store.data.google;
    if (!g?.tokens) return { state: 'disconnected', detail: 'Google account not connected' };
    if (g.status === 'expired') {
      return { state: 'expired', detail: 'Authorisation expired. Reconnect to continue', account: g.email };
    }
    if (this.lastError) return { state: 'degraded', detail: this.lastError, account: g.email };
    return { state: 'online', detail: g.email || 'connected', account: g.email };
  }

  client() {
    if (!this.configured) {
      throw new JarvisError('NOT_CONFIGURED', 'Google credentials are not configured on this server.', {
        integration: 'google',
        hint: 'Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET, then restart.',
      });
    }
    if (!this.tokens) {
      throw new JarvisError('NOT_CONNECTED', 'Your Google account is not connected.', {
        integration: 'google',
        hint: 'Connect it from the Systems panel.',
      });
    }
    if (store.data.google.status === 'expired') {
      throw new JarvisError('AUTH_EXPIRED', 'Google authorisation has expired. Reconnect your account to continue.', {
        integration: 'google',
      });
    }
    if (!this.oauth) {
      this.oauth = new OAuth2Client(config.google.clientId, config.google.clientSecret, config.google.redirectUri);
      this.oauth.on('tokens', (t) => {
        const g = store.data.google;
        if (!g) return;
        g.tokens = { ...g.tokens, ...t };
        store.save();
      });
    }
    this.oauth.setCredentials(this.tokens);
    return this.oauth;
  }

  authUrl() {
    if (!this.configured) {
      throw new JarvisError('NOT_CONFIGURED', 'Google credentials are not configured on this server.', { integration: 'google' });
    }
    const oauth = new OAuth2Client(config.google.clientId, config.google.clientSecret, config.google.redirectUri);
    const state = crypto.randomBytes(16).toString('hex');
    this.pendingStates.set(state, Date.now());
    for (const [k, t] of this.pendingStates) if (Date.now() - t > 10 * 60 * 1000) this.pendingStates.delete(k);
    return oauth.generateAuthUrl({
      access_type: 'offline',
      prompt: 'consent',
      scope: SCOPES,
      state,
      include_granted_scopes: true,
    });
  }

  async handleCallback(code, state) {
    if (!this.pendingStates.delete(state)) {
      throw new JarvisError('AUTH_STATE', 'Sign-in session was not recognised. Start the connection again.', { integration: 'google' });
    }
    const oauth = new OAuth2Client(config.google.clientId, config.google.clientSecret, config.google.redirectUri);
    const { tokens } = await oauth.getToken(code);
    let email = null;
    try {
      if (tokens.id_token) {
        const ticket = await oauth.verifyIdToken({ idToken: tokens.id_token, audience: config.google.clientId });
        email = ticket.getPayload().email;
      }
    } catch {
      // email is cosmetic
    }
    const previous = store.data.google?.tokens;
    store.data.google = {
      tokens: { ...previous, ...tokens },
      email,
      status: 'ok',
      connectedAt: new Date().toISOString(),
    };
    this.oauth = null;
    this.lastError = null;
    store.save();
  }

  async revoke() {
    const t = this.tokens;
    store.data.google = null;
    this.oauth = null;
    store.save();
    if (t?.access_token) {
      try {
        await new OAuth2Client().revokeToken(t.access_token);
      } catch {
        // local disconnect already done
      }
    }
  }

  // Run a Google call and translate whatever comes back into a JarvisError.
  async call(integration, fn) {
    const auth = this.client();
    try {
      const out = await fn(auth);
      this.lastError = null;
      return out;
    } catch (err) {
      throw this.translate(err, integration);
    }
  }

  translate(err, integration) {
    if (err instanceof JarvisError) return err;
    const status = err.code && Number.isInteger(err.code) ? err.code : err.response?.status;
    const msg = String(err.response?.data?.error_description || err.response?.data?.error?.message || err.message || '');
    const reason = err.response?.data?.error?.errors?.[0]?.reason || err.errors?.[0]?.reason || '';
    const label = integration === 'calendar' ? 'Google Calendar' : 'Google Drive';
    console.warn(`google ${integration}: ${status || err.code || 'error'} ${msg}`.slice(0, 300));

    if (/invalid_grant|invalid_token|unauthorized_client|Token has been expired or revoked/i.test(msg) || status === 401) {
      if (store.data.google) store.data.google.status = 'expired';
      store.save();
      return new JarvisError('AUTH_EXPIRED', `${label} rejected the saved authorisation. Reconnect your Google account.`, { integration, cause: err });
    }
    if (status === 403 && /insufficient/i.test(msg + reason)) {
      return new JarvisError('AUTH_SCOPE', `${label} access was not granted. Reconnect and approve all requested permissions.`, { integration, cause: err });
    }
    if (status === 403 && /accessNotConfigured|has not been used|is disabled/i.test(msg + reason)) {
      return new JarvisError('API_DISABLED', `The ${label} API is not enabled for this Google Cloud project.`, {
        integration,
        hint: 'Enable it in the Cloud Console under APIs & Services.',
        cause: err,
      });
    }
    if (status === 429 || /rateLimit|quota/i.test(reason)) {
      return new JarvisError('RATE_LIMIT', `${label} is rate-limiting requests. Try again in a minute.`, { integration, cause: err });
    }
    if (status === 404) return new JarvisError('NOT_FOUND', `${label} could not find that item.`, { integration, cause: err });
    if (/ENOTFOUND|ECONNRESET|ETIMEDOUT|EAI_AGAIN|ECONNREFUSED|fetch failed|socket hang up/i.test(`${err.code} ${msg}`)) {
      this.lastError = 'network unreachable';
      return new JarvisError('NETWORK', `Could not reach ${label}. Check the connection and try again.`, { integration, cause: err });
    }
    return new JarvisError('API', `${label} returned an error: ${msg || 'unknown'}`, { integration, cause: err });
  }
}

const dayStart = (str, tz) => {
  const [y, mo, d] = str.split('-').map(Number);
  return zonedToDate({ y, mo, d }, tz);
};

const normEvent = (e, tz) => {
  const allDay = Boolean(e.start?.date && !e.start?.dateTime);
  const start = allDay ? e.start.date : e.start.dateTime;
  const end = allDay ? e.end?.date : e.end?.dateTime;
  const instant = (v) => (allDay ? dayStart(v, tz) : new Date(v)).toISOString();
  return {
    id: e.id,
    title: e.summary || '(untitled)',
    start: instant(start),
    end: end ? instant(end) : null,
    startDate: allDay ? start : null,
    allDay,
    description: e.description || '',
    location: e.location || '',
    attendees: (e.attendees || []).map((a) => a.email),
    link: e.htmlLink || null,
  };
};

export class GoogleCalendar {
  constructor(account) {
    this.account = account;
  }

  status() {
    return this.account.state();
  }

  api(auth) {
    return calendarApi({ version: 'v3', auth, rootUrl: config.google.apiRoot });
  }

  async probe() {
    return this.account.call('calendar', (auth) => this.api(auth).calendarList.list({ maxResults: 1 }));
  }

  async list({ from, to, tz }) {
    return this.account.call('calendar', async (auth) => {
      const res = await this.api(auth).events.list({
        calendarId: 'primary',
        timeMin: from.toISOString(),
        timeMax: to.toISOString(),
        singleEvents: true,
        orderBy: 'startTime',
        maxResults: 250,
      });
      return (res.data.items || []).filter((e) => e.status !== 'cancelled').map((e) => normEvent(e, tz));
    });
  }

  async create({ title, start, end, allDay, description, location, attendees, tz }) {
    return this.account.call('calendar', async (auth) => {
      const body = { summary: title, description, location };
      if (allDay) {
        body.start = { date: ymd(start, tz) };
        body.end = { date: ymd(end && end > start ? end : addDays(startOfDay(start, tz), 1, tz), tz) };
      } else {
        body.start = { dateTime: start.toISOString(), timeZone: tz };
        body.end = { dateTime: end.toISOString(), timeZone: tz };
      }
      if (attendees?.length) body.attendees = attendees.map((email) => ({ email }));
      const res = await this.api(auth).events.insert({
        calendarId: 'primary',
        requestBody: body,
        sendUpdates: attendees?.length ? 'all' : 'none',
      });
      return normEvent(res.data, tz);
    });
  }

  async update(id, patch, tz) {
    return this.account.call('calendar', async (auth) => {
      const body = {};
      if (patch.title) body.summary = patch.title;
      if (patch.description !== undefined) body.description = patch.description;
      if (patch.location !== undefined) body.location = patch.location;
      if (patch.start) body.start = { dateTime: patch.start.toISOString(), timeZone: tz };
      if (patch.end) body.end = { dateTime: patch.end.toISOString(), timeZone: tz };
      const res = await this.api(auth).events.patch({ calendarId: 'primary', eventId: id, requestBody: body, sendUpdates: 'all' });
      return normEvent(res.data, tz);
    });
  }

  async remove(id) {
    return this.account.call('calendar', async (auth) => {
      await this.api(auth).events.delete({ calendarId: 'primary', eventId: id, sendUpdates: 'all' });
    });
  }
}

const FILE_FIELDS = 'id,name,mimeType,modifiedTime,size,parents,webViewLink';
const esc = (s) => String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'");

export class GoogleDrive {
  constructor(account) {
    this.account = account;
    this.nameCache = new Map();
    this.rootId = null;
  }

  status() {
    return this.account.state();
  }

  api(auth) {
    return driveApi({ version: 'v3', auth, rootUrl: config.google.apiRoot });
  }

  async root(api) {
    if (!this.rootId) {
      const res = await api.files.get({ fileId: 'root', fields: 'id' });
      this.rootId = res.data.id;
      this.nameCache.set(this.rootId, { name: 'My Drive', parents: [] });
    }
    return this.rootId;
  }

  // Walk parents up to the root and print "My Drive / Research / Reactor".
  async pathOf(api, parentId, depth = 0) {
    const rootId = await this.root(api);
    if (!parentId) return 'My Drive';
    if (parentId === rootId) return 'My Drive';
    let entry = this.nameCache.get(parentId);
    if (!entry) {
      try {
        const res = await api.files.get({ fileId: parentId, fields: 'id,name,parents' });
        entry = { name: res.data.name, parents: res.data.parents || [] };
        this.nameCache.set(parentId, entry);
      } catch {
        return 'Shared / Unknown';
      }
    }
    if (depth > 8 || !entry.parents.length) return `Shared / ${entry.name}`;
    return `${await this.pathOf(api, entry.parents[0], depth + 1)} / ${entry.name}`;
  }

  async shape(api, f) {
    const parent = f.parents?.[0];
    return {
      id: f.id,
      name: f.name,
      mimeType: f.mimeType,
      kind: kindOf(f.mimeType, f.name),
      modifiedTime: f.modifiedTime,
      size: f.size ? Number(f.size) : null,
      folderId: parent || null,
      folderPath: await this.pathOf(api, parent),
      link: f.webViewLink || `https://drive.google.com/open?id=${f.id}`,
    };
  }

  async listFolder(folderId = 'root') {
    return this.account.call('drive', async (auth) => {
      const api = this.api(auth);
      const rootId = await this.root(api);
      const id = folderId === 'root' ? rootId : folderId;
      const res = await api.files.list({
        q: `'${esc(id)}' in parents and trashed=false`,
        fields: `files(${FILE_FIELDS})`,
        orderBy: 'folder,name',
        pageSize: 200,
      });
      const items = [];
      for (const f of res.data.files || []) items.push(await this.shape(api, f));
      const crumbs = [];
      let cur = id;
      for (let i = 0; i < 8 && cur && cur !== rootId; i++) {
        let entry = this.nameCache.get(cur);
        if (!entry) {
          const r = await api.files.get({ fileId: cur, fields: 'id,name,parents' });
          entry = { name: r.data.name, parents: r.data.parents || [] };
          this.nameCache.set(cur, entry);
        }
        crumbs.unshift({ id: cur, name: entry.name });
        cur = entry.parents[0];
      }
      crumbs.unshift({ id: rootId, name: 'My Drive' });
      return { folderId: id, breadcrumbs: crumbs, items };
    });
  }

  async folders() {
    return this.account.call('drive', async (auth) => {
      const api = this.api(auth);
      const rootId = await this.root(api);
      const all = [];
      let pageToken;
      do {
        const res = await api.files.list({
          q: `mimeType='${FOLDER_MIME}' and trashed=false`,
          fields: 'nextPageToken,files(id,name,parents)',
          pageSize: 500,
          pageToken,
        });
        all.push(...(res.data.files || []));
        pageToken = res.data.nextPageToken;
      } while (pageToken && all.length < 2000);
      const byId = new Map(all.map((f) => [f.id, f]));
      for (const f of all) this.nameCache.set(f.id, { name: f.name, parents: f.parents || [] });
      const pathFor = (f, depth = 0) => {
        const p = f.parents?.[0];
        if (!p || p === rootId) return `My Drive / ${f.name}`;
        const parent = byId.get(p);
        if (!parent || depth > 8) return `Shared / ${f.name}`;
        return `${pathFor(parent, depth + 1)} / ${f.name}`;
      };
      return all
        .map((f) => ({ id: f.id, name: f.name, parentId: f.parents?.[0] || null, path: pathFor(f) }))
        .sort((a, b) => a.path.localeCompare(b.path));
    });
  }

  async findFolder(spec) {
    if (!String(spec || '').trim()) return resolveFolder([], '');
    return resolveFolder(await this.folders(), spec);
  }

  async createFolder(name, parentId = 'root') {
    return this.account.call('drive', async (auth) => {
      const api = this.api(auth);
      const rootId = await this.root(api);
      const res = await api.files.create({
        requestBody: { name, mimeType: FOLDER_MIME, parents: [parentId === 'root' ? rootId : parentId] },
        fields: 'id,name,parents',
      });
      this.nameCache.set(res.data.id, { name: res.data.name, parents: res.data.parents || [] });
      return { id: res.data.id, name: res.data.name, path: `${await this.pathOf(api, res.data.parents?.[0])} / ${res.data.name}` };
    });
  }

  async search(query) {
    const tokens = String(query)
      .toLowerCase()
      .split(/[^a-z0-9._-]+/i)
      .filter((t) => t.length > 1);
    if (!tokens.length) return { files: [], mode: 'name', tokens };
    return this.account.call('drive', async (auth) => {
      const api = this.api(auth);
      const run = async (q) => {
        const res = await api.files.list({
          q: `${q} and trashed=false and mimeType != '${FOLDER_MIME}'`,
          fields: `files(${FILE_FIELDS})`,
          orderBy: 'modifiedTime desc',
          pageSize: 25,
        });
        return res.data.files || [];
      };
      const nameAll = tokens.map((t) => `name contains '${esc(t)}'`).join(' and ');
      let files = await run(nameAll);
      let mode = 'name';
      if (!files.length) {
        files = await run(tokens.map((t) => `fullText contains '${esc(t)}'`).join(' and '));
        mode = 'content';
      }
      if (!files.length && tokens.length > 1) {
        files = await run(tokens.map((t) => `name contains '${esc(t)}'`).join(' or '));
        mode = 'partial';
      }
      const out = [];
      for (const f of files) out.push(await this.shape(api, f));
      return { files: out, mode, tokens };
    });
  }

  async upload({ filePath, name, mimeType, folderId = 'root', onProgress }) {
    return this.account.call('drive', async (auth) => {
      const api = this.api(auth);
      const rootId = await this.root(api);
      const total = fs.statSync(filePath).size;
      const res = await api.files.create(
        {
          requestBody: { name, parents: [folderId === 'root' ? rootId : folderId] },
          media: { mimeType: mimeType || 'application/octet-stream', body: fs.createReadStream(filePath) },
          fields: FILE_FIELDS,
        },
        {
          rootUrl: config.google.apiRoot, // media uploads read this from per-call options
          onUploadProgress: (evt) => onProgress?.(Math.min(evt.bytesRead ?? 0, total), total),
        },
      );
      onProgress?.(total, total);
      return this.shape(api, res.data);
    });
  }
}
