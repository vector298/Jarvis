import { h, icon, api, S, on, fmt, toast, save, clear, bytes } from './util.js';
import { jobBody, userLine } from './job.js';

const SUGGESTIONS = [
  'Schedule a meeting with Bruce tomorrow at 4 PM',
  'Remind me to check the Mark 50 at 7 PM',
  'What do I have scheduled for tomorrow?',
  'Find the reactor design report',
  'Send Bruce a message saying the experiment is postponed',
  'Schedule the Stark team meeting tomorrow at 6 PM, remind me 30 minutes before it, and message Bruce about it',
];

const nodes = new Map();
let transcript;
let queueEl;
let input;
let sendBtn;
let attachSlot;
let suggestEl;
let bannerEl;
let headInfo;
let staged = null; // { id, name, size, pct, state }
const recall = [];
let recallIx = -1;

function greeting() {
  const hr = Number(new Intl.DateTimeFormat('en-US', { timeZone: S.tz, hour: 'numeric', hourCycle: 'h23' }).format(new Date()));
  const part = hr < 5 ? 'Good evening' : hr < 12 ? 'Good morning' : hr < 18 ? 'Good afternoon' : 'Good evening';
  const down = S.systems ? Object.entries({ Calendar: S.systems.calendar, Archive: S.systems.drive, Comms: S.systems.telegram }).filter(([, v]) => v && v.state !== 'online') : [];
  const lines = [`${part}, sir. Systems are up and I am at your disposal.`];
  for (const [name, v] of down) lines.push(`${name} link is offline: ${v.detail}.`);
  return lines.join('\n');
}

function nearBottom() {
  return transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight < 90;
}
function toBottom(force) {
  requestAnimationFrame(() => { if (force) transcript.scrollTo({ top: transcript.scrollHeight }); });
}

function turn(cls, name, time, ...body) {
  return h('div.turn', { class: cls },
    h('div.who', h('div.name', name), time ? h('div.time', time) : null),
    h('div.content', body),
  );
}

export function renderJob(job) {
  const stick = nearBottom();
  let wrap = nodes.get(job.id);
  if (!wrap) {
    wrap = h('div.jobwrap', { data: { id: job.id } });
    nodes.set(job.id, wrap);
    transcript.append(wrap);
  }
  const consoleOrigin = job.origin === 'console';
  const body = jobBody(job);
  wrap.replaceChildren(
    turn('user', consoleOrigin ? 'CONSOLE' : 'TONY', fmt.hm(job.createdAt), ...userLine(job)),
    turn('jarvis', 'JARVIS', job.finishedAt ? fmt.hm(job.finishedAt) : '', ...body),
  );
  suggestEl.hidden = nodes.size > 0;
  if (stick) toBottom(true);
  renderQueue();
}

function renderQueue() {
  const { running, queued } = S.queue;
  clear(queueEl);
  const items = [];
  if (running && S.jobs.get(running)) items.push({ job: S.jobs.get(running), run: true });
  queued.forEach((id, i) => S.jobs.get(id) && items.push({ job: S.jobs.get(id), pos: i + 1 }));
  queueEl.hidden = items.length === 0;
  headInfo.textContent = items.length ? `${running ? '1 executing' : ''}${running && queued.length ? ' · ' : ''}${queued.length ? `${queued.length} waiting` : ''}` : 'Queue idle';
  if (!items.length) return;
  queueEl.append(h('div.queue-head',
    h('span.label', 'Execution queue'),
    h('span.grow', { style: 'flex:1' }),
    queued.length > 1 ? h('button.btn.sm', { on: { click: () => api('/queue/clear', { method: 'POST' }).catch((e) => toast(e.message, 'err')) } }, 'Clear waiting') : null,
  ));
  for (const it of items) {
    const j = it.job;
    const state = it.run ? (j.state === 'awaiting_confirm' ? 'Awaiting you' : j.cancelRequested ? 'Stopping' : j.state === 'planning' ? 'Parsing' : 'Executing') : 'Waiting';
    queueEl.append(h('div.qitem', { class: it.run ? 'run' : 'wait' },
      h('span.pos', it.run ? '▶' : String(it.pos)),
      h('span.txt', j.text),
      h('span.state', state),
      h('button.iconbtn.sm', { 'aria-label': 'Cancel', title: it.run ? 'Stop after the current step' : 'Remove from queue', on: { click: () => api(`/jobs/${j.id}/cancel`, { method: 'POST' }) } }, icon('x', 12)),
    ));
  }
}

