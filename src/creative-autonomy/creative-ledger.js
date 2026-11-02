// The Creative ledger: accepted tenant media policies, atomic spending reservations and the media-transmission audit trail.
// ONE contract, two implementations:
//   createSupabaseCreativeLedger  - production: the SECURITY DEFINER functions of supabase/migrations/20261102120000_creative_media_policy_spend_ledger.sql.
//                                   Atomicity comes from PostgreSQL (per tenant-month advisory lock, primary keys, unique constraints), so it holds
//                                   across every application instance sharing the database.
//   createMemoryCreativeLedger    - offline tests and local diagnostics ONLY (one process). It is never authoritative (`durable: false`) and the
//                                   production entrypoint refuses it unless the caller explicitly declares a non-production run.
// A spending reservation is an APPLICATION ceiling; it is not provider billing (the real invoice is checked in the provider console).
import { createHash } from 'node:crypto';

export const LEDGER_EVENT = Object.freeze({
  AUTHORIZED: 'AUTHORIZED', RESERVED: 'RESERVED', ATTEMPTED: 'ATTEMPTED', SENT: 'SENT', SUCCEEDED: 'SUCCEEDED', FAILED: 'FAILED', CANCELLED: 'CANCELLED',
});
export const MEDIA_OPERATIONS = Object.freeze(['VISION_CRITIQUE', 'IMAGE_EDIT']);

export class CreativeLedgerUnavailable extends Error {
  constructor(fn) { super(`CREATIVE_LEDGER_UNAVAILABLE: ${fn}`); this.name = 'CreativeLedgerUnavailable'; this.code = 'CREATIVE_LEDGER_UNAVAILABLE'; }
}
const iso = (d) => (d instanceof Date ? d : new Date(d ?? Date.now())).toISOString();

/** Production ledger over a Supabase client exposing rpc(fn, args). Any transport error fails CLOSED (CreativeLedgerUnavailable): never a guess. */
export function createSupabaseCreativeLedger({ supabase }) {
  if (!supabase || typeof supabase.rpc !== 'function') throw new TypeError('the Creative ledger needs a Supabase client with rpc()');
  const rpc = async (fn, args) => {
    let out;
    try { out = await supabase.rpc(fn, args); } catch { throw new CreativeLedgerUnavailable(fn); } // the error body may echo parameters: never kept
    if (out === null || typeof out !== 'object') throw new CreativeLedgerUnavailable(fn);
    return out;
  };
  return Object.freeze({
    kind: 'SUPABASE', durable: true,
    acceptPolicy: ({ merchantId, actorId, policy, now }) => rpc('creative_media_policy_accept', { p_merchant: merchantId, p_actor: actorId, p_policy_id: policy.policy_id, p_content: policy, p_now: iso(now) }),
    revokePolicy: ({ merchantId, actorId, policyId, now }) => rpc('creative_media_policy_revoke', { p_merchant: merchantId, p_actor: actorId, p_policy_id: policyId, p_now: iso(now) }),
    currentPolicy: async ({ merchantId, policyId }) => {
      let out;
      try { out = await supabase.rpc('creative_media_policy_current', { p_merchant: merchantId, p_policy_id: policyId }); } catch { throw new CreativeLedgerUnavailable('creative_media_policy_current'); }
      return out ?? null;
    },
    reserve: ({ merchantId, runId, policyId, policyVersion, ceilingEur, now }) => rpc('creative_spend_reserve', { p_merchant: merchantId, p_run_id: runId, p_policy_id: policyId, p_policy_version: policyVersion, p_ceiling_eur: ceilingEur, p_now: iso(now) }),
    settle: ({ merchantId, runId, settledEur, basis, now }) => rpc('creative_spend_settle', { p_merchant: merchantId, p_run_id: runId, p_settled_eur: settledEur, p_basis: basis, p_now: iso(now) }),
    release: ({ merchantId, runId, reason, now }) => rpc('creative_spend_release', { p_merchant: merchantId, p_run_id: runId, p_reason: reason, p_now: iso(now) }),
    reconcileStale: ({ merchantId, olderThan, now }) => rpc('creative_spend_reconcile_stale', { p_merchant: merchantId, p_older_than: iso(olderThan), p_now: iso(now) }),
    record: (e) => rpc('creative_media_transmission_record', {
      p_merchant: e.merchantId, p_run_id: e.runId, p_operation: e.operation, p_attempt_ref: e.attemptRef, p_event: e.event, p_policy_id: e.policyId,
      p_policy_version: e.policyVersion, p_authorization_id: e.authorizationId, p_source_sha256: e.sourceSha256, p_provider_id: e.providerId, p_region: e.region,
      p_request_id: e.requestId ?? null, p_detail: e.detail ?? {}, p_now: iso(e.now),
    }),
  });
}

