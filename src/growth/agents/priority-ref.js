// Nordla Growth - A5: the link between a Stratège draft and ONE priority of Opportunités.
// The server finds the priority among the CURRENT priorities of the session's merchant (the payload the page itself shows). Never by text, never
// from the model: the reference is the priority's own stable id, set by the server once the priority has been found. Read only.
// A5 review hardening: the personal filter below applies to EVERY agent context (gateway.js), not only to priorities.

import { createHash } from 'node:crypto';

const BLOCKS = ['inbox', 'ads', 'site', 'social'];

/** Every priority the page can show, by its stable id. Items of another merchant never reach this payload (the app is built per merchant). */
export function priorityItemsById(payload) {
  const out = new Map();
  const add = (list) => { if (Array.isArray(list)) for (const i of list) if (i && typeof i.id === 'string' && i.id.length > 0 && !out.has(i.id)) out.set(i.id, i); };
  if (payload && payload.sections) { add(payload.sections.fix); add(payload.sections.commercial); add(payload.sections.watch); }
  for (const k of BLOCKS) add(payload && payload[k] ? payload[k].items : null);
  return out;
}

// Keys that identify a person, carry message text, or identify a customer or a connected account. Removed at ANY depth of an agent context.
export const PRIVATE_FIELDS = new Set([
  'handle', 'account', 'accountId', 'account_id', 'text', 'messages', 'threads', 'customer', 'customer_key', 'customerKey',
  'email', 'phone', 'firstName', 'lastName', 'first_name', 'last_name', 'address', 'ip', 'ipAddress',
]);
const PRIVATE_EVIDENCE = PRIVATE_FIELDS;

/** The provider never sees a connected account's identifier, nor a priority id built from one: those are replaced by an opaque reference. */
const opaqueRef = (id) => `ref:${createHash('sha256').update(String(id)).digest('hex').slice(0, 16)}`;
const isAccountPriority = (o) => o.category === 'inbox' || o.kind === 'inquiryTest';

/** A copy of a value without the personal fields, at any depth (arrays and objects). Used for every agent context. */
export function redactPersonalFields(value) {
  if (Array.isArray(value)) return value.map(redactPersonalFields);
  if (!value || typeof value !== 'object') return value;
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    if (PRIVATE_FIELDS.has(k)) continue;
    if (k === 'entity' && v && typeof v === 'object' && v.type === 'socialAccount') continue; // its id is the account id and its title the handle
    out[k] = redactPersonalFields(v);
  }
  if (isAccountPriority(value) && typeof value.id === 'string') out.id = opaqueRef(value.id);
  return out;
}

/** What the agent may read about the priority: its stable id, kind, category, codes, and its evidence without personal fields. */
export function priorityFocus(item) {
  const evidence = item.evidence && typeof item.evidence === 'object' && !Array.isArray(item.evidence)
    ? Object.fromEntries(Object.entries(item.evidence).filter(([k]) => !PRIVATE_EVIDENCE.has(k)))
    : null;
  return { id: item.id, kind: item.kind ?? null, category: item.category ?? null, title: item.title ?? null, explanation: item.explanation ?? null, reliability: item.reliability ?? null, sourcePage: item.sourcePage ?? null, evidence };
}
