// Paramètres -> Préférences: the shared formatter, the service (personal, independent per person and merchant), the saved views and their reasons, the hub language, and the HTTP host
// (session identity, CSRF, rights, assets). Real host, memory repository, fake sessions.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createFormatter } from '../src/settings-preferences/format.js';
import { createPreferencesService } from '../src/settings-preferences/service.js';
import { createMemoryPreferencesRepository } from '../src/settings-preferences/repository.js';
import { translateSettings } from '../src/settings-preferences/hub-i18n.js';
import { APPLICATION, VIEW_MODULES, cleanFilters } from '../src/settings-preferences/model.js';
import { createPreferencesHost } from '../src/sourcing/server/preferences-host.js';
import { createSessionGate } from '../src/sourcing/server/session-gate.js';

const M1 = '11111111-1111-4111-8111-111111111111'; const M2 = '22222222-2222-4222-8222-222222222222';
const t1 = { merchantId: M1 }; const t2 = { merchantId: M2 };
const reg = { currency: 'EUR', timezone: 'Europe/Brussels' };
const svc = (over = {}) => createPreferencesService({ repo: createMemoryPreferencesRepository(), merchantRef: async () => reg, ...over });

test('PF-1 formatter: the region changes presentation only - same commercial day, same currency, same amount for every format', () => {
  const instant = '2026-11-18T23:30:00Z'; // 00:30 on the 19th in Brussels: the merchant's day is the 19th for everybody
  const out = Object.fromEntries(['fr-BE', 'nl-BE', 'en-GB'].map((r) => { const f = createFormatter({ region: r, timeZone: 'Europe/Brussels', currency: 'EUR' }); return [r, { date: f.date(instant, { month: '2-digit' }), time: f.time(instant), money: f.money(123450, 'EUR'), num: f.number(1234567.891, { max: 3 }) }]; }));
  for (const r of Object.keys(out)) { assert.match(out[r].date, /19/, `${r}: the 19th (merchant day), got ${out[r].date}`); assert.match(out[r].time, /00[:.]30/, `${r}: 00:30 Brussels time, got ${out[r].time}`); assert.match(out[r].money, /€/, `${r}: still EUR`); assert.match(out[r].money.replace(/\D/g, ''), /^123450$/, `${r}: 1 234,50 untouched (${out[r].money})`); }
  assert.notEqual(out['fr-BE'].num, out['en-GB'].num, 'the separators differ by region');
  assert.match(out['en-GB'].money, /^€1,234\.50$/); assert.match(out['fr-BE'].money.replace(/\s| /g, ''), /^1234,50€$/);
  // another time zone really moves the day (so the merchant zone, not the browser's, is what fixes it)
  assert.match(createFormatter({ region: 'fr-BE', timeZone: 'America/New_York' }).date(instant, { month: '2-digit' }), /18/);
  // a calendar date without time is a DAY, never shifted
  assert.match(createFormatter({ region: 'en-GB', timeZone: 'Pacific/Auckland' }).date('2026-11-18', { month: '2-digit' }), /18/);
  // unknown region -> default; fallback zone is reported, never silent
  const d = createFormatter({ region: 'xx', timeZone: null }); assert.equal(d.locale, 'fr-BE'); assert.equal(d.timezoneSource, 'fallback'); assert.equal(createFormatter({ timeZone: 'Europe/Brussels' }).timezoneSource, 'general');
  // currency of the AMOUNT is kept even when the merchant currency differs: nothing is converted
  assert.match(createFormatter({ region: 'fr-BE', currency: 'EUR' }).money(1000, 'USD'), /\$|USD/);
  assert.equal(createFormatter({}).money('x'), ''); assert.equal(createFormatter({}).date('not a date'), '');
  const p = createFormatter({ region: 'nl-BE', timeZone: 'Europe/Brussels', currency: 'EUR' }).preview(); for (const k of ['date', 'time', 'number', 'money']) assert.ok(p[k], k);
});

