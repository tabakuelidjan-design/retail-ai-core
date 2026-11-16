// Lot _10 closure: TWO MERCHANTS. Both import a conversation with the SAME id but different content and state. Neither the imported conversations nor the qualifications may pass from one merchant to
// the other: not on the server (each source and review is fixed to its merchant), not in the local follow-up (keyed by the merchant's scope), not after a reload. An import whose merchant cannot
// be established is refused when the context requires it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import http from 'node:http';
import { createInboxSource, createInboxReviewSource, merchantRefOf } from '../src/growth/server/inbox.js';
import { createGrowthApp } from '../src/growth/server/app.js';
import { growthDom, prioritiesPayload, potentialPayload, audiencePayload, contentPayload, storePayload, text, all, hasClass } from './growth-dom.js';

const NOW = new Date('2026-11-15T12:00:00Z'); const FROM = '2026-11-03';
const ClockDate = class extends Date { constructor(...a) { if (a.length) super(...a); else super(NOW.getTime()); } static now() { return NOW.getTime(); } };
const A = 'merchant-a'; const B = 'merchant-b';
const base = (merchant, conversations, extra = {}) => ({ merchant_ref: merchant ? merchantRefOf(merchant) : undefined, source_system: 'inbox_import_SIM', method: 'aggregate_export', network: 'instagram', account: { id: 'ig-9001', handle: '@atelier_sim' }, market: 'BE', window: { start: '2026-10-18', end: '2026-11-15' }, retrieved_at: '2026-11-15T06:00:00Z', complete: true, conversations, ...extra });
// the SAME ids c1..c3, different content and different qualification state per merchant
const FILE_A = (extra) => base(A, [{ id: 'c1', started_at: '2026-11-03', messages: 9, origin: { kind: 'post', post_id: 'test1', attribution: 'connection' }, qualified: 'qualified' }, { id: 'c2', started_at: '2026-11-04', messages: 2, origin: { kind: 'post', post_id: 'test1', attribution: 'connection' } }, { id: 'c3', started_at: '2026-11-05', messages: 1, origin: { kind: 'unknown' } }], extra);
const FILE_B = (extra) => base(B, [{ id: 'c1', started_at: '2026-11-06', messages: 1, origin: { kind: 'unknown' }, qualified: 'not_qualified' }, { id: 'c2', started_at: '2026-11-05', messages: 5, origin: { kind: 'post', post_id: 'other-post', attribution: 'connection' } }, { id: 'c3', started_at: '2026-11-04', messages: 3, origin: { kind: 'post', post_id: 'test1', attribution: 'connection' }, qualified: 'qualified' }], extra);
const known = async () => [{ network: 'instagram', id: 'ig-9001', handle: '@atelier_sim', linkedTestId: null }];
const src = (merchantId, file, o = {}) => createInboxSource({ loaders: { instagram: async () => file }, accounts: known, now: () => NOW, cacheMs: 0, merchantId, ...o });
const rev = (merchantId, file, o = {}) => createInboxReviewSource({ loaders: { instagram: async () => file }, now: () => NOW, merchantId, ...o });
const q = { id: 'test1', network: 'instagram', account: 'ig-9001', days: '7', from: FROM, type: 'quote' };

