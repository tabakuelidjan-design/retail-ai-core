// Targeted mutation sweep for the integration layer - ONLY the safety-critical logic (routing, approval boundaries, identity conflicts, provenance promotion,
// cross-module financial / stock safety). Each mutant changes one expression; the contract tests run first, the workflow tests only if the contracts survive.
// Usage: node tools/integration-mutation.mjs [--only <id>]   (restores every file it touches, even on failure)
import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const MUTANTS = [
  // approval boundaries
  ['approval/machine-approver', 'src/integration/approval.js', "|| MACHINE.has(ap.id.toLowerCase())", ''],
  ['approval/human-kind', 'src/integration/approval.js', "ap.kind !== 'HUMAN' ||", 'false ||'],
  ['approval/default-deny', 'src/integration/approval.js', "if (!level) return { decision: 'BLOCK'", "if (!level) return { decision: 'ALLOW'"],
  ['approval/subject-match', 'src/integration/approval.js', "(!subject_ref || a.subject_ref === subject_ref)", 'true'],
  ['approval/action-match', 'src/integration/approval.js', "a?.action === action &&", 'true &&'],
  ['approval/blocked-level', 'src/integration/approval.js', "if (level === L.BLOCKED) return { decision: 'BLOCK'", "if (level === L.BLOCKED) return { decision: 'ALLOW'"],
  ['approval/owner-needs-record', 'src/integration/approval.js', "if (!matching.length) return", "if (false) return"],
  ['hub/ignore-approval-required', 'src/integration/hub.js', "if (auth.decision === 'APPROVAL_REQUIRED') {", "if (false) {"],
  ['hub/availability', 'src/integration/hub.js', "if (!has(module)) {", "if (false) {"],
  // identity
  ['ids/local-binding', 'src/integration/ids.js', "if (byLocal.has(lk) && byLocal.get(lk) !== ck) fail(", "if (false) fail("],
  ['ids/strong-key', 'src/integration/ids.js', "if (owner && owner !== ck) fail(", "if (false) fail("],
  ['ids/ambiguous-first', 'src/integration/ids.js', "if (hits.length === 1) return hits[0];", "if (hits.length >= 1) return hits[0];"],
  // provenance
  ['prov/human-or-official', 'src/integration/provenance.js', "if (!humanOrOfficial ||", "if (false ||"],
  ['prov/machine-verifier', 'src/integration/provenance.js', "if (['SYSTEM', 'LLM', 'AI', 'ENGINE', 'MODEL'].includes(String(v.verifier).toUpperCase()))", "if (false)"],
  ['prov/conflict-resolution', 'src/integration/provenance.js', "if (fact.provenance === P.CONFLICT && !v.resolves_conflict)", "if (false)"],
  ['prov/currency-mismatch', 'src/integration/provenance.js', "if (a.currency !== b.currency) {", "if (false) {"],
  ['prov/only-to-verified', 'src/integration/provenance.js', "if (to !== P.VERIFIED) fail(", "if (false) fail("],
  ['prov/quoted-is-claim', 'src/integration/provenance.js', "QUOTED: P.SUPPLIER_CLAIM", "QUOTED: P.VERIFIED"],
  // Finance: currency, cash, landed
  ['finance/human-fx', 'src/finance/purchase-analysis.js', "if (!r || !humanProvenance) {", "if (!r) {"],
  ['finance/no-fx-at-all', 'src/finance/purchase-analysis.js', "if (!r || !humanProvenance) {", "if (false) {"],
  ['finance/cost-currency', 'src/finance/purchase-analysis.js', "if (input.cost_currency && input.cost_currency !== merchantCurrency) {", "if (false) {"],
  ['finance/import-vat-in-cash', 'src/finance/purchase-analysis.js', "const cashRequirement = landedTotal + importVat;", "const cashRequirement = landedTotal;"],
  ['finance/duty', 'src/finance/purchase-analysis.js', "const duty = percentOfCents(customsValue, rates.duty_rate_pct);", "const duty = 0;"],
  ['finance/negative-margin-flag', 'src/finance/purchase-analysis.js', "if (margin < 0) risks.push(RISK.NEGATIVE_MARGIN);", "if (false) risks.push(RISK.NEGATIVE_MARGIN);"],
  ['finance/lower-bound', 'src/finance/purchase-analysis.js', "basis: foreign ? 'ESTIMATED' : (unknown.length ? 'LOWER_BOUND' : 'CALCULATED'), unknown_inputs: unknown }", "basis: foreign ? 'ESTIMATED' : 'CALCULATED', unknown_inputs: unknown }"],
  // handoffs: stock and purchase safety
  ['handoff/in-stock-needs-stock', 'src/integration/handoffs.js', "availability.on_hand_available > 0 ?", "availability.on_hand_available >= 0 ?"],
  ['handoff/incoming-not-stock', 'src/integration/handoffs.js', "on_hand_available: Number.isInteger(on_hand) ? on_hand : null,", "on_hand_available: Number.isInteger(on_hand) ? on_hand + incoming.reduce((s, e) => s + e.qty, 0) : null,"],
  ['handoff/incoming-needs-approval', 'src/integration/handoffs.js', "if (plan.status !== 'APPROVED_TO_ORDER') fail(ERR.APPROVAL_REQUIRED", "if (false) fail(ERR.APPROVAL_REQUIRED"],
  ['handoff/buy-verdict', 'src/integration/handoffs.js', "if (!BUYABLE.has(verdict) || blockers.length) fail(", "if (false) fail("],
  ['handoff/buy-approval-subject', 'src/integration/handoffs.js', "approval.subject_ref !== case_ref) fail(", "false) fail("],
  ['handoff/plan-approval-subject', 'src/integration/handoffs.js', "approval.subject_ref !== plan.purchase_ref) fail(", "false) fail("],
  ['handoff/plan-needs-analysis', 'src/integration/handoffs.js', "if (finance_analysis?.status !== 'ANALYZED') fail(", "if (false) fail("],
  ['handoff/moq', 'src/integration/handoffs.js', "if (Number.isInteger(q.moq.value) && quantity < q.moq.value) fail(", "if (false) fail("],
  ['handoff/brand-wording', 'src/integration/handoffs.js', "reg.get(c.ref) === c.wording ?", "true ?"],
  ['handoff/creative-brand-gate', 'src/integration/handoffs.js', "if (!contract.checks.brand.ok) fail(", "if (false) fail("],
  ['handoff/creative-stock-gate', 'src/integration/handoffs.js', "if (!contract.checks.stock.ok) fail(", "if (false) fail("],
  ['handoff/unknown-stock', 'src/integration/handoffs.js', "if (!availability.on_hand_known) return", "if (false) return"],
  ['handoff/coming-soon-needs-eta', 'src/integration/handoffs.js', "return availability.earliest_eta ? {", "return true ? {"],
  ['handoff/tenant-brand', 'src/integration/handoffs.js', "if (brand.tenant_id !== tenant_id) fail(", "if (false) fail("],
  // router
  ['router/ambiguous-first', 'src/integration/router.js', "if (focus.length === 1) return { ref: focus[0] };\n    if (focus.length > 1) return { status: STATUS.ASK, reason: 'AMBIGUOUS_REFERENCE', question: `Lequel ? ${focus.length} possibilités`", "if (focus.length >= 1) return { ref: focus[0] };\n    if (focus.length > 1) return { status: STATUS.ASK, reason: 'AMBIGUOUS_REFERENCE', question: `Lequel ? ${focus.length} possibilités`"],
  ['router/permission', 'src/integration/router.js', "if (denied) return", "if (false) return"],
  ['router/unavailable', 'src/integration/router.js', "if (missing) return", "if (false) return"],
  ['router/name-ambiguity', 'src/integration/router.js', "if (named.length === 1) return { ref: named[0].ref };", "if (named.length >= 1) return { ref: named[0].ref };"],
  ['router/active-context', 'src/integration/router.js', "if (!mod || !ACTIVE_MODULE_COMMAND[mod]) return", "if (false) return"],
  ['router/sales-rule', 'src/integration/router.js', "route: [[M.ANALYTICS, 'explain_change']]", "route: [[M.FINANCE, 'search_invoices']]"],
  // ledger and supplier exposure
  ['ledger/chain', 'src/integration/ledger.js', "if (body.prev !== prev || sha(prev + canonical(body)) !== hash) return", "if (false) return"],
  ['ledger/tenant', 'src/integration/ledger.js', "if (e.tenant_id !== undefined && e.tenant_id !== tenant_id) fail(", "if (false) fail("],
  ['exposure/foreign-not-converted', 'src/integration/index.js', "if (eur === null) { foreign.push(", "if (false) { foreign.push("],
  ['exposure/paid-skipped', 'src/integration/index.js', "if (r.paymentStatus === 'paid') continue;", ""],
];