/**
 * In-memory ledger with the SAME rules as the SQL functions, serialised by a promise chain (one process only).
 * members: Map(merchantId -> Map(userId -> role)) of ACTIVE memberships.
 */
export function createMemoryCreativeLedger({ members = new Map() } = {}) {
  const policies = []; const reservations = new Map(); const events = [];
  let chain = Promise.resolve();
  const serial = (fn) => { const p = chain.then(fn); chain = p.catch(() => {}); return p; };
  const roleOf = (m, u) => members.get(m)?.get(u) ?? null;
  const current = (m, id) => policies.find((p) => p.merchant_id === m && p.policy_id === id && !p.superseded_at && !p.revoked_at) ?? null;
  const shaOf = (o) => createHash('sha256').update(JSON.stringify(o)).digest('hex');
  const monthOf = (now) => iso(now).slice(0, 7);
  const key = (m, r) => `${m}\u0000${r}`;
  const attempted = (m, r) => events.some((e) => e.merchantId === m && e.runId === r && e.event === 'ATTEMPTED');
  return Object.freeze({
    kind: 'MEMORY', durable: false,
    snapshot: () => structuredClone({ policies, reservations: [...reservations.values()], events }),
    acceptPolicy: ({ merchantId, actorId, policy, now }) => serial(() => {
      const role = roleOf(merchantId, actorId);
      if (!['OWNER', 'ADMIN'].includes(role)) return { status: 'REFUSED', reason: 'ACTOR_NOT_TENANT_ADMIN' };
      if (policy?.tenant?.merchant_id !== merchantId) return { status: 'REFUSED', reason: 'TENANT_MISMATCH' };
      const run = Number(policy?.spend?.per_run_max); const month = Number(policy?.spend?.monthly_max);
      if (!Number.isFinite(run) || !Number.isFinite(month) || run < 0 || month < run || policy.spend.currency !== 'EUR') return { status: 'REFUSED', reason: 'SPEND_LIMITS_INVALID' };
      const sha = shaOf(policy); const cur = current(merchantId, policy.policy_id);
      if (cur && cur.content_sha256 === sha) return { status: 'ALREADY_ACCEPTED', version: cur.version, content_sha256: sha };
      if (cur) cur.superseded_at = iso(now);
      const version = 1 + Math.max(0, ...policies.filter((p) => p.merchant_id === merchantId && p.policy_id === policy.policy_id).map((p) => p.version));
      policies.push({ merchant_id: merchantId, policy_id: policy.policy_id, version, content: structuredClone(policy), content_sha256: sha, per_run_max_eur: run, monthly_max_eur: month,
        accepted_by: actorId, accepted_role: role, accepted_at: iso(now), superseded_at: null, revoked_at: null, revoked_by: null });
      return { status: 'ACCEPTED', version, content_sha256: sha };
    }),
    revokePolicy: ({ merchantId, actorId, policyId, now }) => serial(() => {
      if (!['OWNER', 'ADMIN'].includes(roleOf(merchantId, actorId))) return { status: 'REFUSED', reason: 'ACTOR_NOT_TENANT_ADMIN' };
      const cur = current(merchantId, policyId); if (!cur) return { status: 'NOTHING_TO_REVOKE' };
      cur.revoked_at = iso(now); cur.revoked_by = actorId; return { status: 'REVOKED', version: cur.version };
    }),
    currentPolicy: ({ merchantId, policyId }) => serial(() => {
      const c = current(merchantId, policyId); if (!c) return null;
      return { version: c.version, content: structuredClone(c.content), content_sha256: c.content_sha256, accepted_by: c.accepted_by, accepted_role: c.accepted_role,
        accepted_at: c.accepted_at, per_run_max_eur: c.per_run_max_eur, monthly_max_eur: c.monthly_max_eur };
    }),
    reserve: ({ merchantId, runId, policyId, policyVersion, ceilingEur, now }) => serial(() => {
      if (!(ceilingEur > 0)) return { status: 'REFUSED', reason: 'CEILING_INVALID' };
      const existing = reservations.get(key(merchantId, runId));
      if (existing) return existing.ceiling_eur === ceilingEur && existing.policy_id === policyId && existing.policy_version === policyVersion
        ? { status: 'ALREADY_RESERVED', run_status: existing.status, ceiling_eur: existing.ceiling_eur } : { status: 'REFUSED', reason: 'RUN_ID_ALREADY_USED_WITH_OTHER_TERMS' };
      const pol = policies.find((p) => p.merchant_id === merchantId && p.policy_id === policyId && p.version === policyVersion);
      if (!pol || pol.superseded_at || pol.revoked_at) return { status: 'REFUSED', reason: 'POLICY_NOT_IN_FORCE' };
      if (ceilingEur > pol.per_run_max_eur) return { status: 'REFUSED', reason: 'PER_RUN_LIMIT' };
      const m = monthOf(now);
      const committed = [...reservations.values()].filter((r) => r.merchant_id === merchantId && r.month === m)
        .reduce((s, r) => s + (['RESERVED', 'RECONCILE_REQUIRED'].includes(r.status) ? r.ceiling_eur : r.status === 'SETTLED' ? r.settled_eur : 0), 0);
      if (committed + ceilingEur > pol.monthly_max_eur + 1e-9) return { status: 'REFUSED', reason: 'MONTHLY_LIMIT', committed_eur: committed, monthly_max_eur: pol.monthly_max_eur };
      reservations.set(key(merchantId, runId), { merchant_id: merchantId, run_id: runId, policy_id: policyId, policy_version: policyVersion, month: m, ceiling_eur: ceilingEur,
        status: 'RESERVED', settled_eur: null, settlement_basis: null, release_reason: null, created_at: iso(now), updated_at: iso(now) });
      return { status: 'RESERVED', ceiling_eur: ceilingEur, committed_eur: committed + ceilingEur, monthly_max_eur: pol.monthly_max_eur };
    }),
    settle: ({ merchantId, runId, settledEur, basis, now }) => serial(() => {
      const r = reservations.get(key(merchantId, runId)); if (!r) return { status: 'REFUSED', reason: 'NO_RESERVATION' };
      if (r.status === 'SETTLED') return r.settled_eur === settledEur && r.settlement_basis === basis ? { status: 'ALREADY_SETTLED' } : { status: 'REFUSED', reason: 'ALREADY_SETTLED_WITH_OTHER_AMOUNT' };
      if (r.status === 'RELEASED') return { status: 'REFUSED', reason: 'RELEASED' };
      if (!(settledEur >= 0)) return { status: 'REFUSED', reason: 'AMOUNT_INVALID' };
      Object.assign(r, { status: 'SETTLED', settled_eur: settledEur, settlement_basis: basis, updated_at: iso(now) });
      return { status: 'SETTLED', settled_eur: settledEur, over_ceiling: settledEur > r.ceiling_eur };
    }),
    release: ({ merchantId, runId, reason, now }) => serial(() => {
      const r = reservations.get(key(merchantId, runId)); if (!r) return { status: 'REFUSED', reason: 'NO_RESERVATION' };
      if (r.status === 'RELEASED') return { status: 'ALREADY_RELEASED' };
      if (r.status !== 'RESERVED') return { status: 'REFUSED', reason: `NOT_RELEASABLE_${r.status}` };
      if (attempted(merchantId, runId)) return { status: 'REFUSED', reason: 'MEDIA_WAS_ATTEMPTED_SETTLE_INSTEAD' };
      Object.assign(r, { status: 'RELEASED', release_reason: reason, updated_at: iso(now) }); return { status: 'RELEASED' };
    }),
    reconcileStale: ({ merchantId, olderThan, now }) => serial(() => {
      let released = 0; let flagged = 0;
      for (const r of reservations.values()) {
        if (r.merchant_id !== merchantId || r.status !== 'RESERVED' || !(r.updated_at < iso(olderThan))) continue;
        if (attempted(merchantId, r.run_id)) { r.status = 'RECONCILE_REQUIRED'; flagged += 1; } else { Object.assign(r, { status: 'RELEASED', release_reason: 'STALE_NO_ATTEMPT' }); released += 1; }
        r.updated_at = iso(now);
      }
      return { released, reconcile_required: flagged };
    }),
    record: (e) => serial(() => {
      const r = reservations.get(key(e.merchantId, e.runId)); if (!r) return { status: 'REFUSED', reason: 'NO_RESERVATION' };
      const same = (x) => x.merchantId === e.merchantId && x.runId === e.runId && x.operation === e.operation;
      if (e.event === 'ATTEMPTED') {
        if (r.status !== 'RESERVED') return { status: 'REFUSED', reason: 'RESERVATION_NOT_LIVE' };
        if (!events.some((x) => same(x) && x.event === 'AUTHORIZED' && x.sourceSha256 === e.sourceSha256 && x.policyId === e.policyId && x.policyVersion === e.policyVersion))
          return { status: 'REFUSED', reason: 'NOT_AUTHORIZED_FOR_THIS_SOURCE' };
      } else if (['SENT', 'SUCCEEDED', 'FAILED'].includes(e.event)) {
        if (!events.some((x) => same(x) && x.attemptRef === e.attemptRef && x.event === 'ATTEMPTED')) return { status: 'REFUSED', reason: 'NO_ATTEMPT' };
      }
      if (events.some((x) => same(x) && x.attemptRef === e.attemptRef && x.event === e.event)) return { status: 'DUPLICATE' };
      events.push(Object.freeze({ ...e, requestId: e.requestId ?? null, detail: e.detail ?? {}, now: iso(e.now) }));
      return { status: 'RECORDED' };
    }),
  });
}
