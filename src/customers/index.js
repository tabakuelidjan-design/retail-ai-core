#!/usr/bin/env node
// node --env-file=.env src/customers/index.js [--policy file]
// Writes reports/customer-facts-<date>.json (gitignored). Order-level, pseudonymous; no customer identity is read.
// Tenant (ADR 0003, step 7): NORDLA_MERCHANT_ID through the shared resolver. The facts come only from the data already synced into
// Nordla: this command never contacts Shopify. The output file is stamped with the tenant it was built for.

import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { mergeConfig } from '../metrics/config.js';
import { buildLedger } from '../metrics/ledger.js';
import { loadDataset } from '../metrics/load.js';
import { buildWindows } from '../metrics/windows.js';
import { createSupabaseClient, loadSupabaseConfigFromEnv } from '../supabase/client.js';
import { resolveToolTenant } from '../tenant/tool-context.js';
import { buildCustomerFacts } from './facts.js';

export async function runCustomerFacts({ argv = [], env = process.env, supabase: injectedSupabase = null, now = new Date(), outDir = 'reports', log = console.log, createClient = null } = {}) {
  const timeZone = env.MERCHANT_TIMEZONE || 'UTC';
  const i = argv.indexOf('--policy');
  const policyPath = i > -1 ? argv[i + 1] : 'data/local/marketing-policy.json';
  const config = mergeConfig(existsSync(policyPath) ? JSON.parse(await readFile(policyPath, 'utf8')) : {});
  const supabase = injectedSupabase ?? createSupabaseClient(loadSupabaseConfigFromEnv(env));
  const tenant = await resolveToolTenant({ env, supabase, tool: 'customers', log: (l) => log(l), createClient });
  const windows = buildWindows(now, timeZone);
  const data = await loadDataset(supabase, tenant.merchantId, { since: windows.available_window.start });
  const facts = buildCustomerFacts({ ledger: buildLedger(data, { config }), data, now, config });
  await mkdir(outDir, { recursive: true });
  const file = path.join(outDir, `customer-facts-${now.toISOString().slice(0, 10)}.json`);
  await writeFile(file, JSON.stringify({ tenant: { merchant_id: tenant.merchantId }, ...facts }, null, 2));
  log(`customer facts written to ${file}`);
  return { merchantId: tenant.merchantId, file, facts };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runCustomerFacts({ argv: process.argv.slice(2) }).catch((e) => { console.error('customer facts failed:', e.message); process.exitCode = 1; });
}
