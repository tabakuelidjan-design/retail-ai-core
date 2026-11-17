import { createHash } from 'node:crypto';
// Event sources of Paramètres -> Notifications. Two sources are wired: "Connexion à renouveler" (Connexions) and "Action à revoir" (Développement des ventes, see below).
//
// SOURCE. The Connexions centre (src/provider-connections/connection-center.js) already decides, from the stored credential, that a connection is in the state
// REAUTH_REQUIRED (its credential is EXPIRED, set by the provisioning service when a refresh is refused). That state is read here, never recomputed.
// IDEMPOTENCE. The event key is "<connector>:<credential rotation version>": the same expired credential gives the same key on every sweep (a re-run adds nothing),
// and once the person renews the connection the rotation version changes, so a later expiry is a new event.
// ISOLATION. A sweep that fails is logged and ignored: Connexions, Général and every other page never depend on it.
const PROVIDER_LABEL = Object.freeze({ instagram: 'Instagram', tiktok: 'TikTok', google_business_profile: 'Google Business', google_business: 'Google Business', facebook: 'Facebook', meta: 'Meta', shopify: 'Shopify' });
const labelOf = (p) => PROVIDER_LABEL[String(p ?? '').toLowerCase()] ?? String(p ?? '').replace(/[^A-Za-z0-9 _-]/g, '').slice(0, 40);

/** @param {{ service: object, merchantId: string, listConnections: (o: { tenant: object }) => Promise<object[]>, log?: Function }} o */
export function createConnectionReauthEmitter({ service, merchantId, listConnections, log = () => {} }) {
  let running = null;
  async function sweep() {
    const items = await listConnections({ tenant: { merchantId, source: 'env' } });
    const total = { seen: 0, created: 0, duplicate: 0, skipped: 0 };
    for (const c of items) {
      if (c.connection_state !== 'REAUTH_REQUIRED' || !c.connector_id) continue;
      total.seen += 1;
      const r = await service.emit({ merchantId, type: 'connection_reauth', dedupeKey: `connection_reauth:${c.connector_id}:${c.grant?.rotation_version ?? 0}`, data: { provider: labelOf(c.provider) } });
      total.created += r.created; total.duplicate += r.duplicate; total.skipped += r.skipped;
    }
    return total;
  }
  return Object.freeze({
    /** One sweep at a time; a failing sweep resolves to null (and is logged) instead of throwing. */
    async run() {
      if (running) return running;
      running = sweep().catch((e) => { log(`Notifications: sweep failed (${e?.code ?? e?.message ?? e})`); return null; }).finally(() => { running = null; });
      return running;
    },
  });
}

/**
 * SECOND SOURCE: "Action à revoir" (Développement des ventes). The follow-up lives SERVER-SIDE in `growth_follow_up` (one row per opportunity, a list of events); this only READS it.
 * Same reading rule as the Growth screen (opportunities.js): the latest plan, its applied event (planAt = the plan), a planned review date, and no later `review` event.
 * The alert is due when that review date is reached (today in the merchant's time zone). Key = the entry + the plan's timestamp: re-planning is a new event, a replay adds nothing.
 * @param {{ service: object, merchantId: string, listEntries: (merchantId: string) => Promise<Array<{ entry_key: string, value: object }>>, today?: () => string, log?: Function }} o
 */
export function createGrowthReviewEmitter({ service, merchantId, listEntries, today = () => new Date().toISOString().slice(0, 10), log = () => {} }) {
  let running = null;
  const due = (value) => {
    const events = Array.isArray(value?.events) ? value.events : [];
    let planIdx = -1; events.forEach((e, i) => { if (e?.type === 'plan') planIdx = i; });
    if (planIdx < 0) return null;
    const plan = events[planIdx];
    if (typeof plan.reviewDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(plan.reviewDate) || plan.reviewDate > today()) return null;
    if (!events.slice(planIdx + 1).some((e) => e?.type === 'applied' && e.planAt === plan.at)) return null; // not applied yet: nothing to review
    if (events.slice(planIdx + 1).some((e) => e?.type === 'review')) return null; // already reviewed
    return { planAt: String(plan.at ?? ''), action: String(plan.action ?? plan.text ?? '').slice(0, 120) };
  };
  async function sweep() {
    const total = { seen: 0, created: 0, duplicate: 0, skipped: 0 };
    for (const row of await listEntries(merchantId)) {
      if (!String(row.entry_key).startsWith('nordla.growth.follow-up.v1:')) continue;
      const d = due(row.value); if (!d || !d.planAt) continue;
      total.seen += 1;
      const r = await service.emit({ merchantId, type: 'growth_action_review', dedupeKey: `growth_action_review:${createHash('sha256').update(row.entry_key).digest('hex').slice(0, 32)}:${d.planAt}`.slice(0, 200), data: { action: d.action } });
      total.created += r.created; total.duplicate += r.duplicate; total.skipped += r.skipped;
    }
    return total;
  }
  return Object.freeze({ async run() { if (running) return running; running = sweep().catch((e) => { log(`Notifications: growth sweep failed (${e?.code ?? e?.message ?? e})`); return null; }).finally(() => { running = null; }); return running; } });
}

