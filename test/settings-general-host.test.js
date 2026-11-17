// Paramètres -> Général over HTTP: session gate, merchant scope, rights, versions, validation answers, assets. Real host, memory repository, fake sessions.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createGeneralHost } from '../src/sourcing/server/general-host.js';
import { createGeneralService } from '../src/settings-general/service.js';
import { createMemoryGeneralRepository } from '../src/settings-general/repository.js';
import { createSessionGate } from '../src/sourcing/server/session-gate.js';

const M1 = '11111111-1111-4111-8111-111111111111'; const M2 = '22222222-2222-4222-8222-222222222222';
const SESSIONS = { owner: { merchantId: M1, userId: 'u-owner', role: 'OWNER' }, viewer: { merchantId: M1, userId: 'u-view', role: 'VIEWER' }, admin: { merchantId: M1, userId: 'u-adm', role: 'ADMIN' }, other: { merchantId: M2, userId: 'u-other', role: 'OWNER' } };
const identity = { context: { module: 'sourcing' }, resolveAccessSession: async (t) => (SESSIONS[t] ? { ok: true, ...SESSIONS[t], module: 'sourcing' } : { ok: false }), authenticateAndOpenSession: async () => ({ ok: false, status: 401 }), logoutSession: async () => {} };
const security = { module: 'sourcing', cookies: { read: (c) => ({ session: /sid=([^;]+)/.exec(c ?? '')?.[1] ?? null }), sessionCookie: (t) => `sid=${t}`, csrfCookie: (t) => `csrf=${t}`, clearSessionCookie: () => 'sid=;', clearCsrfCookie: () => 'csrf=;' },
  csrfTokenFor: (t) => `csrf-${t}`, guardRead: () => ({ ok: true }), guardLogin: () => ({ ok: true, ctx: {} }), readLoginBody: async () => ({}), publicError: () => ({ status: 400, error: 'BAD' }), guardMutation: async (req, resolve) => { const t = /sid=([^;]+)/.exec(req.headers.cookie ?? '')?.[1]; const a = t ? await resolve(t) : null; if (!a?.ok) return { ok: false, code: 'SESSION_INVALID' }; return req.headers['x-nordla-csrf'] === 'good' ? { ok: true, access: a, sessionToken: t } : { ok: false, code: 'CSRF_INVALID' }; } };

async function boot() {
  const repo = createMemoryGeneralRepository({ merchants: { [M1]: 'Boutique A', [M2]: 'Boutique B' } });
  const host = await createGeneralHost({ gate: createSessionGate({ identity, security, moduleCode: 'sourcing' }), merchantId: M1, service: createGeneralService({ repo }) });
  const server = http.createServer(async (req, res) => { if (!(await host.handle(req, res, new URL(req.url, 'http://x')))) { res.writeHead(404); res.end('nf'); } });
  await new Promise((r) => server.listen(0, '127.0.0.1', r)); const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (path, { as, method = 'GET', body, csrf = 'good' } = {}) => { const res = await fetch(base + path, { method, headers: { ...(as ? { cookie: `sid=${as}` } : {}), ...(body ? { 'content-type': 'application/json', 'x-nordla-csrf': csrf } : {}) }, body: body ? JSON.stringify(body) : undefined }); const text = await res.text(); let json = null; try { json = JSON.parse(text); } catch { /* html */ } return { status: res.status, json, text, headers: res.headers }; };
  return { call, close: () => server.close(), repo };
}

test('GH-1 session and merchant: no session 401, another merchant 403, the page and its files are served with a strict CSP', async () => {
  const { call, close } = await boot();
  try {
    assert.equal((await call('/api/general')).status, 401);
    assert.equal((await call('/api/general', { as: 'other' })).status, 403);
    const ok = await call('/api/general', { as: 'owner' }); assert.equal(ok.status, 200); assert.equal(ok.json.sections.length, 7); assert.ok(ok.json.options.timezones.includes('Europe/Brussels')); assert.equal(ok.json.canWrite, true);
    const page = await call('/settings/general/legal'); assert.equal(page.status, 200); assert.match(page.text, /general-assets\/general\.js/); assert.match(page.text, /general-assets\/shell\.js/); assert.match(page.headers.get('content-security-policy'), /script-src 'self'/);
    assert.equal((await call('/settings/general/inconnu')).status, 404);
    for (const f of ['general.js', 'general.css', 'shell.js', 'connections.css']) assert.equal((await call(`/general-assets/${f}`)).status, 200, f);
  } finally { close(); }
});

