import { store, uid } from '../store.js';
import { bus } from '../bus.js';
import { integrations } from '../integrations/index.js';
import { TOOLS } from './tools.js';
import { makePlan } from './planner.js';
import { JarvisError, NeedsInput, describeError } from '../errors.js';
import * as attachments from '../attachments.js';
import { isValidTz } from '../time.js';

const TERMINAL = new Set(['done', 'failed', 'partial', 'cancelled', 'needs_input']);
const BLOCKING = new Set(['failed', 'skipped', 'declined', 'cancelled', 'needs_input']);
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

class JobQueue {
  constructor() {
    this.queue = [];
    this.running = null;
    this.pending = null; // a question Tony still owes an answer to
    this.waiters = new Map();
    this.throttle = new Map();

    // Anything left mid-flight by a previous process can't be resumed.
    for (const j of store.data.jobs) {
      if (!TERMINAL.has(j.state)) {
        j.state = 'cancelled';
        j.reply = j.reply || 'This command was interrupted when JARVIS restarted.';
        for (const s of j.steps) if (!['done', 'failed', 'declined'].includes(s.status)) s.status = 'cancelled';
      }
    }
  }

  get(id) {
    return store.data.jobs.find((j) => j.id === id) || null;
  }

  snapshot() {
    return { running: this.running?.id || null, queued: this.queue.map((j) => j.id), pending: Boolean(this.pending) };
  }

  emitQueue() {
    bus.publish('queue', this.snapshot());
  }

  emit(job, { force = true } = {}) {
    if (!force) {
      const last = this.throttle.get(job.id) || 0;
      if (Date.now() - last < 120) return;
      this.throttle.set(job.id, Date.now());
    }
    // lets the browser discard a stale snapshot that arrives after a newer one
    job.rev = (job.rev || 0) + 1;
    store.save();
    bus.publish('job', job);
  }

  submit({ text, mode = 'queue', tz, attachmentIds = [], steps = null, origin = 'command', label = null }) {
    const job = {
      id: uid('j_'),
      text: label || text,
      origin,
      mode,
      state: 'queued',
      createdAt: new Date().toISOString(),
      startedAt: null,
      finishedAt: null,
      tz: isValidTz(tz) ? tz : store.data.settings.timezone || 'UTC',
      attachmentIds,
      attachments: attachmentIds.map((id) => attachments.get(id)).filter(Boolean).map(attachments.publicView),
      presetSteps: steps,
      steps: [],
      reply: '',
      ack: '',
      notes: [],
      source: null,
      cancelRequested: false,
    };
    store.push('jobs', job);

    if (mode === 'interrupt' && this.running) {
      this.queue.unshift(job);
      job.interrupts = this.running.id;
      this.requestCancel(this.running);
    } else {
      this.queue.push(job);
    }
    this.emit(job);
    this.emitQueue();
    this.pump();
    return job;
  }

  requestCancel(job) {
    job.cancelRequested = true;
    const waiter = this.waiters.get(job.id);
    if (waiter) waiter('cancel');
    this.emit(job);
  }

  cancel(id) {
    const job = this.get(id);
    if (!job || TERMINAL.has(job.state)) return false;
    const qi = this.queue.indexOf(job);
    if (qi >= 0) {
      this.queue.splice(qi, 1);
      job.state = 'cancelled';
      job.reply = 'Cancelled before it started.';
      job.finishedAt = new Date().toISOString();
      this.emit(job);
      this.emitQueue();
      return true;
    }
    this.requestCancel(job);
    return true;
  }

  clearQueued() {
    const n = this.queue.length;
    for (const job of [...this.queue]) this.cancel(job.id);
    return n;
  }

  confirm(id, approve) {
    const waiter = this.waiters.get(id);
    if (!waiter) return false;
    waiter(approve ? 'approve' : 'deny');
    return true;
  }

  retry(id, tz) {
    const old = this.get(id);
    if (!old) return null;
    const redo = old.steps.filter((s) => ['failed', 'skipped', 'cancelled'].includes(s.status));
    if (!redo.length) return null;
    const index = new Map(redo.map((s, i) => [s.originalIndex ?? old.steps.indexOf(s), i]));
    const steps = redo.map((s) => ({
      tool: s.tool,
      args: s.args,
      dependsOn: (s.dependsOn || []).map((d) => index.get(d)).filter((d) => d !== undefined),
    }));
    return this.submit({ text: `Retry: ${old.text}`, tz: tz || old.tz, steps, attachmentIds: old.attachmentIds.filter((a) => attachments.get(a)), origin: old.origin });
  }