test('TEN-1 server: the same conversation id in two merchants stays two different conversations; each source and each review sees only its own', async () => {
  const a = await src(A, FILE_A())(); const b = await src(B, FILE_B())();
  const ta = a.accounts[0].threads; const tb = b.accounts[0].threads;
  assert.deepEqual([ta.find((t) => t.id === 'c1').messages, ta.find((t) => t.id === 'c1').source, ta.find((t) => t.id === 'c1').origin.postId, ta.find((t) => t.id === 'c1').startedAt], [9, 'qualified', 'test1', '2026-11-03']);
  assert.deepEqual([tb.find((t) => t.id === 'c1').messages, tb.find((t) => t.id === 'c1').source, tb.find((t) => t.id === 'c1').origin, tb.find((t) => t.id === 'c1').startedAt], [1, 'not_qualified', null, '2026-11-06'], 'B\'s c1 is not A\'s c1');
  const ra = await rev(A, FILE_A())({ ...q, qualified: 'c1' }); const rb = await rev(B, FILE_B())({ ...q, qualified: 'c1' }); // the SAME ids typed in both requests
  assert.deepEqual([ra.counts.unique, ra.counts.qualified, ra.accountLevel.conversations, ra.accountLevel.unknownOrigin], [2, 1, 3, 1]);
  assert.deepEqual([rb.counts.unique, rb.counts.qualified, rb.accountLevel.conversations, rb.accountLevel.otherPublications], [1, 1, 3, 1], 'B has ONE attributed conversation (its c3, qualified by ITS source); the "c1" typed in the request is B\'s unknown-origin c1 and counts for nothing');
  const rb0 = await rev(B, FILE_B())({ ...q }); assert.deepEqual([rb0.counts.unique, rb0.counts.qualified], [1, 1], 'with no id typed: A\'s c1 never reaches B');
  assert.ok(!JSON.stringify(b).includes('"messages":9') && !JSON.stringify(a).includes('"messages":5'), 'nothing of the other merchant\'s content is present');
});

test('TEN-2 an import whose merchant is another one, or cannot be established when the context requires proof, is refused: no conversation, no item, no review', async () => {
  const swapped = await src(A, FILE_B())(); assert.deepEqual([swapped.accounts[0].state, swapped.accounts[0].errors, swapped.items.length, swapped.accounts[0].threads], ['INVALID', ['MERCHANT_MISMATCH'], 0, undefined]);
  const noProof = await src(A, base(null, FILE_A().conversations))(); assert.deepEqual([noProof.accounts[0].state, noProof.accounts[0].errors, noProof.items.length], ['INVALID', ['MERCHANT_UNKNOWN'], 0]);
  assert.equal((await rev(A, FILE_B())({ ...q })).limits[0], 'SOURCE_UNAVAILABLE'); assert.equal((await rev(A, base(null, FILE_A().conversations))({ ...q })).limits[0], 'SOURCE_UNAVAILABLE');
  assert.equal((await src(A, base(null, FILE_A().conversations), { requireMerchantProof: false })()).accounts[0].state, 'OK', 'the context may waive the proof (a local statement); a file naming ANOTHER merchant is still refused');
  assert.equal((await src(A, FILE_B(), { requireMerchantProof: false })()).accounts[0].state, 'INVALID');
  assert.equal((await src(null, base(null, FILE_A().conversations))()).accounts[0].state, 'OK', 'no merchant context (a local demonstration): nothing to compare, stated by the absence of the proof requirement');
  assert.equal((await src(A, FILE_A({ merchant_ref: 'not-a-hash' }))()).accounts[0].state, 'INVALID', 'a malformed proof is no proof');
});

