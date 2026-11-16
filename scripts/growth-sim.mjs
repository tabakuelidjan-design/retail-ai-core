#!/usr/bin/env node
// Growth SIMULATION preview (local only): http://127.0.0.1:4414/#/opportunities - ENTIRELY fictitious data, no HABB data, no database, no Shopify, no ad platform.
//   - Opportunités with product / store / e-mail campaign opportunities (the synthetic fixtures used by the tests);
//   - the "Campagnes publicitaires" block fed by a simulated Meta Ads export (a real zero, unknown conversions, an incomplete period, a clean campaign);
//   - an applied action whose review is due ("À revoir"), with a before / after result CALCULATED by the real review engine from a simulated order history.
// The history of the merchant (plans, applications, reviews) lives in the browser's localStorage of THIS origin (127.0.0.1:4414), seeded once by /sim-seed.js.
// Run: node scripts/growth-sim.mjs   (optional GROWTH_SIM_PORT)
import http from 'node:http';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createGrowthApp } from '../src/growth/server/app.js';
import { createReviewSource } from '../src/growth/server/review.js';
import { createAdsSource } from '../src/growth/server/ads.js';
import { createSiteSource, createSiteReviewSource } from '../src/growth/server/site.js';
import { createSocialSource, createSocialReviewSource } from '../src/growth/server/social.js';
import { createPublicationSource } from '../src/growth/server/social-publication.js';
import { createInboxSource, createInboxReviewSource, merchantRefOf } from '../src/growth/server/inbox.js';
import { createCorrectionsSource } from '../src/growth/server/corrections.js';
import { createSocialService } from '../src/social/service.js';
import { createPublisher } from '../src/social/publisher.js';
import { createMemoryStore } from '../src/social/store.js';
import { createSimulatedPublisher } from '../src/social/providers/simulated.js';
import { simulatedCreation, merchantRef } from './lib/social-creation-sim.mjs';
import { createFakeSupabase } from '../test/fixtures/fake-supabase.js';
import { audiencePayload, potentialPayload, contentPayload, storePayload } from '../test/growth-dom.js';