// Equivalent mutants (proved, not survivors): a fully paid invoice has allocated == gross, so skipping the 'paid' shortcut yields the same exposure (0).
const EQUIVALENT = new Set(['exposure/paid-skipped']);
const only = process.argv.includes('--only') ? process.argv[process.argv.indexOf('--only') + 1] : null;
const run = (file) => spawnSync(process.execPath, ['--test', file], { encoding: 'utf8', timeout: 240_000 });
const results = [];
for (const [id, file, find, repl] of MUTANTS) {
  if (only && id !== only) continue;
  const original = readFileSync(file, 'utf8');
  const hay = original.replace(/\r\n/g, '\n');
  if (!hay.includes(find)) { results.push({ id, status: 'NOT_APPLIED' }); continue; }
  try {
    writeFileSync(file, hay.replace(find, repl));
    let r = run('test/integration-contracts.test.js');
    if (r.status !== 0) { results.push({ id, status: 'KILLED', by: 'contracts' }); continue; }
    r = run('test/integration-workflows.test.js');
    results.push(r.status !== 0 ? { id, status: 'KILLED', by: 'workflows' } : { id, status: EQUIVALENT.has(id) ? 'EQUIVALENT' : 'SURVIVED' });
  } finally { writeFileSync(file, original); }
}
for (const r of results) console.log(`${r.status.padEnd(11)} ${r.id}${r.by ? ` (${r.by})` : ''}`);
const surv = results.filter((r) => r.status === 'SURVIVED'); const na = results.filter((r) => r.status === 'NOT_APPLIED');
console.log(`mutants: ${results.length}, killed: ${results.filter((r) => r.status === 'KILLED').length}, equivalent: ${results.filter((r) => r.status === 'EQUIVALENT').length}, survived: ${surv.length}, not applied: ${na.length}`);
process.exitCode = surv.length || na.length ? 1 : 0;
