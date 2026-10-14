// The cross-module trace ledger (requirement 18). Append-only, tenant-scoped, hash-chained: every handoff, decision, approval, refusal and error is one entry.
// It records WHAT crossed a module boundary and WHY; it is not a copy of the data (facts are summarised, secrets and raw payloads never enter).
import { createHash } from 'node:crypto';
import { ERR, fail, deepFreeze } from './constants.js';

const clone = (v) => (v === undefined ? null : JSON.parse(JSON.stringify(v)));
const sha = (s) => createHash('sha256').update(s).digest('hex');
const canonical = (v) => JSON.stringify(v, (k, x) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => (a < b ? -1 : 1))) : x));
const OUTCOMES = new Set(['OK', 'BLOCKED', 'REVIEW_REQUIRED', 'APPROVAL_REQUIRED', 'ERROR', 'MODULE_NOT_AVAILABLE', 'NEEDS_CLARIFICATION']);

export function createTraceLedger({ tenant_id, now = () => new Date().toISOString() }) {
  if (!tenant_id) fail(ERR.TENANT_MISMATCH, 'a tenant id is required');
  const entries = [];
  function append(e) {
    if (e.tenant_id !== undefined && e.tenant_id !== tenant_id) fail(ERR.TENANT_MISMATCH, 'entry for another tenant refused');
    if (!OUTCOMES.has(e.outcome)) fail(ERR.HANDOFF_INVALID, `unknown outcome ${e.outcome}`);
    if (!e.workflow_id || !e.source_module || !e.action) fail(ERR.HANDOFF_INVALID, 'workflow_id, source_module and action are required');
    const prev = entries.at(-1)?.hash ?? 'GENESIS';
    const body = {
      seq: entries.length + 1, tenant_id, at: now(), workflow_id: e.workflow_id,
      initiated_by: e.initiated_by ?? null, source_module: e.source_module, destination_module: e.destination_module ?? null, action: e.action,
      entity_refs: clone(e.entity_refs ?? []), facts: clone(e.facts ?? []), decision: clone(e.decision), approval: clone(e.approval),
      outcome: e.outcome, result: clone(e.result), error: clone(e.error), prev,
    };
    const entry = deepFreeze({ ...body, hash: sha(prev + canonical(body)) });
    entries.push(entry);
    return entry;
  }
  const list = (filter = {}) => entries.filter((x) => (!filter.workflow_id || x.workflow_id === filter.workflow_id) && (!filter.module || x.source_module === filter.module || x.destination_module === filter.module));
  function verify() {
    let prev = 'GENESIS';
    for (const x of entries) {
      const { hash, ...body } = x;
      if (body.prev !== prev || sha(prev + canonical(body)) !== hash) return { ok: false, broken_at: x.seq };
      prev = hash;
    }
    return { ok: true, length: entries.length };
  }
  return Object.freeze({ tenant_id, append, list, verify, size: () => entries.length });
}

/** A fact summary for the ledger: provenance and source stay, large payloads do not. */
export const factSummary = (name, fact) => ({ name, value: fact.value, provenance: fact.provenance, source_module: fact.source_module, currency: fact.currency ?? null });
