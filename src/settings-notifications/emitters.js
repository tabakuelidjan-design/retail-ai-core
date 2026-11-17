// Event sources of Paramètres -> Notifications. ONE source is wired end to end: "Connexion à renouveler".
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
    const items = await listConnections({ tenant: { merchantId, source: 'notifications' } });
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
