// Growth > Contenu: content checks, statuses, capabilities (unknown is never "correct"), tenant isolation, route, UI.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import vm from 'node:vm';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { buildContent, CHECKS, STATUSES, NOT_AVAILABLE, MANY_PROBLEMS } from '../src/growth/content/content.js';
import { contentFacts } from '../src/growth/content/facts.js';
import { createContentSource } from '../src/growth/server/content.js';
import { createGrowthApp } from '../src/growth/server/app.js';
import { createFakeSupabase } from './fixtures/fake-supabase.js';
import { makeContentData, NOW, TZ, CONFIG } from './fixtures/content-sample.js';
import { growthDom, contentPayload, all, text, hasClass, title, navState } from './growth-dom.js';

const UI = new URL('../src/growth/ui/', import.meta.url);
const run = (specs, opts) => buildContent(contentFacts({ data: makeContentData(specs, opts), now: NOW, timeZone: TZ, config: CONFIG }));
const row = (p, id) => p.rows.find((r) => r.id === id);
const COMPLETE = { type: 'Cat', image: 'https://cdn.shopify.com/x.jpg', alt: 'Alt', collection: true };

// ---------- mandatory business cases ----------
test('content case 1: a product without image -> "Sans image" detected, Prioritaire', () => {
  const p = run([{ id: 'a', ...COMPLETE, image: null, alt: null }]);
  assert.deepEqual(row(p, 'a').problems, ['noImage']);
  assert.equal(row(p, 'a').status, 'priority');
  assert.equal(row(p, 'a').rule, 'MAJOR_PROBLEM');
  assert.equal(p.kpis.noImage, 1);
});

test('content case 2: an image without alt text -> a distinct problem ("Sans texte alternatif"), not "Sans image"', () => {
  const p = run([{ id: 'a', ...COMPLETE, alt: null }, { id: 'b', ...COMPLETE, alt: '   ' }]);
  for (const id of ['a', 'b']) { assert.deepEqual(row(p, id).problems, ['noAltText']); assert.equal(row(p, id).status, 'improve'); }
  assert.equal(p.kpis.noAltText, 2);
  assert.equal(p.kpis.noImage, 0);
});

test('content case 3: no product type (the category Core and Growth already use) -> "Sans catégorie"', () => {
  const p = run([{ id: 'a', ...COMPLETE, type: null }, { id: 'b', ...COMPLETE, type: '  ' }]);
  assert.deepEqual(row(p, 'a').problems, ['noType']);
  assert.deepEqual(row(p, 'b').problems, ['noType']);
  assert.equal(row(p, 'a').category, null);
  assert.equal(p.kpis.noType, 2);
});

test(`content case 4: several problems -> higher priority (${MANY_PROBLEMS}+ problems = Prioritaire, deterministic)`, () => {
  const p = run([
    { id: 'two', ...COMPLETE, type: null, alt: null },
    { id: 'three', ...COMPLETE, type: null, alt: null, collection: false },
    { id: 'dupA', ...COMPLETE, title: 'Même nom', type: null, alt: null, skus: [null] },
    { id: 'dupB', ...COMPLETE, title: 'même  NOM' },
  ]);
  assert.equal(row(p, 'two').status, 'improve');
  assert.equal(row(p, 'three').status, 'priority');
  assert.equal(row(p, 'three').rule, 'MANY_PROBLEMS');
  assert.deepEqual(row(p, 'dupA').problems, ['noAltText', 'noType', 'missingSku', 'duplicateTitle']);
  assert.equal(row(p, 'dupA').status, 'priority');
  assert.deepEqual(row(p, 'dupB').problems, ['duplicateTitle'], 'same name, case and spaces ignored');
  assert.ok(p.rows.findIndex((r) => r.id === 'three') < p.rows.findIndex((r) => r.id === 'two'), 'Prioritaire listed first');
});

test('content case 5: no detectable problem -> "Correct" (with the wording "no detectable problem", never "good content")', () => {
  const p = run([{ id: 'a', ...COMPLETE }]);
  assert.equal(row(p, 'a').status, 'correct');
  assert.deepEqual(row(p, 'a').problems, []);
  assert.equal(row(p, 'a').rule, 'NO_DETECTABLE_PROBLEM');
});

