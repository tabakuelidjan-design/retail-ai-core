// Nordla Créateur — the customer-facing Creator screen over the EXISTING creative production route (integration hub
// CREATIVE.produce_product_visual, ADR 0007-A, PROPOSED). A plain node:http handler, same "static UI + small JSON API"
// convention as the other Nordla modules; it shares the Nordla design system (tokens, rail, cards) and touches no other module.
//
// The workflow it serves, and nothing more:
//   product + variant chosen by the user -> Nordla retrieves the verified product photo ITSELF (the user is never asked to
//   select, confirm or approve it) -> creative request -> the existing pipeline -> the result shown -> accept / revision / reject.
// Nothing is ever published from here: an accepted result is recorded as accepted, `published: false`.
// Real provider calls stay refused by the hub under NDR-D02, EXCEPT in the owner-authorised LIVE_LOCAL mode (this file, `live` option): local loopback, HABB administrator only, every paid phase
// shown and authorised BEFORE it runs, the 0,60 EUR ceiling covering the WHOLE attempt. Hosted and demo servers never pass `live`: they stay SIMULATED / DEMO.
import { permissionsOf } from '../scene-permissions.js';
import { readFile } from 'node:fs/promises';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join, dirname } from 'node:path';
import { readNordlaShared } from '../../shared/nordla-static.js';
import { MODULE } from '../../integration/index.js';
import { EXISTING_VISUAL_ORIGIN } from '../existing-visual.js';

const UI = new URL('./ui/', import.meta.url);
const ANALYTICS_UI = new URL('../../analytics-premium/ui/', import.meta.url); // shared design system, served as-is (read only)
const JS = 'text/javascript; charset=utf-8';
const CSS = 'text/css; charset=utf-8';
const STATIC = {
  '/': [UI, 'index.html', 'text/html; charset=utf-8'],
  '/creator.js': [UI, 'creator.js', JS],
  '/creator.css': [UI, 'creator.css', CSS],
  '/style.css': [ANALYTICS_UI, 'style.css', CSS],
};
const SECURITY_HEADERS = {
  'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
};
export const DECISION = Object.freeze({ ACCEPT: 'ACCEPTED', REVISE: 'REVISION_REQUESTED', REJECT: 'REJECTED' });
const MAX_BODY = 16 * 1024;
const MAX_UPLOAD_BODY = 20 * 1024 * 1024; // a base64 photo (the file itself is bounded to 16 MB by the media rules)