test('PF-2 service: defaults are today\'s behaviour; a save is personal, validated, and independent per person and per merchant', async () => {
  const s = svc();
  const a0 = await s.overview({ tenant: t1, userId: 'u-a', role: 'OWNER' });
  assert.equal(a0.personal, true); assert.equal(a0.language.value, 'fr'); assert.equal(a0.language.saved, null); assert.equal(a0.region.value, 'fr-BE'); assert.equal(a0.region.saved, null);
  assert.deepEqual(a0.merchant, { currency: 'EUR', timezone: 'Europe/Brussels', source: 'general' });
  await s.save({ tenant: t1, userId: 'u-a', role: 'OWNER', input: { language: 'en', region: 'fr-BE' } });
  await s.save({ tenant: t1, userId: 'u-v', role: 'VIEWER', input: { language: 'nl', region: 'en-GB' } }); // a read-only member changes their OWN preferences
  const a = await s.effective({ tenant: t1, userId: 'u-a', role: 'OWNER' }); const v = await s.effective({ tenant: t1, userId: 'u-v', role: 'VIEWER' });
  assert.deepEqual([a.language, a.region, v.language, v.region], ['en', 'fr-BE', 'nl', 'en-GB']);
  assert.deepEqual(a.merchant, v.merchant, 'same currency and time zone for both: the region never changes them');
  const other = await s.effective({ tenant: t2, userId: 'u-a', role: 'OWNER' }); assert.equal(other.languageSaved, false, 'preferences belong to (merchant, person)');
  await s.save({ tenant: t1, userId: 'u-a', role: 'OWNER', input: { region: null } }); // back to the default format, language kept
  const back = await s.effective({ tenant: t1, userId: 'u-a', role: 'OWNER' }); assert.equal(back.region, 'fr-BE'); assert.equal(back.regionSaved, false); assert.equal(back.language, 'en');
  for (const bad of [{ language: 'de' }, { region: 'de-DE' }, { role: 'OWNER' }, { userId: 'u-v', language: 'fr' }, {}, null, []]) await assert.rejects(() => s.save({ tenant: t1, userId: 'u-a', role: 'OWNER', input: bad }), (e) => e.code === 'VALIDATION', JSON.stringify(bad));
  assert.equal((await s.effective({ tenant: t1, userId: 'u-v', role: 'VIEWER' })).language, 'nl', 'nothing leaked to the other person');
  await assert.rejects(() => s.overview({ tenant: {}, userId: 'u-a', role: 'OWNER' }), (e) => e.code === 'TENANT_REQUIRED');
  await assert.rejects(() => s.overview({ tenant: t1, userId: '', role: 'OWNER' }), (e) => e.code === 'TENANT_REQUIRED');
  const noGeneral = createPreferencesService({ repo: createMemoryPreferencesRepository() }); assert.equal((await noGeneral.effective({ tenant: t1, userId: 'u', role: 'OWNER' })).merchant.source, 'unset');
  const broken = createPreferencesService({ repo: createMemoryPreferencesRepository(), merchantRef: async () => { throw new Error('general down'); } }); assert.equal((await broken.effective({ tenant: t1, userId: 'u', role: 'OWNER' })).merchant.source, 'unset', 'a Général failure never blocks preferences');
});

