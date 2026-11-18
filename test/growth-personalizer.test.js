// Growth > the personalizer's technical events: strict validation, the public receiver (origin, schema, size, rate, dedupe), the summary (attempt vs confirmed, obstacle vs abandon),
// the hosted route without a session, the screen, and the table's columns. Fakes only: no network, no credential, no Shopify call.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { validatePersonalizerEvent, summarizePersonalizer, PZ_ALLOWED_KEYS, PZ_STEPS } from '../src/growth/dropoff/personalizer.js';
import { createPersonalizerCollector, createMemoryPersonalizerStore, COLLECT_PATH, collectChannels, channelProvenance } from '../src/growth/server/collect-personalizer.js';
import { createDropoffSource } from '../src/growth/server/dropoff.js';
import { createHostedGrowth } from '../src/growth/server/hosted.js';
import { growthDom, text } from './growth-dom.js';

const A = 'a1b2c3d4e5f60718'; const B = '0f1e2d3c4b5a6978'; const M = '36b1a1a7-2a48-416a-9dfe-ce66fe1ec2a5';
const ev = (attempt, step, status = 'ok', n = 1, extra = {}) => ({ v: 1, attempt, step, status, device: 'mobile', product: 'coque-personnalisee-apple-iphone-13', n, consent: 'analytics', ...extra });

async function serve(handler) { const server = http.createServer(handler); await new Promise((r) => server.listen(0, '127.0.0.1', r)); return { url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => server.close(r)) }; }
const post = (url, body, origin = 'https://habb.be', ct = 'text/plain;charset=UTF-8') => fetch(url + COLLECT_PATH, { method: 'POST', headers: { 'content-type': ct, ...(origin ? { origin } : {}) }, body: typeof body === 'string' ? body : JSON.stringify(body) });

test('PZ-1 an event is accepted only with the known fields; a file name, a URL, a text or a contact makes the whole event refused', () => {
  assert.equal(validatePersonalizerEvent(ev(A, 'photo_chosen')).ok, true);
  for (const bad of [{ fileName: 'IMG_1234.jpg' }, { photoUrl: 'https://cdn.shopify.com/x.png' }, { text: 'Pour Léa' }, { email: 'a@b.be' }, { ip: '1.2.3.4' }, { userAgent: 'x' }]) {
    const r = validatePersonalizerEvent(ev(A, 'photo_chosen', 'ok', 1, bad)); assert.equal(r.ok, false); assert.equal(r.reason, 'FIELD_NOT_ALLOWED');
  }
  assert.deepEqual([...PZ_ALLOWED_KEYS].sort(), ['attempt', 'ch', 'consent', 'device', 'n', 'product', 'status', 'step', 'v']);
  assert.equal(validatePersonalizerEvent({ ...ev(A, 'photo_chosen'), consent: 'none' }).reason, 'NO_CONSENT');
  assert.equal(validatePersonalizerEvent({ ...ev(A, 'photo_chosen'), consent: undefined }).reason, 'NO_CONSENT');
  assert.equal(validatePersonalizerEvent(ev('not-hex!', 'photo_chosen')).reason, 'ATTEMPT');
  assert.equal(validatePersonalizerEvent(ev(A, 'cart_submit', 'no_photo')).reason, 'STATUS'); // a status that does not belong to the step
  assert.equal(validatePersonalizerEvent(ev(A, 'file_name')).reason, 'STEP');
  assert.equal(validatePersonalizerEvent(ev(A, 'photo_chosen', 'ok', 1, { product: 'IMG 1234.jpg' })).reason, 'PRODUCT');
  assert.equal(validatePersonalizerEvent(ev(A, 'photo_chosen', 'ok', 0)).reason, 'N');
  assert.ok(Object.keys(PZ_STEPS).includes('cart_confirmed') && Object.keys(PZ_STEPS).includes('cart_submit'));
});

