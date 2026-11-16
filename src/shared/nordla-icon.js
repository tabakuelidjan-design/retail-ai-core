'use strict';
// Nordla shared icon system - the ONE place every Nordla module gets its icons from
// (Analytics Premium, Finance, and every future module). Two kinds:
//   1. NordlaIcon.parle(variant, size, opts)  - the official "Parle à Nordla" icon (white on terracotta
//      backgrounds, terracotta everywhere else).
//   2. NordlaIcon.semantic(name, size, opts)  - the official Nordla Visual System v1 icons, by SEMANTIC
//      name (same meaning = same icon everywhere), never by raw file path in the UI.
// The assets are fixed, multi-colour (navy + terracotta), transparent SVGs: never recoloured, redrawn,
// stretched or replaced by a generic icon. If a UI element needs an icon that is not in ICONS below, do
// NOT invent one - flag it as "UNRESOLVED ICON - official Nordla asset missing".
// Assets live in src/shared/assets/nordla/official-icons/ and are served under /nordla-assets/ by each module's server.
window.NordlaIcon = (function () {
  const BASE = '/nordla-assets/';
  // Shared size tokens (px): sm = small utility, md = standard navigation, lg = semantic/process icon.
  const SIZES = { sm: 16, md: 20, lg: 28 };
  const PARLE = { onTerracotta: 'parle-a-nordla/white.webp', default: 'parle-a-nordla/terracotta.webp' };
  // Official Nordla icons (Nordla_Official_Icons_READY, exact PNGs, never redrawn/recoloured). Semantic key -> file in
  // assets/nordla/official-icons/. Same meaning = same icon in every module.
  const ICONS = {
    accueil: '04_ui_core_accueil.png',
    packComptable: '04_ui_core_pack_comptable.png',
    parametres: '04_ui_core_parametres.png',
    aFaire: '01_navigation_modules_a_faire.png',
    achats: '01_navigation_modules_achats.png',
    afterSales: '01_navigation_modules_after_sales.png',
    approval: '01_navigation_modules_approval.png',
    banqueEtCaisse: '01_navigation_modules_banque_et_caisse.png',
    buyingSuppliers: '01_navigation_modules_buying_suppliers.png',
    ceQuiAChange: '01_navigation_modules_ce_qui_a_change.png',
    clients: '01_navigation_modules_clients.png',
    commandCenter: '01_navigation_modules_command_center.png',
    compliance: '01_navigation_modules_compliance.png',
    contacts: '01_navigation_modules_contacts.png',
    decisionLedger: '01_navigation_modules_decision_ledger.png',
    explorer: '01_navigation_modules_explorer.png',
    governance: '01_navigation_modules_governance.png',
    growth: '01_navigation_modules_growth.png',
    parleANordla: '01_navigation_modules_parle_a_nordla.png',
    produits: '01_navigation_modules_produits.png',
    resume: '01_navigation_modules_resume.png',
    security: '01_navigation_modules_security.png',
    tresorerie: '01_navigation_modules_tresorerie.png',
    ventes: '01_navigation_modules_ventes.png',
    baisse: '02_performance_business_baisse.png',
    chiffreAffaires: '02_performance_business_chiffre_affaires.png',
    commandes: '02_performance_business_commandes.png',
    croissance: '02_performance_business_croissance.png',
    margeBrute: '02_performance_business_marge_brute.png',
    panierMoyen: '02_performance_business_panier_moyen.png',
    clientARisque: '03_clients_client_a_risque.png',
    clientDormant: '03_clients_client_dormant.png',
    clientFidele: '03_clients_client_fidele.png',
    cohorte: '03_clients_cohorte.png',
    nouveauClient: '03_clients_nouveau_client.png',
    segmentClient: '03_clients_segment_client.png',
    fournisseur: '04_produits_commerce_fournisseur.png',
    meilleurProduit: '04_produits_commerce_meilleur_produit.png',
    prix: '04_produits_commerce_prix.png',
    produitEnBaisse: '04_produits_commerce_produit_en_baisse.png',
    produitEnHausse: '04_produits_commerce_produit_en_hausse.png',
    stock: '04_produits_commerce_stock.png',
    calendrier: '08_ui_utilities_calendrier.png',
    dataHealth: '08_ui_utilities_data_health.png',
    recherche: '08_ui_utilities_recherche.png',
    synchronisation: '08_ui_utilities_synchronisation.png',
  };
  // Icons that exist in the pack but whose exported file is defective (clipped / caption fragments / wrong crop).
  // They must NOT be rendered: asking for one throws in dev so nobody ships it. Re-export needed from the design board.
  const DEFECTIVE = {
    information: '08_ui_utilities_information.png', // caption fragment ("05"), not the icon
    banque: '05_finance_operations_banque.png',
    facture: '05_finance_operations_facture.png',
    paiement: '05_finance_operations_paiement.png',
    retard: '05_finance_operations_retard.png',
    validation: '05_finance_operations_validation.png',
    actionRecommandee: '06_alertes_actions_action_recommandee.png',
    donneesAJour: '06_alertes_actions_donnees_a_jour.png',
    donneesPartielles: '06_alertes_actions_donnees_partielles.png',
    opportunite: '06_alertes_actions_opportunite.png',
    priorite: '06_alertes_actions_priorite.png',
    risque: '06_alertes_actions_risque.png',
    assistant: '07_nordla_intelligence_assistant.png',
    decision: '07_nordla_intelligence_decision.png',
    explication: '07_nordla_intelligence_explication.png',
    fiabiliteDonnees: '07_nordla_intelligence_fiabilite_donnees.png',
    insight: '07_nordla_intelligence_insight.png',
    recommandation: '07_nordla_intelligence_recommandation.png',
  };

  function img(src, size, opts) {
    const key = SIZES[size] ? size : 'md';
    const el = document.createElement('img');
    el.src = BASE + src;
    el.width = SIZES[key]; el.height = SIZES[key];
    el.className = 'nordla-icon nordla-icon-' + key;
    if (opts && opts.label) el.alt = opts.label;
    else { el.alt = ''; el.setAttribute('aria-hidden', 'true'); }
    return el;
  }

  /** variant: 'onTerracotta' (icon sits on a terracotta background -> white) | 'default' (any other -> terracotta).
   * opts.label: pass only when the icon is the sole content of a clickable control (accessible name). */
  function parle(variant = 'default', size = 'md', opts = {}) {
    return img(PARLE[variant] || PARLE.default, size, opts);
  }

  /** Official semantic icon by name (see ICONS). Unknown names throw in dev so a typo is never silently blank. */
  function semantic(name, size = 'md', opts = {}) {
    if (DEFECTIVE[name]) throw new Error('NordlaIcon: official asset for "' + name + '" is defective in the READY pack (needs re-export)');
    if (!ICONS[name]) throw new Error('NordlaIcon: no official icon named "' + name + '"');
    return img('official-icons/' + ICONS[name], size, opts);
  }

  return { parle, semantic, SIZES, ICONS, DEFECTIVE, has: (n) => Object.prototype.hasOwnProperty.call(ICONS, n) };
})();
