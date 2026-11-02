// Nordla Créateur — the customer-facing Creator screen over the EXISTING creative production route (integration hub
// CREATIVE.produce_product_visual, ADR 0007-A, PROPOSED). A plain node:http handler, same "static UI + small JSON API"
// convention as the other Nordla modules; it shares the Nordla design system (tokens, rail, cards) and touches no other module.
//
// The workflow it serves, and nothing more:
//   product + variant chosen by the user -> Nordla retrieves the verified product photo ITSELF (the user is never asked to
//   select, confirm or approve it) -> creative request -> the existing pipeline -> the result shown -> accept / revision / reject.
// Nothing is ever published from here: an accepted result is recorded as accepted, `published: false`.
// Real provider calls stay refused by the hub under NDR-D02: this server can only run with SIMULATED providers.
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join, dirname } from 'node:path';
import { readNordlaShared } from '../../shared/nordla-static.js';
import { MODULE } from '../../integration/index.js';

const UI = new URL('./ui/', import.meta.url);
const ANALYTICS_UI = new URL('../../analytics-premium/ui/', import.meta.url); // shared design system, served as-is (read only)
const JS = 'text/javascript; charset=utf-8';
const CSS = 'text/css; charset=utf-8';
const STATIC = {
  '/': [UI, 'index.html', 'text/html; charset=utf-8'],
  '/creator.js': [UI, 'creator.js', JS],
  '/creator.css': [UI, 'creator.css', CSS],
  '/style.css': [ANALYTICS_UI, 'style.css', CSS],
  '/nordla-tokens.css': [ANALYTICS_UI, 'nordla-tokens.css', CSS],
};
const SECURITY_HEADERS = {
  'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
};
export const DECISION = Object.freeze({ ACCEPT: 'ACCEPTED', REVISE: 'REVISION_REQUESTED', REJECT: 'REJECTED' });
const MAX_BODY = 16 * 1024;

