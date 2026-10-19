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
import { validateConversation } from './field-context.js';
import { creativeCapability } from './campaign.js';

const ID = '([A-Za-z0-9_-]{1,80})';
// Who may CREATE records in the Core (a campaign proposal, a local visual). VIEWER and ACCOUNTANT read; they do not write. (Decisions and approvals have their own, stricter role tables.)
const CAN_PROPOSE = new Set(['OWNER', 'ADMIN', 'COLLABORATOR']);
const mayPropose = (actor) => { if (!CAN_PROPOSE.has(actor?.role)) throw new CoreError('FORBIDDEN_ROLE', 'votre rôle peut consulter mais pas créer de proposition ni de visuel', 403); };
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

export function createCoreHttp({ runtime, configError = null, store, externals = async () => ({}), finance = null, analytics = null, procurement = null, branding = null, campaigns = null, creation = null, social = null, env = process.env }) {
  const json = (res, status, body) => { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }); res.end(JSON.stringify(body)); };
  async function body(req, max = MAX) {
    const chunks = []; let n = 0;
    for await (const c of req) { n += c.length; if (n > max) throw new CoreError('BODY_TOO_LARGE', 'requête trop grande', 413); chunks.push(c); }
    const raw = Buffer.concat(chunks).toString('utf8'); if (!raw) return {};
    try { return JSON.parse(raw); } catch { throw new CoreError('INVALID_JSON', 'JSON invalide'); }
  }
  const status = async () => (runtime ? { enabled: true, ...(({ decisions, ...o }) => o)(await runtime.overview()) } : { enabled: false, reason: configError ?? 'CORE_NOT_CONFIGURED' });

  /** The seven modules as they REALLY are on this server (what answers, what is limited, what is missing and why). Offline: Sourcing only. */
  async function modules() {
    const b = branding ? await branding.status() : { status: 'NOT_CONNECTED' };
    const c = creativeCapability(env);
    const row = (key, label, state, detail, offline = false) => ({ key, label, state, detail, offline });
    // Social Publishing: read-only counts from its own app's data directory, only when the operator pointed this server at it (SOCIAL_DATA_DIR). Otherwise it is not connected - said so.
    let socialRow;
    if (!social) socialRow = row('social', 'Publication sociale', 'NON RACCORDÉ', 'Social Publishing est une application à part (npm run social, sur le poste, avec sa propre approbation signée). Elle n’est pas reliée à ce serveur : rien n’est publié d’ici.');
    else {
      try {
        const s = await social.summary();
        const sim = s.mode === 'live' ? 'mode réel' : s.mode === 'simulate' ? 'mode SIMULÉ (rien n’est publié)' : 'aucune plateforme connectée (publication à la main)';
        socialRow = row('social', 'Publication sociale', s.error ? 'À VÉRIFIER' : 'LECTURE SEULE', `${s.total} publication(s) au calendrier, ${s.awaiting_owner} à valider par vous dans l’application Social ; prochaine : ${s.next_due ?? 'aucune planifiée'} ; ${sim}. Approuver, planifier et publier se font uniquement dans l’application Social, jamais depuis cet écran.${s.error ? ' Certaines publications n’ont pas pu être lues.' : ''}`);
      } catch { socialRow = row('social', 'Publication sociale', 'À VÉRIFIER', 'Le dossier de Social Publishing n’a pas pu être lu.'); }
    }
    return { modules: [
      row('core', 'Nordla Core', runtime ? 'DISPONIBLE' : 'NON CONFIGURÉ', runtime ? 'Sujets d’achat, décisions humaines, suivi, journal.' : String(configError ?? '')),
      row('finance', 'Finance', finance ? 'LECTURE SEULE' : 'NON RACCORDÉ', finance ? `Factures à payer, échéances, trésorerie, achats — ${finance.source}. Aucun paiement.` : NOT_CONNECTED.FINANCE),
      row('analytics', 'Analytics', analytics ? 'LECTURE SEULE' : 'NON RACCORDÉ', analytics ? `Évolution des ventes, produits et canaux — ${analytics.source}.` : NOT_CONNECTED.ANALYTICS),
      row('procurement', 'Stock / Achats', procurement ? 'DISPONIBLE' : 'NON RACCORDÉ', procurement ? 'Commandes d’achat, réceptions, stock : consultation par Parle à Nordla ; commander, approuver et réceptionner passent par l’écran Achats (approbation nommée).' : NOT_CONNECTED.STOCK_SALES),
      row('sourcing', 'China Sourcing', 'DISPONIBLE', 'Dossiers, photos, analyses d’achat ; fonctionne hors ligne.', true),
      row('branding', 'Branding', b.status === 'APPROVED' ? 'DISPONIBLE' : b.status === 'PROPOSED_NOT_APPROVED' ? 'À APPROUVER' : 'NON RACCORDÉ', b.status === 'APPROVED' ? 'Règles de marque approuvées : vérification officielle.' : b.status === 'PROPOSED_NOT_APPROVED' ? 'Proposition de règles de marque en attente de votre approbation : vérification indicative seulement.' : 'Aucune règle de marque.'),
      row('marketing', 'Marketing', campaigns ? 'LIMITÉ' : 'NON RACCORDÉ', 'Proposition de campagne (contrat, contrôles marque et stock) et décision humaine. Aucune diffusion possible.'),
      creation && creation.status().status === 'LOCAL_AVAILABLE'
        ? row('creative', 'Création', 'LIMITÉ', `Visuel local disponible : votre photo telle quelle + un titre (${creation.status().typography}), PNG et contrôles de fidélité. Génération IA : ${c.status === 'PROVIDER_NOT_CONNECTED' ? 'aucun fournisseur connecté' : 'à vérifier'}.`)
        : row('creative', 'Création', c.status === 'PROVIDER_NOT_CONNECTED' ? 'BLOQUÉ' : 'À VÉRIFIER', c.status === 'PROVIDER_NOT_CONNECTED' ? `Aucun fournisseur de génération connecté (${c.missing.join(', ') || c.error}). Rien n’est produit ni simulé.` : c.note),
      row('parle', 'Parle à Nordla', 'LIMITÉ', 'Questions en texte (dictée du navigateur si activée), réponses calculées avec leurs sources, sans modèle d’IA : dossiers d’achat, décisions, Stock / Achats, Finance et Analyses quand ils sont raccordés. Marketing et Création ne sont pas interrogeables ; il ne commande, ne paie ni n’approuve jamais.'),
      row('validations', 'Règles et validations', runtime ? 'LIMITÉ' : 'NON CONFIGURÉ', runtime ? 'Décisions humaines du Core (journal), approbation nommée des commandes d’achat, règles de marque, décisions de campagne et de visuel : chacune a son propre contrôle ; il n’existe pas encore de file d’approbation unique. Finance n’a pas de double contrôle (la même personne peut créer, approuver et envoyer).' : String(configError ?? '')),
      socialRow,
      row('activation', 'Diffusion et connexions', 'NON RACCORDÉ', 'Adaptateurs Instagram, TikTok et Google testés avec des simulations ; aucun compte connecté, aucun écran de connexion (outil en ligne de commande seulement). Rien n’est diffusé.'),
      row('growth', 'Développement des ventes', 'NON RACCORDÉ', 'Écran local séparé (npm run growth) sans authentification : volontairement non exposé sur ce serveur.'),
    ] };
  }

  /** @returns {Promise<boolean>} true when the request was a /api/core route (answered). `actor` = { userId?, role, label? } from the server's authorisation. */
  async function handle(req, res, url, actor) {
    const p = url.pathname; const m = req.method;
    if (!p.startsWith('/api/core/')) return false;
    try {
      if (p === '/api/core/status' && m === 'GET') {
        json(res, 200, { ...(await status()), connected: { china_sourcing: 'CONNECTED', socle_decision: runtime ? 'CONNECTED' : 'NOT_CONFIGURED', finance: finance ? `READ_ONLY (${finance.source})` : 'NOT_CONNECTED', stock_achats: procurement ? 'READ_ONLY' : 'NOT_CONNECTED', analytics: analytics ? `READ_ONLY (${analytics.source})` : 'NOT_CONNECTED' }, not_connected: Object.fromEntries(Object.entries(NOT_CONNECTED).filter(([k]) => !((k === 'FINANCE' && finance) || (k === 'ANALYTICS' && analytics) || (k === 'STOCK_SALES' && procurement)))), executes_actions: false, you: { role: actor.role, auth: actor.userId ? 'NORDLA_SESSION' : 'LOCAL_TOKEN' } });
        return true;
      }
      if (p === '/api/core/ask' && m === 'POST') {
        const b = await body(req);
        const conversation = 'conversation' in b ? validateConversation(b.conversation) : undefined; // opt-in; client state is rebuilt, never trusted
        json(res, 200, await askNordla({ text: String(b.text ?? '').slice(0, 1000), caseId: typeof b.caseId === 'string' ? b.caseId : null }, { runtime, getCase: (id) => store.get(id), externals: await externals(), actor, finance, analytics, procurement, conversation }));
        return true;
      }
      if (p === '/api/core/modules' && m === 'GET') { json(res, 200, await modules()); return true; }
      if (p === '/api/core/branding' && m === 'GET') { json(res, 200, branding ? await branding.status() : { status: 'NOT_CONNECTED' }); return true; }
      if (p === '/api/core/branding/check' && m === 'POST') { if (!branding) { json(res, 503, { error: 'NOT_CONNECTED' }); return true; } const b = await body(req); json(res, 200, await branding.checkText(String(b.text ?? '').slice(0, 4000))); return true; }
      if (p === '/api/core/branding/approve' && m === 'POST') { if (!branding) { json(res, 503, { error: 'NOT_CONNECTED' }); return true; } json(res, 200, await branding.approve(actor)); return true; }
      if (p === '/api/core/campaigns' && m === 'GET') { json(res, 200, { campaigns: campaigns ? await campaigns.list() : [] }); return true; }
      if (p === '/api/core/campaigns' && m === 'POST') { mayPropose(actor); if (!campaigns) { json(res, 503, { error: 'NOT_CONNECTED' }); return true; } const b = await body(req); json(res, 200, await campaigns.prepare({ product: b.product, objective: b.objective, audience: b.audience, channel: b.channel, copy: String(b.copy ?? '').slice(0, 2000) }, actor)); return true; }
      const cd = /^\/api\/core\/campaigns\/([^/]{1,200})\/decision$/.exec(p);
      if (cd && m === 'POST') { if (!campaigns) { json(res, 503, { error: 'NOT_CONNECTED' }); return true; } const b = await body(req); json(res, 200, await campaigns.decide(decodeURIComponent(cd[1]), b, actor)); return true; }
      if (p === '/api/core/creation' && m === 'GET') { json(res, 200, creation ? { ...creation.status(), creations: await creation.list() } : { status: 'NOT_CONNECTED', creations: [] }); return true; }
      if (p === '/api/core/creation' && m === 'POST') {
        mayPropose(actor);
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