test('PZ-2 the public receiver: origin, size, schema, silent answers, one row per (attempt, step, n), a flood is stopped', async () => {
  const store = createMemoryPersonalizerStore(); const srv = await serve(createPersonalizerCollector({ store, perIpPerMinute: 1000, perAttempt: 6 }));
  try {
    assert.equal((await post(srv.url, ev(A, 'photo_chosen'))).status, 204);
    assert.equal((await post(srv.url, ev(A, 'photo_chosen'))).status, 204); // the SAME event again (a re-emission)
    assert.equal(store._all().length, 1, 'stored once');
    assert.equal((await post(srv.url, ev(A, 'photo_chosen', 'ok', 2))).status, 204); // a second occurrence (the visitor changed the photo)
    assert.equal(store._all().length, 2);
    assert.equal((await post(srv.url, ev(A, 'photo_chosen'), 'https://evil.example')).status, 403);
    assert.equal((await post(srv.url, ev(A, 'photo_chosen'), null)).status, 403); // no Origin
    assert.equal((await post(srv.url, ev(B, 'photo_chosen', 'ok', 1, { fileName: 'IMG_1.jpg' }))).status, 204); // refused by the schema: silent, nothing stored
    assert.equal(store._all().length, 2);
    assert.equal((await post(srv.url, 'x'.repeat(2000))).status, 413);
    assert.equal((await post(srv.url, '{not json')).status, 204);
    assert.equal((await fetch(srv.url + COLLECT_PATH, { headers: { origin: 'https://habb.be' } })).status, 405);
    const pre = await fetch(srv.url + COLLECT_PATH, { method: 'OPTIONS', headers: { origin: 'https://habb.be' } }); assert.equal(pre.status, 204); assert.equal(pre.headers.get('access-control-allow-origin'), 'https://habb.be');
    for (let i = 3; i <= 9; i++) await post(srv.url, ev(A, 'photo_chosen', 'ok', i)); // per-attempt cap (6): the surplus is dropped
    assert.ok(store._all().filter((r) => r.attempt_id === A).length <= 6);
    const row = store._all()[0]; assert.deepEqual(Object.keys(row).sort(), ['attempt_id', 'device', 'n', 'product', 'provenance', 'received_at', 'status', 'step']); // no merchant, ip, agent or any other trace in the row
  } finally { await srv.close(); }
  const flooded = await serve(createPersonalizerCollector({ store: createMemoryPersonalizerStore(), perIpPerMinute: 3 }));
  try { const codes = []; for (let i = 0; i < 5; i++) codes.push((await post(flooded.url, ev(A, 'photo_chosen', 'ok', i + 1))).status); assert.deepEqual(codes, [204, 204, 204, 429, 429]); } finally { await flooded.close(); }
});

