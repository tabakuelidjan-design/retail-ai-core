#!/usr/bin/env node
// `node --env-file=.env src/report/index.js <report|flags|validate|triage|demand|all>`
// Reads synced data from Supabase for ONE tenant: NORDLA_MERCHANT_ID through the shared resolver (ADR 0003, step 6) - never Shopify,
// never "the only merchant". `report` and `flags` never contact Shopify. Only `validate`, `demand` and `triage` compare against Shopify
// (read-only): they need its credentials and say so explicitly when they are missing.
// Writes reports to ./reports/ (gitignored: real merchant numbers never get committed); every report / dataset file is stamped with the
// tenant it was built for, so Analytics never serves another merchant's file.
// No LLM anywhere: every figure comes from the deterministic modules.

import { mkdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createSupabaseClient, loadSupabaseConfigFromEnv } from '../supabase/client.js';
import { mergeConfig } from '../metrics/config.js';
import { buildLedger } from '../metrics/ledger.js';
import { loadDataset } from '../metrics/load.js';
import { buildWindows, inWindow } from '../metrics/windows.js';
import { buildDemandFacts } from '../demand/build.js';
import { buildCostTriage, buildLargestStockPositions, buildProfitUncertainty } from '../analysis/triage.js';
import { detectQualityFlags } from '../quality/rules.js';
import { syncQualityFlags } from '../quality/flags.js';
import { resolveAnalyticsTenant, tenantStamp } from '../analytics-premium/server/tenant.js';
import { buildReport } from './build.js';
import { renderMarkdown } from './render.js';

export const MODES = ['report', 'flags', 'validate', 'triage', 'demand', 'all'];
const SHOPIFY_MODES = ['validate', 'triage', 'demand', 'all'];

/** The Shopify client for the modes that compare with Shopify - built lazily, only for them. */
async function shopifyFor(mode, env, createClient) {
  const { hasShopifyCredentials } = await import('../connectors/shopify.js');
  if (!hasShopifyCredentials(env)) throw Object.assign(new Error(`mode "${mode}" compares with Shopify and needs its credentials (Shopify is NOT_CONFIGURED); "report" and "flags" work without Shopify`), { code: 'SHOPIFY_NOT_CONFIGURED' });
  const client = await import('../shopify/client.js');
  return (createClient ?? client.createShopifyClient)(client.loadShopifyConfigFromEnv(env));
}

/**
 * @returns {Promise<{ merchantId: string, written: string[] }>}
 */
