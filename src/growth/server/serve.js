#!/usr/bin/env node
// Launcher (local preview only): npm run growth -> http://127.0.0.1:4413
// Binds to the loopback interface; there is no hosted/staging mode for Growth yet (no access token layer),
// so it must not be exposed. Optional: GROWTH_PORT.
// Tenant (ADR 0003): when NORDLA_MERCHANT_ID is set, it is resolved at startup through the shared resolver (unknown or invalid ->
// refused, nothing served) and Potentiel produits reads that merchant's synced data. Without it, the demonstration pages still
// work and Produits Potentiels / Audience / Contenu / Croissance magasin say TENANT_NOT_CONFIGURED - no merchant is ever guessed.

import http from 'node:http';
import { createGrowthApp } from './app.js';
import { createProductPotentialSource } from './products.js';
import { createAudienceSource } from './audience.js';
import { createContentSource } from './content.js';
import { createStoreSource } from './store.js';
import { createReviewSource } from './review.js';
import { createCorrectionsSource } from './corrections.js';
import { createAdsSource } from './ads.js';
import { createSiteSource, createSiteReviewSource, fileSiteLoader } from './site.js';
import { createSocialSource, createSocialReviewSource, fileSocialLoader } from './social.js';
import { instagramLoaderFromEnv } from './instagram-env.js';
import { createPublicationSource, filePosts } from './social-publication.js';
import { createInboxSource, createInboxReviewSource, fileInboxLoader } from './inbox.js';
import { readMerchantIdFromEnv } from '../../tenant/index.js';
import { resolveToolTenant } from '../../tenant/tool-context.js';
import { createSupabaseClient, loadSupabaseConfigFromEnv } from '../../supabase/client.js';
import { resolveBusinessProfile } from '../../metrics/profile.js';

const port = Number(process.env.GROWTH_PORT || 4413);
try {
  let merchantId = null;
  let productPotential = null; let audience = null; let content = null; let store = null; let review = null; let corrections = null; let ads = null; let site = null; let siteReview = null; let social = null; let socialReview = null; let inbox = null; let inboxReview = null;
  if (readMerchantIdFromEnv(process.env)) {
    const supabase = createSupabaseClient(loadSupabaseConfigFromEnv());
    const tenant = await resolveToolTenant({ env: process.env, supabase, tool: 'growth', log: console.log });
    merchantId = tenant.merchantId;
    // The merchant's local zone (merchant_profile.timezone, else MERCHANT_TIMEZONE, reported): missing or invalid -> TIMEZONE_NOT_CONFIGURED / TIMEZONE_INVALID, nothing is served. UTC is never assumed.
    const { timezone: timeZone } = await resolveBusinessProfile({ supabase, merchantId: tenant.merchantId, env: process.env });
    productPotential = createProductPotentialSource({ supabase, merchantId: tenant.merchantId, timeZone });
    audience = createAudienceSource({ supabase, merchantId: tenant.merchantId, timeZone });
    content = createContentSource({ supabase, merchantId: tenant.merchantId, timeZone });
    store = createStoreSource({ supabase, merchantId: tenant.merchantId, timeZone });
    review = createReviewSource({ supabase, merchantId: tenant.merchantId, timeZone });
    // Optional shop identity for the correction file (names/links only; nothing is guessed when absent).
    site = createSiteSource({ timeZone, load: fileSiteLoader() }); siteReview = createSiteReviewSource({ timeZone, load: fileSiteLoader() }); // no GA4 / Search Console connector yet: only an import file (data/local/marketing/site-funnel.json); absent = NOT_CONNECTED
    { const loaders = { instagram: instagramLoaderFromEnv(process.env) ?? fileSocialLoader('instagram'), tiktok: fileSocialLoader('tiktok') }; social = createSocialSource({ loaders, merchantId, publications: createPublicationSource({ list: filePosts(process.env.SOCIAL_DATA_DIR || undefined), merchantId, appUrl: process.env.SOCIAL_APP_URL || null }) }); socialReview = createSocialReviewSource({ loaders }); const il = { instagram: fileInboxLoader('instagram'), tiktok: fileInboxLoader('tiktok') }; inbox = createInboxSource({ loaders: il, merchantId, accounts: async () => { const sc = await social(); return sc.accounts.filter((a) => a.state === 'OK').map((a) => ({ network: a.network, id: a.accountId, handle: a.handle ?? null, linkedTestId: (sc.items.find((i) => i.evidence.network === a.network) ?? {}).id ?? null })); }, publications: createPublicationSource({ list: filePosts(process.env.SOCIAL_DATA_DIR || undefined), merchantId, appUrl: process.env.SOCIAL_APP_URL || null }) }); inboxReview = createInboxReviewSource({ loaders: il, merchantId }); } // no Instagram / TikTok insights connector yet: only import files (data/local/marketing/social-<network>.json); absent = NOT_CONNECTED
    ads = createAdsSource({ timeZone }); // no ad account is connected to Nordla yet: the block says so (NOT_CONNECTED), nothing is invented
    corrections = createCorrectionsSource({ supabase, merchantId: tenant.merchantId, timeZone, productPotential, shop: { name: process.env.NORDLA_SHOP_NAME || tenant.merchant?.name, platform: 'Shopify', domain: process.env.NORDLA_SHOP_DOMAIN, myshopifyDomain: process.env.NORDLA_MYSHOPIFY_DOMAIN || (/\.myshopify\.com$/i.test(process.env.SHOPIFY_SHOP_DOMAIN ?? '') ? process.env.SHOPIFY_SHOP_DOMAIN : undefined) } });
  }
  const previewUrl = /^https?:\/\//.test(process.env.GROWTH_PREVIEW_URL ?? '') ? process.env.GROWTH_PREVIEW_URL : null; // the guided preview (fictitious data), offered from the guide when the merchant has configured it
  const handler = createGrowthApp({ guide: { previewUrl, isPreview: false }, productPotential, audience, content, store, merchantId, review, corrections, ads, site, siteReview, social, socialReview, inbox, inboxReview });
  http.createServer(handler).listen(port, '127.0.0.1', () => {
    console.log(`Nordla Growth running at http://127.0.0.1:${port}${productPotential ? '' : ' (no NORDLA_MERCHANT_ID: Produits Potentiels, Audience, Contenu and Croissance magasin not configured)'}`);
  });
} catch (e) {
  console.error(`growth failed to start${e.code ? ` (${e.code})` : ''}: ${e.message}`);
  process.exitCode = 1;
}
