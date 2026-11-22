#!/usr/bin/env node
// Launcher (local preview only): npm run growth -> http://127.0.0.1:4413
// Local: binds to the loopback interface only (GROWTH_PORT). Hosted (Railway): binds to every interface on PORT, and only for the
// exact host names in GROWTH_ALLOWED_HOSTS, with NORDLA_PROXY_SECRET required (see hosting.js). Nothing else is exposed.
// Tenant (ADR 0003): when NORDLA_MERCHANT_ID is set, it is resolved at startup through the shared resolver (unknown or invalid ->
// refused, nothing served) and Potentiel produits reads that merchant's synced data. Without it, the demonstration pages still
// work and Produits Potentiels / Audience / Contenu / Croissance magasin say TENANT_NOT_CONFIGURED - no merchant is ever guessed.

import { createGrowthApp } from './app.js';
import { listenGrowth } from './hosting.js';
import { createProductPotentialSource } from './products.js';
import { createAudienceSource } from './audience.js';
import { createContentSource } from './content.js';
import { createStoreSource } from './store.js';
import { readMerchantIdFromEnv } from '../../tenant/index.js';
import { resolveToolTenant } from '../../tenant/tool-context.js';
import { createSupabaseClient, loadSupabaseConfigFromEnv } from '../../supabase/client.js';
import { resolveBusinessProfile, liveTimeZone } from '../../metrics/profile.js';

try {
  let productPotential = null; let audience = null; let content = null; let store = null;
  if (readMerchantIdFromEnv(process.env)) {
    const supabase = createSupabaseClient(loadSupabaseConfigFromEnv());
    const tenant = await resolveToolTenant({ env: process.env, supabase, tool: 'growth', log: console.log });
    // The merchant's local zone (merchant_profile.timezone, else MERCHANT_TIMEZONE, reported): missing or invalid -> TIMEZONE_NOT_CONFIGURED / TIMEZONE_INVALID, nothing is served. UTC is never assumed.
    await resolveBusinessProfile({ supabase, merchantId: tenant.merchantId, env: process.env }); // strict check at start: a missing or invalid zone refuses to start
    const timeZone = liveTimeZone({ supabase, merchantId: tenant.merchantId, env: process.env, onError: (e) => console.error(`time zone re-read failed, keeping the last one: ${e.message}`) }); // then it follows Général (at most once a minute; the sources cache 5 minutes)
    productPotential = createProductPotentialSource({ supabase, merchantId: tenant.merchantId, timeZone });
    audience = createAudienceSource({ supabase, merchantId: tenant.merchantId, timeZone });
    content = createContentSource({ supabase, merchantId: tenant.merchantId, timeZone });
    store = createStoreSource({ supabase, merchantId: tenant.merchantId, timeZone });
  }
  // local: loopback only; hosted (Railway): every interface, with the host check and the proxy secret (src/growth/server/hosting.js)
  await listenGrowth({ env: process.env, log: console.log, createHandler: (plan) => createGrowthApp({ productPotential, audience, content, store, proxySecret: plan.proxySecret, basePath: process.env.NORDLA_MODULE_BASE || '/' }) });
  console.log(`Nordla Growth started${productPotential ? '' : ' (no NORDLA_MERCHANT_ID: Produits Potentiels, Audience, Contenu and Croissance magasin not configured)'}`);
} catch (e) {
  console.error(`growth failed to start${e.code ? ` (${e.code})` : ''}: ${e.message}`);
  process.exitCode = 1;
}
