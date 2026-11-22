// /api/core/* on the server that holds the merchant's sourcing cases. Mounted INSIDE the server's /api authorisation: on a hosted server
// every call already carries a valid Nordla session (and CSRF for a POST); the person's user id and role come from that session, never
// from the request body. On a local PC server (development token) the token holder is the owner of that PC: the journal says LOCAL_TOKEN.
//   GET  /api/core/status                      what the Core is connected to, and its limits
//   GET  /api/core/decisions[?case=<id>]        the decision journal (all, or one case)
//   POST /api/core/cases/<id>/analyse           Subject -> Levers -> Decision for the case as held by the server
//   POST /api/core/decisions/<entry>/human      { decision, reason, chosen_lever_ids? }   the human decision
//   POST /api/core/decisions/<entry>/result     { result, evidence_level?, notes? }       the follow-up
//   POST /api/core/ask                          { text, caseId? }                         Parle à Nordla (text)
//   GET/POST /api/core/creation, GET /api/core/creation/<id>.png, POST /api/core/creation/<id>/decision   local visual (no provider)
import { CoreError } from './runtime.js';
import { askNordla, NOT_CONNECTED } from './ask.js';
import { issueTicket, ANALYTICS_SSO_AUDIENCE } from '../finance/sso-ticket.js';
import { issueHandoff, HANDOFF_DESTINATIONS, HANDOFF_MIN_SECRET_LENGTH } from '../identity/handoff.js';
import { validateConversation } from './field-context.js';
import { creativeCapability } from './campaign.js';
import { decideModuleOpen } from '../identity/module-catalog.js';
import { loadSalesHome } from './sales-home.js';
import { FINANCE_INBOX_ROLES } from '../identity/permissions.js';

const ID = '([A-Za-z0-9_-]{1,80})';
const MAX = 64 * 1024;
const MAX_PHOTO_BODY = 9 * 1024 * 1024; // a 6 MB photo, base64 in JSON

export function presentDecision(v) {
  if (!v) return null;
  const e = v.entry; const s = v.subject;
  return {
    id: e.id, case_id: v.source?.case_id ?? null, case_version: v.source?.case_version ?? null, created_at: e.created_at,
    subject: { id: s.id, title: s.title, status: s.status, confidence: s.confidence, materiality: s.materiality, currency: s.currency },
    facts: e.facts_used.map((f) => ({ key: f.key, value: f.value, unit: f.unit, source: f.source_ref })),
    missing_data: s.missing_data,
    recommendation: e.recommendation ? { kind: e.recommendation.kind, label: e.recommendation.label, lever_ids: e.recommendation.lever_ids, rationale: e.recommendation.rationale, tests_lever_id: e.recommendation.tests_lever_id } : null,
    options: [
      ...e.options.remaining.map((r) => ({ lever_id: r.lever_id, label: r.label, status: 'ELIGIBLE', required_approval: r.required_approval, axes: r.axes, reasons: r.dominated_by.length ? [`dominé par ${r.dominated_by.join(', ')}`] : [] })),
      ...e.options.eliminated.map((x) => ({ lever_id: x.lever_id, label: x.label, status: 'ELIMINATED', stage: x.stage, reasons: x.reasons })),
    ],
    rules: e.rules_applied, approval_status: e.approval_status,
    human_decision: e.human_decision, result: e.result, sourcing: v.source?.assessment ?? null,
    executes_nothing: true,
  };
}

/** The https origin of the hosted Growth screen (GROWTH_PUBLIC_URL), or null: no origin, no link (a missing or malformed value is never turned into a guess). */
export function growthOrigin(env) { return httpsOrigin(env?.GROWTH_PUBLIC_URL); }
/** Same rule for any module address given by the environment (ANALYTICS_PUBLIC_URL, ...). */
export function httpsOrigin(value) { try { const u = new URL(String(value ?? '').trim()); return u.protocol === 'https:' && !u.username && !u.password ? u.origin : null; } catch { return null; } }