test('PF-3 saved views: personal, named, one default per screen, favourite, rename, remove; other accounts and merchants never see them', async () => {
  const s = svc(); const A = { tenant: t1, userId: 'u-a', role: 'OWNER' }; const B = { tenant: t1, userId: 'u-b', role: 'VIEWER' };
  const v1 = await s.createView({ ...A, input: { module: 'procurement_items', name: ' Porte-clés ', filters: { q: ' clé ' } }, makeDefault: true });
  assert.equal(v1.name, 'Porte-clés'); assert.deepEqual(v1.filters, { q: 'clé' }); assert.equal(v1.isDefault, true); assert.equal(v1.status, 'OK');
  const v2 = await s.createView({ ...A, input: { module: 'procurement_items', name: 'Coques', filters: { q: 'coque' } } });
  await assert.rejects(() => s.createView({ ...A, input: { module: 'procurement_items', name: 'coques', filters: { q: 'x' } } }), (e) => e.code === 'NAME_TAKEN');
  await s.updateView({ ...A, id: v2.id, patch: { isDefault: true } });
  const list = (await s.listViews(A)).views; assert.equal(list.filter((v) => v.isDefault).length, 1, 'one default per screen'); assert.equal(list.find((v) => v.id === v2.id).isDefault, true);
  assert.equal((await s.resolveDefault({ ...A, module: 'procurement_items' })).view.name, 'Coques');
  assert.equal((await s.updateView({ ...A, id: v2.id, patch: { isFavorite: true } })).isFavorite, true);
  assert.equal((await s.updateView({ ...A, id: v1.id, patch: { name: 'Clés' } })).name, 'Clés');
  assert.equal((await s.updateView({ ...A, id: v2.id, patch: { isDefault: false } })).isDefault, false);
  assert.deepEqual(await s.resolveDefault({ ...A, module: 'procurement_items' }), { view: null, reason: null }, 'default removed -> standard view, nothing to explain');
  // the other account: sees nothing, cannot touch anything, receives no default
  assert.deepEqual((await s.listViews(B)).views, []); assert.deepEqual(await s.resolveDefault({ ...B, module: 'procurement_items' }), { view: null, reason: null });
  for (const op of [() => s.updateView({ ...B, id: v1.id, patch: { name: 'x' } }), () => s.removeView({ ...B, id: v1.id })]) await assert.rejects(op, (e) => e.code === 'NOT_FOUND');
  assert.equal((await s.listViews({ tenant: t2, userId: 'u-a', role: 'OWNER' })).views.length, 0, 'another merchant');
  // a read-only member keeps THEIR OWN views too
  const vb = await s.createView({ ...B, input: { module: 'procurement_items', name: 'Ma vue', filters: { q: 'a' } }, makeDefault: true }); assert.equal(vb.isDefault, true);
  assert.equal((await s.resolveDefault({ ...A, module: 'procurement_items' })).view, null, 'B default does not become A default');
  await s.removeView({ ...A, id: v1.id }); assert.equal((await s.listViews(A)).views.length, 1);
  for (const bad of [{ module: 'nope', name: 'x' }, { module: 'procurement_items', name: '' }, { module: 'procurement_items', name: 'x', filters: { color: 'red' } }, { module: 'procurement_items', name: 'x'.repeat(61) }]) await assert.rejects(() => s.createView({ ...A, input: bad }), (e) => e.code === 'VALIDATION', JSON.stringify(bad));
  await assert.rejects(() => s.resolveDefault({ ...A, module: 'nope' }), (e) => e.code === 'VALIDATION');
});

test('PF-4 a default that no longer applies opens the standard view and says WHY (filter removed, module inaccessible, screen removed)', async () => {
  const repo = createMemoryPreferencesRepository(); let roles = ['OWNER', 'VIEWER'];
  const s = createPreferencesService({ repo, moduleAccess: (m, role) => roles.includes(role) && VIEW_MODULES[m] != null });
  const A = { tenant: t1, userId: 'u-a', role: 'VIEWER' };
  const ok = await s.createView({ ...A, input: { module: 'procurement_items', name: 'Clés', filters: { q: 'clé' } }, makeDefault: true });
  roles = ['OWNER']; // the module becomes inaccessible for this role
  const r1 = await s.resolveDefault({ ...A, module: 'procurement_items' }); assert.equal(r1.view, null); assert.equal(r1.reason, 'MODULE_INACCESSIBLE'); assert.equal(r1.viewName, 'Clés');
  const listed = (await s.listViews(A)).views[0]; assert.equal(listed.status, 'UNAVAILABLE'); assert.equal(listed.reason, 'MODULE_INACCESSIBLE');
  await assert.rejects(() => s.updateView({ ...A, id: ok.id, patch: { isDefault: true } }), (e) => e.code === 'FORBIDDEN_MODULE', 'an inaccessible module cannot be set as default');
  await s.updateView({ ...A, id: ok.id, patch: { isDefault: false } }); // removing the default stays possible
  roles = ['OWNER', 'VIEWER'];
  await repo.insertView(t1.merchantId, 'u-a', { module: 'procurement_items', name: 'Ancienne', filters: { q: 'a', retired_filter: 'x' }, is_default: true }); // a filter that has since disappeared
  const r2 = await s.resolveDefault({ ...A, module: 'procurement_items' }); assert.equal(r2.view, null); assert.equal(r2.reason, 'FILTER_REMOVED');
  await repo.insertView(t1.merchantId, 'u-z', { module: 'gone_screen', name: 'Vieille', filters: {}, is_default: true }); const sz = { tenant: t1, userId: 'u-z', role: 'OWNER' };
  assert.equal((await s.listViews(sz)).views[0].reason, 'MODULE_REMOVED');
  assert.deepEqual(cleanFilters('procurement_items', { q: 'x'.repeat(81) }).dropped, ['q']);
});

