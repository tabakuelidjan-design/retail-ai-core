#!/usr/bin/env node
// node --env-file=.env src/marketing/index.js [--policy file] [--traffic file] [--ads file] [--search file] [--validate] [--write-flags]
// Builds the marketing measurement facts from synced orders (+ optional imported traffic / ad / search files)
// and writes reports/marketing-facts-<date>.json (gitignored). Files live in data/local/marketing/ (gitignored).
// --validate  re-reads channel/visit fields from Shopify and compares them with what is stored.
// --write-flags  persists the marketing data-quality issues as merchant-level data_quality_flags.
// Tenant (ADR 0003, step 7): NORDLA_MERCHANT_ID through the shared resolver - Shopify never says which merchant this is. The facts
// come from the data already synced into Nordla (+ the optional imported files); only --validate reads Shopify, through the tenant's
// VERIFIED shopify connector, and reports NOT_CONFIGURED / MISCONFIGURED / UNAVAILABLE explicitly instead of guessing.

import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { mergeConfig } from '../metrics/config.js';
import { buildLedger } from '../metrics/ledger.js';
import { loadDataset } from '../metrics/load.js';
import { buildWindows } from '../metrics/windows.js';
import { syncQualityFlags } from '../quality/flags.js';
import { createSupabaseClient, loadSupabaseConfigFromEnv } from '../supabase/client.js';
import { openShopifyForTenant, resolveToolTenant } from '../tenant/tool-context.js';
import { buildMarketingFacts } from './build.js';
import { normalizeAds } from './paid.js';
import { MARKETING_RULE_CODES, toQualityFlags } from './quality.js';
import { normalizeSearch } from './search.js';
import { compareOrders, validationRange } from './adapters/shopify-validation.js';
import { readCoverage } from '../sync/history.js';
import { normalizeTraffic } from './traffic.js';

const DEFAULTS = { policy: 'data/local/marketing-policy.json', traffic: 'data/local/marketing/traffic.json', ads: 'data/local/marketing/ads.json', search: 'data/local/marketing/search.json' };
const VALUE_FLAGS = ['policy', 'traffic', 'ads', 'search'];

function parseArgs(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (!argv[i].startsWith('--')) continue;
    const name = argv[i].slice(2);
    opts[name] = VALUE_FLAGS.includes(name) ? argv[++i] : true;
  }
  return opts;
}

async function optionalImport(path, normalize, label) {
  if (!path || !existsSync(path)) return null;
  const parsed = normalize(JSON.parse(await readFile(path, 'utf8')));
  const key = Object.keys(parsed).find((k) => !['errors', 'issues'].includes(k));
  if (!parsed[key]) throw new Error(`${label} file ${path} is invalid: ${parsed.errors.join('; ')}`);
  return { [key]: parsed[key], issues: parsed.issues };
}

const CHECK_QUERY = `query ($cursor: String, $q: String) { orders(first: 50, after: $cursor, sortKey: CREATED_AT, query: $q) { edges { node { id test sourceName
  channelInformation { channelDefinition { handle } } customerJourneySummary { lastVisit { source utmParameters { source medium campaign } } } } } pageInfo { hasNextPage endCursor } } }`;

async function validateAgainstShopify(shopify, supabase, merchantId, range) {
  const nodes = [];
  let cursor = null;
  for (;;) {
    const page = await shopify.graphql(CHECK_QUERY, { cursor, q: `created_at:>=${range.since}` });
    nodes.push(...page.orders.edges.map((e) => e.node));
    if (!page.orders.pageInfo.hasNextPage) break;
    cursor = page.orders.pageInfo.endCursor;
  }
  const stored = await supabase.selectAll('orders', { select: 'id,source_id,is_test,ordered_at,channel_handle', merchant_id: `eq.${merchantId}` });
  // Fixed 2026-09-22: previously fetched EVERY merchant's order_attribution rows (no merchant_id filter at
  // all) and relied only on the join below to land on the right ones - safe only by accident (order_id is a
  // globally unique UUID). Was a CRITICAL tenant-isolation finding from the RLS/merchant-isolation review.
  // Combined here with the separate date-range fix (see shopify-validation.js): both bugs lived in this same
  // function and neither fix alone was complete - the live/stored comparison must be both merchant-scoped
  // AND range-matched.
  const attribution = await supabase.selectAll('order_attribution', { select: 'order_id,touch,source,utm_source', touch: 'eq.last_visit', merchant_id: `eq.${merchantId}` });
  return compareOrders({ live: nodes, stored, attribution, range });
}

export async function runMarketingReport({ argv = [], env = process.env, supabase: injectedSupabase = null, createClient = null, now = new Date(), outDir = 'reports', log = console.log, coverage = readCoverage } = {}) {
  const opts = parseArgs(argv);
  const timeZone = env.MERCHANT_TIMEZONE || 'UTC';
  const policyPath = opts.policy ?? DEFAULTS.policy;
  const config = mergeConfig(existsSync(policyPath) ? JSON.parse(await readFile(policyPath, 'utf8')) : {});
  const supabase = injectedSupabase ?? createSupabaseClient(loadSupabaseConfigFromEnv(env));
  const tenant = await resolveToolTenant({ env, supabase, tool: 'marketing', log: (l) => log(l), createClient });
  const merchantId = tenant.merchantId;

  const windows = buildWindows(now, timeZone);
  const data = await loadDataset(supabase, merchantId, { since: windows.available_window.start });
  const ledger = buildLedger(data, { config });

  const traffic = await optionalImport(opts.traffic ?? DEFAULTS.traffic, normalizeTraffic, 'traffic');
  const ads = await optionalImport(opts.ads ?? DEFAULTS.ads, normalizeAds, 'ads');
  const search = await optionalImport(opts.search ?? DEFAULTS.search, normalizeSearch, 'search');

  const facts = buildMarketingFacts({ ledger, data, traffic, ads, search, now, timeZone, config, merchantId });
  let exitCode = 0;
  if (opts.validate) {
    const shop = await openShopifyForTenant({ env, supabase, merchantId, createClient });
    if (shop.state === 'CONFIGURED') {
      try { facts.validation = await validateAgainstShopify(shop.shopify, supabase, merchantId, validationRange({ availableStart: windows.available_window.start, coverage: await coverage() })); } catch { facts.validation = { ok: false, status: 'UNAVAILABLE' }; }
    } else facts.validation = { ok: false, status: shop.state, reason: shop.reason };
    log('validation:', JSON.stringify(facts.validation));
    if (!facts.validation.ok) exitCode = 2;
  }
  if (opts['write-flags']) {
    const summary = await syncQualityFlags({ supabase }, { merchantId, detected: toQualityFlags(facts.data_quality.issues, merchantId), now, evaluatedRules: MARKETING_RULE_CODES });
    log('marketing data-quality flags:', JSON.stringify(summary));
  }
  await mkdir(outDir, { recursive: true });
  const file = path.join(outDir, `marketing-facts-${now.toISOString().slice(0, 10)}.json`);
  await writeFile(file, JSON.stringify({ tenant: { merchant_id: merchantId }, ...facts }, null, 2));
  log(`marketing facts written to ${file} (traffic: ${traffic ? 'imported' : 'absent'}, ads: ${ads ? 'imported' : 'absent'}, search: ${search ? 'imported' : 'absent'})`);
  return { merchantId, file, facts, exitCode };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runMarketingReport({ argv: process.argv.slice(2) })
    .then((r) => { process.exitCode = r.exitCode; })
    .catch((err) => { console.error('marketing report failed:', err?.message ?? err); process.exit(1); });
}