  pump() {
    if (this.running || !this.queue.length) return;
    const job = this.queue.shift();
    this.running = job;
    this.emitQueue();
    this.execute(job)
      .catch((err) => {
        console.error('job crashed', err);
        job.state = 'failed';
        job.reply = 'Something went wrong on my side before I could finish that.';
        job.steps.forEach((s) => ['pending', 'running', 'awaiting_confirm'].includes(s.status) && (s.status = 'cancelled'));
      })
      .finally(() => {
        job.finishedAt = new Date().toISOString();
        this.running = null;
        this.waiters.delete(job.id);
        this.emit(job);
        this.emitQueue();
        setImmediate(() => this.pump());
      });
  }

  historyFor() {
    return store.data.jobs
      .filter((j) => TERMINAL.has(j.state) && j.origin === 'command' && !j.presetSteps)
      .slice(-5)
      .map((j) => ({ text: j.text, reply: j.reply }));
  }

  async execute(job) {
    job.startedAt = new Date().toISOString();
    const baseCtx = {
      tz: job.tz,
      now: new Date(),
      integrations,
      job,
      history: this.historyFor(),
    };

    // 1. Understand
    let attachmentIds = job.attachmentIds;
    if (!attachmentIds.length && this.pending?.attachmentIds) attachmentIds = this.pending.attachmentIds;
    const staged = attachmentIds.map((id) => attachments.get(id)).filter(Boolean);
    job.attachments = staged.map(attachments.publicView);
    const ctx = { ...baseCtx, attachments: staged, pending: this.pending };

    if (job.presetSteps) {
      job.steps = job.presetSteps.map((s, i) => this.makeStep(s, i, ctx));
      job.source = 'console';
    } else {
      job.state = 'planning';
      this.emit(job);
      const plan = await makePlan(job.text, ctx);
      if (job.cancelRequested) return this.finishCancelled(job);
      job.source = plan.source;
      job.notes = plan.notes || [];

      if (plan.cleared) this.pending = null;
      if (plan.clarify) {
        // keep any staged files alive so the answer can still use them
        const keep = staged.length ? staged.map((a) => a.id) : plan.pending?.attachmentIds;
        this.pending = plan.pending || keep?.length ? { ...(plan.pending || {}), attachmentIds: keep } : null;
        job.state = 'needs_input';
        job.reply = plan.clarify;
        return;
      }
      if (!plan.steps.length) {
        job.state = 'done';
        job.reply = [plan.reply, ...job.notes].filter(Boolean).join('\n') || 'At your disposal, sir.';
        return;
      }
      this.pending = null;
      job.ack = plan.steps.length > 1 || plan.source === 'llm' ? plan.reply : '';
      job.steps = plan.steps.map((s, i) => this.makeStep(s, i, ctx));
    }

    // 2. Execute in order
    job.state = 'running';
    this.emit(job);
    for (let i = 0; i < job.steps.length; i++) {
      const step = job.steps[i];
      if (job.cancelRequested) {
        for (const s of job.steps.slice(i)) s.status = 'cancelled';
        break;
      }
      const blocked = step.dependsOn.find((d) => BLOCKING.has(job.steps[d]?.status));
      if (blocked !== undefined) {
        step.status = 'skipped';
        step.message = `Skipped: step ${blocked + 1} did not complete.`;
        this.emit(job);
        continue;
      }
      const stop = await this.runStep(job, step, i, ctx);
      if (stop) break;
    }
    this.finalise(job);
  }

  makeStep(s, i, ctx) {
    const tool = TOOLS[s.tool];
    return {
      id: `s${i}`,
      originalIndex: i,
      tool: s.tool,
      integration: tool.integration,
      args: s.args,
      dependsOn: s.dependsOn || [],
      approved: Boolean(s.approved),
      label: tool.label(s.args, ctx),
      status: 'pending',
      risk: 'safe',
      message: '',
      say: '',
      error: null,
      progress: null,
      confirm: null,
      focus: null,
    };
  }