test('content case 6: fields not available for the merchant -> "Données insuffisantes", never "Correct"', () => {
  // No product of the merchant has an image: "no image" cannot be told apart from "image never synced".
  const p = run([{ id: 'a', type: 'Cat', collection: true }, { id: 'b', type: null }], { withImagesElsewhere: false });
  assert.equal(p.capabilities.image, false);
  assert.equal(row(p, 'a').status, 'insufficient');
  assert.equal(row(p, 'a').rule, 'ESSENTIAL_CHECK_UNAVAILABLE');
  assert.ok(row(p, 'a').unverified.includes('noImage') && row(p, 'a').unverified.includes('noAltText'));
  assert.equal(row(p, 'b').status, 'improve', 'a problem that IS detectable is still reported');
  assert.equal(p.kpis.noImage, null, 'unknown, not 0');
  assert.equal(p.kpis.noAltText, null);
  assert.equal(p.byStatus.find((s) => s.status === 'correct').count, 0);
  // Collections never synced: the collection check does not run (nobody is flagged "Hors collection").
  const noCol = run([{ id: 'a', ...COMPLETE, collection: false }]);
  assert.equal(noCol.capabilities.collections, true, 'the reference product has one');
  const none = buildContent({ products: [{ id: 'a', title: 'A', product_type: 'T', image_url: 'https://x/y.jpg', image_alt_text: 'a', source_status: 'ACTIVE' }], variants: [], collections: [], sales: new Map(), window: {}, currency: 'EUR' });
  assert.equal(none.capabilities.collections, false);
  assert.deepEqual(none.rows[0].problems, []);
  assert.ok(none.rows[0].unverified.includes('noCollection'));
  assert.deepEqual(none.notAvailable, NOT_AVAILABLE);
});

async function seedTwo() {
  const supabase = createFakeSupabase();
  const [A, B] = [randomUUID(), randomUUID()];
  for (const [m, specs] of [[A, [{ id: `${A}-p`, title: 'Alpha produit', ...COMPLETE }]], [B, [{ id: `${B}-p1`, title: 'Beta produit', type: null }, { id: `${B}-p2`, title: 'Beta deux' }]]]) {
    const d = makeContentData(specs, { merchantId: m, withImagesElsewhere: false });
    await supabase.insert('products', d.products); await supabase.insert('variants', d.variants);
    await supabase.insert('product_collections', d.collections);
  }
  return { supabase, A, B };
}
test('content case 7: two merchants -> no leak between A and B; merchant required and fixed at creation', async () => {
  const { supabase, A, B } = await seedTwo();
  const pa = await createContentSource({ supabase, merchantId: A, now: () => NOW })();
  const pb = await createContentSource({ supabase, merchantId: B, now: () => NOW })();
  assert.deepEqual(pa.rows.map((r) => r.title), ['Alpha produit']);
  assert.deepEqual(pb.rows.map((r) => r.title).sort(), ['Beta deux', 'Beta produit']);
  assert.equal(pa.capabilities.image, true);
  assert.equal(pb.capabilities.image, false, 'A\'s images never make B\'s image check look available');
  assert.ok(!JSON.stringify(pa).includes('Beta'));
  assert.throws(() => createContentSource({ supabase }), TypeError);
});

// ---------- scope, sales priority, empty ----------
test('content: only ACTIVE products are analysed; sales order the list but never change the problem', () => {
  const p = run([
    { id: 'draft', ...COMPLETE, image: null, status: 'DRAFT' },
    { id: 'arch', ...COMPLETE, image: null, status: 'ARCHIVED' },
    { id: 'quiet', ...COMPLETE, image: null, alt: null, units: 0 },
    { id: 'busy', ...COMPLETE, image: null, alt: null, units: 9 },
  ]);
  assert.ok(!p.rows.some((r) => ['draft', 'arch'].includes(r.id)));
  assert.equal(p.scope.analysed, 3);
  assert.deepEqual(p.rows.slice(0, 2).map((r) => r.id), ['busy', 'quiet'], 'same problem: the product that sells comes first');
  assert.deepEqual(row(p, 'busy').problems, row(p, 'quiet').problems);
  assert.equal(row(p, 'busy').units, 9);
  assert.equal(p.byStatus.reduce((a, s) => a + s.count, 0), p.rows.length, 'donut total = products analysed');
  assert.ok(p.problems.length <= 5);
  for (const s of p.byStatus) assert.ok(STATUSES.includes(s.status));
});

