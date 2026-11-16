// THE REPAIR CONTRACT. A repair never regenerates a structure: it answers a list of field patches { path, value }, one per violating field, and Nordla applies
// them to the previous answer, all or none, after validating each of them. Four real attempts (trial-17dc..., c22941..., e97815..., 66252c...) failed before the image
// stage because the repair was a regenerated answer merged BY POSITION: the model deleted an array element, shifted the others, or answered an element without its
// key, and the merge silently dropped the key (JSON.stringify drops `undefined`) or paired a new text with an old reason.
// Guarantees, whatever the model answers:
//   - only the listed fields (and, optionally, the free-text siblings of a listed field in the same array item) can change;
//   - an array keeps its length, order and items; nothing is added, deleted, reordered or duplicated;
//   - a missing or `undefined` replacement is a REJECTION, never a deletion (a key is removed only by an explicit {"path","delete":true} on a listed key, never an array item);
//   - a replacement keeps the kind of the value it replaces (text stays text, a list stays a list);
//   - nothing is applied unless EVERY required patch is present and valid.
// The caller then validates the COMPLETE resulting answer with the unchanged contract validators; this module only guards the structure.

export const PATCH_REJECT = Object.freeze({
  UNPARSEABLE: 'REPAIR_UNPARSEABLE',
  MISSING_PATCH: 'REPAIR_MISSING_PATCH',
  UNEXPECTED_PATH: 'REPAIR_UNEXPECTED_PATH',
  DUPLICATE_PATH: 'REPAIR_DUPLICATE_PATH',
  MALFORMED: 'REPAIR_MALFORMED_PATCH',
  WRONG_KIND: 'REPAIR_VALUE_KIND_CHANGED',
  LENGTH_CHANGED: 'REPAIR_ARRAY_LENGTH_CHANGED',
  ITEM_MISSING: 'REPAIR_ITEM_MISSING',
  IDENTITY_LOST: 'REPAIR_ITEM_IDENTITY_LOST',
  DUPLICATED_ITEM: 'REPAIR_DUPLICATED_ITEM',
  NOT_ADDRESSABLE: 'REPAIR_PATH_NOT_ADDRESSABLE',
});

const kindOf = (v) => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const keyOf = (path) => JSON.stringify(path);
const getAt = (o, path) => path.reduce((x, k) => (x == null ? undefined : x[k]), o);
const reject = (code, detail) => ({ ok: false, reject: { code, detail } });