test('PZ-3 the two replayed cases: an obstacle then stop, and an obstacle then photo then a double click = ONE confirmed add', () => {
  const t0 = Date.parse('2026-11-18T12:00:00Z'); let k = 0; const at = () => new Date(t0 + (k++) * 1000).toISOString();
  const rows = (arr) => arr.map(([att, step, status, n]) => ({ attempt_id: att, step, status, device: 'mobile', product: 'coque-personnalisee-apple-iphone-13', n: n ?? 1, received_at: at() }));
  const case1 = rows([[A, 'submit_blocked_no_photo', 'no_photo']]);
  const case2 = rows([[B, 'submit_blocked_no_photo', 'no_photo'], [B, 'photo_chosen', 'ok'], [B, 'send_clicked', 'ok'], [B, 'design_ready', 'ok'], [B, 'cart_submit', 'ok'], [B, 'cart_confirmed', 'ok']]);
  const s1 = summarizePersonalizer(case1); const s2 = summarizePersonalizer(case2); const both = summarizePersonalizer([...case1, ...case2]);
  assert.equal(s1.outcomes.LAST_EVENT_OBSTACLE, 1); assert.equal(s1.obstacles.met, 1); assert.equal(s1.obstacles.thenContinued, 0);
  assert.equal(s1.steps.cart_confirmed.total, 0); assert.equal(s1.abandon.status, 'NOT_OBSERVABLE'); // never presented as a confirmed abandon
  assert.equal(s2.outcomes.CONFIRMED, 1); assert.equal(s2.obstacles.thenContinued, 1); assert.equal(s2.outcomes.LAST_EVENT_OBSTACLE, undefined, 'obstacle then photo is NOT counted as stopped');
  assert.equal(s2.steps.cart_submit.total, 1); assert.equal(s2.steps.cart_confirmed.total, 1);
  assert.equal(both.attempts, 2); assert.equal(both.steps.submit_blocked_no_photo.total, 2); assert.equal(both.steps.cart_confirmed.total, 1); assert.equal(both.outcomes.CONFIRMED, 1);
  // a re-emission and a double click can never inflate: the store keeps one row per (attempt, step, n), and the summary counts distinct attempts
  const dup = summarizePersonalizer([...case2, ...case2.map((r) => ({ ...r, n: 2 })), ...case2]); assert.equal(dup.steps.cart_confirmed.total, 1); assert.equal(dup.steps.cart_submit.total, 1);
  // an attempt WITHOUT the cart confirmation is a "tentative", never an add
  const unconf = summarizePersonalizer(rows([[A, 'photo_chosen', 'ok'], [A, 'send_clicked', 'ok'], [A, 'design_ready', 'ok'], [A, 'cart_submit', 'ok']]));
  assert.equal(unconf.outcomes.SUBMITTED_UNCONFIRMED, 1); assert.equal(unconf.outcomes.CONFIRMED, undefined); assert.equal(unconf.steps.cart_submit.total, 1); assert.equal(unconf.steps.cart_confirmed.total, 0);
  assert.equal(summarizePersonalizer(rows([[A, 'cart_submit', 'ok'], [A, 'cart_not_found', 'not_found']])).outcomes.SUBMITTED_NOT_FOUND, 1);
  assert.equal(summarizePersonalizer([]).status, 'NO_DATA');
});

test('PZ-5 hosted: the receiver is public (a visitor has no session), every other API route still needs the Nordla session', async () => {
  const store = createMemoryPersonalizerStore(); const collect = createPersonalizerCollector({ store });
  const gate = { authorize: async () => ({ ok: false, status: 401, body: { error: { code: 'AUTH_REQUIRED' } } }), handle: async () => false };
  const handler = createHostedGrowth({ gate, merchantId: M, historyScope: 'x'.repeat(64), app: (req, res) => { res.writeHead(200); res.end('app'); }, store: { list: async () => [], put: async () => ({ ok: true }) }, collect });
  const srv = await serve(handler);
  try {
    assert.equal((await post(srv.url, ev(A, 'photo_chosen'))).status, 204); assert.equal(store._all().length, 1);
    assert.equal((await fetch(srv.url + '/api/growth/funnel')).status, 401);
    assert.equal((await fetch(srv.url + '/api/growth/collect/other')).status, 401);
  } finally { await srv.close(); }
});

test('PZ-7 the table stores technical columns only (no photo, URL, file name, text, contact, IP, agent or visitor id) and is service-role only', async () => {
  const sql = await readFile(new URL('../supabase/migrations-pending/20261118200000_growth_personalizer_events.sql', import.meta.url), 'utf8');
  const body = sql.split('create table if not exists public.growth_personalizer_events (')[1].split(/\n\);/)[0];
  const cols = body.split('\n').map((l) => l.trim()).filter((l) => /^[a-z_]+ (uuid|text|smallint|timestamptz)/.test(l)).map((l) => l.split(' ')[0]);
  assert.deepEqual(cols, ['merchant_id', 'attempt_id', 'step', 'status', 'device', 'product', 'n', 'received_at']);
  assert.match(sql, /enable row level security/); assert.match(sql, /revoke all on public\.growth_personalizer_events from anon, authenticated/);
  assert.match(sql, /primary key \(merchant_id, attempt_id, step, n\)/); // idempotent re-sends
  assert.doesNotMatch(cols.join(), /ip|agent|email|name|url|text|photo|file|visitor|cookie/);
});

