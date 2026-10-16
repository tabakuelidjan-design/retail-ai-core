// Proposal for the owner of supabase/migrations-pending/20261015090000_integration_objects_and_sourcing_cases.sql (chantier A / convergence):
// that file creates, in ONE transaction, the five integration tables the team wants AND the two the convergence decided NOT to apply, because the purchase order of Stock / Achats is the
// canonical object and a second persistent copy would double-count:
//     integration_purchase_plans            (a purchase plan = a purchase order in DRAFT / PENDING_APPROVAL / APPROVED, derived read-only: src/integration/procurement-compat.js)
//     integration_incoming_expectations     (an expectation = the outstanding lines of an ORDERED / CONFIRMED / PARTIALLY_RECEIVED order, derived read-only)
// This tool NEVER edits the file. It prints the text WITHOUT those two tables and everything that exists only for them, or the unified patch that produces it, so the split can be reviewed,
// applied by the owner of the file, and proven on a throw-away PostgreSQL (test/postgres/procurement-coexistence.pg-smoke.mjs).
//
//   node tools/procurement-staging/split-integration-migration.mjs <file> [--patch]
//
// What is removed (by name, each removal is checked; if the file changed shape the tool refuses instead of guessing):
//   1. create table integration_purchase_plans (...)                 2. create table integration_incoming_expectations (...)   (it references the plans)
//   3. function + trigger integration_purchase_plans_guard           4. trigger integration_incoming_write_once
//   5. the two names in the "service role only" loop (RLS + revoke), so the remaining five tables keep exactly the same protection.
// What stays untouched: integration_buy_candidates, integration_campaign_contracts, integration_tracking_definitions, integration_trace_ledger, sourcing_cases and their guards.
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export class SplitError extends Error { constructor(m) { super(m); this.name = 'SplitError'; } }

export function splitIntegrationMigration(sqlIn) {
  let s = String(sqlIn).replace(/\r\n/g, '\n'); const cut = (re, what) => { if (!re.test(s)) throw new SplitError(`cannot find ${what}: the migration changed shape, refusing to guess`); s = s.replace(re, ''); };
  cut(/create table integration_purchase_plans \(\n[\s\S]*?\n\);\n\n/, 'the integration_purchase_plans table');
  cut(/create table integration_incoming_expectations \(\n[\s\S]*?\n\);\n\n/, 'the integration_incoming_expectations table');
  cut(/-- Keys never move to another merchant or another reference; a purchase plan only moves forward; an approval is never removed\.\ncreate function integration_purchase_plans_guard\(\)[\s\S]*?create trigger integration_purchase_plans_guard [^\n]*\n\n/, 'the purchase plan guard (function + trigger)');
  cut(/create trigger integration_incoming_write_once [^\n]*\n/, 'the incoming expectation write-once trigger');
  if (!s.includes("'integration_purchase_plans', 'integration_incoming_expectations', ")) throw new SplitError('cannot find the two names in the access loop');
  s = s.replace("'integration_purchase_plans', 'integration_incoming_expectations', ", '');
  s = s.replace(/^(-- NORDLA CORE P0 - PREPARED, NOT APPLIED[^\n]*\n)/, '$1-- SPLIT VARIANT (proposal, Stock / Achats): integration_purchase_plans and integration_incoming_expectations are NOT created: the purchase order of Stock / Achats is canonical (docs/architecture/stock-achats-v1-ac-arbitrage.md).\n');
  for (const gone of ['integration_purchase_plans', 'integration_incoming_expectations']) if (new RegExp(`(create|alter|references|on) +(table +)?(public\\.)?${gone}\\b`, 'i').test(s)) throw new SplitError(`${gone} is still referenced after the split`);
  return s;
}

function unifiedPatch(path, before, after) {
  const dir = mkdtempSync(join(tmpdir(), 'nordla-split-')); writeFileSync(join(dir, 'a'), before.replace(/\r\n/g, '\n')); writeFileSync(join(dir, 'b'), after);
  const r = spawnSync('diff', ['-u', '--label', `a/${path}`, '--label', `b/${path}`, join(dir, 'a'), join(dir, 'b')], { encoding: 'utf8' });
  return r.stdout;
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop())) {
  const [file, flag] = process.argv.slice(2);
  if (!file) { console.error('usage: node split-integration-migration.mjs <migration.sql> [--patch]'); process.exit(2); }
  const before = readFileSync(file, 'utf8'); let after;
  try { after = splitIntegrationMigration(before); } catch (e) { console.error(`REFUSED: ${e.message}`); process.exit(1); }
  process.stdout.write(flag === '--patch' ? unifiedPatch('supabase/migrations-pending/20261015090000_integration_objects_and_sourcing_cases.sql', before, after) : after);
}
