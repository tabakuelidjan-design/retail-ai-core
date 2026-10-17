// Nordla Core screen - the VIEW MODEL. Pure: it turns what the server REALLY answered (GET /api/core/status, /api/core/modules,
// /api/core/decisions, /healthz/backup, /api/auth/session) into what the screen shows. No I/O, no clock of its own (`now` is passed),
// no figure invented: a value the server did not give is "Non disponible" with the reason; "opérationnel" is said only when every
// check behind it was actually verified. The screen reflects server decisions, it never replaces them.

/** Official icon files (src/shared/assets/nordla/official-icons, served at /nordla-assets/official-icons/). Same names as
 *  src/shared/nordla-icon.js; never a file listed there as DEFECTIVE (test/nordla-design-system.test.js checks both). */
export const ICON_FILES = Object.freeze({
  accueil: '04_ui_core_accueil.png', parametres: '04_ui_core_parametres.png', parleANordla: '01_navigation_modules_parle_a_nordla.png',
  commandCenter: '01_navigation_modules_command_center.png', buyingSuppliers: '01_navigation_modules_buying_suppliers.png',
  tresorerie: '01_navigation_modules_tresorerie.png', stock: '04_produits_commerce_stock.png', ventes: '01_navigation_modules_ventes.png',
  produits: '01_navigation_modules_produits.png', explorer: '01_navigation_modules_explorer.png', fournisseur: '04_produits_commerce_fournisseur.png',
  compliance: '01_navigation_modules_compliance.png', growth: '01_navigation_modules_growth.png', security: '01_navigation_modules_security.png',
  recherche: '08_ui_utilities_recherche.png', decisionLedger: '01_navigation_modules_decision_ledger.png', dataHealth: '08_ui_utilities_data_health.png',
  synchronisation: '08_ui_utilities_synchronisation.png',
});
export const iconUrl = (name) => (ICON_FILES[name] ? `/nordla-assets/official-icons/${ICON_FILES[name]}` : null);

/** The modules the SERVER can report (keys of GET /api/core/modules) with their official icon. Branding and Création have no official icon
 *  in the READY pack: an initial is shown instead (flagged in docs, never a generic or redrawn icon). */
export const MODULE_META = Object.freeze({
  core: { icon: 'commandCenter', short: 'Décisions d’achat, journal' },
  sourcing: { icon: 'buyingSuppliers', short: 'Recherche fournisseurs, dossiers', href: '/' },
  finance: { icon: 'tresorerie', short: 'Factures, paiements, trésorerie' },
  procurement: { icon: 'stock', short: 'Commandes, réceptions, stock' },
  analytics: { icon: 'explorer', short: 'Ventes, produits, canaux' },
  branding: { icon: null, initial: 'B', short: 'Règles de marque' },
  marketing: { icon: 'growth', short: 'Propositions de campagne' },
  creative: { icon: null, initial: 'C', short: 'Visuels produit' },
});

/** Server module state -> badge tone. Unknown states are neutral, never green. */
export const STATE_TONE = Object.freeze({ DISPONIBLE: 'ok', 'LECTURE SEULE': 'info', LIMITÉ: 'warn', 'À APPROUVER': 'warn', 'À VÉRIFIER': 'warn', BLOQUÉ: 'error', 'NON RACCORDÉ': 'neutral', 'NON CONFIGURÉ': 'neutral' });
const usable = (state) => ['DISPONIBLE', 'LECTURE SEULE', 'LIMITÉ', 'À APPROUVER'].includes(state);

const fmtTime = (iso) => { const d = new Date(iso); return Number.isNaN(d.getTime()) ? '' : d.toISOString().slice(0, 16).replace('T', ' '); };

/** /healthz/backup states, said in words (an unknown state is shown as the server sent it). */
const BACKUP_LABEL = Object.freeze({ PENDING_FIRST_RUN: 'première sauvegarde pas encore faite', NOT_CONFIGURED: 'non configurée sur ce serveur', FAILING: 'en échec', STALE: 'dernière copie trop ancienne', NO_OFFSITE_COPY_YET: 'aucune copie hors serveur encore' });