const TZ = 'Europe/Brussels'; const NOW = new Date('2026-11-18T10:00:00Z');
const snapshot = () => ({ source_system: 'shopify_analytics', time_zone: TZ, retrieved_at: '2026-11-18T09:00:00Z', window: { start: '2026-10-19', end: '2026-11-18' }, rows: [
  { scope: 'shop', device: 'mobile', counts: { session: 300, add_to_cart: 15, checkout_start: 6, purchase: 3 } }, { scope: 'shop', device: 'desktop', counts: { session: 150, add_to_cart: 12, checkout_start: 6, purchase: 3 } },
  { scope: 'personalizable', device: 'mobile', counts: { session: 120, add_to_cart: 6, checkout_start: 3, purchase: 1 } }, { scope: 'personalizable', device: 'desktop', counts: { session: 40, add_to_cart: 4, checkout_start: 2, purchase: 1 } }] });
async function twoCases(store, provenance = 'live') { for (const e of [ev(A, 'submit_blocked_no_photo', 'no_photo'), ev(B, 'submit_blocked_no_photo', 'no_photo'), ev(B, 'photo_chosen'), ev(B, 'send_clicked'), ev(B, 'design_ready'), ev(B, 'cart_submit'), ev(B, 'cart_confirmed')]) await store.insert({ ...validatePersonalizerEvent(e).row, provenance }); }

test('PZ-4 the drop-off source attaches a FRESH summary of the events (never cached with the snapshot), keeps its own states, and says so when events are not collected', async () => {
  const store = createMemoryPersonalizerStore(); let t = NOW;
  const src = createDropoffSource({ load: async () => snapshot(), timeZone: TZ, now: () => t, personalizerStore: store, cacheMs: 60_000 });
  const first = await src(); assert.equal(first.state, 'OK'); assert.equal(first.personalizer.status, 'NO_DATA');
  await twoCases(store); t = new Date(NOW.getTime() + 5000); // the snapshot is still cached (60 s) but the events are read again
  const second = await src(); assert.equal(second.personalizer.status, 'OK'); assert.equal(second.personalizer.attempts, 2); assert.equal(second.personalizer.steps.cart_confirmed.total, 1); assert.equal(second.personalizer.steps.cart_submit.total, 1);
  assert.equal(second.personalizer.outcomes.CONFIRMED, 1); assert.equal(second.personalizer.outcomes.LAST_EVENT_OBSTACLE, 1); assert.equal(second.personalizer.obstacles.thenContinued, 1);
  const nc = await createDropoffSource({ load: async () => null, timeZone: TZ, now: () => NOW, personalizerStore: store, cacheMs: 0 })(); assert.equal(nc.state, 'NOT_CONNECTED'); assert.equal(nc.personalizer.attempts, 2);
  const failing = await createDropoffSource({ load: async () => snapshot(), timeZone: TZ, now: () => NOW, personalizerStore: { list: async () => { throw new Error('db down'); } }, cacheMs: 0 })(); assert.equal(failing.state, 'OK'); assert.equal(failing.personalizer.status, 'UNAVAILABLE');
  const none = await createDropoffSource({ load: async () => snapshot(), timeZone: TZ, now: () => NOW, cacheMs: 0 })(); assert.equal(none.personalizer.status, 'INACTIVE'); assert.equal(none.personalizer.provenance, 'draft_theme_tests'); // no store: collection inactive, said so (never a silent zero)
});

