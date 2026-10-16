// Same purchase through the THREE landed-cost engines of the repository, to compare inputs, arithmetic, rounding and what each does with a missing input. Synthetic numbers only.
//   node docs/integration/landed-cost-engines/compare.mjs [repo-root]      (prints a table; no file is written)
// A = Sourcing   src/sourcing/core/landed.js        landedCost(input)            integer EUR cents, Incoterm-aware, KNOWN/ESTIMATED/UNKNOWN, ranges
// B = Finance    src/finance/purchase-analysis.js    analyzePurchase(input)       integer cents + basis points, explicit human FX, refuses silent conversion
// C = Buying     src/buying/economics.js             landedCost(candidate, cfg)   floating point per-unit bands (best / nominal / worst), no quantity, no duty rate
import { pathToFileURL } from 'node:url';
import { resolve, join } from 'node:path';

const root = resolve(process.argv[2] ?? '.');
const imp = (rel) => import(pathToFileURL(join(root, rel)).href);
const [{ landedCost: A }, { analyzePurchase: B }, { landedCost: C }, { ZERO_COSTS }] = await Promise.all([imp('src/sourcing/core/landed.js'), imp('src/finance/purchase-analysis.js'), imp('src/buying/economics.js'), imp('test/sourcing-zero-costs.js')]);
const eurC = (c) => (c === null || c === undefined ? 'null' : (c / 100).toFixed(4));
const safe = (f) => { try { return f(); } catch (e) { return { threw: `${e.name}: ${e.code ?? e.message}` }; } };

function scenario(name, p) {
  // A: Sourcing
  const a = safe(() => A({ supplier: { unitPrice: p.price, currency: p.cur, qty: p.qty, moq: p.qty, incoterm: p.incoterm ?? 'FOB' }, fx: p.fx ? { rate: p.fx, date: '2026-10-02', source: 'USER_ENTERED' } : null,
    costs: { ...(p.zero ? ZERO_COSTS : {}), ...(p.freight !== undefined ? { freight: { total: p.freight, status: 'ESTIMATED' } } : {}), ...(p.insurance !== undefined ? { insurance: { total: p.insurance, status: 'ESTIMATED' } } : {}), ...(p.duty !== undefined ? { customsDuty: { ratePct: p.duty, status: 'ESTIMATED', source: 'USER_ENTERED' } } : {}) }, importVat: { ratePct: 21, recoverable: true } }));
  const aOut = a.threw ? a.threw : `${a.status} per unit ${eurC(a.totals?.landedPerUnitEurMinor)} total ${eurC(a.totals?.landedTotalEurMinor)}${a.criticalUnknown?.length ? ` critical:${a.criticalUnknown.join('+')}` : ''}${a.isLowerBound ? ' LOWER_BOUND' : ''}`;
  // B: Finance
  const b = safe(() => B({ supplier_unit_price: p.price, currency: p.cur, qty: p.qty, ...(p.freight !== undefined ? { freight_total: String(p.freight) } : {}), ...(p.otherZero ? { other_costs_total: '0' } : {}), duty_rate_pct: String(p.duty ?? 0), import_vat_rate_pct: '21', ...(p.fx ? { fx: { rate: p.fx, provenance: 'USER_PROVIDED' } } : {}) }));
  const bOut = b.threw ? b.threw : `${b.status} per unit ${b.landed_cost?.per_unit ?? '-'} total ${b.landed_cost?.total ?? '-'} risks:${(b.risks ?? []).join('+') || '-'}`;
  // C: Buying (per unit, floating point; the caller must pre-compute a per-unit duty: it has no rate)
  const dutyPerUnit = p.duty !== undefined && p.freight !== undefined ? ((Number(p.price) * Number(p.fx ?? 1) * p.qty + Number(p.freight)) * (p.duty / 100)) / p.qty : undefined;
  const c = safe(() => C({ currency: p.cur, fx_rate: p.fx ? { value: Number(p.fx), basis: 'QUOTED' } : null, unit_price: { value: Number(p.price), basis: 'QUOTED' }, landed: { freight: p.freight !== undefined ? { value: Number(p.freight) / p.qty / Number(p.fx ?? 1), basis: 'QUOTED' } : null, duties: dutyPerUnit !== undefined ? { value: dutyPerUnit / Number(p.fx ?? 1), basis: 'QUOTED' } : null, other: null, not_applicable: [] } }, { merchantCurrency: 'EUR', tol: 0.1 }));
  const cOut = c.threw ? c.threw : `${c.status} nominal per unit ${c.nominal === undefined ? '-' : c.nominal.toFixed(6)}${c.missing?.length ? ` missing:${c.missing.join('+')}` : ''}`;
  console.log(`\n## ${name}\n  A Sourcing: ${aOut}\n  B Finance : ${bOut}\n  C Buying  : ${cOut}`);
}

scenario('S1  USD 4.20 x 1000, FX 0.92, freight 600 EUR, duty 2.7 %, other costs entered as 0', { price: '4.20', cur: 'USD', qty: 1000, fx: '0.92', freight: 600, duty: 2.7, zero: true, otherZero: true });
scenario('S2  same but price 4.3333 (rounding)', { price: '4.3333', cur: 'USD', qty: 777, fx: '0.9137', freight: 333.33, duty: 3.7, zero: true, otherZero: true });
scenario('S3  same as S1 plus insurance 50 EUR (is duty charged on goods+freight or goods+freight+insurance?)', { price: '4.20', cur: 'USD', qty: 1000, fx: '0.92', freight: 600, insurance: 50, duty: 2.7, zero: true, otherZero: true });
scenario('S4  freight not entered', { price: '4.20', cur: 'USD', qty: 1000, fx: '0.92', duty: 2.7, zero: true, otherZero: true });
scenario('S5  USD price, NO exchange rate', { price: '4.20', cur: 'USD', qty: 1000, freight: 600, duty: 2.7, zero: true, otherZero: true });
scenario('S6  EUR price (no FX needed), freight 600, duty 0 %', { price: '4.20', cur: 'EUR', qty: 1000, freight: 600, duty: 0, zero: true, otherZero: true });
scenario('S7  EXW (buyer pays everything) vs the same numbers: does the engine care about the Incoterm?', { price: '4.20', cur: 'EUR', qty: 1000, freight: 600, duty: 0, zero: true, otherZero: true, incoterm: 'EXW' });