async function readJson(req) {
  let size = 0; const chunks = [];
  for await (const c of req) { size += c.length; if (size > MAX_BODY) throw Object.assign(new Error('body too large'), { status: 413 }); chunks.push(c); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch { throw Object.assign(new Error('invalid JSON'), { status: 400 }); }
}

/**
 * integration: a hub from createIntegration({ creativeProduction }) — the ONLY way this screen produces anything.
 * catalog():    the tenant's products and variants for the picker (read only), each variant saying whether a verified photo exists.
 * mode:         'SIMULATED' is the only mode this screen accepts (NDR-D02); anything else refuses to start.
 * actor:        who decides on this screen (the tenant user), recorded with each decision.
 */
export function createCreatorApp({ integration, catalog, mode = 'SIMULATED', actor, tenantName = null, now = () => new Date(), readImage = (p) => readFile(p), revisions = null, revisionDir = null }) {
  if (mode !== 'SIMULATED') throw new Error('NDR-D02: the Creator screen only runs with simulated providers');
  if (!integration?.call || typeof catalog !== 'function') throw new TypeError('integration and catalog are required');
  const creations = new Map(); // creation_id -> record (in memory: a demonstration server)
  let queue = Promise.resolve(); // one production at a time (simulated providers and the ledger month are shared)

  const view = (c) => ({
    creation_id: c.id, status: c.status, created_at: c.createdAt, product: c.product, variant: c.variant, objective: c.objective,
    revision_of: c.revisionOf, revision_note: c.revisionNote, simulated: true, published: false,
    result: c.result ? { images: c.result.results.map((_, i) => `/api/creator/creations/${c.id}/images/${i}.png`), media_id: c.result.media_id,
      source_sha256: c.result.source_sha256, policy_version: c.result.policy_version, withheld: c.result.withheld,
      reservation: c.result.reservation ? { status: c.result.reservation.closing?.status ?? c.result.reservation.status, ceiling_eur: c.result.reservation.ceiling_eur,
        settled_eur: c.result.reservation.closing?.settled_eur ?? null } : null } : null,
    error: c.error, decision: c.decision,
    revision_method: c.revisionMethod ?? null, verification: c.verification ?? null,
    pending_revision: c.pendingRevision ? { note: c.pendingRevision.note, plan: publicPlan(c.pendingRevision.plan) } : null,
  });
  const publicPlan = (pl) => pl && ({ method: pl.method, kind: pl.understood.kind, executable: pl.executable, estimated_cost_eur: pl.estimated_cost_eur, worst_case_eur: pl.worst_case_eur,
    needs_confirmation: pl.needs_confirmation, ask: pl.ask ?? null, changes: pl.changes, preserves: pl.preserves, refusals: pl.refusals, reason_not_local: pl.reason_not_local ?? null, provider_calls: pl.provider_calls });

  function start({ product, variant, objective, revisionOf = null, revisionNote = null }) {
    const id = `cr-${randomUUID().replace(/-/g, '').slice(0, 12)}`;
    const c = { id, status: 'RUNNING', createdAt: now().toISOString(), product, variant, objective, revisionOf, revisionNote, result: null, error: null, decision: null };
    creations.set(id, c);
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
      else if (out.ok) { c.result = out.result; c.status = 'NO_RESULT'; c.error = { code: 'NO_RESULT_PASSED_CHECKS', reason: 'every proposal was withheld by the technical checks' }; }
      else { c.status = 'REFUSED'; c.error = { code: out.code ?? 'REFUSED', reason: String(out.reason ?? '').slice(0, 300) }; }
    }).catch((e) => { c.status = 'FAILED'; c.error = { code: 'INTERNAL', reason: String(e?.message ?? e).slice(0, 200) }; });
    return c;
  }

  /** A LOCAL revision: the same scene, new text decisions, the real compositor, then verification. No provider call. */
  function startLocal(parent, note, plan) {
    const id = `cr-${randomUUID().replace(/-/g, '').slice(0, 12)}`;
    const c = { id, status: 'RUNNING', createdAt: now().toISOString(), product: parent.product, variant: parent.variant, objective: parent.objective, revisionOf: parent.id, revisionNote: note,
      revisionMethod: plan.method, result: null, error: null, decision: null };
    creations.set(id, c);
    queue = queue.then(async () => {
      const r = await revisions.applyLocal({ plan, proposalImage: parent.result.results[0].image, outDir: join(revisionDir ?? dirname(dirname(parent.result.results[0].image)), 'revisions', id) });
      c.verification = r.verification;
      if (r.verification.outcome === 'REJECTED_BY_CHECKS') { c.status = 'NO_RESULT'; c.error = { code: 'REVISION_REJECTED_BY_CHECKS', reason: (r.verification.technical_defects ?? []).join(', ') || 'product proof failed' }; return; }
      c.result = { ...parent.result, results: [{ image: r.image, technical: 'PASS', creative: null }], reservation: { status: 'NO_SPEND', ceiling_eur: 0, closing: { status: 'NO_SPEND', settled_eur: 0 } } };
      c.status = 'READY';
    }).catch((e) => { c.status = 'FAILED'; c.error = { code: 'INTERNAL', reason: String(e?.message ?? e).slice(0, 200) }; });
    return c;
  }

  const send = (res, status, type, body) => { res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', ...SECURITY_HEADERS }); res.end(body); };
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
      if (req.method === 'GET' && p === '/api/creator/status') return json(res, 200, { mode, live_provider: false, auto_publish: false, tenant: tenantName });
      if (req.method === 'GET' && p === '/api/creator/products') return json(res, 200, { products: await catalog() });
      if (req.method === 'POST' && p === '/api/creator/creations') {
        const b = await readJson(req);
        const objective = typeof b.objective === 'string' ? b.objective.trim().slice(0, 500) : '';
        if (!objective) return json(res, 400, { error: { code: 'OBJECTIVE_REQUIRED' } });
        const found = await findVariant(b.product_id, b.variant_id);
        if (!found) return json(res, 400, { error: { code: 'UNKNOWN_PRODUCT_OR_VARIANT' } });
        return json(res, 202, view(start({ ...found, objective })));
      }
      let m = /^\/api\/creator\/creations\/(cr-[0-9a-f]{12})$/.exec(p);
      if (req.method === 'GET' && m) { const c = creations.get(m[1]); return c ? json(res, 200, view(c)) : json(res, 404, { error: { code: 'NOT_FOUND' } }); }
      m = /^\/api\/creator\/creations\/(cr-[0-9a-f]{12})\/images\/(\d{1,2})\.png$/.exec(p);
      if (req.method === 'GET' && m) {
        const c = creations.get(m[1]); const r = c?.result?.results?.[Number(m[2])];
        if (!r) return json(res, 404, { error: { code: 'NOT_FOUND' } });
        return send(res, 200, 'image/png', await readImage(r.image)); // a path the pipeline returned, chosen by index only: never a path from the request
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
        if (decision === DECISION.REVISE && !note) return json(res, 400, { error: { code: 'REVISION_NOTE_REQUIRED' } });
        if (decision === DECISION.REVISE && revisions) {
          // understood, planned with the least disruptive method, priced BEFORE anything runs
          const { plan } = revisions.plan({ proposalImage: c.result.results[0].image, note });
          if (plan.method === 'LOCAL_RECOMPOSE' && !plan.executable) return json(res, 422, { error: { code: 'REVISION_REFUSED_BY_RULES' }, plan: publicPlan(plan) });
          if (plan.method === 'NEEDS_EXACT_INSTRUCTION') return json(res, 422, { error: { code: 'REVISION_NEEDS_EXACT_INSTRUCTION' }, plan: publicPlan(plan) });
          if (plan.needs_confirmation) { c.pendingRevision = { note, plan }; return json(res, 200, { creation: view(c), revision: null, plan: publicPlan(plan) }); }
          c.decision = { decision, note, by: actor.id, at: now().toISOString(), published: false, method: plan.method };
          return json(res, 200, { creation: view(c), revision: view(startLocal(c, note, plan)), plan: publicPlan(plan) });
        }
        c.decision = { decision, note: note || null, by: actor.id, at: now().toISOString(), published: false };
        let revision = null;
        if (decision === DECISION.REVISE) revision = start({ product: c.product, variant: c.variant, objective: c.objective, revisionOf: c.id, revisionNote: note });
        return json(res, 200, { creation: view(c), revision: revision ? view(revision) : null });
      }
      m = /^\/api\/creator\/creations\/(cr-[0-9a-f]{12})\/revision\/(confirm|cancel)$/.exec(p);
      if (req.method === 'POST' && m) {
        const c = creations.get(m[1]); if (!c?.pendingRevision) return json(res, 409, { error: { code: 'NO_PENDING_REVISION' } });
        const { note, plan } = c.pendingRevision; c.pendingRevision = null;
        if (m[2] === 'cancel') return json(res, 200, { creation: view(c), revision: null });
        c.decision = { decision: DECISION.REVISE, note, by: actor.id, at: now().toISOString(), published: false, method: plan.method, estimated_cost_eur: plan.estimated_cost_eur };
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