test('PF-5 hub language: nothing saved = the payload is untouched; NL / EN translate the menu, the six cards and the title; the rest stays as is', () => {
  const payload = { nav: [{ id: 'home', label: 'Accueil', href: '/' }, { id: 'settings', label: 'Paramètres', href: '/settings' }], merchant: { name: 'X' }, environment: 'Staging',
    cards: [{ id: 'preferences', label: 'Préférences', description: 'd', availabilityLabel: 'Disponible', note: null }, { id: 'notifications', label: 'Notifications', description: 'd', availabilityLabel: 'Prévu', note: 'Pas encore disponible.' }, { id: 'connections', label: 'Connexions', description: 'd', availabilityLabel: 'Disponible', note: null, providers: [{ id: 'shopify', label: 'Shopify', statusLabel: 'Connecté' }, { id: 'x', label: 'X', statusLabel: 'Application X à configurer' }] }] };
  assert.equal(translateSettings(payload, null), payload); assert.equal(translateSettings(payload, 'fr'), payload); assert.equal(translateSettings(payload, 'xx'), payload);
  const nl = translateSettings(payload, 'nl'); assert.equal(nl.texts.title, 'Instellingen'); assert.equal(nl.nav[1].label, 'Instellingen'); assert.equal(nl.cards[0].label, 'Voorkeuren'); assert.equal(nl.cards[1].note, 'Nog niet beschikbaar.'); assert.equal(nl.cards[2].providers[0].statusLabel, 'Verbonden'); assert.equal(nl.cards[2].providers[1].statusLabel, 'Application X à configurer', 'unknown server text is left as is');
  const en = translateSettings(payload, 'en'); assert.equal(en.cards[0].label, 'Preferences'); assert.equal(en.lang, 'en'); assert.equal(en.nav[0].href, '/', 'links untouched'); assert.equal(payload.nav[1].label, 'Paramètres', 'the input is not mutated');
});

test('PF-6 the "where it applies" table is honest: only modules that really follow the setting say Appliqué', () => {
  const by = Object.fromEntries(APPLICATION.map((a) => [a.id, a]));
  assert.equal(by.preferences.language, 'APPLIED'); assert.equal(by.hub.language, 'APPLIED'); assert.equal(by.procurement.region, 'APPLIED'); assert.equal(by.procurement.language, 'KEPT');
  for (const id of ['general', 'team', 'connections', 'security', 'sourcing']) assert.equal(by[id].language, 'KEPT', id);
  assert.equal(by.growth.language, 'OWN'); assert.equal(by.analytics.language, 'OWN');
});

// ------------------------------------------------------------------ HTTP host
const SESSIONS = { owner: { merchantId: M1, userId: 'u-owner', role: 'OWNER' }, viewer: { merchantId: M1, userId: 'u-view', role: 'VIEWER' }, admin: { merchantId: M1, userId: 'u-adm', role: 'ADMIN' }, other: { merchantId: M2, userId: 'u-other', role: 'OWNER' } };
const identity = { context: { module: 'sourcing' }, resolveAccessSession: async (t) => (SESSIONS[t] ? { ok: true, ...SESSIONS[t], module: 'sourcing' } : { ok: false }), authenticateAndOpenSession: async () => ({ ok: false, status: 401 }), logoutSession: async () => {} };
const security = { module: 'sourcing', cookies: { read: (c) => ({ session: /sid=([^;]+)/.exec(c ?? '')?.[1] ?? null }), sessionCookie: (t) => `sid=${t}`, csrfCookie: (t) => `csrf=${t}`, clearSessionCookie: () => 'sid=;', clearCsrfCookie: () => 'csrf=;' },
  csrfTokenFor: (t) => `csrf-${t}`, guardRead: () => ({ ok: true }), guardLogin: () => ({ ok: true, ctx: {} }), readLoginBody: async () => ({}), publicError: () => ({ status: 400, error: 'BAD' }), guardMutation: async (req, resolve) => { const t = /sid=([^;]+)/.exec(req.headers.cookie ?? '')?.[1]; const a = t ? await resolve(t) : null; if (!a?.ok) return { ok: false, code: 'SESSION_INVALID' }; return req.headers['x-nordla-csrf'] === 'good' ? { ok: true, access: a, sessionToken: t } : { ok: false, code: 'CSRF_INVALID' }; } };

