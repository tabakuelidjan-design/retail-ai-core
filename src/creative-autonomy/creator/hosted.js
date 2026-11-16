// HOSTED Nordla Créateur: the Creator screen behind the Core identity (module 'creator'), for ONE merchant per server, DEMO ONLY.
//
//   - Sign-in is the Core identity of THIS merchant (the server's merchant id, never a request value): Supabase Auth account, ACTIVE member, 'creator' module
//     ACTIVE, Nordla session cookie + CSRF on every change (createSessionGate, the same gate as China Sourcing with its own module code).
//   - TENANT SCOPE: a session whose merchant is not this server's merchant is refused (TENANT_MISMATCH) even if the gate let it through; each signed-in person
//     gets their own Creator instance (their creations, their decisions), built for this merchant's hub and catalog only.
//   - Roles: OWNER, ADMIN and COLLABORATOR create and decide; every other role reads (a change is refused with FORBIDDEN_ROLE).
//   - DEMO ONLY (NDR-D02, until the real-provider authorisation is resolved): the app is built with mode SIMULATED and demo = true, by THIS file; the caller cannot
//     turn either off. Every creation view carries demo: true, the page marks each image DÉMO, and no image can be exported as a file.
//   - The Creator page itself (HTML, script, style, shared design system) carries no data and is served without a session so it can show its sign-in form;
//     every /api/creator/* route needs the session.
import { createCreatorApp } from './app.js';

const json = (res, status, body) => { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(JSON.stringify(body)); };
export const CREATOR_WRITERS = new Set(['OWNER', 'ADMIN', 'COLLABORATOR']);

/**
 * @param {object} p
 *  gate          createSessionGate({ identity, security, moduleCode: 'creator' })
 *  merchantId    this server's merchant (the Nordla UUID); a session of another merchant is refused
 *  integrationFor(merchantId)  the hub of that merchant (createIntegration({ creativeProduction }) with SIMULATED providers)
 *  catalogFor(merchantId)      the catalog function of that merchant (read only)
 *  tenantName    shown in the banner
 *  persistDirFor(merchantId, userId) optional history directory per person
 *  readImageFor(merchantId) optional: how a produced file is read for that merchant (staging: only inside the merchant's own folder)
 *  revisions     optional revision service (the local, free revisions of createCreatorApp); the same for every person
 */
export function createHostedCreator({ gate, merchantId, integrationFor, catalogFor, tenantName = null, persistDirFor = null, readImageFor = null, revisions = null, now = () => new Date() }) {
  if (!gate || typeof gate.authorize !== 'function' || typeof gate.handle !== 'function') throw new TypeError('a session gate is required');
  if (typeof merchantId !== 'string' || !merchantId) throw new TypeError('the merchant id of this server is required');
  if (typeof integrationFor !== 'function' || typeof catalogFor !== 'function') throw new TypeError('integrationFor and catalogFor are required');

  // the page only: no hub, no catalog, no data. API paths never reach it (they all need the session first)
  const shell = createCreatorApp({ integration: { call: async () => ({ ok: false }) }, catalog: async () => [], mode: 'SIMULATED', demo: true, actor: { id: 'anonymous', role: 'NONE' }, tenantName: null, now });
  const apps = new Map();
  const appFor = (access) => {
    const key = `${access.merchantId}:${access.userId}`;
    if (!apps.has(key)) {
      apps.set(key, createCreatorApp({
        integration: integrationFor(access.merchantId), catalog: catalogFor(access.merchantId), mode: 'SIMULATED', demo: true, tenantName,
        actor: { id: access.userId, role: access.role }, revisions, persistDir: persistDirFor ? persistDirFor(access.merchantId, access.userId) : null, ...(readImageFor ? { readImage: readImageFor(access.merchantId) } : {}), now,
      }));
    }
    return apps.get(key);
  };

  return async function handle(req, res) {
    try {
      const pathname = new URL(req.url, 'http://localhost').pathname;
      if (pathname.startsWith('/api/auth/')) { if (await gate.handle(req, res, pathname)) return; return json(res, 404, { error: 'NOT_FOUND' }); }
      if (!pathname.startsWith('/api/')) return shell(req, res); // the page and the shared design system
      const a = await gate.authorize(req);
      if (!a.ok) return json(res, a.status, a.body);
      const access = a.access;
      if (access.merchantId !== merchantId) return json(res, 403, { error: { code: 'TENANT_MISMATCH' } });
      const method = String(req.method ?? '').toUpperCase();
      if (!['GET', 'HEAD'].includes(method) && !CREATOR_WRITERS.has(access.role)) return json(res, 403, { error: { code: 'FORBIDDEN_ROLE' } });
      return appFor(access)(req, res);
    } catch {
      if (!res.headersSent) json(res, 500, { error: { code: 'INTERNAL' } }); // no stack, no detail
    }
  };
}
