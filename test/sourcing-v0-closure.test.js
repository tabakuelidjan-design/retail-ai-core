// NON-VOICE V0 CLOSURE (C1 economic uncertainty, C2 copied field summary, C3 regulatory coverage / neutral states / stale Safety Gate). Synthetic data only, deterministic.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { landedCost } from '../src/sourcing/core/landed.js';
import { unitEconomics, maxPurchasePrice } from '../src/sourcing/core/economics.js';
import { newCase, dispatch, assess } from '../src/sourcing/core/case.js';
import { regulatoryCoverage } from '../src/sourcing/core/coverage.js';
import { fieldSummaryText } from '../src/sourcing/core/field-summary.js';
import { ZERO_COSTS } from './sourcing-zero-costs.js';
import { NOW, build, run, ident, traits, extraTraits, importer, commercial, docsFor, LIVE_CLEAN } from './sourcing-fixtures.js';

const base = (costs) => ({ supplier: { unitPrice: '4.20', currency: 'USD', qty: 1000, moq: 500, incoterm: 'FOB' }, fx: { rate: 0.92, date: '2026-10-03', source: 'USER_ENTERED' }, costs: { freight: { total: 450, status: 'KNOWN' }, customsDuty: { ratePct: 3.7, status: 'KNOWN' }, ...costs } });

// ---- C1 ---------------------------------------------------------------------------------------------------------------------------------------------------------------------
test('C1: an import cost that is not entered is UNKNOWN, never zero: the landed cost is a LOWER BOUND, never COMPLETE, and the unknown components stay listed', () => {
  const r = landedCost(base({}));
  assert.equal(r.status, 'LOWER_BOUND'); assert.equal(r.isLowerBound, true);
  assert.deepEqual(r.unknownCostComponents.sort(), ['costs.brokerage', 'costs.epr', 'costs.inboundLogistics', 'costs.inspection', 'costs.insurance', 'costs.labelling', 'costs.testing']);
  assert.equal(r.totals.landedTotalEurMinor, 386400 + 45000 + 15962, 'the total is what is known (goods + freight + duty on the customs value): the unknown lines add nothing and are NOT presented as zero');
  assert.ok(r.warnings.some((w) => /^LOWER_BOUND: the real landed cost is HIGHER/.test(w)));
  assert.ok(r.lines.filter((l) => l.status === 'UNKNOWN').every((l) => l.totalMinor === null), 'an unknown line carries null, not 0');
});

test('C1: entering every relevant cost (0 only when the cost really is zero) makes it COMPLETE; one still missing keeps it a lower bound and names exactly that one', () => {
  assert.equal(landedCost(base({ ...ZERO_COSTS })).status, 'COMPLETE'); assert.equal(landedCost(base({ ...ZERO_COSTS })).isLowerBound, false);
  const { testing, ...rest } = ZERO_COSTS; const r = landedCost(base({ ...rest })); assert.equal(r.status, 'LOWER_BOUND'); assert.deepEqual(r.unknownCostComponents, ['costs.testing']);
  const dep = landedCost(base({ ...ZERO_COSTS, testing: { total: 300, status: 'KNOWN' } })); assert.ok(dep.totals.landedTotalEurMinor > landedCost(base({ ...ZERO_COSTS })).totals.landedTotalEurMinor);
  const exw = base({ ...ZERO_COSTS }); exw.supplier.incoterm = 'EXW'; delete exw.costs.originCharges; assert.deepEqual(landedCost(exw).unknownCostComponents, ['costs.originCharges'], 'under EXW the origin charges are the buyer\'s and must be entered');
  const crit = base({}); delete crit.costs.freight; assert.equal(landedCost(crit).status, 'INFORMATION_INSUFFICIENT', 'a critical unknown still wins');
});