async function boot() {
  const service = svc();
  const shellOf = async ({ lang }) => translateSettings({ nav: [{ id: 'settings', label: 'Paramètres', href: '/settings' }], merchant: { name: 'Boutique A' }, environment: 'Staging', cards: [] }, lang);
  const host = await createPreferencesHost({ gate: createSessionGate({ identity, security, moduleCode: 'sourcing' }), merchantId: M1, service, shellOf });
  const server = http.createServer(async (req, res) => { if (!(await host.handle(req, res, new URL(req.url, 'http://x')))) { res.writeHead(404); res.end('nf'); } });
  await new Promise((r) => server.listen(0, '127.0.0.1', r)); const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (path, { as, method = 'GET', body, csrf = 'good' } = {}) => { const res = await fetch(base + path, { method, headers: { ...(as ? { cookie: `sid=${as}` } : {}), ...(method !== 'GET' ? { 'x-nordla-csrf': csrf } : {}), ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined }); const text = await res.text(); let json = null; try { json = JSON.parse(text); } catch { /* html */ } return { status: res.status, json, text, headers: res.headers }; };
  return { call, close: () => server.close() };
}

test('PH-1 session and merchant: no session 401, another merchant 403, the page and its files are served with a strict CSP', async () => {
  const { call, close } = await boot();
  try {
    assert.equal((await call('/api/preferences')).status, 401); assert.equal((await call('/api/preferences', { as: 'other' })).status, 403);
    const ok = await call('/api/preferences', { as: 'owner' }); assert.equal(ok.status, 200); assert.equal(ok.json.personal, true); assert.equal(ok.json.languages.length, 3); assert.equal(ok.json.regions.length, 3); assert.ok(ok.json.applies.length >= 8); assert.equal(ok.json.shell.merchant.name, 'Boutique A');
    const page = await call('/settings/preferences/format-regional'); assert.equal(page.status, 200); assert.match(page.text, /preferences-assets\/preferences\.js/); assert.match(page.text, /preferences-assets\/shell\.js/); assert.match(page.headers.get('content-security-policy'), /script-src 'self'/);
    assert.equal((await call('/settings/preferences/inconnu')).status, 404);
    for (const f of ['preferences.js', 'preferences.css', 'shell.js', 'connections.css', 'format.js']) assert.equal((await call(`/preferences-assets/${f}`)).status, 200, f);
    assert.equal((await call('/preferences-assets/secret.js')).status, 404);
  } finally { close(); }
});

test('PH-2 identity comes from the session: two accounts (one read-only) keep different, independent preferences; a body can never name another person', async () => {
  const { call, close } = await boot();
  try {
    assert.equal((await call('/api/preferences', { as: 'owner', method: 'PUT', body: { language: 'en', region: 'fr-BE' } })).status, 200); // interface English + Belgian format
    assert.equal((await call('/api/preferences', { as: 'viewer', method: 'PUT', body: { language: 'nl', region: 'en-GB' } })).status, 200); // read-only member
    const o = (await call('/api/preferences/effective', { as: 'owner' })).json; const v = (await call('/api/preferences/effective', { as: 'viewer' })).json; const a = (await call('/api/preferences/effective', { as: 'admin' })).json;
    assert.deepEqual([o.language, o.region, v.language, v.region, a.language, a.region], ['en', 'fr-BE', 'nl', 'en-GB', 'fr', 'fr-BE']);
    assert.deepEqual(o.merchant, v.merchant);
    for (const b of [{ userId: 'u-owner', language: 'fr' }, { user_id: 'u-owner', language: 'fr' }, { merchantId: M2, language: 'fr' }, { role: 'OWNER' }]) assert.equal((await call('/api/preferences', { as: 'viewer', method: 'PUT', body: b })).status, 422, JSON.stringify(b));
    assert.equal((await call('/api/preferences/effective', { as: 'owner' })).json.language, 'en', 'the owner is untouched');
    assert.equal((await call('/api/preferences', { as: 'viewer', method: 'PUT', body: { language: 'de' } })).status, 422);
    assert.ok([401, 403].includes((await call('/api/preferences', { as: 'owner', method: 'PUT', body: { language: 'fr' }, csrf: 'bad' })).status), 'CSRF required');
    assert.equal((await call('/api/preferences/effective', { as: 'owner' })).json.language, 'en');
    assert.equal((await call('/api/preferences', { as: 'viewer' })).json.shell.nav[0].label, 'Instellingen', 'the hub follows the saved language');
    assert.equal((await call('/api/preferences', { as: 'admin' })).json.shell.nav[0].label, 'Paramètres');
  } finally { close(); }
});

test('PH-3 views over HTTP: save, default, resolve, rename, remove the default, delete; invisible to another account', async () => {
  const { call, close } = await boot();
  try {
    const made = await call('/api/preferences/views', { as: 'owner', method: 'POST', body: { module: 'procurement_items', name: 'Clés', filters: { q: 'clé' }, makeDefault: true } }); assert.equal(made.status, 200); const id = made.json.id; assert.ok(/^[0-9a-f-]{36}$/.test(id));
    assert.equal((await call('/api/preferences/views/default?module=procurement_items', { as: 'owner' })).json.view.name, 'Clés');
    assert.equal((await call('/api/preferences/views/default?module=procurement_items', { as: 'viewer' })).json.view, null, 'another account receives no default');
    assert.equal((await call('/api/preferences/views', { as: 'viewer' })).json.views.length, 0);
    assert.equal((await call(`/api/preferences/views/${id}`, { as: 'viewer', method: 'PATCH', body: { name: 'volé' } })).status, 404);
    assert.equal((await call(`/api/preferences/views/${id}`, { as: 'viewer', method: 'DELETE' })).status, 404);
    assert.equal((await call(`/api/preferences/views/${id}`, { as: 'owner', method: 'PATCH', body: { name: 'Clés 2' } })).json.name, 'Clés 2');
    assert.equal((await call(`/api/preferences/views/${id}`, { as: 'owner', method: 'PATCH', body: { isDefault: false } })).json.isDefault, false);
    assert.deepEqual((await call('/api/preferences/views/default?module=procurement_items', { as: 'owner' })).json, { view: null, reason: null });
    assert.equal((await call('/api/preferences/views', { as: 'owner', method: 'POST', body: { module: 'procurement_items', name: 'clés 2', filters: { q: 'a' } } })).status, 409);
    assert.equal((await call('/api/preferences/views', { as: 'viewer', method: 'POST', body: { module: 'procurement_items', name: 'Ma vue', filters: { q: 'a' }, makeDefault: true } })).status, 200, 'a read-only member saves their own view');
    assert.equal((await call('/api/preferences/views', { as: 'owner', method: 'POST', body: { module: 'x', name: 'n' } })).status, 422);
    assert.equal((await call('/api/preferences/views/default?module=x', { as: 'owner' })).status, 422);
    assert.equal((await call('/api/preferences/views/not-a-uuid', { as: 'owner', method: 'DELETE' })).status, 404);
    assert.equal((await call(`/api/preferences/views/${id}`, { as: 'owner', method: 'DELETE' })).status, 200); assert.equal((await call(`/api/preferences/views/${id}`, { as: 'owner', method: 'DELETE' })).status, 404);
    assert.equal((await call('/api/preferences/views', { as: 'owner', method: 'POST', body: { module: 'procurement_items', name: 'z', filters: { q: 'z' } }, csrf: 'bad' })).status === 200, false, 'CSRF required');
  } finally { close(); }
});
