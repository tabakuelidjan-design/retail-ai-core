// Candidate data contract. Every supplier/merchant-entered value carries a
// BASIS so the evaluator can tell a quote from a guess:
//   QUOTED      stated by the supplier (or a firm merchant decision)
//   ESTIMATED   the merchant's own estimate of a real quantity
//   ASSUMPTION  a working guess
//   (absent)    MISSING - never zero-filled, never defaulted
// Plain numbers are accepted with conservative default bases (documented in
// docs/architecture/buying-intelligence-lite.md). Identity is candidate_id
// only: supplier item codes are free text and are never a key. No SKU logic.

export const BASIS_RANK = { QUOTED: 3, ESTIMATED: 2, ASSUMPTION: 1, MISSING: 0 };
const BASES = Object.keys(BASIS_RANK).filter((b) => b !== 'MISSING');
const PEER_KEYS = ['reference_product_ids', 'collection_ids', 'product_type'];
const CAPABILITY_VALUES = ['yes', 'no', 'unknown'];

const isNum = (x) => typeof x === 'number' && Number.isFinite(x);

/** Shopify ids are canonical. A plain number (as seen in the admin URL) is expanded to its gid. */
export function normalizeShopifyId(kind, id) {
  const s = String(id).trim();
  if (!/^\d+$/.test(s)) return s;
  return kind === 'collection_ids' ? `gid://shopify/Collection/${s}` : `gid://shopify/Product/${s}`;
}

/** Accepts `12` or `{ value: 12, basis: 'QUOTED' }`; returns { value, basis } or null when absent. */
function valued(raw, name, defaultBasis, errors, { min = 0, allowZero = false } = {}) {
  if (raw === undefined || raw === null) return null;
  const obj = typeof raw === 'object' ? raw : { value: raw };
  if (obj.value === undefined || obj.value === null) return null; // { "value": null } = unknown, which is allowed
  if (!isNum(obj.value) || obj.value < min || (!allowZero && obj.value === 0)) {
    errors.push(`${name}: must be a ${allowZero ? 'non-negative' : 'positive'} number`);
    return null;
  }
  const basis = obj.basis ?? defaultBasis;
  if (!BASES.includes(basis)) {
    errors.push(`${name}: basis must be one of ${BASES.join(', ')}`);
    return null;
  }
  return { value: obj.value, basis };
}

/**
 * @returns {{candidate: object|null, errors: string[], warnings: string[]}}
 * Errors mean the file is malformed (nothing is evaluated). Missing optional/required-for-verdict
 * inputs are NOT errors: they surface as INCOMPLETE checks with an exact list of what to supply.
 */
