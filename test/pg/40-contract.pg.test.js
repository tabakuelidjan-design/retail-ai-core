// Phase 1 - MEMORY <-> POSTGRES CONTRACT, PostgreSQL half. The scenarios (test/finance-contract-scenarios.js) run on the PRODUCTION store code (supabase-store.js, unchanged)
// talking to the real PostgreSQL 17 of the bench through a REST-compatible shim (lib/pgrest.js). The results must equal the pinned EXPECTED results that the in-memory
// store must also produce (test/finance-payment-contract.test.js): memory == PostgreSQL == EXPECTED. Concurrency is NOT part of this contract (see 30-p0-regression).
import { readFileSync } from 'node:fs';
import { createSupabaseFinanceStore } from '../../src/finance/supabase-store.js';
import { createFinanceService } from '../../src/finance/service.js';
import { createInboxService, createMemoryAttachmentStore } from '../../src/finance/inbox.js';
import { CONFIG } from '../finance-fixtures.js';
import { SCENARIOS, A, mkClock } from '../finance-contract-scenarios.js';
import { createPgRestClient } from './lib/pgrest.js';
import { freshDatabase, seedMerchants } from './lib/db.js';
import { control } from './lib/classify.js';

const EXPECTED = JSON.parse(readFileSync(new URL('../finance-contract-expected.json', import.meta.url), 'utf8'));

async function pgWorld() {
  const db = await freshDatabase(); const s = await db.open(); await seedMerchants(s); await s.end();
  const rest = await createPgRestClient(db.name); const stores = new Map(); const clock = mkClock();
  const storeFor = (m = A) => { if (!stores.has(m)) stores.set(m, createSupabaseFinanceStore(rest, { merchantId: m })); return stores.get(m); };
  return { name: 'postgres', storeFor, svc: createFinanceService({ store: storeFor(A), config: { ...CONFIG, merchantId: A }, clock }),
    inboxFor: (st) => createInboxService({ store: st, attachments: createMemoryAttachmentStore(), merchantId: A, now: clock.now }), close: async () => { await rest.close(); await db.drop(); } };
}

for (const [name, scenario] of Object.entries(SCENARIOS)) {
  control(`CONTRACT ${name}`, async () => {
    const w = await pgWorld();
    try {
      const got = JSON.parse(JSON.stringify(await scenario(w))); const same = JSON.stringify(got) === JSON.stringify(EXPECTED[name]);
      return { holds: same, evidence: same ? `PostgreSQL == pinned results (== memory store): ${JSON.stringify(got).slice(0, 220)}` : `DIFFERENT. postgres=${JSON.stringify(got)} expected=${JSON.stringify(EXPECTED[name])}` };
    } finally { await w.close(); }
  });
}
