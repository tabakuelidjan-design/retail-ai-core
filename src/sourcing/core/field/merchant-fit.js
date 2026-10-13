// MERCHANT FIT (the pilot merchant's "fit" checklist). A transparent checklist, not a score: every dimension has a state, a reason and the evidence it rests on.
//   SUPPORTED  the evidence on record supports a fit        PARTIAL  mixed or against (see `lean`)        UNKNOWN  nothing to judge on        NOT_APPLICABLE  the question does not arise
// The ENGINE is generic: everything specific to one merchant (what it sells, which materials its printing process accepts, its seasons, its price band) is DATA in a merchant profile
// (config/merchants/<id>/sourcing-fit.json). A profile value left null is not a default: the dimension says what the owner still has to set.
// The summary label is a counting rule over the dimensions (HIGH / MEDIUM / LOW / INSUFFICIENT_EVIDENCE), printed with the rule. It is not a probability and not a prediction of sales.
import { effective } from '../identity.js';
import { CATEGORIES } from '../taxonomy.js';

export const FIT_STATE = Object.freeze({ SUPPORTED: 'SUPPORTED', PARTIAL: 'PARTIAL', UNKNOWN: 'UNKNOWN', NOT_APPLICABLE: 'NOT_APPLICABLE' });
export const FIT_LABEL = Object.freeze({ HIGH: 'HIGH', MEDIUM: 'MEDIUM', LOW: 'LOW', INSUFFICIENT_EVIDENCE: 'INSUFFICIENT_EVIDENCE' });
export const FIT_RULE = 'Known dimensions = SUPPORTED + PARTIAL. INSUFFICIENT_EVIDENCE when fewer than 5 dimensions are known or fewer than half of the applicable ones. Otherwise LOW when 2 or more dimensions lean AGAINST or fewer than a third of the known ones are SUPPORTED; HIGH when no dimension leans AGAINST and at least 70% of the known ones are SUPPORTED; else MEDIUM. A counting rule over the listed reasons, not a forecast.';
export const DIMENSIONS = Object.freeze(['giftability', 'personalization', 'uvPrint', 'retailPriceFit', 'marginPotential', 'storageFootprint', 'shippingPracticality', 'novelty', 'competition', 'bundlePotential', 'seasonality', 'assortmentFit', 'complianceBurden']);
const LABEL = { giftability: ['Giftability', 'Idée cadeau'], personalization: ['Personalisation potential', 'Potentiel de personnalisation'], uvPrint: ['UV-print compatibility', 'Compatibilité impression UV'], retailPriceFit: ['Retail price fit', 'Prix de vente'], marginPotential: ['Margin potential', 'Potentiel de marge'], storageFootprint: ['Storage footprint', 'Encombrement'], shippingPracticality: ['Shipping practicality', "Facilité d'expédition"], novelty: ['Novelty / differentiation', 'Nouveauté / différenciation'], competition: ['Competition / saturation', 'Concurrence / saturation'], bundlePotential: ['Bundle potential', 'Potentiel de coffret'], seasonality: ['Seasonality', 'Saisonnalité'], assortmentFit: ['Fit with current assortment', "Cohérence avec l'assortiment"], complianceBurden: ['Compliance burden', 'Charge de conformité'] };

const lower = (s) => String(s ?? '').toLowerCase();
const ev = (kind, ref, note) => ({ kind, ref, note });
const dim = (key, state, why, { lean = null, evidence = [], needs = null, detail = null } = {}) => ({ key, label: LABEL[key][0], labelFr: LABEL[key][1], state, lean: state === FIT_STATE.SUPPORTED ? 'FOR' : state === FIT_STATE.PARTIAL ? (lean ?? 'MIXED') : null, why, evidence, ...(needs ? { needs } : {}), ...(detail ? { detail } : {}) });
const latest = (state, key, context = 'product') => state.ledger.filter((e) => e.key === key && (context === null || e.context === context)).at(-1) ?? null;
const has = (list, text) => (list ?? []).find((c) => c && text.includes(lower(c))) ?? null;

