// Nordla Growth - SYNTHETIC evaluation cases for the eight AI agents. No merchant, customer or real figure: every number and name is invented
// for the test. Each case is run through the REAL gateway (agents/gateway.js), so the prompt built here is the one a provider would receive.
// `sources` are exactly the shapes the server hands to an agent (status + data). `expect` says what a good answer must reflect:
//   mustMention  - terms the draft should use (taken from the case's own sources), at least one must appear
//   noInventIds  - identifiers that must not appear in the answer (not in the sources)
// The quality of a real provider's answer is measured by grade.js on answers produced for these cases; it is NOT measured here.

const avail = (data) => ({ status: 'available', data });
const absent = (status) => ({ status });

export const CASES = Object.freeze([
  // ---- Stratège: weekly synthesis, priorities, a plan of at most three steps ----
  { id: 'strat-1', agent: 'strategist', question: 'Quelles priorités retenir cette semaine ?',
    sources: { priorities: avail({ items: [{ id: 'fix:purchase-cost', title: 'Coûts d’achat à vérifier', count: 4 }, { id: 'product:coque-chien', title: 'Coque chien', netSales: 320 }] }), products: avail({ rows: [{ name: 'Coque chien', units: 12 }] }), audience: absent('not_connected'), store: avail({ weeks: 8, sales: 1420 }) },
    expect: { mustMention: ['coût', 'coque chien', '4'], noInventIds: ['product:inventé-99'] } },
  { id: 'strat-2', agent: 'strategist', question: '',
    sources: { priorities: avail({ items: [] }), products: absent('unavailable'), audience: absent('unavailable'), store: avail({ weeks: 8, sales: 0 }) },
    expect: { mustMention: ['données', 'indisponible', 'insuffisant'] } },
  { id: 'strat-3', agent: 'strategist', question: 'Plan pour le mois prochain',
    sources: { priorities: avail({ items: [{ id: 'store:weekday:3', title: 'Jeudi fort en magasin', share: 0.22 }] }), products: avail({ rows: [] }), audience: avail({ segments: [{ key: 'loyal', customers: 31 }] }), store: avail({ weeks: 8, sales: 980 }) },
    expect: { mustMention: ['jeudi', 'fidèle', '31'] } },

  // ---- Produits et offres ----
  { id: 'prod-1', agent: 'products', question: 'Quel produit pousser ?',
    sources: { products: avail({ rows: [{ id: 'product:gourde-a', name: 'Gourde A', status: 'push', units: 14, margin: 'verified' }, { id: 'product:gourde-b', name: 'Gourde B', status: 'watch', units: 2, margin: 'unverified' }] }) },
    expect: { mustMention: ['gourde a'], noInventIds: ['product:gourde-z'] } },
  { id: 'prod-2', agent: 'products', question: '',
    sources: { products: avail({ rows: [{ id: 'product:coque-x', name: 'Coque X', status: 'restock', units: 9, stock: 1 }] }) },
    expect: { mustMention: ['coque x', 'stock'] } },
  { id: 'prod-3', agent: 'products', question: 'Faut-il baisser le prix ?',
    sources: { products: avail({ rows: [{ id: 'product:lot-1', name: 'Lot 1', status: 'lowMargin', units: 6, margin: 'partial' }] }) },
    expect: { mustMention: ['lot 1', 'marge'] } },

  // ---- Audience et fidélisation ----
  { id: 'aud-1', agent: 'audience', question: 'Qui réactiver ?',
    sources: { audience: avail({ segments: [{ key: 'reactivate', customers: 42, status: 'priority' }, { key: 'loyal', customers: 18, status: 'develop' }] }) },
    expect: { mustMention: ['réactiv', '42'] } },
  { id: 'aud-2', agent: 'audience', question: '',
    sources: { audience: absent('unavailable') },
    expect: { mustMention: ['indisponible', 'données'] } },
  { id: 'aud-3', agent: 'audience', question: 'Brouillon de campagne pour les nouveaux clients',
    sources: { audience: avail({ segments: [{ key: 'new', customers: 33, status: 'activate' }] }) },
    expect: { mustMention: ['nouveau', '33'] } },

  // ---- Contenu et réseaux sociaux ----
  { id: 'cont-1', agent: 'content', question: 'Idées pour Instagram cette semaine',
    sources: { content: avail({ checks: [{ product: 'Coque chien', problem: 'noAltText' }] }), social: avail({ account: { network: 'instagram' }, posts: [{ id: 'post-1', format: 'reel', units: 3 }] }) },
    expect: { mustMention: ['instagram', 'reel', 'texte alternatif'] } },
  { id: 'cont-2', agent: 'content', question: '',
    sources: { content: avail({ checks: [] }), social: absent('not_connected') },
    expect: { mustMention: ['non connect', 'compte'], needsLimit: ['social'] } },
  { id: 'cont-3', agent: 'content', question: 'Texte pour TikTok',
    sources: { content: avail({ checks: [{ product: 'Gourde A', problem: 'noImage' }] }), social: avail({ account: { network: 'tiktok' }, posts: [] }) },
    expect: { mustMention: ['tiktok', 'gourde a'] } },

  // ---- Boutique locale ----
  { id: 'store-1', agent: 'store', question: 'Quelle offre en magasin ?',
    sources: { store: avail({ weeks: 8, sales: 1500, weekdays: [{ day: 'Samedi', share: 0.31 }, { day: 'Mardi', share: 0.06 }] }) },
    expect: { mustMention: ['samedi', 'mardi'] } },
  { id: 'store-2', agent: 'store', question: '',
    sources: { store: avail({ weeks: 8, sales: 0, weekdays: [] }) },
    expect: { mustMention: ['pas de vente', 'aucune', 'données'] } },
  { id: 'store-3', agent: 'store', question: 'Objectif pour le trimestre',
    sources: { store: avail({ weeks: 8, sales: 2200 }) },
    expect: { mustMention: ['objectif', '2200'] } },

  // ---- Conversion du site (tunnel) ----
  { id: 'conv-1', agent: 'conversion', question: 'Où les visiteurs abandonnent ?',
    sources: { dropoff: avail({ state: 'OK', funnels: [{ scope: 'personalizable', device: 'mobile', steps: [{ step: 'add_to_cart', value: 5, rate: 0.076 }] }] }) },
    expect: { mustMention: ['panier', 'mobile'] } },
  { id: 'conv-2', agent: 'conversion', question: '',
    sources: { dropoff: absent('not_connected') },
    expect: { mustMention: ['non connect', 'instantané', 'données'], needsLimit: ['dropoff'] } },
  { id: 'conv-3', agent: 'conversion', question: 'Améliorer le bouton ajouter au panier',
    sources: { dropoff: avail({ state: 'OK', funnels: [{ scope: 'personalizable', device: 'mobile', steps: [{ step: 'personalization_done', value: 3 }] }] }) },
    expect: { mustMention: ['personnalisation', 'mobile'] } },

  // ---- Publicités (no spend, no change: read and recommend only) ----
  { id: 'ads-1', agent: 'ads', question: 'Faut-il dépenser plus ?',
    sources: { ads: absent('not_connected') },
    expect: { mustMention: ['non connect', 'compte'], needsLimit: ['ads'] } },
  { id: 'ads-2', agent: 'ads', question: 'Lire la campagne Noël',
    sources: { ads: avail({ campaigns: [{ name: 'Noël', spend: 180, clicks: 240, conversions: null }] }) },
    expect: { mustMention: ['noël', 'conversions'] } },
  { id: 'ads-3', agent: 'ads', question: '',
    sources: { ads: avail({ campaigns: [{ name: 'Fête des pères', spend: 42, clicks: 12, conversions: 0 }] }) },
    expect: { mustMention: ['fête des pères'] } },

  // ---- Expériences: hypothesis, measure, duration, stop criteria ----
  { id: 'exp-1', agent: 'experiments', question: 'Tester une réduction en magasin',
    sources: { priorities: avail({ items: [{ id: 'store:weekday:6', title: 'Samedi fort', share: 0.31 }] }), dropoff: absent('not_connected'), store: avail({ weeks: 8, sales: 1500 }) },
    expect: { mustMention: ['hypothèse', 'durée', 'critère', 'samedi'], needsLimit: ['dropoff'] } },
  { id: 'exp-2', agent: 'experiments', question: '',
    sources: { priorities: avail({ items: [] }), dropoff: absent('not_connected'), store: absent('unavailable') },
    expect: { mustMention: ['données', 'aucune'] } },
  { id: 'exp-3', agent: 'experiments', question: 'Mesurer l’effet d’un nouveau visuel',
    sources: { priorities: avail({ items: [{ id: 'product:gourde-a', title: 'Gourde A', status: 'push' }] }), dropoff: avail({ state: 'OK', funnels: [] }), store: avail({ weeks: 8, sales: 900 }) },
    expect: { mustMention: ['hypothèse', 'mesure', 'gourde a'] } },
]);

export const AGENT_CASE_COUNT = Object.freeze(CASES.reduce((m, c) => ({ ...m, [c.agent]: (m[c.agent] ?? 0) + 1 }), {}));
