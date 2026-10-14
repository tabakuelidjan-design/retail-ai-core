// Classification of each rule, kept apart from its logic:
//   scope        GLOBAL (applies to every product that is sold to consumers / imported) or CATEGORY (needs a product trait)
//   materiality  PRODUCT_COMPLIANCE (decides whether and how the PRODUCT may be placed on the market: shapes the product verdict),
//                OPERATOR_ADMIN (registrations, producer responsibility, customs administration: listed as obligations, they never cap the product verdict),
//                CHANNEL (Amazon readiness: never legal marketability)
//   layer        EU | BELGIUM (federal) | REGIONAL (Flanders / Wallonia / Brussels) | CHANNEL.  Membership of a scheme or organisation (Recupel, Bebat, Fost Plus, Valipac)
//                is NOT the legal obligation: see the `obligation` field of each evidence item (LEGAL | SCHEME_SERVICE | OPTIONAL_SERVICE).
const G = 'GLOBAL'; const C = 'CATEGORY'; const P = 'PRODUCT_COMPLIANCE'; const A = 'OPERATOR_ADMIN'; const H = 'CHANNEL';
export const META = Object.freeze({
  'eu.gpsr': { scope: G, materiality: P, layer: 'EU' },
  'eu.nlf_operator': { scope: C, materiality: P, layer: 'EU' },
  'eu.ce': { scope: C, materiality: P, layer: 'EU' },
  'eu.lvd': { scope: C, materiality: P, layer: 'EU' },
  'eu.emc': { scope: C, materiality: P, layer: 'EU' },
  'eu.red': { scope: C, materiality: P, layer: 'EU' },
  'eu.red_cyber': { scope: C, materiality: P, layer: 'EU' },
  'eu.charger': { scope: C, materiality: P, layer: 'EU' },
  'eu.rohs': { scope: C, materiality: P, layer: 'EU' },
  'eu.batteries': { scope: C, materiality: P, layer: 'EU' },
  'transport.lithium': { scope: C, materiality: P, layer: 'EU' },
  'eu.weee': { scope: C, materiality: A, layer: 'EU' },
  'eu.reach': { scope: G, materiality: P, layer: 'EU' },
  'eu.clp': { scope: C, materiality: P, layer: 'EU' },
  'eu.toys': { scope: C, materiality: P, layer: 'EU' },
  'eu.fcm': { scope: C, materiality: P, layer: 'EU' },
  'eu.textiles': { scope: C, materiality: P, layer: 'EU' },
  'eu.cosmetics': { scope: C, materiality: P, layer: 'EU' },
  'eu.ppe': { scope: C, materiality: P, layer: 'EU' },
  'eu.packaging': { scope: G, materiality: A, layer: 'EU' },
  'eu.medical_boundary': { scope: C, materiality: P, layer: 'EU' },
  'customs.eori': { scope: G, materiality: A, layer: 'EU' },
  'be.language': { scope: G, materiality: P, layer: 'BELGIUM' },
  'be.recupel': { scope: C, materiality: A, layer: 'REGIONAL' },
  'be.bebat': { scope: C, materiality: A, layer: 'REGIONAL' },
  'be.packaging': { scope: G, materiality: A, layer: 'REGIONAL' },
  'be.bipt': { scope: C, materiality: P, layer: 'BELGIUM' },
  'be.fcm': { scope: C, materiality: P, layer: 'BELGIUM' },
  'amazon.gpsr_listing': { scope: G, materiality: H, layer: 'CHANNEL' },
  'amazon.category_documents': { scope: C, materiality: H, layer: 'CHANNEL' },
  'amazon.dangerous_goods': { scope: C, materiality: H, layer: 'CHANNEL' },
});
