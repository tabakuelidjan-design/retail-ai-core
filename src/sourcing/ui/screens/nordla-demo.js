// Demonstration values for the Core home. Used ONLY when the home is opened with ?demo=1: the same home, with these example figures in place
// of the server's. Every figure carries a « DÉMO » tag and the banner says so. Nothing here is read from the server or from the merchant's data.
// The shapes are the ones the server returns (GET /api/core/sales, GET /api/connections, GET /api/core/modules), so the same rendering runs.

export const DEMO_TAG = ''; // the DÉMO badges are removed; the banner stays
export const DEMO_BANNER = '<p class="nx-h-demo-banner" role="note">Affichage de démonstration : valeurs d’exemple, non réelles.</p>';

/** Example sales of 30 days, consistent with each other: 12 450 € over 86 orders (average basket 144,77 €), weekly series summing to it. */
export const DEMO_SALES = Object.freeze({
  status: 'AVAILABLE', source: 'Exemple', currency: 'EUR',
  values: [{ key: 'net_sales_ex_tax', value: 12450, unit: 'EUR' }, { key: 'order_count', value: 86, unit: 'count' }],
  comparison: { rows: [{ key: 'net_sales_ex_tax', delta_pct: 0.087 }, { key: 'order_count', delta_pct: 0.147 }, { key: 'aov_ex_tax', delta_pct: 0.009 }] },
  weekly: [
    { week_start: '2026-09-28', net_sales_ex_tax: 1480, order_count: 9 },
    { week_start: '2026-10-05', net_sales_ex_tax: 1560, order_count: 10 },
    { week_start: '2026-10-12', net_sales_ex_tax: 1690, order_count: 11 },
    { week_start: '2026-10-19', net_sales_ex_tax: 1750, order_count: 12 },
    { week_start: '2026-10-26', net_sales_ex_tax: 1890, order_count: 13 },
    { week_start: '2026-11-02', net_sales_ex_tax: 2010, order_count: 14 },
    { week_start: '2026-11-09', net_sales_ex_tax: 2070, order_count: 17 },
  ],
  channels: [
    { ref: 'online', label: 'Boutique en ligne', values: [{ key: 'net_sales_ex_tax', value: 7719 }] },
    { ref: 'pos', label: 'Magasin', values: [{ key: 'net_sales_ex_tax', value: 3486 }] },
    { ref: 'other', label: 'Autres', values: [{ key: 'net_sales_ex_tax', value: 1245 }] },
  ],
});

export const DEMO_CONNECTIONS = Object.freeze([
  { id: 'shopify', label: 'Shopify', statusLabel: 'Statut réel', connected: false },
  { id: 'instagram', label: 'Instagram', statusLabel: 'Statut réel', connected: false },
  { id: 'tiktok', label: 'TikTok', statusLabel: 'Statut réel', connected: false },
  { id: 'google_business_profile', label: 'Google Business Profile', statusLabel: 'Statut réel', connected: false },
]);

/** The menu of the example, in the reference's order. Entries without a Core module are example entries of the demonstration only: they open nothing. */
export const DEMO_MENU = Object.freeze([
  { key: 'finance', label: 'Finance' },
  { key: 'analytics', label: 'Analyses' },
  { key: 'procurement', label: 'Stock & Achats' },
  { key: 'sourcing', label: 'Sourcing' },
  { key: 'growth', label: 'Croissance' },
  { key: 'branding', label: 'Branding' },
  { key: 'marketing', label: 'Marketing' },
  { key: 'creative', label: 'Création' },
]);

/** Illustration of the phone bars of Panier moyen, as the copy (image 72), in heights %. Demonstration only. */
export const DEMO_SPARKS = Object.freeze({
  ventes: [20, 32, 40, 50, 60, 100],
  commandes: [22, 30, 40, 55, 72, 100],
  panier: [84, 88, 86, 84, 82, 76],
  evo: [20, 30, 42, 36, 60, 50, 100],
  // the fifteen bars of the reference (image 106), in % of the tallest
  evoRef: [5, 10, 13, 20, 33, 24, 42, 32, 61, 40, 65, 51, 78, 100, 58],
  panierPh: [30, 40, 50, 62, 80, 100],
});
