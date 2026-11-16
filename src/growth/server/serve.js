#!/usr/bin/env node
// Launcher (local preview only): npm run growth -> http://127.0.0.1:4413
// Binds to the loopback interface and has NO sign-in: it must not be exposed. The hosted, signed-in server is hosted-main.js (the "growth" service of service-start.js).
// Optional: GROWTH_PORT.
// Tenant (ADR 0003): when NORDLA_MERCHANT_ID is set, it is resolved at startup through the shared resolver (unknown or invalid ->
// refused, nothing served) and Potentiel produits reads that merchant's synced data. Without it, the demonstration pages still
// work and Produits Potentiels / Audience / Contenu / Croissance magasin say TENANT_NOT_CONFIGURED - no merchant is ever guessed.

import http from 'node:http';
import { createGrowthApp } from './app.js';
import { buildGrowthSources } from './sources.js';

const port = Number(process.env.GROWTH_PORT || 4413);
try {
  const sources = await buildGrowthSources(process.env, { log: console.log });
  const previewUrl = /^https?:\/\//.test(process.env.GROWTH_PREVIEW_URL ?? '') ? process.env.GROWTH_PREVIEW_URL : null; // the guided preview (fictitious data), offered from the guide when the merchant has configured it
  const handler = createGrowthApp({ guide: { previewUrl, isPreview: false }, ...sources });
  http.createServer(handler).listen(port, '127.0.0.1', () => {
    console.log(`Nordla Growth running at http://127.0.0.1:${port}${sources.productPotential ? '' : ' (no NORDLA_MERCHANT_ID: Produits Potentiels, Audience, Contenu and Croissance magasin not configured)'}`);
  });
} catch (e) {
  console.error(`growth failed to start${e.code ? ` (${e.code})` : ''}: ${e.message}`);
  process.exitCode = 1;
}
