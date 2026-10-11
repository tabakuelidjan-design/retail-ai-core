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

// ---- near-miss key repair. A language model may misspell a key of the contract it was given ("risisks" for "risks"). The closed contract stays closed: only an UNAMBIGUOUS misspelling is
// corrected, deterministically and locally (no second call): exactly one unknown key and one missing key that are within two edits of each other. Every repair is recorded as evidence; the
// values are still validated by the contract, so nothing about the quality bar changes.

function editDistance(a, b) {
  const row = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i += 1) {
    let previous = row[0]; row[0] = i;
    for (let j = 1; j <= b.length; j += 1) { const keep = row[j]; row[j] = Math.min(row[j] + 1, row[j - 1] + 1, previous + (a[i - 1] === b[j - 1] ? 0 : 1)); previous = keep; }
  }
  return row[b.length];
}
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const MAX_KEY_EDITS = 2;

/**
 * @param {*} value the parsed answer; @param {object} schema { keys, required?, children?: { key: schema | { items: schema } } } @returns the answer with unambiguous near-miss keys corrected
 */
export function repairNearMissKeys(value, schema, repairs = [], path = 'answer') {
  if (schema?.items) return Array.isArray(value) ? value.map((v, i) => repairNearMissKeys(v, schema.items, repairs, `${path}[${i}]`)) : value;
  if (!isObject(value) || !schema?.keys) return value;
  const out = { ...value };
  const unknown = Object.keys(out).filter((k) => !schema.keys.includes(k));
  const missing = (schema.required ?? schema.keys).filter((k) => !(k in out));
  if (unknown.length === 1 && missing.length === 1 && editDistance(unknown[0], missing[0]) <= MAX_KEY_EDITS) {
    out[missing[0]] = out[unknown[0]]; delete out[unknown[0]];
    repairs.push({ path, from: unknown[0], to: missing[0] });
  }
  for (const [key, child] of Object.entries(schema.children ?? {})) if (key in out) out[key] = repairNearMissKeys(out[key], child, repairs, `${path}.${key}`);
  return out;
}

/**
 * One completion, then the stage's normalization, with the evidence a diagnosis needs: if normalization refuses the answer, the error carries `evidence` ({ stage, request_id, model,
 * key_repairs, raw_answer (bounded) }) so that a failed stage can be reconstructed from the record alone. Returns { value, meta }.
 */
export async function askAndNormalize({ complete, instruction, stage, schema = null, normalize }) {
  if (typeof complete !== 'function') throw new TypeError(`${stage} needs a language-model port`);
  let reply;
  try { reply = await complete(instruction); } catch (cause) { throw new BrainError(BRAIN_ERROR.PORT_FAILED, `${stage}: the language-model port failed`, stage, safeCause(cause)); }
  const meta = { model: reply?.model ?? null, request_id: reply?.request_id ?? null, key_repairs: [] };
  const evidence = { stage, request_id: meta.request_id, model: meta.model, key_repairs: meta.key_repairs, raw_answer: String(reply?.text ?? '').slice(0, 8000) };
  try {
    const parsed = parseJsonObject(reply?.text, stage);
    const raw = schema ? repairNearMissKeys(parsed, schema, meta.key_repairs, stage) : parsed;
    return { value: normalize(raw), meta };
  } catch (error) {
    if (error && typeof error === 'object') error.evidence = evidence;
    throw error;
  }
}
