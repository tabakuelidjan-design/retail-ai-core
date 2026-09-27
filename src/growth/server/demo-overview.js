// Growth Overview - DEMONSTRATION data only (`demo: true`). No Growth source is connected yet (ad platforms,
// social accounts, store counters, experiments), so every figure below is an illustrative example chosen to be
// internally consistent (channel revenues add up to the influenced revenue, ROAS = paid revenue / spend, the
// daily series add up to the 30-day totals). It is deterministic (no randomness) and generic: no retailer name.
// When real sources exist, this file is replaced by a deterministic builder over synced data - the payload
// shape stays the same so the UI does not change.

const L = (fr, nl, en) => ({ fr, nl, en });
const DAY = 86400000;
const iso = (d) => d.toISOString().slice(0, 10);

/** Deterministic daily series of `n` points: weekly rhythm (weekends higher) + gentle trend, scaled to `total`. */
function series(n, total, { trend = 0, weekend = 0.3, wave = 0.08, phase = 0, dates, integer = true }) {
  const raw = dates.map((d, i) => {
    const dow = new Date(`${d}T00:00:00Z`).getUTCDay();
    const wk = dow === 6 ? 1 + weekend : dow === 0 ? 1 + weekend * 0.55 : 1;
    return wk * (1 + trend * (i / (n - 1) - 0.5)) * (1 + wave * Math.sin((i + phase) * 1.7));
  });
  const sum = raw.reduce((a, b) => a + b, 0);
  const out = raw.map((v) => (integer ? Math.round((v / sum) * total) : (v / sum) * total));
  if (integer) out[n - 1] += total - out.reduce((a, b) => a + b, 0); // exact total, no drift from rounding
  return out;
}

