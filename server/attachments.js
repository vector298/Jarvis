import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import multer from 'multer';
import { config } from './config.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-stage-'));
const staged = new Map();
const TTL = 60 * 60 * 1000;

const fixName = (n) => {
  // multer reports multipart names as latin1
  try {
    return Buffer.from(n, 'latin1').toString('utf8');
  } catch {
    return n;
  }
};

export const uploader = multer({
  storage: multer.diskStorage({
    destination: dir,
    filename: (_req, _file, cb) => cb(null, crypto.randomBytes(8).toString('hex')),
  }),
  limits: { fileSize: config.maxUploadBytes, files: 1 },
});

export function register(file) {
  const id = `f_${crypto.randomBytes(5).toString('hex')}`;
  const entry = {
    id,
    name: fixName(file.originalname).replace(/[\\/\0]/g, '_').slice(0, 255) || 'untitled',
    size: file.size,
    mime: file.mimetype,
    path: file.path,
    createdAt: Date.now(),
  };
  staged.set(id, entry);
  return entry;
}

export const get = (id) => staged.get(id) || null;
export const publicView = (a) => ({ id: a.id, name: a.name, size: a.size, mime: a.mime });

export function drop(id) {
  const a = staged.get(id);
  if (!a) return;
  staged.delete(id);
  fs.rm(a.path, { force: true }, () => {});
}

setInterval(() => {
  for (const a of staged.values()) if (Date.now() - a.createdAt > TTL) drop(a.id);
}, 5 * 60 * 1000).unref();

process.on('exit', () => fs.rmSync(dir, { recursive: true, force: true }));
