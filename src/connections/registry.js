// Settings -> Connections: the EXTENSIBLE REGISTRY of the providers Nordla can connect to. DATA only: nothing here contacts a provider.
//
// Adding a provider = adding ONE entry (defineProvider) to PROVIDERS or passing it to createRegistry({ extra }). The page, the service and the host never name a provider: they read this
// list. A provider declares
//   category     where it appears (CATEGORY)
//   status       AVAILABLE (a journey exists) | WAITING (built or planned but blocked by something outside Nordla, `steps` say what) | PLANNED ("Prévu": no journey yet)
//   source       how its real connections are read: 'oauth' (ConnectionCenterService, one connector per authorised account), 'shopify' (merchant_connectors kind shopify), 'bank' (bank catalogue), null
//   capabilities what ONE connection can do (ONE connection may declare SEVERAL, e.g. Odoo: sales + catalogue + stock + invoicing)
//   multiAccount several accounts / shops / bank accounts of the same provider may coexist (the data model never assumes one)
export const CATEGORY = Object.freeze({
  boutique: Object.freeze({ id: 'boutique', label: 'Boutique', order: 1 }),
  reseaux: Object.freeze({ id: 'reseaux', label: 'Réseaux sociaux', order: 2 }),
  local: Object.freeze({ id: 'local', label: 'Présence locale', order: 3 }),
  banque: Object.freeze({ id: 'banque', label: 'Banque', order: 4 }),
  commerce_gestion: Object.freeze({ id: 'commerce_gestion', label: 'Commerce et gestion', order: 5 }),
});

export const CAPABILITY = Object.freeze({
  sales: 'Ventes', catalog: 'Catalogue', stock: 'Stock', invoicing: 'Facturation',
  profile_read: 'Profil du compte', media_read: 'Publications (lecture)', insights_read: 'Statistiques (lecture)',
  reviews_read: 'Avis (lecture)', bank_accounts_read: 'Comptes bancaires (lecture)', transactions_read: 'Mouvements (lecture)',
});

export const STATUS = Object.freeze({ AVAILABLE: 'AVAILABLE', WAITING: 'WAITING', PLANNED: 'PLANNED' });
export const STATUS_FR = Object.freeze({ AVAILABLE: 'Disponible', WAITING: 'En attente', PLANNED: 'Prévu' });
export const ACCESS_FR = Object.freeze({ READ_ONLY: 'Lecture seule', EXISTING: 'Synchronisation existante', NONE: 'Aucun accès pour l’instant' });
const SOURCES = new Set(['oauth', 'shopify', 'bank', null]);
const ID = /^[a-z][a-z0-9_]{1,39}$/;

/** Validates and freezes one provider definition. Throws on an unknown category / capability / status: a broken entry never reaches the page. */
export function defineProvider(def) {
  const d = { multiAccount: true, access: 'NONE', source: null, steps: [], ...def };
  if (!ID.test(d.id ?? '')) throw new TypeError(`provider id invalid: ${d.id}`);
  if (!CATEGORY[d.category]) throw new TypeError(`provider ${d.id}: unknown category ${d.category}`);
  if (!STATUS[d.status]) throw new TypeError(`provider ${d.id}: unknown status ${d.status}`);
  if (!SOURCES.has(d.source)) throw new TypeError(`provider ${d.id}: unknown source ${d.source}`);
  if (!ACCESS_FR[d.access]) throw new TypeError(`provider ${d.id}: unknown access ${d.access}`);
  if (typeof d.label !== 'string' || !d.label.trim()) throw new TypeError(`provider ${d.id}: label required`);
  for (const c of d.capabilities ?? []) if (!CAPABILITY[c]) throw new TypeError(`provider ${d.id}: unknown capability ${c}`);
  if (d.source === 'oauth' && !d.providerKey) throw new TypeError(`provider ${d.id}: an oauth provider names its providerKey`);
  return Object.freeze({
    ...d, capabilities: Object.freeze([...(d.capabilities ?? [])]), steps: Object.freeze((d.steps ?? []).map((s) => Object.freeze({ ...s }))),
  });
}

