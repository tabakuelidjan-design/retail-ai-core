#!/usr/bin/env node
// Local preview launcher: npm run analytics-premium -> http://127.0.0.1:4411
// Reads real report snapshots from reports/ (produced by `npm run metrics:report`) - no synthetic data.

import http from 'node:http';
import { createAnalyticsPremiumApp } from './app.js';

const PORT = Number(process.env.ANALYTICS_PREMIUM_PORT || 4411);
const REPORTS_DIR = new URL('../../../reports/', import.meta.url);

const handler = createAnalyticsPremiumApp({ reportsDir: REPORTS_DIR });
http.createServer(handler).listen(PORT, '127.0.0.1', () => {
  console.log(`Analytics Premium (Brief) running at http://127.0.0.1:${PORT}`);
});
