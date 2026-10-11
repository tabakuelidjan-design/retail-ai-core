import { createHash } from 'node:crypto';

import { findDuplicateKey as coreFindDuplicateKey, jsonSlice as coreJsonSlice } from '../core-resilience/structured-output.js';
import { normalizeNearMisses, REPAIR_KIND } from './contract.js';
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

function jsonSlice(text, where) {
  const slice = coreJsonSlice(text);
  if (slice === null) fail(BRAIN_ERROR.MALFORMED, 'the model returned no JSON object', where);
  return slice;
}

export function parseJsonObject(text, where = 'answer') {
  try { return JSON.parse(jsonSlice(text, where)); } catch (error) { if (error?.code === BRAIN_ERROR.MALFORMED) throw error; return fail(BRAIN_ERROR.MALFORMED, 'the model returned invalid JSON', where); }
}

/** The duplicate-key scanner is Core's (src/core-resilience/structured-output.js); the Brain keeps its own signature (the `where` is ignored). */
export const findDuplicateKey = (text) => coreFindDuplicateKey(text);

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

// ---- the ONE protocol repair. A provider may return text that is not parseable JSON at all (a bracket closed with the wrong character, a truncated key). That is a failure of the PROTOCOL, not of the
// creative answer, so a stage may re-ask exactly ONCE, and only then: the provider call succeeded, a body exists, and parsing failed before any contract validation. It is the same stage, the same
// model, the same instruction (same input, same creative context, same contract) with a short addendum asking for the same intended answer as valid JSON; the malformed text is attached as repair evidence
// only. Never after a semantic or contract failure, never twice, never to obtain a different or a new creative answer. The repaired text goes through the complete canonical validation like any answer.

export const PROTOCOL_REPAIR = Object.freeze({ max_reasks_per_stage: 1, evidence_chars: 6000, outcome: Object.freeze({ PARSED: 'PARSED', STILL_MALFORMED: 'STILL_MALFORMED', PORT_FAILED: 'PORT_FAILED' }) });

export function buildProtocolRepairInstruction(instruction, malformedText) {
  const evidence = String(malformedText ?? '').slice(0, PROTOCOL_REPAIR.evidence_chars);
  return {
    system: instruction.system,
    user: `${instruction.user}

PROTOCOL REPAIR (the only one for this stage): your previous answer to the request above could not be parsed as JSON. Return the same intended answer as valid JSON conforming exactly to the contract stated above. Do not add, remove or reconsider any creative decision, and do not write a new or alternative answer. Output the JSON object only.
The previous answer, supplied as repair evidence only:
${evidence}`,
  };
}

const sha256Text = (text) => createHash('sha256').update(String(text ?? '')).digest('hex');
const costOf = (reply) => (Number.isFinite(reply?.cost_eur) ? reply.cost_eur : null);

/**
 * One completion, then the stage's normalization, with the evidence a diagnosis needs: if normalization refuses the answer, the error carries `evidence` ({ stage, request_id, model,
 * key_repairs, raw_answer (bounded) }) so that a failed stage can be reconstructed from the record alone. Malformed JSON gets at most ONE protocol repair re-ask (see above); its journal is
 * `meta.protocol_repair` and `evidence.protocol_repair`. Returns { value, meta }.
 */
export async function askAndNormalize({ complete, instruction, stage, schema = null, spec = null, normalize }) {
  if (typeof complete !== 'function') throw new TypeError(`${stage} needs a language-model port`);
  const call = async (input) => {
    try { return await complete(input); } catch (cause) { throw new BrainError(BRAIN_ERROR.PORT_FAILED, `${stage}: the language-model port failed`, stage, safeCause(cause)); }
  };
  let reply = await call(instruction);
  let parsed;
  let repair = null;
  let originalBody = null;
  try { parsed = parseJsonObject(reply?.text, stage); } catch (parseError) {
    const body = String(reply?.text ?? '');
    originalBody = body;
    if (parseError?.code !== BRAIN_ERROR.MALFORMED || body.trim() === '') throw withEvidence(parseError, stage, reply, [], [], null);
    repair = {
      original_request_id: reply?.request_id ?? null, original_model: reply?.model ?? null, malformed_response_sha256: sha256Text(body), malformed_response_chars: body.length,
      parse_failure: String(parseError.message).slice(0, 200), original_cost_eur: costOf(reply), repair_request_id: null, outcome: null, added_cost_eur: null,
    };
    const original = reply;
    try { reply = await complete(buildProtocolRepairInstruction(instruction, body)); } catch (cause) {
      repair.outcome = PROTOCOL_REPAIR.outcome.PORT_FAILED;
      throw withEvidence(new BrainError(BRAIN_ERROR.PORT_FAILED, `${stage}: the language-model port failed during the protocol repair`, stage, safeCause(cause)), stage, original, [], [], repair, body);
    }
    repair.repair_request_id = reply?.request_id ?? null; repair.added_cost_eur = costOf(reply);
    try { parsed = parseJsonObject(reply?.text, stage); repair.outcome = PROTOCOL_REPAIR.outcome.PARSED; } catch (second) {
      repair.outcome = PROTOCOL_REPAIR.outcome.STILL_MALFORMED;
      throw withEvidence(second, stage, reply, [], [], repair, body);
    }
  }
  const meta = { model: reply?.model ?? null, request_id: reply?.request_id ?? null, key_repairs: [], repairs: [], ...(repair ? { protocol_repair: repair } : {}) };
  try {
    const duplicate = findDuplicateKey(reply?.text, stage);
    if (duplicate) fail(BRAIN_ERROR.RULE_VIOLATION, `${stage}: the key "${duplicate.key}" appears twice in one object, so the answer does not say which of the two values it means`, stage, { problem: 'DUPLICATE_KEY', words: [duplicate.key] });
    let raw = parsed;
    if (spec) {
      raw = normalizeNearMisses(spec, parsed, meta.repairs, stage);
      for (const r of meta.repairs) if (r.kind === REPAIR_KIND.KEY_NEAR_MISS) meta.key_repairs.push({ path: r.path, from: r.from, to: r.to });
    } else if (schema) raw = repairNearMissKeys(parsed, schema, meta.key_repairs, stage);
    return { value: normalize(raw), meta };
  } catch (error) {
    throw withEvidence(error, stage, reply, meta.key_repairs, meta.repairs, repair, originalBody);
  }
}

/** The evidence of a refused answer: the latest answer (the one that was parsed or validated), and, after a protocol repair, the journal of the repair with the ORIGINAL malformed text. */
function withEvidence(error, stage, reply, keyRepairs, repairs, repair, originalBody = null) {
  if (error && typeof error === 'object') {
    error.evidence = {
      stage, request_id: reply?.request_id ?? null, model: reply?.model ?? null, key_repairs: keyRepairs, repairs, raw_answer: String(reply?.text ?? '').slice(0, 8000),
      ...(repair ? { protocol_repair: { ...repair, ...(originalBody != null ? { original_raw_answer: String(originalBody).slice(0, 8000) } : {}) } } : {}),
    };
  }
  return error;
}
