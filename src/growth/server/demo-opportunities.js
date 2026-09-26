// Growth > Opportunités - DEMONSTRATION data only (`demo: true`). There is no detection engine yet: the rows below are
// illustrative examples of the chain Signal -> Opportunité -> Impact estimé -> Confiance -> Effort -> Décision -> Résultat.
// Deterministic, generic (no retailer name). Every KPI is DERIVED from the rows (never typed separately), so the page
// cannot show contradictory figures. When a real engine exists it returns the same payload shape.

const L = (fr, nl, en) => ({ fr, nl, en });
const DAY = 86400000;

// Pipeline: every ACTIVE opportunity (a won / rejected one leaves the pipeline).
// status: ready (prête à approuver) | inProgress (en cours) | analysis (analyse) | planned (planifiée)
// priority: high | medium | low (high + medium = "prioritaires") ; effort: low | medium | high
// impact: engine's impact class used by the Impact vs effort matrix ; confidence: 0..1
const PIPELINE = [
  { id: 'store-traffic', title: L('Augmenter le trafic magasin', 'Winkelbezoek verhogen', 'Increase store traffic'), short: L('Trafic magasin', 'Winkelbezoek', 'Store traffic'), source: 'store', priority: 'high', revenue: 3500, confidence: 0.85, effort: 'medium', impact: 'high', status: 'ready', budget: 500 },
  { id: 'bottles-stock', title: L('Stock élevé de gourdes personnalisées', 'Hoge voorraad gepersonaliseerde drinkflessen', 'High stock of custom bottles'), short: L('Gourdes personnalisées', 'Drinkflessen', 'Custom bottles'), source: 'stock', priority: 'high', revenue: 2800, confidence: 0.78, effort: 'low', impact: 'high', status: 'inProgress' },
  { id: 'student-offer', title: L('Offre étudiants', 'Studentenaanbod', 'Student offer'), short: L('Offre étudiants', 'Studentenaanbod', 'Student offer'), source: 'market', priority: 'high', revenue: 2200, confidence: 0.72, effort: 'low', impact: 'high', status: 'ready', budget: 300 },
  { id: 'google-search', title: L('Extension Google Search', 'Uitbreiding Google Search', 'Google Search extension'), short: L('Google Search', 'Google Search', 'Google Search'), source: 'ai', priority: 'high', revenue: 2000, confidence: 0.68, effort: 'medium', impact: 'high', status: 'analysis' },
  { id: 'gift-box-upsell', title: L('Upsell boîte cadeau', 'Upsell geschenkdoos', 'Gift box upsell'), short: L('Upsell boîte cadeau', 'Upsell geschenkdoos', 'Gift box upsell'), source: 'customers', priority: 'medium', revenue: 1200, confidence: 0.60, effort: 'low', impact: 'low', status: 'inProgress' },
  { id: 'window-signage', title: L('Test signalétique vitrine', 'Test etalagesignalisatie', 'Shop window signage test'), short: L('Signalétique vitrine', 'Etalagesignalisatie', 'Window signage'), source: 'experiment', priority: 'medium', revenue: 800, confidence: 0.52, effort: 'low', impact: 'low', status: 'planned' },
  { id: 'grandparents-day', title: L('Offre fête des grands-parents', 'Aanbod grootouderdag', 'Grandparents’ day offer'), short: L('Fête des grands-parents', 'Grootouderdag', 'Grandparents’ day'), source: 'seasonality', priority: 'medium', revenue: 600, confidence: 0.58, effort: 'low', impact: 'low', status: 'analysis' },
  { id: 'dormant-reactivation', title: L('Relance des clients inactifs', 'Inactieve klanten heractiveren', 'Win back inactive customers'), short: L('Clients inactifs', 'Inactieve klanten', 'Inactive customers'), source: 'customers', priority: 'medium', revenue: 500, confidence: 0.55, effort: 'medium', impact: 'low', status: 'inProgress' },
  { id: 'case-bundle', title: L('Bundle coque + support', 'Bundel hoesje + houder', 'Case + stand bundle'), short: L('Bundle coque', 'Hoesjesbundel', 'Case bundle'), source: 'sales', priority: 'low', revenue: 400, confidence: 0.50, effort: 'low', impact: 'low', status: 'ready', budget: 150 },
  { id: 'gbp-posts', title: L('Posts Google Business hebdomadaires', 'Wekelijkse Google Business-posts', 'Weekly Google Business posts'), short: L('Posts Google Business', 'Google Business-posts', 'Google Business posts'), source: 'local', priority: 'low', revenue: 300, confidence: 0.47, effort: 'low', impact: 'low', status: 'inProgress' },
  { id: 'loyalty-card', title: L('Carte de fidélité', 'Klantenkaart', 'Loyalty card'), short: L('Carte de fidélité', 'Klantenkaart', 'Loyalty card'), source: 'customers', priority: 'low', revenue: 300, confidence: 0.45, effort: 'high', impact: 'low', status: 'analysis' },
  { id: 'premium-wrapping', title: L('Emballage cadeau premium', 'Premium cadeauverpakking', 'Premium gift wrapping'), short: L('Emballage premium', 'Premium verpakking', 'Premium wrapping'), source: 'margin', priority: 'low', revenue: 200, confidence: 0.44, effort: 'low', impact: 'low', status: 'planned' },
];

