#!/usr/bin/env node
// Entry point: `node src/sync/index.js <catalog|inventory|cost|orders|all>`
// No Claude/MCP dependency - reads config from env vars only. See
// .env.example and docs/security/shopify-auth.md before running for real.
//
// Identity (ADR 0003, step 5): NORDLA_MERCHANT_ID -> tenant resolver -> merchant -> its `shopify` connector (merchant_connectors) ->
// the shop behind the credentials must be that connector's shop -> sync, every write through the tenant write guard. Shopify never
// says "who am I": no merchant is created, looked up by shop or re-assigned here.
//   - tenant unknown / invalid        -> refused before any write (exit 1)
//   - no Shopify credentials          -> the Shopify job is skipped (NOT_CONFIGURED, exit 0, nothing written)
//   - MISCONFIGURED / UNAVAILABLE     -> no data write; a FAILED sync_runs row for the tenant (exit 1); the next cycle retries

import { pathToFileURL } from 'node:url';
import { createSupabaseClient, loadSupabaseConfigFromEnv } from '../supabase/client.js';
import { syncCatalog } from './catalog.js';
import { syncInventory } from './inventory.js';
import { syncProductCosts } from './cost.js';
import { syncOrders } from './orders.js';
import { loadCustomerKeySecret } from '../customers/pseudonym.js';
import { loadShopifyConfigFromEnv } from '../shopify/client.js';
import { SHOP_CREATED_QUERY } from '../shopify/queries.js';
import { getGrantedScopes, nextCoverage, planOrdersSync, readCoverage, writeCoverage } from './history.js';
import { finishRun, recordStartupFailure, startRun } from './run-log.js';
import { resolveSyncTenant, prepareShopifySync, SyncConnectorError } from './tenant-context.js';
import { guardSyncWrites } from './write-guard.js';

export const MODES = ['catalog', 'inventory', 'cost', 'orders', 'all'];

/**
 * One sync run. Everything external is injectable (tests); the CLI below passes the real environment.
 * Returns { status: 'SUCCESS' | 'FAILED' | 'SKIPPED' | 'REFUSED', exitCode, merchantId, runId, state?, reason? }.
 */
