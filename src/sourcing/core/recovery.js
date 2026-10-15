// Case recovery: bring cases back onto a phone (from the server list or from an exported JSON) WITHOUT ever overwriting what the phone already holds.
// Pure functions, no I/O, no mutation of their inputs. Nothing here merges two cases: when an id already exists locally with different content, the owner either
// skips it or keeps BOTH (the incoming copy is stored under a new id). A recovered case is never marked as "changed", so the sync never pushes it by itself.
import { upgradeCase, CASE_SCHEMA } from './upgrade.js';

export const SAFE_ID = /^[A-Za-z0-9_-]{1,80}$/;
// 64 MB: a case with many document photos must stay importable (it was 8 MB). Photos are also recoverable one by one from the server since the photo store.
export const MAX_IMPORT_BYTES = 64 * 1024 * 1024;
export const EXPORT_FORMAT = 'nordla-case-export';
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

const clone = (x) => JSON.parse(JSON.stringify(x));
/** Same value, same text, whatever the key order. */
export function canonical(v) {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`;
  return JSON.stringify(v) ?? 'null';
}
const fnv = (s, seed) => { let h = seed >>> 0; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; } return h.toString(16).padStart(8, '0'); };
/** Content fingerprint of a case. The revision counter and the recovery mark are bookkeeping, not content, so they are left out. */
export function digest(c) { const { rev, recoveredFrom, ...rest } = c ?? {}; const t = canonical(rest); return fnv(t, 2166136261) + fnv(t, 84696351); }

function hasForbiddenKey(v, depth = 0) {
  if (depth > 60) return true;
  if (Array.isArray(v)) return v.some((x) => hasForbiddenKey(x, depth + 1));
  if (v && typeof v === 'object') return Object.keys(v).some((k) => FORBIDDEN_KEYS.has(k) || hasForbiddenKey(v[k], depth + 1));
  return false;
}

/** Checks ONE case object (from the server or from a file). Never throws; returns { ok, case } or { ok:false, error }. The returned case is a copy, upgraded additively (upgradeCase). */
export function validateCase(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, error: 'NOT_A_CASE' };
  if (hasForbiddenKey(raw)) return { ok: false, error: 'FORBIDDEN_KEY' };
  if (typeof raw.id !== 'string' || !SAFE_ID.test(raw.id)) return { ok: false, error: 'BAD_ID' };
  if (raw.schema !== undefined && (!Number.isFinite(raw.schema) || raw.schema > CASE_SCHEMA)) return { ok: false, error: 'NEWER_SCHEMA' };
  if (!raw.identity || typeof raw.identity !== 'object' || Array.isArray(raw.identity)) return { ok: false, error: 'NOT_A_CASE' };
  if (!Array.isArray(raw.events)) return { ok: false, error: 'NOT_A_CASE' };
  if (typeof raw.updatedAt !== 'string' || typeof raw.createdAt !== 'string') return { ok: false, error: 'NOT_A_CASE' };
  for (const k of ['quotes', 'documents', 'decisions', 'notes', 'conversations', 'candidates', 'ledger', 'conflicts', 'documentLedger', 'userQuestions', 'questionLog', 'confirmBatches', 'offers', 'factAudit', 'factObservations']) if (raw[k] !== undefined && !Array.isArray(raw[k])) return { ok: false, error: 'NOT_A_CASE' };
  return { ok: true, case: upgradeCase(clone(raw)) };
}

/** Reads the text of an exported file. Accepts a bare case (what "Export" wrote until now) or a bundle { format, version, case, photos }. */
export function parseImportText(text) {
  if (typeof text !== 'string' || !text.trim()) return { ok: false, error: 'EMPTY' };
  if (text.length > MAX_IMPORT_BYTES) return { ok: false, error: 'TOO_BIG' };
  let obj; try { obj = JSON.parse(text); } catch { return { ok: false, error: 'NOT_JSON' }; }
  const bundle = obj && obj.format === EXPORT_FORMAT;
  if (bundle && obj.version !== 1) return { ok: false, error: 'NEWER_FORMAT' };
  const v = validateCase(bundle ? obj.case : obj); if (!v.ok) return v;
  const photos = {};
  if (bundle && obj.photos && typeof obj.photos === 'object' && !Array.isArray(obj.photos)) {
    for (const [k, val] of Object.entries(obj.photos)) {
      const m = /^(photo|docphoto):([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/.exec(k);
      if (m && m[2] === v.case.id && typeof val === 'string' && val.startsWith('data:image/')) photos[k] = val; // only this case's own images, only images
    }
  }
  return { ok: true, case: v.case, photos };
}
/** The text of an export: the whole case plus the photos this phone holds for it. `photoOf(key)` returns a data URL or null. */
export function buildExport(c, photoOf = () => null, now = new Date()) {
  const photos = {};
  (c.identity?.photos ?? []).forEach((_, i) => { const k = `photo:${c.id}.${i}`; const d = photoOf(k); if (d) photos[k] = d; });
  for (const d of c.documents ?? []) { const k = `docphoto:${c.id}.${d.id}`; const p = photoOf(k); if (p) photos[k] = p; }
  return JSON.stringify({ format: EXPORT_FORMAT, version: 1, exportedAt: now.toISOString(), case: c, photos }, null, 1);
}

const count = (a) => (Array.isArray(a) ? a.length : 0);
/** What the owner is shown for one copy. Counts only, taken from the case itself. */
export function describe(c) {
  return { id: c.id, name: c.identity?.workingName || '', rev: c.rev ?? 0, updatedAt: c.updatedAt, createdAt: c.createdAt, events: count(c.events), conversations: count(c.conversations), candidates: count(c.candidates), ledger: count(c.ledger), corrections: (c.candidates ?? []).filter((x) => x.state === 'CORRECTED').length, rejected: (c.candidates ?? []).filter((x) => x.state === 'REJECTED').length, offers: count(c.offers), factAudit: count(c.factAudit), documents: count(c.documents), photos: count(c.identity?.photos) };
}
const isPrefix = (a, b) => a.length <= b.length && a.every((e, i) => canonical(e) === canonical(b[i]));
/** How two copies of the same case relate. INCOMING_AHEAD: the incoming copy only adds to the local one. LOCAL_AHEAD: the reverse. DIVERGED: both changed. Informational only: nothing is merged. */
export function relation(local, incoming) {
  if (digest(local) === digest(incoming)) return 'IDENTICAL';
  const a = local.events ?? []; const b = incoming.events ?? [];
  if (isPrefix(a, b)) return 'INCOMING_AHEAD';
  if (isPrefix(b, a)) return 'LOCAL_AHEAD';
  return 'DIVERGED';
}

/** Where a copy came from, stored on the copy so importing the same file again never makes a second copy. */
const provenance = (incoming, source) => ({ id: incoming.id, digest: digest(incoming), sourceRev: incoming.rev ?? 0, source });

/** Decides, for each incoming case, what recovery would do. Does not change anything. status: NEW | ALREADY_HERE | ALREADY_KEPT | DIFFERENT. */
export function planRecovery(localCases, incomingList) {
  const locals = Object.values(localCases ?? {});
  return incomingList.map((incoming) => {
    const local = localCases?.[incoming.id];
    const base = { id: incoming.id, incoming: describe(incoming) };
    if (!local) {
      const kept = locals.find((l) => l.recoveredFrom?.id === incoming.id && l.recoveredFrom?.digest === digest(incoming));
      return kept ? { ...base, status: 'ALREADY_KEPT', keptAs: kept.id } : { ...base, status: 'NEW' };
    }
    const rel = relation(local, incoming);
    if (rel === 'IDENTICAL') return { ...base, status: 'ALREADY_HERE', local: describe(local) };
    const kept = locals.find((l) => l.recoveredFrom?.id === incoming.id && l.recoveredFrom?.digest === digest(incoming));
    if (kept) return { ...base, status: 'ALREADY_KEPT', keptAs: kept.id, local: describe(local), relation: rel };
    return { ...base, status: 'DIFFERENT', relation: rel, local: describe(local) };
  });
}

/** Adds ONE incoming case. Returns { cases, id, action } where cases is a new map (the input is untouched).
 *  NEW -> stored as it came (same id). DIFFERENT with choice 'keep-both' -> stored under a new id, the local copy is left exactly as it was. Anything else -> nothing changes. */
export function applyRecovery(localCases, incoming, { choice = 'skip', source = 'server', now = new Date() } = {}) {
  const [plan] = planRecovery(localCases, [incoming]);
  const cases = { ...localCases };
  if (plan.status === 'NEW') { cases[incoming.id] = { ...clone(incoming), recoveredFrom: provenance(incoming, source) }; return { cases, id: incoming.id, action: 'ADDED', plan }; }
  if (plan.status === 'DIFFERENT' && choice === 'keep-both') {
    let id = `${incoming.id}-rec-${now.getTime().toString(36)}`.slice(0, 80); let n = 1; while (cases[id]) id = `${incoming.id}-rec-${now.getTime().toString(36)}${n++}`.slice(0, 80);
    const label = incoming.identity?.workingName || 'Case';
    cases[id] = { ...clone(incoming), id, rev: 0, identity: { ...clone(incoming.identity), workingName: `${label} (copie récupérée)` }, recoveredFrom: provenance(incoming, source) };
    return { cases, id, action: 'KEPT_BOTH', plan };
  }
  return { cases, id: plan.keptAs ?? incoming.id, action: plan.status === 'DIFFERENT' ? 'SKIPPED' : plan.status, plan };
}

/** The photo keys to copy when a case is stored under a different id than the one its photos were saved with. */
export function photoKeysFor(c, fromId) {
  const keys = []; (c.identity?.photos ?? []).forEach((_, i) => keys.push(`photo:${fromId}.${i}`));
  for (const d of c.documents ?? []) if (d.id !== undefined) keys.push(`docphoto:${fromId}.${d.id}`);
  return keys;
}
