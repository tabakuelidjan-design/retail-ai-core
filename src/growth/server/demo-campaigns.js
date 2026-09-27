// Growth > Campagnes - DEMONSTRATION data only (`demo: true`). No ad platform is connected yet; the rows are illustrative,
// deterministic and generic (no retailer name). Every KPI, every per-channel figure and the 30-day revenue/spend chart are
// DERIVED from the campaign rows, so the page cannot contradict itself. A real source returns the same payload shape.
//
// Dates are relative to "today" (startIn / endIn in days) so the campaigns always fit the page's fixed window, the last
// 30 days: running campaigns overlap it, "ready" and "planned" ones start after today.
// Per campaign: spend = spent in the window (<= budget); revenue / clicks / newCustomers = results in the window;
// performance = result vs the campaign's own objective target (1 = 100 %); null for a campaign not launched yet ("ready").
// Not-yet-launched campaigns have no results.
// Channel ids match the channel logos (src/growth/ui/assets/channels/). `theme` = what the campaign is about; the UI
// picks the campaign's thumbnail icon from it (the data never names icons).

const L = (fr, nl, en) => ({ fr, nl, en });
const none = { spend: 0, revenue: 0, clicks: 0, newCustomers: 0 };

const CAMPAIGNS = [
  { id: 'autumn-collection', theme: 'collection', title: L('Collection automne', 'Herfstcollectie', 'Autumn collection'), subtitle: L('Nouvelle collection', 'Nieuwe collectie', 'New collection'), channel: 'google-search', objective: 'sales', startIn: -25, endIn: 5, budget: 2000, status: 'running', performance: 1.05, spend: 650, revenue: 2100, clicks: 7800, newCustomers: 390 },
  { id: 'student-offer', theme: 'students', title: L('Offre étudiants', 'Studentenaanbod', 'Student offer'), subtitle: L('-20 % avec le code ÉTUDIANT', '-20 % met de code STUDENT', '-20% with the code STUDENT'), channel: 'instagram', objective: 'sales', startIn: 3, endIn: 33, budget: 1500, status: 'ready', performance: null, ...none },
  { id: 'tiktok-challenge', theme: 'challenge', title: L('TikTok Challenge', 'TikTok Challenge', 'TikTok Challenge'), subtitle: L('#NordlaStyle', '#NordlaStyle', '#NordlaStyle'), channel: 'tiktok', objective: 'awareness', startIn: -20, endIn: 10, budget: 1000, status: 'running', performance: 0.72, spend: 480, revenue: 1400, clicks: 4100, newCustomers: 210 },
  { id: 'holiday-season', theme: 'gifts', title: L('Fêtes de fin d’année', 'Eindejaarsfeesten', 'Holiday season'), subtitle: L('Idées cadeaux', 'Cadeau-ideeën', 'Gift ideas'), channel: 'facebook', objective: 'sales', startIn: 20, endIn: 66, budget: 2500, status: 'planned', performance: 0, ...none },
  { id: 'store-opening', theme: 'storeOpening', title: L('Ouverture Lyon', 'Opening Lyon', 'Lyon opening'), subtitle: L('Nouveau magasin', 'Nieuwe winkel', 'New store'), channel: 'google-business', objective: 'storeTraffic', startIn: -25, endIn: 5, budget: 1000, status: 'running', performance: 1.10, spend: 100, revenue: 500, clicks: 800, newCustomers: 80 },
  { id: 'accessory-bundle', theme: 'bundle', title: L('Bundle accessoires', 'Accessoirebundel', 'Accessory bundle'), subtitle: L('Coque + support', 'Hoesje + houder', 'Case + stand'), channel: 'instagram', objective: 'sales', startIn: -25, endIn: 5, budget: 1000, status: 'running', performance: 0.88, spend: 280, revenue: 900, clicks: 2400, newCustomers: 150 },
  { id: 'loyalty-programme', theme: 'loyalty', title: L('Programme fidélité', 'Loyaliteitsprogramma', 'Loyalty programme'), subtitle: L('Avantages membres', 'Ledenvoordelen', 'Member benefits'), channel: 'google-search', objective: 'retention', startIn: -54, endIn: 5, budget: 1500, status: 'running', performance: 0.95, spend: 300, revenue: 600, clicks: 3100, newCustomers: 60 },
  { id: 'store-recruitment', theme: 'recruitment', title: L('Recrutement magasin', 'Winkelrekrutering', 'Store recruitment'), subtitle: L('Rejoignez notre équipe', 'Word lid van ons team', 'Join our team'), channel: 'facebook', objective: 'recruitment', startIn: 10, endIn: 55, budget: 800, status: 'planned', performance: 0, ...none },
  { id: 'brand-search', theme: 'brandSearch', title: L('Recherche marque', 'Merkzoekopdrachten', 'Brand search'), subtitle: L('Mots-clés de marque', 'Merkzoekwoorden', 'Brand keywords'), channel: 'google-search', objective: 'sales', startIn: -29, endIn: 1, budget: 500, status: 'running', performance: 1.01, spend: 150, revenue: 500, clicks: 2600, newCustomers: 110 },
  { id: 'new-arrivals', theme: 'newArrivals', title: L('Nouveautés', 'Nieuw binnen', 'New arrivals'), subtitle: L('Carrousel produits', 'Productcarrousel', 'Product carousel'), channel: 'instagram', objective: 'sales', startIn: -25, endIn: 5, budget: 800, status: 'running', performance: 0.92, spend: 330, revenue: 1200, clicks: 2200, newCustomers: 140 },
  { id: 'visitor-retargeting', theme: 'retargeting', title: L('Retargeting visiteurs', 'Retargeting bezoekers', 'Visitor retargeting'), subtitle: L('Paniers abandonnés', 'Verlaten winkelmandjes', 'Abandoned carts'), channel: 'facebook', objective: 'sales', startIn: -29, endIn: 1, budget: 500, status: 'running', performance: 0.97, spend: 180, revenue: 1200, clicks: 1500, newCustomers: 90 },
  { id: 'customisation-tutorials', theme: 'tutorial', title: L('Tutoriels personnalisation', 'Personalisatietutorials', 'Customisation tutorials'), subtitle: L('Série vidéo', 'Videoreeks', 'Video series'), channel: 'tiktok', objective: 'awareness', startIn: 15, endIn: 44, budget: 600, status: 'planned', performance: 0, ...none },
];
// Display order of the channels (same ids as the logos).
const CHANNELS = [
  { id: 'google-search', name: 'Google Search' },
  { id: 'instagram', name: 'Instagram' },
  { id: 'tiktok', name: 'TikTok' },
  { id: 'facebook', name: 'Facebook' },
  { id: 'google-business', name: 'Google Business' },
];