test('content: empty catalog and "all clear" states are explicit', () => {
  const empty = buildContent({ products: [], variants: [], collections: [], sales: new Map(), window: {}, currency: 'EUR' });
  assert.equal(empty.rows.length, 0);
  assert.equal(empty.kpis.toImprove, 0);
  const clear = run([{ id: 'a', ...COMPLETE }]);
  assert.equal(clear.kpis.toImprove, 0);
  assert.deepEqual(clear.problems, []);
});

// ---------- route ----------
async function serve(opts) {
  const server = http.createServer(createGrowthApp(opts));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { base: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => server.close(r)) };
}
test('content route: no tenant -> 503 TENANT_NOT_CONFIGURED; request parameters never choose the merchant', async () => {
  const none = await serve({});
  try {
    const r = await fetch(`${none.base}/api/growth/content`);
    assert.equal(r.status, 503);
    assert.deepEqual(await r.json(), { error: { code: 'TENANT_NOT_CONFIGURED' } });
    assert.equal((await fetch(`${none.base}/content.js`)).status, 200);
  } finally { await none.close(); }
  const { supabase, A, B } = await seedTwo();
  const calls = [];
  const source = createContentSource({ supabase, merchantId: A, now: () => NOW });
  const app = await serve({ content: (...args) => { calls.push(args); return source(); } });
  try {
    for (const q of ['', `?merchantId=${B}`, `?merchant_id=${B}&tenant=${B}`]) {
      const d = await (await fetch(`${app.base}/api/growth/content${q}`, { headers: { 'x-merchant-id': B } })).json();
      assert.deepEqual(d.rows.map((r) => r.title), ['Alpha produit'], `query "${q}" is ignored`);
    }
    assert.ok(calls.every((a) => a.length === 0));
  } finally { await app.close(); }
});

