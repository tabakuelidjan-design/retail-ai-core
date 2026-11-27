// Nordla Growth - A5: the link between a Stratège draft and ONE priority of Opportunités.
// The server finds the priority among the CURRENT priorities of the session's merchant (the payload the page itself shows). Never by text, never
// from the model: the reference is the priority's own stable id, set by the server once the priority has been found. Read only.

const BLOCKS = ['inbox', 'ads', 'site', 'social'];

/** Every priority the page can show, by its stable id. Items of another merchant never reach this payload (the app is built per merchant). */
export function priorityItemsById(payload) {
  const out = new Map();
  const add = (list) => { if (Array.isArray(list)) for (const i of list) if (i && typeof i.id === 'string' && i.id.length > 0 && !out.has(i.id)) out.set(i.id, i); };
  if (payload && payload.sections) { add(payload.sections.fix); add(payload.sections.commercial); add(payload.sections.watch); }
  for (const k of BLOCKS) add(payload && payload[k] ? payload[k].items : null);
  return out;
}

// Fields that identify a person or carry message text: never given to the agent, at any depth of its context.
export const PRIVATE_FIELDS = new Set(['handle', 'accountId', 'text', 'messages', 'threads', 'customer', 'email', 'phone']);
const PRIVATE_EVIDENCE = PRIVATE_FIELDS;

/** A copy of a value without the personal fields, at any depth (arrays and objects). Used for every agent context, not only for priorities. */
export function redactPersonalFields(value) {
  if (Array.isArray(value)) return value.map(redactPersonalFields);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([k]) => !PRIVATE_FIELDS.has(k)).map(([k, v]) => [k, redactPersonalFields(v)]));
  return value;
}

/** What the agent may read about the priority: its stable id, kind, category, codes, and its evidence without personal fields. */
export function priorityFocus(item) {
  const evidence = item.evidence && typeof item.evidence === 'object' && !Array.isArray(item.evidence)
    ? Object.fromEntries(Object.entries(item.evidence).filter(([k]) => !PRIVATE_EVIDENCE.has(k)))
    : null;
  return { id: item.id, kind: item.kind ?? null, category: item.category ?? null, title: item.title ?? null, explanation: item.explanation ?? null, reliability: item.reliability ?? null, sourcePage: item.sourcePage ?? null, evidence };
}