test('GH-2 rights over HTTP: a viewer reads but cannot save; the legal section answers 403 to a viewer; CSRF is required', async () => {
  const { call, close } = await boot();
  try {
    assert.equal((await call('/api/general/activity', { as: 'viewer' })).status, 200);
    assert.equal((await call('/api/general/activity', { as: 'viewer', method: 'POST', body: { data: {} } })).status, 403);
    assert.equal((await call('/api/general/legal', { as: 'viewer' })).status, 403);
    assert.equal((await call('/api/general/legal', { as: 'admin' })).status, 200);
    const noCsrf = await call('/api/general/activity', { as: 'owner', method: 'POST', body: { data: { main: { value: 'retail' } } }, csrf: 'bad' }); assert.ok([401, 403].includes(noCsrf.status), `CSRF refused (${noCsrf.status})`);
    assert.equal((await call('/api/general/activity', { as: 'owner' })).json.version, null, 'nothing was saved by the refused calls');
  } finally { close(); }
});

test('GH-3 save over HTTP: 200 with the new version, 422 with field errors and nothing stored, 409 with the current value on a stale version', async () => {
  const { call, close } = await boot();
  try {
    const bad = await call('/api/general/profile', { as: 'owner', method: 'POST', body: { data: { name: '', email: 'x' }, expectedVersion: null } }); assert.equal(bad.status, 422); assert.deepEqual(Object.keys(bad.json.errors).sort(), ['email', 'name']);
    assert.equal((await call('/api/general/profile', { as: 'owner' })).json.data.name, 'Boutique A');
    const a = await call('/api/general/profile', { as: 'owner', method: 'POST', body: { data: { name: 'Boutique Alpha', website: 'https://alpha.be' }, expectedVersion: null } }); assert.equal(a.status, 200); assert.equal(a.json.version, 1);
    const stale = await call('/api/general/profile', { as: 'admin', method: 'POST', body: { data: { name: 'Autre nom' }, expectedVersion: null } }); assert.equal(stale.status, 409); assert.equal(stale.json.current.data.name, 'Boutique Alpha');
    assert.equal((await call('/api/general/profile', { as: 'owner' })).json.data.website, 'https://alpha.be');
    const reg = await call('/api/general/regional', { as: 'owner', method: 'POST', body: { data: { currency: 'EUR', timezone: 'Europe/Brussels' }, expectedVersion: null } }); assert.equal(reg.status, 200);
    assert.equal((await call('/api/general/regional', { as: 'owner', method: 'POST', body: { data: { currency: 'EUR', timezone: 'Europe/Paris' }, expectedVersion: null } })).status, 409);
  } finally { close(); }
});

test('GH-4 establishments over HTTP: create (becomes main), archive keeps it listed, unknown id 404, a place of merchant B is never reachable', async () => {
  const { call, close, repo } = await boot();
  try {
    const place = { name: 'Boutique', functions: [{ value: 'shop' }], address: { street: 'Rue 1', postal_code: '5000', city: 'Namur', country: 'BE' }, visibility: 'public', hours: { mon: [{ from: '10:00', to: '18:00' }] } };
    const c = await call('/api/general/establishments', { as: 'owner', method: 'POST', body: { establishment: place } }); assert.equal(c.status, 200); const id = c.json.id; assert.equal(c.json.data.establishments[0].isPrimary, true);
    const b = await repo.createEstablishment(M2, { name: 'Lieu de B' }, { primary: true, actor: 'x' });
    assert.equal((await call(`/api/general/establishments/${b.row.id}/archive`, { as: 'owner', method: 'POST', body: {} })).status, 404, 'merchant B\'s place is not reachable from merchant A');
    assert.equal((await call(`/api/general/establishments/${id}/archive`, { as: 'owner', method: 'POST', body: {} })).status, 200);
    const list = (await call('/api/general/establishments', { as: 'owner' })).json.data.establishments; assert.deepEqual([list.length, list[0].archived], [1, true]);
    assert.equal((await call(`/api/general/establishments/${id}/archive`, { as: 'viewer', method: 'POST', body: {} })).status, 403);
  } finally { close(); }
});
