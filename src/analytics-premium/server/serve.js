#!/usr/bin/env node
// Launcher.
//   Local:  npm run analytics-premium -> http://127.0.0.1:4411 (reads reports/ produced by `npm run metrics:report`).
//   Hosted (Railway staging): node src/analytics-premium/server/serve.js with ANALYTICS_HOSTED / Railway markers - see hosting.js.
//     Requires ANALYTICS_ACCESS_TOKEN + ANALYTICS_ALLOWED_HOSTS; builds its own report from Supabase (SUPABASE_*, SHOPIFY_*).
// No synthetic data anywhere.

import http from 'node:http';
import { createAnalyticsPremiumApp } from './app.js';
import { HostingConfigError, createGuard, resolveHosting } from './hosting.js';
import { startReportRefresh } from './report-refresh.js';

const REPORTS_DIR = new URL('../../../reports/', import.meta.url);

try {
  const hosting = resolveHosting(); // fails fast, before anything is served
  const guard = hosting.hosted ? createGuard({ allowedHosts: hosting.allowedHosts, token: hosting.token, trustProxyHops: hosting.trustProxyHops }) : undefined;
  const handler = createAnalyticsPremiumApp({ reportsDir: REPORTS_DIR, guard });
  http.createServer(handler).listen(hosting.port, hosting.host, () => {
    if (hosting.hosted) console.log(`Analytics Premium (hosted): listening on ${hosting.host}:${hosting.port}, serving ${hosting.allowedHosts.join(', ')} only, access token required.`);
    else console.log(`Analytics Premium (Brief) running at http://127.0.0.1:${hosting.port}`);
  });
  if (hosting.hosted) startReportRefresh({ hours: hosting.refreshHours });
} catch (e) {
  console.error(e instanceof HostingConfigError ? `analytics configuration error: ${e.message}` : `analytics failed to start: ${e.message}`);
  process.exitCode = 1;
}
