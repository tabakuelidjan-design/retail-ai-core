// Deterministic regulatory rule engine. Rules are DATA (src/sourcing/core/rulebook/*.js), evaluated with three-valued logic over the Product Identity traits and
// the case context. It decides, for each regulatory family, APPLIES / NOT_APPLICABLE / UNRESOLVED - never "assume applicable because it is made in China",
// never "assume not applicable because a logo is visible". No LLM, no prompt. Every result carries its why, its required evidence, what is missing, its
// sources, and the freshness and verification level of those sources.
import { evaluate, readsOf } from './predicate.js';
import { traitEnv } from './identity.js';
import { RULE_STATUS, REQUIREMENT } from './levels.js';
import { STANDARD_FAMILIES } from './docinspect.js';

const DAY = 86400000;

/** Freshness of one source record: regulatory sources are re-checked, stale or unchecked ones are surfaced, never silently relied upon. */
export function sourceFreshness(src, now, maxAgeDays = 180) {
  if (!src.checkedAt) return { status: 'UNCHECKED', ageDays: null };
  const age = Math.floor((now.getTime() - Date.parse(src.checkedAt)) / DAY);
  return { status: age > (src.maxAgeDays ?? maxAgeDays) ? 'STALE' : 'FRESH', ageDays: age };
}
export const VERIFICATION_RANK = Object.freeze({ OPENED_OFFICIAL: 3, SECONDARY_OFFICIAL: 2, SEEN_IN_SEARCH_SNIPPET: 1, NOT_OPENED_ELI: 1, BACKGROUND_KNOWLEDGE: 0, PENDING_RESEARCH: 0 });

/** Does a supplied document satisfy a requirement? PRESENT only when it is the right type, covers the instrument if one is named, and no consistency concern exists. */
const d_all = (xs, f) => xs.filter(f);
export function coverageOf(req, docs, rule) {
  const types = req.docTypes ?? [req.docType]; const typed = docs.filter((d) => types.includes(d.docType));
  if (!typed.length) return { status: 'MISSING', docIds: [] };
  const refs = req.coversRefs ?? rule.instrumentRefs ?? [];
  const cites = (d) => { const x = d.extraction ?? {}; const cited = [...(x.directives ?? []), ...(x.regulations ?? []), ...(x.standards ?? [])].join(' ').toUpperCase(); return refs.some((r) => cited.includes(String(r).toUpperCase())); };
  // test-type evidence is tied to a regulation by the STANDARDS it applies (a lab report cites EN 62368-1, rarely the directive); declarations by the legislation they cite
  const byStandards = ['TEST_REPORT', 'BATTERY_DOC', 'CERTIFICATE', 'ROHS_EVIDENCE', 'REACH_EVIDENCE'].some((t) => types.includes(t)) && rule.standardFamily && STANDARD_FAMILIES[rule.standardFamily];
  const matches = (d) => { const x = d.extraction ?? {}; if (byStandards && (x.standards ?? []).some((st) => STANDARD_FAMILIES[rule.standardFamily].test(st))) return true; if (rule.family === 'ROHS' && x.mentionsRoHS) return true; if (rule.family === 'REACH' && x.mentionsREACH) return true; return refs.length ? cites(d) : !byStandards; };
  const covering = d_all(typed, matches);
  if (!covering.length) return { status: 'DOES_NOT_COVER_THIS_REGULATION', docIds: typed.map((d) => d.id) };
  const clean = covering.filter((d) => ['NO_ISSUE_FOUND'].includes(d.inspection?.consistency));
  if (clean.length) return { status: 'PRESENT', docIds: clean.map((d) => d.id) };
  return { status: 'PRESENT_WITH_CONCERNS', docIds: covering.map((d) => d.id), consistency: [...new Set(covering.map((d) => d.inspection?.consistency ?? 'UNVERIFIED'))] };
}

/**
 * @param {{ identity: object, context: object, rulebook: object[], docs?: object[], now?: Date }} args
 * context: { market: 'EU-BE', channels: ['own_site','amazon'], consumerSales: true, role: { roles: [...] } }
 */
