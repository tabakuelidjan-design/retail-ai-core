// VAT as deterministic, configurable logic. No global 21% assumption: the merchant selects the treatment and each
// line's rate, and validation blocks inconsistent combinations. This module encodes structure (which combinations
// are coherent), never a tax-law opinion. Legal mentions are merchant-confirmed text, not generated here.

import { percentOfCents } from './money.js';

/** Treatments the merchant may select. `requiresCustomerVat` / `zeroOnly` are structural checks. */
export const VAT_REGIMES = {
  domestic: { label: 'Domestic supply, VAT charged', zeroOnly: false, requiresCustomerVat: false, requiresMention: false },
  intra_eu_b2b_exempt: { label: 'Intra-EU B2B supply, VAT exempt', zeroOnly: true, requiresCustomerVat: true, requiresMention: true, customerCountryNot: true },
  reverse_charge: { label: 'Reverse charge (VAT due by the customer)', zeroOnly: true, requiresCustomerVat: true, requiresMention: true },
  export_outside_eu: { label: 'Export outside the EU', zeroOnly: true, requiresCustomerVat: false, requiresMention: true },
  vat_exempt_small_business: { label: 'VAT-exempt (small business scheme)', zeroOnly: true, requiresCustomerVat: false, requiresMention: true },
};

/** EN 16931 / Peppol VAT category codes for a structured invoice. */
export function vatCategoryCode(regime, rateBp) {
  if (regime === 'intra_eu_b2b_exempt') return 'K';
  if (regime === 'reverse_charge') return 'AE';
  if (regime === 'export_outside_eu') return 'G';
  if (regime === 'vat_exempt_small_business') return 'E';
  return rateBp === 0 ? 'Z' : 'S';
}

export const DEFAULT_VAT_CONFIG = {
  // Rates the merchant allows on domestic documents, in basis points. Empty = nothing is allowed until configured.
  allowedRatesBp: [],
};

/**
 * Per-rate VAT totals (EN 16931 style): VAT of a rate group = round(sum of net in that group * rate).
 * @param {Array<{netCents: number, vatRateBp: number}>} lines
 */
export function vatBreakdown(lines) {
  const groups = new Map();
  for (const l of lines) groups.set(l.vatRateBp, (groups.get(l.vatRateBp) ?? 0) + l.netCents);
  return [...groups.entries()].sort((a, b) => a[0] - b[0]).map(([vatRateBp, taxableCents]) => ({ vatRateBp, taxableCents, vatCents: percentOfCents(taxableCents, vatRateBp) }));
}

/** Structural VAT validation for a document. Returns error codes; empty = coherent. */
export function validateVat({ regime, regimeConfirmed, lines, customer, mention, vatConfig, sellerVatNumber }) {
  const errors = [];
  const r = VAT_REGIMES[regime];
  if (!r) return ['VAT_REGIME_MISSING_OR_UNKNOWN'];
  if (regimeConfirmed !== true) errors.push('VAT_TREATMENT_NOT_CONFIRMED_BY_MERCHANT');
  if (!sellerVatNumber && regime !== 'vat_exempt_small_business') errors.push('SELLER_VAT_NUMBER_MISSING');
  for (const [i, l] of lines.entries()) {
    if (!Number.isInteger(l.vatRateBp) || l.vatRateBp < 0) errors.push(`LINE_${i + 1}_VAT_RATE_MISSING`);
    else if (r.zeroOnly && l.vatRateBp !== 0) errors.push(`LINE_${i + 1}_RATE_MUST_BE_ZERO_FOR_${regime.toUpperCase()}`);
    else if (!r.zeroOnly && !(vatConfig?.allowedRatesBp ?? []).includes(l.vatRateBp)) errors.push(`LINE_${i + 1}_RATE_NOT_ALLOWED_BY_MERCHANT_CONFIG`);
  }
  if (r.requiresCustomerVat && !customer?.vatNumber) errors.push('CUSTOMER_VAT_NUMBER_REQUIRED_FOR_TREATMENT');
  if (r.customerCountryNot && customer?.address?.countryCode === 'BE') errors.push('INTRA_EU_TREATMENT_INCOMPATIBLE_WITH_BELGIAN_CUSTOMER');
  if (r.requiresMention && !(mention && mention.trim())) errors.push('LEGAL_MENTION_REQUIRED_FOR_TREATMENT');
  return errors;
}