export function upsertJob(job) {
  const prev = S.jobs.get(job.id);
  if (prev && (prev.rev || 0) > (job.rev || 0)) return;
  S.jobs.set(job.id, job);
  renderJob(job);
}

function setStaged(next) {
  staged = next;
  clear(attachSlot);
  if (!staged) return;
  attachSlot.append(h('div.attach-chip',
    icon('clip', 14),
    h('span.nm', staged.name),
    h('span.mono.dim', bytes(staged.size)),
    staged.state === 'uploading' ? h('div.track', h('div.fill', { style: `width:${staged.pct}%` })) : null,
    staged.state === 'error' ? h('span', { style: 'color:var(--red)' }, staged.error) : null,
    h('button.iconbtn.sm', { 'aria-label': 'Remove attachment', on: { click: () => { if (staged?.id) api(`/attachments/${staged.id}`, { method: 'DELETE' }).catch(() => {}); setStaged(null); } } }, icon('x', 12)),
  ));
}

// Receives the file on the JARVIS server first; shared with the Archive pane.
export function stageWithProgress(file, onProgress) {
  return new Promise((resolve, reject) => {
    const fd = new FormData();
    fd.append('file', file);
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/attachments');
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(Math.round((e.loaded / e.total) * 100));
    xhr.onload = () => {
      let data = {};
      try { data = JSON.parse(xhr.responseText); } catch { /* handled below */ }
      if (xhr.status >= 200 && xhr.status < 300) resolve(data);
      else reject(new Error(data?.error?.message || (xhr.status === 413 ? 'That file is larger than this server accepts.' : `Transfer failed (${xhr.status}).`)));
    };
    xhr.onerror = () => reject(new Error('Connection to JARVIS dropped during the transfer.'));
    xhr.send(fd);
  });
}

async function attach(file) {
  if (!file) return;
  setStaged({ name: file.name, size: file.size, pct: 0, state: 'uploading' });
  try {
    const a = await stageWithProgress(file, (pct) => { staged.pct = pct; setStaged({ ...staged }); });
    setStaged({ ...a, pct: 100, state: 'ready' });
    input.focus();
  } catch (err) {
    setStaged({ name: file.name, size: file.size, state: 'error', error: err.message });
  }
}

async function submit() {
  const text = input.value.trim();
  if (!text) return;
  if (staged?.state === 'uploading') return toast('Still receiving the attachment. One moment.');
  const attachmentIds = staged?.state === 'ready' ? [staged.id] : [];
  input.value = '';
  autosize();
  recall.unshift(text);
  recall.length = Math.min(recall.length, 30);
  recallIx = -1;
  try {
    const job = await api('/commands', { method: 'POST', body: { text, mode: S.mode, tz: S.tz, attachmentIds } });
    if (attachmentIds.length) setStaged(null);
    upsertJob(job);
    toBottom(true);
  } catch (err) {
    input.value = text;
    toast(err.message, 'err');
  }
}

function autosize() {
  input.style.height = 'auto';
  input.style.height = `${Math.min(input.scrollHeight, 120)}px`;
}

function modeSeg() {
  const hintEl = h('span.hint');
  const seg = h('div.seg', { role: 'group', 'aria-label': 'When a command arrives while another is running' });
  const draw = () => {
    seg.classList.toggle('interrupt', S.mode === 'interrupt');
    clear(seg).append(
      h('button', { type: 'button', 'aria-pressed': String(S.mode === 'queue'), title: 'New commands wait their turn', on: { click: () => set('queue') } }, 'Queue'),
      h('button', { type: 'button', 'aria-pressed': String(S.mode === 'interrupt'), title: 'New commands stop the current one after its current step and run first', on: { click: () => set('interrupt') } }, 'Interrupt'),
    );
    hintEl.textContent = S.mode === 'queue' ? 'New orders wait for the current one to finish.' : 'New orders stop the current one after its step, then run.';
  };
  const set = (m) => { S.mode = m; save('jarvis.mode', m); draw(); };
  draw();
  return { seg, hintEl };
}

function startVoice(btn) {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) { btn.hidden = true; return; }
  let rec = null;
  btn.addEventListener('click', () => {
    if (rec) { rec.stop(); return; }
    rec = new SR();
    rec.lang = navigator.language || 'en-US';
    rec.interimResults = true;
    rec.onresult = (e) => {
      input.value = [...e.results].map((r) => r[0].transcript).join('');
      autosize();
    };
    rec.onend = () => { rec = null; btn.style.color = ''; input.focus(); };
    rec.onerror = (e) => { if (e.error !== 'aborted' && e.error !== 'no-speech') toast(`Voice input: ${e.error}`, 'err'); };
    btn.style.color = 'var(--red)';
    rec.start();
  });
}