const PORT = Number(process.env.GROWTH_SIM_PORT || 4414); const MERCHANT = 'sim-merchant'; const TZ = 'UTC';
const DAY = 86400000; const today = () => new Date().toISOString().slice(0, 10); const shift = (d, n) => new Date(Date.parse(`${d}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);

// ---- simulated order history for the reviewed variant (the real review engine computes from it) ----
const APPLIED = shift(today(), -30); const REVIEW = shift(today(), -2);
function orderWorld() {
  const db = createFakeSupabase(); const tag = (rows) => rows.map((r) => ({ ...r, merchant_id: MERCHANT }));
  const sales = [shift(APPLIED, -62), shift(APPLIED, -20), shift(APPLIED, -9), shift(APPLIED, 4), shift(APPLIED, 11), shift(APPLIED, 17), shift(APPLIED, 24)]; // 2 units before the application, 4 after
  const orders = sales.map((d, i) => ({ id: `o${i}`, ordered_at: `${d}T10:00:00Z`, status: 'PAID', currency: 'EUR', taxes_included: true, is_test: false, order_name: `#SIM${100 + i}` }));
  const lines = sales.map((d, i) => ({ id: `l${i}`, order_id: `o${i}`, variant_id: 'v-bleu', title_snapshot: 'Casque Sim – Bleu', sku_snapshot: null, quantity: 1, unit_price: 49, discount_amount: 0, tax_amount: 8.5 }));
  const t = (name, rows) => db._tables.set(name, tag(rows));
  t('products', [{ id: 'p-sim', source_id: 'gid://SIM/P', title: 'Casque Sim', product_type: 'Audio', source_created_at: '2026-01-01T00:00:00Z', source_status: 'ACTIVE' }]);
  t('variants', [{ id: 'v-bleu', product_id: 'p-sim', source_id: 'gid://SIM/V/bleu', sku: 'SIM-BLEU', title: 'Bleu' }]);
  t('locations', [{ id: 'loc1', name: 'Boutique simulée', type: 'unknown', source_id: 'gid://SIM/L' }]); t('orders', orders); t('order_lines', lines);
  for (const n of ['refunds', 'refund_lines', 'product_costs', 'inventory_snapshots', 'product_collections', 'order_attribution']) t(n, []);
  return db;
}
const review = createReviewSource({ supabase: orderWorld(), merchantId: MERCHANT, timeZone: TZ, cacheMs: 0 });

// ---- simulated Meta Ads export: the 28 days ending today (exclusive) ----
const adRows = (id, name, from, n, f) => Array.from({ length: n }, (_, i) => ({ date: shift(from, i), campaign_id: id, campaign_name: name, impressions: 900, clicks: 14, cost: 6.5, ...f }));
const adStart = shift(today(), -28);
const ads = createAdsSource({ timeZone: TZ, cacheMs: 0, load: async () => ({ source_system: 'meta_ads', platform: 'meta_ads', account_ref: 'act_SIMULATION', currency: 'EUR', conversion_objective: 'purchase', window: { start: adStart, end: today() }, retrieved_at: new Date().toISOString(),
  rows: [...adRows('120001', 'Coques personnalisées – Instagram', adStart, 28, { conversions: 0 }), ...adRows('120002', 'Gourdes – Reels', adStart, 28, {}), ...adRows('120003', 'Boîtes cadeaux – Facebook', adStart, 28, { conversions: 3, clicks: 20 }), ...adRows('120004', 'Impression UV – Stories', adStart, 12, { conversions: 0 })] }) });

// ---- simulated independent site (GA4 export): a services site that receives quote requests. ALL fictitious. ----
// scenarios (GET /sim/scenario?name=...): default | no-start (the form-start event is not configured) | totals-only (no same-session figure) | low-volume
let scenario = 'default'; const PAGE = '/demander-un-devis'; const PAGE2 = '/services-peinture';
const split = (total, n) => Array.from({ length: n }, (_, i) => Math.floor(total / n) + (i < total % n ? 1 : 0));
const siteRows = (path, from, n, t) => { const a = split(t.sessions, n), b = split(t.starts, n), c = split(t.submits, n), d = split(t.seq, n); return Array.from({ length: n }, (_, i) => ({ date: shift(from, i), page_path: path, sessions: a[i], form_start_sessions: b[i], form_submit_sessions: c[i], started_then_submitted_sessions: scenario === 'totals-only' ? null : d[i] })); };
const siteLoad = async () => {
  const T = today(); const D = APPLIED; const scale = scenario === 'low-volume' ? 0.25 : 1; const k = (x) => Math.round(x * scale);
  const before = { sessions: k(240), starts: k(60), submits: k(12), seq: k(12) }; const after = { sessions: k(240), starts: k(60), submits: k(18), seq: k(18) };
  const daily = [...siteRows(PAGE, shift(D, -28), 28, before), ...siteRows(PAGE, D, 1, { sessions: 9, starts: 2, submits: 1, seq: 1 }), ...siteRows(PAGE, shift(D, 1), 28, after), ...siteRows(PAGE, shift(T, -1), 1, { sessions: 8, starts: 2, submits: 1, seq: 1 }),
    ...siteRows(PAGE2, shift(T, -28), 28, { sessions: k(240), starts: k(60), submits: k(12), seq: k(12) })];
  const events = [{ kind: 'form_start', name: 'form_start', configured: scenario !== 'no-start', confirms: 'unknown', page_attributable: true }, { kind: 'form_submit', name: 'generate_lead', configured: true, confirms: 'server_success', page_attributable: true }];
  return { source_system: 'ga4', method: 'manual_export', property_id: 'SIM-381000111', site_url: 'https://www.atelier-exemple.be', time_zone: TZ, window: { start: shift(T, -28), end: T }, retrieved_at: new Date().toISOString(), filters: { channel: 'all', simulation: true }, daily, events,
    search_console: { property_url: 'https://www.atelier-exemple.be/', window: { start: shift(T, -28), end: T }, retrieved_at: new Date().toISOString(), filters: { search_type: 'web' }, page_rows: [{ page: PAGE, impressions: 5200, clicks: 190 }], query_page_rows: [{ query: 'devis peinture namur', page: PAGE, impressions: 900, clicks: 41 }] } };
};
const site = createSiteSource({ timeZone: TZ, cacheMs: 0, load: siteLoad }); const siteReview = createSiteReviewSource({ timeZone: TZ, load: siteLoad });

// ---- simulated social accounts (Instagram insights export, TikTok analytics export). ALL fictitious. ----
// scenarios (GET /sim/scenario?name=...): default | no-attribution (no follows attributed per post) - the TikTok account never has per-post attribution.
const POSTED = shift(today(), -10); const sPost = (id, network, structure, reach, follows, o = {}) => ({ id, url: network === 'tiktok' ? `https://www.tiktok.com/@atelier_sim/video/${id}` : `https://www.instagram.com/reel/${id}/`, posted_at: shift(today(), -25), format: 'reel', paid: 'organic', hook: 'Du plateau vide au cadeau fini', topic: 'impression UV', structure,
  observed: { age_days: 7, reach, follows_attributed: scenario === 'no-attribution' || network === 'tiktok' ? null : follows, views: reach * 2, interactions: Math.round(reach / 20) }, ...o });
const socialFacts = (network) => ({ source_system: network === 'tiktok' ? 'tiktok_analytics_SIMULATION' : 'instagram_insights_SIMULATION', method: 'manual_export', network, account: { id: network === 'tiktok' ? 'tt-7001' : 'ig-9001', handle: '@atelier_sim' }, market: 'BE', time_zone: TZ,
  window: { start: shift(today(), -28), end: today() }, retrieved_at: new Date().toISOString(), followers: { start_total: network === 'tiktok' ? 640 : 1000, end_total: network === 'tiktok' ? 668 : 1060 }, funnel: network === 'instagram' ? { reach: 9000, profile_visits: 400, follows: 60 } : null,
  brand: { tone: 'chaleureux, direct', process: 'impression UV' }, capabilities: { trial_reels: network === 'instagram' },
  posts: [sPost('sim_demo', network, 'démonstration', 1200, 12), sPost('sim_presentation', network, 'présentation produit', 4000, 8), sPost(network === 'instagram' && pubStep === 'published' ? 'sim_instagram_1' : 'sim_test1', network, 'démonstration', 1500, 15, { posted_at: POSTED }),
    sPost('sim_ad', network, 'démonstration', 3000, 40, { paid: 'sponsored' })] });
const socialLoaders = { instagram: async () => socialFacts('instagram'), tiktok: async () => socialFacts('tiktok') };
// ---- the SIMULATED calendar of Publication sociale (lot _09): GET /sim/social?step=none|draft|validated|scheduled|published|uncertain replays the path with a SIMULATED Creator delivery and a simulated publisher (nothing is published) ----
let pubStep = 'none'; let calendar = null; const OWNER = { id: 'owner:sim', role: 'owner' }; const AGENT = { id: 'creator-SIMULATED', role: 'agent' };
const socialBase = createSocialSource({ loaders: socialLoaders, cacheMs: 0, merchantId: 'sim-merchant' });
async function buildCalendar(step) {
  pubStep = 'none'; calendar = null; if (step === 'none') return;
  const brief = (await socialBase()).items.find((i) => i.evidence.network === 'instagram').preparedAction.brief; pubStep = step;
  const midnight = Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate()); // planned 23:30 (Brussels) YESTERDAY, really published 04:00 TODAY (within the publisher's 6 h tolerance): the planned and the real day differ
  const clock = { now: midnight - 3 * 3600_000 }; const store = createMemoryStore();
  const publishers = { instagram: createSimulatedPublisher('instagram', { formats: ['IMAGE', 'REEL'], ...(step === 'uncertain' ? { fail: Object.assign(new Error('timeout'), { unknown: true }) } : {}) }) };
  const service = createSocialService({ store, publishers, clock: () => clock.now, context: { merchantRef: merchantRef(MERCHANT), accounts: { instagram: 'ig-9001', facebook: null } } });
  const publisher = createPublisher({ service, publishers, media: { async resolve(a) { return { url: 'https://simulation.invalid/x', content_type: a.content_type, sha256: a.sha256 }; } }, clock: () => clock.now, logger: () => {}, config: {} });
  const [line] = await service.importProposals([simulatedCreation(brief, { merchantId: MERCHANT })]); calendar = { service, brief };
  if (step === 'draft') return;
  await service.editPost(line.post_id, { publish_at: new Date(midnight - 1 * 3600_000 - 30 * 60_000).toISOString() }, OWNER); await service.act(line.post_id, 'submit', AGENT).catch(() => {});
  const hash = service.contentHashOf(await service.get(line.post_id)); await service.act(line.post_id, 'approve', OWNER, { expected_hash: hash });
  if (step === 'validated') return;
  await service.act(line.post_id, 'schedule', OWNER, { expected_hash: hash });
  if (step === 'scheduled') return;
  clock.now = midnight + 3 * 3600_000; await publisher.runDue(); // published (or, for 'uncertain', an outcome the publisher cannot confirm)
}
const publications = createPublicationSource({ list: async () => (calendar ? calendar.service.list() : []), merchantId: MERCHANT, acceptSimulated: true, appUrl: 'http://127.0.0.1:8980' }); // acceptSimulated: THIS simulation only
const social = createSocialSource({ loaders: socialLoaders, cacheMs: 0, merchantId: 'sim-merchant', publications }); const socialReview = createSocialReviewSource({ loaders: socialLoaders });
await buildCalendar('scheduled'); // the first thing seen: the simulated draft is validated and SCHEDULED in the calendar (planned day shown, no measurement started)

