// Finance's answer to "what does this planned purchase cost, and does it pay?" - the one place the integration asks for landed cost, cash requirement and margin
// of a PLANNED purchase. Integer cents and basis points only (money.js); nothing here is a model's output, nothing is fetched.
//
// Currency rule (same as currency.js): Finance never converts silently. An amount in a currency other than the merchant currency is refused with
// CURRENCY_CONFLICT unless the caller supplies an explicit fx { rate, provenance } stated by a human; every converted figure is then flagged ESTIMATED.
// A planned purchase is not a purchase: nothing here records an invoice, a payment, a commitment or a stock movement.

import { toCents, toQtyMilli, toPriceMicro, percentToBp, lineGrossCents, percentOfCents, divRound, BP } from './money.js';

export const PURCHASE_ANALYSIS_VERSION = 'finance-purchase-analysis.v1';
export const MERCHANT_CURRENCY = 'EUR';
export const RISK = Object.freeze({
  CURRENCY_CONFLICT: 'CURRENCY_CONFLICT',
  FX_ESTIMATED: 'FX_ESTIMATED',
  NEGATIVE_MARGIN: 'NEGATIVE_MARGIN',
  THIN_MARGIN: 'THIN_MARGIN',
  EXCEEDS_AVAILABLE_CASH: 'EXCEEDS_AVAILABLE_CASH',
  COST_UNKNOWN: 'COST_UNKNOWN',
  INPUT_INVALID: 'INPUT_INVALID',
});
export const THIN_MARGIN_BP = 1500; // 15 % of net revenue: below this the analysis says so (a flag, not a verdict)

const deepFreeze = (o) => { if (o && typeof o === 'object' && !Object.isFrozen(o)) { Object.freeze(o); for (const v of Object.values(o)) deepFreeze(v); } return o; };
const bad = (field, reason) => ({ field, reason });
const money = (v) => (v === undefined || v === null ? null : toCents(v));

/** Scale a foreign amount (cents) to merchant cents with an explicit rate (merchant units per 1 foreign unit, 6 decimals max). Rounded half-up. */
function convertCents(cents, rate) {
  const r = toScaledRate(rate);
  return Number(divRound(BigInt(cents) * BigInt(r), 1_000_000n));
}
const toScaledRate = (rate) => {
  const s = String(rate).trim();
  const m = /^(\d+)(?:\.(\d{1,6}))?$/.exec(s);
  if (!m) return null;
  return Number(BigInt(m[1] + (m[2] ?? '').padEnd(6, '0')));
};

/**
 * @param {object} input
 *  supplier_unit_price  decimal string ("4.20")          currency  ISO code of the supplier price
 *  qty                  integer                          freight_total / other_costs_total  decimal string in `cost_currency` (default: merchant currency)
 *  duty_rate_pct        decimal string ("2.7") on customs value (goods + freight)
 *  import_vat_rate_pct  decimal string ("21"), recoverable by assumption: counted in the cash requirement, not in landed cost
 *  expected_selling_price_gross  decimal string, merchant currency, VAT included     selling_vat_rate_pct  ("21")
 *  payment_terms        { deposit_pct, balance_pct } (shares of goods value, optional)
 *  fx                   { rate: "0.92", provenance: "USER_PROVIDED" | ... } merchant units per 1 supplier-currency unit; required when currency differs
 *  cash_available_cents integer (optional)
 * @returns frozen analysis; status ANALYZED | CURRENCY_CONFLICT | INPUT_INVALID
 */
