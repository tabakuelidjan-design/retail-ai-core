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
import { createFinanceApp } from './app.js';

const PORT = Number(process.env.FINANCE_PORT || 4310);
const AUDIT_LOG = 'data/local/finance/audit.log';

async function ensureToken() {
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
  const token = await ensureToken();
  const rt = await createRuntime();
  await mkdir('data/local/finance', { recursive: true });
  if (!existsSync(SETTINGS_PATH)) await saveSettings(await loadSettings());
  const app = createFinanceApp({
    merchantId: rt.merchant.id, store: rt.store, token, retail: rt.retail, priceSource: createShopifyPriceSource(rt.shopify), retailConfig: rt.retailConfig, timeZone: rt.timeZone, retailHistory: rt.retailHistory,
    settings: {
      load: () => loadSettings(),
      save: (s) => saveSettings(s),
      saveLogo: async ({ ext, bytes }) => { const p = join(LOGO_DIR, `logo.${ext}`).replace(/\\/g, '/'); await writeFile(p, bytes); return p; },
    },
    audit: async (e) => appendFile(AUDIT_LOG, `${JSON.stringify(e)}\n`).catch(() => {}),
  });
  const server = http.createServer(app.handler);
  server.listen(PORT, '127.0.0.1', () => {
    console.log(`Finance dashboard: http://127.0.0.1:${PORT}   (loopback only)`);
    console.log('Log in with the token stored in .env (FINANCE_DASHBOARD_TOKEN). Nothing is sent externally.');
  });
}
main().catch((e) => { console.error('dashboard failed to start:', e.message); process.exitCode = 1; });
