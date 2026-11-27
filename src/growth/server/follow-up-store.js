'use strict';
// Growth follow-up kept SERVER-SIDE, per merchant: the plans, applied actions and review results of Opportunités ("follow-up") and the
// requests / quotes / sales of « Suite commerciale » ("pipeline"). One row per browser-storage key of the UI, so the screen's own
// logic is unchanged: it reads and writes the same entries, only the place they live is different.
//
// Isolation: EVERY call takes the merchant id of the caller (the Core session's merchant, never a request value) and filters on it. A key can
// only be written under the merchant's own history scope (sha256 of its id, the one the page already carries): see followUpKeyOk.
// Concurrency: each entry has a version. A write names the version it read (0 = "I believe it does not exist"); a different current version is
// refused with VERSION_CONFLICT and the current entry, so two browsers never overwrite each other silently.
//
// Table (supabase/migrations-pending/20261116100000_growth_follow_up.sql): growth_follow_up(merchant_id, entry_key, value jsonb, version, updated_at, updated_by).

export const MAX_ENTRY_BYTES = 256 * 1024;
export const MAX_ENTRIES = 5000;
const KEY = /^nordla\.growth\.(follow-up|pipeline|agent|goals)\.v1:([0-9a-f]{64})(?::((?:[A-Za-z0-9_.:@/-]|%[0-9A-Fa-f]{2}){1,200}))?$/; // the screen writes encodeURIComponent(id): a product id "product:<uuid>" arrives as "product%3A<uuid>"

/** Is this key one of the follow-up keys of THIS merchant's scope? follow-up keys carry an opportunity id; the pipeline and agent-draft keys carry none. */
export function followUpKeyOk(key, historyScope) {
  if (typeof key !== 'string' || key.length > 400 || typeof historyScope !== 'string' || !/^[0-9a-f]{64}$/.test(historyScope)) return false;
  const m = KEY.exec(key);
  if (!m || m[2] !== historyScope) return false;
  return m[1] === 'follow-up' ? Boolean(m[3]) : !m[3];
}

// A4 - the Stratège drafts (A3) and the human decision on them. The key carries NO opportunity id. Draft ids are checked here, on the server.
export const AGENT_DRAFT_PREFIX = 'nordla.growth.agent.v1:';
export const agentDraftKey = (scope) => AGENT_DRAFT_PREFIX + scope;
export const REVIEW_STATUSES = Object.freeze(['validated', 'rejected']);
export const isDraftId = (id) => typeof id === 'string' && /^[A-Za-z0-9_-]{8,64}$/.test(id);
/** The state of a draft: 'to_validate' (A3, before A4) and a missing state both mean pending. */
export function normalizeDraftState(state) { return state === 'validated' || state === 'rejected' ? state : 'pending'; }
/** The id of a draft. Drafts written before A4 have none: their id is derived from their date (the same rule as the page). */
export function draftId(d) { return typeof d?.id === 'string' && isDraftId(d.id) ? d.id : `a${String(d?.at ?? '').replace(/\D/g, '')}`; }
const DRAFT_STATES = ['to_validate', 'pending', 'validated', 'rejected'];
// A5: the priority reference is the priority's own id (up to 200 characters, no control character) and nothing else
const validPriorityRef = (r) => Boolean(r) && typeof r === 'object' && !Array.isArray(r) && Object.keys(r).every((k) => k === 'id') && typeof r.id === 'string' && r.id.length > 0 && r.id.length <= 200 && !/[\u0000-\u001f]/.test(r.id);
const validDraft = (d) => Boolean(d) && typeof d === 'object' && !Array.isArray(d) && (d.state === undefined || DRAFT_STATES.includes(d.state)) && (d.id === undefined || isDraftId(d.id)) && (d.priorityRef === undefined || validPriorityRef(d.priorityRef));

