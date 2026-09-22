#!/usr/bin/env node
// node --env-file=.env src/marketing/index.js [--policy file] [--traffic file] [--ads file] [--search file] [--validate] [--write-flags]
// Builds the marketing measurement facts from synced orders (+ optional imported traffic / ad / search files)
// and writes reports/marketing-facts-<date>.json (gitignored). Files live in data/local/marketing/ (gitignored).
// --validate  re-reads channel/visit fields from Shopify and compares them with what is stored.
// --write-flags  persists the marketing data-quality issues as merchant-level data_quality_flags.

import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { mergeConfig } from '../metrics/config.js';
import { buildLedger } from '../metrics/ledger.js';
import { loadDataset } from '../metrics/load.js';
import { buildWindows } from '../metrics/windows.js';
import { syncQualityFlags } from '../quality/flags.js';
import { createShopifyClient, loadShopifyConfigFromEnv } from '../shopify/client.js';
import { SHOP_QUERY } from '../shopify/queries.js';
import { createSupabaseClient, loadSupabaseConfigFromEnv } from '../supabase/client.js';
import { buildMarketingFacts } from './build.js';
import { normalizeAds } from './paid.js';
import { MARKETING_RULE_CODES, toQualityFlags } from './quality.js';
import { normalizeSearch } from './search.js';
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

async function validateAgainstShopify(shopify, supabase, merchantId, since) {
  const nodes = [];
  let cursor = null;
  for (;;) {
    const page = await shopify.graphql(CHECK_QUERY, { cursor, q: `created_at:>=${since.toISOString().slice(0, 10)}` });
    nodes.push(...page.orders.edges.map((e) => e.node));
    if (!page.orders.pageInfo.hasNextPage) break;
    cursor = page.orders.pageInfo.endCursor;
  }
  const live = nodes.filter((n) => !n.test);
  const stored = await supabase.selectAll('orders', { select: 'id,source_id,is_test,channel_handle', merchant_id: `eq.${merchantId}` });
  // Fixed 2026-09-22: previously fetched EVERY merchant's order_attribution rows (no merchant_id filter at
  // all) and relied only on the join below to land on the right ones - safe only by accident (order_id is a
  // globally unique UUID). Was a CRITICAL tenant-isolation finding from the RLS/merchant-isolation review.
  const attribution = await supabase.selectAll('order_attribution', { select: 'order_id,touch,source,utm_source', touch: 'eq.last_visit', merchant_id: `eq.${merchantId}` });
  const byOrder = new Map(stored.map((o) => [o.source_id, o]));
  const attrByOrderId = new Map(attribution.map((a) => [a.order_id, a]));
  let channelMismatch = 0;
  let visitMismatch = 0;
  for (const n of live) {
    const s = byOrder.get(n.id);
    if (!s) continue;
    if ((n.channelInformation?.channelDefinition?.handle ?? null) !== s.channel_handle) channelMismatch += 1;
    const liveSource = n.customerJourneySummary?.lastVisit?.source ?? null;
    const storedSource = attrByOrderId.get(s.id)?.source ?? null;
    if (liveSource !== storedSource) visitMismatch += 1;
  }
  return { shopify_orders: live.length, stored_orders: stored.filter((o) => !o.is_test).length, channel_mismatches: channelMismatch, last_visit_source_mismatches: visitMismatch, ok: live.length === stored.filter((o) => !o.is_test).length && channelMismatch === 0 && visitMismatch === 0 };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const now = new Date();
  const timeZone = process.env.MERCHANT_TIMEZONE || 'UTC';
  const policyPath = opts.policy ?? DEFAULTS.policy;
  const config = mergeConfig(existsSync(policyPath) ? JSON.parse(await readFile(policyPath, 'utf8')) : {});
  const shopify = createShopifyClient(loadShopifyConfigFromEnv());
  const supabase = createSupabaseClient(loadSupabaseConfigFromEnv());

  const { shop } = await shopify.graphql(SHOP_QUERY);
  const [merchant] = await supabase.select('merchants', { select: 'id', source_system: 'eq.shopify', source_id: `eq.${shop.id}` });
  if (!merchant) throw new Error('No merchant found - run the sync first.');

  const windows = buildWindows(now, timeZone);
  const data = await loadDataset(supabase, merchant.id, { since: windows.available_window.start });
  const ledger = buildLedger(data, { config });

  const traffic = await optionalImport(opts.traffic ?? DEFAULTS.traffic, normalizeTraffic, 'traffic');
  const ads = await optionalImport(opts.ads ?? DEFAULTS.ads, normalizeAds, 'ads');
  const search = await optionalImport(opts.search ?? DEFAULTS.search, normalizeSearch, 'search');

  const facts = buildMarketingFacts({ ledger, data, traffic, ads, search, now, timeZone, config, merchantId: merchant.id });
  if (opts.validate) {
    facts.validation = await validateAgainstShopify(shopify, supabase, merchant.id, windows.available_window.start);
    console.log('validation:', JSON.stringify(facts.validation));
    if (!facts.validation.ok) process.exitCode = 2;
  }
  if (opts['write-flags']) {
    const summary = await syncQualityFlags({ supabase }, { merchantId: merchant.id, detected: toQualityFlags(facts.data_quality.issues, merchant.id), now, evaluatedRules: MARKETING_RULE_CODES });
    console.log('marketing data-quality flags:', JSON.stringify(summary));
  }
  await mkdir('reports', { recursive: true });
  const stamp = now.toISOString().slice(0, 10);
  await writeFile(`reports/marketing-facts-${stamp}.json`, JSON.stringify(facts, null, 2));
  console.log(`marketing facts written to reports/marketing-facts-${stamp}.json (traffic: ${traffic ? 'imported' : 'absent'}, ads: ${ads ? 'imported' : 'absent'}, search: ${search ? 'imported' : 'absent'})`);
}

main().catch((err) => {
  console.error('marketing report failed:', err);
  process.exit(1);
});