export function evaluateRules({ identity, context, rulebook, docs = [], now = new Date() }) {
  const env = traitEnv(identity, { ...context, role: context.role?.roles ?? [], ownBrand: context.role?.ownBrand ?? null });
  const results = rulebook.map((rule) => {
    if (rule.channel && !(context.channels ?? []).includes(rule.channel)) return { rule, skipped: true };
    const applies = evaluate(rule.appliesWhen, env);
    const status = applies === true ? RULE_STATUS.APPLIES : applies === false ? RULE_STATUS.NOT_APPLICABLE : RULE_STATUS.UNRESOLVED;
    const unknownReads = status === RULE_STATUS.UNRESOLVED ? [...readsOf(rule.appliesWhen)].filter((r) => (r.startsWith('trait:') ? env.trait(r.slice(6)) : env.ctx(r.slice(4))) === null || (r.startsWith('trait:') ? env.trait(r.slice(6)) : env.ctx(r.slice(4))) === undefined) : [];
    const requiredEvidence = (rule.requiredEvidence ?? []).map((req) => {
      if (status === RULE_STATUS.NOT_APPLICABLE) return { ...req, requirement: REQUIREMENT.NOT_APPLICABLE, coverage: { status: 'NOT_NEEDED', docIds: [] } };
      let requirement = req.requirement;
      let reqUnknown = [];
      if (req.when) { const w = evaluate(req.when, env); requirement = w === true ? REQUIREMENT.REQUIRED : w === false ? REQUIREMENT.NOT_APPLICABLE : REQUIREMENT.CONDITIONAL; if (w === null) reqUnknown = [...readsOf(req.when)]; }
      if (status === RULE_STATUS.UNRESOLVED && requirement === REQUIREMENT.REQUIRED) requirement = REQUIREMENT.CONDITIONAL;
      const coverage = requirement === REQUIREMENT.NOT_APPLICABLE ? { status: 'NOT_NEEDED', docIds: [] } : req.docType === 'COMPANY_RECORD' || req.docType === null ? { status: 'OWN_ACTION', docIds: [] } : coverageOf(req, docs, rule);
      return { ...req, requirement, coverage, unknownReads: reqUnknown };
    });
    const missing = requiredEvidence.filter((r) => [REQUIREMENT.REQUIRED, REQUIREMENT.CONDITIONAL].includes(r.requirement) && ['MISSING', 'DOES_NOT_COVER_THIS_REGULATION', 'PRESENT_WITH_CONCERNS', 'OWN_ACTION'].includes(r.coverage.status));
    const sources = (rule.sources ?? []).map((s) => ({ ...s, freshness: sourceFreshness(s, now), verificationRank: VERIFICATION_RANK[s.verification] ?? 0 }));
    const weakest = sources.length ? Math.min(...sources.map((s) => s.verificationRank)) : 0;
    return {
      ruleId: rule.id, family: rule.family, jurisdiction: rule.jurisdiction, title: rule.title, status, why: applies === true ? rule.whyApplies : applies === false ? rule.whyNot ?? 'the identity facts established so far exclude it' : `cannot be decided yet: ${unknownReads.join(', ')} unknown`,
      unknownReads, requiredEvidence, missingEvidence: missing, sources, ruleVersion: rule.ruleVersion, instrumentRefs: rule.instrumentRefs ?? [], standardFamily: rule.standardFamily ?? null,
      requiresAuthorityConfirmation: rule.requiresAuthorityConfirmation === true, sourceVerification: weakest >= 3 ? 'VERIFIED_ON_OFFICIAL_PAGE' : weakest >= 1 ? 'PARTLY_VERIFIED' : 'UNVERIFIED_EXPERT_CHECK_NEEDED',
      freshness: sources.some((s) => s.freshness.status !== 'FRESH') ? (sources.some((s) => s.freshness.status === 'UNCHECKED') ? 'UNCHECKED' : 'STALE') : 'FRESH', notes: rule.notes ?? null, severity: rule.severity ?? 'NORMAL',
    };
  }).filter((r) => !r.skipped && r.ruleId);

  const applying = results.filter((r) => r.status === RULE_STATUS.APPLIES);
  const ce = results.find((r) => r.ruleId === 'eu.ce');
  return {
    results, ruleBookVersion: rulebook.map((r) => r.ruleVersion).sort().at(-1) ?? null,
    ce: ce ? { status: ce.status === RULE_STATUS.APPLIES ? 'CE_REQUIRED' : ce.status === RULE_STATUS.NOT_APPLICABLE ? 'CE_NOT_APPLICABLE' : 'CE_APPLICABILITY_UNRESOLVED', why: ce.why, unknownReads: ce.unknownReads } : null,
    expectedStandardFamilies: [...new Set(applying.map((r) => r.standardFamily).filter(Boolean))],
    summary: { applies: applying.length, notApplicable: results.filter((r) => r.status === RULE_STATUS.NOT_APPLICABLE).length, unresolved: results.filter((r) => r.status === RULE_STATUS.UNRESOLVED).length, missingRequired: results.reduce((a, r) => a + r.missingEvidence.filter((m) => m.requirement === REQUIREMENT.REQUIRED).length, 0) },
  };
}