test('TEN-3 app level: each merchant\'s Growth server has its own history scope and serves its own conversations and review; the merchant is never read from the request', async () => {
  const mk = (merchantId, file) => createGrowthApp({ merchantId, inbox: src(merchantId, file), inboxReview: rev(merchantId, file), now: () => NOW, productPotential: async () => potentialPayload(), audience: async () => audiencePayload(), content: async () => contentPayload(), store: async () => storePayload() });
  const serve = async (app) => { const s = http.createServer(app); await new Promise((r) => s.listen(0, '127.0.0.1', r)); const base = `http://127.0.0.1:${s.address().port}`; return { get: async (p) => (await fetch(base + p)).json(), close: () => new Promise((r) => s.close(r)) }; };
  const sa = await serve(mk(A, FILE_A())); const sb = await serve(mk(B, FILE_B()));
  try {
    const oa = await sa.get('/api/growth/opportunities'); const ob = await sb.get('/api/growth/opportunities');
    const scope = (m) => createHash('sha256').update(m).digest('hex');
    assert.deepEqual([oa.historyScope, ob.historyScope], [scope(A), scope(B)]); assert.notEqual(oa.historyScope, ob.historyScope);
    assert.deepEqual([oa.inbox.accounts[0].threads.find((t) => t.id === 'c1').messages, ob.inbox.accounts[0].threads.find((t) => t.id === 'c1').messages], [9, 1]);
    const path = '/api/growth/review?type=inbox&id=test1&network=instagram&account=ig-9001&days=7&from=2026-11-03&applied=2026-11-03&review=2026-11-12&qualified=c1&merchantId=merchant-b&merchant=merchant-b';
    const ra = await sa.get(path); const rb = await sb.get(path); assert.deepEqual([ra.counts.qualified, rb.counts.qualified, ra.counts.unique, rb.counts.unique], [1, 1, 2, 1], 'a merchant sent in the query changes nothing');
  } finally { await sa.close(); await sb.close(); }
});

// ---------- the local follow-up ----------
const reviewVia = (merchantId, file, urls) => (u) => { urls.push(u); const p = new URL(u, 'http://x').searchParams; return rev(merchantId, file)({ id: p.get('id'), network: p.get('network'), account: p.get('account'), days: p.get('days'), from: p.get('from'), type: p.get('requestType'), qualified: p.get('qualified'), notQualified: p.get('notQualified'), declared: p.get('declared') }); };
const store = () => { const m = new Map(); return { m, api: { get length() { return m.size; }, key: (i) => [...m.keys()][i], getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, v) } }; };
const norm = (t) => t.replace(/[  ]/g, ' ');
const tick = (ms = 40) => new Promise((r) => setTimeout(r, ms));
const PUB = { stage: 'published', state: 'PUBLISHED', confirmed: true, simulated: false, plannedDay: '2026-11-02', publishedDay: '2026-11-03', publishedAt: '2026-11-03T17:05:00Z', networkPostId: 'test1', permalink: 'https://www.instagram.com/reel/test1/', reviewDueDay: '2026-11-10', observationDays: 7, measurement: 'READY', socialPostId: 'post_1', links: { testId: 'social:instagram:ig-9001', briefId: 'brief_x', briefVersion: 1, creationId: 'c', creationVersion: 1 } };
const open = async (merchantId, file, scope, st, urls) => { const s = await createInboxSource({ loaders: { instagram: async () => file }, accounts: async () => [{ network: 'instagram', id: 'ig-9001', handle: '@atelier_sim', linkedTestId: 'social:instagram:ig-9001' }], now: () => NOW, cacheMs: 0, merchantId })();
  const inbox = { ...s, items: s.items.map((i) => ({ ...i, publication: PUB })) }; const ui = await growthDom('#/overview', { opportunities: { ...prioritiesPayload(), historyScope: scope, inbox }, review: reviewVia(merchantId, file, urls) }); ui.ctx.localStorage = st.api; ui.ctx.Date = ClockDate; await ui.navigate('#/opportunities'); assert.deepEqual(ui.errors, []); return ui; };