async function readJson(req, max = MAX_BODY) {
  let size = 0; const chunks = [];
  for await (const c of req) { size += c.length; if (size > max) throw Object.assign(new Error('body too large'), { status: 413 }); chunks.push(c); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch { throw Object.assign(new Error('invalid JSON'), { status: 400 }); }
}

/**
 * integration: a hub from createIntegration({ creativeProduction }) — the ONLY way this screen produces anything.
 * catalog():    the tenant's products and variants for the picker (read only), each variant saying whether a verified photo exists.
 * mode:         'SIMULATED' is the only mode this screen accepts (NDR-D02); anything else refuses to start.
 * actor:        who decides on this screen (the tenant user), recorded with each decision.
 */
export function createCreatorApp({ integration, catalog, mode = 'SIMULATED', actor, tenantName = null, now = () => new Date(), readImage = (p) => readFile(p), revisions = null, revisionDir = null, persistDir = null, demo = false, live = null }) {
  // LIVE_LOCAL needs the live world (caps, gate hooks, uploads); a hosted/demo server can never reach it, and `demo` forbids it outright
  if (mode === 'LIVE_LOCAL') { if (!live || demo) throw new Error('NDR-D02: LIVE_LOCAL needs the local live world and is never a demo'); }
  else if (mode !== 'SIMULATED' || live) throw new Error('NDR-D02: the Creator screen only runs with simulated providers');
  const isLive = mode === 'LIVE_LOCAL';
  const gates = new Map(); // creation_id -> { resolve, reject } of the image authorisation the run is waiting for (never persisted)
  const uploads = new Map(); // upload_id -> { staged, title, price, ... } (this session only)
  if (!integration?.call || typeof catalog !== 'function') throw new TypeError('integration and catalog are required');
  const creations = new Map(); // creation_id -> record
  // HISTORY. With persistDir every creation is written (atomically) to <persistDir>/<id>.json at each state change and read back at start: a restart never loses a result that
  // was paid for. A production that was still running when the process stopped is closed honestly as INTERRUPTED_BY_RESTART (its provider call may have been billed: the ledger reconciles it).
  const save = (c) => {
    if (!persistDir) return;
    try { mkdirSync(persistDir, { recursive: true }); const f = join(persistDir, `${c.id}.json`); writeFileSync(`${f}.tmp`, JSON.stringify(c)); renameSync(`${f}.tmp`, f); } catch { /* history is a convenience: it never stops a production */ }
  };
  if (persistDir) {
    let files = []; try { files = readdirSync(persistDir).filter((f) => /^cr-[0-9a-f]{12}\.json$/.test(f)).sort(); } catch { /* no history yet */ }
    for (const f of files) {
      let c; try { c = JSON.parse(readFileSync(join(persistDir, f), 'utf8')); } catch { continue; } // a corrupt file is ignored, never fatal
      if (!c || typeof c.id !== 'string' || `${c.id}.json` !== f || typeof c.status !== 'string') continue;
      if (c.status === 'RUNNING' || c.status === 'AWAITING_IMAGE_AUTHORIZATION') { c.status = 'FAILED'; c.error = { code: 'INTERRUPTED_BY_RESTART', reason: 'the server stopped while this creation was running' }; save(c); }
      else if (c.status === 'AWAITING_AUTHORIZATION') { c.status = 'CANCELLED'; c.error = { code: 'INTERRUPTED_BY_RESTART', reason: 'the server stopped before any spend was authorised: nothing was spent' }; save(c); }
      creations.set(c.id, c);
    }
  }
  let queue = Promise.resolve(); // one production at a time (simulated providers and the ledger month are shared)

  const view = (c) => ({
    creation_id: c.id, status: c.status, created_at: c.createdAt, product: c.product, variant: c.variant, objective: c.objective, campaign: c.campaign ?? null, ...(c.ad ? { ad: c.ad } : {}),
    ...(c.origin ? { origin: c.origin, existing: c.existing ?? null } : {}),
    revision_of: c.revisionOf, revision_note: c.revisionNote, simulated: !isLive || live.simulated === true, live_local: isLive, published: false,
    ...(isLive ? { preflight: c.preflight ?? null, phase: c.phase ?? null, estimate: c.estimate ?? null, concept: c.concept ?? null, spend: c.status === 'RUNNING' ? { spent_eur: Math.round(live.spent() * 10000) / 10000, attempt_cap_eur: live.caps.attempt_eur } : (c.spend ?? null), upload: c.upload ?? null, authorizations: c.authorizations ?? [] } : {}),
    result: c.result ? { images: c.result.results.map((_, i) => `/api/creator/creations/${c.id}/images/${i}.png`), ...(c.result.results.some((r) => r.mobile_preview) ? { mobile_images: c.result.results.map((r, i) => (r.mobile_preview ? `/api/creator/creations/${c.id}/mobile/${i}.png` : null)) } : {}), ...(c.result.results.some((r) => r.route) ? { ad_results: c.result.results.map((r, i) => reviewView(c.id, r, i)) } : {}), media_id: c.result.media_id,
      source_sha256: c.result.source_sha256, policy_version: c.result.policy_version, withheld: c.result.withheld,
      reservation: c.result.reservation ? { status: c.result.reservation.closing?.status ?? c.result.reservation.status, ceiling_eur: c.result.reservation.ceiling_eur,
        settled_eur: c.result.reservation.closing?.settled_eur ?? null } : null } : null,
    error: c.error, decision: c.decision,
    revision_method: c.revisionMethod ?? null, verification: c.verification ?? null,
    pending_revision: c.pendingRevision ? { note: c.pendingRevision.note, plan: publicPlan(c.pendingRevision.plan) } : null,
    // EXPORT: only an ACCEPTED result can be exported (the owner's decision comes first); the list is what the screen offers as downloads
    ...(demo ? { demo: true } : {}), // hosted: every result is flagged DEMO in the data itself, so no client can mistake it for a real image
    exports: !demo && c.decision?.decision === 'ACCEPTED' && c.result?.results ? c.result.results.map((_, i) => `/api/creator/creations/${c.id}/export/${i}.png`) : [],
  });
  // AD route: what the owner needs to REVIEW a result: the headline, the proposal it comes from, and the points to check (contact with the support, outline readability), with the crops and one useful action each
  const REVIEW_PIECES = Object.freeze({ 'sans-titre': '1-sans-titre.png', 'appui-100': '2-appui-100.png', 'appui-300': '3-appui-300.png' });
  const reviewView = (id, r, i) => {
    const rv = r.review ?? null; const flags = [];
    if (rv?.contact_decor && rv.contact_decor.status !== 'CONFIRMED') flags.push({ what: 'Appui du produit sur le support', status: rv.contact_decor.label ?? 'À vérifier par le propriétaire', reasons: (rv.contact_decor.missing ?? []).map(String), actions: rv.contact_decor.owner_actions ?? [] });
    if (rv?.support_dessine?.flagged) flags.push({ what: 'Support dessiné', status: rv.support_dessine.status, reasons: rv.support_dessine.reasons ?? [], actions: rv.support_dessine.action ? [rv.support_dessine.action] : [] });
    if (rv?.lisibilite_contour?.flagged) flags.push({ what: 'Contour du produit', status: rv.lisibilite_contour.status, reasons: rv.lisibilite_contour.reasons ?? [], actions: rv.lisibilite_contour.action ? [rv.lisibilite_contour.action] : [] });
    const pieces = rv?.pieces ?? {};
    const fr = r.final_review ?? null; // Creator's own review of its finished advertisement (final-review.js): the verdict, the reason to buy it names, what it could not confirm
    const finalReview = fr ? { verdict: fr.verdict, publishable: fr.publishable === true, reasons: fr.reasons ?? [], reason_to_buy: fr.review?.reason_to_buy ?? null, items: fr.review ? { product_fidelity: fr.review.product_fidelity, decor: fr.review.decor, headline_image: fr.review.headline_image, phone_legibility: fr.review.phone_legibility } : null, cost_eur: fr.provenance?.cost_eur ?? null } : null;
    return { ...(r.export_image ? { export_href: `/api/creator/creations/${id}/export-jpeg/${i}.jpg`, export_format: r.export_format } : {}), ...(r.platform ? { platform: r.platform, label: r.label ?? null, caption_source: r.caption_source ?? null, layout: r.layout ?? null, unverified: r.unverified ?? null } : {}), headline: r.headline ?? null, caption: r.caption ?? null, concept_name: r.concept_name ?? null, final_review: finalReview, review_available: Boolean(rv), to_check: flags, crops: Object.fromEntries(Object.entries(REVIEW_PIECES).filter(([, f]) => Object.values(pieces).includes(f)).map(([k]) => [k, `/api/creator/creations/${id}/review/${i}/${k}.png`])) };
  };
  const publicPlan = (pl) => pl && ({ method: pl.method, kind: pl.understood.kind, executable: pl.executable, estimated_cost_eur: pl.estimated_cost_eur, worst_case_eur: pl.worst_case_eur,
    needs_confirmation: pl.needs_confirmation, ask: pl.ask ?? null, changes: pl.changes, preserves: pl.preserves, refusals: pl.refusals, reason_not_local: pl.reason_not_local ?? null, provider_calls: pl.provider_calls });

  // ---------- LIVE_LOCAL: authorise-then-run, phase by phase ----------
  const r4 = (x) => Math.round(x * 10000) / 10000;
  const conceptView = ({ stage, concept, artDirection }) => ({ headline: stage?.headline ?? null, central_idea: concept?.central_idea ?? null, story: concept?.story ?? null,
    emotional_intent: concept?.emotional_intent ?? null, atmosphere: artDirection?.atmosphere ?? null, text_placement: stage?.text_placement ?? null, show_price: stage?.show_price ?? null });
  /** A creation that WAITS for the administrator's authorisation of its first paid phase. Nothing is spent, no provider is contacted, the ledger is not touched. */
  async function openLive({ product, variant, objective, staged = null, upload = null, campaign = null, revisionOf = null, revisionNote = null, resume = null }) {
    const id = `cr-${randomUUID().replace(/-/g, '').slice(0, 12)}`;
    const c = { id, status: 'AWAITING_AUTHORIZATION', phase: 'CONCEPT', createdAt: now().toISOString(), product, variant, objective, campaign, resume, revisionOf, revisionNote, result: null, error: null, decision: null,
      estimate: resume ? { ...live.estimate('CONCEPT'), label: 'Reprise de la proposition retenue : composition refaite selon votre demande (texte seul, aucune image)', expected_eur: 0.02 } : live.estimate('CONCEPT'), concept: null, spend: { spent_eur: 0, attempt_cap_eur: live.caps.attempt_eur }, upload, authorizations: [], preflight: null };
    if (staged) c.staged = true; // the bytes stay in memory (uploads map), never in the history file
    // FREE preflight (photo found, validated, cut out locally): when it fails the creation is REFUSED here and NO paid phase is ever offered
    try {
      c.preflight = await live.preflight({ product_id: product.product_id, variant_id: variant.variant_id, variant_title: variant.title || null, staged });
      if (!c.preflight.ok) { c.status = 'REFUSED'; c.estimate = null; c.error = { code: 'PHOTO_NOT_USABLE', reason: `${c.preflight.status}: ${(c.preflight.reasons ?? []).join(', ') || 'the photo cannot be cut out'}`.slice(0, 300) }; }
    } catch (e) { c.status = 'REFUSED'; c.estimate = null; c.error = { code: e?.code ?? 'PHOTO_NOT_AVAILABLE', reason: String(e?.message ?? e).slice(0, 300) }; }
    creations.set(id, c); save(c);
    return c;
  }
  // the offer is part of the objective, in the merchant's own words (the brief has no field for it): never invented, never added when absent
  const campaignObjective = (c) => `${c.objective}${c.campaign?.offer ? ` Offre de la campagne : ${String(c.campaign.offer).trim().replace(/[.\s]+$/, '')}.` : ''}${c.revisionNote ? `\nRévision demandée : ${c.revisionNote}` : ''}`;
  function runLive(c, staged) {
    c.status = 'RUNNING'; c.phase = 'CONCEPT'; save(c);
    queue = queue.then(async () => {
      live.begin(c.id, {
        requestImageAuthorization: (info) => new Promise((resolve, reject) => {
          gates.set(c.id, { resolve, reject });
          if (info.ad) c.ad = info.ad;
          const spent = live.spent();
          c.concept = conceptView(info); c.phase = 'IMAGE'; c.status = 'AWAITING_IMAGE_AUTHORIZATION';
          c.estimate = live.estimate('IMAGE', { spent_eur: spent }); c.spend = { spent_eur: r4(spent), attempt_cap_eur: live.caps.attempt_eur }; save(c);
        }),
      }, { product_id: c.product.product_id });
      try {
        const out = await integration.call(MODULE.CREATIVE, 'produce_product_visual',
          { product_id: c.product.product_id, variant_id: c.variant.variant_id, expected_variant_title: c.variant.title || null, objective: campaignObjective(c), run_id: c.id, ...(staged ? { staged_media: staged } : {}), ...(live.route ? { campaign: { audience: c.campaign?.audience ?? null, occasion: c.campaign?.occasion ?? null, permissions: c.campaign?.permissions ?? [], route: live.route, ...(c.resume ? { adResume: c.resume } : {}) } } : {}) },
          { workflow_id: `creator:${c.id}`, initiated_by: { kind: 'HUMAN', id: actor.id, role: actor.role } });
        if (out.ok && out.result?.results?.length) { c.result = out.result; c.status = 'READY'; }
        else if (out.ok) {
          c.result = out.result; c.status = 'NO_RESULT';
          const why = out.result?.stop_reason; // the run stopped BEFORE any proposal existed: say exactly why (a ceiling too low is not "every proposal withheld")
          c.error = why ? { code: /BUDGET_PRECHECK_REFUSED/.test(`${why.code} ${why.message}`) ? 'BUDGET_CEILING_TOO_LOW' : (why.code || 'RUN_STOPPED'), reason: String(why.message ?? '').slice(0, why.code === 'AD_NO_CONVINCING_IDEA' ? 400 : 300) }
            : { code: 'NO_RESULT_UNEXPLAINED', reason: 'the run ended without a result and without a journaled reason' };
        }
        else if (c.error?.code === 'CANCELLED_BY_ADMIN') { c.status = 'CANCELLED'; }
        else { c.status = 'REFUSED'; c.error = { code: out.code ?? 'REFUSED', reason: String(out.reason ?? '').slice(0, 300) }; }
        if (c.error?.code === 'AD_NO_CONVINCING_IDEA') { try { live.noneMemory?.record(c); } catch { /* the memory is a convenience: it never stops a run */ } }
      } finally { const sp = live.spent(); c.spend = { spent_eur: r4(sp), attempt_cap_eur: live.caps.attempt_eur }; gates.delete(c.id); live.end(c.id); }
    }).catch((e) => { if (c.status !== 'CANCELLED') { c.status = 'FAILED'; c.error = { code: 'INTERNAL', reason: String(e?.message ?? e).slice(0, 200) }; } }).then(() => save(c));
  }

  function start({ product, variant, objective, revisionOf = null, revisionNote = null }) {
    const id = `cr-${randomUUID().replace(/-/g, '').slice(0, 12)}`;
    const c = { id, status: 'RUNNING', createdAt: now().toISOString(), product, variant, objective, revisionOf, revisionNote, result: null, error: null, decision: null };
    creations.set(id, c); save(c);
    const brief = revisionNote ? `${objective}\nRévision demandée : ${revisionNote}` : objective;
    queue = queue.then(async () => {
      const out = await integration.call(MODULE.CREATIVE, 'produce_product_visual',
        { product_id: product.product_id, variant_id: variant.variant_id, expected_variant_title: variant.title, objective: brief, run_id: id },
        { workflow_id: `creator:${id}`, initiated_by: { kind: 'HUMAN', id: actor.id, role: actor.role } });
      if (out.ok && out.result?.results?.length) {
        c.result = out.result; c.status = 'READY';
        // a revised result is VERIFIED against its parent: an identical image is never presented as a successful revision
        const parent = revisionOf ? creations.get(revisionOf) : null;
        if (parent?.result && revisions) c.verification = revisions.verifyRegenerated({ parentImage: parent.result.results[0].image, image: out.result.results[0].image, plan: c.plan ?? null });
      }
      else if (out.ok) {
        // STAGING MODULE: the simulated path now says WHY a run ended without a result, exactly like the live path (a NONE keeps its own code and reason, never "every proposal was withheld")
        c.result = out.result; c.status = 'NO_RESULT'; const why = out.result?.stop_reason;
        c.error = why ? { code: why.code || 'RUN_STOPPED', reason: String(why.message ?? '').slice(0, why.code === 'AD_NO_CONVINCING_IDEA' ? 400 : 300) } : { code: 'NO_RESULT_PASSED_CHECKS', reason: 'every proposal was withheld by the technical checks' };
      }
      else { c.status = 'REFUSED'; c.error = { code: out.code ?? 'REFUSED', reason: String(out.reason ?? '').slice(0, 300) }; }
    }).catch((e) => { c.status = 'FAILED'; c.error = { code: 'INTERNAL', reason: String(e?.message ?? e).slice(0, 200) }; }).then(() => save(c));
    return c;
  }

  /** A LOCAL revision: the same scene, new text decisions, the real compositor, then verification. No provider call. */
  function startLocal(parent, note, plan) {
    const id = `cr-${randomUUID().replace(/-/g, '').slice(0, 12)}`;
    const c = { id, status: 'RUNNING', createdAt: now().toISOString(), product: parent.product, variant: parent.variant, objective: parent.objective, revisionOf: parent.id, revisionNote: note,
      revisionMethod: plan.method, result: null, error: null, decision: null };
    creations.set(id, c); save(c);
    queue = queue.then(async () => {
      const r = await revisions.applyLocal({ plan, proposalImage: parent.result.results[0].image, outDir: join(revisionDir ?? dirname(dirname(parent.result.results[0].image)), 'revisions', id) });
      c.verification = r.verification;
      if (r.verification.outcome === 'REJECTED_BY_CHECKS') { c.status = 'NO_RESULT'; c.error = { code: 'REVISION_REJECTED_BY_CHECKS', reason: (r.verification.technical_defects ?? []).join(', ') || 'product proof failed' }; return; }
      c.result = { ...parent.result, results: [{ image: r.image, technical: 'PASS', creative: null }], reservation: { status: 'NO_SPEND', ceiling_eur: 0, closing: { status: 'NO_SPEND', settled_eur: 0 } } };
      c.status = 'READY';
    }).catch((e) => { c.status = 'FAILED'; c.error = { code: 'INTERNAL', reason: String(e?.message ?? e).slice(0, 200) }; }).then(() => save(c));
    return c;
  }

  const send = (res, status, type, body, extra = {}) => { res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', ...SECURITY_HEADERS, ...extra }); res.end(body); };
  // a download name made only of a-z, 0-9 and hyphens: never a path, never a control character
  const fileSlug = (s) => String(s ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
  const json = (res, status, obj) => send(res, status, 'application/json', JSON.stringify(obj));
  const findVariant = async (productId, variantId) => {
    const p = (await catalog()).find((x) => x.product_id === productId);
    const v = p?.variants.find((x) => x.variant_id === variantId);
    return p && v ? { product: { product_id: p.product_id, title: p.title }, variant: { variant_id: v.variant_id, title: v.title, price: v.price } } : null;
  };

  const handler = async function handle(req, res) {
    try {
      const url = new URL(req.url, 'http://localhost');
      const p = url.pathname;
      if (req.method === 'GET' && STATIC[p]) { const [base, file, type] = STATIC[p]; return send(res, 200, type, await readFile(new URL(file, base))); }
      if (req.method === 'GET') { const shared = await readNordlaShared(p); if (shared) return send(res, 200, shared.type, shared.body); }
      if (req.method === 'GET' && p === '/api/creator/status') return json(res, 200, { mode, ...(demo ? { demo: true } : {}), live_provider: isLive, auto_publish: false, tenant: tenantName, ...(isLive ? { live_local: true, route: live.route ?? null, caps: live.caps, simulated_providers: live.simulated === true } : {}) });
      if (req.method === 'GET' && p === '/api/creator/products') {
        let products; try { products = await catalog(); } catch (e) { return json(res, 503, { error: { code: e?.code === 'CATALOG_UNAVAILABLE' ? 'CATALOG_UNAVAILABLE' : 'CATALOG_FAILED' } }); } // no stack, no provider message
        return json(res, 200, { products });
      }
      if (req.method === 'GET' && p === '/api/creator/creations') return json(res, 200, { creations: [...creations.values()].sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt))).map(view) });
      // EXISTING HABB VISUAL path (live mode only): a visual HABB already has + the text Creator already wrote, as a DRAFT to validate. Nothing is generated, no provider is contacted; the cost of the archived text call is
      // reconciled into the ledger ONCE (existing-visual.js) and shown, never added again. The owner's decision goes through the same /decision route as any result (accepted = recorded, never published).
      if (isLive && live.existingVisuals && req.method === 'GET' && p === '/api/creator/existing-visuals') return json(res, 200, { visuals: live.existingVisuals.list() });
      if (isLive && live.dayPlan && req.method === 'GET' && p === '/api/creator/day') return json(res, 200, { plan: live.dayPlan() });
      let ev;
      if (isLive && live.existingVisuals && req.method === 'POST' && (ev = /^\/api\/creator\/existing-visuals\/([a-z0-9-]{3,80})\/draft$/.exec(p))) {
        const already = [...creations.values()].find((x) => x.origin === EXISTING_VISUAL_ORIGIN && x.existing?.visual_id === ev[1] && !x.decision);
        const o = await live.existingVisuals.open(ev[1]); // verified and reconciled (once) on every opening
        if (!o.ok) return json(res, o.code === 'EXISTING_VISUAL_NOT_FOUND' ? 404 : 422, { error: { code: o.code, problems: o.problems ?? null, reconciliation: o.reconciliation ?? null } });
        const e = o.entry; const id = `cr-${randomUUID().replace(/-/g, '').slice(0, 12)}`;
        const c = { id, status: 'READY', origin: EXISTING_VISUAL_ORIGIN, createdAt: now().toISOString(), product: { product_id: `existing-visual:${e.id}`, title: e.subject_label }, variant: { variant_id: 'existing-visual', title: 'Visuel HABB existant', price: null },
          objective: 'Présenter un visuel HABB existant avec l’accroche et la légende écrites par Creator.', campaign: null, resume: null, revisionOf: null, revisionNote: null, error: null, decision: null, preflight: null, phase: null, estimate: null, concept: null, upload: null, authorizations: [],
          spend: { spent_eur: o.call.settled_eur, attempt_cap_eur: o.call.ceiling_eur },
          existing: { visual_id: e.id, mention: e.mention, price_eur: e.price_eur, price_source: e.price_source, image_origin: e.image_origin, status: e.status, not_claimed: e.not_claimed ?? [],
            cost: { settled_eur: o.call.settled_eur, ceiling_eur: o.call.ceiling_eur, model: o.call.model, archived_request_sha256: o.call.request_sha256, ledger_run_id: o.reconciliation.run_id, ledger: o.reconciliation.status, counted_once: true, image_generation_eur: 0 } },
          result: { results: o.formats.map((f) => ({ image: f.imagePath, route: EXISTING_VISUAL_ORIGIN, platform: f.platform, label: f.label, caption_source: f.caption_source, layout: f.layout, unverified: f.unverified, ...(f.exportPath ? { export_image: f.exportPath, export_format: f.exportFormat } : {}), headline: e.headline, caption: e.caption, technical: 'PASS', creative: null, final_review: null })), media_id: `existing-visual:${e.id}`, source_sha256: e.image_sha256, policy_version: null, withheld: [],
            reservation: { status: 'SETTLED', ceiling_eur: o.call.settled_eur, closing: { status: 'SETTLED', settled_eur: o.call.settled_eur } } } };
        // the same draft is never made twice while it waits for the owner: it is REFRESHED from the registry (formats, texts), keeping its id and its history
        if (already) { Object.assign(already, { result: c.result, existing: c.existing, spend: c.spend }); save(already); return json(res, 200, view(already)); }
        creations.set(id, c); save(c); return json(res, 201, view(c));
      }
      if (req.method === 'POST' && p === '/api/creator/creations') {
        const b = await readJson(req);
        const objective = typeof b.objective === 'string' ? b.objective.trim().slice(0, 500) : '';
        if (!objective) return json(res, 400, { error: { code: 'OBJECTIVE_REQUIRED' } });
        const short = (v) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, 400) : null);
        const campaign = { audience: short(b.audience), occasion: short(b.occasion), offer: short(b.offer), audience_unknown: b.audience_unknown === true, permissions: permissionsOf({ scene_permissions: Array.isArray(b.permissions) ? b.permissions : [] }) }; // a permission is a campaign choice, from the registry only
        // AD route (explicit mode): the public is part of the campaign the merchant provides; without it Nordla would have to invent one
        if (isLive && live.route && !campaign.audience && !campaign.audience_unknown) return json(res, 400, { error: { code: 'AUDIENCE_REQUIRED', reason: 'define the public of the campaign (or state that it is not defined)' } });
        if (isLive && typeof b.upload_id === 'string' && live.route) return json(res, 422, { error: { code: 'AD_ROUTE_NEEDS_A_CATALOGUE_PRODUCT' } });
        if (isLive && typeof b.upload_id === 'string') {
          const u = uploads.get(b.upload_id); if (!u) return json(res, 404, { error: { code: 'UPLOAD_NOT_FOUND' } });
          const c = await openLive({ product: { product_id: u.staged.identity.product_id, title: u.staged.snapshot.product.title }, variant: { variant_id: u.staged.identity.variant_id, title: u.staged.identity.variant_title ?? '', price: u.price },
            objective, staged: u.staged, upload: { upload_id: b.upload_id, sha256_prefix: u.staged.sha256.slice(0, 12), title: u.staged.snapshot.product.title } });
          c.stagedRef = b.upload_id; return json(res, 202, view(c));
        }
        const found = await findVariant(b.product_id, b.variant_id);
        if (!found) return json(res, 400, { error: { code: 'UNKNOWN_PRODUCT_OR_VARIANT' } });
        if (isLive && live.route && !live.adProducts.has(found.product.product_id)) return json(res, 422, { error: { code: 'AD_ROUTE_PRODUCT_NOT_PREPARED', reason: 'this product has no validated product sheet: the advertisement route cannot be used for it' } });
        if (isLive) return json(res, 202, view(await openLive({ ...found, objective, campaign })));
        return json(res, 202, view(start({ ...found, objective })));
      }
      let m;
      if (isLive && req.method === 'POST' && p === '/api/creator/uploads') {
        const b = await readJson(req, MAX_UPLOAD_BODY);
        let bytes; try { bytes = Buffer.from(String(b.data_base64 ?? ''), 'base64'); } catch { bytes = Buffer.alloc(0); }
        try {
          const staged = live.stageUpload({ bytes, facts: { title: b.title, price: b.price, variant: b.variant, features: b.features, description: b.description, headline: b.headline, display_features: b.display_features } });
          const upload_id = `up-${staged.sha256.slice(0, 12)}`;
          uploads.set(upload_id, { staged, price: `${staged.snapshot.product.variants.nodes[0].price.replace('.', ',')} €` });
          return json(res, 201, { upload_id, sha256_prefix: staged.sha256.slice(0, 12), width_px: staged.photoMeta.width_px, height_px: staged.photoMeta.height_px, title: staged.snapshot.product.title });
        } catch (e) { return json(res, 422, { error: { code: 'UPLOAD_REFUSED', reason: String(e?.message ?? e).slice(0, 160) } }); }
      }
      m = /^\/api\/creator\/creations\/(cr-[0-9a-f]{12})\/authorize$/.exec(p);
      if (isLive && req.method === 'POST' && m) {
        const c = creations.get(m[1]); if (!c) return json(res, 404, { error: { code: 'NOT_FOUND' } });
        const b = await readJson(req);
        const phase = b.phase; const want = c.estimate;
        if (!want || phase !== want.phase) return json(res, 409, { error: { code: 'NOT_WAITING_FOR_THIS_PHASE' } });
        // the administrator authorises EXACTLY the ceiling that was displayed: nothing else is accepted
        if (!(Number(b.ceiling_eur) === want.max_eur)) return json(res, 409, { error: { code: 'CEILING_MISMATCH', expected_eur: want.max_eur } });
        if (phase === 'CONCEPT') {
          if (c.status !== 'AWAITING_AUTHORIZATION') return json(res, 409, { error: { code: 'NOT_WAITING_FOR_THIS_PHASE' } });
          c.authorizations.push({ phase, ceiling_eur: want.max_eur, by: actor.id, at: now().toISOString() });
          runLive(c, c.stagedRef ? uploads.get(c.stagedRef)?.staged : null);
          return json(res, 200, view(c));
        }
        if (phase === 'IMAGE') {
          const g = gates.get(c.id); if (c.status !== 'AWAITING_IMAGE_AUTHORIZATION' || !g) return json(res, 409, { error: { code: 'NOT_WAITING_FOR_THIS_PHASE' } });
          // a request that contradicts itself (a detail the generator would lose) is never paid for: the administrator is told before the payment and can cancel without further spend
          if (c.ad?.request?.warnings?.length) return json(res, 409, { error: { code: 'REQUEST_HAS_UNRESOLVED_WARNINGS', warnings: c.ad.request.warnings } });
          // the AD route's single global ceiling: the image, the logo montage and the final review must fit in what is left (never start an image that the review could not follow)
          if (c.estimate?.needed_eur != null && c.estimate.max_eur < c.estimate.needed_eur) return json(res, 409, { error: { code: 'BUDGET_INSUFFICIENT_FOR_IMAGE_AND_REVIEW', left_eur: c.estimate.max_eur, needed_eur: c.estimate.needed_eur } });
          // the authorisation NAMES the exact request that was shown (its SHA-256): a different request is never paid for under this click
          if (c.ad?.request && b.request_sha256 !== c.ad.request.prompt_sha256) return json(res, 409, { error: { code: 'REQUEST_NOT_THE_ONE_SHOWN', expected_sha256: c.ad.request.prompt_sha256 } });
          c.authorizations.push({ phase, ceiling_eur: want.max_eur, by: actor.id, at: now().toISOString() });
          c.status = 'RUNNING'; save(c); gates.delete(c.id); g.resolve({ ceiling_eur: want.max_eur }); return json(res, 200, view(c));
        }
        return json(res, 400, { error: { code: 'PHASE_INVALID' } });
      }
      m = /^\/api\/creator\/creations\/(cr-[0-9a-f]{12})\/cancel$/.exec(p);
      if (isLive && req.method === 'POST' && m) {
        const c = creations.get(m[1]); if (!c) return json(res, 404, { error: { code: 'NOT_FOUND' } });
        if (c.status === 'AWAITING_AUTHORIZATION') { c.status = 'CANCELLED'; c.error = { code: 'CANCELLED_BY_ADMIN', reason: 'cancelled before any spend' }; save(c); return json(res, 200, view(c)); }
        const g = gates.get(c.id);
        if (c.status === 'AWAITING_IMAGE_AUTHORIZATION' && g) { c.error = { code: 'CANCELLED_BY_ADMIN', reason: 'cancelled before the image phase: only the concept phase was spent' }; gates.delete(c.id); g.reject(Object.assign(new Error('CANCELLED_BY_ADMIN'), { code: 'CANCELLED_BY_ADMIN' })); return json(res, 200, view(c)); }
        return json(res, 409, { error: { code: 'NOTHING_TO_CANCEL' } });
      }
      m = /^\/api\/creator\/creations\/(cr-[0-9a-f]{12})$/.exec(p);
      if (req.method === 'GET' && m) { const c = creations.get(m[1]); return c ? json(res, 200, view(c)) : json(res, 404, { error: { code: 'NOT_FOUND' } }); }
      m = /^\/api\/creator\/creations\/(cr-[0-9a-f]{12})\/images\/(\d{1,2})\.png$/.exec(p);
      if (req.method === 'GET' && m) {
        const c = creations.get(m[1]); const r = c?.result?.results?.[Number(m[2])];
        if (!r) return json(res, 404, { error: { code: 'NOT_FOUND' } });
        return send(res, 200, 'image/png', await readImage(r.image)); // a path the pipeline returned, chosen by index only: never a path from the request
      }
      m = /^\/api\/creator\/creations\/(cr-[0-9a-f]{12})\/mobile\/(\d{1,2})\.png$/.exec(p);
      if (req.method === 'GET' && m) {
        const r = creations.get(m[1])?.result?.results?.[Number(m[2])];
        if (!r?.mobile_preview) return json(res, 404, { error: { code: 'NOT_FOUND' } });
        return send(res, 200, 'image/png', await readImage(r.mobile_preview)); // the path the pipeline returned, by index only
      }
      // JPEG export of an existing visual's format (TikTok): the SAME visual converted, only after the owner accepted the draft, by index only (never a path from the request)
      m = /^\/api\/creator\/creations\/(cr-[0-9a-f]{12})\/export-jpeg\/(\d{1,2})\.jpg$/.exec(p);
      if (req.method === 'GET' && m) {
        const c = creations.get(m[1]); const r = c?.result?.results?.[Number(m[2])];
        if (!r?.export_image) return json(res, 404, { error: { code: 'NOT_FOUND' } });
        if (c.decision?.decision !== 'ACCEPTED') return json(res, 409, { error: { code: 'EXPORT_REQUIRES_ACCEPTANCE' } });
        return send(res, 200, 'image/jpeg', await readImage(r.export_image), { 'Content-Disposition': `attachment; filename="${[fileSlug(c.product?.title), fileSlug(r.platform), c.id].filter(Boolean).join('-')}.jpg"` });
      }
      m = /^\/api\/creator\/creations\/(cr-[0-9a-f]{12})\/review\/(\d{1,2})\/(sans-titre|appui-100|appui-300)\.png$/.exec(p);
      if (req.method === 'GET' && m) {
        const r = creations.get(m[1])?.result?.results?.[Number(m[2])];
        const file = r?.review?.pieces ? Object.values(r.review.pieces).find((f) => f === REVIEW_PIECES[m[3]]) : null;
        if (!r || !file) return json(res, 404, { error: { code: 'NOT_FOUND' } });
        return send(res, 200, 'image/png', await readImage(join(dirname(r.image), 'revue', file))); // a fixed file name of the review pack, never a name from the request
      }
      m = /^\/api\/creator\/creations\/(cr-[0-9a-f]{12})\/export\/(\d{1,2})\.png$/.exec(p);
      if (req.method === 'GET' && m) {
        const c = creations.get(m[1]); const r = c?.result?.results?.[Number(m[2])];
        if (!r) return json(res, 404, { error: { code: 'NOT_FOUND' } });
        if (demo) return json(res, 409, { error: { code: 'EXPORT_DISABLED_IN_DEMO' } }); // a simulated image is never handed out as a file
        if (c.decision?.decision !== 'ACCEPTED') return json(res, 409, { error: { code: 'EXPORT_REQUIRES_ACCEPTANCE' } });
        const name = [fileSlug(c.product?.title), fileSlug(c.variant?.title), c.id].filter(Boolean).join('-');
        return send(res, 200, 'image/png', await readImage(r.image), { 'Content-Disposition': `attachment; filename="${name}.png"` });
      }
      m = /^\/api\/creator\/creations\/(cr-[0-9a-f]{12})\/decision$/.exec(p);
      if (req.method === 'POST' && m) {
        const c = creations.get(m[1]); if (!c) return json(res, 404, { error: { code: 'NOT_FOUND' } });
        if (c.status !== 'READY') return json(res, 409, { error: { code: 'NOTHING_TO_DECIDE' } });
        if (c.decision) return json(res, 409, { error: { code: 'ALREADY_DECIDED', decision: c.decision.decision } });
        const b = await readJson(req);
        const decision = DECISION[b.decision];
        if (!decision) return json(res, 400, { error: { code: 'DECISION_INVALID' } });
        const note = typeof b.note === 'string' ? b.note.trim().slice(0, 500) : '';
        if (c.origin === EXISTING_VISUAL_ORIGIN && decision === DECISION.REVISE) return json(res, 422, { error: { code: 'REVISION_NOT_AVAILABLE_FOR_AN_EXISTING_VISUAL' } }); // an existing visual is validated or rejected: nothing is regenerated
        if (decision === DECISION.REVISE && !note) return json(res, 400, { error: { code: 'REVISION_NOTE_REQUIRED' } });
        if (isLive && decision === DECISION.REVISE && !revisions) return json(res, 422, { error: { code: 'REVISION_NOT_AVAILABLE_IN_LIVE_V1' } });
        if (decision === DECISION.REVISE && revisions) {
          // understood, planned with the least disruptive method, priced BEFORE anything runs
          const { plan } = revisions.plan({ proposalImage: c.result.results[0].image, note });
          if (plan.method === 'LOCAL_RECOMPOSE' && !plan.executable) return json(res, 422, { error: { code: 'REVISION_REFUSED_BY_RULES' }, plan: publicPlan(plan) });
          if (plan.method === 'NEEDS_EXACT_INSTRUCTION') return json(res, 422, { error: { code: 'REVISION_NEEDS_EXACT_INSTRUCTION' }, plan: publicPlan(plan) });
          if (isLive && plan.method !== 'LOCAL_RECOMPOSE' && !live.route) return json(res, 422, { error: { code: 'REVISION_NEEDS_A_NEW_AUTHORISED_CREATION' }, plan: publicPlan(plan) }); // a new paid scene is a NEW creation, authorised from its own start
          if (isLive && plan.method !== 'LOCAL_RECOMPOSE') {
            // AD route: the PRODUCT, the VARIANT, the CAMPAIGN and the BRIEF are kept; the step the note concerns is redone, in a NEW creation that waits for its own authorisation (with its own estimate)
            const decisions = join(dirname(dirname(c.result.results[0].image)), 'ad_decisions.json');
            const resume = plan.method === 'NEW_SCENE_GENERATION' && existsSync(decisions) ? { decisions, note, seed: 7000 + [...creations.values()].filter((x) => x.revisionOf).length + 1 } : null;
            c.decision = { decision, note, by: actor.id, at: now().toISOString(), published: false, method: plan.method }; save(c);
            const nc = await openLive({ product: c.product, variant: c.variant, objective: c.objective, campaign: c.campaign, revisionOf: c.id, revisionNote: note, resume });
            nc.revisionMethod = plan.method; save(nc);
            return json(res, 200, { creation: view(c), revision: view(nc), plan: publicPlan(plan) });
          }
          if (plan.needs_confirmation) { c.pendingRevision = { note, plan }; save(c); return json(res, 200, { creation: view(c), revision: null, plan: publicPlan(plan) }); }
          c.decision = { decision, note, by: actor.id, at: now().toISOString(), published: false, method: plan.method }; save(c);
          return json(res, 200, { creation: view(c), revision: view(startLocal(c, note, plan)), plan: publicPlan(plan) });
        }
        c.decision = { decision, note: note || null, by: actor.id, at: now().toISOString(), published: false }; save(c);
        let revision = null;
        if (decision === DECISION.REVISE) revision = start({ product: c.product, variant: c.variant, objective: c.objective, revisionOf: c.id, revisionNote: note });
        return json(res, 200, { creation: view(c), revision: revision ? view(revision) : null });
      }
      m = /^\/api\/creator\/creations\/(cr-[0-9a-f]{12})\/revision\/(confirm|cancel)$/.exec(p);
      if (req.method === 'POST' && m) {
        const c = creations.get(m[1]); if (!c?.pendingRevision) return json(res, 409, { error: { code: 'NO_PENDING_REVISION' } });
        const { note, plan } = c.pendingRevision; c.pendingRevision = null;
        if (m[2] === 'cancel') { save(c); return json(res, 200, { creation: view(c), revision: null }); }
        c.decision = { decision: DECISION.REVISE, note, by: actor.id, at: now().toISOString(), published: false, method: plan.method, estimated_cost_eur: plan.estimated_cost_eur }; save(c);
        const r = start({ product: c.product, variant: c.variant, objective: c.objective, revisionOf: c.id, revisionNote: note }); r.revisionMethod = plan.method; r.plan = plan;
        return json(res, 200, { creation: view(c), revision: view(r) });
      }
      return json(res, 404, { error: { code: 'NOT_FOUND' } });
    } catch (e) {
      return json(res, e?.status ?? 500, { error: { code: e?.status ? 'BAD_REQUEST' : 'INTERNAL_ERROR' } });
    }
  };
  handler.idle = () => queue; // tests: wait for the productions in flight
  return handler;
}