/** The reply as a JSON value (a ```json fence is tolerated, nothing else). */
export function parseReply(text) {
  const s = String(text ?? '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  try { return { ok: true, value: JSON.parse(s) }; } catch { return { ok: false }; }
}

/**
 * Turns the model's reply into the patches of the required paths.
 *   original   the previous (parsed) answer
 *   reply      the parsed reply: either { patches: [{ path, value | delete }] } or, tolerated, a whole answer
 *   required   [{ field, path }]: the violating fields, in document order
 *   resolve    (fieldString) -> path array (the caller's own path rules, e.g. envelope names)
 * Returns { ok: true, patches: [{ field, path, op: 'set'|'delete', value }], form } or { ok: false, reject: { code, detail } }.
 */
export function planPatches({ original, reply, required, resolve, siblings = true }) {
  const wanted = new Map(required.map((r) => [keyOf(r.path), r]));
  const optional = new Map(); // free-text siblings of a required field inside the same array item
  for (const r of required) {
    const parent = r.path.slice(0, -1);
    const holder = getAt(original, parent);
    if (siblings && typeof r.path.at(-2) === 'number' && holder && typeof holder === 'object' && !Array.isArray(holder)) {
      for (const [k, v] of Object.entries(holder)) if (typeof v === 'string' && !wanted.has(keyOf([...parent, k]))) optional.set(keyOf([...parent, k]), { field: null, path: [...parent, k] });
    }
  }
  const patches = [];
  const isPatchForm = reply && typeof reply === 'object' && !Array.isArray(reply) && Array.isArray(reply.patches) && Object.keys(reply).every((k) => k === 'patches');
  if (isPatchForm) {
    const seen = new Set();
    for (const p of reply.patches) {
      if (!p || typeof p !== 'object' || Array.isArray(p) || typeof p.path !== 'string' || !Object.keys(p).every((k) => k === 'path' || k === 'value' || k === 'delete')) return reject(PATCH_REJECT.MALFORMED, { patch: JSON.stringify(p)?.slice(0, 200) });
      const path = resolve(p.path);
      const k = keyOf(path);
      if (!path.length || (!wanted.has(k) && !optional.has(k))) return reject(PATCH_REJECT.UNEXPECTED_PATH, { path: p.path });
      if (seen.has(k)) return reject(PATCH_REJECT.DUPLICATE_PATH, { path: p.path });
      seen.add(k);
      if (p.delete === true) {
        if (typeof path.at(-1) === 'number' || !wanted.has(k)) return reject(PATCH_REJECT.MALFORMED, { path: p.path, why: 'only a listed key can be removed, never an array item' });
        patches.push({ field: wanted.get(k).field, path, op: 'delete' });
      } else {
        if (!Object.hasOwn(p, 'value') || p.value === undefined || p.value === null) return reject(PATCH_REJECT.MALFORMED, { path: p.path, why: 'no replacement value' });
        patches.push({ field: wanted.get(k)?.field ?? optional.get(k).field, path, op: 'set', value: p.value });
      }
    }
    for (const r of required) if (!seen.has(keyOf(r.path))) return reject(PATCH_REJECT.MISSING_PATCH, { field: r.field });
    return finish(original, patches, 'PATCHES');
  }
  // TOLERATED FORM = a FALLBACK, not the format that is asked for: the model answered a whole regenerated answer instead of patches. Patches are DERIVED from it, only for the required paths (every other field of the reply is
  // discarded, never applied), and only if the structure around them is intact. A required field that is missing from the reply rejects the whole repair; a derived value that still breaks a rule is refused by the caller's rules.
  if (!reply || typeof reply !== 'object' || Array.isArray(reply)) return reject(PATCH_REJECT.MALFORMED, { why: 'the reply is neither a patch list nor an answer object' });
  for (const r of required) {
    // every array on the way to the field must keep its length (unless the array itself is the field), and the item must still be there
    for (let i = 0; i < r.path.length - 1; i += 1) {
      if (typeof r.path[i + 1] !== 'number') continue;
      const arrPath = r.path.slice(0, i + 1);
      const a = getAt(original, arrPath); const b = getAt(reply, arrPath);
      if (!Array.isArray(a)) continue;
      if (!Array.isArray(b)) return reject(PATCH_REJECT.NOT_ADDRESSABLE, { field: r.field, why: 'the list is not a list in the reply' });
      if (a.length !== b.length) return reject(PATCH_REJECT.LENGTH_CHANGED, { field: r.field, before: a.length, after: b.length });
      const idx = r.path[i + 1];
      if (b[idx] === undefined || b[idx] === null) return reject(PATCH_REJECT.ITEM_MISSING, { field: r.field });
    }
    const item = r.path.length >= 2 && typeof r.path.at(-2) === 'number' ? { before: getAt(original, r.path.slice(0, -1)), after: getAt(reply, r.path.slice(0, -1)) } : null;
    if (item && item.before && typeof item.before === 'object') {
      // identity: the reply's item may not BE another original item (a reorder): its unpatched fields must not match a different original item while differing from this one
      const holderPath = r.path.slice(0, -2); const idx = r.path.at(-2);
      const others = Object.keys(item.before).filter((k) => !wanted.has(keyOf([...r.path.slice(0, -1), k])));
      const originals = getAt(original, holderPath);
      const matches = (j) => others.length > 0 && others.every((k) => same(originals[j]?.[k], item.after?.[k]));
      if (Array.isArray(originals) && !matches(idx) && originals.some((_, j) => j !== idx && matches(j))) return reject(PATCH_REJECT.IDENTITY_LOST, { field: r.field, why: 'the item of the reply is another item of the previous answer (reordered)' });
    }
    const value = getAt(reply, r.path);
    if (value === undefined) {
      // an item or a key absent from the reply is a MISSING answer, never a deletion (removal exists only as an explicit patch)
      const parentAfter = getAt(reply, r.path.slice(0, -1));
      return reject(!parentAfter || typeof parentAfter !== 'object' ? PATCH_REJECT.ITEM_MISSING : PATCH_REJECT.MISSING_PATCH, { field: r.field });
    } else patches.push({ field: r.field, path: r.path, op: 'set', value });
  }
  return finish(original, patches, 'WHOLE_ANSWER');
}

function finish(original, patches, form) {
  const out = [];
  for (const p of patches) {
    const parent = getAt(original, p.path.slice(0, -1));
    const last = p.path.at(-1);
    if (!parent || typeof parent !== 'object') return reject(PATCH_REJECT.NOT_ADDRESSABLE, { field: p.field });
    if (Array.isArray(parent) && !(typeof last === 'number' && last < parent.length)) return reject(PATCH_REJECT.NOT_ADDRESSABLE, { field: p.field, why: 'no such item' });
    if (p.op === 'delete') { if (Array.isArray(parent)) return reject(PATCH_REJECT.MISSING_PATCH, { field: p.field }); out.push(p); continue; }
    const before = getAt(original, p.path);
    if (before !== undefined && ['string', 'array', 'object'].includes(kindOf(before)) && kindOf(before) !== kindOf(p.value)) return reject(PATCH_REJECT.WRONG_KIND, { field: p.field, before: kindOf(before), after: kindOf(p.value) });
    if (typeof p.value === 'string' && !p.value.trim()) return reject(PATCH_REJECT.MALFORMED, { field: p.field, why: 'empty text' });
    out.push({ ...p, value: structuredClone(p.value) });
  }
  // a replacement text may not duplicate another item's text at the same key (a "fix" that copies a neighbour)
  for (const p of out) {
    if (p.op !== 'set' || typeof p.value !== 'string') continue;
    // the identity text of an item (`element`) or an item of a list of texts may not be a copy of a neighbour's (reasons may legitimately repeat)
    const i = p.path.at(-1);
    const list = typeof i === 'number' ? getAt(original, p.path.slice(0, -1)) : (i === 'element' && typeof p.path.at(-2) === 'number' ? getAt(original, p.path.slice(0, -2)) : null);
    const mine = typeof i === 'number' ? i : p.path.at(-2);
    if (Array.isArray(list) && list.some((item, j) => j !== mine && (typeof i === 'number' ? item : item?.element) === p.value)) return reject(PATCH_REJECT.DUPLICATED_ITEM, { field: p.field });
  }
  return { ok: true, patches: out, form };
}

/** Applies validated patches to a COPY of the previous answer. */
export function applyPatches(original, patches) {
  const merged = structuredClone(original);
  for (const p of patches) {
    const parent = getAt(merged, p.path.slice(0, -1)); const last = p.path.at(-1);
    if (p.op === 'delete') delete parent[last]; else parent[last] = p.value;
  }
  return merged;
}

/** The instruction appended to the stage's own: the patch format, exact paths, one per listed field. */
export function patchInstruction(fields, siblingsAllowed = true, standalone = false) {
  const list = fields.map((f) => `"${f}"`).join(', ');
  return ` ANSWER FORMAT OF THIS REPAIR${standalone ? '' : ' (it replaces the format above)'}: return ONLY this JSON object, nothing else: {"patches":[{"path":"<field exactly as listed>","value":<the corrected value>}]} with EXACTLY one patch for each of these ${fields.length} field(s): ${list}.${siblingsAllowed ? ' You may also patch the text sibling (for example "reason") of a listed array item when the correction makes it untrue.' : ''}  For a listed key that must simply be REMOVED answer {"path":"<field>","delete":true}. Never return a whole answer, never add, remove, reorder or duplicate an item, never answer a field without its value. A patch missing, extra or malformed stops the run.`;
}

/** "elements[0].element" -> ["elements", 0, "element"] (the field names the violations use). */
export const pathOfField = (field) => String(field).split('.').flatMap((part) => { const m = part.match(/^([^\[\]]+)((?:\[\d+\])*)$/); if (!m) return [part]; return [m[1], ...[...m[2].matchAll(/\[(\d+)\]/g)].map((x) => Number(x[1]))]; });

/** True when every listed field names a precise place of the previous answer whose container exists (a repair can then be a patch). */
export function patchable(previous, fields) {
  if (!previous || typeof previous !== 'object' || !fields.length) return false;
  return fields.every((f) => { const p = pathOfField(f); const parent = getAt(previous, p.slice(0, -1)); return p.length > 0 && parent !== null && typeof parent === 'object' && (!Array.isArray(parent) || p.at(-1) < parent.length) && getAt(previous, p) !== undefined; });
}

/** The repaired answer as TEXT: the previous answer with ONLY the listed fields replaced, through validated patches. A reply that breaks the repair contract is REJECTED (applied: false), never half-applied. */
export function mergeScoped(previous, replyText, fields, { siblings = true } = {}) {
  const reply = parseReply(replyText);
  if (!reply.ok) return { applied: false, text: replyText, reject: { code: PATCH_REJECT.UNPARSEABLE } };
  const plan = planPatches({ original: previous, reply: reply.value, required: fields.map((f) => ({ field: f, path: pathOfField(f) })), resolve: pathOfField, siblings });
  if (!plan.ok) return { applied: false, text: replyText, reject: plan.reject };
  return { applied: true, text: JSON.stringify(applyPatches(previous, plan.patches)), form: plan.form, patched: plan.patches.map((p) => p.field) };
}
