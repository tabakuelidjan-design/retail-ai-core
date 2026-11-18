// In-store payment channel resolution (pure, no I/O).
//
// Shopify POS records a sale under a gateway label ("cash", "sumup", ...). HABB also takes
// payments through a QR code generated in KBC, which has no dedicated Shopify POS option and
// was historically recorded under "sumup". This module:
//   - keeps the label Shopify gave (`gateway_label`), never rewritten;
//   - resolves the method Finance reports (`method`) only from a justificatif that matches it;
//   - marks anything without such a justificatif as AMBIGUOUS (to verify), never as confirmed;
//   - counts each order once, keyed by its Shopify id;
//   - imputes only fees Shopify actually reported on the transaction, never an estimate.

export const IN_STORE_METHODS = ['cash', 'card', 'qr_kbc', 'sumup', 'bank_transfer', 'other'];

// Evidence that may confirm a method. A justificatif must match the method it confirms.
const EVIDENCE_FOR = {
  qr_kbc: ['KBC_STATEMENT'], // KBC bank statement line for the QR payment
  sumup: ['SUMUP_RECEIPT'], // SumUp transaction report / receipt
};

// Shopify gateway label -> method reported before any confirmation. Unknown labels stay unresolved.
const LABEL_TO_METHOD = { cash: 'cash', sumup: 'sumup' };

export function normalizeGatewayLabel(raw) {
  if (typeof raw !== 'string') return null;
  const t = raw.trim().toLowerCase();
  return t === '' ? null : t;
}

/**
 * @param {object} input
 * @param {string|null} input.gatewayLabel  label exactly as Shopify returned it
 * @param {{method: 'qr_kbc'|'sumup', evidence: string, reference: string}|null} [input.confirmation]
 * @returns {{gateway_label: string|null, method: string|null, status: 'CONFIRMED'|'AMBIGUOUS'|'REJECTED', reason: string, evidence: string|null, reference: string|null}}
 */
export function resolveInStorePayment({ gatewayLabel, confirmation = null } = {}) {
  const label = normalizeGatewayLabel(gatewayLabel);
  const observed = label ? LABEL_TO_METHOD[label] ?? null : null;

  if (confirmation) {
    const allowed = EVIDENCE_FOR[confirmation.method];
    if (!allowed || !allowed.includes(confirmation.evidence) || !confirmation.reference) {
      return { gateway_label: label, method: observed, status: 'REJECTED', reason: 'EVIDENCE_DOES_NOT_MATCH_METHOD', evidence: confirmation.evidence ?? null, reference: confirmation.reference ?? null };
    }
    return { gateway_label: label, method: confirmation.method, status: 'CONFIRMED', reason: 'JUSTIFICATIF_MATCHES', evidence: confirmation.evidence, reference: confirmation.reference };
  }

  if (observed === 'cash') return { gateway_label: label, method: 'cash', status: 'CONFIRMED', reason: 'SHOPIFY_CASH', evidence: null, reference: null };
  if (observed === 'sumup') {
    // "sumup" may hide a KBC QR payment: never confirmed without a justificatif.
    return { gateway_label: label, method: 'sumup', status: 'AMBIGUOUS', reason: 'SUMUP_LABEL_WITHOUT_JUSTIFICATIF', evidence: null, reference: null };
  }
  return { gateway_label: label, method: null, status: 'AMBIGUOUS', reason: label ? 'UNKNOWN_GATEWAY_LABEL' : 'NO_GATEWAY_LABEL', evidence: null, reference: null };
}

/**
 * Fees for one captured payment. Only what Shopify reported is imputed; a missing fee is
 * "not visible", never a rate applied to the amount.
 */
export function imputedFees({ reportedFees }) {
  if (reportedFees === undefined || reportedFees === null) return { fee_cents: 0, fee_status: 'NOT_VISIBLE' };
  const cents = Math.round(Number(reportedFees) * 100);
  if (!Number.isFinite(cents) || cents < 0) throw new Error('invalid reported fee');
  return { fee_cents: cents, fee_status: 'REPORTED' };
}

/**
 * Keep each Shopify order once (by its Shopify id), even when the same sale arrives twice.
 * The first occurrence wins; a later duplicate is reported, not added.
 */
export function dedupeOrders(orders) {
  const seen = new Map();
  const duplicates = [];
  for (const o of orders) {
    if (seen.has(o.id)) duplicates.push(o.id);
    else seen.set(o.id, o);
  }
  return { orders: [...seen.values()], duplicates };
}