/** A value of the shapes the screen writes (an object, a plan history, or the pipeline store), and not larger than MAX_ENTRY_BYTES. Returns an error code or null. */
export function followUpValueError(key, value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return 'VALUE_INVALID';
  let size; try { size = Buffer.byteLength(JSON.stringify(value)); } catch { return 'VALUE_INVALID'; }
  if (size > MAX_ENTRY_BYTES) return 'VALUE_TOO_LARGE';
  if (key.startsWith('nordla.growth.goals.v1:')) {
    // the merchant's objective (Administration): a weekly sales target in whole euros (null = none) and an optional short note. Nothing else.
    const goals = value.goals;
    const ok = value.v === 1 && goals && typeof goals === 'object' && !Array.isArray(goals)
      && Object.keys(goals).every((k) => ['weeklySalesTargetEur', 'note', 'updatedAt'].includes(k))
      && (goals.weeklySalesTargetEur === null || (Number.isInteger(goals.weeklySalesTargetEur) && goals.weeklySalesTargetEur >= 0 && goals.weeklySalesTargetEur <= 100000000))
      && (goals.note === undefined || (typeof goals.note === 'string' && goals.note.length <= 200));
    return ok ? null : 'VALUE_INVALID';
  }
  if (key.startsWith('nordla.growth.agent.v1:')) {
    // the saved drafts of the Stratège agent: at most 10 entries, each already capped by the agent contract
    return value.v === 1 && Array.isArray(value.drafts) && value.drafts.length <= 10 && value.drafts.every(validDraft) ? null : 'VALUE_INVALID';
  }
  if (key.startsWith('nordla.growth.follow-up.v1:')) { if (!Array.isArray(value.events) || value.events.length > 2000 || !value.snapshot || typeof value.snapshot !== 'object') return 'VALUE_INVALID'; return null; }
  return value.v === 1 && value.requests && typeof value.requests === 'object' && !Array.isArray(value.requests) ? null : 'VALUE_INVALID';
}

/** In memory (tests, and the validation account): the same contract as the Supabase store. */
export function createMemoryFollowUpStore() {
  const rows = new Map(); // `${merchant}\u0000${key}` -> { value, version, updated_at, updated_by }
  const k = (m, key) => `${m}\u0000${key}`;
  return {
    async list(merchantId) {
      const out = [];
      for (const [id, r] of rows) { const [m, key] = id.split('\u0000'); if (m === merchantId) out.push({ key, value: structuredClone(r.value), version: r.version, updated_at: r.updated_at }); }
      return out;
    },
    async put(merchantId, key, value, expectedVersion, userId, now = new Date()) {
      const cur = rows.get(k(merchantId, key));
      if ((cur?.version ?? 0) !== expectedVersion) return { ok: false, code: 'VERSION_CONFLICT', current: cur ? { value: structuredClone(cur.value), version: cur.version } : null };
      const version = (cur?.version ?? 0) + 1;
      rows.set(k(merchantId, key), { value: structuredClone(value), version, updated_at: now.toISOString(), updated_by: userId ?? null });
      return { ok: true, version };
    },
  };
}

/** Supabase (the Core database, the table above). Every query carries merchant_id; a write is conditional on the version it read, in ONE statement. */
export function createSupabaseFollowUpStore(supabase, { table = 'growth_follow_up' } = {}) {
  const eq = (v) => `eq.${v}`;
  return {
    async list(merchantId) {
      const rows = await supabase.select(table, { select: 'entry_key,value,version,updated_at', merchant_id: eq(merchantId), order: 'entry_key.asc', limit: String(MAX_ENTRIES) });
      return (rows ?? []).map((r) => ({ key: r.entry_key, value: r.value, version: r.version, updated_at: r.updated_at }));
    },
    async put(merchantId, key, value, expectedVersion, userId, now = new Date()) {
      const stamp = now.toISOString();
      let done;
      if (expectedVersion === 0) {
        done = await supabase.insertIgnoringDuplicates(table, [{ merchant_id: merchantId, entry_key: key, value, version: 1, updated_at: stamp, updated_by: userId ?? null }], { onConflict: 'merchant_id,entry_key' });
      } else {
        done = await supabase.update(table, { merchant_id: eq(merchantId), entry_key: eq(key), version: eq(expectedVersion) }, { value, version: expectedVersion + 1, updated_at: stamp, updated_by: userId ?? null });
      }
      if (Array.isArray(done) && done.length === 1) return { ok: true, version: done[0].version };
      const cur = (await supabase.select(table, { select: 'value,version', merchant_id: eq(merchantId), entry_key: eq(key), limit: '1' }))?.[0] ?? null;
      return { ok: false, code: 'VERSION_CONFLICT', current: cur };
    },
  };
}

// A goal (Administration): the merchant's weekly target is ONE follow-up entry under its own key. This reads this merchant's scope only.
export const goalKey = (scope) => `nordla.growth.goals.v1:${scope}`;
/** The weekly target of this merchant from its follow-up rows, or null (absent, or not a valid goal value). */
export function goalFromRows(rows, scope) {
  const row = (Array.isArray(rows) ? rows : []).find((r) => r && r.key === goalKey(scope)) ?? null;
  if (!row || followUpValueError(row.key, row.value) !== null) return null;
  return row.value.goals ?? null;
}