export function buildDemoOpportunities(now = new Date()) {
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const daysAgo = (n) => new Date(today.getTime() - n * DAY).toISOString().slice(0, 10);
  const wins = [
    { id: 'instagram-bottles', title: L('Campagne Instagram — gourdes personnalisées', 'Instagram-campagne — gepersonaliseerde drinkflessen', 'Instagram campaign — custom bottles'), result: 2100, target: 1800, date: daysAgo(6) },
    { id: 'gift-collection', title: L('Collection cadeaux', 'Cadeaucollectie', 'Gift collection'), result: 2200, target: 2500, date: daysAgo(12) },
    { id: 'local-campaign', title: L('Campagne locale', 'Lokale campagne', 'Local campaign'), result: 850, target: 800, date: daysAgo(38) },
  ];
  const monthPrefix = today.toISOString().slice(0, 7);
  const winsThisMonth = wins.filter((w) => w.date.startsWith(monthPrefix));
  const sum = (a) => a.reduce((x, y) => x + y, 0);
  const priority = PIPELINE.filter((o) => o.priority !== 'low');
  const potential = sum(PIPELINE.map((o) => o.revenue));

  return {
    demo: true,
    currency: 'EUR',
    generatedAt: now.toISOString(),
    kpis: {
      priority: { value: priority.length, previous: 5, high: PIPELINE.filter((o) => o.priority === 'high').length },
      potentialRevenue: { value: potential, previous: 10200, active: PIPELINE.length },
      readyToApprove: { value: PIPELINE.filter((o) => o.status === 'ready').length },
      inProgress: { value: PIPELINE.filter((o) => o.status === 'inProgress').length },
      winsThisMonth: { value: winsThisMonth.length, revenue: sum(winsThisMonth.map((w) => w.result)) },
    },
    pipeline: PIPELINE.map(({ budget, ...o }) => o),
    // Nordla AI recommendations, each tied to a pipeline row (same figures as the row).
    recommendations: [
      { opportunityId: 'bottles-stock', kind: 'stock', title: L('Prioriser les gourdes personnalisées', 'Gepersonaliseerde drinkflessen voorrang geven', 'Prioritise custom bottles'), text: L('Stock élevé + marge élevée.', 'Hoge voorraad + hoge marge.', 'High stock + high margin.') },
      { opportunityId: 'google-search', kind: 'campaign', title: L('Étendre les mots-clés Google Search', 'Google Search-zoekwoorden uitbreiden', 'Extend Google Search keywords'), text: L('ROAS actuel performant. Ajouter environ 15 nouveaux mots-clés produits.', 'Huidige ROAS presteert goed. Voeg ongeveer 15 nieuwe productzoekwoorden toe.', 'Current ROAS is strong. Add about 15 new product keywords.') },
      { opportunityId: 'student-offer', kind: 'segment', title: L('Tester une offre étudiants', 'Een studentenaanbod testen', 'Test a student offer'), text: L('Potentiel détecté autour de la rentrée.', 'Potentieel rond de start van het schooljaar.', 'Potential detected around back-to-school.') },
      { opportunityId: 'window-signage', kind: 'store', title: L('Tester la signalétique vitrine', 'Etalagesignalisatie testen', 'Test shop window signage'), text: L('Effort faible et problème de trafic magasin détecté.', 'Weinig inspanning en een winkelbezoekprobleem gedetecteerd.', 'Low effort and a store traffic issue detected.') },
    ],
    // Awaiting a decision = the pipeline rows in status "ready" (budget proposed by the engine).
    approvals: PIPELINE.filter((o) => o.status === 'ready').map((o) => ({ opportunityId: o.id, title: o.title, budget: o.budget, expectedRevenue: o.revenue })),
    segments: [
      { id: 'students', label: L('Étudiants', 'Studenten', 'Students'), growthPct: 0.42 },
      { id: 'gifts', label: L('Cadeaux', 'Cadeaus', 'Gifts'), growthPct: 0.28 },
      { id: 'local', label: L('Clients locaux', 'Lokale klanten', 'Local customers'), growthPct: 0.18 },
      { id: 'business', label: L('Entreprises', 'Bedrijven', 'Businesses'), growthPct: 0.16 },
      { id: 'returning', label: L('Clients récurrents', 'Terugkerende klanten', 'Returning customers'), growthPct: 0.08 },
    ],
    wins,
  };
}