export function buildDemoOverview(now = new Date()) {
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const inDays = (n) => iso(new Date(today.getTime() + n * DAY));
  const N = 30;
  const dates = Array.from({ length: N }, (_, i) => inDays(i - (N - 1)));

  const influenced = series(N, 12540, { trend: 0.5, weekend: 0.35, phase: 1, dates });
  const other = series(N, 27060, { trend: 0.1, weekend: 0.25, phase: 4, dates });
  const visitors = series(N, 4860, { trend: -0.12, weekend: 0.6, phase: 2, dates });
  const storeRevenue = series(N, 14380, { trend: 0.06, weekend: 0.55, phase: 3, dates });
  const conversion = series(N, 21.4 * N, { trend: 0.1, weekend: -0.08, wave: 0.05, phase: 5, dates, integer: false }).map((v) => Math.round(v * 10) / 10);

  return {
    demo: true,
    currency: 'EUR',
    generatedAt: now.toISOString(),
    period: { key: 'last_30_days', from: dates[0], to: dates[N - 1] },
    kpis: {
      revenueInfluenced: { value: 12540, deltaPct: 0.28 },
      activeOpportunities: { value: 8, highPriority: 4 },
      activeCampaigns: { value: 5, performingWell: 2 },
      roas: { value: 3.2, deltaPct: 0.22 },
      experimentsRunning: { value: 3, endingThisWeek: 1 },
    },
    pulse: {
      dates,
      totalRevenue: influenced.map((v, i) => v + other[i]),
      influencedRevenue: influenced,
      storeVisitors: visitors,
      totals: { totalRevenue: 39600, influencedRevenue: 12540, storeVisitors: 4860 },
      deltas: { totalRevenue: 0.11, influencedRevenue: 0.28, storeVisitors: -0.06 },
    },
    insights: [
      { kind: 'momentum', tone: 'good', title: L('Forte dynamique sur les coques personnalisées', 'Sterke groei bij gepersonaliseerde hoesjes', 'Strong momentum on custom phone cases'), text: L('+34 % de chiffre d’affaires en 30 jours, porté surtout par Google Search.', '+34 % omzet in 30 dagen, vooral gedreven door Google Search.', '+34% revenue in 30 days, driven mostly by Google Search.') },
      { kind: 'campaign', tone: 'good', title: L('La campagne Google Search performe bien', 'De Google Search-campagne presteert goed', 'Google Search campaign performing well'), text: L('ROAS de 4,6x, au-dessus de la moyenne de 3,2x. Le budget est consommé à 82 %.', 'ROAS van 4,6x, boven het gemiddelde van 3,2x. 82 % van het budget is gebruikt.', 'ROAS of 4.6x, above the 3.2x average. 82% of the budget is spent.') },
      { kind: 'traffic', tone: 'warn', title: L('Peu de trafic en magasin malgré une bonne conversion', 'Weinig winkelbezoek ondanks goede conversie', 'Low store traffic despite good conversion'), text: L('Visiteurs −6 %, conversion 21,4 % (+2,1 pts). Le levier est la visibilité locale.', 'Bezoekers −6 %, conversie 21,4 % (+2,1 ptn). De hefboom is lokale zichtbaarheid.', 'Visitors −6%, conversion 21.4% (+2.1 pts). Local visibility is the lever.') },
      { kind: 'stock', tone: 'warn', title: L('Stock élevé sur les mugs personnalisés', 'Hoge voorraad personaliseerbare mokken', 'High stock on custom mugs'), text: L('64 unités, soit 11 semaines de couverture au rythme actuel.', '64 stuks, goed voor 11 weken aan het huidige tempo.', '64 units, 11 weeks of cover at the current pace.') },
    ],
    attention: [
      { kind: 'approval', status: 'pending', date: inDays(1), title: L('Approuver la campagne « Précommandes de Noël »', 'Campagne „Kerstpreorders” goedkeuren', 'Approve campaign “Christmas pre-orders”'), sub: L('Instagram · budget proposé 600 €', 'Instagram · voorgesteld budget € 600', 'Instagram · proposed budget €600'), action: 'approve' },
      { kind: 'opportunity', status: 'new', date: inDays(-1), title: L('Examiner l’opportunité « Stock élevé sur les mugs »', 'Kans „Hoge voorraad mokken” bekijken', 'Review opportunity “High stock on custom mugs”'), sub: L('Impact estimé +1 150 €', 'Geschatte impact + € 1.150', 'Estimated impact +€1,150'), action: 'review' },
      { kind: 'experiment', status: 'endingSoon', date: inDays(4), title: L('Test « Vitrine A/B » bientôt terminé', 'Test „Etalage A/B” loopt bijna af', 'Experiment “Shop window A/B” ending soon'), sub: L('KPI suivi : visites en magasin', 'Gevolgde KPI: winkelbezoeken', 'KPI tracked: store visits'), action: 'results' },
    ],
    channels: [
      { id: 'google-search', name: 'Google Search', revenue: 4820, reach: 2140, reachKind: 'visits', conversion: 0.031, roas: 4.4 },
      { id: 'instagram', name: 'Instagram', revenue: 3160, reach: 18400, reachKind: 'reach', conversion: 0.014, roas: 3.0 },
      { id: 'tiktok', name: 'TikTok', revenue: 1240, reach: 22900, reachKind: 'reach', conversion: 0.006, roas: 2.0 },
      { id: 'facebook', name: 'Facebook', revenue: 980, reach: 6300, reachKind: 'reach', conversion: 0.011, roas: 2.4 },
      { id: 'google-business', name: 'Google Business', revenue: 2340, reach: 1120, reachKind: 'actions', conversion: null, roas: null },
    ],
    campaigns: [
      { name: L('Coques personnalisées – Search', 'Gepersonaliseerde hoesjes – Search', 'Custom phone cases – Search'), channel: 'google-search', spend: 820, budget: 1000, status: 'performing', roas: 4.6, conversions: 64 },
      { name: L('Rentrée scolaire', 'Terug naar school', 'Back to school'), channel: 'instagram', spend: 610, budget: 800, status: 'performing', roas: 3.2, conversions: 38 },
      { name: L('Retargeting visiteurs', 'Retargeting bezoekers', 'Visitor retargeting'), channel: 'facebook', spend: 417, budget: 500, status: 'active', roas: 2.4, conversions: 21 },
      { name: L('Cadeaux personnalisés – Reels', 'Gepersonaliseerde cadeaus – Reels', 'Personalised gifts – Reels'), channel: 'tiktok', spend: 620, budget: 700, status: 'watch', roas: 2.0, conversions: 14 },
      { name: L('Posts offre locale', 'Posts lokale aanbieding', 'Local offer posts'), channel: 'google-business', spend: 0, budget: 0, status: 'active', roas: null, conversions: null, reach: 1120 },
    ],
    // Content items reference a channel by id; its display name comes from `channels` above.
    content: [
      { kind: 'reel', channel: 'instagram', title: L('Making-of d’une coque personnalisée', 'Making-of van een gepersonaliseerd hoesje', 'Making of a custom case'), views: 12400, deltaPct: 0.38, performance: 'best' },
      { kind: 'video', channel: 'tiktok', title: L('Impression UV en 30 secondes', 'UV-print in 30 seconden', 'UV print in 30 seconds'), views: 9800, deltaPct: -0.08, performance: 'below' },
      { kind: 'carousel', channel: 'instagram', title: L('5 idées cadeaux à moins de 30 €', '5 cadeau-ideeën onder € 30', '5 gift ideas under €30'), views: 6100, deltaPct: 0.12, performance: 'good' },
      { kind: 'post', channel: 'google-business', title: L('Nouveautés en boutique', 'Nieuw in de winkel', 'New in store'), views: 1900, deltaPct: 0.04, performance: 'good' },
    ],
    store: {
      traffic: { value: 4860, deltaPct: -0.06, series: visitors },
      conversion: { value: 0.214, deltaPp: 2.1, series: conversion },
      revenue: { value: 14380, deltaPct: 0.03, series: storeRevenue },
    },
    opportunities: [
      { kind: 'traffic', title: L('Augmenter le trafic en magasin', 'Winkelbezoek verhogen', 'Increase store traffic'), source: L('Magasin · Google Business', 'Winkel · Google Business', 'Store · Google Business'), priority: 'high', estimate: 2400, status: 'recommended' },
      { kind: 'stock', title: L('Stock élevé sur les mugs personnalisés', 'Hoge voorraad personaliseerbare mokken', 'High stock on custom mugs'), source: L('Stock · Ventes', 'Voorraad · Verkoop', 'Stock · Sales'), priority: 'high', estimate: 1150, status: 'review' },
      { kind: 'customers', title: L('Offre groupée étudiants', 'Studentenbundel', 'Student bundle offer'), source: L('Commandes · Clients', 'Bestellingen · Klanten', 'Orders · Customers'), priority: 'medium', estimate: 860, status: 'planned' },
    ],
    experiments: [
      { name: L('Vitrine A/B', 'Etalage A/B', 'Shop window A/B'), kpi: L('Visites en magasin', 'Winkelbezoeken', 'Store visits'), start: inDays(-17), end: inDays(4), status: 'endingSoon' },
      { name: L('Seuil de gravure offerte 40 € vs 50 €', 'Gratis gravure vanaf € 40 vs € 50', 'Free engraving threshold €40 vs €50'), kpi: L('Panier moyen', 'Gemiddelde bestelwaarde', 'Average order value'), start: inDays(-7), end: inDays(14), status: 'running' },
      { name: L('Heure de publication Instagram 12h vs 19h', 'Instagram-posttijd 12u vs 19u', 'Instagram posting time 12:00 vs 19:00'), kpi: L('Taux d’engagement', 'Engagementgraad', 'Engagement rate'), start: inDays(-4), end: inDays(10), status: 'running' },
    ],
  };
}