// ---- the SIMULATED conversations of the account (lot _10): fictitious customers, opaque ids, no message text. GET /sim/inbox?name=default|no-attribution|zero|not-connected|unavailable ----
// default: 12 conversations attributed by the source to the post 'sim_test1' (some with several messages) + 3 of unknown origin, all inside the 7 days that follow 10 days ago.
let inboxScenario = 'default';
const convDay = (i) => shift(today(), -10 + (i % 6)); // inside [today-10, today-3)
const inboxFacts = () => ({ merchant_ref: merchantRefOf(MERCHANT), source_system: 'inbox_import_SIMULATION', method: 'aggregate_export', network: 'instagram', account: { id: 'ig-9001', handle: '@atelier_sim' }, market: 'BE', window: { start: shift(today(), -28), end: today() }, retrieved_at: new Date().toISOString(), request_type: 'quote', complete: true,
  conversations: inboxScenario === 'zero' ? [{ id: 'z1', started_at: convDay(0), messages: 1, origin: { kind: 'post', post_id: 'sim_other', attribution: 'connection' } }] : [
    ...Array.from({ length: 12 }, (_, i) => ({ id: `c${String(i + 1).padStart(2, '0')}`, started_at: convDay(i), messages: i % 3 === 0 ? 4 : 1, origin: inboxScenario === 'no-attribution' ? { kind: 'unknown' } : { kind: 'post', post_id: 'sim_test1', attribution: 'connection' } })),
    ...['x1', 'x2', 'x3'].map((id, i) => ({ id, started_at: convDay(i + 1), messages: 1, origin: { kind: 'unknown' } }))] });
