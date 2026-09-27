#!/usr/bin/env node
// Launcher (local preview only): npm run growth -> http://127.0.0.1:4413
// Binds to the loopback interface; there is no hosted/staging mode for Growth yet (no access token layer),
// so it must not be exposed. Optional: GROWTH_PORT.
// Tenant (ADR 0003): when NORDLA_MERCHANT_ID is set, it is resolved at startup through the shared resolver (unknown or invalid ->
// refused, nothing served) and Potentiel produits reads that merchant's synced data. Without it, the demonstration pages still
// work and Potentiel produits / Audience say TENANT_NOT_CONFIGURED - no merchant is ever guessed.

import http from 'node:http';
import { createGrowthApp } from './app.js';
import { createProductPotentialSource } from './products.js';
import { createAudienceSource } from './audience.js';
import { readMerchantIdFromEnv } from '../../tenant/index.js';
import { resolveToolTenant } from '../../tenant/tool-context.js';
import { createSupabaseClient, loadSupabaseConfigFromEnv } from '../../supabase/client.js';

const port = Number(process.env.GROWTH_PORT || 4413);
try {
  let productPotential = null; let audience = null;
  if (readMerchantIdFromEnv(process.env)) {
    const supabase = createSupabaseClient(loadSupabaseConfigFromEnv());
    const tenant = await resolveToolTenant({ env: process.env, supabase, tool: 'growth', log: console.log });
    productPotential = createProductPotentialSource({ supabase, merchantId: tenant.merchantId, timeZone: process.env.MERCHANT_TIMEZONE || 'UTC' });
    audience = createAudienceSource({ supabase, merchantId: tenant.merchantId, timeZone: process.env.MERCHANT_TIMEZONE || 'UTC' });
  }
  const handler = createGrowthApp({ productPotential, audience });
  http.createServer(handler).listen(port, '127.0.0.1', () => {
    console.log(`Nordla Growth running at http://127.0.0.1:${port}${productPotential ? '' : ' (no NORDLA_MERCHANT_ID: Produits Potentiels and Audience not configured)'}`);
  });
} catch (e) {
  console.error(`growth failed to start: ${e.message}`);
  process.exitCode = 1;
}
