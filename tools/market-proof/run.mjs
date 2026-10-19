#!/usr/bin/env node
// MARKET PROOF CLI (isolated; reads/writes nothing in the sourcing app, deploys nothing).
//   node tools/market-proof/run.mjs --image photo.jpg --consent [--country BE] [--supplier-price 5 --supplier-currency USD] [--model RB-980HB] [--ean 8710...] [--query "text"]
//   node tools/market-proof/run.mjs --status        (which providers are configured; nothing is sent)
// Credentials: %USERPROFILE%\.nordla\market-proof.env (outside the repository), keys GOOGLE_VISION_API_KEY, DATAFORSEO_LOGIN, DATAFORSEO_PASSWORD, BOL_CLIENT_ID, BOL_CLIENT_SECRET.
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { loadEnv, configured, identifyPhoto, buildQueries, searchShopping, searchAmazon, bolByEan, ecbRates, compareToSupplier, summarizeMarketEvidence, dfsBalance, estimateCostUsd, spendGuard, marketplaceSplit, ENV_FILE } from './lib.mjs';
// Paid calls (DataForSEO) are limited to the free trial credit: no call without --go, a readable balance, a trial-sized balance and a worst-case estimate that fits (see spendGuard). --amazon adds the Amazon API (off by default). --max-queries N (default 2).

const args = Object.fromEntries(process.argv.slice(2).reduce((a, x, i, all) => (x.startsWith('--') ? [...a, [x.slice(2), all[i + 1] && !all[i + 1].startsWith('--') ? all[i + 1] : true]] : a), []));
const env = loadEnv(); const cfg = configured(env);
if (args.status) { console.log(JSON.stringify({ credentialsFile: ENV_FILE, configured: cfg, note: 'values are never printed' }, null, 2)); process.exit(0); }

const country = String(args.country ?? 'BE').toUpperCase(); const now = new Date();
const out = { startedAt: now.toISOString(), country, configured: cfg, input: { image: args.image ? '(file)' : null, query: args.query ?? null, ean: args.ean ?? null, model: args.model ?? null }, steps: {} };

// 1. Identification
let ident = null;
if (args.image) ident = await identifyPhoto({ imageBase64: readFileSync(String(args.image)).toString('base64'), consent: args.consent === true, env });
out.steps.identify = ident ?? { status: 'SKIPPED', note: 'no image given: the owner text / EAN is used directly' };
const maxQ = Math.max(1, Math.min(5, Number(args['max-queries']) || 2));
const queries = buildQueries(ident?.status === 'DONE' ? ident : null, { query: args.query || null, ean: args.ean || null, model: args.model || null }).slice(0, maxQ);
out.steps.queries = queries;

// Spend guard BEFORE any paid call
const wantAmazon = args.amazon === true; const textQueries = queries.filter((q) => q.strength !== 'GTIN' || !cfg.bol);
let balanceBefore = null; out.guard = { paidProviders: cfg.shopping ? ['dataforseo-google-shopping', ...(wantAmazon ? ['dataforseo-amazon'] : [])] : [], estimateUsd: null };
if (cfg.shopping && textQueries.length) {
  balanceBefore = await dfsBalance({ env }); const estimate = estimateCostUsd({ queries: textQueries, amazon: wantAmazon });
  const g = spendGuard({ go: args.go === true, balance: balanceBefore, estimate, allowFunded: args['allow-funded'] === true });
  out.guard = { ...out.guard, estimateUsd: estimate, balanceUsd: balanceBefore, ...g };
  if (!g.ok) { console.log(`PAID CALLS NOT MADE: ${g.why}\nPlan: ${textQueries.length} query(ies) ${JSON.stringify(textQueries.map((q) => q.text))} on ${country}${wantAmazon ? ' + Amazon API' : ''}; worst-case cost ~${estimate} USD; balance ${balanceBefore ?? 'unreadable'} USD.`); process.exit(g.plan ? 0 : 2); }
}

