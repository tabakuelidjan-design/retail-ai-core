import { BRAIN_ERROR, BrainError, fail } from './validation.js';

// How a Creative Brain stage talks to a language model, behind a PORT: `complete({ system, user }) -> { text, model?, request_id? }`. The instruction is an adapter-level PROJECTION of canonical Nordla state
// (knowledge principles, the frame, the concept...), never the state itself. The model's answer is untrusted text: it is parsed as ONE JSON object and then normalized by the stage's closed contract.
// Nothing asks the model for, stores or depends on its private reasoning: a stage keeps only the fields of its contract, among them a concise rationale written for the record.

const SAFE_TOKEN = /^[A-Za-z0-9_.:-]{1,100}$/;

/** The diagnostics of a failure that are safe to keep: scalars of a fixed shape, never a message. */
export function safeCause(cause) {
  const out = {};
  if (typeof cause?.name === 'string' && SAFE_TOKEN.test(cause.name)) out.name = cause.name;
  if (typeof cause?.code === 'string' && SAFE_TOKEN.test(cause.code)) out.code = cause.code;
  if (Number.isInteger(cause?.status) && cause.status >= 100 && cause.status <= 599) out.status = cause.status;
  const requestId = cause?.requestId ?? cause?.request_id;
  if (typeof requestId === 'string' && SAFE_TOKEN.test(requestId)) out.request_id = requestId;
  return out;
}

export function parseJsonObject(text, where = 'answer') {
  const trimmed = String(text ?? '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  const start = trimmed.indexOf('{'); const end = trimmed.lastIndexOf('}');
  if (start < 0 || end < start) fail(BRAIN_ERROR.MALFORMED, 'the model returned no JSON object', where);
  try { return JSON.parse(trimmed.slice(start, end + 1)); } catch { return fail(BRAIN_ERROR.MALFORMED, 'the model returned invalid JSON', where); }
}

/**
 * One completion through the port. A failure of the port is a BrainError with the safe diagnostics only. Returns { raw, meta }.
 * @param {object} input { complete, instruction: { system, user }, stage }
 */
export async function askModel({ complete, instruction, stage }) {
  if (typeof complete !== 'function') throw new TypeError(`${stage} needs a language-model port`);
  let reply;
  try { reply = await complete(instruction); } catch (cause) { throw new BrainError(BRAIN_ERROR.PORT_FAILED, `${stage}: the language-model port failed`, stage, safeCause(cause)); }
  const raw = parseJsonObject(reply?.text, stage);
  return { raw, meta: { model: reply?.model ?? null, request_id: reply?.request_id ?? null } };
}
