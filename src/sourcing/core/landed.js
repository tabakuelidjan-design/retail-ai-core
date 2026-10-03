// Deterministic landed-cost calculator. Everything it knows is KNOWN (entered/quoted), ESTIMATED (explicit estimate, optionally min/max) or UNKNOWN
// (missing). Nothing is invented: no duty rate, no freight, no FX is ever assumed. Customs duty is applied to the customs value (goods + origin
// charges + freight + insurance up to the EU border) only when a rate was supplied (by the user, or by an official lookup adapter that says so).
//
// Amounts in EUR minor units unless a field says otherwise. The supplier price is in the supplier currency and converted with an EXPLICIT fx rate.
import { toMinor, pctToBps, applyBps, roundHalfAway, MoneyError } from './money.js';
import { FACT_CLASS } from './levels.js';

/** What each Incoterm 2020 puts on the buyer (a simplification for cost completeness, not a contract interpretation). */
export const INCOTERMS = Object.freeze({
  EXW: { originCharges: false, mainFreight: false, insurance: false, importDuties: false },
  FCA: { originCharges: true, mainFreight: false, insurance: false, importDuties: false },
  FOB: { originCharges: true, mainFreight: false, insurance: false, importDuties: false },
  CFR: { originCharges: true, mainFreight: true, insurance: false, importDuties: false },
  CIF: { originCharges: true, mainFreight: true, insurance: true, importDuties: false },
  CPT: { originCharges: true, mainFreight: true, insurance: false, importDuties: false },
  CIP: { originCharges: true, mainFreight: true, insurance: true, importDuties: false },
  DAP: { originCharges: true, mainFreight: true, insurance: true, importDuties: false },
  DPU: { originCharges: true, mainFreight: true, insurance: true, importDuties: false },
  DDP: { originCharges: true, mainFreight: true, insurance: true, importDuties: true },
});

const LINE_KEYS = ['originCharges', 'freight', 'insurance', 'brokerage', 'inspection', 'testing', 'labelling', 'packaging', 'epr', 'inboundLogistics', 'amazonPrep'];
const lineEur = (spec, qty) => {
  // spec: { total | perUnit, status, min?, max?, source?, note? } in EUR. Returns total minor units or null.
  if (!spec) return null;
  const t = spec.total !== undefined && spec.total !== null ? toMinor(spec.total) : spec.perUnit !== undefined && spec.perUnit !== null ? roundHalfAway(toMinor(spec.perUnit) * qty) : null;
  return t;
};
const rangeOf = (spec, qty) => {
  const f = (x, perUnitKey) => (x === undefined || x === null ? null : (spec.total !== undefined && spec.total !== null ? toMinor(x) : roundHalfAway(toMinor(x) * qty)));
  void f;
  const conv = (v) => (v === undefined || v === null ? null : (spec.perUnit !== undefined && spec.perUnit !== null ? roundHalfAway(toMinor(v) * qty) : toMinor(v)));
  return { min: conv(spec.min), max: conv(spec.max) };
};

/**
 * @param {object} input see docs/sourcing-field-mode.md
 * @returns {{ status: 'COMPLETE'|'RANGE'|'INFORMATION_INSUFFICIENT', quantity: number, lines: object[], goods: object, customs: object, importVat: object, totals: object,
 *             unknown: string[], criticalUnknown: string[], warnings: string[], factClass: string }}
 */