const DAY = 86400000;
const WINDOW = 30; // days, the page's fixed period ("30 derniers jours")

/** Deterministic spread of an integer `total` over `n` days (weekly rhythm + small wave), summing exactly to `total`. */
function spread(total, days, phase) {
  if (!total || !days.length) return days.map(() => 0);
  const raw = days.map((iso, i) => {
    const dow = new Date(`${iso}T00:00:00Z`).getUTCDay();
    return (dow === 6 ? 1.35 : dow === 0 ? 1.15 : 1) * (1 + 0.12 * Math.sin((i + phase) * 1.3));
  });
  const k = raw.reduce((x, y) => x + y, 0);
  const out = raw.map((v) => Math.round((v / k) * total));
  out[out.length - 1] += total - out.reduce((x, y) => x + y, 0);
  return out;
}

export function buildDemoCampaigns(now = new Date()) {
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const iso = (n) => new Date(today.getTime() + n * DAY).toISOString().slice(0, 10);
  const dates = Array.from({ length: WINDOW }, (_, i) => iso(i - (WINDOW - 1)));
  const campaigns = CAMPAIGNS.map(({ startIn, endIn, ...c }) => ({ ...c, start: iso(startIn), end: iso(endIn) }));
  // Daily revenue and spend of the window = each running campaign's window results spread over its active days in the window.
  const daily = (key) => {
    const acc = dates.map(() => 0);
    CAMPAIGNS.forEach((c, ci) => {
      if (!c[key]) return;
      const from = Math.max(c.startIn, -(WINDOW - 1)); const to = Math.min(c.endIn, 0);
      const idx = dates.map((_, i) => i).filter((i) => i - (WINDOW - 1) >= from && i - (WINDOW - 1) <= to);
      spread(c[key], idx.map((i) => dates[i]), ci).forEach((v, j) => { acc[idx[j]] += v; });
    });
    return acc;
  };
  const sum = (a, k) => a.reduce((x, c) => x + c[k], 0);
  const revenue = sum(CAMPAIGNS, 'revenue');
  const spend = sum(CAMPAIGNS, 'spend');
  const roas = Math.round((revenue / spend) * 10) / 10;
  return {
    demo: true,
    currency: 'EUR',
    generatedAt: now.toISOString(),
    // Previous-period values give the variations (+28 %, +35 %, +42 %, +0,8).
    kpis: {
      revenue: { value: revenue, previous: 6560 },
      clicks: { value: sum(CAMPAIGNS, 'clicks'), previous: 18150 },
      newCustomers: { value: sum(CAMPAIGNS, 'newCustomers'), previous: 866 },
      roas: { value: roas, previous: 2.6 },
    },
    period: { key: 'last_30_days', from: dates[0], to: dates[WINDOW - 1] },
    campaigns,
    // Revenue vs spend, per day over the window (sums = the revenue KPI and the total spend behind the ROAS).
    trend: { dates, revenue: daily('revenue'), spend: daily('spend'), totals: { revenue, spend } },
    // Per channel: revenue, spend and ROAS summed/derived from that channel's rows (ROAS null when nothing was spent).
    channels: CHANNELS.map((c) => {
      const rows = CAMPAIGNS.filter((x) => x.channel === c.id);
      const rev = sum(rows, 'revenue'); const sp = sum(rows, 'spend');
      return { ...c, revenue: rev, spend: sp, roas: sp ? Math.round((rev / sp) * 10) / 10 : null, share: revenue ? rev / revenue : 0 };
    }),
    // Priority actions, each tied to a campaign row (its channel logo comes from that row).
    actions: [
      { campaignId: 'student-offer', kind: 'launch', title: L('Lancer l’offre étudiants', 'Het studentenaanbod lanceren', 'Launch the student offer'), text: L('La campagne est prête à être lancée.', 'De campagne is klaar om te starten.', 'The campaign is ready to launch.') },
      { campaignId: 'autumn-collection', kind: 'optimise', title: L('Optimiser la collection automne', 'De herfstcollectie optimaliseren', 'Optimise the autumn collection'), text: L('Augmenter le budget pour capitaliser sur les bons résultats.', 'Verhoog het budget om de goede resultaten te benutten.', 'Increase the budget to build on the good results.') },
      { campaignId: 'tiktok-challenge', kind: 'improve', title: L('Améliorer la performance', 'De prestaties verbeteren', 'Improve performance'), text: L('Le taux d’engagement est en baisse depuis 7 jours.', 'De engagementgraad daalt al 7 dagen.', 'The engagement rate has been falling for 7 days.') },
    ],
  };
}