test('PZ-6 the screen: attempt vs confirmed add, obstacle vs abandon, counts only, no confirmed-abandon claim; shown even when the funnel snapshot is not connected', async () => {
  const store = createMemoryPersonalizerStore(); await twoCases(store);
  for (const load of [async () => snapshot(), async () => null]) {
    const payload = JSON.parse(JSON.stringify(await createDropoffSource({ load, timeZone: TZ, now: () => NOW, personalizerStore: store, cacheMs: 0 })()));
    const d = await growthDom('#/dropoff', { dropoff: payload }); const t = text(d.root);
    assert.deepEqual(d.errors, []);
    assert.match(t, /Étapes du personnalisateur/); assert.match(t, /Tentative d’ajout au panier \(cart_submit\)/); assert.match(t, /Ajout confirmé par le panier Shopify/);
    assert.match(t, /Obstacle rencontré : 2 tentatives ; 1 ont ensuite ajouté une photo \(elles ne sont pas des abandons\)/);
    assert.match(t, /dernier événement : refus sans photo \(arrêt non confirmé\)/); assert.match(t, /jamais comme des abandons confirmés/); assert.match(t, /Une tentative d’ajout n’est pas un ajout confirmé/);
    assert.doesNotMatch(t, /\bIMG_|\.jpg|\.png|TEXTE/);
  }
  const empty = await growthDom('#/dropoff', { dropoff: JSON.parse(JSON.stringify(await createDropoffSource({ load: async () => snapshot(), timeZone: TZ, now: () => NOW, personalizerStore: createMemoryPersonalizerStore(), cacheMs: 0 })())) });
  assert.match(text(empty.root), /Collecte live non activée : aucun chiffre client/); // no live key configured here: not the same as inactive, unavailable or active-with-zero
});

test('PZ-8 the events table reads the SAME summary as the card: photo_chosen -> Photo chargée, design_ready -> Personnalisation terminée, cart_submit stays an attempt, cart_confirmed the confirmed add; three states; provenance', async () => {
  const store = createMemoryPersonalizerStore(); await twoCases(store);
  const mk = (personalizerStore, load = async () => snapshot()) => createDropoffSource({ load, timeZone: TZ, now: () => NOW, personalizerStore, cacheMs: 0, collect: { test: 'testchannelkey0123456789abcd', live: 'livechannelkey0123456789abcdef' } })().then((x) => JSON.parse(JSON.stringify(x)));
  const d = await growthDom('#/dropoff', { dropoff: await mk(store) }); const t = text(d.root);
  const evRows = (root) => { const rows = []; const walk = (n) => { if (n.tagName === 'TR' && /gr-do-pz-ev/.test(n.className)) rows.push(text(n)); (n.children || []).forEach(walk); }; walk(root); return rows; };
  const rows = evRows(d.root); const row = (re) => rows.find((r) => re.test(r)) || '';
  assert.match(row(/Photo chargée/i), /habb_personalizer › photo_chosen.*Mesuré.*1 tentatives \(mobile 1 · ordinateur 0\)/);
  assert.match(row(/Personnalisation terminée/i), /habb_personalizer › design_ready.*Mesuré.*1 tentatives/);
  assert.match(row(/Tentative d’ajout au panier/i), /cart_submit.*1 tentatives/); assert.match(row(/Ajout confirmé par le panier Shopify/i), /cart_confirmed.*1 tentatives/);
  assert.match(row(/Refus « photo manquante »/i), /submit_blocked_no_photo.*2 tentatives/);
  // the same numbers in the card
  assert.match(t, /Photo ajoutée1mobile 1 · ordinateur 0/); assert.match(t, /Ajout confirmé par le panier Shopify1mobile 1 · ordinateur 0/); assert.match(t, /Tentative d’ajout au panier \(cart_submit\)1mobile 1/);
  assert.match(t, /Les essais du thème brouillon ne sont jamais comptés ici/); assert.match(t, /dernier événement : refus sans photo \(arrêt non confirmé\)/);
  // three different states, never the same message
  const inactive = text((await growthDom('#/dropoff', { dropoff: await mk(null) })).root); assert.match(inactive, /Collecte inactive/); assert.match(inactive, /collecte inactive/); assert.doesNotMatch(inactive, /Collecte active/);
  const zero = text((await growthDom('#/dropoff', { dropoff: await mk(createMemoryPersonalizerStore()) })).root); assert.match(zero, /Collecte live active : aucun événement client reçu/); assert.match(zero, /collecte live active, 0 événement client/); assert.doesNotMatch(zero, /Collecte inactive/);
  const down = text((await growthDom('#/dropoff', { dropoff: await mk({ list: async () => { throw new Error('db'); } }) })).root); assert.match(down, /Données indisponibles : les événements n’ont pas pu être lus/); assert.match(down, /données indisponibles/);
  for (const x of [zero, down, inactive]) assert.doesNotMatch(x, /Ajout confirmé par le panier Shopify.{0,3}[1-9]/); // no invented number in a state without data
});