export async function runSync({
  mode, args = [], env = process.env, supabase: injectedSupabase, createClient, log = console.log, logError = console.error,
  now = () => new Date(), customerKeySecret = () => loadCustomerKeySecret(), coverage = { read: readCoverage, write: writeCoverage },
  grantedScopes = () => getGrantedScopes(loadShopifyConfigFromEnv(env)),
} = {}) {
  if (!MODES.includes(mode)) { logError(`Usage: node src/sync/index.js <${MODES.join('|')}>`); return { status: 'REFUSED', exitCode: 1, reason: 'BAD_MODE' }; }
  const supabase = injectedSupabase ?? createSupabaseClient(loadSupabaseConfigFromEnv(env));
  const clientOpt = createClient ? { createClient } : {};

  // Run log (table sync_runs): best effort, never fails a sync. A failed run erases nothing (the sync only upserts) and is recorded FAILED
  // so Analytics and Finance can show the data as stale instead of pretending it is current.
  const run = { db: null, id: null, summaries: {}, ok: true, merchantId: null };
  const record = (name, summary) => { run.summaries[name] = summary; if (summary.errors.length > 0) run.ok = false; };

  try {
    // 1. the tenant - before anything else, never from Shopify
    const tenant = await resolveSyncTenant({ env, supabase, log, ...clientOpt });
    run.merchantId = tenant.merchantId;

    // 2. the tenant's Shopify connector, validated against the shop behind the credentials
    const prep = await prepareShopifySync({ env, supabase, tenant, ...clientOpt });
    if (prep.state === 'NOT_CONFIGURED') {
      log(`shopify sync skipped: NOT_CONFIGURED (${prep.reason}) - nothing written`);
      return { status: 'SKIPPED', exitCode: 0, merchantId: tenant.merchantId, runId: null, state: prep.state, reason: prep.reason };
    }
    if (prep.state !== 'CONFIGURED') throw new SyncConnectorError(prep.state, prep.reason, { merchantId: tenant.merchantId });

    // 3. every write from here on goes through the tenant guard
    const db = guardSyncWrites(supabase, prep.context);
    const { shopify } = prep;
    const merchantId = prep.context.merchantId;
    run.db = db;
    run.id = await startRun(db, { merchantId, mode, now: now() });

    if (mode === 'catalog' || mode === 'all') {
      const summary = await syncCatalog({ shopify, supabase: db }, { merchantId });
      log('catalog sync summary:', JSON.stringify(summary, null, 2));
      record('catalog', summary);
    }

    if (mode === 'inventory' || mode === 'all') {
      // Merchant-local timezone for the one-snapshot-per-day rule. This is
      // merchant config, not architecture - HABB's value goes in .env, never
      // hardcoded here. Defaults to UTC for any merchant that hasn't set one.
      const timeZone = env.MERCHANT_TIMEZONE || 'UTC';
      const summary = await syncInventory({ shopify, supabase: db }, { merchantId, timeZone });
      log('inventory sync summary:', JSON.stringify(summary, null, 2));
      record('inventory', summary);
    }

    if (mode === 'cost' || mode === 'all') {
      const summary = await syncProductCosts({ shopify, supabase: db }, { merchantId });
      log('cost sync summary:', JSON.stringify(summary, null, 2));
      record('cost', summary);
    }

    if (mode === 'orders' || mode === 'all') {
      // --since YYYY-MM-DD, or --full-history (= since the store was created): needs the read_all_orders scope on the live token.
      // SYNC_ORDERS_SINCE_DAYS: a longer refresh window than the default 60 days (refunds on older orders); it needs the read_all_orders scope.
      const envSinceDays = Number(env.SYNC_ORDERS_SINCE_DAYS);
      const sinceIdx = args.indexOf('--since');
      let since = sinceIdx > -1 ? args[sinceIdx + 1] : (Number.isInteger(envSinceDays) && envSinceDays > 0 ? new Date(now().getTime() - envSinceDays * 86_400_000).toISOString().slice(0, 10) : null);
      let storeCreatedOn = null;
      if (args.includes('--full-history') || since) {
        storeCreatedOn = (await shopify.graphql(SHOP_CREATED_QUERY)).shop.createdAt.slice(0, 10);
        if (args.includes('--full-history')) since = storeCreatedOn;
      }
      const plan = planOrdersSync({ since, grantedScopes: since ? await grantedScopes() : [] });
      if (!plan.ok) throw Object.assign(new Error(JSON.stringify(plan)), { planRefused: true });
      const summary = await syncOrders({ shopify, supabase: db }, { merchantId, customerKeySecret: customerKeySecret(), since });
      log('orders sync summary:', JSON.stringify(summary, null, 2));
      record('orders', summary);
      if (summary.errors.length === 0) await coverage.write(nextCoverage(await coverage.read(), { plan, now: now(), storeCreatedOn }));
    }

    await finishRun(db, run.id, { ok: run.ok, summaries: run.summaries, error: run.ok ? null : 'the sync reported errors', now: now() });
    return { status: run.ok ? 'SUCCESS' : 'FAILED', exitCode: run.ok ? 0 : 1, merchantId, runId: run.id };
  } catch (err) {
    logError('sync failed:', err?.message ?? err);
    const error = err instanceof SyncConnectorError ? `${err.state}: ${err.reason}` : err?.message;
    if (run.id) await finishRun(run.db, run.id, { ok: false, summaries: run.summaries, error, now: now() });
    else if (run.merchantId) {
      // Known tenant, nothing written yet (connector MISCONFIGURED / UNAVAILABLE, credentials refused): a FAILED trace for THIS tenant only.
      await recordStartupFailure(guardSyncWrites(supabase, { merchantId: run.merchantId }), { merchantId: run.merchantId, mode, error, now: now() });
    }
    // Unknown tenant: nothing is written anywhere.
    return { status: run.merchantId ? 'FAILED' : 'REFUSED', exitCode: 1, merchantId: run.merchantId, runId: run.id, state: err?.state ?? err?.code ?? null, reason: err?.reason ?? null };
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = await runSync({ mode: process.argv[2], args: process.argv.slice(3) });
  process.exit(result.exitCode);
}
