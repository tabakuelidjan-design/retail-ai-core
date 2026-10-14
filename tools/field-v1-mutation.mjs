#!/usr/bin/env node
// Focused mutation check for China Sourcing Field V1: decision logic, provenance rules, conflict handling, recommendation logic and the dependency-aware recompute ONLY (not formatting).
// Each mutation changes ONE line of one source file, runs the focused tests, and must be KILLED (a test fails). A survivor is a missing test. The file is always restored.   node tools/field-v1-mutation.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
const F = 'src/sourcing/core/'; const T = ['offer-import', 'changes', 'deal-negotiation', 'truth-fit', 'derived', 'workspace', 'china-day'].map((x) => `test/sourcing-field-v1-${x}.test.js`);
const M = [
  ['owner lines become supplier facts', `${F}field/offer-import.js`, "extract: speaker !== SPEAKER.ME && !plan.typed", "extract: !plan.typed", T.slice(0, 1)],
  ['a product fact (material) is absorbed as an update', `${F}conflicts.js`, "'offer.warranty']);\n/** True when", "'offer.warranty', 'spec.material']);\n/** True when", T.slice(0, 1)],
  ['two prices inside ONE offer stop being a contradiction', `${F}conflicts.js`, "return !(last && cand.offerId && last.offerId === cand.offerId);", "return true;", T.slice(0, 1)],
  ['an unregistered provider keeps VERIFIED', `${F}field/external-evidence.js`, "declared === 'VERIFIED' && !registered ? 'ESTIMATED' : declared", "declared", T.slice(3, 4)],
  ['a matching supplier document becomes VERIFIED', `${F}field/truth-card.js`, "st.status === 'MISMATCH' ? 'CONFLICT' : 'SUPPLIER_CLAIM'", "st.status === 'MISMATCH' ? 'CONFLICT' : (received && st.matched ? 'VERIFIED' : 'SUPPLIER_CLAIM')", T.slice(3, 4)],
  ['a blocked offer is no longer recommended PASS', `${F}field/revisions.js`, "r.role === ROLE.BLOCKED ? RECOMMENDATION.PASS", "r.role === ROLE.BLOCKED ? RECOMMENDATION.INVESTIGATE", T.slice(1, 2)],
  ['the comparison names a winner while offers are still unknown', `${F}comparison.js`, "else if (notEliminated.length > viable.length) noWinnerReason", "else if (false) noWinnerReason", T.slice(6)],
  ['the opening target goes ABOVE the maximum price', `${F}field/deal.js`, "{ status: 'CONFIGURED_STEP', minor: Math.round(max.minor * (1 - step / 100))", "{ status: 'CONFIGURED_STEP', minor: Math.round(max.minor * (1 + step / 100))", T.slice(2, 3)],
  ['a target is shown without a configured step', `${F}field/negotiation.js`, "target.status === 'CONFIGURED_STEP' ? { status: 'CONFIGURED_STEP'", "target.status !== 'X' ? { status: 'CONFIGURED_STEP'", T.slice(2, 3)],
  ['evidence completeness ignores three critical gaps', `${F}field/evidence-status.js`, "nc >= 3 ?", "nc >= 99 ?", T.slice(3, 4)],
  ['the economics are not re-assessed when the selling price changes', `${F}field/derived.js`, "slices: ['identity', 'placing', 'supplier', 'quote', 'sale', 'costs', 'documents', 'safety', 'market']", "slices: ['identity', 'placing', 'supplier', 'quote', 'costs', 'documents', 'safety', 'market']", T.slice(4, 5)],
  ['a changed fact never invalidates anything (stale derived state)', `${F}field/derived.js`, "if (prev && prev.fp === f && !opts.force)", "if (prev && !opts.force)", T.slice(4, 5)],
  ['merchant fit declares a label with almost nothing known', `${F}field/merchant-fit.js`, "known < 5 ||", "known < 0 ||", T.slice(3, 4)],
  ['the ask list is not capped', `${F}field/ask-now.js`, "if (chosen.length >= max) break;", "", T.slice(3, 4).concat(T.slice(6))],
  ['a certificate claimed twice without a document is not noticed', `${F}field/memory.js`, "(hist.length >= 2 || statedIn.size >= 2)", "false", T.slice(3, 4)],
  ['the same inputs are recorded again and again', `${F}field/workspace.js`, "if (list.some((s) => s.id === id)) return { ws, recorded: false, id };", "", T.slice(5, 6)],
  ['the older ask state wins a merge', `${F}field/workspace.js`, "!x ? y : !y ? x : String(x.at) >= String(y.at) ? x : y; } out.askState[caseId] = qs;", "!x ? y : !y ? x : String(x.at) <= String(y.at) ? x : y; } out.askState[caseId] = qs;", T.slice(5, 6)],
  ['the owner\'s own chat line stays a proposal about the supplier', `${F}conversation.js`, "if (ev.speaker === SPEAKER.ME && c.offerId && c.state === CANDIDATE_STATE.PROPOSED)", "if (false)", T.slice(0, 1).concat(T.slice(3, 4))],
  ['revisions are ordered by a clock again', `${F}field/revisions.js`, "out.sort((a, b) => a.quoteIndex - b.quoteIndex ||", "out.sort((a, b) => String(a.at).localeCompare(String(b.at)) ||", T.slice(1, 2)],
  ['a landed cost that is only a lower bound is compared as exact', `${F}field/deal.js`, "const provisional = withLanded.length !== rows.length || withLanded.some((r) => r.lb);", "const provisional = false;", T.slice(2, 3)],
  ['an UNKNOWN margin counts as supported', `${F}field/merchant-fit.js`, "if (!e || e.contributionPct === null || e.contributionPct === undefined) return dim('marginPotential', FIT_STATE.UNKNOWN", "if (false) return dim('marginPotential', FIT_STATE.UNKNOWN", T.slice(3, 4)],
];
let killed = 0; const survivors = [];
for (const [name, file, from, to, tests] of M) {
  const src = readFileSync(file, 'utf8'); const n = src.split(from).length - 1; if (n !== 1) { console.log(`SKIP  ${name}: pattern found ${n} times in ${file}`); survivors.push(`${name} (pattern)`); continue; }
  try { writeFileSync(file, src.replace(from, to)); const r = spawnSync(process.execPath, ['--test', ...tests], { encoding: 'utf8', timeout: 240000 }); const dead = r.status !== 0; if (dead) killed += 1; else survivors.push(name); console.log(`${dead ? 'KILLED  ' : 'SURVIVED'} ${name}`); } finally { writeFileSync(file, src); }
}
console.log(`\n${killed}/${M.length} mutations killed${survivors.length ? `; survivors: ${survivors.join(' | ')}` : ''}`); process.exit(survivors.length ? 1 : 0);