test('C1: a lower-bound landed cost makes the margin an UPPER bound and the maximum purchase price an UPPER bound (labelled, with the reason)', () => {
  const sale = { sellingPriceGross: '24.99', vatRatePct: 21, targetContributionPct: 20 };
  const r = landedCost(base({})); const e = unitEconomics({ ...sale, landedPerUnitMinor: r.totals.landedPerUnitEurMinor, landedIsLowerBound: true });
  assert.equal(e.contributionIsUpperBound, true); assert.equal(e.landedIsLowerBound, true); assert.ok(e.warnings.some((w) => /^LANDED_COST_IS_LOWER_BOUND/.test(w)));
  const full = unitEconomics({ ...sale, landedPerUnitMinor: r.totals.landedPerUnitEurMinor }); assert.equal(full.contributionIsUpperBound, false);
  const m = maxPurchasePrice({ landedInput: base({}), sale: { sellingPriceGross: '24.99', vatRatePct: 21, lines: [] }, targetContributionPct: 20 });
  assert.equal(m.status, 'UPPER_BOUND'); assert.equal(m.upperBound, true); assert.match(m.reason, /^COSTS_NOT_ENTERED: .*costs\.testing/); assert.ok(m.unknownCostComponents.length >= 5);
  const c = maxPurchasePrice({ landedInput: base({ ...ZERO_COSTS }), sale: { sellingPriceGross: '24.99', vatRatePct: 21, lines: [] }, targetContributionPct: 20 }); assert.equal(c.status, 'COMPLETE'); assert.equal(c.upperBound, false);
  assert.ok(c.maxUnitPriceMinor <= m.maxUnitPriceMinor, 'the complete maximum is never above the upper bound');
});

const goEvents = (withZeros) => [...ident({ name: 'USB-C charger 65W', category: 'usb_charger', model: 'PD-65' }), ...traits({ 'electrical.present': true }), ...extraTraits({ 'electrical.mainsConnected': true, 'electrical.maxVoltageAc': 230 }), ...importer, ...commercial({ price: 24.99 }).map((ev) => (ev.type === 'COSTS' && !withZeros ? { ...ev, costs: { ...ev.costs, costs: { freight: ev.costs.costs.freight } } } : ev)), ...docsFor.charger('PD-65')];
test('C1: the purchase verdict is capped at CONDITIONAL_GO while relevant costs are unknown; with them entered the same case can be GO (the cap is the ONLY difference)', () => {
  const full = run(build(goEvents(true))); assert.equal(full.landed.status, 'COMPLETE'); assert.equal(full.decision.verdict, 'GO'); assert.equal(full.decision.dimensions.economicsIsUpperBound, false);
  const inc = run(build(goEvents(false))); assert.equal(inc.landed.status, 'LOWER_BOUND'); assert.equal(inc.decision.verdict, 'CONDITIONAL_GO'); assert.equal(inc.decision.canCommitMoney, false); assert.equal(inc.decision.dimensions.economicsIsUpperBound, true);
  assert.ok(inc.decision.conditions.some((c) => /import costs not entered \(.*testing.*\): the landed cost is a LOWER BOUND/.test(c)), inc.decision.conditions.join(' | '));
  assert.equal(inc.maxPurchasePrice.upperBound, true); assert.equal(inc.economics.contributionIsUpperBound, true);
});