  async runStep(job, step, index, ctx) {
    const tool = TOOLS[step.tool];
    step.status = 'running';
    step.startedAt = new Date().toISOString();
    this.emit(job);

    const stepCtx = {
      ...ctx,
      now: new Date(),
      step,
      progress: (pct, label) => {
        step.progress = { pct: Math.max(0, Math.min(100, Math.round(pct))), label };
        this.emit(job, { force: false });
      },
      ui: (action, payload) => bus.publish('ui', { action, ...payload }),
      consumeAttachment: (id) => attachments.drop(id),
    };

    try {
      let args = step.args;
      if (tool.resolve) {
        args = await tool.resolve(args, stepCtx);
        step.args = args;
        step.label = tool.label(args, stepCtx);
      }

      const risk = tool.risk(args);
      step.risk = risk;
      if (risk === 'confirm' && store.data.settings.confirmConsequential && !step.approved) {
        step.status = 'awaiting_confirm';
        step.confirm = { text: tool.confirmText?.(args, stepCtx) || '' };
        job.state = 'awaiting_confirm';
        this.emit(job);
        const decision = await new Promise((resolve) => this.waiters.set(job.id, resolve));
        this.waiters.delete(job.id);
        job.state = 'running';
        step.confirm = null;
        if (decision === 'cancel') {
          step.status = 'cancelled';
          for (const s of job.steps.slice(index + 1)) s.status = 'cancelled';
          this.emit(job);
          return true;
        }
        if (decision === 'deny') {
          step.status = 'declined';
          step.message = 'Held back at your request.';
          tool.onDeclined?.(args, stepCtx);
          this.logAction(job, step, 'declined', step.message);
          bus.publish('refresh', { panels: ['comms', 'log'] });
          this.emit(job);
          return false;
        }
        step.status = 'running';
        this.emit(job);
      }

      const result = await tool.run(args, stepCtx);
      step.status = 'done';
      step.say = result.say;
      step.short = result.short;
      step.notes = result.notes || [];
      step.data = result.data || null;
      step.focus = result.focus || null;
      step.progress = null;
      step.finishedAt = new Date().toISOString();
      this.logAction(job, step, 'ok', result.say);
      if (step.focus) bus.publish('focus', { ...step.focus, jobId: job.id });
      bus.publish('refresh', { panels: [step.integration, 'log'] });
      this.emit(job);
      return false;
    } catch (err) {
      step.progress = null;
      step.finishedAt = new Date().toISOString();
      if (err instanceof NeedsInput) {
        step.status = 'needs_input';
        step.message = err.message;
        const rest = job.steps.slice(index);
        for (const s of job.steps.slice(index + 1)) {
          s.status = 'skipped';
          s.message = 'Waiting on your answer above.';
        }
        const remap = new Map(rest.map((s, i) => [job.steps.indexOf(s), i]));
        this.pending = err.pending
          ? {
              steps: rest.map((s) => ({ tool: s.tool, args: s.args, dependsOn: s.dependsOn.map((d) => remap.get(d)).filter((d) => d !== undefined) })),
              index: 0,
              slot: err.pending.slot,
              attachmentIds: err.pending.attachmentIds || ctx.attachments.map((a) => a.id),
            }
          : null;
        job.state = 'needs_input';
        job.reply = err.message;
        this.emit(job);
        return true;
      }
      step.status = 'failed';
      step.error = describeError(err);
      if (!(err instanceof JarvisError)) console.error('step failed', err);
      this.logAction(job, step, 'failed', step.error.message);
      bus.publish('refresh', { panels: [step.integration, 'log', 'status'] });
      this.emit(job);
      return false;
    }
  }

  finishCancelled(job) {
    job.state = 'cancelled';
    job.reply = store.data.jobs.some((j) => j.interrupts === job.id) ? 'Interrupted by your newer command.' : 'Cancelled.';
  }

  finalise(job) {
    if (job.state === 'needs_input') return;
    const steps = job.steps;
    const done = steps.filter((s) => s.status === 'done');
    const failed = steps.filter((s) => s.status === 'failed');
    const declined = steps.filter((s) => s.status === 'declined');
    const cancelled = steps.filter((s) => s.status === 'cancelled');

    if (job.cancelRequested && cancelled.length) {
      job.state = 'cancelled';
      const interrupter = store.data.jobs.find((j) => j.interrupts === job.id);
      const kept = done.length ? ` ${plural(done.length, 'step')} had already completed.` : '';
      job.reply = interrupter ? `Interrupted by your newer command.${kept}` : `Cancelled.${kept}`;
      return;
    }
    if (failed.length === 0 && done.length > 0) job.state = 'done';
    else if (failed.length && done.length) job.state = 'partial';
    else if (failed.length) job.state = 'failed';
    else job.state = 'done';

    job.reply = this.compose(job, { done, failed, declined });
  }

  compose(job, { done, failed, declined }) {
    const n = job.steps.length;
    const lines = [];
    if (n === 1) {
      if (done[0]) lines.push(done[0].say);
      else if (failed[0]) {
        lines.push(`I couldn't complete that, sir. ${failed[0].error.message}`);
        if (failed[0].error.hint) lines.push(failed[0].error.hint);
      } else if (declined[0]) lines.push('Understood. I have not sent anything.');
      return lines.join('\n');
    }
    if (failed.length === 0) {
      job.summary = declined.length ? `${done.length} of ${n} completed; ${declined.length} held back at your request.` : `All ${n} actions complete.`;
      lines.push(job.summary, ...done.map((s) => s.say));
    } else {
      job.summary = `${done.length} of ${n} completed, sir. ${plural(failed.length, 'action')} did not go through.`;
      lines.push(job.summary, ...done.map((s) => s.say), ...failed.map((s) => `${s.label}: ${s.error.message}`));
    }
    return lines.join('\n');
  }

  logAction(job, step, status, summary) {
    store.push('actions', {
      id: uid('a_'),
      ts: new Date().toISOString(),
      jobId: job.id,
      integration: step.integration,
      tool: step.tool,
      label: step.label,
      summary,
      status,
      origin: job.origin,
    });
  }
}

export const queue = new JobQueue();