/** Growth single sign-on: the https origin (GROWTH_PUBLIC_URL) AND GROWTH_SSO_SECRET (server-side only, 24+ characters, the same on the Growth server). Anything missing: null (the links stay plain links and Growth asks its own sign-in). */
export function growthSsoConfig(env, merchantId) { const origin = growthOrigin(env); const secret = String(env?.GROWTH_SSO_SECRET ?? ''); return origin && secret.length >= HANDOFF_MIN_SECRET_LENGTH && merchantId ? { origin, secret, merchantId } : null; }

export function createCoreHttp({ runtime, configError = null, store, externals = async () => ({}), finance = null, analytics = null, procurement = null, branding = null, campaigns = null, creation = null, financeSso = null, analyticsSso = null, merchantIdentity = null, merchantId = null, entitlements = null, env = process.env }) {
  // Server-Timing: Core's own processing time for the answer (durations only, nothing secret)
  const json = (res, status, body) => { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...(res.__t0 !== undefined ? { 'server-timing': `core;dur=${(performance.now() - res.__t0).toFixed(1)}` } : {}) }); res.end(JSON.stringify(body)); };
  // ACTIVE module codes of THIS merchant, read on each call. No reader, or a failed read: nothing is active (default deny).
  async function activeModules() { if (typeof entitlements !== 'function') return new Set(); try { const s = await entitlements(); return s instanceof Set ? s : new Set(); } catch { return new Set(); } }
  const refusalOf = (decision) => ({ status: 403, body: { error: decision.code, message: 'Ce module n’est pas ouvert pour votre compte ou votre rôle.' } });
  async function body(req, max = MAX) {
    const chunks = []; let n = 0;
    for await (const c of req) { n += c.length; if (n > max) throw new CoreError('BODY_TOO_LARGE', 'requête trop grande', 413); chunks.push(c); }
    const raw = Buffer.concat(chunks).toString('utf8'); if (!raw) return {};
    try { return JSON.parse(raw); } catch { throw new CoreError('INVALID_JSON', 'JSON invalide'); }
  }
  const status = async () => (runtime ? { enabled: true, ...(({ decisions, ...o }) => o)(await runtime.overview()) } : { enabled: false, reason: configError ?? 'CORE_NOT_CONFIGURED' });

  /** The seven modules as they REALLY are on this server (what answers, what is limited, what is missing and why). Offline: Sourcing only. */
  async function modules(actor = null) {
    const role = actor?.role ?? null; // Phase 6: the state shown for a module is the decision the open route would take for THIS role
    const openable = (key, active) => decideModuleOpen({ key, role, activeCodes: active }).ok;
    const b = branding ? await branding.status() : { status: 'NOT_CONNECTED' };
    const c = creativeCapability(env);
    const active = await activeModules(); // what this merchant may use: a module without an ACTIVE entitlement is shown as not activated
    const row =(key, label, state, detail, offline = false) => ({ key, label, state, detail, offline });
    return { modules: [
      row('core', 'Nordla Core', runtime ? 'DISPONIBLE' : 'NON CONFIGURÉ', runtime ? 'Sujets d’achat, décisions humaines, suivi, journal.' : String(configError ?? '')),
      { dashboard: Boolean(finance && financeSso && openable('finance', active)), ...row('finance', 'Finance', !active.has('finance') ? 'NON ACTIVÉ' : !openable('finance', active) ? 'ACCÈS RÉSERVÉ' : finance ? 'LECTURE SEULE' : 'NON RACCORDÉ', !active.has('finance') ? 'Module non activé pour ce commerce.' : finance ?`Factures à payer, échéances, trésorerie, achats — ${finance.source}. Aucun paiement.` : NOT_CONNECTED.FINANCE) },
      { dashboard: Boolean(analytics && analyticsSso && openable('analytics', active)), ...row('analytics', 'Analytics', !active.has('analytics') ? 'NON ACTIVÉ' : !openable('analytics', active) ? 'ACCÈS RÉSERVÉ' : analytics ? 'LECTURE SEULE' : 'NON RACCORDÉ', !active.has('analytics') ? 'Module non activé pour ce commerce.' : analytics ? `Évolution des ventes, produits et canaux — ${analytics.source}.` : NOT_CONNECTED.ANALYTICS), ...(active.has('analytics') && httpsOrigin(env?.ANALYTICS_PUBLIC_URL) ?{ analytics_url: httpsOrigin(env.ANALYTICS_PUBLIC_URL) } : {}) },
      row('procurement', 'Stock / Achats', procurement ? 'DISPONIBLE' : 'NON RACCORDÉ', procurement ? 'Commandes d’achat, réceptions, stock : consultation par Parle à Nordla ; commander, approuver et réceptionner passent par l’écran Achats (approbation nommée).' : NOT_CONNECTED.STOCK_SALES),
      row('sourcing', 'Sourcing', 'DISPONIBLE', 'Dossiers, photos, analyses d’achat ; fonctionne hors ligne.', true),
      row('branding', 'Branding', b.status === 'APPROVED' ? 'DISPONIBLE' : b.status === 'PROPOSED_NOT_APPROVED' ? 'À APPROUVER' : 'NON RACCORDÉ', b.status === 'APPROVED' ? 'Règles de marque approuvées : vérification officielle.' : b.status === 'PROPOSED_NOT_APPROVED' ? 'Proposition de règles de marque en attente de votre approbation : vérification indicative seulement.' : 'Aucune règle de marque.'),
      row('marketing', 'Marketing', campaigns ? 'LIMITÉ' : 'NON RACCORDÉ', 'Proposition de campagne (contrat, contrôles marque et stock) et décision humaine. Aucune diffusion possible.'),
      creation && creation.status().status === 'LOCAL_AVAILABLE'
        ? row('creative', 'Création', 'LIMITÉ', `Visuel local disponible : votre photo telle quelle + un titre (${creation.status().typography}), PNG et contrôles de fidélité. Génération IA : ${c.status === 'PROVIDER_NOT_CONNECTED' ? 'aucun fournisseur connecté' : 'à vérifier'}.`)
        : row('creative', 'Création', c.status === 'PROVIDER_NOT_CONNECTED' ? 'BLOQUÉ' : 'À VÉRIFIER', c.status === 'PROVIDER_NOT_CONNECTED' ? `Aucun fournisseur de génération connecté (${c.missing.join(', ') || c.error}). Rien n’est produit ni simulé.` : c.note),
      ...(growthOrigin(env) ? [{ ...row('growth', 'Développement des ventes', active.has('growth') ? 'DISPONIBLE' : 'NON ACTIVÉ', active.has('growth') ? 'Opportunités, produits, audience, abandons des visiteurs : écran dédié, ouvert dans un nouvel onglet'+(growthSsoConfig(env, merchantId) ? ' avec votre session Nordla (aucune seconde connexion).' : ' avec la même adresse e-mail Nordla (connexion demandée).') : 'Module non activé pour ce commerce.'), growth_url: active.has('growth') ? growthOrigin(env) : null, growth_sso: active.has('growth') && Boolean(growthSsoConfig(env, merchantId)) }] : []),
    ].map((m) => (m.key === 'core' ? { ...m, connections_screen: env?.NORDLA_CONNECTIONS_MODULE === '1' } : m.key === 'creative' ? { ...m, creator_screen: env?.NORDLA_CREATOR_MODULE === '1' } : m.key === 'marketing' ? { ...m, gbp_screen: env?.NORDLA_GBP_DRAFTS_MODULE === '1', video_screen: env?.NORDLA_VIDEO_DRAFTS_MODULE === '1' } : m)) }; // the Creator screen exists only where the isolated module is built
  }

  /** @returns {Promise<boolean>} true when the request was a /api/core route (answered). `actor` = { userId?, role, label? } from the server's authorisation. */
  async function handle(req, res, url, actor) {
    res.__t0 = performance.now();
    const p = url.pathname; const m = req.method;
    if (!p.startsWith('/api/core/')) return false;
    try {
      if (p === '/api/core/status' && m === 'GET') {
        json(res, 200, { ...(await status()), merchant: await merchantIdentity?.().catch(() => null) ?? null, connected: { china_sourcing: 'CONNECTED', socle_decision: runtime ? 'CONNECTED' : 'NOT_CONFIGURED', finance: finance ? `READ_ONLY (${finance.source})` : 'NOT_CONNECTED', stock_achats: procurement ? 'READ_ONLY' : 'NOT_CONNECTED', analytics: analytics ? `READ_ONLY (${analytics.source})` : 'NOT_CONNECTED' }, not_connected: Object.fromEntries(Object.entries(NOT_CONNECTED).filter(([k]) => !((k === 'FINANCE' && finance) || (k === 'ANALYTICS' && analytics) || (k === 'STOCK_SALES' && procurement)))), executes_actions: false, you: { role: actor.role, auth: actor.userId ? 'NORDLA_SESSION' : 'LOCAL_TOKEN' } });
        return true;
      }
      if (p === '/api/core/ask' && m === 'POST') {
        const b = await body(req);
        const conversation = 'conversation' in b ? validateConversation(b.conversation) : undefined; // opt-in; client state is rebuilt, never trusted
        const active = await activeModules();
        const readAccess = Object.fromEntries(['finance', 'analytics'].map((key) => [key, decideModuleOpen({ key, role: actor?.role ?? null, activeCodes: active })]));
        json(res, 200, await askNordla({ text: String(b.text ?? '').slice(0, 1000), caseId: typeof b.caseId === 'string' ? b.caseId : null }, { runtime, getCase: (id) => store.get(id), externals: await externals(), actor, finance, analytics, procurement, conversation, readAccess }));
        return true;
      }
      if (p === '/api/core/finance/open' && m === 'POST') { // a one-time ticket to open the Finance dashboard on its own domain with THIS session: no token typed, no secret sent
        if (!financeSso) { json(res, 503, { error: 'NOT_CONNECTED' }); return true; }
        const fin = decideModuleOpen({ key: 'finance', role: actor?.role ?? null, activeCodes: await activeModules() });
        if (!fin.ok) { const r = refusalOf(fin); json(res, r.status, r.body); return true; }
        if (!actor?.userId) { json(res, 409, { error: 'NOT_AVAILABLE', message: 'single sign-on needs a signed-in Nordla account' }); return true; }
        const ticket = issueTicket({ secret: financeSso.secret, merchantId: financeSso.merchantId, ttlSeconds: 60, person: { userId: actor.userId, role: actor.role, module: 'finance', ...(actor.sessionId ? { authSessionId: actor.sessionId } : {}) } });
        const ob = await body(req).catch(() => ({})); const dossier = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(ob?.dossier ?? '')) ? `&open=${String(ob.dossier).toLowerCase()}` : ''; // a navigation hint only (the file to land on): it grants nothing, Finance still reads it under the signed-in session
        // same tab, under the Core origin: the gateway (/finance/*) forwards /sso to the Finance service
        json(res, 200, { url: `${financeSso.publicUrl}/finance/sso?t=${ticket}${dossier}`, expiresInSeconds: 60 }); return true;
      }
      if (p === '/api/core/sales' && m === 'GET') { // the Core home sales tiles: read-only, same rights as opening Analytics; never a figure of its own (see sales-home.js)
        const ana = decideModuleOpen({ key: 'analytics', role: actor?.role ?? null, activeCodes: await activeModules() });
        if (!ana.ok) { const r = refusalOf(ana); json(res, r.status, r.body); return true; }
        if (!analyticsSso || !actor?.userId) { json(res, 200, { status: 'NOT_CONNECTED', source: 'Analytics' }); return true; } // no Analytics link, or no personal Nordla session to read it with
        const ticket = issueTicket({ secret: analyticsSso.secret, merchantId: analyticsSso.merchantId, audience: ANALYTICS_SSO_AUDIENCE, ttlSeconds: 60, person: { userId: actor.userId, role: actor.role, module: 'analytics', ...(actor.sessionId ? { authSessionId: actor.sessionId } : {}) } });
        json(res, 200, await loadSalesHome({ publicUrl: analyticsSso.publicUrl, ticket })); return true;
      }
      if (p === '/api/core/analytics/open' && m === 'POST') { // a one-time ticket to open the Analytics dashboard on its own domain with THIS Nordla session: no access token typed. Same audience of people as the Finance dashboard.
        if (!analyticsSso) { json(res, 503, { error: 'NOT_CONNECTED' }); return true; }
        const ana = decideModuleOpen({ key: 'analytics', role: actor?.role ?? null, activeCodes: await activeModules() });
        if (!ana.ok) { const r = refusalOf(ana); json(res, r.status, r.body); return true; }
        if (!actor?.userId) { json(res, 409, { error: 'NOT_AVAILABLE', message: 'single sign-on needs a signed-in Nordla account' }); return true; }
        const ticket = issueTicket({ secret: analyticsSso.secret, merchantId: analyticsSso.merchantId, audience: ANALYTICS_SSO_AUDIENCE, ttlSeconds: 60, person: { userId: actor.userId, role: actor.role, module: 'analytics', ...(actor.sessionId ? { authSessionId: actor.sessionId } : {}) } });
        json(res, 200, { url: `${analyticsSso.publicUrl}/sso?t=${ticket}`, expiresInSeconds: 60 }); return true;
      }
      if (p === '/api/core/growth/open' && m === 'POST') { // a one-time ticket to open Growth on its own domain with THIS Nordla session (no second sign-in). Any signed-in person may ask: Growth re-checks membership, module and role itself.
        const sso = growthSsoConfig(env, merchantId);
        if (!sso) { json(res, 503, { error: 'NOT_CONNECTED' }); return true; }
        if (!actor?.userId) { json(res, 409, { error: 'NOT_AVAILABLE', message: 'single sign-on needs a signed-in Nordla account' }); return true; }
        const gro = decideModuleOpen({ key: 'growth', role: actor?.role ?? null, activeCodes: await activeModules() });
        if (!gro.ok) { const r = refusalOf(gro); json(res, r.status, r.body); return true; }
        const b = await body(req); const to = b.to === undefined ? 'dropoff' : String(b.to);
        if (!Object.hasOwn(HANDOFF_DESTINATIONS, to)) { json(res, 400, { error: 'INVALID_DESTINATION' }); return true; }
        const ticket = issueHandoff({ secret: sso.secret, merchantId: sso.merchantId, userId: actor.userId, authSessionId: actor.sessionId, ttlSeconds: 60 });
        json(res, 200, { url: `${sso.origin}/sso?t=${ticket}&to=${to}`, expiresInSeconds: 60 }); return true;
      }
      if (p === '/api/core/finance/inbox' && m === 'GET') { // read-only list of the Finance supplier-invoice inbox of THIS server's merchant; owner, administrator and accountant only
        if (!finance?.inbox) { json(res, 503, { error: 'NOT_CONNECTED' }); return true; }
        if (!FINANCE_INBOX_ROLES.includes(String(actor?.role ?? ''))) { json(res, 403, { error: 'FORBIDDEN', message: 'the Finance inbox is for the owner, an administrator or the accountant' }); return true; }
        if (!(await activeModules()).has('finance')) { const denied = refusalOf({ code: 'MODULE_NOT_ENABLED' }); json(res, denied.status, denied.body); return true; }
        json(res, 200, await finance.inbox()); return true;
      }
      if (p === '/api/core/modules' && m === 'GET') { json(res, 200, await modules(actor)); return true; }
      if (p === '/api/core/branding' && m === 'GET') { json(res, 200, branding ? await branding.status() : { status: 'NOT_CONNECTED' }); return true; }
      if (p === '/api/core/branding/check' && m === 'POST') { if (!branding) { json(res, 503, { error: 'NOT_CONNECTED' }); return true; } const b = await body(req); json(res, 200, await branding.checkText(String(b.text ?? '').slice(0, 4000))); return true; }
      if (p === '/api/core/branding/approve' && m === 'POST') { if (!branding) { json(res, 503, { error: 'NOT_CONNECTED' }); return true; } json(res, 200, await branding.approve(actor)); return true; }
      if (p === '/api/core/campaigns' && m === 'GET') { json(res, 200, { campaigns: campaigns ? await campaigns.list() : [] }); return true; }
      if (p === '/api/core/campaigns' && m === 'POST') { if (!campaigns) { json(res, 503, { error: 'NOT_CONNECTED' }); return true; } const b = await body(req); json(res, 200, await campaigns.prepare({ product: b.product, objective: b.objective, audience: b.audience, channel: b.channel, copy: String(b.copy ?? '').slice(0, 2000) }, actor)); return true; }
      const cd = /^\/api\/core\/campaigns\/([^/]{1,200})\/decision$/.exec(p);
      if (cd && m === 'POST') { if (!campaigns) { json(res, 503, { error: 'NOT_CONNECTED' }); return true; } const b = await body(req); json(res, 200, await campaigns.decide(decodeURIComponent(cd[1]), b, actor)); return true; }
      if (p === '/api/core/creation' && m === 'GET') { json(res, 200, creation ? { ...creation.status(), creations: await creation.list() } : { status: 'NOT_CONNECTED', creations: [] }); return true; }
      if (p === '/api/core/creation' && m === 'POST') {
        if (!creation) { json(res, 503, { error: 'NOT_CONNECTED' }); return true; }
        const b = await body(req, MAX_PHOTO_BODY);
        const b64 = String(b.photo ?? '').replace(/^data:image\/(jpeg|png);base64,/, '');
        if (!/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) throw new CoreError('PHOTO_REQUIRED', 'Photo manquante ou illisible.');
        json(res, 200, await creation.render({ photo: new Uint8Array(Buffer.from(b64, 'base64')), headline: b.headline }, actor)); return true;
      }
      const ci = /^\/api\/core\/creation\/(cr-[0-9a-f]{16})\.png$/.exec(p);
      if (ci && m === 'GET') {
        const png = creation ? await creation.image(ci[1]) : null;
        if (!png) { json(res, 404, { error: 'NOT_FOUND' }); return true; }
        res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff', 'content-disposition': `inline; filename="${ci[1]}.png"` }); res.end(png); return true;
      }
      const cr = /^\/api\/core\/creation\/(cr-[0-9a-f]{16})\/decision$/.exec(p);
      if (cr && m === 'POST') { if (!creation) { json(res, 503, { error: 'NOT_CONNECTED' }); return true; } const b = await body(req); json(res, 200, await creation.decide(cr[1], b, actor)); return true; }
      if (!runtime) { json(res, 503, { error: 'CORE_NOT_CONFIGURED', reason: configError }); return true; }
      if (p === '/api/core/decisions' && m === 'GET') {
        const c = url.searchParams.get('case');
        const list = c ? await runtime.forCase(c) : (await runtime.overview()).decisions;
        json(res, 200, { decisions: list.map(presentDecision) });
        return true;
      }
      let r = new RegExp(`^/api/core/cases/${ID}/analyse$`).exec(p);
      if (r && m === 'POST') {
        const c = await store.get(r[1]); if (!c) { json(res, 404, { error: 'CASE_NOT_ON_SERVER', message: 'Ce dossier n’est pas encore sur le serveur : synchronisez-le d’abord.' }); return true; }
        const out = await runtime.analyseCase(c, { externals: await externals(), actor });
        json(res, 200, { status: out.status, reason: out.reason ?? null, decision: presentDecision(out.entry ? out : null) });
        return true;
      }
      r = new RegExp(`^/api/core/decisions/${ID}/(human|result)$`).exec(p);
      if (r && m === 'POST') {
        const b = await body(req);
        const v = r[2] === 'human' ? await runtime.decideHuman(r[1], b, actor) : await runtime.recordResult(r[1], b, actor);
        json(res, 200, { decision: presentDecision(v) });
        return true;
      }
      json(res, 404, { error: 'NOT_FOUND' }); return true;
    } catch (e) {
      if (e instanceof CoreError || (e?.code && e?.status)) { json(res, e.status, { error: e.code, message: e.message }); return true; }
      throw e;
    }
  }
  return { handle };
}