export function landedCost(input) {
  const warnings = []; const lines = []; const unknown = []; const criticalUnknown = [];
  const qty = Number(input.supplier?.qty ?? 0);
  if (!(qty > 0)) throw new MoneyError('QUANTITY_REQUIRED', 'quantity must be > 0');
  const moq = input.supplier?.moq ?? null; if (moq && qty < Number(moq)) warnings.push(`QUANTITY_BELOW_MOQ (${qty} < ${moq})`);
  const incoterm = input.supplier?.incoterm ?? null; const inc = incoterm ? INCOTERMS[incoterm] : null;
  if (incoterm && !inc) throw new MoneyError('INCOTERM_UNKNOWN', incoterm);
  if (!incoterm) warnings.push('INCOTERM_NOT_STATED');

  // ---- goods (supplier currency -> EUR with an explicit rate) ----
  const cur = (input.supplier?.currency ?? 'EUR').toUpperCase();
  const unitMinor = toMinor(input.supplier?.unitPrice);
  let goodsEur = null; let fx = null;
  if (unitMinor === null) { unknown.push('supplier.unitPrice'); criticalUnknown.push('supplier.unitPrice'); }
  else if (cur === 'EUR') { goodsEur = unitMinor * qty; }
  else if (input.fx && Number(input.fx.rate) > 0) { fx = { rate: Number(input.fx.rate), date: input.fx.date ?? null, source: input.fx.source ?? 'USER_ENTERED', from: cur, to: 'EUR' }; goodsEur = roundHalfAway(unitMinor * qty * fx.rate); }
  else { unknown.push(`fx.${cur}EUR`); criticalUnknown.push(`fx.${cur}EUR`); }
  const goods = { currency: cur, unitPriceMinor: unitMinor, quantity: qty, totalEurMinor: goodsEur, fx, status: goodsEur === null ? 'UNKNOWN' : 'KNOWN', factClass: FACT_CLASS.SUPPLIER_CLAIM };

  // ---- cost lines ----
  const costs = input.costs ?? {};
  const values = {}; // key -> { minor, min, max, status }
  for (const key of LINE_KEYS) {
    const spec = costs[key]; const covered = inc && ((key === 'originCharges' && inc.originCharges) || (key === 'freight' && inc.mainFreight) || (key === 'insurance' && inc.insurance));
    if (covered && (!spec || (spec.total === undefined && spec.perUnit === undefined))) { values[key] = { minor: 0, status: 'INCLUDED_IN_PRICE', min: null, max: null }; lines.push({ key, status: 'INCLUDED_IN_PRICE', totalMinor: 0, note: `included by ${incoterm}` }); continue; }
    if (key === 'insurance' && spec && spec.ratePct !== undefined && spec.ratePct !== null && spec.total === undefined) {
      values[key] = { rateBps: pctToBps(spec.ratePct), status: spec.status ?? 'ESTIMATED' }; continue; // resolved below, needs goods + freight
    }
    const total = lineEur(spec, qty);
    if (total === null) {
      const st = spec?.status === 'UNKNOWN' || !spec ? 'UNKNOWN' : 'UNKNOWN';
      values[key] = { minor: null, status: st };
      unknown.push(`costs.${key}`);
      if (key === 'freight' && !(inc && inc.mainFreight)) criticalUnknown.push('costs.freight');
      lines.push({ key, status: 'UNKNOWN', totalMinor: null });
      continue;
    }
    const status = spec.status === 'ESTIMATED' ? 'ESTIMATED' : spec.status === 'UNKNOWN' ? 'UNKNOWN' : 'KNOWN';
    const r = rangeOf(spec, qty);
    values[key] = { minor: total, status, min: r.min, max: r.max };
    lines.push({ key, status, totalMinor: total, min: r.min, max: r.max, source: spec.source ?? null, note: spec.note ?? null });
  }
  // insurance as a rate of (goods + origin + freight)
  if (values.insurance && values.insurance.rateBps !== undefined) {
    const base = (goodsEur ?? 0) + (values.originCharges?.minor ?? 0) + (values.freight?.minor ?? 0);
    const minor = goodsEur === null ? null : applyBps(base, values.insurance.rateBps);
    values.insurance = { minor, status: minor === null ? 'UNKNOWN' : values.insurance.status, min: null, max: null };
    lines.push({ key: 'insurance', status: values.insurance.status, totalMinor: minor, note: `rate ${values.insurance.rateBps / 100}% of goods+origin+freight` });
    if (minor === null) unknown.push('costs.insurance');
  }
  for (const [i, o] of (costs.other ?? []).entries()) {
    const total = lineEur(o, qty);
    if (total === null) { unknown.push(`costs.other[${i}]`); lines.push({ key: `other:${o.label ?? i}`, status: 'UNKNOWN', totalMinor: null }); continue; }
    lines.push({ key: `other:${o.label ?? i}`, status: o.status === 'ESTIMATED' ? 'ESTIMATED' : 'KNOWN', totalMinor: total, ...rangeOf(o, qty), note: o.note ?? null });
  }

  // ---- customs value, duty (only with a supplied rate) ----
  const cv = goodsEur === null ? null : goodsEur + (values.originCharges?.minor ?? 0) + (values.freight?.minor ?? 0) + (values.insurance?.minor ?? 0);
  const customsValue = cv === null || values.freight?.minor === null ? null : cv;
  const dutiesIncluded = inc?.importDuties === true;
  const dutySpec = costs.customsDuty; let dutyMinor = null; let dutyStatus = 'UNKNOWN';
  if (dutiesIncluded) { dutyMinor = 0; dutyStatus = 'INCLUDED_IN_PRICE'; }
  else if (dutySpec && dutySpec.ratePct !== undefined && dutySpec.ratePct !== null) {
    if (customsValue === null) { unknown.push('customsValue'); }
    else { dutyMinor = applyBps(customsValue, pctToBps(dutySpec.ratePct)); dutyStatus = dutySpec.status === 'ESTIMATED' ? 'ESTIMATED' : 'KNOWN'; }
  } else { unknown.push('costs.customsDuty'); criticalUnknown.push('costs.customsDuty'); }
  lines.push({ key: 'customsDuty', status: dutyStatus, totalMinor: dutyMinor, ratePct: dutySpec?.ratePct ?? null, basis: 'CUSTOMS_VALUE', source: dutySpec?.source ?? null, note: dutySpec?.note ?? null, factClass: dutyMinor === null ? FACT_CLASS.UNKNOWN : FACT_CLASS.CALCULATED_VALUE });
  let otherDutyMinor = 0;
  for (const [i, d] of (costs.otherDuties ?? []).entries()) { if (customsValue === null) { unknown.push(`costs.otherDuties[${i}]`); continue; } const m = applyBps(customsValue, pctToBps(d.ratePct)); otherDutyMinor += m; lines.push({ key: `otherDuty:${d.label ?? i}`, status: d.status === 'ESTIMATED' ? 'ESTIMATED' : 'KNOWN', totalMinor: m, ratePct: d.ratePct, basis: 'CUSTOMS_VALUE' }); }

  // ---- import VAT (information; recoverable VAT is not a cost) ----
  const vatSpec = input.importVat; let importVat = { status: 'NOT_PROVIDED', minor: null, recoverable: null, includedInLanded: false };
  if (vatSpec && vatSpec.ratePct !== undefined && customsValue !== null && dutyMinor !== null) {
    const vatBase = customsValue + dutyMinor + otherDutyMinor + (values.brokerage?.minor ?? 0);
    const minor = applyBps(vatBase, pctToBps(vatSpec.ratePct));
    importVat = { status: 'CALCULATED', minor, recoverable: vatSpec.recoverable !== false, includedInLanded: vatSpec.recoverable === false, base: vatBase };
  }

  // ---- totals ----
  const sumBy = (pred) => lines.filter(pred).reduce((a, l) => a + (l.totalMinor ?? 0), 0);
  const knownMinor = (goodsEur ?? 0) + sumBy((l) => l.status === 'KNOWN') + 0;
  const estimatedMinor = sumBy((l) => l.status === 'ESTIMATED');
  const vatCost = importVat.includedInLanded ? importVat.minor : 0;
  const landedTotal = goodsEur === null ? null : knownMinor + estimatedMinor + otherDutyMinorSafe(lines, otherDutyMinor) + vatCost;
  // range: estimated lines with min/max widen the total; unknown lines are NOT in the range (they are listed)
  const estLines = lines.filter((l) => l.status === 'ESTIMATED');
  const hasRange = estLines.some((l) => l.min !== null && l.min !== undefined && l.max !== null && l.max !== undefined);
  const lo = landedTotal === null ? null : landedTotal - estLines.reduce((a, l) => a + (l.totalMinor - (l.min ?? l.totalMinor)), 0);
  const hi = landedTotal === null ? null : landedTotal + estLines.reduce((a, l) => a + ((l.max ?? l.totalMinor) - l.totalMinor), 0);
  const totals = {
    purchaseTotalEurMinor: goodsEur, knownMinor: goodsEur === null ? null : knownMinor, estimatedMinor, landedTotalEurMinor: landedTotal,
    landedPerUnitEurMinor: landedTotal === null ? null : roundHalfAway(landedTotal / qty), rangeEurMinor: hasRange && landedTotal !== null ? { min: lo, max: hi, perUnit: { min: roundHalfAway(lo / qty), max: roundHalfAway(hi / qty) } } : null,
    importCostEurMinor: landedTotal === null ? null : landedTotal - goodsEur,
  };
  const status = criticalUnknown.length ? 'INFORMATION_INSUFFICIENT' : hasRange ? 'RANGE' : 'COMPLETE';
  if (unknown.length && !criticalUnknown.length) warnings.push(`NON_CRITICAL_COSTS_UNKNOWN: ${unknown.join(', ')} (excluded from the total)`);
  return {
    status, quantity: qty, incoterm, lines, goods, customs: { customsValueMinor: customsValue, dutyMinor, dutyStatus, otherDutiesMinor: otherDutyMinor, dutiesIncludedByIncoterm: dutiesIncluded },
    importVat, totals, unknown, criticalUnknown, warnings, factClass: status === 'INFORMATION_INSUFFICIENT' ? FACT_CLASS.UNKNOWN : FACT_CLASS.CALCULATED_VALUE,
  };
}
function otherDutyMinorSafe(lines, otherDutyMinor) { return lines.some((l) => l.key.startsWith('otherDuty:') && l.status !== 'UNKNOWN') ? 0 : otherDutyMinor; }
