import { h, icon, api, fmt, integrationTag, S, toast } from './util.js';

const STATE_LABEL = {
  queued: 'Queued', planning: 'Parsing', running: 'Executing', awaiting_confirm: 'Awaiting authorisation',
  done: 'Complete', partial: 'Partial', failed: 'Failed', cancelled: 'Cancelled', needs_input: 'Needs input',
};
const STEP_ICON = {
  pending: 'circle', running: 'spin', done: 'check', failed: 'x', skipped: 'dash', cancelled: 'dash',
  declined: 'slash', needs_input: 'ask', awaiting_confirm: 'shield',
};
const ACTIVE = new Set(['queued', 'planning', 'running', 'awaiting_confirm']);
const AUTH_CODES = new Set(['AUTH_EXPIRED', 'AUTH_SCOPE', 'NOT_CONNECTED']);

export const isActive = (job) => ACTIVE.has(job.state);

const post = (path, body) => api(path, { method: 'POST', body }).catch((e) => toast(e.message, 'err'));

function duration(step) {
  if (!step.startedAt || !step.finishedAt) return '';
  const s = (new Date(step.finishedAt) - new Date(step.startedAt)) / 1000;
  return s < 0.05 ? '' : `${s.toFixed(1)} s`;
}

function stepNode(job, step, index, single) {
  const reconnect = step.error && AUTH_CODES.has(step.error.code);
  const notConfigured = step.error?.code === 'NOT_CONFIGURED';
  const row = h('div.step', { class: `s-${step.status}` },
    h('span.ico', icon(STEP_ICON[step.status] || 'circle', 15)),
    h('div.head',
      single ? null : h('span.idx', String(index + 1).padStart(2, '0')),
      integrationTag(step.integration),
      h('span.lbl', step.label),
    ),
    h('span.meta', step.status === 'running' ? '' : duration(step)),
  );

  let body = '';
  if (step.status === 'done' && !single) body = step.say;
  else if (step.status === 'failed' && !single) body = step.error?.message + (step.error?.hint ? `\n${step.error.hint}` : '');
  else if (['skipped', 'declined', 'needs_input'].includes(step.status) && !single) body = step.message;
  if (body) row.append(h('div.body', body));

  if (step.progress && step.status === 'running') {
    row.append(h('div.bar',
      h('div.track', h('div.fill', { style: `width:${step.progress.pct}%` })),
      h('span.mono.dim', `${step.progress.pct}%`),
    ));
    if (step.progress.label) row.append(h('div.body', step.progress.label));
  }

  if (step.status === 'awaiting_confirm') {
    row.append(h('div.confirm',
      h('span.label', 'Authorisation required'),
      h('div.what', step.confirm?.text || step.label),
      h('div.why', 'This leaves the console and reaches other people. Say the word and I will proceed.'),
      h('div.actions',
        h('button.btn.primary', { on: { click: () => post(`/jobs/${job.id}/confirm`, { approve: true }) } }, 'Authorise'),
        h('button.btn', { on: { click: () => post(`/jobs/${job.id}/confirm`, { approve: false }) } }, 'Hold'),
      ),
    ));
  }

  if (reconnect || notConfigured) {
    row.append(h('div.actions',
      reconnect ? h('a.btn.sm', { href: step.integration === 'telegram' ? '#' : '/auth/google' }, 'Reconnect Google') : null,
      h('button.btn.sm', { on: { click: () => document.dispatchEvent(new CustomEvent('open-systems')) } }, 'Open systems'),
    ));
  }
  return row;
}

// Returns the JARVIS half of a job: ack, step card, reply.
export function jobBody(job) {
  const out = [];
  const steps = job.steps || [];
  const single = steps.length === 1;
  const active = isActive(job);

  if (job.state === 'queued') {
    const pos = S.queue.queued.indexOf(job.id) + 1;
    out.push(h('div.say.muted', pos ? `Queued. ${pos === 1 ? 'Next up' : `${pos - 1} ahead of this`}.` : 'Queued.'));
  } else if (job.state === 'planning') {
    out.push(h('div.say.muted', h('span.scanning', 'Parsing request')));
  }
  if (job.ack && steps.length) out.push(h('div.ack', job.ack));

  if (steps.length) {
    const protocol = steps.length > 1;
    const card = h('div.job', { class: `${protocol ? 'protocol' : ''} ${job.state}` },
      h('div.job-head',
        h('span.label', protocol ? `Protocol · ${steps.length} steps` : 'Action'),
        job.cancelRequested && active ? h('span.tag', 'stopping after this step') : null,
        h('span.sp'),
        h('span.label', { style: job.state === 'failed' ? 'color:var(--red)' : job.state === 'done' ? 'color:var(--verd)' : '' }, STATE_LABEL[job.state] || job.state),
        active ? h('button.btn.sm', { on: { click: () => post(`/jobs/${job.id}/cancel`) } }, job.state === 'queued' ? 'Cancel' : 'Stop') : null,
      ),
      steps.map((s, i) => stepNode(job, s, i, single)),
    );
    out.push(card);
  } else if (job.state === 'needs_input') {
    out.push(h('div.say.ask', job.reply));
  }

  if (!active) {
    const text = steps.length > 1 ? job.summary || job.reply : job.state === 'needs_input' && !steps.length ? '' : job.reply;
    if (text && !(job.state === 'needs_input' && !steps.length)) {
      out.push(h('div.say', { class: job.state === 'cancelled' ? 'cancelled' : '' }, text));
    }
    if (job.state === 'needs_input' && steps.length) out.push(h('div.say.ask', job.reply));
    for (const n of job.notes || []) out.push(h('div.note', n));
    if (['failed', 'partial'].includes(job.state)) {
      out.push(h('div.actions', { style: 'display:flex;gap:8px;margin-top:8px' },
        h('button.btn.sm', { on: { click: () => post(`/jobs/${job.id}/retry`, { tz: S.tz }) } }, icon('retry', 12), 'Retry failed steps'),
      ));
    }
  }
  return out;
}

export function userLine(job) {
  const parts = [h('div.say.user', job.text)];
  const tags = [];
  if (job.mode === 'interrupt') tags.push(h('span.tag', { style: 'color:var(--red);border-color:#6b2b24' }, 'Interrupt'));
  for (const a of job.attachments || []) tags.push(h('span.tag', icon('clip', 10), ` ${a.name}`));
  if (tags.length) parts.push(h('div', { style: 'display:flex;gap:6px;margin-top:4px;flex-wrap:wrap' }, tags));
  return parts;
}

export { fmt };