const inboxLoaders = { instagram: async () => { if (inboxScenario === 'not-connected') return null; if (inboxScenario === 'unavailable') throw Object.assign(new Error('simulated'), { code: 'CONNECTION_DOWN' }); return inboxFacts(); } };
const inbox = createInboxSource({ loaders: inboxLoaders, merchantId: MERCHANT, cacheMs: 0, accounts: async () => { const sc = await socialBase(); return sc.accounts.filter((a) => a.state === 'OK' && a.network === 'instagram').map((a) => ({ network: a.network, id: a.accountId, handle: a.handle ?? null, linkedTestId: (sc.items.find((i) => i.evidence.network === a.network) ?? {}).id ?? null })); }, publications });
const inboxReview = createInboxReviewSource({ loaders: inboxLoaders, merchantId: MERCHANT });
// ---- the SIMULATED catalogue behind "Télécharger le dossier de correction": 7 fictitious products of the fictitious shop (fake database, in memory) ----
const simDb = createFakeSupabase(); const simProd = (n, o = {}) => ({ merchant_id: MERCHANT, id: `p${n}`, source_id: `gid://shopify/Product/${100 + n}`, handle: `produit-sim-${n}`, title: `Produit simulé ${n}`, product_type: 'Plaque', source_status: 'ACTIVE', image_url: `https://cdn.example.invalid/${n}.jpg`, image_alt_text: 'alt', source_created_at: '2026-01-01T00:00:00Z', ...o });
const simVar = (n, k, sku) => ({ merchant_id: MERCHANT, id: `v${n}-${k}`, product_id: `p${n}`, source_id: `gid://shopify/ProductVariant/${n}0${k}`, sku, title: `Variante ${k}` });
simDb._tables.set('products', [simProd(1), simProd(2), simProd(3), simProd(4, { product_type: '' }), simProd(5), simProd(6), simProd(9)]);
simDb._tables.set('variants', [simVar(1, 1, 'SIM-001'), simVar(1, 2, ''), simVar(1, 3, null), simVar(2, 1, ''), simVar(3, 1, null), simVar(4, 1, ' '), simVar(5, 1, ''), simVar(6, 1, 'SIM-006'), simVar(9, 1, 'SIM-009')]);
const corrections = createCorrectionsSource({ supabase: simDb, merchantId: MERCHANT, timeZone: TZ, shop: { name: 'Boutique de simulation', platform: 'Shopify', domain: 'boutique-sim.example', myshopifyDomain: 'sim-boutique.myshopify.com' }, productPotential: async () => potentialPayload() });
const handler = createGrowthApp({ guide: { isPreview: true, previewUrl: null }, merchantId: MERCHANT, corrections, social, socialReview, inbox, inboxReview, site, siteReview, productPotential: async () => potentialPayload(), audience: async () => audiencePayload(), content: async () => contentPayload(), store: async () => storePayload(), review, ads });