const ID = 'inbox:instagram:ig-9001';
const rowIn = (ui) => all(all(ui.root, (n) => n.tagName === 'DETAILS' && hasClass(n, 'gv-inbox'))[0], (n) => n.getAttribute?.('data-priority-id') === ID)[0];
const click = (b) => b.listeners.click[0]();
const prim = (row) => all(row, (n) => n.tagName === 'BUTTON' && hasClass(n, 'gv-primary'))[0];
const form = (scope, name) => all(scope, (n) => n.tagName === 'FORM' && n.getAttribute('data-form') === name)[0];
const named = (f, k) => all(f, (n) => n.tagName === 'INPUT' || n.tagName === 'TEXTAREA').find((n) => n.getAttribute('name') === k);
const conv = (row, id, cls) => all(row, (n) => n.getAttribute?.('data-conv') === id).flatMap((li) => all(li, (b) => b.tagName === 'BUTTON' && hasClass(b, cls)))[0];
const convState = (row, id) => norm(text(all(all(row, (n) => n.getAttribute?.('data-conv') === id)[0], (n) => hasClass(n, 'gv-conv-state'))[0])); // the state label only (not the buttons)
const keysOf = (st) => [...st.m.keys()];
function plan(ui) { click(prim(rowIn(ui))); const p = form(rowIn(ui), 'plan'); const n = (k) => named(p, k); n('action').value = n('action').getAttribute('value'); n('metric').value = n('metric').getAttribute('value'); n('baseline').valueAsNumber = 20; n('target').valueAsNumber = 30; n('reviewDate').value = '2026-11-12'; all(p, (x) => x.tagName === 'SELECT')[0].value = 'quote'; p.listeners.submit[0]({ preventDefault() {} }); click(prim(rowIn(ui))); }

test('TEN-4 local follow-up: A qualifies c1 in a shared browser; B (same id c1, other content) sees no qualification and sends none; after a reload A keeps its own and B still has none', async () => {
  const st = store(); const urlsA = []; const urlsB = []; const SA = 'scope-a'; const SB = 'scope-b';
  const FA = FILE_A(); const FB = FILE_B(); FB.conversations[1] = { id: 'c2', started_at: '2026-11-05', messages: 5, origin: { kind: 'post', post_id: 'test1', attribution: 'connection' } }; // B's own c2: same id as A's, other content, attributed, still to qualify
  let ui = await open(A, FA, SA, st, urlsA); plan(ui); assert.ok(norm(text(rowIn(ui))).includes('Conversations de la période'), 'A has plan and publication'); click(conv(rowIn(ui), 'c2', 'gv-q'));
  const ev = [...st.m.values()].flatMap((v) => JSON.parse(v).events).filter((e) => e.type === 'qualify'); assert.deepEqual(ev.map((e) => [e.id, e.state, e.postId]), [['c2', 'qualified', 'test1']]);
  assert.ok(keysOf(st).every((k) => k.includes(`:${SA}:`)), `every stored key belongs to A's scope: ${keysOf(st)}`);
  // B opens the SAME browser with its own scope: it has no plan, so nothing of A is shown; then B prepares its own test and links its publication
  const ub = await open(B, FB, SB, st, urlsB); assert.equal(all(rowIn(ub), (n) => hasClass(n, 'gv-conv-state')).length, 0, 'B has no plan: no conversation list, so nothing of A is shown'); plan(ub);
  assert.ok(convState(rowIn(ub), 'c1').includes('Non qualifiée'), convState(rowIn(ub), 'c1')); // B's own source state for ITS c1
  assert.ok(convState(rowIn(ub), 'c2').includes('À qualifier') && !convState(rowIn(ub), 'c2').includes('Qualifiée'), `B's c2 is still to qualify: ${convState(rowIn(ub), 'c2')}`);
  click(prim(rowIn(ub))); await tick(); const queryB = urlsB.at(-1); assert.equal(new URL(queryB, 'http://x').searchParams.get('qualified'), '', 'B sends no qualification: A\'s c2 is not B\'s');
  assert.deepEqual(keysOf(st).map((k) => k.split(':')[1]).sort(), [SA, SB], 'two separate scopes, nothing mixed');
  // reload A: its qualification is still there, and still only for A
  ui = await open(A, FA, SA, st, urlsA); assert.ok(convState(rowIn(ui), 'c2').includes('Qualifiée'), 'A keeps its own qualification after the reload');
  const ub2 = await open(B, FB, SB, st, urlsB); assert.ok(convState(rowIn(ub2), 'c2').includes('À qualifier'), 'B still has none after the reload');
  click(prim(rowIn(ui))); await tick(); assert.equal(new URL(urlsA.at(-1), 'http://x').searchParams.get('qualified'), 'c2');
});
