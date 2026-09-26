#!/usr/bin/env node
// Launcher.
//   Local:  npm run analytics-premium -> http://127.0.0.1:4411 (reads reports/ produced by `npm run metrics:report`).
//   Hosted (Railway staging): node src/analytics-premium/server/serve.js with ANALYTICS_HOSTED / Railway markers - see hosting.js.
//     Requires ANALYTICS_ACCESS_TOKEN + ANALYTICS_ALLOWED_HOSTS; builds its own report from Supabase (SUPABASE_*, SHOPIFY_*).
// No synthetic data anywhere.

import http from 'node:http';
import { access } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createAnalyticsPremiumApp } from './app.js';
import { createAssistant, loadAssistantProvider } from './assistant.js';
import { HostingConfigError, createGuard, resolveHosting } from './hosting.js';
import { reportRefreshState, startSyncAwareRefresh } from './report-refresh.js';
import { createSupabaseClient, loadSupabaseConfigFromEnv } from '../../supabase/client.js';
import { latestSyncStatus } from '../../sync/run-log.js';

const REPORTS_DIR = new URL('../../../reports/', import.meta.url);

try {
  const hosting = resolveHosting(); // fails fast, before anything is served
  const guard = hosting.hosted ? createGuard({ allowedHosts: hosting.allowedHosts, token: hosting.token, trustProxyHops: hosting.trustProxyHops }) : undefined;
  // Sync health: read-only, from the sync_runs table the Core sync writes. Single-tenant staging: exactly one merchant is expected.
  let supabase = null;
  try { if (process.env.SUPABASE_URL) supabase = createSupabaseClient(loadSupabaseConfigFromEnv()); } catch { supabase = null; }
  const syncStatus = supabase ? async () => {
    const merchants = await supabase.select('merchants', { select: 'id', limit: '2' });
    if (merchants.length !== 1) return { available: false, reason: 'MERCHANT_NOT_UNIQUE' };
    return latestSyncStatus(supabase, merchants[0].id, { staleAfterMinutes: Number(process.env.SYNC_STALE_AFTER_MINUTES || 60) });
  } : undefined;
  // Assistant: figures come from the report; the AI explanation only exists when a provider adapter is configured (none is bundled today).
  const { status: providerStatus, provider } = loadAssistantProvider();
  const ask = createAssistant({ reportsDir: REPORTS_DIR, provider, providerStatus });
  let refresher = null;
  const handler = createAnalyticsPremiumApp({ reportsDir: REPORTS_DIR, guard, syncStatus, reportStatus: () => ({ ...reportRefreshState }), ask, onDatasetMissing: () => { if (refresher) refresher.tick(); } });
  http.createServer(handler).listen(hosting.port, hosting.host, () => {
    if (hosting.hosted) console.log(`Analytics Premium (hosted): listening on ${hosting.host}:${hosting.port}, serving ${hosting.allowedHosts.join(', ')} only, access token required.`);
    else console.log(`Analytics Premium (Brief) running at http://127.0.0.1:${hosting.port}`);
  });
  // The report is built FROM the synced Supabase data: regenerate when a newer successful sync exists (checked every few minutes), plus a safety-net interval.
  const datasetFile = fileURLToPath(new URL('dataset.json', REPORTS_DIR));
  if (hosting.hosted) refresher = startSyncAwareRefresh({ getSyncFinishedAt: async () => (syncStatus ? (await syncStatus())?.lastSuccess?.finishedAt ?? null : null), needsRebuild: async () => access(datasetFile).then(() => false, () => true), checkMinutes: hosting.checkMinutes, fallbackHours: hosting.refreshHours });
} catch (e) {
  console.error(e instanceof HostingConfigError ? `analytics configuration error: ${e.message}` : `analytics failed to start: ${e.message}`);
  process.exitCode = 1;
}