// ---- the seed: ONE applied action whose review is due (kept in this browser; never overwritten) ----
const scope = createHash('sha256').update(MERCHANT).digest('hex'); const ID = 'product:sim-variant-bleu';
const seed = async () => {
  const at = (d, h = 9) => `${d}T0${h}:00:00.000Z`; const planAt = at(shift(APPLIED, -3));
  const snapshot = { id: ID, title: 'Mettre en avant « Casque Sim » (variante Bleu)', why: 'Simulation : une action appliquée il y a 30 jours dont la revue est due.', facts: [], measurement: {}, proposal: { action: 'Mettre en avant « Casque Sim » en montrant la variante « Bleu » en priorité.', metric: 'Unités nettes de la variante', draft: null, campaign: null, facts: [] },
    code: 'variant', target: { type: 'product', available: false }, prerequisites: [], kind: 'product', sourcePage: 'products', summary: 'Simulation.', proof: [], lineProof: '2 unités avant · 4 après (simulation)', targetRef: { type: 'variant', id: 'gid://SIM/V/bleu' } };
  const events = [{ type: 'plan', at: planAt, action: snapshot.proposal.action, metric: snapshot.proposal.metric, baseline: 2, target: 4, reviewDate: REVIEW }, { type: 'applied', at: at(APPLIED, 8), planAt, date: APPLIED, prerequisites: 'none' }];
  const SID = `site:SIM-381000111:${PAGE}`; const sSnap = { id: SID, title: 'Page « /demander-un-devis » : des démarrages du formulaire n’aboutissent pas à un envoi', why: 'Simulation.', facts: [], measurement: {}, proposal: { action: 'Relire le formulaire de la page « /demander-un-devis » et tester la suppression d’un champ non indispensable.', metric: 'Taux d’envoi : sessions ayant démarré puis envoyé / sessions ayant démarré', draft: null, campaign: null, facts: [] },
    code: 'siteForm', target: { type: 'sitePage', available: true, id: PAGE, url: `https://www.atelier-exemple.be${PAGE}` }, prerequisites: [], kind: 'sitePage', sourcePage: 'site', summary: 'Simulation.', proof: [], lineProof: '12/60 sessions · 20 %', targetRef: { type: 'page', id: PAGE } };
  const sEvents = [{ type: 'plan', at: planAt, action: sSnap.proposal.action, metric: sSnap.proposal.metric, baseline: 20, target: 30, reviewDate: REVIEW }, { type: 'applied', at: at(APPLIED, 8), planAt, date: APPLIED, prerequisites: 'none' }];
  const put = (id, v) => `{ const k = ${JSON.stringify(`nordla.growth.follow-up.v1:${scope}:${encodeURIComponent(id)}`)}; if (!localStorage.getItem(k)) localStorage.setItem(k, JSON.stringify(${JSON.stringify(v)})); }`;
  const sp = (await social()).items.find((i) => i.evidence.network === 'instagram'); const QID = sp ? sp.id : 'social:instagram:ig-9001'; const brief = sp ? sp.preparedAction.brief : null;
  const qSnap = { id: QID, title: 'Gagner des abonnés (Instagram) : piste à tester', why: 'Simulation.', facts: [], measurement: {}, proposal: { action: 'Publier un test (Reel) qui reprend la structure « démonstration » observée, et mesurer les abonnements attribués pour 1 000 comptes atteints à 7 jours.', metric: 'Abonnements attribués pour 1 000 comptes atteints', draft: null, campaign: null, brief, facts: [] },
    code: 'socialTest', target: null, prerequisites: [], network: 'instagram', accountId: 'ig-9001', observationDays: 7, kind: 'socialTest', sourcePage: 'social', summary: 'Simulation.', proof: [], lineProof: 'Instagram @atelier_sim · 10 pour 1 000 contre 2', targetRef: null };
  const qPlan = shift(today(), -14); const qEvents = [{ type: 'plan', at: at(qPlan), action: qSnap.proposal.action, metric: qSnap.proposal.metric, baseline: 3.85, target: 8, reviewDate: REVIEW }, { type: 'applied', at: at(POSTED, 8), planAt: at(qPlan), date: POSTED, post: { id: 'sim_test1', url: 'https://www.instagram.com/reel/sim_test1/', network: 'instagram', accountId: 'ig-9001', declared: 'manual' }, prerequisites: 'none' }];
  // Demandes: the test is prepared, linked to the Reel 10 days ago, 4 conversations qualified by the merchant (+ 1 of unknown origin), the others marked not qualified; then the commercial follow-up
  const IID = 'inbox:instagram:ig-9001'; const iApplied = shift(today(), -10); const iPlan = at(shift(today(), -12));
  const iSnap = { id: IID, title: 'Demandes qualifiées (Instagram) : inviter à écrire « DEVIS » en message privé', why: 'Simulation.', facts: [], measurement: {}, proposal: { action: 'Ajouter à la prochaine publication l’invitation à envoyer « DEVIS » en message privé, puis mesurer les demandes qualifiées sur 7 jours.', metric: 'Taux de qualification (%)', draft: null, campaign: null, brief: null, inquiry: { type: 'quote', keyword: 'DEVIS' }, facts: [] },
    code: 'inquiryTest', target: null, prerequisites: [], network: 'instagram', accountId: 'ig-9001', observationDays: 7, requestType: 'quote', kind: 'inquiryTest', sourcePage: 'inbox', summary: 'Simulation.', proof: [], lineProof: 'Instagram @atelier_sim · 15 conversations, dont 3 d’origine inconnue', targetRef: null };
  const q = (id, state, n) => ({ type: 'qualify', at: `${shift(today(), -9)}T10:${String(n).padStart(2, '0')}:00.000Z`, planAt: iPlan, postId: 'sim_test1', id, state });
  const iEvents = [{ type: 'plan', at: iPlan, action: iSnap.proposal.action, metric: iSnap.proposal.metric, requestType: 'quote', baseline: 20, target: 30, reviewDate: REVIEW }, { type: 'applied', at: at(iApplied, 8), planAt: iPlan, date: iApplied, post: { id: 'sim_test1', url: 'https://www.instagram.com/reel/sim_test1/', network: 'instagram', accountId: 'ig-9001', declared: 'manual' }, prerequisites: 'none' },
    ...['c01', 'c02', 'c03', 'c04'].map((c, i) => q(c, 'qualified', i)), ...['c05', 'c06', 'c07', 'c08', 'c09', 'c10', 'c11', 'c12'].map((c, i) => q(c, 'not_qualified', 10 + i)), q('x1', 'qualified', 30)];
  const rq = (c, start, prov, post) => ({ id: `req:${IID}:${c}`, testId: IID, kind: 'conversation', conversationId: c, start, qualifiedOn: start, provenance: prov, postId: post, network: 'instagram', accountId: 'ig-9001', pagePath: null, label: null });
  const ev = (n, c, type, date, extra = {}) => ({ id: `ev_sim_${n}`, type, requestId: `req:${IID}:${c}`, date, ref: null, note: null, amount: null, currency: null, source: 'merchant', at: `${shift(today(), -5)}T09:0${n}:00.000Z`, ...extra });
  const pipe = { v: 1, requests: { [`req:${IID}:c01`]: rq('c01', shift(today(), -10), 'connection', 'sim_test1'), [`req:${IID}:c02`]: rq('c02', shift(today(), -9), 'connection', 'sim_test1'), [`req:${IID}:c03`]: rq('c03', shift(today(), -8), 'connection', 'sim_test1'), [`req:${IID}:x1`]: rq('x1', shift(today(), -9), 'unknown', null) },
    events: [ev(1, 'c01', 'quote_sent', shift(today(), -8), { ref: 'D-2026-014', note: 'plaque 30 cm, 20 pièces' }), ev(2, 'c01', 'sale_closed', shift(today(), -6), { amount: 240, currency: 'EUR' }), ev(3, 'c02', 'quote_sent', shift(today(), -8)), ev(4, 'c03', 'booking_confirmed', shift(today(), -7), { note: 'réservation directe, sans devis' }), ev(5, 'x1', 'sale_closed', shift(today(), -6), { amount: 90, currency: 'EUR' })] };
  const putPipe = `{ const k = ${JSON.stringify(`nordla.growth.pipeline.v1:${scope}`)}; if (!localStorage.getItem(k)) localStorage.setItem(k, JSON.stringify(${JSON.stringify(pipe)})); }`;
  return `(() => { try { ${put(ID, { snapshot, events })} ${put(SID, { snapshot: sSnap, events: sEvents })} ${put(QID, { snapshot: qSnap, events: qEvents })} ${put(IID, { snapshot: iSnap, events: iEvents })} ${putPipe} } catch (e) {} })();\n`;
};
http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/sim/scenario') { const n = url.searchParams.get('name'); if (['default', 'no-start', 'totals-only', 'low-volume', 'no-attribution'].includes(n)) scenario = n; res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end(`scenario: ${scenario}`); }
  if (url.pathname === '/sim/inbox') { const n = url.searchParams.get('name'); if (['default', 'no-attribution', 'zero', 'not-connected', 'unavailable'].includes(n)) inboxScenario = n; res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end(`inbox: ${inboxScenario}`); }
  if (url.pathname === '/sim/social') { const n = url.searchParams.get('step'); if (['none', 'draft', 'validated', 'scheduled', 'published', 'uncertain'].includes(n)) await buildCalendar(n); res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end(`calendar: ${pubStep}`); }
  if (url.pathname === '/sim/links') { // the other simulated screens, offered only when they are running (the simulation never contacts anything else)
    const up = async (u) => { try { const r = await fetch(u.split('#')[0], { signal: AbortSignal.timeout(800) }); return r.status < 500; } catch (e) { return false; } };
    const creator = 'http://127.0.0.1:4421/'; const social = 'http://127.0.0.1:8980/#t=sim-publication-sociale-0123456789-token';
    res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ creator: (await up(creator)) ? creator : null, social: (await up(social)) ? social : null }));
  }
  if (url.pathname === '/sim-guide.js' || url.pathname === '/sim-guide.css') { res.writeHead(200, { 'Content-Type': url.pathname.endsWith('.js') ? 'text/javascript; charset=utf-8' : 'text/css; charset=utf-8', 'Cache-Control': 'no-store' }); return res.end(await readFile(new URL(`./growth-sim-guide${url.pathname.endsWith('.js') ? '.js' : '.css'}`, import.meta.url), 'utf8')); }
  if (url.pathname === '/sim-seed.js') { res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-store' }); return res.end(await seed()); }
  if (url.pathname === '/') {
    const html = (await readFile(new URL('../src/growth/ui/index.html', import.meta.url), 'utf8')).replace('<script src="/opportunities.js"></script>', '<script src="/sim-seed.js"></script>\n<script src="/opportunities.js"></script>').replace('</body>', '<link rel="stylesheet" href="/sim-guide.css">\n<script src="/sim-guide.js"></script>\n</body>');
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; font-src 'self'; connect-src 'self'; frame-ancestors 'none'" }); return res.end(html);
  }
  return handler(req, res);
}).listen(PORT, '127.0.0.1', () => console.log(`Growth SIMULATION (fictitious data) at http://127.0.0.1:${PORT}/#/opportunities`));
