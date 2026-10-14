// Field V1 fixtures. Everything is INVENTED (suppliers, models, quotations, documents): no real supplier, lab or product. The product is a UV-printable stainless-steel tumbler, the kind of item a
// personalised-gifts merchant buys; the merchant profile is the real HABB data file (config/merchants/habb/sourcing-fit.json), read as DATA.
import { readFileSync } from 'node:fs';
import { newCase, dispatch } from '../src/sourcing/core/case.js';
import { offerDraft } from '../src/sourcing/core/field/offer-import.js';
import { docsFor, LIVE_CLEAN } from './sourcing-fixtures.js';

export const NOW = new Date('2026-10-20T12:00:00Z');
export const EXT = { safety: LIVE_CLEAN };
export const PROFILE = JSON.parse(readFileSync(new URL('../config/merchants/habb/sourcing-fit.json', import.meta.url), 'utf8'));
export const t = (h, m = 0) => new Date(Date.UTC(2026, 9, 20, h, m)); // 2026-10-20 at h:m UTC
export { docsFor, LIVE_CLEAN };

/** the merchant's own selling-side costs for one printed unit, entered by the owner as estimates (UV ink and labour, gift packaging, a returns allowance) */
export const SALE_LINES = [{ key: 'uvPrint', label: 'UV print (ink, labour)', kind: 'per_unit', value: 2.2, status: 'ESTIMATED' }, { key: 'giftPack', label: 'gift packaging', kind: 'per_unit', value: 0.6, status: 'ESTIMATED' }, { key: 'returns', label: 'returns allowance', kind: 'pct_of_net', value: 3, status: 'ESTIMATED' }];

/** what the owner enters about import costs: freight and brokerage as estimates, the rest explicitly zero (a cost that is not entered would make the landed cost a lower bound) */
// freight === null means "not typed at all": the Incoterm already covers it (typing it again would count it twice)
export const costsEvent = ({ freight = 620, origin = 0, brokerage = 90, inbound = 40 } = {}) => ({ type: 'COSTS', costs: { fx: { rate: 0.92, date: '2026-10-19', source: 'USER_ENTERED' },
  costs: { ...(freight === null ? {} : { freight: { total: freight, status: 'ESTIMATED' } }), originCharges: origin ? { total: origin, status: 'ESTIMATED' } : { total: 0, status: 'KNOWN' }, brokerage: { total: brokerage, status: 'ESTIMATED' }, inspection: { total: 0, status: 'KNOWN' }, testing: { total: 0, status: 'KNOWN' }, labelling: { total: 0, status: 'KNOWN' }, epr: { total: 0, status: 'KNOWN' }, inboundLogistics: { total: inbound, status: 'ESTIMATED' }, insurance: { total: 0, status: 'KNOWN' } }, importVat: { ratePct: 21, recoverable: true } } });

/** a case for a tumbler, as the owner would have it after a minute at the stand: name, the answers he knows, the plan (quantity, selling price, margin), his import cost estimates */
export function tumbler(id, { supplier = `Supplier ${id}`, now = t(8), qty = 1000, costs = {}, model = null, sellingPrice = 19.9, target = 55, extra = [] } = {}) {
  let c = newCase({ id, name: 'Stainless steel tumbler 500 ml', now });
  const evs = [{ type: 'CATEGORY', category: 'water_bottle' }, { type: 'TRAIT', trait: 'foodContact', value: true }, ...['electrical.present', 'battery.present', 'radio.present', 'childrenUse', 'cosmetic', 'ppe', 'textile', 'medical', 'chemicalMixture'].map((k) => ({ type: 'TRAIT', trait: k, value: false })),
    { type: 'PLACING', placing: { underOwnNameOrBrand: false, manufacturerEstablishedInEU: false, euAuthorisedRepresentative: false, substantialModification: false } }, { type: 'SUPPLIER', supplier: { name: supplier } }, { type: 'PLAN_QTY', qty },
    costsEvent(costs), { type: 'CUSTOMS', customs: { chosenCode: '7323.93', duty: { ratePct: 2.7, kind: 'USER_ENTERED', source: 'owner' } } }, { type: 'SALE', sale: { sellingPriceGross: sellingPrice, vatRatePct: 21, targetContributionPct: target, priceBasis: 'TARGET', lines: SALE_LINES } }, ...(model ? [{ type: 'IDENTIFIER', name: 'model', value: model, level: 'USER_STATED' }] : []), ...extra];
  for (const e of evs) c = dispatch(c, e, now); return c;
}
export const withDocs = (c, model, now = t(8)) => docsFor.bottle(model).reduce((x, d) => dispatch(x, d, now), c);

/** import an offer then review it: confirm every proposed fact that does not need a correction (an ambiguous one is left for the owner). Returns the new case. */
export function importAndConfirm(c, ev, now, { skip = [], only = null } = {}) {
  let s = dispatch(c, { type: 'OFFER_IMPORT', ...ev }, now); const o = s.offers.at(-1); const d = offerDraft(s, o.id);
  for (const f of d.fields) { if (f.review.state !== 'PENDING' || f.needsCorrection) continue; if (skip.includes(f.key) || (only && !only.includes(f.key))) continue; if (f.speaker === 'unknown') continue; try { s = dispatch(s, { type: 'CANDIDATE_CONFIRM', id: f.id }, now); } catch { /* a conflict is raised, not thrown; anything else is left pending */ } }
  return s;
}
export const offerOf = (s, i = -1) => s.offers.at(i);
export const openConflicts = (s) => s.conflicts.filter((x) => x.state === 'OPEN');
