// Deterministic decision engine. The LLM never decides; it may only EXPLAIN the output of this module. No opaque score: a verdict, its dimensions, its hard
// blockers, and the WHY as a list of facts. INFORMATION INSUFFICIENT is a valid and frequent result.
import { BLOCKER, VERDICT, TRAFFIC } from './levels.js';
import { fmt } from './money.js';

export const DEFAULT_POLICY = Object.freeze({
  unattractiveBelowTargetFraction: 0.5, // contribution below half of the target margin = UNATTRACTIVE at this price (a Nordla default, editable per case)
  staleSafetyGateDays: 14,
});

const isMissing = (m) => ['MISSING', 'DOES_NOT_COVER_THIS_REGULATION', 'PRESENT_WITH_CONCERNS'].includes(m.coverage.status);

/** Documents that matter: those required by a regime that APPLIES. Own actions (registrations) are listed separately: they never become a supplier question. */
export function evidenceGaps(rules) {
  const applying = (rules.results ?? []).filter((r) => r.status === 'APPLIES' && r.jurisdiction !== 'AMAZON');
  const missingDocs = []; const conditionalDocs = []; const ownActions = []; const concerns = [];
  for (const r of applying) for (const e of r.requiredEvidence ?? []) {
    const item = { ruleId: r.ruleId, id: e.id, label: e.label, docType: e.docType, requirement: e.requirement, coverage: e.coverage.status };
    if (e.docType === 'COMPANY_RECORD') { if (e.requirement === 'REQUIRED') ownActions.push(item); continue; }
    if (e.coverage.status === 'PRESENT_WITH_CONCERNS') concerns.push({ ...item, consistency: e.coverage.consistency });
    if (e.requirement === 'REQUIRED' && isMissing(e)) missingDocs.push(item);
    else if (e.requirement === 'CONDITIONAL' && isMissing(e)) conditionalDocs.push(item);
  }
  const dedupe = (xs) => xs.filter((x, i) => xs.findIndex((y) => y.id === x.id) === i);
  return { missingDocs: dedupe(missingDocs), conditionalDocs: dedupe(conditionalDocs), ownActions: dedupe(ownActions), concerns: dedupe(concerns) };
}

/** A required requirement is CONTRADICTED when every covering document shows INCONSISTENT / SUSPICIOUS (no clean document covers it). */
export function contradictions(rules, docs) {
  const out = [];
  for (const r of rules.results ?? []) { if (r.status !== 'APPLIES') continue; for (const e of r.requiredEvidence ?? []) {
    if (e.requirement !== 'REQUIRED' || e.coverage.status === 'MISSING' || e.coverage.status === 'OWN_ACTION') continue;
    const ids = e.coverage.docIds ?? []; const cs = docs.filter((d) => ids.includes(d.id)).map((d) => d.inspection?.consistency);
    if (cs.length && cs.every((c) => c === 'INCONSISTENT' || c === 'SUSPICIOUS')) out.push({ ruleId: r.ruleId, requirement: e.id, label: e.label, documents: ids, consistency: [...new Set(cs)] });
    if (e.coverage.status === 'DOES_NOT_COVER_THIS_REGULATION') out.push({ ruleId: r.ruleId, requirement: e.id, label: e.label, documents: ids, consistency: ['DOES_NOT_COVER_THIS_REGULATION'] });
  } }
  return out.filter((x, i) => out.findIndex((y) => y.requirement === x.requirement) === i);
}

