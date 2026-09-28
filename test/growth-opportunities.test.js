// Développement des ventes > Opportunités - the page (owner decisions 2026-09-28): three sections fed by the four real engines,
// problems grouped by problem, one card per product, an honest empty commercial state, links to the source pages, no action button.
// Synthetic payloads only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPriorities } from '../src/growth/priorities/priorities.js';
import { growthDom, prioritiesPayload, all, text, hasClass, navState, title, NOW } from './growth-dom.js';
import { smallStore } from './fixtures/growth-priorities-sample.js';
import { frozenViolations } from './frozen-modules.js';

const cards = (root) => all(root, (n) => hasClass(n, 'gr-pr-card'));
const rowsOf = (card) => all(card, (n) => hasClass(n, 'gr-pr-row'));
const section = (root, cls) => all(root, (n) => hasClass(n, cls))[0];
const small = () => buildPriorities({ ...smallStore(), now: NOW });

test('opportunities UI: three sections in order, one row per item of the payload, Opportunités active in the menu', async () => {
  const d = prioritiesPayload();
  const { root, errors } = await growthDom('#/opportunities', { opportunities: d });
  assert.deepEqual(errors, []);
  assert.equal(title(root), 'Opportunités');
  assert.deepEqual(navState(root).filter((n) => n.active).map((n) => [n.label, n.href]), [['Opportunités', '#/opportunities']]);
  assert.deepEqual(cards(root).map((c) => ['gr-pr-fix', 'gr-pr-commercial', 'gr-pr-watch'].find((k) => hasClass(c, k))), ['gr-pr-fix', 'gr-pr-commercial', 'gr-pr-watch']);
  assert.equal(rowsOf(section(root, 'gr-pr-fix')).length, d.sections.fix.length);
  assert.equal(rowsOf(section(root, 'gr-pr-commercial')).length, d.sections.commercial.length);
  assert.equal(rowsOf(section(root, 'gr-pr-watch')).length, d.sections.watch.length);
  // Every rendered row carries the stable id of its priority (statuses can attach to it later).
  assert.deepEqual(all(root, (n) => n.getAttribute && n.getAttribute('data-priority-id')).map((n) => n.getAttribute('data-priority-id')), [...d.sections.fix, ...d.sections.commercial, ...d.sections.watch].map((i) => i.id));
  const kpis = all(root, (n) => hasClass(n, 'ex-kpi'));
  assert.equal(kpis.length, 3);
  assert.ok(text(kpis[0]).includes(String(d.counts.fix)) && text(kpis[1]).includes(String(d.counts.commercial)) && text(kpis[2]).includes(String(d.counts.watch)));
});

test('opportunities UI: a small store sees grouped corrections, an HONEST empty commercial section and weak signals to watch', async () => {
  const d = small();
  const { root, errors } = await growthDom('#/opportunities', { opportunities: d });
  assert.deepEqual(errors, []);
  const fix = section(root, 'gr-pr-fix');
  assert.equal(rowsOf(fix).length, 3, 'costs + two content problems: one row per problem, not one per product');
  assert.ok(text(fix).includes('126 produits sans SKU'));
  assert.ok(text(fix).includes('Coûts d’achat à vérifier : 16 produits vendus'));
  assert.ok(text(fix).includes('La vérification des coûts d’achat n’est pas encore disponible dans Nordla.'), 'the dependency is stated, no validation button');
  const com = section(root, 'gr-pr-commercial');
  assert.equal(rowsOf(com).length, 0);
  assert.ok(text(com).includes('Aucune opportunité commerciale fiable pour l’instant'));
  for (const s of ['plus de clients identifiés : 18 sur les 30', 'des coûts d’achat vérifiés', 'plus de commandes en ligne : 6 sur les 30']) assert.ok(text(com).includes(s), s);
  const watch = section(root, 'gr-pr-watch');
  const w = rowsOf(watch);
  assert.equal(w.length, 2, 'two products, one card each');
  const second = w.find((r) => text(r).includes('Steady best seller'));
  for (const s of ['4 ventes en 8 semaines', 'n° 2 du magasin', 'Suggéré en magasin, non recommandé', 'Coût d’achat non vérifié', 'Fiche produit incomplète', 'Signal faible', 'Il manque :', 'un coût d’achat vérifié']) assert.ok(text(second).includes(s), s);
  const first = w.find((r) => text(r).includes('Rising product'));
  assert.ok(text(first).includes('N° 1 du magasin, écarté de la mise en avant'));
  assert.ok(text(first).includes('le coût d’achat n’est pas vérifié'));
});

test('opportunities UI: links open the source page (navigation only); no button except the shell\'s own (language, Plus)', async () => {
  const { root } = await growthDom('#/opportunities', { opportunities: small() });
  const links = all(root, (n) => n.tagName === 'A' && hasClass(n, 'gr-op-link'));
  assert.ok(links.length >= 4);
  assert.ok(links.every((a) => ['#/potential', '#/content', '#/storeGrowth', '#/audience'].includes(a.getAttribute('href'))));
  const buttons = all(root, (n) => n.tagName === 'BUTTON');
  assert.ok(buttons.every((b) => hasClass(b.parent || {}, 'langswitch') || /^(FR|NL|EN|Plus)$/.test(text(b)) || hasClass(b, 'gr-more-btn')), `unexpected button(s): ${buttons.map(text).join(', ')}`);
  assert.equal(buttons.filter((b) => b.getAttribute('disabled') != null).length, 0);
});

test('opportunities UI: FR / NL / EN render without error and without a raw translation key', async () => {
  for (const lang of ['fr', 'nl', 'en']) {
    for (const d of [prioritiesPayload(), small()]) {
      const { root, errors } = await growthDom('#/opportunities', { opportunities: d, lang });
      assert.deepEqual(errors, [], lang);
      assert.ok(!/\bgr\.[a-z]+\.[\w.]+/.test(text(root)), `${lang}: a key is shown instead of a text`);
    }
  }
});

test('opportunities UI: a source that cannot be read is named, the other sources still count', async () => {
  const d = buildPriorities({ ...smallStore(), audience: null, now: NOW });
  const { root } = await growthDom('#/opportunities', { opportunities: d });
  assert.ok(text(root).includes('Source indisponible pour le moment : Audience'));
});

test('growth: no Finance, Analytics or shared file differs from the Nordla platform baseline', () => {
  assert.deepEqual(frozenViolations(), []);
});
