#!/usr/bin/env node
// Launch the finance dashboard against the real system:  npm run finance:dashboard
// Listens on 127.0.0.1 only. Login uses FINANCE_DASHBOARD_TOKEN from .env (generated on first run, never printed, never sent to
// the browser except as what you type into the login box). No Peppol/external sending exists.

import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import http from 'node:http';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRuntime } from '../runtime.js';
import { LOGO_DIR, SETTINGS_PATH, loadSettings, saveSettings } from '../settings.js';
import { createShopifyPriceSource } from '../catalog.js';
import { createShopifyStockApplier } from '../stock.js';
import { createSupabaseAttachmentStore } from '../inbox.js';
import { createFinanceApp } from './app.js';
import { createFileSessionPersistence } from './session-store.js';
import { latestSyncStatus } from '../../sync/run-log.js';
import { mergeRetailHistory } from '../retail-history.js';
import { HostingConfigError, resolveHosting } from './hosting.js';

const AUDIT_LOG = 'data/local/finance/audit.log';

async function ensureToken(hosting, env = process.env) {
  // Hosted: the token comes from the platform variables only; nothing is read from or written to a .env file.
  if (hosting.tokenRequired) return env.FINANCE_DASHBOARD_TOKEN;
  if (env.FINANCE_DASHBOARD_TOKEN && env.FINANCE_DASHBOARD_TOKEN.length >= 24) return env.FINANCE_DASHBOARD_TOKEN;
  if (existsSync('.env') && /^FINANCE_DASHBOARD_TOKEN=.{24,}/m.test(await readFile('.env', 'utf8'))) {
    const m = /^FINANCE_DASHBOARD_TOKEN=(.{24,})$/m.exec(await readFile('.env', 'utf8'));
    return m[1].trim();
  }
  const t = randomBytes(24).toString('hex');
  await appendFile('.env', `\n# Login token for the local finance dashboard (Phase: Finance Operations). Keep private.\nFINANCE_DASHBOARD_TOKEN=${t}\n`);
  console.log('A dashboard login token was generated and saved to .env as FINANCE_DASHBOARD_TOKEN (not displayed).');
  return t;
}

/**
 * Start the Finance dashboard. Exported for tests, which inject `runtimeDeps` (a Supabase stand-in, a Shopify client factory);
 * production runs it with the process environment when this file is executed directly.
 * The tenant comes from the shared resolver (NORDLA_MERCHANT_ID); Shopify is an optional connector, never contacted at boot.
 * @returns {Promise<{ server: import('node:http').Server, runtime: object, hosting: object }>} resolves once the port is open
 */
export async function startFinanceServer({ env = process.env, runtimeDeps = {}, log = console.log } = {}) {
  const hosting = resolveHosting(env); // fails fast (before any network call) when a hosted deployment is misconfigured
  const token = await ensureToken(hosting, env);
  const rt = await createRuntime({ env, log, ...runtimeDeps });
  await mkdir('data/local/finance', { recursive: true });
  if (!existsSync(SETTINGS_PATH)) await saveSettings(await loadSettings());
  const app = createFinanceApp({
    merchantId: rt.merchant.id, store: rt.store, token, retail: rt.retail, priceSource: createShopifyPriceSource(rt.shopify), salesConnector: rt.shopify,
    // Shopify stock applier gated by the connector state: NOT_CONFIGURED / MISCONFIGURED / UNAVAILABLE block it explicitly.
    stockApplier: { ...createShopifyStockApplier(rt.shopify), state: () => rt.shopify.state({ verify: true }) },
    attachmentStore: createSupabaseAttachmentStore({ url: env.SUPABASE_URL, serviceKey: env.SUPABASE_SERVICE_ROLE_KEY }), retailConfig: rt.retailConfig, timeZone: rt.timeZone, retailHistory: async () => { let at = null; try { at = (await latestSyncStatus(rt.supabase, rt.merchant.id))?.lastSuccess?.finishedAt ?? null; } catch { at = null; } return mergeRetailHistory(await rt.retailHistory(), at); },
    // No sales-source connector at all -> an honest "no source" instead of an unknown sync.
    syncStatus: async () => {
      const source = await rt.salesSource();
      if (source === 'NONE') return { available: false, reason: 'NO_SALES_SOURCE' };
      if (source === 'NOT_CONFIGURED') return { available: false, reason: 'SALES_SOURCE_NOT_CONFIGURED' }; // never an old sync run shown as live
      return latestSyncStatus(rt.supabase, rt.merchant.id, { staleAfterMinutes: Number(env.SYNC_STALE_AFTER_MINUTES || 60) });
    },
    allowedHosts: hosting.allowedHosts ?? undefined, secureCookie: hosting.secureCookie, trustProxyHops: hosting.trustProxyHops,
    settings: {
      load: () => loadSettings(),
      save: (s) => saveSettings(s),
      saveLogo: async ({ ext, bytes }) => { const p = join(LOGO_DIR, `logo.${ext}`).replace(/\\/g, '/'); await writeFile(p, bytes); return p; },
    },
    audit: async (e) => appendFile(AUDIT_LOG, `${JSON.stringify(e)}\n`).catch(() => {}),
    // Sessions survive a redeploy: kept next to the settings (hosted: on the Finance volume), session ids stored hashed only.
    sessionPersistence: createFileSessionPersistence('data/local/finance/sessions.json'),
  });
  const server = http.createServer(app.handler);
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(hosting.port, hosting.host, resolve); });
  if (hosting.hosted) log(`Finance dashboard (hosted): listening on ${hosting.host}:${hosting.port}, serving ${hosting.allowedHosts.join(', ')} only.`);
  else {
    log(`Finance dashboard: http://127.0.0.1:${hosting.port}   (loopback only)`);
    log('Log in with the token stored in .env (FINANCE_DASHBOARD_TOKEN). Nothing is sent externally.');
  }
  return { server, runtime: rt, hosting };
}

// Run only when executed directly (`node src/finance/server/index.js`), not when imported by a test.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startFinanceServer().catch((e) => { console.error(e instanceof HostingConfigError ? `dashboard configuration error: ${e.message}` : `dashboard failed to start: ${e.message}`); process.exitCode = 1; });
}