// ---------- UI ----------
test('content UI: every label exists in FR/NL/EN; no mockup figure, review, uplift or AI wording in the code', async () => {
  const ctx = { window: {} };
  for (const l of ['fr', 'nl', 'en']) vm.runInNewContext(await readFile(new URL(`lang-${l}.js`, UI), 'utf8'), ctx);
  const D = ctx.window.NORDLA_DICTS;
  const src = await readFile(new URL('content.js', UI), 'utf8');
  const RULES = ['MAJOR_PROBLEM', 'MANY_PROBLEMS', 'MINOR_PROBLEMS', 'ESSENTIAL_CHECK_UNAVAILABLE', 'NO_DETECTABLE_PROBLEM'];
  const keys = [
    ...[...src.matchAll(/\bt\('(gr\.[\w.]+)'/g)].map((m) => m[1]),
    ...CHECKS.flatMap((c) => ['problem', 'fact', 'explain', 'reco', 'recoHow'].map((g) => `gr.ct.${g}.${c.code}`)),
    ...STATUSES.map((s) => `gr.ct.status.${s}`), ...RULES.map((r) => `gr.ct.rule.${r}`), ...NOT_AVAILABLE.map((x) => `gr.ct.na.${x}`),
    ...['product', 'category', 'problems', 'status', 'sales', 'action'].map((c) => `gr.ct.col.${c}`),
    'gr.ct.title', 'gr.ct.subtitle', 'gr.nav.content',
  ];
  for (const k of keys) for (const l of ['fr', 'nl', 'en']) assert.ok(D[l][k], `missing ${l} key ${k}`);
  const ct = (l) => Object.keys(D[l]).filter((k) => k.startsWith('gr.ct.')).sort();
  assert.deepEqual(ct('nl'), ct('fr')); assert.deepEqual(ct('en'), ct('fr'));
  for (const l of ['fr', 'nl', 'en']) for (const k of ct(l)) assert.ok(!/\+\s?\d+\s?%/.test(D[l][k]), `no uplift figure in ${k}`);
  assert.equal(D.fr['gr.ct.empty.clearTitle'], 'Aucun problème de contenu détecté avec les données actuellement disponibles.');
  for (const f of [new URL('content.js', UI), new URL('../src/growth/content/content.js', import.meta.url), new URL('../src/growth/content/facts.js', import.meta.url)]) {
    const code = await readFile(f, 'utf8');
    for (const v of ['Baskets', 'SKU-001', '+35', '+12 %', 'avis', 'review_count', 'openai', 'anthropic', 'generate(']) assert.ok(!code.includes(v), `${f.pathname}: "${v}"`);
  }
});

test('content UI: renders, nav entry active, filters work, a row opens the detail panel with problems and recommendations', async () => {
  const { root, errors } = await growthDom('#/content');
  assert.deepEqual(errors, []);
  assert.equal(title(root), 'Contenu');
  assert.deepEqual(navState(root).filter((n) => n.active).map((n) => [n.label, n.href]), [['Contenu', '#/content']]);
  assert.ok(text(root).includes('8 dernières semaines'));
  assert.equal(all(root, (n) => hasClass(n, 'ex-kpi')).length, 5);
  const rows = () => all(root, (n) => hasClass(n, 'gr-ct-row'));
  assert.equal(rows().length, 6, '5 products + the image reference product');
  assert.ok(text(rows()[0]).includes('Baskets'), 'Prioritaire (no image) and sold 12 times: first');
  const selects = () => all(all(root, (n) => hasClass(n, 'gr-ct-selects'))[0], (n) => n.tagName === 'SELECT');
  selects()[1].listeners.change[0]({ target: { value: 'missingSku' } });
  assert.deepEqual(rows().map((r) => text(r.children[0].children[1].children[0])), ['Casquette']);
  selects()[1].listeners.change[0]({ target: { value: 'all' } });
  rows()[0].listeners.click[0]();
  const drawer = all(root, (n) => hasClass(n, 'gr-pp-drawer'))[0];
  for (const s of ['Problèmes détectés', 'Aucune image principale n’est disponible pour ce produit.', 'Pourquoi c’est important', 'Recommandations', 'Ajouter une image produit de qualité.', 'Non vérifiable avec les données actuelles']) assert.ok(text(drawer).includes(s), s);
  const improve = all(drawer, (n) => n.tagName === 'BUTTON' && text(n) === 'Améliorer ce produit')[0];
  assert.equal(improve.getAttribute('disabled'), 'disabled');
  assert.deepEqual(errors, []);
});

test('content UI: insufficient data and missing tenant are explicit states', async () => {
  const ins = await growthDom('#/content', { content: contentPayload(makeContentData([{ id: 'a', type: 'Cat', collection: true }], { withImagesElsewhere: false })) });
  assert.deepEqual(ins.errors, []);
  assert.ok(text(ins.root).includes('Images non vérifiables'));
  assert.ok(text(ins.root).includes('Données insuffisantes'));
  assert.ok(!text(ins.root).includes('Aucun problème de contenu détecté'), 'never "all clear" when the image cannot be checked');
  const clear = await growthDom('#/content', { content: contentPayload(makeContentData([{ id: 'a', ...COMPLETE }])) });
  assert.ok(text(clear.root).includes('Aucun problème de contenu détecté avec les données actuellement disponibles.'));
  const none = await growthDom('#/content', { contentStatus: 503 });
  assert.deepEqual(none.errors, []);
  assert.equal(all(none.root, (n) => hasClass(n, 'ex-kpi')).length, 0);
});

test('content UI: every icon used exists (official set or Growth pack) and none is a defective asset', async () => {
  const ctx = { window: {}, document: { createElement: () => ({ setAttribute() {} }) } };
  vm.runInNewContext(await readFile(new URL('../src/shared/nordla-icon.js', import.meta.url), 'utf8'), ctx);
  const NI = ctx.window.NordlaIcon;
  const app = await readFile(new URL('app.js', UI), 'utf8');
  const pack = new Set([...app.split('const GROWTH_PACK = {')[1].split('};')[0].matchAll(/(\w+): '/g)].map((m) => m[1]));
  const icons = new Set([...app.split('const GROWTH_ICONS = {')[1].split('};')[0].matchAll(/(\w+): '/g)].map((m) => m[1]));
  const src = await readFile(new URL('content.js', UI), 'utf8');
  const names = [...new Set([...src.matchAll(/(?:gi|cardHead|kpi|semantic)\('([\w:]+)'/g)].map((m) => m[1]))];
  assert.ok(names.length >= 5);
  for (const n of names) {
    if (n.startsWith('pack:')) assert.ok(pack.has(n.slice(5)), n);
    else if (icons.has(n)) assert.ok(true);
    else { assert.ok(!NI.DEFECTIVE[n], `defective ${n}`); assert.ok(NI.has(n), `unknown ${n}`); }
  }
});
