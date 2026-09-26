#!/usr/bin/env node
// `node --env-file=.env src/report/index.js <report|flags|validate|all>`
// Reads synced data from Supabase (and, for `validate`, Shopify - read-only).
// Writes reports to ./reports/ (gitignored: real merchant numbers never get committed).
// No LLM anywhere: every figure comes from the deterministic modules.

import { mkdir, rename, writeFile } from 'node:fs/promises';
import { createShopifyClient, loadShopifyConfigFromEnv } from '../shopify/client.js';
import { SHOP_QUERY } from '../shopify/queries.js';
import { createSupabaseClient, loadSupabaseConfigFromEnv } from '../supabase/client.js';
import { mergeConfig } from '../metrics/config.js';
import { buildLedger } from '../metrics/ledger.js';
import { loadDataset } from '../metrics/load.js';
import { validateAgainstShopify } from '../metrics/validate.js';
import { buildWindows, inWindow } from '../metrics/windows.js';
import { buildDemandFacts } from '../demand/build.js';
import { fetchPaymentTransactions, summarizePaymentFees } from '../analysis/payment-fees.js';
import { buildCostTriage, buildLargestStockPositions, buildProfitUncertainty } from '../analysis/triage.js';
import { detectQualityFlags } from '../quality/rules.js';
import { syncQualityFlags } from '../quality/flags.js';
import { buildReport } from './build.js';
import { renderMarkdown } from './render.js';

const MODES = ['report', 'flags', 'validate', 'triage', 'demand', 'all'];

async function main() {
  const mode = process.argv[2];
  if (!MODES.includes(mode)) {
    console.error(`Usage: node src/report/index.js <${MODES.join('|')}>`);
    process.exit(1);
  }

  const now = new Date();
  const timeZone = process.env.MERCHANT_TIMEZONE || 'UTC';
  const config = mergeConfig();
  const shopify = createShopifyClient(loadShopifyConfigFromEnv());
  const supabase = createSupabaseClient(loadSupabaseConfigFromEnv());

  const { shop } = await shopify.graphql(SHOP_QUERY);
  const [merchant] = await supabase.select('merchants', { select: 'id', source_system: 'eq.shopify', source_id: `eq.${shop.id}` });
  if (!merchant) throw new Error('No merchant found - run the sync first.');

  const windows = buildWindows(now, timeZone);
  const data = await loadDataset(supabase, merchant.id, { since: windows.available_window.start });
  const ledger = buildLedger(data, { config });
  const extras = {};

  if (mode === 'flags' || mode === 'all') {
    const detected = detectQualityFlags(data, ledger, { merchantId: merchant.id, now, config });
    extras.quality = await syncQualityFlags({ supabase }, { merchantId: merchant.id, detected, now });
    console.log('data quality flags:', JSON.stringify(extras.quality, null, 2));
  }

  if (mode === 'validate' || mode === 'all') {
    extras.validation = await validateAgainstShopify({ shopify, ledger, windows });
    console.table(extras.validation);
    if (extras.validation.some((v) => !v.ok)) process.exitCode = 2;
  }

  if (mode === 'demand') {
    // Provenance must be real: reconcile sales with the source before labelling them.
    const validation = await validateAgainstShopify({ shopify, ledger, windows });
    const salesReconciled = validation.every((v) => v.ok);
    const facts = buildDemandFacts({ ledger, data, now, timeZone, config, salesReconciled });
    facts.input_status.sales_reconciliation = { checked_at: now.toISOString(), comparisons: validation.length, all_match: salesReconciled };
    await mkdir('reports', { recursive: true });
    const stamp = now.toISOString().slice(0, 10);
    await writeFile(`reports/demand-facts-${stamp}.json`, JSON.stringify(facts, null, 2));
    console.log(`demand facts written to reports/demand-facts-${stamp}.json (sales reconciled: ${salesReconciled})`);
  }

  if (mode === 'triage') {
    const w = windows.available_window;
    const transactions = (await fetchPaymentTransactions(shopify, w.start)).filter((o) => inWindow(o.createdAt, w));
    const triage = {
      generated_at: now.toISOString(),
      cost_triage: buildCostTriage(ledger, w, now),
      profit_uncertainty: buildProfitUncertainty(ledger, w),
      largest_stock_positions: buildLargestStockPositions(ledger, now, config),
      payment_fees: summarizePaymentFees(transactions),
    };
    await mkdir('reports', { recursive: true });
    const stamp = now.toISOString().slice(0, 10);
    await writeFile(`reports/triage-${stamp}.json`, JSON.stringify(triage, null, 2));
    console.log(`triage written to reports/triage-${stamp}.json`);
  }

  if (mode === 'report' || mode === 'all') {
    const { report } = buildReport({ ledger, now, timeZone, config, data });
    await mkdir('reports', { recursive: true });
    const stamp = now.toISOString().slice(0, 10);
    await writeFile(`reports/report-${stamp}.json`, JSON.stringify(report, null, 2));
    // Dataset snapshot for the Analytics period selector: the period engine rebuilds any period from the SAME rows with the SAME deterministic functions.
    // Full history (not just the report's 60 days), written atomically so a reader never sees a half-written file.
    const fullSince = new Date(now.getTime() - 1100 * 24 * 60 * 60 * 1000);
    const full = await loadDataset(supabase, merchant.id, { since: fullSince });
    const snapshot = { version: 1, generated_at: now.toISOString(), time_zone: timeZone, currency: ledger.currency, data: full };
    await writeFile('reports/dataset.json.tmp', JSON.stringify(snapshot));
    await rename('reports/dataset.json.tmp', 'reports/dataset.json');
    console.log(`dataset snapshot written to reports/dataset.json (${full.orders.length} orders)`);
    await writeFile(`reports/report-${stamp}.md`, renderMarkdown(report, extras));
    console.log(`report written to reports/report-${stamp}.{json,md}`);
  }
}

main().catch((err) => {
  console.error('report failed:', err);
  process.exit(1);
});
