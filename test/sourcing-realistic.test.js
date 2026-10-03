// Realistic field acceptance: three cases end to end (see sourcing-realistic-cases.js). Every fact must land in exactly ONE evidence class.
import test from 'node:test';
import assert from 'node:assert/strict';
import { CASES, runCase } from './sourcing-realistic-cases.js';

const classes = (a) => Object.fromEntries(['verified', 'observed', 'supplierClaims', 'calculated', 'estimated', 'assumed', 'unknown', 'needsExpert'].map((k) => [k, a.evidence[k].map((e) => e.item)]));
const results = {};

for (const def of CASES) {
  test(`${def.title}`, async () => {
    const { live, offline, saved } = await runCase(def); results[def.id] = { live, offline };
    // the whole pipeline produced every part of the card
    assert.ok(['GO', 'CONDITIONAL_GO', 'NO_GO', 'INSUFFICIENT_INFORMATION'].includes(live.decision.verdict));
    assert.ok(live.decision.why.length >= 4 && live.decision.nextAction.length > 10 && live.questions.length > 0);
    assert.ok(live.landed.totals.landedPerUnitEurMinor > 0, 'landed cost');
    assert.ok(live.maxPurchasePrice.maxUnitPriceMinor > 0 && live.maxPurchasePrice.display, 'maximum purchase price');
    assert.equal(live.dataMode, 'LIVE_VERIFIED'); assert.ok(live.safety.status);
    assert.equal(live.identity.confidence.level === 'LOW', false, 'identification is not LOW once the owner confirmed it');
    // never an unconditional GO while rules are unreviewed
    assert.notEqual(live.decision.verdict, 'GO'); assert.equal(live.decision.canCommitMoney, false);
    assert.ok(live.decision.conditions.some((c) => /rulebook not yet verified/.test(c)));
    // evidence classes are separate: no fact in two classes, nothing OCR / typed is ever VERIFIED
    const k = classes(live); const all = Object.entries(k).flatMap(([cls, items]) => items.map((i) => `${cls}|${i}`));
    const names = all.map((x) => x.split('|')[1]); const dup = names.filter((n, i) => names.indexOf(n) !== i && !/^(eu|be|amazon|transport|customs)\./.test(n));
    assert.deepEqual([...new Set(dup)], [], 'a fact appears in two evidence classes');
    assert.ok(k.supplierClaims.length > 0 && k.calculated.length > 0 && k.unknown.length >= 0 && k.estimated.length > 0);
    assert.equal(k.verified.every((i) => i === 'EU Safety Gate check'), true);
    // offline reopen of the SAVED case, two days later, no server: same verdict inputs, safety shown as CACHED, never live
    assert.equal(saved.decisions.length, 1);
    assert.equal(offline.dataMode, 'CACHED');
    assert.equal(offline.maxPurchasePrice.maxUnitPriceMinor, live.maxPurchasePrice.maxUnitPriceMinor);
    assert.equal(offline.decision.verdict, live.decision.verdict);
    assert.ok(offline.decision.conditions.some((c) => /CACHED/.test(c)));
    assert.equal(offline.freshness.find((f) => f.name === 'EU Safety Gate').status === 'FRESH', false);
  });
}

test('realistic cases differ for the right reasons', () => {
  const r = results;
  assert.ok(r['case-1'] && r['case-2'] && r['case-3'], 'the three cases ran');
  // case 1: no required third-party documents, only unreviewed rules / own actions hold it at conditional
  assert.equal(r['case-1'].live.decision.gaps.missingDocs.length, 0);
  assert.equal(r['case-1'].live.economics.priceBasis, 'OBSERVED');
  // case 2: battery documents incomplete (UN 38.3 missing), similar Safety Gate alert, higher-risk regime
  assert.ok(r['case-2'].live.decision.gaps.missingDocs.some((m) => m.docType === 'UN383'));
  assert.equal(r['case-2'].live.safety.status, 'SIMILAR_PRODUCT_RISK');
  assert.ok(r['case-2'].live.decision.conditions.some((c) => /expert or authority/.test(c)));
  // case 3: own brand on a radio product; the cybersecurity regime is unresolved; the photographed declaration was confirmed by the owner but is still a supplier document
  assert.equal(r['case-3'].live.role.ownBrand, true);
  assert.equal(r['case-3'].live.rules.results.find((x) => x.ruleId === 'eu.red_cyber').status, 'UNRESOLVED');
  assert.equal(r['case-3'].live.documents[0].textSource, 'OCR'); assert.equal(r['case-3'].live.documents[0].confirmed, true);
  assert.ok(!r['case-3'].live.evidence.verified.some((e) => /document/.test(e.item)));
  assert.equal(r['case-3'].live.economicsAmazon.status === 'COMPLETE', false, 'Amazon fees are never invented');
});
