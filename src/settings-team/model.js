// Paramètres -> Équipe et accès: roles, rights grid, vocabulary. Pure data + small pure functions, no I/O.
//
// THE GRID IS A COPY OF WHAT THE SERVERS ENFORCE TODAY, not a wish list. Every line below names the code that enforces it; test/settings-team.test.js
// imports those real constants and fails when a line and its enforcement disagree (so the grid cannot drift silently).
// Levels: 'none' = Aucun accès, 'view' = Consulter, 'edit' = Modifier.

export const ROLE_ORDER = Object.freeze(['OWNER', 'ADMIN', 'VIEWER']);
/** The three roles offered by this screen. COLLABORATOR / ACCOUNTANT still exist in the identity layer (ADR 0004) and are displayed if a member holds one, but cannot be given from here. */
export const ROLES = Object.freeze({
  OWNER: Object.freeze({ id: 'OWNER', label: 'Propriétaire', summary: 'Gère tout, y compris les accès et les autres propriétaires.' }),
  ADMIN: Object.freeze({ id: 'ADMIN', label: 'Administrateur', summary: 'Gère le commerce et ses réglages ; ne gère pas les propriétaires ni les autres administrateurs.' }),
  VIEWER: Object.freeze({ id: 'VIEWER', label: 'Lecture seule', summary: 'Consulte, ne modifie rien.' }),
});
export const OTHER_ROLE_LABEL = Object.freeze({ COLLABORATOR: 'Collaborateur', ACCOUNTANT: 'Comptable' });
export const roleLabel = (r) => ROLES[r]?.label ?? OTHER_ROLE_LABEL[r] ?? r;
/** Next business role, documented only (not built, not selectable). */
export const NEXT_ROLE = Object.freeze({ id: 'SHOP_EMPLOYEE', label: 'Employé boutique', note: 'Prochain rôle métier : accès limité à la vente et au stock du point de vente. Pas encore disponible ; les rôles actuels ne changent pas.' });

export const STATUS = Object.freeze({ ACTIVE: 'Actif', SUSPENDED: 'Suspendu', REMOVED: 'Accès retiré' });
export const INVITATION_STATUS = Object.freeze({ PENDING: 'En attente', ACCEPTED: 'Acceptée', EXPIRED: 'Expirée', CANCELLED: 'Annulée' });

/** What each role may delegate to others (identity layer MEMBER_RULES; the database re-checks under a lock). */
export const ASSIGNABLE = Object.freeze({ OWNER: Object.freeze(['OWNER', 'ADMIN', 'VIEWER']), ADMIN: Object.freeze(['VIEWER']), VIEWER: Object.freeze([]) });
/** Who may manage which current role (a person is never managed above its own rank; an administrator never manages itself). */
export const MANAGES = Object.freeze({ OWNER: Object.freeze(['OWNER', 'ADMIN', 'VIEWER', 'COLLABORATOR', 'ACCOUNTANT']), ADMIN: Object.freeze(['VIEWER', 'COLLABORATOR', 'ACCOUNTANT']), VIEWER: Object.freeze([]) });
export const MANAGER_ROLES = Object.freeze(new Set(['OWNER', 'ADMIN']));

const lvl = (owner, admin, viewer, other = {}) => Object.freeze({ OWNER: owner, ADMIN: admin, VIEWER: viewer, COLLABORATOR: other.COLLABORATOR ?? viewer, ACCOUNTANT: other.ACCOUNTANT ?? viewer });
/** @type {ReadonlyArray<{id: string, label: string, levels: Record<string,string>, enforcedBy: string, note?: string}>} */
export const MODULE_RIGHTS = Object.freeze([
  Object.freeze({ id: 'general', label: 'Général', levels: lvl('edit', 'edit', 'view'), enforcedBy: 'src/settings-general/service.js (WRITER_ROLES, LEGAL_READERS)', note: 'La rubrique « Informations légales et facturation » est réservée au propriétaire et aux administrateurs : « Lecture seule » ne la voit pas.' }),
  Object.freeze({ id: 'connections', label: 'Connexions', levels: lvl('edit', 'edit', 'view'), enforcedBy: 'src/connections/service.js (WRITER_ROLES)' }),
  Object.freeze({ id: 'team', label: 'Équipe et accès', levels: lvl('edit', 'edit', 'none'), enforcedBy: 'src/settings-team/service.js (MANAGER_ROLES) + fonctions SQL team_* / identity_member_apply', note: 'Un administrateur ne gère que les rôles « Lecture seule » (jamais un propriétaire, un administrateur ni lui-même).' }),
  Object.freeze({ id: 'procurement', label: 'Stock / Achats', levels: lvl('edit', 'edit', 'view'), enforcedBy: 'src/procurement/server/hosted.js (PROCUREMENT_ROLE) + permissions.js', note: 'Préparer visites, offres et commandes : propriétaire et administrateur. Approuver une commande : propriétaire (ou personne explicitement autorisée par lui).' }),
  Object.freeze({ id: 'creator', label: 'Création', levels: lvl('edit', 'edit', 'view', { COLLABORATOR: 'edit' }), enforcedBy: 'src/creative-autonomy/creator/hosted.js (CREATOR_WRITERS)' }),
  Object.freeze({ id: 'gbp', label: 'Google Business', levels: lvl('edit', 'edit', 'view'), enforcedBy: 'src/sourcing/server/gbp-host.js (GBP_WRITERS)', note: 'Approuver ou retirer une approbation : propriétaire et administrateur.' }),
  Object.freeze({ id: 'videos', label: 'Vidéos', levels: lvl('edit', 'edit', 'view'), enforcedBy: 'src/sourcing/server/video-host.js (VIDEO_WRITERS)' }),
  Object.freeze({ id: 'sourcing', label: 'Sourcing Chine', levels: lvl('edit', 'edit', 'view', { COLLABORATOR: 'edit' }), enforcedBy: 'src/sourcing/server/app.js (SOURCING_WRITERS : propriétaire, administrateur, collaborateur)', note: 'Les routes de modification de China Sourcing et de Nordla Core refusent « Lecture seule » (et Comptable) côté serveur ; consulter et interroger Nordla restent ouverts.' }),
]);

