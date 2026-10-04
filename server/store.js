import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from './config.js';

export const uid = (prefix = '') => prefix + crypto.randomBytes(5).toString('hex');

const DEFAULTS = () => ({
  settings: { timezone: null, confirmConsequential: true },
  reminders: [],
  jobs: [],
  actions: [],
  messages: [],
  contacts: [],
  telegram: { offset: 0, discovered: [] },
  google: null,
});

const MAX = { jobs: 150, actions: 500, messages: 300 };

class Store {
  constructor({ persist, file }) {
    this.persist = persist;
    this.file = file;
    this.data = DEFAULTS();
    this.timer = null;
  }

  load() {
    if (!this.persist) return;
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      this.data = { ...DEFAULTS(), ...raw, settings: { ...DEFAULTS().settings, ...raw.settings } };
    } catch (err) {
      if (err.code !== 'ENOENT') console.warn(`store: could not read ${this.file}: ${err.message}`);
    }
  }

  save() {
    if (!this.persist) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), 150);
  }

  flush() {
    if (!this.persist) return;
    clearTimeout(this.timer);
    this.timer = null;
    const tmp = `${this.file}.${process.pid}.tmp`;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), { mode: 0o600 });
      fs.renameSync(tmp, this.file);
    } catch (err) {
      console.error(`store: write failed: ${err.message}`);
    }
  }

  push(list, item) {
    const arr = this.data[list];
    arr.push(item);
    if (MAX[list] && arr.length > MAX[list]) arr.splice(0, arr.length - MAX[list]);
    this.save();
    return item;
  }
}

export const store = new Store({
  persist: !config.demo,
  file: path.join(config.dataDir, 'jarvis.json'),
});
store.load();

process.on('exit', () => store.flush());
