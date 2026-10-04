// Natural-language planner backed by the Anthropic Messages API. The model
// never touches an integration; it only returns a plan that the same validators
// and executor used by the built-in parser then run.
import { config } from '../config.js';
import { TOOL_NAMES } from './tools.js';
import { contactNames } from './contacts.js';
import { store } from '../store.js';
import { toIsoOffset, fmtLongDate, fmtTime } from '../time.js';

let resolvedModel = config.llm.model || null;
let lastFailure = null;

export const llmEnabled = () => Boolean(config.llm.key);

export function llmStatus() {
  if (!llmEnabled()) return { state: 'unconfigured', detail: 'Built-in parser active (no ANTHROPIC_API_KEY)' };
  if (lastFailure) return { state: 'degraded', detail: `Fell back to built-in parser: ${lastFailure}`, account: resolvedModel };
  return { state: 'online', detail: resolvedModel || 'language model', account: resolvedModel };
}

async function api(path, init = {}) {
  const res = await fetch(`${config.llm.baseUrl}${path}`, {
    ...init,
    headers: {
      'x-api-key': config.llm.key,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
      ...init.headers,
    },
    signal: AbortSignal.timeout(25000),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body?.error?.message || `HTTP ${res.status}`);
  return body;
}

// Without an explicit model we ask the API what exists and prefer a mid-tier one.
async function pickModel() {
  if (resolvedModel) return resolvedModel;
  const list = await api('/v1/models?limit=100', { method: 'GET' });
  const ids = (list.data || []).map((m) => m.id);
  resolvedModel = ids.find((id) => /sonnet/i.test(id)) || ids.find((id) => /haiku/i.test(id)) || ids[0];
  if (!resolvedModel) throw new Error('no models available for this key');
  return resolvedModel;
}

const STEP_SCHEMA = {
  type: 'object',
  properties: {
    tool: { type: 'string', enum: TOOL_NAMES },
    args: { type: 'object', description: 'Arguments for the tool. See the tool reference in the system prompt.' },
    dependsOn: { type: 'array', items: { type: 'integer' }, description: 'Zero-based indices of earlier steps this one needs to have succeeded.' },
  },
  required: ['tool', 'args'],
};

const PLAN_TOOL = {
  name: 'submit_plan',
  description: "Return the plan for Tony's request.",
  input_schema: {
    type: 'object',
    properties: {
      reply: { type: 'string', description: 'Optional one-line spoken reply. Use it for chit-chat or questions that need no tool. Leave empty when steps are given.' },
      clarify: { type: 'string', description: 'A single short question, only when something required is missing or genuinely ambiguous. Then steps must be empty.' },
      steps: { type: 'array', items: STEP_SCHEMA },
    },
    required: ['steps'],
  },
};

const TOOL_REFERENCE = `
calendar_create   {title, start, end?, durationMinutes?, allDay?, description?, location?, attendees?: [email]}
calendar_list     {start, end, label?}              view events in a window (label like "tomorrow")
calendar_update   {match: {title?, date?}, changes: {title?, start?, end?, durationMinutes?, description?, location?}}
calendar_delete   {match: {title?, date?}}
reminder_create   {text, at}                        personal reminder (not a calendar event)
reminder_list     {scope: "today"|"upcoming"|"all"|"date", date?}
reminder_complete {match: {text}}
reminder_delete   {match: {text}}
drive_search      {query}                           keywords from the file name or contents
drive_list        {folder?}                         browse a folder by name or path; empty = My Drive
drive_create_folder {name, parent?}
drive_upload      {folder?, newFolder?}             uploads the staged attachment(s); folder = existing destination, newFolder = create it
telegram_send     {recipient, text}                 text is the message to deliver, written in Tony's voice
comms_history     {}`.trim();

function systemPrompt(ctx) {
  const now = ctx.now;
  const open = store.data.reminders.filter((r) => ['pending', 'due'].includes(r.status)).slice(0, 8);
  return `You are JARVIS, Tony Stark's personal assistant. You turn his message into a plan of tool calls by calling submit_plan. You never answer in plain text.

Now: ${fmtLongDate(now, ctx.tz)}, ${fmtTime(now, ctx.tz)} (${ctx.tz}). ISO: ${toIsoOffset(now, ctx.tz)}.

Tools (all arguments are JSON):
${TOOL_REFERENCE}

Rules
- Every date-time is ISO 8601 with the numeric UTC offset for ${ctx.tz}, e.g. ${toIsoOffset(now, ctx.tz)}. Compute relative phrases ("tomorrow at 5 PM", "30 minutes before it") yourself. Without a stated time zone, use ${ctx.tz}.
- Several requests in one message become several ordered steps. Use dependsOn when a step only makes sense if an earlier one worked (a reminder before an event, a message about it).
- A meeting or call at a time = calendar_create. A "remind me" = reminder_create. Never mix them up.
- If something required is missing or ambiguous (no time for an event or reminder, no message body, an AM/PM that could be either, which of two people), do not guess: set clarify to one short question and return no steps.
- telegram_send: recipient is the name as Tony said it. Known contacts: ${contactNames().join(', ') || 'none yet'}. Write text as the message itself, first person from Tony, concise, no quotation marks. Do not invent facts that Tony did not give.
- drive_upload: only when Tony wants a file filed to Drive. ${ctx.attachments?.length ? `Staged files: ${ctx.attachments.map((a) => a.name).join(', ')}.` : 'No file is attached right now; still plan drive_upload and the console will ask him to choose one.'}
- Small talk or questions about what you can do: put a short dry, courteous reply (address him as "sir") in reply and no steps.
- Never put secrets, tokens or other people's data in any argument.
${open.length ? `Active reminders: ${open.map((r) => r.text).join('; ')}` : ''}`;
}

export async function planWithLlm(text, ctx) {
  const model = await pickModel();
  const messages = [];
  for (const h of ctx.history || []) {
    messages.push({ role: 'user', content: h.text });
    if (h.reply) messages.push({ role: 'assistant', content: h.reply });
  }
  // consecutive same-role turns are rejected; collapse defensively
  const merged = [];
  for (const m of messages) {
    const last = merged.at(-1);
    if (last && last.role === m.role) last.content += `\n${m.content}`;
    else merged.push({ ...m });
  }
  if (merged.at(-1)?.role === 'user') merged.push({ role: 'assistant', content: '(no reply)' });
  merged.push({ role: 'user', content: text });

  const body = await api('/v1/messages', {
    method: 'POST',
    body: JSON.stringify({
      model,
      max_tokens: 1500,
      temperature: 0,
      system: systemPrompt(ctx),
      tools: [PLAN_TOOL],
      tool_choice: { type: 'tool', name: 'submit_plan' },
      messages: merged,
    }),
  });
  const block = (body.content || []).find((b) => b.type === 'tool_use' && b.name === 'submit_plan');
  if (!block) throw new Error('model returned no plan');
  lastFailure = null;
  const input = block.input || {};
  return {
    reply: typeof input.reply === 'string' ? input.reply.trim() : '',
    clarify: typeof input.clarify === 'string' ? input.clarify.trim() : '',
    steps: Array.isArray(input.steps) ? input.steps.filter((s) => TOOL_NAMES.includes(s?.tool)).map((s) => ({ tool: s.tool, args: s.args || {}, dependsOn: s.dependsOn })) : [],
  };
}

export function noteLlmFailure(err) {
  lastFailure = err.message;
}