function marketabilityOf({ identityConf, rules, gaps, contra, safety }) {
  if (['EXACT_MATCH', 'PROBABLE_MATCH'].includes(safety.status) || contra.length) return TRAFFIC.RED;
  if ((rules.results ?? []).some((r) => r.ruleId === 'eu.medical_boundary' && r.status === 'APPLIES')) return TRAFFIC.RED;
  if (identityConf.level === 'LOW' || rules.ce?.status === 'CE_APPLICABILITY_UNRESOLVED') return TRAFFIC.UNKNOWN;
  const unresolved = (rules.results ?? []).filter((r) => r.status === 'UNRESOLVED' && r.jurisdiction !== 'AMAZON');
  if (unresolved.length || gaps.missingDocs.length || gaps.concerns.length) return TRAFFIC.AMBER;
  return TRAFFIC.GREEN;
}
function safetyRiskOf({ safety, rules }) {
  if (['EXACT_MATCH', 'PROBABLE_MATCH'].includes(safety.status)) return 'HIGH';
  if (safety.status === 'NOT_CHECKED') return 'UNKNOWN';
  if (safety.status === 'SIMILAR_PRODUCT_RISK') return 'MEDIUM';
  const highRegime = (rules.results ?? []).some((r) => r.status === 'APPLIES' && r.severity === 'HIGH');
  return highRegime ? 'MEDIUM' : 'LOW';
}
function economicsLabel(econ, policy) {
  if (!econ) return 'UNKNOWN';
  if (econ.status === 'INFORMATION_INSUFFICIENT') return 'UNKNOWN';
  if (econ.contributionMinor !== null && econ.contributionMinor < 0) return 'UNATTRACTIVE';
  if (econ.status === 'UPPER_BOUND') return 'UNKNOWN'; // fees missing: only an upper bound exists
  const t = econ.targetContributionPct; if (t === null || t === undefined) return 'BORDERLINE';
  if (econ.classification === 'ATTRACTIVE') return 'ATTRACTIVE';
  return econ.contributionPct !== null && econ.contributionPct < (t / 100) * policy.unattractiveBelowTargetFraction ? 'UNATTRACTIVE' : 'BORDERLINE';
}
function evidenceLabel({ rules, gaps, contra, docs, identityConf }) {
  if (contra.length) return 'CONTRADICTORY';
  // what is required cannot be known while the product is unidentified or its regimes are unresolved: nothing can be called complete
  if (identityConf.level === 'LOW' || (rules.results ?? []).some((r) => r.status === 'UNRESOLVED' && r.jurisdiction !== 'AMAZON' && r.ruleId === 'eu.ce')) return docs.length ? 'PARTIAL' : 'INSUFFICIENT';
  const required = (rules.results ?? []).filter((r) => r.status === 'APPLIES' && r.jurisdiction !== 'AMAZON').flatMap((r) => (r.requiredEvidence ?? []).filter((e) => e.requirement === 'REQUIRED' && e.docType !== 'COMPANY_RECORD'));
  if (!gaps.missingDocs.length && !gaps.concerns.length) return 'COMPLETE';
  const present = required.filter((e) => e.coverage.status === 'PRESENT').length;
  return present === 0 && docs.length === 0 ? 'INSUFFICIENT' : 'PARTIAL';
}

/**
 * @returns the decision card (all dimensions, hard blockers, verdict, why, what is missing, what blocks import / Amazon, max purchase price, next action).
 */