/** "Opérationnel" only when the Core runs AND the off-server backup is verified OK. Everything else says what is missing. */
export function systemStatus({ status, backup, online = true, now }) {
  if (!online) return { tone: 'neutral', label: 'Hors ligne', detail: 'Le serveur ne répond pas : l’état ne peut pas être vérifié.', checks: [] };
  if (!status) return { tone: 'neutral', label: 'État non vérifié', detail: 'Le serveur n’a pas répondu à la vérification.', checks: [] };
  const checks = [
    { name: 'Nordla Core', ok: status.enabled === true, detail: status.enabled ? 'actif, journal lisible' : `inactif (${status.reason ?? 'raison non donnée'})` },
    { name: 'Sauvegarde hors serveur', ok: backup?.status === 'OK', detail: !backup ? 'état non disponible' : backup.status === 'OK' ? `dernière copie il y a ${backup.last_success_age_h} h` : `${BACKUP_LABEL[backup.status] ?? backup.status}${backup.error_code ? ` (${backup.error_code})` : ''}` },
  ];
  const at = now ? ` (vérifié à ${fmtTime(now).slice(11)} UTC)` : '';
  if (!checks[0].ok) return { tone: 'error', label: 'Core inactif', detail: checks[0].detail, checks };
  if (checks.every((c) => c.ok)) return { tone: 'ok', label: `Opérationnel${at}`, detail: 'Core actif et sauvegarde hors serveur vérifiée.', checks };
  return { tone: 'warn', label: 'Partiellement vérifié', detail: checks.filter((c) => !c.ok).map((c) => `${c.name} : ${c.detail}`).join(' · '), checks };
}

/** The indicators: each value comes from a named server field, or is "Non disponible" with the reason. */
export function metrics({ status, decisions, backup }) {
  const na = (label, why) => ({ label, value: null, source: why });
  const enabled = status?.enabled === true;
  return [
    enabled ? { label: 'Décisions à prendre', value: status.awaiting_human, source: 'Journal Core : recommandations sans décision humaine' } : na('Décisions à prendre', 'Core inactif'),
    enabled ? { label: 'Décisions en suivi', value: status.in_follow_up, source: 'Journal Core : décisions validées sans résultat noté' } : na('Décisions en suivi', 'Core inactif'),
    Array.isArray(decisions) ? { label: 'Analyses au journal', value: decisions.length, source: 'Journal Core (GET /api/core/decisions)' } : na('Analyses au journal', 'journal non lu'),
    backup?.last_success_age_h != null ? { label: 'Dernière sauvegarde', value: `${backup.last_success_age_h} h`, source: 'Copie hors serveur (/healthz/backup)' } : na('Dernière sauvegarde', backup ? 'aucune copie hors serveur encore' : 'état non disponible'),
  ];
}

/** Spend and model usage: this server exposes no AI spend counter, so it is said, never estimated. */
export function aiUsage({ modules }) {
  const creative = (modules ?? []).find((m) => m.key === 'creative');
  return { value: null, label: 'Dépenses IA et modèles', source: 'Non disponible : ce serveur n’expose aucun compteur de dépenses IA.', note: creative ? `Création : ${creative.detail}` : 'Les réponses de Parle à Nordla et du Core sont calculées par le code (aucun modèle).' };
}

/** The central diagram: four nodes with their REAL state; a node links somewhere only when that destination exists in this app. */
export function coreNodes({ status, modules }) {
  const by = Object.fromEntries((modules ?? []).map((m) => [m.key, m]));
  const data = ['finance', 'analytics', 'procurement'].filter((k) => usable(by[k]?.state));
  const conn = Object.values(status?.connected ?? {}).filter((v) => /^(CONNECTED|READ_ONLY)/.test(String(v))).length;
  const total = Object.keys(status?.connected ?? {}).length;
  return [
    { pos: 'top', key: 'agents', title: 'Agents IA', detail: 'Aucun agent autonome : chaque décision reste humaine.', href: null, icon: 'decisionLedger' },
    { pos: 'left', key: 'data', title: 'Données', detail: modules ? `${data.length} source(s) sur 3 raccordée(s) (Finance, Analyses, Stock)` : 'Non disponible', href: modules ? '#modules' : null, icon: 'dataHealth' },
    { pos: 'right', key: 'tools', title: 'Outils', detail: status ? `${conn} sur ${total} connecté(s)` : 'Non disponible', href: status ? '#modules' : null, icon: 'synchronisation' },
    { pos: 'bottom', key: 'rules', title: 'Règles et validations', detail: status?.enabled ? `Règles du propriétaire : ${status.owner_rules === 'CONFIGURED' ? 'configurées' : 'non configurées'} · ${status.awaiting_human} décision(s) à valider` : 'Non disponible', href: null, icon: 'compliance' },
  ];
}

