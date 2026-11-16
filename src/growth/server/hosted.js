// HOSTED Nordla Growth ("Développement des ventes"): the Growth screen behind the Core identity (module 'growth'), for ONE merchant per server.
//
//   - Sign-in is the Core identity of THIS merchant (the server's merchant id, never a request value): Supabase Auth account, ACTIVE member, 'growth' module ACTIVE,
//     Nordla session cookie + CSRF on every change (createSessionGate, the gate China Sourcing and the Creator use, with its own module code).
//   - Every /api/* route needs the session (the page, its scripts and the shared design system carry no data and are served without one so the sign-in form can show).
//     A session of another merchant is refused (TENANT_MISMATCH) even when the gate let it through.
//   - Data routes (/api/growth/*) are the Growth app's, READ ONLY, built for the server's merchant. The only writes are the merchant's own follow-up entries
//     (/api/growth/follow-up): plans, applied actions, review results, requests and commercial follow-up - never a message, a publication or a Shopify change.
//   - Roles: OWNER, ADMIN and COLLABORATOR may save follow-up; every other role reads (a change is refused with FORBIDDEN_ROLE).
import { followUpKeyOk, followUpValueError } from './follow-up-store.js';

const json = (res, status, body) => { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(JSON.stringify(body)); };
export const GROWTH_WRITERS = new Set(['OWNER', 'ADMIN', 'COLLABORATOR']);
const MAX_BODY = 300 * 1024;

async function readJson(req) {
  const chunks = []; let n = 0;
  for await (const c of req) { n += c.length; if (n > MAX_BODY) throw Object.assign(new Error('too large'), { code: 'BODY_TOO_LARGE' }); chunks.push(c); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw Object.assign(new Error('bad json'), { code: 'BODY_INVALID' }); }
}

/**
 * @param {object} p
 *  gate        createSessionGate({ identity, security, moduleCode: 'growth' })
 *  merchantId  this server's merchant (the Nordla UUID)
 *  historyScope sha256 of that id (the scope the page's follow-up keys carry)
 *  app         the Growth app handler (createGrowthApp built for this merchant, with hosted: true)
 *  store       the follow-up store (createSupabaseFollowUpStore / createMemoryFollowUpStore)
 */
export function createHostedGrowth({ gate, merchantId, historyScope, app, store, now = () => new Date() }) {
  if (!gate || typeof gate.authorize !== 'function' || typeof gate.handle !== 'function') throw new TypeError('a session gate is required');
  if (typeof merchantId !== 'string' || !merchantId) throw new TypeError('the merchant id of this server is required');
  if (typeof historyScope !== 'string' || !historyScope) throw new TypeError('the history scope of this merchant is required');
  if (typeof app !== 'function' || !store || typeof store.list !== 'function' || typeof store.put !== 'function') throw new TypeError('the Growth app and a follow-up store are required');

  async function followUp(req, res, access) {
    const method = String(req.method ?? '').toUpperCase();
    if (method === 'GET') {
      const rows = await store.list(access.merchantId); // the SESSION's merchant (equal to this server's: checked before)
      return json(res, 200, { merchant_scope: historyScope, entries: rows.filter((r) => followUpKeyOk(r.key, historyScope)).map((r) => ({ key: r.key, value: r.value, version: r.version, updated_at: r.updated_at })) });
    }
    if (method !== 'PUT') return json(res, 405, { error: { code: 'METHOD_NOT_ALLOWED' } });
    if (!GROWTH_WRITERS.has(access.role)) return json(res, 403, { error: { code: 'FORBIDDEN_ROLE' } });
    let body;
    try { body = await readJson(req); } catch (e) { return json(res, e.code === 'BODY_TOO_LARGE' ? 413 : 400, { error: { code: e.code ?? 'BODY_INVALID' } }); }
    const { key, value, expected_version: expected } = body ?? {};
    if (!followUpKeyOk(key, historyScope)) return json(res, 400, { error: { code: 'KEY_NOT_ALLOWED' } }); // another merchant's scope, or a key this module never writes
    const bad = followUpValueError(key, value);
    if (bad) return json(res, bad === 'VALUE_TOO_LARGE' ? 413 : 400, { error: { code: bad } });
    if (!Number.isInteger(expected) || expected < 0) return json(res, 400, { error: { code: 'VERSION_REQUIRED' } });
    const r = await store.put(access.merchantId, key, value, expected, access.userId, now());
    if (!r.ok) return json(res, 409, { error: { code: r.code }, current: r.current ?? null });
    return json(res, 200, { ok: true, version: r.version });
  }

  return async function handle(req, res) {
    try {
      const pathname = new URL(req.url, 'http://localhost').pathname;
      if (pathname === '/healthz') return json(res, 200, { ok: true }); // the platform's health check: no data, no session
      if (pathname.startsWith('/api/auth/')) { if (await gate.handle(req, res, pathname)) return; return json(res, 404, { error: 'NOT_FOUND' }); }
      if (!pathname.startsWith('/api/')) return app(req, res); // the page, its scripts, the design system, Growth icons: no data
      const a = await gate.authorize(req);
      if (!a.ok) return json(res, a.status, a.body);
      const access = a.access;
      if (access.merchantId !== merchantId) return json(res, 403, { error: { code: 'TENANT_MISMATCH' } });
      if (pathname === '/api/growth/follow-up') return await followUp(req, res, access);
      return app(req, res); // the Growth app's read-only data routes (it refuses any other method itself)
    } catch {
      if (!res.headersSent) json(res, 500, { error: { code: 'INTERNAL' } }); // no stack, no detail
    }
  };
}