/** the words the product is described by: name, model, category label, what the supplier said about material / packaging / customisation (all of them are supplier or owner statements) */
function productText(state) {
  const cat = effective(state.identity, 'category').value; const bits = [state.identity.workingName, state.identity.identifiers?.model, cat ? CATEGORIES[cat]?.label : '', ...state.notes.map((n) => n.text)];
  for (const k of ['spec.material', 'offer.packaging', 'offer.customization', 'offer.accessories']) { const e = latest(state, k); if (e) bits.push(String(e.value)); }
  return lower(bits.filter(Boolean).join(' | '));
}
const num = (v) => { if (v === null || v === undefined || v === '') return null; const n = Number(String(v).replace(',', '.')); return Number.isFinite(n) ? n : null; }; // a missing value is null, never 0
/** volume (cm3) and weight (g) of ONE unit when the case says enough: product dimensions, else carton dimensions / units per carton. Never guessed. */
export function unitPhysical(state) {
  const pd = latest(state, 'product.dimensions')?.value; const cd = latest(state, 'carton.dimensions')?.value; const cq = num(latest(state, 'carton.qty')?.value); const cw = latest(state, 'carton.grossWeight')?.value;
  const cm = (d) => { const f = { cm: 1, mm: 0.1, m: 100, in: 2.54 }[lower(d.unit)]; return f ? [d.l, d.w, d.h].map((x) => num(x) * f) : null; };
  const vol = (arr) => (arr && arr.every((x) => x !== null && x > 0) ? Math.round(arr[0] * arr[1] * arr[2]) : null);
  const g = (w) => { const f = { kg: 1000, g: 1, lb: 453.59 }[lower(w?.unit)]; return f && num(w.amount) !== null ? Math.round(num(w.amount) * f) : null; };
  const unitVolume = pd ? vol(cm(pd)) : cd && cq ? (vol(cm(cd)) === null ? null : Math.round(vol(cm(cd)) / cq)) : null;
  const unitWeight = cw && cq ? (g(cw) === null ? null : Math.round(g(cw) / cq)) : null;
  return { unitVolumeCm3: unitVolume, unitVolumeFrom: unitVolume === null ? null : pd ? 'product dimensions' : 'carton dimensions / units per carton', unitWeightG: unitWeight };
}

/** the counting rule printed in FIT_RULE */
export function fitLabel({ profile, known, applicable, supported, against }) {
  if (!profile || known < 5 || known / Math.max(1, applicable) < 0.5) return FIT_LABEL.INSUFFICIENT_EVIDENCE;
  if (against >= 2 || supported / known < 1 / 3) return FIT_LABEL.LOW;
  if (against === 0 && supported / known >= 0.7) return FIT_LABEL.HIGH;
  return FIT_LABEL.MEDIUM;
}

/**
 * @param {object} state the case  @param {object} a its assessment (assess())  @param {object|null} profile the merchant profile (data)
 * @returns {{ type:'MerchantFitAssessment', merchantId:string|null, displayName:string|null, label:string, rule:string, dimensions:object[], counts:object, missing:string[], profile:{ status:string|null, present:boolean } }}
 */
