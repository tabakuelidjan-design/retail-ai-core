// Nordla Growth - REMAX evaluation groups (separate from the 24 synthetic reference cases in cases.js, which stay unchanged).
//  - remax (REAL catalogue facts): built only from the public snapshot (remax-catalogue.js). Public fields only; no purchase cost, margin,
//    supplier, stock, sales, orders or customer key. Where a figure is missing, the expected answer says so.
//  - remax-synthetic (FICTIONAL commercial metrics): every commercial figure sits under a `synthetic` block labelled FICTIF, so the agent is tested
//    on reasoning, and must say which numbers are fictitious and which facts come from the catalogue.

import { REMAX_TECH, REMAX_SNAPSHOT_DATE } from './remax-catalogue.js';

const avail = (data) => ({ status: 'available', data });
const absent = (status) => ({ status });

/** One public row, in the shape the agent reads. */
const row = (p) => ({ id: `product:${p.handle}`, name: p.title, vendor: p.vendor, productType: p.productType, tags: p.tags, storefrontStatus: p.status, priceEur: p.price });
const byHandle = (h) => {
  const p = REMAX_TECH.find((x) => x.handle === h);
  if (!p) throw new Error(`REMAX case refers to an unknown product handle: ${h}`); // never invent a product
  return p;
};
const prices = REMAX_TECH.map((p) => Number(p.price));
const summary = {
  catalogue: 'public', snapshotDate: REMAX_SNAPSHOT_DATE, count: REMAX_TECH.length,
  minPriceEur: Math.min(...prices).toFixed(2), maxPriceEur: Math.max(...prices).toFixed(2),
};
const publicOnly = { catalogue: 'public', note: 'champs publics seulement : ventes, marges et stocks non fournis à cet agent' };
const FICTIVE = 'FICTIF – données de test, non issues de Shopify';

export const REMAX_CASES = Object.freeze([
  // ---- REAL catalogue facts: Produits and Stratège, public fields only ----
  { id: 'remax-prod-1', group: 'remax', agent: 'products', question: '',
    sources: { products: avail({ ...publicOnly, rows: [row(byHandle('batterie-externe-mini-10000mah-22-5w'))] }) },
    expect: { mustMention: ['batterie mini'], mustStateMissing: ['vente', 'marge'] } },
  { id: 'remax-prod-2', group: 'remax', agent: 'products', question: 'Faut-il baisser le prix ?',
    sources: { products: avail({ ...publicOnly, rows: [row(byHandle('cable-tresse-usb-c-30w-65w'))] }) },
    expect: { mustMention: ['cable tresse'], mustStateMissing: ['marge', 'vente'] } },
  { id: 'remax-prod-3', group: 'remax', agent: 'products', question: 'Quel produit pousser ?',
    sources: { products: avail({ ...publicOnly, rows: [row(byHandle('casque-bluetooth-telescopique-et-pliable'))] }) },
    expect: { mustMention: ['rb-870'], mustStateMissing: ['vente'] } },
  { id: 'remax-strat-1', group: 'remax', agent: 'strategist', question: 'Vue d’ensemble de la gamme REMAX ?',
    sources: { priorities: absent('unavailable'), products: avail({ ...summary, rows: REMAX_TECH.map(row) }), audience: absent('unavailable'), store: absent('unavailable') },
    expect: { mustMention: ['remax', String(summary.count)], mustStateMissing: ['priorit'] } },
  { id: 'remax-strat-2', group: 'remax', agent: 'strategist', question: 'Quelle priorité retenir cette semaine ?',
    sources: { priorities: absent('unavailable'), products: avail({ ...summary, rows: REMAX_TECH.map(row) }), audience: absent('unavailable'), store: absent('unavailable') },
    expect: { mustMention: ['remax'], mustStateMissing: ['priorit'] } },

  // ---- FICTIONAL commercial metrics, labelled: the agent must separate catalogue facts, fictitious figures and missing data ----
  { id: 'remax-syn-prod-1', group: 'remax-synthetic', agent: 'products', question: 'Faut-il pousser ce produit ?',
    sources: { products: avail({ catalogue: 'public', rows: [row(byHandle('batterie-externe-mini-10000mah-22-5w'))],
      synthetic: { label: FICTIVE, netUnits8w: 12, marginRateFictive: 0.31 } }) },
    expect: { mustMention: ['batterie mini', '29'], mustLabelSynthetic: true, mustStateMissing: ['stock'] } },
  { id: 'remax-syn-prod-2', group: 'remax-synthetic', agent: 'products', question: 'Faut-il baisser le prix ?',
    sources: { products: avail({ catalogue: 'public', rows: [row(byHandle('casque-bluetooth-rb-980hb-plongez-dans-le-son'))],
      synthetic: { label: FICTIVE, netUnits8w: 2, marginRateFictive: 0.08 } }) },
    expect: { mustMention: ['rb-980hb'], mustLabelSynthetic: true, mustStateMissing: ['stock'] } },
  { id: 'remax-syn-strat-1', group: 'remax-synthetic', agent: 'strategist', question: 'Quelles priorités retenir ?',
    sources: { priorities: absent('unavailable'), audience: absent('unavailable'), store: absent('unavailable'),
      products: avail({ ...summary, rows: REMAX_TECH.slice(0, 3).map(row),
        synthetic: { label: FICTIVE, byProduct: [{ handle: 'casque-bluetooth-remax-rb-300hb-pliable', netUnits8w: 9 }, { handle: 'cable-tresse-usb-c-30w-65w', netUnits8w: 30 }] } }) },
    expect: { mustMention: ['remax'], mustLabelSynthetic: true, mustStateMissing: ['priorit'] } },
]);

/** Keys that must never appear in a REAL-catalogue case (purchase, margin, supplier, stock, sales, customers), at any depth. */
export const FORBIDDEN_KEYS = Object.freeze(['cost', 'unitCost', 'margin', 'supplier', 'stock', 'inventory', 'sales', 'netSales', 'orders', 'customer', 'customers', 'email', 'phone']);