// `steps` = what remains, with WHO does it: 'owner' (you), 'provider' (the external company), 'nordla'.
export const PROVIDERS = Object.freeze([
  defineProvider({
    id: 'shopify', label: 'Shopify', category: 'boutique', status: 'AVAILABLE', dataLabel: 'Catalogue, commandes et stock', source: 'shopify', access: 'EXISTING', capabilities: ['catalog', 'sales', 'stock'],
    description: 'Boutique reliée à Nordla par la synchronisation existante (catalogue et commandes). Rien n’est modifié depuis cette page.',
  }),
  defineProvider({
    id: 'instagram', label: 'Instagram', category: 'reseaux', status: 'AVAILABLE', dataLabel: 'Profil, publications et statistiques', source: 'oauth', providerKey: 'instagram', access: 'READ_ONLY', capabilities: ['profile_read', 'media_read', 'insights_read'],
    description: 'Compte professionnel Instagram de la boutique, en lecture seule : profil, publications et statistiques. Nordla ne publie rien.', appName: 'Meta',
  }),
  defineProvider({
    id: 'tiktok', label: 'TikTok', category: 'reseaux', status: 'PLANNED', dataLabel: 'Profil, vidéos et statistiques', source: 'oauth', providerKey: 'tiktok', access: 'READ_ONLY', capabilities: ['profile_read', 'media_read', 'insights_read'],
    description: 'Compte TikTok de la boutique, en lecture seule : profil, vidéos et statistiques. Même parcours qu’Instagram, activé après la validation du premier. Nordla ne publiera rien.', appName: 'TikTok',
  }),
  defineProvider({
    id: 'google_business_profile', label: 'Google Business Profile', category: 'local', status: 'WAITING', dataLabel: 'Fiche et avis', source: 'oauth', providerKey: 'google_business_profile', access: 'NONE', capabilities: ['profile_read', 'reviews_read'],
    description: 'Fiche Google de la boutique. La connexion reste bloquée tant que Google n’a pas accordé l’accès à son API.',
    holdReason: 'Accès à l’API Google en attente (dossier 8-1074000042712).',
    steps: [
      { label: 'Réponse de Google sur l’accès à l’API Business Profile (dossier 8-1074000042712)', owner: 'provider', done: false },
      { label: 'Activer l’API sur le projet Google de Nordla', owner: 'nordla', done: false },
      { label: 'Consentement du propriétaire de la fiche', owner: 'owner', done: false },
    ],
  }),
  defineProvider({
    id: 'bank', label: 'Banque', category: 'banque', status: 'WAITING', dataLabel: 'Comptes et mouvements (lecture)', source: 'bank', access: 'NONE', capabilities: ['bank_accounts_read', 'transactions_read'],
    description: 'Lecture seule des comptes et des mouvements, par un fournisseur d’accès bancaire agréé (Enable Banking). Le pilote est la banque KBC ; aucun paiement n’est possible.',
    holdReason: 'Conditions écrites d’Enable Banking en attente.',
    steps: [
      { label: 'Conditions écrites d’Enable Banking (message envoyé, réponse attendue)', owner: 'provider', done: false },
      { label: 'Créer l’application Enable Banking et sa clé, puis les poser sur le service Finance', owner: 'owner', done: false },
      { label: 'Consentement bancaire KBC (page de la banque)', owner: 'owner', done: false },
    ],
  }),
  // "Commerce et gestion": no journey yet. One connection of such a platform declares SEVERAL capabilities.
  defineProvider({
    id: 'odoo', label: 'Odoo', category: 'commerce_gestion', status: 'PLANNED', dataLabel: 'Ventes, catalogue, stock et facturation', capabilities: ['sales', 'catalog', 'stock', 'invoicing'],
    description: 'Une seule connexion Odoo pourra couvrir les ventes, le catalogue, le stock et la facturation. Priorité selon les outils des prochaines boutiques pilotes.',
  }),
  defineProvider({
    id: 'woocommerce', label: 'WooCommerce', category: 'commerce_gestion', status: 'PLANNED', dataLabel: 'Ventes, catalogue et stock', capabilities: ['sales', 'catalog', 'stock'],
    description: 'Boutique WooCommerce : ventes, catalogue et stock. Priorité selon les outils des prochaines boutiques pilotes.',
  }),
  defineProvider({
    id: 'prestashop', label: 'PrestaShop', category: 'commerce_gestion', status: 'PLANNED', dataLabel: 'Ventes, catalogue et stock', capabilities: ['sales', 'catalog', 'stock'],
    description: 'Boutique PrestaShop : ventes, catalogue et stock. Priorité selon les outils des prochaines boutiques pilotes.',
  }),
]);

// Settings home: the six sections of the grid. `status` is the REAL availability: a section with no screen is PLANNED and says what already works, it is never shown as usable.
export const SETTINGS_SECTIONS = Object.freeze([
  Object.freeze({ id: 'general', label: 'Général', icon: 'gear', description: 'Informations de la boutique, devises, fuseau horaire et format.', status: 'PLANNED', note: 'Pas encore disponible.' }),
  Object.freeze({ id: 'team', label: 'Équipe et accès', icon: 'users', description: 'Gérer les membres, rôles et permissions.', status: 'PLANNED', note: 'Les rôles (propriétaire, administrateur, lecture) s’appliquent déjà ; leur gestion n’a pas encore d’écran.' }),
  Object.freeze({ id: 'connections', label: 'Connexions', icon: 'plug', description: 'Connecter vos outils (boutique, réseaux sociaux, banque, gestion).', status: 'AVAILABLE', href: '/settings/connections' }),
  Object.freeze({ id: 'notifications', label: 'Notifications', icon: 'bell', description: 'Choisir ce que vous recevez et par quel canal (e-mail, application).', status: 'PLANNED', note: 'Pas encore disponible.' }),
  Object.freeze({ id: 'preferences', label: 'Préférences', icon: 'sliders', description: 'Paramètres d’achats, de stocks, de pricing et d’affichage.', status: 'PLANNED', note: 'Pas encore disponible.' }),
  Object.freeze({ id: 'security', label: 'Sécurité', icon: 'shield', description: 'Authentification, mots de passe et protections du compte.', status: 'PLANNED', note: 'La connexion par session et la protection contre les requêtes forgées sont actives ; aucun écran de réglage pour l’instant.' }),
]);

/** @param {{ extra?: object[] }} o `extra` = more provider definitions (already passed through defineProvider, or raw: they are validated here). */
export function createRegistry({ providers = PROVIDERS, extra = [] } = {}) {
  const all = [...providers, ...extra.map((d) => (Object.isFrozen(d) ? d : defineProvider(d)))];
  const byId = new Map();
  for (const p of all) { if (byId.has(p.id)) throw new TypeError(`provider ${p.id} is registered twice`); byId.set(p.id, p); }
  return Object.freeze({
    list: () => all,
    get: (id) => byId.get(id) ?? null,
    byProviderKey: (key) => all.find((p) => p.providerKey === key) ?? null,
    categories: () => Object.values(CATEGORY).sort((a, b) => a.order - b.order).map((c) => ({ ...c, providers: all.filter((p) => p.category === c.id) })).filter((c) => c.providers.length),
  });
}