export function normalizeCandidate(raw, { merchantCurrency }) {
  const errors = [];
  const warnings = [];
  if (!raw || typeof raw !== 'object') return { candidate: null, errors: ['candidate must be a JSON object'], warnings };
  if (typeof raw.candidate_id !== 'string' || raw.candidate_id.trim() === '') errors.push('candidate_id: required string assigned by the merchant');

  const currency = raw.currency ?? merchantCurrency;
  const unitPrice = valued(raw.unit_price, 'unit_price', 'QUOTED', errors);
  const moqRaw = raw.moq;
  const moq = valued(moqRaw, 'moq', 'QUOTED', errors);
  if (moq) moq.per = (typeof moqRaw === 'object' && moqRaw.per) || 'per_order';
  if (moq && !['per_order', 'per_variant'].includes(moq.per)) errors.push('moq.per: must be per_order or per_variant');
  const variantsPlanned = raw.variants_planned === undefined ? null : raw.variants_planned;
  if (variantsPlanned !== null && !(Number.isInteger(variantsPlanned) && variantsPlanned >= 1)) errors.push('variants_planned: must be a positive integer');

  const lc = raw.landed_cost ?? {};
  const landed = {
    freight: valued(lc.freight_per_unit, 'landed_cost.freight_per_unit', 'ESTIMATED', errors, { allowZero: true }),
    duties: valued(lc.duties_per_unit, 'landed_cost.duties_per_unit', 'ESTIMATED', errors, { allowZero: true }),
    other: valued(lc.other_per_unit, 'landed_cost.other_per_unit', 'ESTIMATED', errors, { allowZero: true }),
    not_applicable: Array.isArray(lc.not_applicable) ? lc.not_applicable : [],
  };
  for (const n of landed.not_applicable) if (!['freight', 'duties'].includes(n)) errors.push(`landed_cost.not_applicable: unknown component "${n}" (use freight or duties)`);

  const rr = raw.expected_retail_price;
  let retail = null;
  if (rr !== undefined && rr !== null && !(typeof rr === 'object' && (rr.value === undefined || rr.value === null))) {
    const obj = typeof rr === 'object' ? rr : { value: rr };
    if (!isNum(obj.value) || obj.value <= 0) errors.push('expected_retail_price.value: must be a positive number');
    else {
      const basis = obj.basis ?? 'ASSUMPTION';
      if (!['DECIDED', 'ASSUMPTION'].includes(basis)) errors.push('expected_retail_price.basis: DECIDED (the merchant has fixed the price) or ASSUMPTION');
      const taxBasis = obj.tax_basis ?? null;
      if (taxBasis !== null && !['incl', 'excl'].includes(taxBasis)) errors.push('expected_retail_price.tax_basis: incl or excl');
      retail = { value: obj.value, basis, tax_basis: taxBasis, tax_rate: valued(obj.tax_rate, 'expected_retail_price.tax_rate', 'ASSUMPTION', errors, { allowZero: true }) };
    }
  }

  const fx = valued(raw.fx_rate_assumption, 'fx_rate_assumption', 'ASSUMPTION', errors);
  const lead = valued(raw.lead_time_days, 'lead_time_days', 'QUOTED', errors);
  const testQty = valued(raw.test_quantity, 'test_quantity', 'QUOTED', errors);

  const peerSets = [];
  if (raw.peer_sets !== undefined && !Array.isArray(raw.peer_sets)) errors.push('peer_sets: must be an array');
  for (const [i, set] of (Array.isArray(raw.peer_sets) ? raw.peer_sets : []).entries()) {
    const keys = PEER_KEYS.filter((k) => set && set[k] !== undefined);
    if (keys.length !== 1) { errors.push(`peer_sets[${i}]: exactly one of ${PEER_KEYS.join(', ')}`); continue; }
    const key = keys[0];
    const value = set[key];
    const okList = Array.isArray(value) && value.length > 0 && value.every((v) => typeof v === 'string' && v.trim() !== '');
    if (key === 'product_type') {
      if (typeof value !== 'string' || value.trim() === '' || value === 'UNCLASSIFIED') { errors.push(`peer_sets[${i}].product_type: a real product_type value (UNCLASSIFIED is not a category)`); continue; }
    } else if (!okList) { errors.push(`peer_sets[${i}].${key}: non-empty array of Shopify ids`); continue; }
    peerSets.push({ label: set.label ?? `${key}#${i + 1}`, kind: key, ids: key === 'product_type' ? [value] : value.map((v) => normalizeShopifyId(key, v)) });
  }

  const caps = {};
  for (const [k, v] of Object.entries(raw.supplier_capabilities ?? {})) {
    if (!CAPABILITY_VALUES.includes(v)) errors.push(`supplier_capabilities.${k}: yes, no or unknown`);
    else caps[k] = v;
  }
  const requiredCaps = Array.isArray(raw.required_capabilities) ? raw.required_capabilities : [];

  if (currency !== merchantCurrency && !fx) warnings.push(`currency ${currency} differs from the merchant currency ${merchantCurrency}: supply fx_rate_assumption (never fetched)`);
  if (raw.sku !== undefined || raw.supplier_sku !== undefined) warnings.push('sku fields are ignored: SKU is never an identity');

  if (errors.length) return { candidate: null, errors, warnings };
  return {
    candidate: {
      candidate_id: raw.candidate_id.trim(), name: raw.name ?? null, supplier_item_ref: raw.supplier_item_ref ?? null, notes: raw.notes ?? null,
      currency, unit_price: unitPrice, moq, variants_planned: variantsPlanned, test_quantity: testQty, lead_time_days: lead,
      landed, retail, fx_rate: fx, required_capabilities: requiredCaps, supplier_capabilities: caps,
      sample_available: raw.sample_available ?? null, peer_sets: peerSets,
      external_signals: Array.isArray(raw.external_signals) ? raw.external_signals : [],
    },
    errors, warnings,
  };
}