export function mountConsole(root) {
  headInfo = h('span.mono.faint', 'Queue idle');
  transcript = h('div.transcript', { role: 'log', 'aria-live': 'polite', 'aria-label': 'Conversation' });
  queueEl = h('div.queue', { hidden: true });
  bannerEl = h('div#due', { style: 'display:grid;gap:6px;padding-top:8px' });
  attachSlot = h('div');
  suggestEl = h('div.suggest', SUGGESTIONS.slice(0, 4).map((s) => h('button', { type: 'button', on: { click: () => { input.value = s; autosize(); input.focus(); } } }, s.length > 44 ? `${s.slice(0, 42)}…` : s)));
  input = h('textarea', { rows: '1', placeholder: 'Give JARVIS an order…', 'aria-label': 'Command', spellcheck: 'true', autocomplete: 'off' });
  sendBtn = h('button.btn.primary.go', { type: 'button', 'aria-label': 'Execute', on: { click: submit } }, h('span.t', 'Execute'), icon('send', 13));
  const fileInput = h('input', { type: 'file', hidden: true, on: { change: (e) => { attach(e.target.files[0]); e.target.value = ''; } } });
  const clip = h('button.iconbtn', { type: 'button', 'aria-label': 'Attach a document', title: 'Attach a document (for Drive uploads)', on: { click: () => fileInput.click() } }, icon('clip', 17));
  const mic = h('button.iconbtn', { type: 'button', 'aria-label': 'Dictate', title: 'Dictate' }, icon('mic', 17));
  startVoice(mic);
  const { seg, hintEl } = modeSeg();

  input.addEventListener('input', autosize);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); submit(); }
    else if (e.key === 'ArrowUp' && !input.value && recall.length) { e.preventDefault(); recallIx = Math.min(recallIx + 1, recall.length - 1); input.value = recall[recallIx]; autosize(); }
    else if (e.key === 'ArrowDown' && recallIx >= 0) { e.preventDefault(); recallIx -= 1; input.value = recallIx >= 0 ? recall[recallIx] : ''; autosize(); }
    else if (e.key === 'Escape' && S.queue.running) { api(`/jobs/${S.queue.running}/cancel`, { method: 'POST' }); }
  });

  root.addEventListener('dragover', (e) => { if (e.dataTransfer?.types?.includes('Files')) e.preventDefault(); });
  root.addEventListener('drop', (e) => { if (e.dataTransfer?.files?.length) { e.preventDefault(); attach(e.dataTransfer.files[0]); } });

  root.append(
    h('div.panel-head', h('span.title', 'Console'), h('span', { style: 'flex:1' }), headInfo),
    bannerEl,
    transcript,
    queueEl,
    h('div.composer',
      suggestEl,
      attachSlot,
      h('div.field', h('span.prompt', '›'), input, clip, mic, sendBtn),
      h('div.composer-foot', seg, hintEl, h('span.mono.faint', { title: 'Esc stops the running command' }, 'esc · stop')),
      fileInput,
    ),
  );

  on('queue', renderQueue);
  on('jobs-loaded', (jobs) => {
    for (const j of jobs) upsertJob(j);
    if (!jobs.length) {
      transcript.append(turn('jarvis', 'JARVIS', fmt.hm(new Date()), h('div.say', greeting())));
    } else {
      transcript.prepend(turn('jarvis', 'JARVIS', '', h('div.say.muted', 'Welcome back, sir. Earlier orders are below.')));
    }
    toBottom(true);
    renderQueue();
  });
  on('stage-file', attach);
  return { input };
}

// Due-reminder banners live on the console so they can't be missed.
export function showDue(list) {
  clear(bannerEl);
  for (const r of list.slice(0, 3)) {
    bannerEl.append(h('div.banner.due', { role: 'alert' },
      h('span.label', 'Reminder due'),
      h('span.txt', r.text),
      h('button.btn.sm', { on: { click: () => api(`/reminders/${r.id}/done`, { method: 'POST' }) } }, 'Done'),
      h('button.btn.sm', { on: { click: () => api(`/reminders/${r.id}/snooze`, { method: 'POST', body: { minutes: 10 } }) } }, '+10 min'),
    ));
  }
  bannerEl.style.paddingBottom = list.length ? '2px' : '0';
  bannerEl.style.paddingTop = list.length ? '8px' : '0';
}
