import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const BLANK = {
  ANTHROPIC_API_KEY: '', ANTHROPIC_MODEL: '', GOOGLE_CLIENT_ID: '', GOOGLE_CLIENT_SECRET: '',
  TELEGRAM_BOT_TOKEN: '', TELEGRAM_CONTACTS: '', JARVIS_DEMO: '',
};

export async function startServer(env = {}, { seed } = {}) {
  const port = 21000 + Math.floor(Math.random() * 20000);
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-test-'));
  if (seed) fs.writeFileSync(path.join(dataDir, 'jarvis.json'), JSON.stringify(seed));
  const child = spawn(process.execPath, ['server/index.js'], {
    cwd: root,
    env: { ...process.env, ...BLANK, PORT: String(port), HOST: '127.0.0.1', DATA_DIR: dataDir, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  child.stdout.on('data', (d) => { log += d; });
  child.stderr.on('data', (d) => { log += d; });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 60; i++) {
    try {
      if ((await fetch(`${base}/healthz`)).ok) break;
    } catch { /* not up yet */ }
    await sleep(100);
    if (i === 59) {
      child.kill('SIGKILL');
      throw new Error(`server did not start:\n${log}`);
    }
  }

  const call = async (p, { method = 'GET', body, headers } = {}) => {
    const res = await fetch(`${base}/api${p}`, {
      method,
      headers: body && !(body instanceof FormData) ? { 'Content-Type': 'application/json', ...headers } : headers,
      body: body ? (body instanceof FormData ? body : JSON.stringify(body)) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    return { status: res.status, data };
  };
  const job = async (id) => (await call('/state?tz=UTC')).data.jobs.find((j) => j.id === id);

  const waitJob = async (id, pred, ms = 15000) => {
    const t0 = Date.now();
    for (;;) {
      const j = await job(id);
      if (j && pred(j)) return j;
      if (Date.now() - t0 > ms) throw new Error(`timed out waiting on job ${id}; last state: ${JSON.stringify(j && { state: j.state, steps: j.steps.map((s) => s.status) })}\n${log}`);
      await sleep(40);
    }
  };
  const DONE = new Set(['done', 'failed', 'partial', 'cancelled', 'needs_input']);
  const settled = (j) => DONE.has(j.state);

  const command = async (text, opts = {}) => {
    const { data } = await call('/commands', { method: 'POST', body: { text, tz: 'UTC', ...opts } });
    return data;
  };
  // run a command; approve any confirmation along the way
  const run = async (text, { approve = true, ...opts } = {}) => {
    const j = await command(text, opts);
    for (;;) {
      const cur = await waitJob(j.id, (x) => settled(x) || x.state === 'awaiting_confirm');
      if (cur.state === 'awaiting_confirm') {
        await call(`/jobs/${j.id}/confirm`, { method: 'POST', body: { approve } });
        await sleep(30);
        continue;
      }
      return cur;
    }
  };
  const stage = async (name, content, type = 'text/plain') => {
    const fd = new FormData();
    fd.append('file', new Blob([content], { type }), name);
    return (await call('/attachments', { method: 'POST', body: fd })).data;
  };

  return {
    base, call, command, run, job, waitJob, settled, stage, log: () => log,
    stop: () => new Promise((r) => { child.once('exit', r); child.kill('SIGTERM'); }).then(() => fs.rmSync(dataDir, { recursive: true, force: true })),
  };
}

export function mockServer(handler) {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    let body = '';
    for await (const c of req) body += c;
    const rec = { method: req.method, url: req.url, headers: req.headers, body: body ? JSON.parse(body) : null };
    requests.push(rec);
    const out = await handler(rec);
    res.writeHead(out.status || 200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(out.json ?? {}));
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({
    url: `http://127.0.0.1:${server.address().port}`,
    requests,
    close: () => new Promise((r) => server.close(r)),
  })));
}
