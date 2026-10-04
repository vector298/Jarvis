import { TOOLS } from './tools.js';
import { NeedsInput, JarvisError } from '../errors.js';
import { llmEnabled, planWithLlm, noteLlmFailure } from './llm.js';
import { planWithRules, slotFor } from './rules.js';

// Validate every step up front so Tony is asked about anything missing before
// the first action runs, not halfway through.
function validate(steps, ctx, rawSteps = steps) {
  const prepared = [];
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i];
    const tool = TOOLS[s.tool];
    try {
      const args = tool.prepare(s.args || {}, ctx);
      const deps = Array.isArray(s.dependsOn) ? s.dependsOn.filter((d) => Number.isInteger(d) && d >= 0 && d < i) : [];
      prepared.push({ tool: s.tool, args, dependsOn: deps });
    } catch (err) {
      if (err instanceof NeedsInput) {
        return {
          ask: err.message,
          pending: { steps: rawSteps.map((r) => ({ tool: r.tool, args: r.args, dependsOn: r.dependsOn })), index: i, slot: slotFor(rawSteps[i], err) },
        };
      }
      throw new JarvisError('PLAN_INVALID', `I couldn't act on step ${i + 1}: ${err.message}`);
    }
  }
  return { steps: prepared };
}

// -> { source, reply, notes, steps, clarify, pending }
export async function makePlan(text, ctx) {
  let source = 'rules';
  let raw = null;
  let fallbackNote = '';

  if (llmEnabled()) {
    try {
      raw = await planWithLlm(text, ctx);
      source = 'llm';
    } catch (err) {
      noteLlmFailure(err);
      fallbackNote = 'The language model was unreachable, so I used the built-in parser.';
      raw = null;
    }
  }
  if (!raw) raw = planWithRules(text, ctx);

  const base = { source, reply: raw.reply || '', notes: [...(raw.notes || []), ...(fallbackNote ? [fallbackNote] : [])], cleared: Boolean(raw.cleared) };

  if (raw.clarify) return { ...base, steps: [], clarify: raw.clarify, pending: raw.pending || null };
  if (raw.askText) {
    return {
      ...base,
      steps: [],
      reply: '',
      clarify: raw.askText,
      pending: { steps: raw.rawSteps, index: raw.askAt, slot: raw.slot },
    };
  }
  if (!raw.steps.length) return { ...base, steps: [] };

  const v = validate(raw.steps, ctx, raw.rawSteps || raw.steps);
  if (v.ask) return { ...base, steps: [], reply: '', clarify: v.ask, pending: v.pending };
  return { ...base, steps: v.steps };
}
