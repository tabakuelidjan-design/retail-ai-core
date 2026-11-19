#!/usr/bin/env node
// Launcher.
//   Local:  npm run analytics-premium -> http://127.0.0.1:4411 (reads reports/ produced by `npm run metrics:report`).
//   Hosted (Railway staging): node src/analytics-premium/server/serve.js with ANALYTICS_HOSTED / Railway markers - see hosting.js.
//     Requires ANALYTICS_ACCESS_TOKEN + ANALYTICS_ALLOWED_HOSTS; builds its own report from Supabase (SUPABASE_*).
// Tenant (ADR 0003, step 6): NORDLA_MERCHANT_ID through the shared resolver, resolved BEFORE anything is served; refused cleanly
// otherwise. Analytics never contacts Shopify: the report is built from the data Core already synced into Nordla.
// No synthetic data anywhere.

import http from 'node:http';
import { pathToFileURL } from 'node:url';
import { createAnalyticsPremiumApp } from './app.js';
import { createAssistant, loadAssistantProvider } from './assistant.js';
import { HostingConfigError, createGuard, resolveHosting } from './hosting.js';
import { reportRefreshState, runReportOnce, startSyncAwareRefresh } from './report-refresh.js';
import { bindReportsTenant, datasetOwnedBy, resolveAnalyticsTenant, salesSourceOf } from './tenant.js';
import { createSupabaseClient, loadSupabaseConfigFromEnv } from '../../supabase/client.js';
import { createAccessChecker } from '../../identity/sso-contract.js';
import { parseSsoKey, ssoKeyReuseOf } from '../../identity/sso-keys.js';
import { latestSyncStatus } from '../../sync/run-log.js';
import { releaseOf } from '../../identity/release.js';
import { createTenantReader } from './pg-tenant-reader.js';
import { createAccessClientFromEnv } from './pg-access-client.js';
import { createAnalyticsPool, createPgSelect, routedSupabase } from './pg-table-select.js';

const REPORTS_DIR = new URL('../../../reports/', import.meta.url);

/**
 * Starts Analytics for ONE tenant. Everything external is injectable (tests).
 * @returns {Promise<{ server: http.Server, tenant: object, refresher: object|null }>}
 */
export async function startAnalyticsServer({ env = process.env, supabase: injectedSupabase, reportsDir = REPORTS_DIR, log = console.log, runReport = null, createClient = null } = {}) {
  const hosting = resolveHosting(env); // fails fast, before anything is served
  let guard; // built after the tenant is known (the single-sign-on ticket is bound to this merchant)

  // The tenant, before anything is served. Supabase holds the synced data Analytics reads - it is required.
  const supabase = injectedSupabase ?? createSupabaseClient(loadSupabaseConfigFromEnv(env));
  // Pilot (ANALYTICS_DATABASE_URL set): merchants, merchant_connectors and sync_runs are read through the Postgres reader, with no
  // fallback to the service key for those three tables. Unset: the existing Supabase path is unchanged.
  const pool = await createAnalyticsPool(env);
  const reads = pool ? routedSupabase(supabase, createPgSelect(createTenantReader({ pool }))) : supabase;
  const tenant = await resolveAnalyticsTenant({ env, supabase: reads, log, createClient });
  const merchantId = tenant.merchantId;
  // Single sign-on key (optional): ANALYTICS_SSO_KEY = canonical base64url of 32 random bytes, never the access token. Missing, malformed or reused: SSO stays off.
  const ssoKey = parseSsoKey(env.ANALYTICS_SSO_KEY); const ssoReuse = ssoKey.ok ? ssoKeyReuseOf(env.ANALYTICS_SSO_KEY, { dashboardToken: hosting.token }) : null;
  // The SSO access check: on the least-privilege access role when ANALYTICS_ACCESS_DATABASE_URL is set (no service key), else unchanged.
  const accessDb = await createAccessClientFromEnv(env);
  guard = hosting.hosted ? createGuard({ allowedHosts: hosting.allowedHosts, token: hosting.token, trustProxyHops: hosting.trustProxyHops, ssoOnly: env.NORDLA_SSO_ONLY === '1', sso: ssoKey.ok && !ssoReuse ? { secret: env.ANALYTICS_SSO_KEY, merchantId, requirePerson: true, checkAccess: createAccessChecker({ supabase: accessDb ?? supabase, merchantId }) } : null }) : undefined;
  bindReportsTenant(reportsDir, merchantId); // from now on, only this tenant's report files are served from reportsDir

  // Sync health of THIS merchant only (sync_runs written by Core). No sales connector at all -> a neutral state, not a failure.
  const syncStatus = async () => ((await salesSourceOf(reads, merchantId)) === 'NONE'
    ? { available: false, reason: 'NO_SALES_SOURCE' }
    : latestSyncStatus(reads, merchantId,{ staleAfterMinutes: Number(env.SYNC_STALE_AFTER_MINUTES || 60) }));

  // Assistant: figures come from the report; the AI explanation only exists when a provider adapter is configured (none is bundled today).
  const { status: providerStatus, provider } = loadAssistantProvider(env);
  const ask = createAssistant({ reportsDir, provider, providerStatus });
  let refresher = null;
  const handler = createAnalyticsPremiumApp({ release: releaseOf(env), reportsDir, guard, syncStatus, reportStatus: () => ({ ...reportRefreshState }), ask, onDatasetMissing: () => { if (refresher) refresher.tick(); } });
  const server = http.createServer(handler);
  if (pool) server.on('close', () => { pool.end().catch(() => {}); });
  await new Promise((resolve) => server.listen(hosting.port, hosting.host, resolve));
  if (hosting.hosted) log(`Analytics Premium (hosted): listening on ${hosting.host}:${hosting.port}, serving ${hosting.allowedHosts.join(', ')} only, access token required.`);
  else log(`Analytics Premium (Brief) running at http://127.0.0.1:${hosting.port}`);

  // The report is built FROM the synced Supabase data, for this tenant: regenerated when a newer successful sync exists, when the dataset
  // snapshot is missing or belongs to another tenant, and on a safety-net interval.
  if (hosting.hosted) {
    refresher = startSyncAwareRefresh({
      getSyncFinishedAt: async () => (await syncStatus())?.lastSuccess?.finishedAt ?? null,
      needsRebuild: async () => !(await datasetOwnedBy(reportsDir, merchantId)),
      run: runReport ?? (() => runReportOnce({ env, log })),
      checkMinutes: hosting.checkMinutes, fallbackHours: hosting.refreshHours,
    });
  }
  return { server, tenant, refresher };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { await startAnalyticsServer(); } catch (e) {
    console.error(e instanceof HostingConfigError ? `analytics configuration error: ${e.message}` : `analytics failed to start: ${e.message}`);
    process.exitCode = 1;
  }
}