// 2. Market search
const ctx = { model: args.model || ident?.models?.[0] || null, brand: ident?.logos?.[0] || null };
const results = [];
const gtin = queries.find((q) => q.strength === 'GTIN')?.text;
if (gtin) results.push(await bolByEan({ ean: gtin, country: country === 'BE' ? 'BE' : 'NL', env }));
else results.push({ status: 'SKIPPED', provider: 'bol-marketing-catalog', evidence: [], note: 'no valid EAN found: bol is looked up by EAN only' });
results.push(queries.length ? await searchShopping({ queries, country, env, ctx }) : { status: 'SKIPPED', provider: 'dataforseo-google-shopping', evidence: [], note: 'no query could be built (no identification, no text)' });
if (wantAmazon && textQueries.length) results.push(await searchAmazon({ queries: textQueries, country, env, ctx }));
results.push({ status: 'NOT_CONFIGURED', provider: 'amazon-creators-api', evidence: [], note: 'Amazon prices need the Creators API: Associates account for the marketplace AND at least 10 qualifying sales in 30 days (official docs). Not available to this prototype.' });
out.steps.search = results.map(({ evidence, ...r }) => ({ ...r, evidenceCount: evidence.length }));
const evidence = results.flatMap((r) => r.evidence);
const balanceAfter = balanceBefore !== null && out.guard.ok ? await dfsBalance({ env }) : null;
out.spend = { reportedCostUsd: +results.reduce((s, r) => s + (r.costUsd ?? 0), 0).toFixed(4), balanceBeforeUsd: balanceBefore, balanceAfterUsd: balanceAfter, spentByBalanceUsd: balanceBefore !== null && balanceAfter !== null ? +(balanceBefore - balanceAfter).toFixed(4) : null, topUp: 'none made by this tool' };
out.marketplaces = marketplaceSplit(evidence);

// 3. Comparison (real ECB rate, nothing invented)
let ecb = null; try { ecb = await ecbRates(); } catch (e) { out.steps.ecb = { status: 'ERROR', error: String(e.message ?? e) }; }
const supplier = args['supplier-price'] ? { price: Number(args['supplier-price']), currency: String(args['supplier-currency'] ?? 'EUR').toUpperCase() } : null;
out.evidence = evidence;
out.summary = summarizeMarketEvidence([{ status: 'DONE', id: 'proof', evidence }]);
out.comparison = ecb ? compareToSupplier({ evidence, supplier, ecb }) : null;
const pick = (re) => evidence.filter((e) => re.test(`${e.seller} ${e.url}`)).length;
out.coverage = { amazonListings: pick(/amazon/i), bolListings: pick(/bol\.com|\bbol\b/i), total: evidence.length, note: evidence.length ? null : 'NO reliable result: this means "this search found nothing reliable", never "not sold in Europe"' };

const dir = join(homedir(), '.nordla', 'market-proof-out', now.toISOString().replace(/[:.]/g, '-')); mkdirSync(dir, { recursive: true });
writeFileSync(join(dir, 'report.json'), JSON.stringify(out, null, 2));
const md = [`# Market proof ${out.startedAt}`, `Market: ${country}. Providers configured: ${JSON.stringify(cfg)}.`, '', '## Identification', '```json', JSON.stringify(out.steps.identify, null, 1).slice(0, 1800), '```', '', '## Queries', ...queries.map((q) => `- ${q.text}  _(via ${q.via})_`), '', '## Providers', ...out.steps.search.map((s) => `- **${s.provider}**: ${s.status}${s.note ? ` - ${s.note}` : ''}${s.error ? ` - ERROR: ${s.error}` : ''} (${s.evidenceCount} listing(s))`), '', `## Listings (${evidence.length})`, '| match | price | seller | country | observed | link |', '|---|---|---|---|---|---|', ...evidence.map((e) => `| ${e.matchType} (${e.confidence}) | ${e.price ? `${e.price.amount} ${e.price.currency}` : 'n/a'} | ${e.seller ?? ''} | ${e.country} | ${e.observedAt.slice(0, 16)} | ${e.url} |`), '', '## Marketplaces checked separately', '```json', JSON.stringify(out.marketplaces, null, 1), '```', '', '## Spend', '```json', JSON.stringify(out.spend), '```', '', '## Comparison with the supplier', '```json', JSON.stringify(out.comparison, null, 1), '```'].join('\n');
writeFileSync(join(dir, 'report.md'), md);
console.log(md); console.log(`\nSaved: ${dir}`);
