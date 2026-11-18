// The merchant's Growth data sources, built once from the environment: used by the local launcher (serve.js) and by the HOSTED server (hosted-main.js).
// One place, so the two never read different data. Nothing here opens a port or reads a request.
import { createProductPotentialSource } from './products.js';
import { createAudienceSource } from './audience.js';
import { createContentSource } from './content.js';
import { createStoreSource } from './store.js';
import { createReviewSource } from './review.js';
import { createCorrectionsSource } from './corrections.js';
import { createAdsSource } from './ads.js';
import { createSiteSource, createSiteReviewSource, fileSiteLoader } from './site.js';
import { createDropoffSource, fileDropoffLoader, supabaseDropoffLoader } from './dropoff.js';
import { createSupabasePersonalizerStore } from './collect-personalizer.js';
import { createSocialSource, createSocialReviewSource, fileSocialLoader } from './social.js';
import { instagramLoaderFromEnv } from './instagram-env.js';
import { createPublicationSource, filePosts } from './social-publication.js';
import { createInboxSource, createInboxReviewSource, fileInboxLoader } from './inbox.js';
import { readMerchantIdFromEnv } from '../../tenant/index.js';
import { resolveToolTenant } from '../../tenant/tool-context.js';
import { createSupabaseClient, loadSupabaseConfigFromEnv } from '../../supabase/client.js';
import { resolveBusinessProfile, liveTimeZone } from '../../metrics/profile.js';
import { createGeneralService } from '../../settings-general/service.js';
import { createSupabaseGeneralRepository } from '../../settings-general/repository.js';

/** @returns the sources of createGrowthApp (all null when NORDLA_MERCHANT_ID is not set: nothing is ever guessed). Throws the tenant / timezone refusals. */
export async function buildGrowthSources(env = process.env, { log = console.log } = {}) {
  let merchantId = null; let supabase = null; let timeZone = null; let generalContext = null;
  let productPotential = null; let audience = null; let content = null; let store = null; let review = null; let corrections = null; let ads = null; let site = null; let siteReview = null; let social = null; let socialReview = null; let inbox = null; let inboxReview = null; let dropoff = null; let personalizerStore = null;
  if (readMerchantIdFromEnv(env)) {
    supabase = createSupabaseClient(loadSupabaseConfigFromEnv(env));
    const tenant = await resolveToolTenant({ env, supabase, tool: 'growth', log });
    merchantId = tenant.merchantId;
    // The merchant's local zone (merchant_profile.timezone, else MERCHANT_TIMEZONE, reported): missing or invalid -> TIMEZONE_NOT_CONFIGURED / TIMEZONE_INVALID, nothing is served. UTC is never assumed.
    ({ timezone: timeZone } = await resolveBusinessProfile({ supabase, merchantId: tenant.merchantId, env }));
    // the four engines follow the zone set in Général without a restart (re-read at most once a minute, then their own 5-minute cache); the other sources below still use the zone read at start
    const liveTz = liveTimeZone({ supabase, merchantId: tenant.merchantId, env, onError: (e) => log(`growth: time zone re-read failed, keeping the last one: ${e.message}`) });
    productPotential = createProductPotentialSource({ supabase, merchantId: tenant.merchantId, timeZone: liveTz });
    audience = createAudienceSource({ supabase, merchantId: tenant.merchantId, timeZone: liveTz });
    content = createContentSource({ supabase, merchantId: tenant.merchantId, timeZone: liveTz });
    store = createStoreSource({ supabase, merchantId: tenant.merchantId, timeZone: liveTz });
    { const general = createGeneralService({ repo: createSupabaseGeneralRepository({ supabase }) }); generalContext = () => general.contextFor({ tenant: { merchantId: tenant.merchantId }, module: 'growth' }); } // READ ONLY: Growth never writes Général
    review = createReviewSource({ supabase, merchantId: tenant.merchantId, timeZone });
    // Optional shop identity for the correction file (names/links only; nothing is guessed when absent).
    site = createSiteSource({ timeZone, load: fileSiteLoader() }); siteReview = createSiteReviewSource({ timeZone, load: fileSiteLoader() }); // no GA4 / Search Console connector yet: only an import file (data/local/marketing/site-funnel.json); absent = NOT_CONNECTED
    { const loaders = { instagram: instagramLoaderFromEnv(env) ?? fileSocialLoader('instagram'), tiktok: fileSocialLoader('tiktok') }; social = createSocialSource({ loaders, merchantId, publications: createPublicationSource({ list: filePosts(env.SOCIAL_DATA_DIR || undefined), merchantId, appUrl: env.SOCIAL_APP_URL || null }) }); socialReview = createSocialReviewSource({ loaders }); const il = { instagram: fileInboxLoader('instagram'), tiktok: fileInboxLoader('tiktok') }; inbox = createInboxSource({ loaders: il, merchantId, accounts: async () => { const sc = await social(); return sc.accounts.filter((a) => a.state === 'OK').map((a) => ({ network: a.network, id: a.accountId, handle: a.handle ?? null, linkedTestId: (sc.items.find((i) => i.evidence.network === a.network) ?? {}).id ?? null })); }, publications: createPublicationSource({ list: filePosts(env.SOCIAL_DATA_DIR || undefined), merchantId, appUrl: env.SOCIAL_APP_URL || null }) }); inboxReview = createInboxReviewSource({ loaders: il, merchantId }); } // no Instagram / TikTok insights connector yet: only import files (data/local/marketing/social-<network>.json); absent = NOT_CONNECTED
    personalizerStore = createSupabasePersonalizerStore(supabase, tenant.merchantId); // the shop's technical personalizer events (table growth_personalizer_events), the server's merchant only
    dropoff = createDropoffSource({ timeZone, personalizerStore, load: env.GROWTH_HOSTED === '1' ? supabaseDropoffLoader(supabase, tenant.merchantId) : fileDropoffLoader() }); // snapshot of the shop funnel (hosted: growth_funnel_snapshot; local: data/local/marketing/shop-funnel.json); absent = NOT_CONNECTED
    ads = createAdsSource({ timeZone }); // no ad account is connected to Nordla yet: the block says so (NOT_CONNECTED), nothing is invented
    corrections = createCorrectionsSource({ supabase, merchantId: tenant.merchantId, timeZone, productPotential, shop: { name: env.NORDLA_SHOP_NAME || tenant.merchant?.name, platform: 'Shopify', domain: env.NORDLA_SHOP_DOMAIN, myshopifyDomain: env.NORDLA_MYSHOPIFY_DOMAIN || (/\.myshopify\.com$/i.test(env.SHOPIFY_SHOP_DOMAIN ?? '') ? env.SHOPIFY_SHOP_DOMAIN : undefined) } });
  }
  return { merchantId, supabase, timeZone, generalContext, productPotential, audience, content, store, review, corrections, ads, site, siteReview, social, socialReview, inbox, inboxReview, dropoff, personalizerStore };
}