const T = 'testchannelkey0123456789abcd'; const L = 'livechannelkey0123456789abcdef'; const X = 'forgedchannelkey0123456789abcd';
const CH = { test: T, live: L };

test('PZ-9 PROVENANCE is decided by the SERVER configuration: test key -> test, live key -> live (only when live is enabled), anything else -> unknown; a claim in the event is refused', async () => {
  assert.equal(validatePersonalizerEvent(ev(A, 'photo_chosen', 'ok', 1, { ch: T })).ok, true);
  for (const claim of [{ provenance: 'live' }, { source: 'live' }, { live: true }, { test: false }, { env: 'production' }]) assert.equal(validatePersonalizerEvent(ev(A, 'photo_chosen', 'ok', 1, claim)).reason, 'FIELD_NOT_ALLOWED', JSON.stringify(claim));
  assert.equal(validatePersonalizerEvent(ev(A, 'photo_chosen', 'ok', 1, { ch: 'x' })).reason, 'CHANNEL');
  assert.equal(channelProvenance(T, CH), 'test'); assert.equal(channelProvenance(L, CH), 'live'); assert.equal(channelProvenance(X, CH), 'unknown'); assert.equal(channelProvenance(null, CH), 'unknown'); assert.equal(channelProvenance(L, { test: T, live: null }), 'unknown', 'live not enabled: the live key classifies nothing');
  const store = createMemoryPersonalizerStore(); const srv = await serve(createPersonalizerCollector({ store, channels: CH, perIpPerMinute: 1000 }));
  try {
    await post(srv.url, ev(A, 'photo_chosen', 'ok', 1, { ch: L })); await post(srv.url, ev(B, 'photo_chosen', 'ok', 1, { ch: T })); await post(srv.url, ev('c3c3c3c3c3c3c3c3', 'photo_chosen')); await post(srv.url, ev('d4d4d4d4d4d4d4d4', 'photo_chosen', 'ok', 1, { ch: X }));
    await post(srv.url, ev('e5e5e5e5e5e5e5e5', 'photo_chosen', 'ok', 1, { ch: L, provenance: 'live' })); // a claim: the whole event is refused
    const by = Object.fromEntries(store._all().map((r) => [r.attempt_id.slice(0, 2), r.provenance])); assert.deepEqual(by, { a1: 'live', '0f': 'test', c3: 'unknown', d4: 'unknown' });
    assert.ok(!store._all().some((r) => 'ch' in r || 'channel' in r), 'the presented key is never stored');
  } finally { await srv.close(); }
  const off = createMemoryPersonalizerStore(); const srv2 = await serve(createPersonalizerCollector({ store: off, channels: { test: T, live: null } }));
  try { await post(srv2.url, ev(A, 'photo_chosen', 'ok', 1, { ch: L })); assert.equal(off._all()[0].provenance, 'unknown'); } finally { await srv2.close(); }
});

test('PZ-10 collectChannels: the test key is derived from a server secret (no variable needed), the live key exists ONLY when set and differs from the test key', () => {
  const a = collectChannels({ NORDLA_CSRF_KEY: 'secret-one' }); const b = collectChannels({ NORDLA_CSRF_KEY: 'secret-one' }); const c = collectChannels({ NORDLA_CSRF_KEY: 'secret-two' });
  assert.match(a.test, /^[a-f0-9]{32}$/); assert.equal(a.test, b.test); assert.notEqual(a.test, c.test); assert.equal(a.live, null, 'live collection is off by default');
  assert.equal(collectChannels({ NORDLA_CSRF_KEY: 'k', GROWTH_COLLECT_LIVE_CHANNEL: L }).live, L);
  assert.equal(collectChannels({ NORDLA_CSRF_KEY: 'k', GROWTH_COLLECT_LIVE_CHANNEL: 'short' }).live, null);
  assert.equal(collectChannels({ GROWTH_COLLECT_TEST_CHANNEL: T, GROWTH_COLLECT_LIVE_CHANNEL: T }).live, null, 'live must differ from test');
  assert.equal(collectChannels({}).test, null);
});

