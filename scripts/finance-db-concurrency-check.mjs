// One-off integration check against the REAL database: are number allocations under genuine concurrency unique and gapless?
// Uses a clearly-labelled SCRATCH merchant (never the real one). Issued documents are immutable by design, so cleanup is a separate
// step (see the SQL printed at the end) that temporarily disables the guard triggers inside a single transaction and re-enables them.
//   node --env-file=.env scripts/finance-db-concurrency-check.mjs setup|run|verify
// No synthetic value here is real business data.

import { randomUUID } from 'node:crypto';
import { createSupabaseClient, loadSupabaseConfigFromEnv } from '../src/supabase/client.js';

const N = 20;
const SCRATCH = '__finance_concurrency_scratch__';
const supabase = createSupabaseClient(loadSupabaseConfigFromEnv());
const step = process.argv[2];

const scratch = async () => (await supabase.select('merchants', { select: 'id', name: `eq.${SCRATCH}` }))[0]?.id ?? null;

if (step === 'setup') {
  const [m] = await supabase.insert('merchants', [{ name: SCRATCH, source_system: 'scratch', source_id: randomUUID() }]);
  const docs = Array.from({ length: N }, () => ({ id: randomUUID(), merchant_id: m.id, doc_type: 'invoice', status: 'READY_FOR_APPROVAL', currency: 'EUR', issue_date: '2026-09-22', due_date: '2026-10-22', body: {} }));
  await supabase.insert('fin_documents', docs);
  console.log(JSON.stringify({ merchant: m.id, documents: docs.length }));
} else if (step === 'run') {
  const m = await scratch();
  const docs = await supabase.select('fin_documents', { select: 'id,version', merchant_id: `eq.${m}` });
  const t0 = Date.now();
  const results = await Promise.allSettled(docs.map((d) => supabase.rpc('fin_issue_document', {
    p_merchant: m, p_doc_id: d.id, p_expected_version: d.version, p_new_status: 'ISSUED', p_prefix: 'TST', p_pad: 4, p_format: '{prefix}-{year}-{seq}', p_year: 2099,
    p_canonical: '{"number":"__P__"}', p_placeholder: '__P__', p_locked_at: '2099-01-01T00:00:00Z', p_event: { actor: { type: 'test' }, action: 'APPROVE_AND_ISSUE', detail: { number: '__P__' } },
  })));
  const ok = results.filter((r) => r.status === 'fulfilled');
  console.log(JSON.stringify({ parallel_calls: docs.length, fulfilled: ok.length, rejected: results.length - ok.length, ms: Date.now() - t0, errors: results.filter((r) => r.status === 'rejected').map((r) => String(r.reason.message).slice(0, 120)) }));
} else if (step === 'verify') {
  const m = await scratch();
  const docs = await supabase.select('fin_documents', { select: 'number,status,locked_at,snapshot_hash', merchant_id: `eq.${m}` });
  const seqs = docs.map((d) => Number(String(d.number).split('-').pop())).sort((a, b) => a - b);
  const events = await supabase.select('fin_events', { select: 'id', merchant_id: `eq.${m}` });
  const expected = Array.from({ length: N }, (_, i) => i + 1);
  console.log(JSON.stringify({ documents: docs.length, issued: docs.filter((d) => d.status === 'ISSUED' && d.locked_at && d.snapshot_hash).length, unique_numbers: new Set(seqs).size, gapless_1_to_N: JSON.stringify(seqs) === JSON.stringify(expected), audit_events: events.length, numbers: seqs.join(',') }));
  console.log(`CLEANUP_MERCHANT_ID=${m}`);
} else { console.error('usage: setup | run | verify'); process.exitCode = 1; }
