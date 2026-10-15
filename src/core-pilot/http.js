// /api/core/* on the server that holds the merchant's sourcing cases. Mounted INSIDE the server's /api authorisation: on a hosted server
// every call already carries a valid Nordla session (and CSRF for a POST); the person's user id and role come from that session, never
// from the request body. On a local PC server (development token) the token holder is the owner of that PC: the journal says LOCAL_TOKEN.
//   GET  /api/core/status                      what the Core is connected to, and its limits
//   GET  /api/core/decisions[?case=<id>]        the decision journal (all, or one case)
//   POST /api/core/cases/<id>/analyse           Subject -> Levers -> Decision for the case as held by the server
//   POST /api/core/decisions/<entry>/human      { decision, reason, chosen_lever_ids? }   the human decision
//   POST /api/core/decisions/<entry>/result     { result, evidence_level?, notes? }       the follow-up
//   POST /api/core/ask                          { text, caseId? }                         Parle à Nordla (text)
import { CoreError } from './runtime.js';
import { askNordla, NOT_CONNECTED } from './ask.js';
import { creativeCapability } from './campaign.js';

const ID = '([A-Za-z0-9_-]{1,80})';
const MAX = 64 * 1024;

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

export function createCoreHttp({ runtime, configError = null, store, externals = async () => ({}), finance = null, analytics = null, branding = null, campaigns = null, env = process.env }) {
  const json = (res, status, body) => { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }); res.end(JSON.stringify(body)); };
  async function body(req) {
    const chunks = []; let n = 0;
    for await (const c of req) { n += c.length; if (n > MAX) throw new CoreError('BODY_TOO_LARGE', 'requête trop grande', 413); chunks.push(c); }
    const raw = Buffer.concat(chunks).toString('utf8'); if (!raw) return {};
    try { return JSON.parse(raw); } catch { throw new CoreError('INVALID_JSON', 'JSON invalide'); }
  }
  const status = async () => (runtime ? { enabled: true, ...(({ decisions, ...o }) => o)(await runtime.overview()) } : { enabled: false, reason: configError ?? 'CORE_NOT_CONFIGURED' });

  /** The seven modules as they REALLY are on this server (what answers, what is limited, what is missing and why). Offline: Sourcing only. */
  async function modules() {
    const b = branding ? await branding.status() : { status: 'NOT_CONNECTED' };
    const c = creativeCapability(env);
    const row = (key, label, state, detail, offline = false) => ({ key, label, state, detail, offline });
    return { modules: [
      row('core', 'Nordla Core', runtime ? 'DISPONIBLE' : 'NON CONFIGURÉ', runtime ? 'Sujets d’achat, décisions humaines, suivi, journal.' : String(configError ?? '')),
      row('finance', 'Finance', finance ? 'LECTURE SEULE' : 'NON RACCORDÉ', finance ? `Factures à payer, échéances, trésorerie, achats — ${finance.source}. Aucun paiement.` : NOT_CONNECTED.FINANCE),
      row('analytics', 'Analytics', analytics ? 'LECTURE SEULE' : 'NON RACCORDÉ', analytics ? `Évolution des ventes, produits et canaux — ${analytics.source}.` : NOT_CONNECTED.ANALYTICS),
      row('sourcing', 'China Sourcing', 'DISPONIBLE', 'Dossiers, photos, analyses d’achat ; fonctionne hors ligne.', true),
      row('branding', 'Branding', b.status === 'APPROVED' ? 'DISPONIBLE' : b.status === 'PROPOSED_NOT_APPROVED' ? 'À APPROUVER' : 'NON RACCORDÉ', b.status === 'APPROVED' ? 'Règles de marque approuvées : vérification officielle.' : b.status === 'PROPOSED_NOT_APPROVED' ? 'Proposition de règles de marque en attente de votre approbation : vérification indicative seulement.' : 'Aucune règle de marque.'),
      row('marketing', 'Marketing', campaigns ? 'LIMITÉ' : 'NON RACCORDÉ', 'Proposition de campagne (contrat, contrôles marque et stock) et décision humaine. Aucune diffusion possible.'),
      row('creative', 'Création', c.status === 'PROVIDER_NOT_CONNECTED' ? 'BLOQUÉ' : 'À VÉRIFIER', c.status === 'PROVIDER_NOT_CONNECTED' ? `Aucun fournisseur de génération connecté (${c.missing.join(', ') || c.error}). Rien n’est produit ni simulé.` : c.note),
    ] };
  }

  /** @returns {Promise<boolean>} true when the request was a /api/core route (answered). `actor` = { userId?, role, label? } from the server's authorisation. */
  async function handle(req, res, url, actor) {
    const p = url.pathname; const m = req.method;
    if (!p.startsWith('/api/core/')) return false;
    try {
      if (p === '/api/core/status' && m === 'GET') {
        json(res, 200, { ...(await status()), connected: { china_sourcing: 'CONNECTED', socle_decision: runtime ? 'CONNECTED' : 'NOT_CONFIGURED', finance: finance ? `READ_ONLY (${finance.source})` : 'NOT_CONNECTED', analytics: analytics ? `READ_ONLY (${analytics.source})` : 'NOT_CONNECTED' }, not_connected: Object.fromEntries(Object.entries(NOT_CONNECTED).filter(([k]) => !((k === 'FINANCE' && finance) || (k === 'ANALYTICS' && analytics)))), executes_actions: false, you: { role: actor.role, auth: actor.userId ? 'NORDLA_SESSION' : 'LOCAL_TOKEN' } });
        return true;
      }
      if (p === '/api/core/ask' && m === 'POST') {
        const b = await body(req);
        json(res, 200, await askNordla({ text: String(b.text ?? '').slice(0, 1000), caseId: typeof b.caseId === 'string' ? b.caseId : null }, { runtime, getCase: (id) => store.get(id), externals: await externals(), actor, finance, analytics }));
        return true;
      }
      if (p === '/api/core/modules' && m === 'GET') { json(res, 200, await modules()); return true; }
      if (p === '/api/core/branding' && m === 'GET') { json(res, 200, branding ? await branding.status() : { status: 'NOT_CONNECTED' }); return true; }
      if (p === '/api/core/branding/check' && m === 'POST') { if (!branding) { json(res, 503, { error: 'NOT_CONNECTED' }); return true; } const b = await body(req); json(res, 200, await branding.checkText(String(b.text ?? '').slice(0, 4000))); return true; }
      if (p === '/api/core/branding/approve' && m === 'POST') { if (!branding) { json(res, 503, { error: 'NOT_CONNECTED' }); return true; } json(res, 200, await branding.approve(actor)); return true; }
      if (p === '/api/core/campaigns' && m === 'GET') { json(res, 200, { campaigns: campaigns ? await campaigns.list() : [] }); return true; }
      if (p === '/api/core/campaigns' && m === 'POST') { if (!campaigns) { json(res, 503, { error: 'NOT_CONNECTED' }); return true; } const b = await body(req); json(res, 200, await campaigns.prepare({ product: b.product, objective: b.objective, audience: b.audience, channel: b.channel, copy: String(b.copy ?? '').slice(0, 2000) }, actor)); return true; }
      const cd = /^\/api\/core\/campaigns\/([^/]{1,200})\/decision$/.exec(p);
      if (cd && m === 'POST') { if (!campaigns) { json(res, 503, { error: 'NOT_CONNECTED' }); return true; } const b = await body(req); json(res, 200, await campaigns.decide(decodeURIComponent(cd[1]), b, actor)); return true; }
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