// ---- C3 ---------------------------------------------------------------------------------------------------------------------------------------------------------------------
test('C3: the coverage guard says "Hors couverture — ne pas conclure" for uncovered families (HARD), no category / general category on assumed traits (CONDITION); covered stays quiet and never implies compliance', () => {
  for (const n of ['Neodymium magnet set', 'Magnetic phone case', 'Briquet tempête', 'Electric scooter 350W', 'Laser pointer', 'Cordless drill', 'Wooden stool', 'Running shoes', 'Baby stroller', 'Fireworks box', 'Vape pod']) { const c = regulatoryCoverage({ category: 'phone_case', name: n }); assert.equal(c.status, 'OUT_OF_COVERAGE', n); assert.equal(c.severity, 'HARD', n); assert.equal(c.banner, 'Hors couverture — ne pas conclure'); }
  const none = regulatoryCoverage({ category: null, name: 'Thing' }); assert.equal(none.status, 'OUT_OF_COVERAGE'); assert.equal(none.severity, 'CONDITION');
  assert.equal(regulatoryCoverage({ category: 'household_general', name: 'Basket', assumedTraits: 3 }).status, 'OUT_OF_COVERAGE'); assert.equal(regulatoryCoverage({ category: 'household_general', name: 'Basket', assumedTraits: 0 }).status, 'COVERED', 'traits stated by the owner: generic obligations are what applies');
  assert.equal(regulatoryCoverage({ category: 'led_lamp_mains', name: 'Desk lamp' }).status, 'PARTIAL'); const ok = regulatoryCoverage({ category: 'power_bank', name: 'Power bank 20000' }); assert.equal(ok.status, 'COVERED'); assert.equal(ok.impliesCompliance, false); assert.equal(ok.banner, null);
});

test('C3: an uncovered product is never concluded: a HARD coverage gap gives INSUFFICIENT_INFORMATION with a named blocker, even with otherwise perfect inputs; a general category on assumed traits is conditional', () => {
  const magnet = goEvents(true).map((e) => (e.type === 'NAME' ? { ...e, name: 'Magnetic USB-C charger' } : e)); const evs = [...goEvents(true), { type: 'NAME', name: 'Magnetic USB-C charger' }];
  const a = run(build(evs)); assert.equal(a.coverage.status, 'OUT_OF_COVERAGE'); assert.equal(a.decision.verdict, 'INSUFFICIENT_INFORMATION'); assert.ok(a.decision.hardBlockers.some((b) => /OUT OF RULEBOOK COVERAGE - do not conclude: the rulebook has NO rule for: magnets/.test(b.detail)), JSON.stringify(a.decision.hardBlockers.map((b) => b.detail)));
  void magnet; assert.equal(a.decision.dimensions.regulatoryCoverage, 'OUT_OF_COVERAGE');
  const good = run(build(goEvents(true))); assert.equal(good.coverage.status, 'PARTIAL'); assert.equal(good.decision.verdict, 'GO', 'a covered product is not penalised');
  const generic = run(build([...ident({ name: 'Storage basket', category: 'household_general', model: 'SB-12' }), ...importer, ...commercial({ price: 14.99, duty: 6.5, code: '4602.19' })])); assert.equal(generic.coverage.status, 'OUT_OF_COVERAGE'); assert.equal(generic.coverage.severity, 'CONDITION');
  assert.ok(generic.decision.conditions.some((c) => /OUT OF RULEBOOK COVERAGE - do not conclude/.test(c))); assert.notEqual(generic.decision.verdict, 'GO');
});

test('C3: stale Safety Gate: a CACHED result older than staleSafetyGateDays (or of unknown age) cannot look current; a fresh live one is untouched; NO_MATCH_FOUND stays "no match found", not a failure', () => {
  const old = { alerts: [], source: { mode: 'CACHED', fetchedAt: '2026-09-01T00:00:00Z', coverage: 'synthetic' } }; const a = run(build(goEvents(true)), { safety: old });
  assert.equal(a.safety.stale, true); assert.equal(a.safety.ageDays, 32); assert.equal(a.safety.status, 'NO_MATCH_FOUND'); assert.ok(a.decision.conditions.some((c) => /32 days old \(limit 14\): it is NOT current/.test(c))); assert.equal(a.decision.verdict, 'CONDITIONAL_GO');
  const unk = run(build(goEvents(true)), { safety: { alerts: [], source: { mode: 'CACHED', coverage: 'synthetic' } } }); assert.equal(unk.safety.stale, true); assert.ok(unk.decision.conditions.some((c) => /of unknown age/.test(c)));
  const recent = run(build(goEvents(true)), { safety: { alerts: [], source: { mode: 'CACHED', fetchedAt: '2026-10-01T00:00:00Z', coverage: 'synthetic' } } }); assert.equal(recent.safety.stale, false);
  const live = run(build(goEvents(true))); assert.equal(live.safety.stale, false); assert.equal(live.decision.verdict, 'GO');
});

