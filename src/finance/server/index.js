#!/usr/bin/env node
// Launch the finance dashboard against the real system:  npm run finance:dashboard
// Listens on 127.0.0.1 only. Login uses FINANCE_DASHBOARD_TOKEN from .env (generated on first run, never printed, never sent to
// the browser except as what you type into the login box). No Peppol/external sending exists.

import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import http from 'node:http';
import { join } from 'node:path';
import { createRuntime } from '../runtime.js';
import { LOGO_DIR, SETTINGS_PATH, loadSettings, saveSettings } from '../settings.js';
import { createShopifyPriceSource } from '../catalog.js';
import { createShopifyStockApplier } from '../stock.js';
import { createSupabaseAttachmentStore } from '../inbox.js';
import { createFinanceApp } from './app.js';
import { latestSyncStatus } from '../../sync/run-log.js';
import { mergeRetailHistory } from '../retail-history.js';
import { HostingConfigError, resolveHosting } from './hosting.js';

const AUDIT_LOG = 'data/local/finance/audit.log';

async function ensureToken(hosting) {
  // Hosted: the token comes from the platform variables only; nothing is read from or written to a .env file.
  if (hosting.tokenRequired) return process.env.FINANCE_DASHBOARD_TOKEN;
  if (process.env.FINANCE_DASHBOARD_TOKEN && process.env.FINANCE_DASHBOARD_TOKEN.length >= 24) return process.env.FINANCE_DASHBOARD_TOKEN;
  if (existsSync('.env') && /^FINANCE_DASHBOARD_TOKEN=.{24,}/m.test(await readFile('.env', 'utf8'))) {
    const m = /^FINANCE_DASHBOARD_TOKEN=(.{24,})$/m.exec(await readFile('.env', 'utf8'));
    return m[1].trim();
  }
  const t = randomBytes(24).toString('hex');
  await appendFile('.env', `\n# Login token for the local finance dashboard (Phase: Finance Operations). Keep private.\nFINANCE_DASHBOARD_TOKEN=${t}\n`);
  console.log('A dashboard login token was generated and saved to .env as FINANCE_DASHBOARD_TOKEN (not displayed).');
  return t;
}

async function main() {
  const hosting = resolveHosting(); // fails fast (before any network call) when a hosted deployment is misconfigured
  const token = await ensureToken(hosting);
  const rt = await createRuntime();
  await mkdir('data/local/finance', { recursive: true });
  if (!existsSync(SETTINGS_PATH)) await saveSettings(await loadSettings());
  const app = createFinanceApp({
    merchantId: rt.merchant.id, store: rt.store, token, retail: rt.retail, priceSource: createShopifyPriceSource(rt.shopify), stockApplier: createShopifyStockApplier(rt.shopify), attachmentStore: createSupabaseAttachmentStore({ url: process.env.SUPABASE_URL, serviceKey: process.env.SUPABASE_SERVICE_ROLE_KEY }), retailConfig: rt.retailConfig, timeZone: rt.timeZone, retailHistory: async () => { let at = null; try { at = (await latestSyncStatus(rt.supabase, rt.merchant.id))?.lastSuccess?.finishedAt ?? null; } catch { at = null; } return mergeRetailHistory(await rt.retailHistory(), at); },
    syncStatus: () => latestSyncStatus(rt.supabase, rt.merchant.id, { staleAfterMinutes: Number(process.env.SYNC_STALE_AFTER_MINUTES || 60) }),
    allowedHosts: hosting.allowedHosts ?? undefined, secureCookie: hosting.secureCookie, trustProxyHops: hosting.trustProxyHops,
    settings: {
      load: () => loadSettings(),
      save: (s) => saveSettings(s),
      saveLogo: async ({ ext, bytes }) => { const p = join(LOGO_DIR, `logo.${ext}`).replace(/\\/g, '/'); await writeFile(p, bytes); return p; },
    },
    audit: async (e) => appendFile(AUDIT_LOG, `${JSON.stringify(e)}\n`).catch(() => {}),
  });
  const server = http.createServer(app.handler);
  server.listen(hosting.port, hosting.host, () => {
    if (hosting.hosted) console.log(`Finance dashboard (hosted): listening on ${hosting.host}:${hosting.port}, serving ${hosting.allowedHosts.join(', ')} only.`);
    else {
      console.log(`Finance dashboard: http://127.0.0.1:${hosting.port}   (loopback only)`);
      console.log('Log in with the token stored in .env (FINANCE_DASHBOARD_TOKEN). Nothing is sent externally.');
    }
  });
}
main().catch((e) => { console.error(e instanceof HostingConfigError ? `dashboard configuration error: ${e.message}` : `dashboard failed to start: ${e.message}`); process.exitCode = 1; });