export function analyzePurchase(input = {}, { merchantCurrency = MERCHANT_CURRENCY } = {}) {
  const errors = [];
  const priceMicro = toPriceMicro(input.supplier_unit_price);
  if (priceMicro === null || priceMicro <= 0) errors.push(bad('supplier_unit_price', 'a positive decimal with at most 4 places is required'));
  const qty = Number.isInteger(input.qty) && input.qty > 0 ? input.qty : null;
  if (qty === null) errors.push(bad('qty', 'a positive integer is required'));
  if (typeof input.currency !== 'string' || !/^[A-Z]{3}$/.test(input.currency)) errors.push(bad('currency', 'an ISO 4217 code is required'));
  const rates = {};
  for (const [k, def] of [['duty_rate_pct', '0'], ['import_vat_rate_pct', '0'], ['selling_vat_rate_pct', null]]) {
    const v = input[k] ?? def;
    rates[k] = v === null ? null : percentToBp(v);
    if (v !== null && (rates[k] === null || rates[k] < 0)) errors.push(bad(k, 'a percentage with at most 2 places is required'));
  }
  const unknown = [];
  const costFields = {};
  for (const k of ['freight_total', 'other_costs_total']) {
    if (input[k] === undefined || input[k] === null) { costFields[k] = 0; unknown.push(k); continue; }
    costFields[k] = money(input[k]);
    if (costFields[k] === null || costFields[k] < 0) errors.push(bad(k, 'a non-negative decimal with at most 2 places is required'));
  }
  if (errors.length) return Object.freeze({ version: PURCHASE_ANALYSIS_VERSION, status: RISK.INPUT_INVALID, errors, risks: [RISK.INPUT_INVALID] });

  const foreign = input.currency !== merchantCurrency;
  const risks = [];
  let rate = 1_000_000;
  if (foreign) {
    const r = input.fx && toScaledRate(input.fx.rate);
    const humanProvenance = ['USER_PROVIDED', 'VERIFIED'].includes(input.fx?.provenance);
    if (!r || !humanProvenance) {
      return Object.freeze({
        version: PURCHASE_ANALYSIS_VERSION, status: RISK.CURRENCY_CONFLICT, risks: [RISK.CURRENCY_CONFLICT],
        conflict: { supplier_currency: input.currency, merchant_currency: merchantCurrency, reason: 'no explicit human-stated fx rate: Finance does not convert silently', converted: false },
      });
    }
    rate = r; risks.push(RISK.FX_ESTIMATED);
  }
  const toMerchant = (cents) => (foreign ? convertCents(cents, input.fx.rate) : cents);

  // goods: the supplier price is in the supplier currency; freight / other costs are entered in the merchant currency (cost_currency, if different, is refused)
  if (input.cost_currency && input.cost_currency !== merchantCurrency) {
    return Object.freeze({ version: PURCHASE_ANALYSIS_VERSION, status: RISK.CURRENCY_CONFLICT, risks: [RISK.CURRENCY_CONFLICT], conflict: { field: 'cost_currency', cost_currency: input.cost_currency, merchant_currency: merchantCurrency, converted: false } });
  }
  const goodsSupplierCents = lineGrossCents(toQtyMilli(String(qty)), priceMicro);
  const goods = toMerchant(goodsSupplierCents);
  const freight = costFields.freight_total;
  const other = costFields.other_costs_total;
  const customsValue = goods + freight;
  const duty = percentOfCents(customsValue, rates.duty_rate_pct);
  const importVat = percentOfCents(customsValue + duty, rates.import_vat_rate_pct);
  const landedTotal = goods + freight + duty + other;
  const landedPerUnit = Number(divRound(BigInt(landedTotal), BigInt(qty)));
  const cashRequirement = landedTotal + importVat; // peak cash: import VAT is advanced and recovered later (assumption, stated)

  const out = {
    version: PURCHASE_ANALYSIS_VERSION, status: 'ANALYZED', currency: merchantCurrency, qty,
    components: { goods, freight, duty, other, import_vat_advanced: importVat },
    landed_cost: { total: landedTotal, per_unit: landedPerUnit, basis: foreign ? 'ESTIMATED' : (unknown.length ? 'LOWER_BOUND' : 'CALCULATED'), unknown_inputs: unknown },
    cash_requirement: { total: cashRequirement, basis: foreign ? 'ESTIMATED' : (unknown.length ? 'LOWER_BOUND' : 'CALCULATED'), vat_recoverable_assumed: true },
    fx: foreign ? { supplier_currency: input.currency, rate: input.fx.rate, provenance: input.fx.provenance } : null,
    assumptions: ['import VAT is advanced in cash and assumed fully recoverable', ...(foreign ? ['converted with the stated fx rate; never a market rate'] : [])],
  };
  if (unknown.length) risks.push(RISK.COST_UNKNOWN);

  // payment schedule from the terms: shares of the goods value (basis points), everything else at the balance date
  const t = input.payment_terms;
  if (t) {
    const dep = percentToBp(String(t.deposit_pct ?? 0)); const bal = percentToBp(String(t.balance_pct ?? 0));
    if (dep === null || bal === null || dep + bal !== Number(BP)) risks.push(RISK.INPUT_INVALID);
    else {
      const deposit = percentOfCents(goods, dep);
      out.payment_schedule = { deposit, balance_and_charges: cashRequirement - deposit };
    }
  }

  // margin on the expected selling price (net of selling VAT); absent price = not computed, never guessed
  if (input.expected_selling_price_gross !== undefined && input.expected_selling_price_gross !== null && rates.selling_vat_rate_pct !== null) {
    const grossUnit = toCents(input.expected_selling_price_gross);
    if (grossUnit === null || grossUnit <= 0) risks.push(RISK.INPUT_INVALID);
    else {
      const netUnit = Number(divRound(BigInt(grossUnit) * BP, BP + BigInt(rates.selling_vat_rate_pct)));
      const margin = netUnit - landedPerUnit;
      const marginBp = netUnit > 0 ? Number(divRound(BigInt(margin) * BP, BigInt(netUnit))) : null;
      out.margin = { net_price_per_unit: netUnit, gross_margin_per_unit: margin, gross_margin_bp: marginBp, basis: out.landed_cost.basis === 'CALCULATED' ? 'CALCULATED' : 'ESTIMATED_OR_LOWER_BOUND', break_even_net_price: landedPerUnit };
      if (margin < 0) risks.push(RISK.NEGATIVE_MARGIN); else if (marginBp !== null && marginBp < THIN_MARGIN_BP) risks.push(RISK.THIN_MARGIN);
    }
  }
  if (Number.isInteger(input.cash_available_cents) && cashRequirement > input.cash_available_cents) {
    risks.push(RISK.EXCEEDS_AVAILABLE_CASH);
    out.cash_shortfall = cashRequirement - input.cash_available_cents;
  }
  out.risks = [...new Set(risks)];
  out.owner_approval = 'NOT_REQUESTED'; // an analysis commits nothing
  return deepFreeze(out);
}

/** Scenario comparison: the same purchase at several quantities (or terms). Each scenario is a full analysis; nothing is ranked by an opaque score. */
export function compareScenarios(base, scenarios, opts) {
  const rows = scenarios.map((s) => ({ label: s.label ?? `qty ${s.qty ?? base.qty}`, analysis: analyzePurchase({ ...base, ...s.override, ...(s.qty ? { qty: s.qty } : {}) }, opts) }));
  return deepFreeze({
    version: PURCHASE_ANALYSIS_VERSION,
    scenarios: rows,
    by_axis: {
      lowest_cash: pick(rows, (a) => a.cash_requirement?.total, 'min'),
      highest_margin: pick(rows, (a) => a.margin?.gross_margin_bp, 'max'),
    },
    note: 'axes are shown separately; no multiplicative score (NDR-006)',
  });
}
function pick(rows, f, mode) {
  const ok = rows.filter((r) => r.analysis.status === 'ANALYZED' && f(r.analysis) != null);
  if (!ok.length) return null;
  const best = ok.reduce((b, r) => ((mode === 'min' ? f(r.analysis) < f(b.analysis) : f(r.analysis) > f(b.analysis)) ? r : b));
  return best.label;
}