export function decide({ identityConf, rules, docs, safety, customs, landed, econ, maxPrice, amazon, role, quote, channels, questions, policy = DEFAULT_POLICY }) {
  const gaps = evidenceGaps(rules); const contra = contradictions(rules, docs);
  const marketability = marketabilityOf({ identityConf, rules, gaps, contra, safety });
  const safetyRisk = safetyRiskOf({ safety, rules }); const economics = economicsLabel(econ, policy); const evidence = evidenceLabel({ rules, gaps, contra, docs, identityConf });
  const amazonRequested = channels.includes('amazon');
  const unresolvedLegal = (rules.results ?? []).filter((r) => r.status === 'UNRESOLVED' && r.jurisdiction !== 'AMAZON' && ['eu.ce', 'eu.lvd', 'eu.emc', 'eu.red', 'eu.toys', 'eu.fcm', 'eu.cosmetics', 'eu.ppe', 'eu.batteries', 'eu.nlf_operator'].includes(r.ruleId));
  const blockers = [];
  const B = (code, severity, detail) => blockers.push({ code, severity, detail });
  if (identityConf.level === 'LOW') B(BLOCKER.PRODUCT_IDENTITY_UNRESOLVED, 'HARD', `identification is LOW: ${identityConf.unresolvedTraits.length} key trait(s) unresolved${identityConf.categoryKnown ? '' : ', no category'}`);
  if (unresolvedLegal.length) B(BLOCKER.LEGAL_REQUIREMENT_UNRESOLVED, 'HARD', `cannot decide yet whether these regimes apply: ${unresolvedLegal.map((r) => r.family).join(', ')}`);
  if (gaps.missingDocs.length) B(BLOCKER.REQUIRED_DOCUMENT_MISSING, 'HARD', `${gaps.missingDocs.length} required document(s) missing or not usable, e.g. ${gaps.missingDocs.slice(0, 2).map((m) => m.label.replace(/\s*\(.*$/, '').slice(0, 70)).join('; ')}`);
  if (['EXACT_MATCH', 'PROBABLE_MATCH'].includes(safety.status)) B(BLOCKER.SAFETY_ALERT_EXACT_MATCH, 'HARD', `Safety Gate ${safety.status === 'EXACT_MATCH' ? 'exact' : 'probable'} match: ${safety.matches[0]?.alertNumber ?? 'alert'} (${(safety.matches[0]?.hazards ?? []).join(', ') || 'hazard not classified'})`);
  if (contra.length) B(BLOCKER.DOCUMENT_CONTRADICTS_CASE, 'HARD', `the documents supplied contradict the case or do not cover the regulation: ${contra.map((c) => c.label).slice(0, 3).join('; ')}`);
  if (amazonRequested && amazon.restricted === true) B(BLOCKER.AMAZON_CATEGORY_RESTRICTION, channels.length === 1 ? 'HARD' : 'CHANNEL', 'the category is restricted on Amazon for you');
  if (econ && econ.contributionMinor !== null && econ.contributionMinor < 0) B(BLOCKER.NEGATIVE_UNIT_ECONOMICS, 'HARD', `contribution per unit is ${fmt(econ.contributionMinor)}${econ.contributionIsUpperBound ? ' even before the unknown fees' : ''}`);
  if (landed && landed.status === 'INFORMATION_INSUFFICIENT') B(BLOCKER.CRITICAL_COST_UNKNOWN, 'HARD', `critical cost input(s) unknown: ${landed.criticalUnknown.join(', ')}`);
  if ((rules.results ?? []).some((r) => r.ruleId === 'eu.medical_boundary' && r.status === 'APPLIES')) B(BLOCKER.LEGAL_REQUIREMENT_UNRESOLVED, 'HARD', 'a medical purpose is claimed: Nordla does not assess medical devices - get an expert classification before any purchase');
  if (role.ownBrand === true) B(BLOCKER.OWN_BRAND_MANUFACTURER_DUTIES, 'CONDITION', 'selling under your own brand: you carry the manufacturer duties (technical file, conformity assessment, DoC, traceability)');

  const has = (c) => blockers.some((b) => b.code === c && b.severity !== 'CHANNEL');
  const hardNoGo = [BLOCKER.SAFETY_ALERT_EXACT_MATCH, BLOCKER.DOCUMENT_CONTRADICTS_CASE, BLOCKER.NEGATIVE_UNIT_ECONOMICS, BLOCKER.AMAZON_CATEGORY_RESTRICTION].some(has) || economics === 'UNATTRACTIVE';
  const insufficient = has(BLOCKER.PRODUCT_IDENTITY_UNRESOLVED) || has(BLOCKER.LEGAL_REQUIREMENT_UNRESOLVED) || has(BLOCKER.CRITICAL_COST_UNKNOWN) || economics === 'UNKNOWN';
  const conditions = [];
  if (has(BLOCKER.REQUIRED_DOCUMENT_MISSING)) conditions.push('obtain the required documents BEFORE any deposit');
  if (identityConf.level === 'MEDIUM') conditions.push('confirm the product traits that are only assumed from the category');
  if (economics === 'BORDERLINE') conditions.push('the margin is below the target: negotiate the price or accept the lower margin knowingly');
  if (safety.status === 'NOT_CHECKED') conditions.push('the Safety Gate was not consulted: OFFLINE - VERIFICATION REQUIRED');
  if (safetyRisk === 'MEDIUM' && safety.status === 'SIMILAR_PRODUCT_RISK') conditions.push('similar products were notified in the Safety Gate: ask the supplier how their design avoids that hazard');
  const expert = (rules.results ?? []).filter((r) => r.status === 'APPLIES' && r.severity === 'HIGH' && r.requiresAuthorityConfirmation && r.jurisdiction !== 'AMAZON');
  if (expert.length) conditions.push(`expert or authority confirmation recommended before a deposit: ${expert.map((r) => r.family).join(', ')} (higher-risk regimes: documents alone are not enough)`);
  if (customs && customs.status === 'CLASSIFICATION_REQUIRES_CONFIRMATION') conditions.push('choose and confirm the customs classification (binding tariff information or your customs broker)');
  if (role.ownBrand === true) conditions.push('own brand: technical file and conformity assessment are yours');
  if (amazonRequested && !['READY'].includes(amazon.readiness.status) && amazon.restricted !== true) conditions.push(`Amazon readiness is ${amazon.readiness.status}`);
  if (amazonRequested && amazon.economics && amazon.economics.status !== 'COMPLETE') conditions.push('Amazon economics are incomplete (fees not provided): the margin shown is an upper bound');
  if (rules.summary.unresolved > 0 && !has(BLOCKER.LEGAL_REQUIREMENT_UNRESOLVED)) conditions.push(`${rules.summary.unresolved} regime(s) still unresolved`);
  const verdict = hardNoGo ? VERDICT.NO_GO : insufficient ? VERDICT.INSUFFICIENT_INFORMATION : conditions.length ? VERDICT.CONDITIONAL_GO : VERDICT.GO;

  const why = [];
  why.push(`Identification ${identityConf.level}${identityConf.assumedFromProfileOnly.length ? ` (${identityConf.assumedFromProfileOnly.length} trait(s) only assumed from the category)` : ''}`);
  why.push(`EU / Belgium marketability ${marketability}${rules.ce ? `; ${rules.ce.status}` : ''}`);
  if (gaps.missingDocs.length) why.push(`missing required evidence: ${gaps.missingDocs.length}`);
  why.push(`Safety / recall risk ${safetyRisk} (Safety Gate: ${safety.status})`);
  why.push(econ && econ.contributionMinor !== null ? `Economics ${economics}: contribution ${fmt(econ.contributionMinor)} per unit${econ.contributionPct !== null ? ` (${(econ.contributionPct * 100).toFixed(1)}% of net revenue)` : ''}${econ.contributionIsUpperBound ? ', UPPER BOUND' : ''}` : `Economics ${economics}`);
  if (amazonRequested) why.push(`Amazon readiness ${amazon.readiness.status}`);

  const ask = (questions ?? []).filter((q) => q.priority === 'P1').slice(0, 5);
  const blocksImport = blockers.filter((b) => b.severity !== 'CHANNEL' && b.code !== BLOCKER.CRITICAL_COST_UNKNOWN && b.code !== BLOCKER.NEGATIVE_UNIT_ECONOMICS && b.code !== BLOCKER.AMAZON_CATEGORY_RESTRICTION).map((b) => b.code);
  const blocksAmazon = amazonRequested ? [...blocksImport, ...(amazon.restricted === true ? [BLOCKER.AMAZON_CATEGORY_RESTRICTION] : []), ...(amazon.readiness.open ?? []).map((o) => `AMAZON_EVIDENCE: ${o.label}`)] : [];
  const nextAction = verdict === VERDICT.NO_GO
    ? (has(BLOCKER.SAFETY_ALERT_EXACT_MATCH) ? 'STOP: a Safety Gate alert matches this product. Do not buy; ask the supplier for the corrective-action evidence only if you still want to pursue it.' : has(BLOCKER.DOCUMENT_CONTRADICTS_CASE) ? 'Do not rely on the documents supplied: ask for the correct documents for the exact model (see "Ask the supplier now").' : maxPrice?.maxUnitPriceMinor ? `At this price the economics fail: renegotiate to at most ${fmt(maxPrice.maxUnitPriceMinor, maxPrice.currency)} per unit or walk away.` : 'Economics fail at this price: renegotiate or walk away.')
    : verdict === VERDICT.INSUFFICIENT_INFORMATION && rules.results.some((r) => r.ruleId === 'eu.medical_boundary' && r.status === 'APPLIES') ? 'A medical claim is outside what Nordla can assess: get an expert classification before any purchase.'
    : verdict === VERDICT.INSUFFICIENT_INFORMATION ? `Ask the supplier now (${(questions ?? []).filter((q) => q.priority === 'P1').length} priority questions): ${ask.slice(0, 3).map((q) => q.en.replace(/\?.*$/, '').slice(0, 70)).join(' / ') || 'see the Ask tab'}.`
    : verdict === VERDICT.CONDITIONAL_GO ? 'Continue the conversation, but do NOT pay a deposit until the conditions below are cleared. Ask for the missing documents and a sample now.'
    : 'Request a sample and the proforma invoice; agree a third-party inspection before final payment. Still a decision aid, not a guarantee.';
  return {
    verdict, canCommitMoney: verdict === VERDICT.GO, dimensions: { identification: identityConf.level, marketability, amazonReadiness: amazonRequested ? amazon.readiness.status : 'NOT_REQUESTED', economics, supplierEvidence: evidence, safetyRisk },
    hardBlockers: blockers.filter((b) => b.severity === 'HARD'), conditionBlockers: blockers.filter((b) => b.severity !== 'HARD'), conditions, why,
    blocksImport, blocksAmazon, gaps, contradictions: contra, nextAction, maxPurchasePrice: maxPrice ?? null,
    note: 'Decision support only. Nordla is not a lawyer, customs authority, laboratory, certification body or Amazon approval authority.',
  };
}