/** Several sources behind the single `run()` the host calls; each one already swallows its own failure. */
export function combineEmitters(list) { const l = list.filter(Boolean); return Object.freeze({ async run() { const out = []; for (const e of l) out.push(await e.run()); return out; } }); }

/**
 * THIRD SOURCE: "Réception d'achat enregistrée" (Stock / Achats). Two paths, ONE alert key per receipt (`receipt_recorded:<receipt id>`):
 *  - handle(event): Stock / Achats publishes GOODS_RECEIVED to its audit outlet AFTER the receipt is committed (service.js receiveGoods); the alert is raised at once;
 *  - run(): catch-up over the receipts of the last `windowMs` (default 3 days), so a receipt committed while Notifications was down or restarting still alerts. A replay adds nothing.
 * Both only READ Stock / Achats (`poOf`, `listReceipts`); a failure is logged and never reaches the receiving person's request (the audit outlet already swallows errors).
 * @param {{ service: object, merchantId: string, poOf: (poId: string) => Promise<{ number: string, status: string, supplierName: string|null }|null>, listReceipts: (merchantId: string) => Promise<Array<{ id: string, poId: string, createdAt: string }>>, windowMs?: number, now?: () => number, log?: Function }} o
 */
export function createReceiptEmitter({ service, merchantId, poOf, listReceipts, windowMs = 3 * 24 * 3600_000, now = () => Date.now(), log = () => {} }) {
  let running = null;
  const raise = async (receiptId, poId, complete) => {
    const po = await poOf(poId).catch(() => null);
    return service.emit({ merchantId, type: 'receipt_recorded', dedupeKey: `receipt_recorded:${receiptId}`, data: { receiptId, ...(po?.number ? { poNumber: String(po.number).slice(0, 40) } : {}), ...(po?.supplierName ? { supplier: String(po.supplierName).slice(0, 60) } : {}), complete: complete === true } });
  };
  return Object.freeze({
    /** The audit outlet of Stock / Achats: GOODS_RECEIVED only, only for this merchant. Never throws. */
    async handle(event) {
      try {
        if (event?.type !== 'GOODS_RECEIVED' || event.merchantId !== merchantId || typeof event.detail?.receiptId !== 'string') return null;
        return await raise(event.detail.receiptId, event.object?.id, event.detail.complete);
      } catch (e) { log(`Notifications: receipt event failed (${e?.code ?? e?.message ?? e})`); return null; }
    },
    async run() {
      if (running) return running;
      running = (async () => {
        const all = (await listReceipts(merchantId)).filter((r) => now() - Date.parse(r.createdAt) <= windowMs);
        const lastOf = new Map(); for (const r of all) if (!lastOf.get(r.poId) || r.createdAt > lastOf.get(r.poId).createdAt) lastOf.set(r.poId, r);
        const total = { seen: 0, created: 0, duplicate: 0, skipped: 0 };
        for (const r of all) { const po = await poOf(r.poId).catch(() => null); const x = await raise(r.id, r.poId, po?.status === 'RECEIVED' && lastOf.get(r.poId)?.id === r.id); total.seen += 1; total.created += x.created; total.duplicate += x.duplicate; total.skipped += x.skipped; }
        return total;
      })().catch((e) => { log(`Notifications: receipt sweep failed (${e?.code ?? e?.message ?? e})`); return null; }).finally(() => { running = null; });
      return running;
    },
  });
}
