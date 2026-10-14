#!/usr/bin/env node
// CASE AUDIT (read-only by default). Traces every fact of one stored case (an exported nordla-case-*.json, or a file of the server's case store) through the ledger: where each value came from, who changed it,
// and which review states disagree with what the case holds today. Nothing is guessed: it prints what is recorded.
//   node tools/case-audit.mjs case.json                      the facts, their history, the findings
//   node tools/case-audit.mjs case.json --trace MOQ          one fact type with every ledger entry, candidate and event that touched it
//   node tools/case-audit.mjs case.json --revert led-3 --reason "typed in the wrong place" --out repaired.json
//        cancels ONE owner correction (append-only: the correction stays, voided, with the reason) and writes the result to a NEW file; the input is never modified
import { readFileSync, writeFileSync } from 'node:fs';
import { upgradeCase } from '../src/sourcing/core/upgrade.js';
import { dispatch } from '../src/sourcing/core/case.js';
import { caseFacts, auditCase, FACT_TYPES } from '../src/sourcing/core/case-facts.js';

const args = process.argv.slice(2); const file = args.find((a) => !a.startsWith('--') && !['--trace', '--revert', '--reason', '--out'].includes(args[args.indexOf(a) - 1] ?? ''));
const opt = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : null; };
if (!file) { console.error('usage: node tools/case-audit.mjs case.json [--trace MOQ] [--revert <ledgerId> --reason "..." --out repaired.json]'); process.exit(2); }
let state = upgradeCase(JSON.parse(readFileSync(file, 'utf8')));
const show = (v) => (typeof v === 'object' && v !== null ? JSON.stringify(v) : String(v));
if (opt('--revert')) {
  if (!opt('--out')) { console.error('--revert needs --out <new file>: the input file is never modified'); process.exit(2); }
  state = dispatch(state, { type: 'FACT_REVERT', ledgerId: opt('--revert'), mode: 'system', reason: opt('--reason') ?? 'correction cancelled (case-audit)' }, new Date());
  writeFileSync(opt('--out'), JSON.stringify(state, null, 1)); console.log(`reverted ${opt('--revert')}; written to ${opt('--out')}`);
}
console.log(`CASE ${state.id} · supplier ${state.supplier?.name ?? '?'} · ${state.events.length} events · ${state.ledger.length} ledger entries · ${(state.offers ?? []).length} offers\n`);
for (const f of caseFacts(state)) {
  console.log(`${f.fact_type.padEnd(13)} ${show(f.value).padEnd(22)} ${f.source_type.padEnd(20)} ${f.review_status.padEnd(10)} v${f.revision}${f.source_reference.mode ? ` via ${f.source_reference.mode}` : ''}${f.ledger_id ? ` (${f.ledger_id})` : ' (no ledger entry)'}`);
  if (f.history.length > 1 || opt('--trace') === f.fact_type) for (const h of f.history) console.log(`    v${h.revision} ${show(h.value).padEnd(18)} ${h.source_type.padEnd(18)} ${h.review_status.padEnd(10)} ${h.created_at ?? ''} ${h.ledger_id}${h.voided ? ' VOIDED' : ''}${h.source_reference.candidateId ? ` cand ${h.source_reference.candidateId}` : ''}${h.source_reference.offerId ? ` offer ${h.source_reference.offerId}` : ''}${h.provenance.reason ? ` — ${h.provenance.reason}` : ''}`);
}
const t = opt('--trace'); if (t && FACT_TYPES[t]) { const key = FACT_TYPES[t].key; console.log(`\nEVERYTHING THAT TOUCHED ${t} (${key})`); for (const c of state.candidates.filter((x) => x.key === key)) console.log(`  candidate ${c.id} offer ${c.offerId ?? '-'} state ${c.state} value ${show(c.value)}${c.correctedValue !== undefined ? ` corrected→${show(c.correctedValue)}` : ''} text « ${c.rawText} »${c.correctionReverted ? ` (correction reverted: ${c.correctionReverted.reason})` : ''}`); for (const e of state.events.filter((x) => x.ref?.key === key)) console.log(`  event ${e.at} ${e.type} ${e.summary ?? ''}`); }
const findings = auditCase(state); console.log(`\nFINDINGS (${findings.length})`); for (const x of findings) console.log(`  ${x.kind}: ${x.fact_type ?? ''} ${x.key} — ${x.note}${x.correctedValue !== undefined ? ` [said ${show(x.originalValue)}, corrected to ${show(x.correctedValue)}, case holds ${show(x.currentValue ?? '—')}; ${x.ledgerId ?? 'no ledger id'}]` : ''}`);
if (!findings.length) console.log('  none');
