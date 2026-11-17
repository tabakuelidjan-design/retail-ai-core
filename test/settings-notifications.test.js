// Paramètres -> Notifications: rules (service), event emission (idempotent, per recipient, rights), and the HTTP host (session gate, merchant scope, CSRF, assets).
// Real service + host, memory repository, fake sessions. No network, no Supabase.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createNotificationsService, NotificationsError } from '../src/settings-notifications/service.js';
import { createMemoryNotificationsRepository } from '../src/settings-notifications/repository.js';
import { createConnectionReauthEmitter } from '../src/settings-notifications/emitters.js';
import { ALERT_TYPES, TYPE_IDS, canView } from '../src/settings-notifications/model.js';
import { createNotificationsHost } from '../src/sourcing/server/notifications-host.js';
import { createSessionGate } from '../src/sourcing/server/session-gate.js';

const M1 = '11111111-1111-4111-8111-111111111111'; const M2 = '22222222-2222-4222-8222-222222222222';
const U = { owner: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', viewer: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', gone: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' };
const members = () => [{ merchantId: M1, userId: U.owner, role: 'OWNER' }, { merchantId: M1, userId: U.viewer, role: 'VIEWER' }, { merchantId: M1, userId: U.gone, role: 'ADMIN' }, { merchantId: M2, userId: U.owner, role: 'OWNER' }];
const t1 = { merchantId: M1 };
const reauth = (n = 1) => ({ merchantId: M1, type: 'connection_reauth', dedupeKey: `connection_reauth:conn-1:${n}`, data: { provider: 'Instagram' } });

test('NT-1 registry: only the connection event is wired; the two others say why they are not; e-mail and digest are inactive with a reason', async () => {
  assert.deepEqual(TYPE_IDS.filter((t) => ALERT_TYPES[t].wired), ['connection_reauth']);
  for (const t of TYPE_IDS.filter((x) => !ALERT_TYPES[x].wired)) assert.ok(ALERT_TYPES[t].notWiredReason.length > 40, t);
  const svc = createNotificationsService({ repo: createMemoryNotificationsRepository({ members: members() }) });
  const ov = await svc.overview({ tenant: t1, role: 'VIEWER', actor: U.viewer });
  assert.equal(ov.alerts.length, 3); assert.equal(ov.email.available, false); assert.match(ov.email.label, /E-mail indisponible/); assert.equal(ov.digest.available, false);
  const wired = ov.alerts.find((a) => a.id === 'connection_reauth'); assert.equal(wired.state, 'RACCORDEE'); assert.equal(wired.channels.find((c) => c.id === 'in_app').enabled, true);
  assert.equal(wired.channels.find((c) => c.id === 'email').available, false);
  const off = ov.alerts.find((a) => a.id === 'receipt_recorded'); assert.equal(off.state, 'NON_RACCORDEE'); assert.equal(off.channels[0].available, false);
});

test('NT-2 personal choices: per account and per merchant, a read-only member may set them, e-mail and unwired alerts are refused', async () => {
  const svc = createNotificationsService({ repo: createMemoryNotificationsRepository({ members: members() }) });
  const after = await svc.setPreference({ tenant: t1, role: 'VIEWER', actor: U.viewer, type: 'connection_reauth', channel: 'in_app', enabled: false });
  assert.equal(after.alerts.find((a) => a.id === 'connection_reauth').channels[0].enabled, false);
  const owner = await svc.overview({ tenant: t1, role: 'OWNER', actor: U.owner }); assert.equal(owner.alerts.find((a) => a.id === 'connection_reauth').channels[0].enabled, true, 'the owner is not affected');
  const other = await svc.overview({ tenant: { merchantId: M2 }, role: 'OWNER', actor: U.owner }); assert.equal(other.alerts.find((a) => a.id === 'connection_reauth').channels[0].enabled, true, 'another merchant is not affected');
  await assert.rejects(svc.setPreference({ tenant: t1, role: 'OWNER', actor: U.owner, type: 'connection_reauth', channel: 'email', enabled: true }), { code: 'CHANNEL_UNAVAILABLE' });
  await assert.rejects(svc.setPreference({ tenant: t1, role: 'OWNER', actor: U.owner, type: 'receipt_recorded', channel: 'in_app', enabled: true }), { code: 'NOT_WIRED' });
  await assert.rejects(svc.setPreference({ tenant: t1, role: 'OWNER', actor: U.owner, type: 'nope', channel: 'in_app', enabled: true }), { code: 'TYPE_UNKNOWN' });
  await assert.rejects(svc.setPreference({ tenant: t1, role: 'OWNER', actor: U.owner, type: 'connection_reauth', channel: 'in_app', enabled: 'yes' }), { code: 'VALIDATION' });
});

test('NT-3 emission: one alert per authorised recipient, a replay adds nothing, a switched-off member and an inactive member receive nothing', async () => {
  const repo = createMemoryNotificationsRepository({ members: members() }); const svc = createNotificationsService({ repo });
  await svc.setPreference({ tenant: t1, role: 'VIEWER', actor: U.viewer, type: 'connection_reauth', channel: 'in_app', enabled: false });
  repo.setMember(M1, U.gone, { active: false }); // access removed / suspended
  const first = await svc.emit(reauth()); assert.deepEqual(first, { created: 1, duplicate: 0, skipped: 1 }); // only the owner
  const replay = await svc.emit(reauth()); assert.deepEqual(replay, { created: 0, duplicate: 1, skipped: 1 });
  assert.equal(repo._rows.length, 1); assert.equal(repo._rows[0].recipient_user_id, U.owner);
  const next = await svc.emit(reauth(2)); assert.equal(next.created, 1, 'a new expiry (new rotation version) is a new event');
  assert.equal((await svc.inbox({ tenant: { merchantId: M2 }, role: 'OWNER', actor: U.owner })).items.length, 0, 'the owner of another merchant sees nothing');
  await assert.rejects(svc.emit({ merchantId: M1, type: 'receipt_recorded', dedupeKey: 'x-1' }), { code: 'TYPE_NOT_WIRED' });
});

test('NT-4 inbox: open leads to the registry page and marks as read; another member cannot open it; read-all and mark-read work; wording is never stored', async () => {
  const repo = createMemoryNotificationsRepository({ members: members() }); const svc = createNotificationsService({ repo });
  await svc.emit(reauth()); const ownerBox = await svc.inbox({ tenant: t1, role: 'OWNER', actor: U.owner });
  assert.equal(ownerBox.items.length, 1); assert.equal(ownerBox.unread, 1); const it = ownerBox.items[0];
  assert.equal(it.link, '/settings/connections'); assert.match(it.title, /Instagram/); assert.equal(it.read, false);
  assert.equal(JSON.stringify(repo._rows[0]).includes('/settings/connections'), false, 'no link stored');
  await assert.rejects(svc.open({ tenant: t1, role: 'VIEWER', actor: U.viewer, id: it.id }), { code: 'NOT_FOUND' }); // the viewer got its own copy, not this id
  assert.equal(repo._rows.find((r) => r.id === it.id).read_at, null);
  const opened = await svc.open({ tenant: t1, role: 'OWNER', actor: U.owner, id: it.id }); assert.equal(opened.link, '/settings/connections');
  assert.equal((await svc.inbox({ tenant: t1, role: 'OWNER', actor: U.owner })).unread, 0);
  await svc.emit(reauth(2)); const id2 = (await svc.inbox({ tenant: t1, role: 'OWNER', actor: U.owner, unreadOnly: true })).items[0].id;
  assert.equal((await svc.markRead({ tenant: t1, role: 'OWNER', actor: U.owner, ids: [id2] })).changed, 1);
  await svc.emit(reauth(3)); assert.equal((await svc.markAllRead({ tenant: t1, role: 'OWNER', actor: U.owner })).changed, 1);
  await assert.rejects(svc.markRead({ tenant: t1, role: 'OWNER', actor: U.owner, ids: ['not-an-id'] }), { code: 'VALIDATION' });
  assert.equal(canView('connection_reauth', 'NOBODY'), false);
});

test('NT-5 emitter: reads only connections in REAUTH_REQUIRED, same expired credential twice = one alert, failures never throw', async () => {
  const repo = createMemoryNotificationsRepository({ members: members() }); const svc = createNotificationsService({ repo });
  let items = [{ connector_id: 'conn-1', provider: 'instagram', connection_state: 'REAUTH_REQUIRED', grant: { rotation_version: 1 } }, { connector_id: 'conn-2', provider: 'tiktok', connection_state: 'VERIFIED', grant: { rotation_version: 1 } }];
  const logs = []; const em = createConnectionReauthEmitter({ service: svc, merchantId: M1, listConnections: async () => items, log: (m) => logs.push(m) });
  const a = await em.run(); assert.equal(a.seen, 1); assert.equal(a.created, 3); // owner, viewer, admin (all roles may view Connexions)
  const b = await em.run(); assert.equal(b.created, 0); assert.equal(repo._rows.length, 3);
  const bad = createConnectionReauthEmitter({ service: svc, merchantId: M1, listConnections: async () => { throw new Error('down'); }, log: (m) => logs.push(m) });
  assert.equal(await bad.run(), null); assert.ok(logs.some((l) => /sweep failed/.test(l)));
});

// ---------------------------------------------------------------- HTTP
const SESSIONS = { owner: { merchantId: M1, userId: U.owner, role: 'OWNER' }, viewer: { merchantId: M1, userId: U.viewer, role: 'VIEWER' }, other: { merchantId: M2, userId: U.owner, role: 'OWNER' } };
const identity = { context: { module: 'sourcing' }, resolveAccessSession: async (t) => (SESSIONS[t] ? { ok: true, ...SESSIONS[t], module: 'sourcing' } : { ok: false }), authenticateAndOpenSession: async () => ({ ok: false, status: 401 }), logoutSession: async () => {} };
const security = { module: 'sourcing', cookies: { read: (c) => ({ session: /sid=([^;]+)/.exec(c ?? '')?.[1] ?? null }), sessionCookie: (t) => `sid=${t}`, csrfCookie: (t) => `csrf=${t}`, clearSessionCookie: () => 'sid=;', clearCsrfCookie: () => 'csrf=;' },
  csrfTokenFor: (t) => `csrf-${t}`, guardRead: () => ({ ok: true }), guardLogin: () => ({ ok: true, ctx: {} }), readLoginBody: async () => ({}), publicError: () => ({ status: 400, error: 'BAD' }),
  guardMutation: async (req, resolve) => { const t = /sid=([^;]+)/.exec(req.headers.cookie ?? '')?.[1]; const a = t ? await resolve(t) : null; if (!a?.ok) return { ok: false, code: 'SESSION_INVALID' }; return req.headers['x-nordla-csrf'] === 'good' ? { ok: true, access: a, sessionToken: t } : { ok: false, code: 'CSRF_INVALID' }; } };

async function boot() {
  const repo = createMemoryNotificationsRepository({ members: members() }); const service = createNotificationsService({ repo });
  let conns = [{ connector_id: 'conn-1', provider: 'instagram', connection_state: 'REAUTH_REQUIRED', grant: { rotation_version: 1 } }];
  const emitter = createConnectionReauthEmitter({ service, merchantId: M1, listConnections: async () => conns });
  const host = await createNotificationsHost({ gate: createSessionGate({ identity, security, moduleCode: 'sourcing' }), merchantId: M1, service, emitter, sweepEveryMs: 0 });
  const server = http.createServer(async (req, res) => { if (!(await host.handle(req, res, new URL(req.url, 'http://x')))) { res.writeHead(404); res.end('nf'); } });
  await new Promise((r) => server.listen(0, '127.0.0.1', r)); const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (path, { as, method = 'GET', body, csrf = 'good' } = {}) => { const res = await fetch(base + path, { method, headers: { ...(as ? { cookie: `sid=${as}` } : {}), ...(body ? { 'content-type': 'application/json', 'x-nordla-csrf': csrf } : {}) }, body: body ? JSON.stringify(body) : undefined }); const text = await res.text(); let json = null; try { json = JSON.parse(text); } catch { /* html or js */ } return { status: res.status, json, text, headers: res.headers }; };
  return { call, close: () => server.close(), repo, setConns: (c) => { conns = c; } };
}

test('NT-6 HTTP: session and merchant scope, page and assets with a strict CSP, unknown rubric 404', async () => {
  const { call, close } = await boot();
  try {
    assert.equal((await call('/api/notifications')).status, 401);
    assert.equal((await call('/api/notifications', { as: 'other' })).status, 403);
    const ok = await call('/api/notifications', { as: 'viewer' }); assert.equal(ok.status, 200); assert.equal(ok.json.canWrite, true); assert.equal(ok.json.alerts.length, 3);
    const page = await call('/settings/notifications/recues'); assert.equal(page.status, 200); assert.match(page.text, /notifications-assets\/notifications\.js/); assert.match(page.headers.get('content-security-policy'), /script-src 'self'/);
    assert.equal((await call('/settings/notifications/inconnu')).status, 404);
    for (const f of ['notifications.js', 'notifications.css', 'shell.js', 'connections.css']) assert.equal((await call(`/notifications-assets/${f}`)).status, 200, f);
  } finally { close(); }
});

test('NT-7 HTTP end to end: the sweep raises ONE alert per authorised member, open returns the page and marks read, a replay adds nothing, CSRF is required', async () => {
  const { call, close, repo } = await boot();
  try {
    const box = await call('/api/notifications/inbox', { as: 'owner' }); assert.equal(box.json.items.length, 1); assert.equal(box.json.unread, 1);
    await call('/api/notifications/inbox', { as: 'owner' }); await call('/api/notifications', { as: 'viewer' }); // more sweeps: still the same event
    assert.equal(repo._rows.filter((r) => r.recipient_user_id === U.owner).length, 1);
    assert.equal((await call('/api/notifications/open', { as: 'owner', method: 'POST', body: { id: box.json.items[0].id }, csrf: 'bad' })).status, 403);
    const opened = await call('/api/notifications/open', { as: 'owner', method: 'POST', body: { id: box.json.items[0].id } }); assert.equal(opened.status, 200); assert.equal(opened.json.link, '/settings/connections');
    assert.equal((await call('/api/notifications/inbox', { as: 'owner' })).json.unread, 0);
    // the read-only member has its own copy and cannot open the owner's
    assert.equal((await call('/api/notifications/open', { as: 'viewer', method: 'POST', body: { id: box.json.items[0].id } })).status, 404);
    assert.equal((await call('/api/notifications/inbox', { as: 'viewer' })).json.unread, 1);
    // another merchant's session never reaches this merchant's alerts
    assert.equal((await call('/api/notifications/inbox', { as: 'other' })).status, 403);
    // preferences over HTTP: refused e-mail (409), unwired (409), accepted in-app switch
    assert.equal((await call('/api/notifications/preferences', { as: 'viewer', method: 'POST', body: { type: 'connection_reauth', channel: 'email', enabled: true } })).status, 409);
    assert.equal((await call('/api/notifications/preferences', { as: 'viewer', method: 'POST', body: { type: 'growth_action_review', channel: 'in_app', enabled: true } })).status, 409);
    const set = await call('/api/notifications/preferences', { as: 'viewer', method: 'POST', body: { type: 'connection_reauth', channel: 'in_app', enabled: false } }); assert.equal(set.status, 200);
    assert.equal(set.json.alerts.find((a) => a.id === 'connection_reauth').channels[0].enabled, false);
    assert.equal((await call('/api/notifications/read-all', { as: 'viewer', method: 'POST', body: {} })).json.changed, 1);
  } finally { close(); }
});

test('NT-8 the error class carries a code (host answers with it)', () => { const e = new NotificationsError('NOT_FOUND'); assert.equal(e.code, 'NOT_FOUND'); assert.ok(e instanceof Error); });