test('PZ-11 MIXED SET: a draft-theme event received AFTER a customer event stays out of the customer figures; API, card and table use the same live-only filter', async () => {
  const store = createMemoryPersonalizerStore(); const srv = await serve(createPersonalizerCollector({ store, channels: CH, perIpPerMinute: 1000 }));
  const C1 = '1111111111111111'; const C2 = '2222222222222222'; const D1 = '3333333333333333'; const U1 = '4444444444444444';
  try {
    // 1) customers (live channel), 2) THEN the draft theme (test channel) after the launch, 3) an old relay (no channel)
    for (const e of [ev(C1, 'photo_chosen', 'ok', 1, { ch: L }), ev(C1, 'send_clicked', 'ok', 1, { ch: L }), ev(C1, 'design_ready', 'ok', 1, { ch: L }), ev(C1, 'cart_submit', 'ok', 1, { ch: L }), ev(C1, 'cart_confirmed', 'ok', 1, { ch: L }), ev(C2, 'submit_blocked_no_photo', 'no_photo', 1, { ch: L })]) await post(srv.url, e);
    for (const e of [ev(D1, 'submit_blocked_no_photo', 'no_photo', 1, { ch: T }), ev(D1, 'photo_chosen', 'ok', 1, { ch: T }), ev(D1, 'send_clicked', 'ok', 1, { ch: T }), ev(D1, 'design_ready', 'ok', 1, { ch: T }), ev(D1, 'cart_submit', 'ok', 1, { ch: T }), ev(D1, 'cart_confirmed', 'ok', 1, { ch: T })]) await post(srv.url, e);
    await post(srv.url, ev(U1, 'cart_submit'));
  } finally { await srv.close(); }
  assert.equal(store._all().length, 13);
  const payload = JSON.parse(JSON.stringify(await createDropoffSource({ load: async () => snapshot(), timeZone: TZ, now: () => new Date(Date.now() + 1000), personalizerStore: store, cacheMs: 0, collect: CH, provenance: 'live' })()));
  const live = payload.personalizer; assert.equal(live.status, 'OK'); assert.equal(live.attempts, 2, 'only the two customer attempts'); assert.equal(live.events, 6); assert.equal(live.steps.cart_confirmed.total, 1, 'ONE confirmed add: the draft one is not added');
  assert.equal(live.steps.cart_submit.total, 1); assert.equal(live.steps.submit_blocked_no_photo.total, 1); assert.equal(live.outcomes.CONFIRMED, 1);
  assert.equal(payload.personalizerTests.attempts, 1); assert.equal(payload.personalizerTests.steps.cart_confirmed.total, 1); assert.deepEqual(payload.personalizerUnknown, { events: 1, attempts: 1 });
  assert.equal(payload.collect.liveEnabled, true); assert.equal(payload.collect.testChannel, T); assert.ok(!JSON.stringify(payload).includes(L), 'the live key never leaves the server');
  const d = await growthDom('#/dropoff', { dropoff: payload }); const t = text(d.root); assert.deepEqual(d.errors, []);
  assert.match(t, /Photo ajoutée1/); assert.match(t, /Ajout confirmé par le panier Shopify1/); // the card: customers only
  const ev1 = (re) => { const out = []; const walk = (n) => { if (n.tagName === 'TR' && /gr-do-pz-ev/.test(n.className)) out.push(text(n)); (n.children || []).forEach(walk); }; walk(d.root); return out.find((r) => re.test(r)) || ''; };
  assert.match(ev1(/cart_confirmed/), /1 tentatives/); assert.match(ev1(/photo_chosen/), /1 tentatives/); assert.doesNotMatch(ev1(/cart_confirmed/), /2 tentatives/); // the table: the same live-only numbers
  assert.match(t, /Essais sur le thème brouillon \(exclus des chiffres clients\)/); assert.match(t, /1 événements de provenance inconnue/);
  // the draft event arrived LAST and still never raised a customer number: remove every test row and the customer figures do not move
  const noTests = JSON.parse(JSON.stringify(await createDropoffSource({ load: async () => snapshot(), timeZone: TZ, now: () => new Date(Date.now() + 1000), personalizerStore: { list: async (a) => (await store.list(a)).filter((r) => r.provenance !== 'test') }, cacheMs: 0, collect: CH })()));
  assert.deepEqual(noTests.personalizer.steps, payload.personalizer.steps);
});