test('C3: NO_MATCH_FOUND and NOT_APPLICABLE are drawn NEUTRAL (never the green success colour), in every screen that paints them', () => {
  for (const f of ['rules.js', 'decision.js']) { const src = readFileSync(new URL(`../src/sourcing/ui/screens/${f}`, import.meta.url), 'utf8'); assert.ok(!/NO_MATCH_FOUND' \? 'GREEN'/.test(src), `${f}: NO_MATCH_FOUND must not be green`); }
  const rules = readFileSync(new URL('../src/sourcing/ui/screens/rules.js', import.meta.url), 'utf8'); assert.match(rules, /r\.status === 'UNRESOLVED' \|\| r\.status === 'NOT_APPLICABLE' \? 'UNKNOWN'/); assert.match(rules, /coverageBanner\(A\)/);
  const dom = readFileSync(new URL('../src/sourcing/ui/dom.js', import.meta.url), 'utf8'); assert.match(dom, /Hors couverture|c\.banner/); assert.match(dom, /Safety Gate : résultat périmé/);
});

// ---- C2 ---------------------------------------------------------------------------------------------------------------------------------------------------------------------
const at = (n) => new Date(Date.UTC(2026, 9, 7, 9, n, 0));
function conversation({ withCosts }) {
  let s = newCase({ id: 'fs1', name: 'Power bank 20000', now: at(0) }); s = dispatch(s, { type: 'CATEGORY', category: 'power_bank' }, at(0)); s = dispatch(s, { type: 'SUPPLIER', supplier: { name: 'Shenzhen Brightway Electronics' } }, at(0));
  s = dispatch(s, { type: 'CONVERSATION_START', supplierRef: 'Hall 2 C-114', lang: 'auto' }, at(1)); const id = s.conversations.at(-1).id;
  s = dispatch(s, { type: 'CONVERSATION_ITEM', convId: id, speaker: 'supplier', lang: 'auto', text: 'Model PB-X200. MOQ 500 pieces, 4.20 USD FOB Shenzhen, lead time 20 days, 30% deposit.' }, at(2));
  for (const c of s.candidates.filter((x) => x.state === 'PROPOSED' && ['quote.moq', 'quote.unitPrice', 'quote.currency', 'quote.incoterm', 'identifier.model'].includes(x.key))) s = dispatch(s, { type: 'CANDIDATE_CONFIRM', id: c.id }, at(3));
  s = dispatch(s, { type: 'CONVERSATION_ITEM', convId: id, speaker: 'supplier', lang: 'auto', text: 'We have CE and UN38.3 certificates.' }, at(4));
  if (withCosts) s = dispatch(s, { type: 'COSTS', costs: { fx: { rate: 0.92, date: '2026-10-02', source: 'USER_ENTERED' }, costs: { freight: { total: 600, status: 'ESTIMATED' } } } }, at(5)); if (withCosts) s = dispatch(s, { type: 'CUSTOMS', customs: { duty: { ratePct: 3.7, kind: 'USER_ENTERED', source: 'owner' } } }, at(5));
  return s;
}
test('C2: the copied summary restates what is known with its provenance, says "non obtenu" for what is missing, lists claims awaiting confirmation, never fabricates and never says "compliant"', () => {
  const s = conversation({ withCosts: true }); const A = assess(s, { now: at(6), externals: { safety: LIVE_CLEAN } }); const t = fieldSummaryText(s, A, { now: at(6) });
  for (const must of ['RÉSUMÉ FOURNISSEUR - 2026-10-07', 'Produit : Power bank 20000', 'Fournisseur : Shenzhen Brightway Electronics', 'CONDITIONS COMMERCIALES', 'À CONFIRMER', 'CONTRADICTIONS', 'INFORMATIONS IMPORTANTES MANQUANTES', 'RÉGLEMENTATION / SAFETY GATE', "ÉVALUATION D'ACHAT", 'Résumé généré par Nordla']) assert.ok(t.includes(must), `missing section/line: ${must}\n${t}`);
  assert.match(t, /MOQ : .*500.*\[(annoncé par le fournisseur, confirmé par vous|confirmé par vous)\]/); assert.match(t, /Incoterm : .*FOB/); assert.match(t, /Modèle \/ référence : PB-X200/);
  assert.match(t, /- Port : (non obtenu|non confirmé)/); assert.match(t, /Port ou lieu : Shenzhen \[annoncé par le fournisseur\]/); assert.match(t, /Paiement : solde : (non obtenu|non confirmé)/);
  assert.match(t, /Certifications annoncées : CE, UN 38\.3 \[annoncées, AUCUN document reçu\]/); assert.match(t, /Safety Gate : aucune correspondance trouvée \(cela ne prouve PAS que le produit est sûr\)/);
  assert.match(t, /codes douaniers \(HS\/CN\) restent des candidats/); assert.ok(!/undefined|NaN|\[object Object\]|\bnull\b/.test(t), t); assert.ok(!/\bconforme\b|\bcompliant\b/i.test(t.replace(/preuve de conformité|ne prouve|pas une preuve/g, '')), 'no conformity claim');
});
test('C2: the summary carries the economic uncertainty (lower bound, upper-bound maximum, named unknown costs) and the out-of-coverage warning when they apply', () => {
  const s = conversation({ withCosts: true }); let A = assess(s, { now: at(6), externals: { safety: LIVE_CLEAN } });
  assert.equal(A.landed.status, 'LOWER_BOUND'); let t = fieldSummaryText(s, A, { now: at(6) }); assert.match(t, /INCERTITUDE ÉCONOMIQUE : coûts non saisis \(.*testing.*\)/); assert.match(t, /Coût de revient par unité : AU MOINS .* EUR \(BORNE BASSE\)/); assert.match(t, /ne pas payer d'acompte sur cette base/);
  let s2 = dispatch(s, { type: 'NAME', name: 'Magnetic power bank 20000' }, at(7)); A = assess(s2, { now: at(8), externals: { safety: LIVE_CLEAN } }); t = fieldSummaryText(s2, A, { now: at(8) }); assert.match(t, /HORS COUVERTURE — NE PAS CONCLURE : .*aimants/); assert.match(t, /Verdict : Pas assez d'informations pour conclure/);
  const old = assess(s, { now: at(6), externals: { safety: { alerts: [], source: { mode: 'CACHED', fetchedAt: '2026-08-01T00:00:00Z', coverage: 'x' } } } }); assert.match(fieldSummaryText(s, old, { now: at(6) }), /RÉSULTAT PÉRIMÉ \(\d+ jours\)/);
});
test('C2: an empty case gives a short honest summary (every fact "non obtenu"), and the button is wired in the evaluation sheet and the controller', () => {
  const s = newCase({ id: 'e', name: '', now: at(0) }); const A = assess(s, { now: at(1), externals: { safety: LIVE_CLEAN } }); const t = fieldSummaryText(s, A, { now: at(1) });
  assert.match(t, /Produit : non obtenu/); assert.match(t, /MOQ : non obtenu/); assert.ok(!/undefined|NaN|\bnull\b/.test(t), t);
  const ff = readFileSync(new URL('../src/sourcing/ui/screens/fieldfirst.js', import.meta.url), 'utf8'); assert.match(ff, /Copier le résumé', 'copy-summary'/); const app = readFileSync(new URL('../src/sourcing/ui/app.js', import.meta.url), 'utf8'); assert.match(app, /act === 'copy-summary'.*fieldSummaryText/);
});
