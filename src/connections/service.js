// Settings -> Connections: the SERVICE that turns the registry + the real connection state into what the page shows. It reuses ConnectionCenterService (the connections, the OAuth flow,
// the explicit target choice, the verification) and the secret-free Activation view; it adds the catalogue, the honest state wording, the remaining steps and the rights.
//
//   - Every connection shown is built from an ALLOWLIST of fields: no token, code, state or verifier can reach the page (and findSecretLeaks double-checks the whole payload).
//   - Several connections of the same provider coexist (two Shopify shops, several bank accounts, two Instagram accounts); none is ever picked implicitly.
//   - Reading is for any session of the merchant; connecting, verifying, reconnecting, disconnecting are OWNER / ADMIN only (decided here AND by the host).
import { findSecretLeaks } from '../provider-connections/validation.js';
import { ACCESS_FR, CAPABILITY, STATUS_FR } from './registry.js';

export const WRITER_ROLES = new Set(['OWNER', 'ADMIN']);
const PUBLISH_SCOPE = /publish|manage_(?!insights)|business\.manage/i; // any write-capable permission

const STATE_FR = Object.freeze({
  VERIFIED: 'Connecté, vérifié', CONNECTED: 'Connecté, à vérifier', REAUTH_REQUIRED: 'Reconnexion nécessaire', NOT_CONFIGURED: 'Non connecté', MISCONFIGURED: 'À corriger', UNAVAILABLE: 'Indisponible',
  LINKED: 'Boutique liée', SYNC_OK: 'Dernière synchronisation réussie', SYNC_FAILED: 'Dernière synchronisation en échec', SYNC_NONE: 'Aucune synchronisation enregistrée',
});
const TONE = Object.freeze({ VERIFIED: 'ok', LINKED: 'ok', SYNC_OK: 'ok', CONNECTED: 'warn', SYNC_NONE: 'warn', REAUTH_REQUIRED: 'warn', NOT_CONFIGURED: 'neutral', MISCONFIGURED: 'bad', UNAVAILABLE: 'bad', SYNC_FAILED: 'bad' });

const capabilityList = (ids) => ids.map((id) => ({ id, label: CAPABILITY[id] }));
const accountOf = (c) => c.external_display_name || c.external_id || 'Compte sans nom';

/**
 * @param {{ registry, center?, connectorRepository?, appConfigPresent?: (providerKey)=>boolean, appEnvNames?: object, redirectUriOf?: (providerKey)=>string|null,
 *           shopifySync?: (merchantId)=>Promise<object|null>, bankCatalog?: object[], bankProvider?: object, now?: ()=>Date }} deps
 */
