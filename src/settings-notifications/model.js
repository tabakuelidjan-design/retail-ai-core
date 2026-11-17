// Paramètres -> Notifications: the alert registry. Pure data + small pure functions, no I/O.
//
// An alert TYPE is listed here only with what is REAL today. `wired` says whether an event of this type is really produced by Nordla:
//   wired: true  -> an emitter raises it (src/settings-notifications/emitters.js) from a reliable source and the alert leads to a real page.
//   wired: false -> the alert is shown as "Pas encore raccordée" with the exact reason; it can never be received and its setting stays inactive.
// The text and the target page of an alert come from THIS registry (never from a stored row), so a stored row can never inject a link or a sentence.

/** Roles that may see each module's items; mirrors MODULE_RIGHTS (src/settings-team/model.js): 'none' is absent from the list. */
const ALL_ROLES = Object.freeze(['OWNER', 'ADMIN', 'VIEWER', 'COLLABORATOR', 'ACCOUNTANT']);

export const MODULES = Object.freeze({
  connections: Object.freeze({ id: 'connections', label: 'Connexions' }),
  procurement: Object.freeze({ id: 'procurement', label: 'Stock / Achats' }),
  growth: Object.freeze({ id: 'growth', label: 'Développement des ventes' }),
});

export const ALERT_TYPES = Object.freeze({
  connection_reauth: Object.freeze({
    id: 'connection_reauth', module: 'connections', wired: true,
    label: 'Connexion à renouveler',
    trigger: 'Une connexion (Instagram, TikTok, Google Business…) n’est plus autorisée et doit être renouvelée.',
    channels: Object.freeze(['in_app']), defaultInApp: true,
    viewers: ALL_ROLES, link: '/settings/connections', linkLabel: 'Ouvrir Connexions',
    title: (d) => `${d.provider ? `${d.provider} : ` : ''}la connexion doit être renouvelée`,
    body: () => 'Nordla ne peut plus lire cette connexion tant qu’elle n’est pas renouvelée.',
  }),
  receipt_recorded: Object.freeze({
    id: 'receipt_recorded', module: 'procurement', wired: false,
    label: 'Réception d’achat enregistrée',
    trigger: 'Une réception de marchandises est enregistrée sur une commande fournisseur.',
    channels: Object.freeze(['in_app']), defaultInApp: true,
    viewers: ALL_ROLES, link: '/procurement', linkLabel: 'Ouvrir Stock / Achats',
    notWiredReason: 'Stock / Achats enregistre la réception dans son propre magasin de données sans publier d’événement que Nordla puisse relire de façon fiable : aucune alerte n’est produite pour l’instant.',
    title: () => 'Réception d’achat enregistrée', body: () => '',
  }),
  growth_action_review: Object.freeze({
    id: 'growth_action_review', module: 'growth', wired: true,
    label: 'Action à revoir',
    trigger: 'Une action de suivi de Développement des ventes, déjà appliquée, a atteint sa date de revue et n’a pas encore été revue.',
    channels: Object.freeze(['in_app']), defaultInApp: true,
    viewers: ALL_ROLES, link: null, linkEnv: 'NORDLA_GROWTH_PUBLIC_URL', linkLabel: 'Ouvrir Développement des ventes',
    notWiredReason: 'L’adresse de Développement des ventes n’est pas configurée sur ce serveur (NORDLA_GROWTH_PUBLIC_URL) : l’alerte ne pourrait pas renvoyer vers l’élément.',
    title: (d) => `Action à revoir${d.action ? ` : ${d.action}` : ''}`, body: () => 'La date de revue prévue est atteinte : comparez le résultat à l’objectif.',
  }),
});
export const TYPE_IDS = Object.freeze(Object.keys(ALERT_TYPES));
export const isType = (t) => Object.hasOwn(ALERT_TYPES, t);
/** Wired = the registry says so AND the alert has a page to lead to (a type with `linkEnv` needs that address configured). */
export const isWired = (type, links = {}) => isType(type) && ALERT_TYPES[type].wired && Boolean(ALERT_TYPES[type].link || links[type]);
export const canView = (type, role) => isType(type) && ALERT_TYPES[type].viewers.includes(role);

/** Channels other than "in Nordla": their REAL state on this server. E-mail has no sending channel on Nordla today; the digest needs one and a periodic job. */
export const EMAIL_STATE = Object.freeze({ available: false, label: 'E-mail indisponible', reason: 'Aucun canal d’envoi d’e-mails n’est opérationnel sur Nordla : aucune adresse d’expédition ni service d’envoi n’est configuré. Le réglage reste inactif.' });
export const DIGEST_STATE = Object.freeze({ available: false, label: 'Récapitulatif indisponible', reason: 'Un récapitulatif quotidien ou hebdomadaire demande un canal d’envoi et un traitement périodique, qui ne sont pas opérationnels. Aucun fuseau d’envoi n’est donc applicable.' });

export const NOTE_ACCOUNT = 'Les messages indispensables à la connexion et à la récupération du compte (réinitialisation du mot de passe, invitation, double authentification) sont gérés dans Paramètres › Sécurité et ne se règlent pas ici.';

/** Wording of one stored alert, from the registry only. `row.data` is the small non-secret object of the row. */
export function describe(row, links = {}) {
  const t = ALERT_TYPES[row.type]; const d = row.data && typeof row.data === 'object' ? row.data : {};
  return { id: row.id, type: row.type, module: t.module, moduleLabel: MODULES[t.module].label, title: String(t.title(d)).slice(0, 160), body: String(t.body(d)).slice(0, 300), link: t.link ?? links[row.type] ?? null, linkLabel: t.linkLabel, createdAt: row.created_at, readAt: row.read_at ?? null, read: row.read_at != null };
}
export const PREF_DEFAULT = (type) => ALERT_TYPES[type]?.defaultInApp ?? false;