export async function runReport({ mode, env = process.env, supabase: injectedSupabase, now = new Date(), outDir = 'reports', log = console.log, createClient = null } = {}) {
  if (!MODES.includes(mode)) throw Object.assign(new Error(`Usage: node src/report/index.js <${MODES.join('|')}>`), { code: 'BAD_MODE' });

  const timeZone = env.MERCHANT_TIMEZONE || 'UTC';
  const config = mergeConfig();
  const supabase = injectedSupabase ?? createSupabaseClient(loadSupabaseConfigFromEnv(env));
  const tenant = await resolveAnalyticsTenant({ env, supabase, log: (l) => log(l), createClient });
  const merchantId = tenant.merchantId;
  const stamp = tenantStamp(merchantId);
  const shopify = SHOPIFY_MODES.includes(mode) && mode !== 'all' ? await shopifyFor(mode, env, createClient) : null;
  const written = [];
  const out = (name) => path.join(outDir, name);

  const windows = buildWindows(now, timeZone);
  const data = await loadDataset(supabase, merchantId, { since: windows.available_window.start });
  const ledger = buildLedger(data, { config });
  const extras = {};

  if (mode === 'flags' || mode === 'all') {
    const detected = detectQualityFlags(data, ledger, { merchantId, now, config });
    extras.quality = await syncQualityFlags({ supabase }, { merchantId, detected, now });
    log('data quality flags:', JSON.stringify(extras.quality, null, 2));
  }

  // `all`: the Shopify comparison is attempted only when Shopify is configured; without it the report is still built from Nordla's data.
  const allShopify = mode === 'all' ? await shopifyFor(mode, env, createClient).catch((e) => { log(`validation skipped: ${e.message}`); return null; }) : null;
  if (mode === 'validate' || (mode === 'all' && allShopify)) {
    const { validateAgainstShopify } = await import('../metrics/validate.js');
    extras.validation = await validateAgainstShopify({ shopify: shopify ?? allShopify, ledger, windows });
    console.table(extras.validation);
    if (extras.validation.some((v) => !v.ok)) process.exitCode = 2;
  }

  if (mode === 'demand') {
    // Provenance must be real: reconcile sales with the source before labelling them.
    const { validateAgainstShopify } = await import('../metrics/validate.js');
    const validation = await validateAgainstShopify({ shopify, ledger, windows });
    const salesReconciled = validation.every((v) => v.ok);
    const facts = buildDemandFacts({ ledger, data, now, timeZone, config, salesReconciled });
    facts.input_status.sales_reconciliation = { checked_at: now.toISOString(), comparisons: validation.length, all_match: salesReconciled };
    await mkdir(outDir, { recursive: true });
    const day = now.toISOString().slice(0, 10);
    await writeFile(out(`demand-facts-${day}.json`), JSON.stringify({ tenant: stamp, ...facts }, null, 2)); written.push(`demand-facts-${day}.json`);
    log(`demand facts written to ${out(`demand-facts-${day}.json`)} (sales reconciled: ${salesReconciled})`);
  }

  if (mode === 'triage') {
    const { fetchPaymentTransactions, summarizePaymentFees } = await import('../analysis/payment-fees.js');
    const w = windows.available_window;
    const transactions = (await fetchPaymentTransactions(shopify, w.start)).filter((o) => inWindow(o.createdAt, w));
    const triage = {
      tenant: stamp,
      generated_at: now.toISOString(),
      cost_triage: buildCostTriage(ledger, w, now),
      profit_uncertainty: buildProfitUncertainty(ledger, w),
      largest_stock_positions: buildLargestStockPositions(ledger, now, config),
      payment_fees: summarizePaymentFees(transactions),
    };
    await mkdir(outDir, { recursive: true });
    const day = now.toISOString().slice(0, 10);
    await writeFile(out(`triage-${day}.json`), JSON.stringify(triage, null, 2)); written.push(`triage-${day}.json`);
    log(`triage written to ${out(`triage-${day}.json`)}`);
  }

  if (mode === 'report' || mode === 'all') {
    const { report } = buildReport({ ledger, now, timeZone, config, data });
    await mkdir(outDir, { recursive: true });
    const day = now.toISOString().slice(0, 10);
    await writeFile(out(`report-${day}.json`), JSON.stringify({ tenant: stamp, ...report }, null, 2)); written.push(`report-${day}.json`);
    // Dataset snapshot for the Analytics period selector: the period engine rebuilds any period from the SAME rows with the SAME deterministic functions.
    // Full history (not just the report's 60 days), written atomically so a reader never sees a half-written file. The tenant stamp comes FIRST
    // (right after the version) so the refresher can check ownership from the head of the file only.
    const fullSince = new Date(now.getTime() - 1100 * 24 * 60 * 60 * 1000);
    const full = await loadDataset(supabase, merchantId, { since: fullSince });
    const snapshot = { version: 1, tenant: stamp, generated_at: now.toISOString(), time_zone: timeZone, currency: ledger.currency, data: full };
    await writeFile(out('dataset.json.tmp'), JSON.stringify(snapshot));
    await rename(out('dataset.json.tmp'), out('dataset.json')); written.push('dataset.json');
    log(`dataset snapshot written to ${out('dataset.json')} (${full.orders.length} orders)`);
    await writeFile(out(`report-${day}.md`), renderMarkdown(report, extras)); written.push(`report-${day}.md`);
    log(`report written to ${out(`report-${day}`)}.{json,md}`);
  }
  return { merchantId, written };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { await runReport({ mode: process.argv[2] }); } catch (err) {
    console.error('report failed:', err?.message ?? err);
    process.exit(1);
  }
}