test('PZ-12 the customer view without any live event says so and still shows the tests apart (live not enabled / live enabled with zero)', async () => {
  const store = createMemoryPersonalizerStore(); await twoCases(store, 'test');
  const mk = (collect) => createDropoffSource({ load: async () => snapshot(), timeZone: TZ, now: () => NOW, personalizerStore: store, cacheMs: 0, collect }).call().then((x) => JSON.parse(JSON.stringify(x)));
  const off = await mk({ test: T, live: null }); assert.equal(off.personalizer.status, 'NO_DATA'); assert.equal(off.collect.liveEnabled, false); assert.equal(off.personalizerTests.attempts, 2);
  const tOff = text((await growthDom('#/dropoff', { dropoff: off })).root); assert.match(tOff, /Collecte live non activée : aucun chiffre client/); assert.match(tOff, /collecte live non activée/); assert.match(tOff, /Essais sur le thème brouillon/); assert.doesNotMatch(tOff, /Ajout confirmé par le panier Shopify1mobile/);
  const on = await mk(CH); const tOn = text((await growthDom('#/dropoff', { dropoff: on })).root); assert.match(tOn, /Collecte live active : aucun événement client reçu/); assert.match(tOn, /collecte live active, 0 événement client/);
});

test('PZ-13 FR, EN and NL render the customer card, the tests card and the states without a raw key', async () => {
  const store = createMemoryPersonalizerStore(); await twoCases(store, 'live'); const tests = createMemoryPersonalizerStore(); await twoCases(tests, 'test');
  const both = { list: async (a) => [...(await store.list(a)), ...(await tests.list(a)).map((r) => ({ ...r, attempt_id: r.attempt_id.split('').reverse().join('') }))] };
  const payload = JSON.parse(JSON.stringify(await createDropoffSource({ load: async () => snapshot(), timeZone: TZ, now: () => NOW, personalizerStore: both, cacheMs: 0, collect: CH })()));
  const expect = { fr: [/chiffres clients/, /Essais sur le thème brouillon/], en: [/customer figures/, /Draft-theme tests/], nl: [/klantcijfers/, /Tests op het conceptthema/] };
  for (const lang of ['fr', 'en', 'nl']) {
    const d = await growthDom('#/dropoff', { dropoff: payload, lang }); const t = text(d.root);
    assert.deepEqual(d.errors, [], lang); assert.doesNotMatch(t, /gr\.do\.pz\./, lang + ' raw key'); for (const re of expect[lang]) assert.match(t, re, lang);
  }
});

test('PZ-14 the provenance migration adds a server-assigned column with default unknown and never reclassifies existing rows by itself', async () => {
  const sql = await readFile(new URL('../supabase/migrations-pending/20261118210000_growth_personalizer_provenance.sql', import.meta.url), 'utf8');
  assert.match(sql, /add column if not exists provenance text not null default 'unknown' check \(provenance in \('test', 'live', 'unknown'\)\)/);
  assert.doesNotMatch(sql.replace(/^--.*$/gm, ''), /\bupdate\b/i, 'no data statement in the migration');
});