/** Sensitive actions that the servers really control (an action that no server checks is NOT listed). */
export const SENSITIVE_ACTIONS = Object.freeze([
  Object.freeze({ id: 'manage_access', label: 'Gérer les accès', levels: Object.freeze({ OWNER: 'yes', ADMIN: 'limited', VIEWER: 'no' }), note: 'Administrateur : uniquement les rôles « Lecture seule ».', enforcedBy: 'fonctions SQL identity_member_apply / team_*' }),
  Object.freeze({ id: 'manage_connection', label: 'Gérer une connexion', levels: Object.freeze({ OWNER: 'yes', ADMIN: 'yes', VIEWER: 'no' }), enforcedBy: 'src/sourcing/server/connections-host.js (WRITER_ROLES)' }),
  Object.freeze({ id: 'approve_order', label: 'Approuver une commande fournisseur', levels: Object.freeze({ OWNER: 'yes', ADMIN: 'no', VIEWER: 'no' }), note: 'Le propriétaire peut autoriser nommément une personne.', enforcedBy: 'src/procurement/server/permissions.js (GRANTS)' }),
  Object.freeze({ id: 'approve_gbp', label: 'Approuver une fiche Google Business', levels: Object.freeze({ OWNER: 'yes', ADMIN: 'yes', VIEWER: 'no' }), enforcedBy: 'src/sourcing/server/gbp-host.js (GBP_WRITERS)' }),
]);
export const NOT_CONTROLLED = Object.freeze(['Exporter : aucun serveur ne contrôle encore l’export par rôle ; l’action n’est donc pas affichée dans la grille.', 'Périmètre par établissement : n’est pas appliqué côté serveur ; chaque membre actif voit tous les établissements.']);

/** The effective rights of one role, module by module. */
export function rightsOf(role) {
  return {
    modules: MODULE_RIGHTS.map((m) => ({ id: m.id, label: m.label, level: m.levels[role] ?? 'none', note: m.note ?? null })),
    sensitive: SENSITIVE_ACTIONS.map((a) => ({ id: a.id, label: a.label, value: a.levels[role] ?? 'no', note: a.note ?? null })),
  };
}
export const LEVEL_LABEL = Object.freeze({ none: 'Aucun accès', view: 'Consulter', edit: 'Modifier' });
export const SENSITIVE_LABEL = Object.freeze({ yes: 'Oui', limited: 'Limité', no: 'Non' });

export const INVITATION_TTL_DAYS = 7;
export const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
export const normalizeEmail = (v) => String(v ?? '').trim().toLowerCase();
export const validEmail = (v) => { const e = normalizeEmail(v); return e.length >= 5 && e.length <= 254 && EMAIL_RE.test(e); };
/** Event types of the access history (journal identity_events) and their French wording. */
export const HISTORY_EVENTS = Object.freeze({
  INVITATION_CREATED: 'Invitation envoyée', INVITATION_RESENT: 'Invitation renvoyée', INVITATION_CANCELLED: 'Invitation annulée', INVITATION_ACCEPTED: 'Invitation acceptée', INVITATION_DENIED: 'Invitation refusée',
  MEMBER_ADDED: 'Membre ajouté', MEMBER_ROLE_CHANGED: 'Rôle modifié', MEMBER_SUSPENDED: 'Accès suspendu', MEMBER_REACTIVATED: 'Accès réactivé', MEMBER_REMOVED: 'Accès retiré', MEMBER_ACTION_DENIED: 'Action refusée', MEMBER_BOOTSTRAPPED: 'Premier propriétaire créé',
});
export const REFUSAL = Object.freeze({
  FORBIDDEN: 'Votre rôle ne permet pas cette action.', FORBIDDEN_ROLE: 'Réservé au propriétaire et aux administrateurs.', LAST_OWNER: 'Impossible : c’est le dernier propriétaire actif. Nommez d’abord un autre propriétaire.', SELF_PROMOTION: 'Vous ne pouvez pas vous donner un rôle supérieur au vôtre.',
  TARGET_NOT_MEMBER: 'Cette personne n’est pas membre de ce commerce.', ALREADY_SUSPENDED: 'Cet accès est déjà suspendu.', ALREADY_ACTIVE: 'Cet accès est déjà actif.', ALREADY_REMOVED: 'L’accès de cette personne est déjà retiré.', NO_CHANGE: 'Ce membre a déjà ce rôle.',
  MEMBER_REMOVED: 'L’accès a été retiré : une nouvelle invitation est nécessaire.', ROLE_INVALID: 'Rôle inconnu.', EMAIL_INVALID: 'Adresse e-mail invalide.', ALREADY_MEMBER: 'Cette personne a déjà accès à ce commerce.', DUPLICATE_PENDING: 'Une invitation est déjà en attente pour cette adresse : renvoyez-la ou annulez-la.',
  NOT_FOUND: 'Élément introuvable.', NOT_RESENDABLE: 'Cette invitation ne peut plus être renvoyée.', NOT_CANCELLABLE: 'Cette invitation ne peut plus être annulée.', MERCHANT_UNKNOWN: 'Commerce introuvable.',
});