export function assessMerchantFit(state, a, profile = null) {
  const P = profile ?? {}; const text = productText(state); const catId = effective(state.identity, 'category').value; const cat = catId ? CATEGORIES[catId] : null; const phys = unitPhysical(state);
  const noProfile = (key) => dim(key, FIT_STATE.UNKNOWN, 'no merchant profile is loaded: nothing to compare with', { needs: 'merchant profile' });
  const out = [];
  const D = (key, fn) => out.push(profile ? fn() : noProfile(key));

  D('giftability', () => {
    const g = P.giftability ?? {}; const cue = has(g.cues, text);
    if (catId && (g.giftCategoryIds ?? []).includes(catId)) return dim('giftability', FIT_STATE.SUPPORTED, `the category (${cat.label}) is one the merchant treats as a gift category`, { evidence: [ev('category', catId, 'category of the case')] });
    if (cue) return dim('giftability', FIT_STATE.PARTIAL, `the description contains the gift cue "${cue}", but the category is not a listed gift category`, { lean: 'MIXED', evidence: [ev('text', cue, 'name / notes / supplier statements')] });
    if (catId) return dim('giftability', FIT_STATE.PARTIAL, `the category (${cat.label}) is not a gift category in the profile and no gift cue was found`, { lean: 'AGAINST', evidence: [ev('category', catId, 'not listed')] });
    return dim('giftability', FIT_STATE.UNKNOWN, 'the product category is not known yet', { needs: 'category' });
  });
  D('personalization', () => {
    const cz = latest(state, 'offer.customization'); const owner = effective(state.identity, 'customisable'); const pcue = has(P.personalization?.cues, text);
    if (owner.known && owner.value === true && owner.level !== 'PROBABLE') return dim('personalization', FIT_STATE.SUPPORTED, 'the owner stated the product is customisable', { evidence: [ev('identity', 'customisable', owner.level)] });
    if (cz) return dim('personalization', FIT_STATE.SUPPORTED, `the supplier says it offers: ${cz.value} (a supplier claim, not yet seen)`, { evidence: [ev('ledger', cz.id, 'SUPPLIER_CLAIM')] });
    if (pcue) return dim('personalization', FIT_STATE.PARTIAL, `the description contains "${pcue}" (blank / customisable cue) but no supplier statement confirms it`, { lean: 'MIXED', evidence: [ev('text', pcue, 'description')] });
    return dim('personalization', FIT_STATE.UNKNOWN, 'nothing says whether the product can be customised or printed on', { needs: 'ask the supplier: blank / customisation / logo' });
  });
  D('uvPrint', () => {
    const mat = latest(state, 'spec.material'); if (!mat) return dim('uvPrint', FIT_STATE.UNKNOWN, 'the material is not known', { needs: 'ask the supplier: material of the printable surface' });
    const m = lower(mat.value); const uv = P.uvPrint ?? {}; const hard = (uv.difficultMaterials ?? []).find((x) => m.includes(lower(x.material))); const ok = (uv.compatibleMaterials ?? []).find((x) => m.includes(lower(x)));
    const e = [ev('ledger', mat.id, `material "${mat.value}" (${mat.status})`)];
    if (hard) return dim('uvPrint', FIT_STATE.PARTIAL, `${mat.value}: ${hard.why}`, { lean: 'AGAINST', evidence: e, detail: uv.basis ?? null });
    if (ok) return dim('uvPrint', FIT_STATE.SUPPORTED, `${mat.value} is a material the profile lists as printable`, { evidence: e, detail: uv.basis ?? null });
    return dim('uvPrint', FIT_STATE.UNKNOWN, `the profile does not say whether "${mat.value}" can be UV-printed`, { needs: 'owner: add this material to the profile, or test a sample', evidence: e });
  });
  D('retailPriceFit', () => {
    const band = P.retailPrice?.bandGrossEur; const sp = num(state.sale?.sellingPriceGross);
    if (sp === null) return dim('retailPriceFit', FIT_STATE.UNKNOWN, 'no selling price entered for this product', { needs: 'selling price (VAT included)' });
    if (!band || num(band.min) === null || num(band.max) === null) return dim('retailPriceFit', FIT_STATE.UNKNOWN, `a selling price of ${sp} EUR is entered but the merchant's price band is not configured`, { needs: 'owner: price band in the profile', detail: `price entered: ${sp} EUR (${state.sale?.priceBasis ?? 'TARGET'})` });
    const inBand = sp >= num(band.min) && sp <= num(band.max);
    return inBand ? dim('retailPriceFit', FIT_STATE.SUPPORTED, `${sp} EUR is inside the merchant's band (${band.min}-${band.max} EUR)`, { evidence: [ev('sale', 'sellingPriceGross', state.sale?.priceBasis ?? 'TARGET')] }) : dim('retailPriceFit', FIT_STATE.PARTIAL, `${sp} EUR is outside the merchant's band (${band.min}-${band.max} EUR)`, { lean: 'AGAINST', evidence: [ev('sale', 'sellingPriceGross', state.sale?.priceBasis ?? 'TARGET')] });
  });
  D('marginPotential', () => {
    const e = a.economics; const floor = num(P.margin?.minContributionPct);
    if (!e || e.contributionPct === null || e.contributionPct === undefined) return dim('marginPotential', FIT_STATE.UNKNOWN, `the margin cannot be calculated${e?.reason ? ` (${e.reason})` : ''}`, { needs: 'selling price, landed cost inputs' });
    const pct = Math.round(e.contributionPct * 1000) / 10; const ub = e.contributionIsUpperBound ? ' (UPPER BOUND: some costs are not entered)' : ''; const evd = [ev('assessment', 'economics', `${e.classification}, price basis ${e.priceBasis ?? 'unknown'}`)];
    if (floor !== null && pct < floor) return dim('marginPotential', FIT_STATE.PARTIAL, `contribution ${pct}% is below the merchant floor of ${floor}%${ub}`, { lean: 'AGAINST', evidence: evd });
    if (e.classification === 'ATTRACTIVE') return dim('marginPotential', FIT_STATE.SUPPORTED, `contribution ${pct}% reaches the target${ub}`, { evidence: evd });
    if (e.classification === 'UNATTRACTIVE') return dim('marginPotential', FIT_STATE.PARTIAL, `contribution ${pct}% is not attractive${ub}`, { lean: 'AGAINST', evidence: evd });
    return dim('marginPotential', FIT_STATE.PARTIAL, `contribution ${pct}%: borderline or no target set${ub}`, { lean: 'MIXED', evidence: evd });
  });
  D('storageFootprint', () => {
    const lim = num(P.storage?.maxVolumePerUnitCm3); if (phys.unitVolumeCm3 === null) return dim('storageFootprint', FIT_STATE.UNKNOWN, 'the size of one unit is not known', { needs: 'ask: product size or carton size and units per carton' });
    const d = `${phys.unitVolumeCm3} cm3 per unit (from ${phys.unitVolumeFrom})`;
    if (lim === null) return dim('storageFootprint', FIT_STATE.UNKNOWN, `${d}, but the merchant's storage limit is not configured`, { needs: 'owner: maximum unit volume', detail: d });
    return phys.unitVolumeCm3 <= lim ? dim('storageFootprint', FIT_STATE.SUPPORTED, `${d} is within the limit of ${lim} cm3`) : dim('storageFootprint', FIT_STATE.PARTIAL, `${d} exceeds the limit of ${lim} cm3`, { lean: 'AGAINST' });
  });
  D('shippingPracticality', () => {
    const m = lower(latest(state, 'spec.material')?.value); const fragile = (P.shipping?.fragileMaterials ?? []).find((x) => m.includes(lower(x))); const lim = num(P.shipping?.maxWeightPerUnitG);
    if (fragile) return dim('shippingPracticality', FIT_STATE.PARTIAL, `${fragile} is fragile: breakage in transit is a cost and a returns risk`, { lean: 'MIXED', evidence: [ev('ledger', latest(state, 'spec.material').id, 'material')] });
    if (phys.unitWeightG === null && phys.unitVolumeCm3 === null) return dim('shippingPracticality', FIT_STATE.UNKNOWN, 'neither the weight nor the size of one unit is known', { needs: 'carton weight and units per carton' });
    if (lim !== null && phys.unitWeightG !== null) return phys.unitWeightG <= lim ? dim('shippingPracticality', FIT_STATE.SUPPORTED, `about ${phys.unitWeightG} g per unit, within ${lim} g`) : dim('shippingPracticality', FIT_STATE.PARTIAL, `about ${phys.unitWeightG} g per unit, above ${lim} g`, { lean: 'AGAINST' });
    return dim('shippingPracticality', FIT_STATE.UNKNOWN, `${phys.unitWeightG !== null ? `about ${phys.unitWeightG} g` : 'weight unknown'}; the merchant's weight limit is not configured`, { needs: 'owner: maximum unit weight' });
  });
  const mkt = a.market ?? { observationCount: 0 }; const searches = a.marketPresence ?? null;
  D('novelty', () => dim('novelty', FIT_STATE.UNKNOWN, 'differentiation can only be judged from market observations (similar listings, searches), and none are on record', { needs: 'market observations' }));
  D('competition', () => {
    if (!mkt.observationCount) return dim('competition', FIT_STATE.UNKNOWN, 'no marketplace observation entered: saturation cannot be judged', { needs: 'market observations' });
    return dim('competition', FIT_STATE.PARTIAL, `${mkt.observationCount} marketplace observation(s) on record: they show prices seen, not how saturated the niche is`, { lean: 'MIXED', evidence: [ev('market', 'observations', `${mkt.observationCount} observation(s)`)], detail: searches?.status ? `market search: ${searches.status}` : null });
  });
  D('bundlePotential', () => {
    const b = P.bundle ?? {}; const cue = has(b.cues, text);
    if (cue) return dim('bundlePotential', FIT_STATE.SUPPORTED, `the description suggests a set/bundle ("${cue}")`, { evidence: [ev('text', cue, 'description')] });
    if (catId && (b.complementaryCategoryIds ?? []).includes(catId)) return dim('bundlePotential', FIT_STATE.PARTIAL, `the category (${cat.label}) combines with categories the merchant sells, but nothing says this product is a set`, { lean: 'MIXED', evidence: [ev('category', catId, 'complementary category in the profile')] });
    return dim('bundlePotential', FIT_STATE.UNKNOWN, 'nothing says whether it can be sold as a set or combined with other products', { needs: 'owner judgement' });
  });
  D('seasonality', () => {
    const hit = (P.seasonality?.seasons ?? []).find((s) => has(s.cues, text)); if (hit) return dim('seasonality', FIT_STATE.PARTIAL, `the description points to ${hit.label}: timing of the order and of the stock matters`, { lean: 'MIXED', evidence: [ev('text', hit.id, hit.label)] });
    const described = [state.identity.workingName, state.identity.identifiers?.model, ...state.notes.map((n) => n.text), ...['spec.material', 'offer.packaging', 'offer.customization', 'offer.accessories'].map((k) => latest(state, k)?.value)].filter(Boolean).join(' '); // the words of the owner and of the supplier, not the generated category label
    if (described.split(/\s+/).filter(Boolean).length < 3) return dim('seasonality', FIT_STATE.UNKNOWN, 'too little description to say', { needs: 'product description' });
    return dim('seasonality', FIT_STATE.NOT_APPLICABLE, 'no seasonal cue found in the name, notes or supplier statements (this is not a guarantee that the product sells all year)');
  });
  D('assortmentFit', () => {
    const list = P.assortment?.existingCategoryIds ?? []; if (!catId) return dim('assortmentFit', FIT_STATE.UNKNOWN, 'the product category is not known yet', { needs: 'category' });
    if (!list.length) return dim('assortmentFit', FIT_STATE.UNKNOWN, 'the merchant assortment is not configured', { needs: 'owner: current categories in the profile' });
    return list.includes(catId) ? dim('assortmentFit', FIT_STATE.SUPPORTED, `${cat.label} is a category the merchant already sells`, { evidence: [ev('category', catId, 'listed in the profile')] }) : dim('assortmentFit', FIT_STATE.PARTIAL, `${cat.label} is a new category for the merchant`, { lean: 'MIXED', evidence: [ev('category', catId, 'not in the profile')] });
  });
  D('complianceBurden', () => {
    const d = a.decision; const hard = d.hardBlockers.map((b) => b.code); const ev1 = [ev('assessment', 'decision', d.verdict)];
    if (hard.length) return dim('complianceBurden', FIT_STATE.PARTIAL, `blocked by: ${hard.join(', ')}`, { lean: 'AGAINST', evidence: ev1 });
    if (d.verdict === 'INSUFFICIENT_INFORMATION') return dim('complianceBurden', FIT_STATE.UNKNOWN, 'the compliance assessment cannot conclude yet (missing information)', { needs: 'answers to the compliance questions', evidence: ev1 });
    if (d.verdict === 'CONDITIONAL_GO') return dim('complianceBurden', FIT_STATE.PARTIAL, `${d.conditions.length} condition(s) to clear before any deposit`, { lean: 'MIXED', evidence: ev1 });
    return dim('complianceBurden', FIT_STATE.SUPPORTED, 'no blocker and no open condition in the assessment (decision support, not a legal conclusion)', { evidence: ev1 });
  });

  const count = (st) => out.filter((d) => d.state === st).length; const known = count('SUPPORTED') + count('PARTIAL'); const applicable = out.length - count('NOT_APPLICABLE'); const against = out.filter((d) => d.lean === 'AGAINST').length; const sup = count('SUPPORTED');
  const label = fitLabel({ profile: Boolean(profile), known, applicable, supported: sup, against });
  return { type: 'MerchantFitAssessment', merchantId: P.merchantId ?? null, displayName: P.displayName ?? null, label, rule: FIT_RULE, dimensions: out,
    counts: { supported: sup, partial: count('PARTIAL'), unknown: count('UNKNOWN'), notApplicable: count('NOT_APPLICABLE'), against, known, applicable },
    missing: [...new Set(out.filter((d) => d.needs).map((d) => d.needs))], profile: { present: Boolean(profile), status: P.status ?? null }, physical: phys, noScore: true, note: 'A checklist with reasons, not a probability. UNKNOWN stays UNKNOWN.' };
}
