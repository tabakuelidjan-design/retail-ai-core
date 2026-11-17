// The commerce context a creative brief may take from Général: allowlisted, no budget, no legal, no private contact; the objective of the brief stays first.
import test from 'node:test';
import assert from 'node:assert/strict';
import { commerceContextForBrief } from '../src/creative-autonomy/commerce-context.js';
import { readFileSync } from 'node:fs';

const ctx = { module: 'creative', merchantId: 'x', profile: { name: 'Boutique A', website: 'https://a.be', description: 'Atelier' }, activity: { main: { value: 'retail', label: 'Vente au détail' }, complementary: [] },
  objectives: { priority: { value: 'traffic', label: 'Attirer du monde en boutique', note: 'Avant Noël' }, expected_result: '30 visites', deadline: '2026-12-24', featured_offers: [{ label: 'Coques' }, { label: 'Verre trempé' }], constraints: { budget: { amount: 300, period: 'month', note: 'secret budget' }, time: { note: '2 h' }, stock: { note: null }, production: { note: 'Impression sur place' } } },
  places: [{ name: 'Namur', address: { street: 'Rue 1', postal_code: '5000', city: 'Namur' }, phone: '+3281000000', email: null }], legal: { legal_name: 'NE DOIT PAS PASSER' } };

test('CC-1 allowlisted and readable; the budget and anything legal never pass; empty values are dropped', () => {
  const b = commerceContextForBrief(ctx);
  assert.deepEqual([b.commerce, b.priorite_du_moment, b.resultat_attendu, b.echeance], ['Boutique A', 'Attirer du monde en boutique', '30 visites', '2026-12-24']);
  assert.deepEqual(b.offres_a_mettre_en_avant, ['Coques', 'Verre trempé']); assert.deepEqual(b.contraintes, { temps: '2 h', production: 'Impression sur place' });
  assert.deepEqual(b.lieux_publics, [{ nom: 'Namur', adresse: 'Rue 1 5000 Namur', telephone: '+3281000000' }]);
  const s = JSON.stringify(b); assert.ok(!/300|secret budget|NE DOIT PAS PASSER|legal/.test(s));
});

test('CC-2 nothing to add -> null (the brief is unchanged); the brief builder takes it as an OPTIONAL input and keeps the explicit objective first', () => {
  assert.equal(commerceContextForBrief(null), null); assert.equal(commerceContextForBrief({ profile: {}, objectives: {}, places: [] }), null);
  const src = readFileSync(new URL('../src/creative-autonomy/brief.js', import.meta.url), 'utf8');
  assert.match(src, /commerceContext = null/);
  assert.ok(src.indexOf('      objective,') > 0 && src.indexOf('      objective,') < src.indexOf('commerce_context: commerceContextForBrief'), 'objective is written before the context');
});