/** The module list exactly as the server reports it; navigable only where a screen exists for it. */
export function moduleCards({ modules }) {
  return (modules ?? []).map((m) => {
    const meta = MODULE_META[m.key] ?? { icon: null, initial: (m.label ?? '?').slice(0, 1), short: '' };
    const href = meta.href ?? `#module/${m.key}`; // every module has its detail screen (state, what it does here, what is missing)
    return { key: m.key, name: m.label, state: m.state, tone: STATE_TONE[m.state] ?? 'neutral', short: meta.short, detail: m.detail, icon: meta.icon, initial: meta.initial ?? null, href, external: Boolean(meta.href) };
  });
}

/** The latest Core journal events, newest first (the only "agent activity" this server has: analyses and human decisions). */
export function activity({ decisions, limit = 6 }) {
  if (!Array.isArray(decisions)) return null;
  const DEC = { APPROVED: 'Validé', APPROVED_ALTERNATIVE: 'Autre option choisie', REJECTED: 'Rejeté', DEFERRED: 'Reporté' };
  return decisions.slice(0, limit).map((d) => ({
    title: d.subject?.title ?? 'Analyse d’achat',
    what: d.human_decision ? `Décision humaine : ${DEC[d.human_decision.decision] ?? d.human_decision.decision}` : d.recommendation ? `Recommandation : ${d.recommendation.label} — à décider` : 'Analyse sans recommandation',
    tone: d.human_decision ? 'ok' : d.recommendation ? 'warn' : 'neutral',
    at: fmtTime(d.human_decision?.decided_at ?? d.created_at),
  }));
}

/** What the security indicator may truthfully say: only facts this server enforces in code. */
export function guardian({ session }) {
  const signed = session?.mode === 'session' && session?.authenticated === true;
  return { tone: signed ? 'ok' : 'warn', title: signed ? 'Session vérifiée par le serveur' : 'Session non vérifiée', detail: 'Contrôles serveur : session, origine et jeton CSRF à chaque modification. Aucune publication, aucun paiement, aucune commande depuis Nordla.' };
}

/** Everything the dashboard shows, from one set of server answers. */
export function buildDashboard({ status = null, modules = null, decisions = null, backup = null, session = null, online = true, now = null }) {
  return { system: systemStatus({ status, backup, online, now }), metrics: metrics({ status, decisions, backup }), ai: aiUsage({ modules }), nodes: coreNodes({ status, modules }), modules: moduleCards({ modules }), activity: activity({ decisions }), guardian: guardian({ session }) };
}

/** Desktop navigation (validated order). Items whose module this server does not hold are shown, but disabled with the reason. */
export function navItems({ modules, route }) {
  const by = Object.fromEntries((modules ?? []).map((m) => [m.key, m]));
  const mod = (key, label, icon) => ({ label, icon, href: by[key] ? (key === 'sourcing' ? '/' : `#module/${key}`) : null, note: by[key] ? null : 'non raccordé', current: route === `module/${key}` });
  const none = (label, icon) => ({ label, icon, href: null, note: 'bientôt', current: false });
  return [
    { label: 'Tableau de bord', icon: 'accueil', href: '#accueil', current: route === 'accueil' },
    { label: 'Parle à Nordla', icon: 'parleANordla', href: '#parle', current: route === 'parle' },
    mod('sourcing', 'China Sourcing', 'buyingSuppliers'), mod('finance', 'Finance', 'tresorerie'), mod('procurement', 'Stock & Achats', 'stock'),
    none('Ventes & CRM', 'ventes'), none('Produits', 'produits'), mod('analytics', 'Analyses', 'explorer'), none('Fournisseurs', 'fournisseur'), none('Conformité', 'compliance'),
    { label: 'Tous les modules', icon: 'commandCenter', href: '#modules', current: route === 'modules' },
    { label: 'Paramètres', icon: 'parametres', href: '#plus', current: route === 'plus' },
  ];
}