export function createConnectionsService({
  registry, center = null, connectorRepository = null, appConfigPresent = () => false, appEnvNames = {}, redirectUriOf = () => null, shopifySync = async () => null, bankCatalog = [], bankProvider = null, now = () => new Date(),
}) {
  const actionsFor = (role, state) => {
    if (!WRITER_ROLES.has(role)) return [];
    if (state === 'NOT_CONFIGURED') return ['reconnect'];
    return ['verify', 'reconnect', 'disconnect'];
  };

  async function oauthConnections(provider, all, role) {
    return all.filter((c) => c.provider === provider.providerKey).map((c) => {
      const readiness = c.live_readiness?.level ?? 'NOT_CONFIGURED';
      const key = c.connection_state === 'REAUTH_REQUIRED' ? 'REAUTH_REQUIRED' : c.connection_state === 'NOT_CONFIGURED' ? 'NOT_CONFIGURED' : c.connection_state === 'MISCONFIGURED' ? 'MISCONFIGURED' : c.connection_state === 'UNAVAILABLE' ? 'UNAVAILABLE'
        : (readiness === 'VERIFIED' || readiness === 'PRODUCTION_ELIGIBLE') ? 'VERIFIED' : 'CONNECTED';
      const scopes = [...(c.grant?.scopes?.length ? c.grant.scopes : c.granted_scopes ?? [])];
      return {
        id: c.connector_id, account: accountOf(c), accountId: c.external_id, accountType: c.account_state ?? null,
        state: key, stateLabel: STATE_FR[key], tone: TONE[key], verifiedAt: c.last_verified_at ?? null,
        scopes, readOnly: scopes.length > 0 && !scopes.some((s) => PUBLISH_SCOPE.test(s)),
        needs: [...(c.review_signals ?? [])].filter((s) => ['REAUTH_REQUIRED', 'NO_CREDENTIAL', 'SCOPES_MISSING'].includes(s)),
        actions: actionsFor(role, key),
      };
    });
  }

  async function shopifyConnections(merchantId) {
    if (!connectorRepository) return [];
    const rows = (await connectorRepository.listForMerchant(merchantId)).filter((c) => c.kind === 'shopify');
    const sync = rows.length ? await shopifySync(merchantId).catch(() => null) : null;
    return rows.map((c) => {
      const linked = c.status === 'CONFIGURED';
      const key = !linked ? 'MISCONFIGURED' : 'LINKED';
      return {
        id: c.id, account: c.external_domain || c.external_id || 'Boutique', accountId: c.external_id, accountType: null,
        state: key, stateLabel: STATE_FR[key], tone: TONE[key], verifiedAt: null, scopes: [], readOnly: false, needs: [], actions: [],
        // The REAL last sync (sync_runs), never a guess: it is what proves the link works.
        sync: sync ? { status: sync.status === 'ok' || sync.status === 'success' || sync.status === 'completed' ? 'SYNC_OK' : sync.status === 'running' ? 'SYNC_NONE' : 'SYNC_FAILED', label: sync.status === 'running' ? 'Synchronisation en cours' : (sync.status === 'ok' || sync.status === 'success' || sync.status === 'completed' ? STATE_FR.SYNC_OK : STATE_FR.SYNC_FAILED), at: sync.finishedAt ?? sync.startedAt ?? null } : { status: 'SYNC_NONE', label: STATE_FR.SYNC_NONE, at: null },
      };
    });
  }

  function setupOf(p, role) {
    if (p.status === 'PLANNED') return { state: 'PLANNED', label: 'Prévu', detail: 'Pas encore de parcours de connexion.', steps: [], canConnect: false };
    if (p.status === 'WAITING') return { state: 'WAITING', label: 'En attente', detail: p.holdReason ?? null, steps: p.steps, canConnect: false };
    if (p.source === 'shopify') return { state: 'READY', label: 'Gérée par la synchronisation existante', detail: null, steps: [], canConnect: false };
    if (p.source === 'oauth') {
      const ready = appConfigPresent(p.providerKey);
      const names = Object.values(appEnvNames[p.providerKey] ?? {});
      return ready
        ? { state: 'READY', label: 'Prêt à connecter', detail: null, steps: [], canConnect: WRITER_ROLES.has(role) }
        : {
          state: 'APP_MISSING', label: `Application ${p.appName ?? p.label} à configurer`, detail: `L’application ${p.appName ?? p.label} de Nordla n’est pas encore enregistrée sur ce serveur : la connexion est impossible tant qu’elle manque.`, canConnect: false,
          steps: [
            { label: `Créer l’application ${p.appName ?? p.label} et ajouter le compte de la boutique comme testeur`, owner: 'owner', done: false },
            { label: `Déclarer cette adresse de retour : ${redirectUriOf(p.providerKey) ?? '(adresse du service)'}`, owner: 'owner', done: false },
            { label: `Poser sur le service Nordla les variables ${names.join(', ')}${p.providerKey === 'instagram' ? ' et INSTAGRAM_GRAPH_API_VERSION' : ''}`, owner: 'owner', done: false },
          ],
        };
    }
    return { state: 'READY', label: '', detail: null, steps: [], canConnect: false };
  }

  return Object.freeze({
    /** The whole page: categories -> providers -> connections, with the real state. `role` decides the actions offered (the host re-checks them). */
    async overview({ tenant, role }) {
      const merchantId = tenant.merchantId;
      const all = center ? await center.listConnections({ tenant }) : [];
      const out = [];
      for (const cat of registry.categories()) {
        const providers = [];
        for (const p of cat.providers) {
          const connections = p.source === 'oauth' && p.status === 'AVAILABLE' ? await oauthConnections(p, all, role) : p.source === 'shopify' ? await shopifyConnections(merchantId) : [];
          const setup = setupOf(p, role);
          providers.push({
            id: p.id, label: p.label, category: p.category, status: p.status, statusLabel: STATUS_FR[p.status], description: p.description, access: p.access, accessLabel: ACCESS_FR[p.access],
            capabilities: capabilityList(p.capabilities), multiCapability: p.capabilities.length > 1, multiAccount: p.multiAccount, setup, connections,
            canAddAccount: p.source === 'oauth' && p.status === 'AVAILABLE' && setup.canConnect && p.multiAccount,
            ...(p.source === 'bank' ? { bank: { provider: bankProvider, banks: bankCatalog.map((b) => ({ key: b.key, label: b.label, group: b.group, notes: b.notes ?? [], aliasOf: b.aliasOf ?? null })), pilot: 'kbc' } } : {}),
          });
        }
        out.push({ id: cat.id, label: cat.label, providers });
      }
      const payload = { generatedAt: now().toISOString(), role, canManage: WRITER_ROLES.has(role), categories: out };
      const leaks = findSecretLeaks(payload);
      if (leaks.length) throw new Error('CONNECTIONS_PAYLOAD_LEAK'); // never sent: a secret-shaped value would reach the browser
      return payload;
    },
    providerOf: (id) => registry.get(id),
  });
}
