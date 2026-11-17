import test from 'node:test';
import assert from 'node:assert/strict';
import { describeGeneral, orientWithGeneral } from '../src/growth/server/general-orientation.js';

const ctx = { objectives: { priority: { value: 'traffic', label: 'Attirer du monde en boutique' }, expected_result: '30 visites', deadline: '2026-12-24', featured_offers: [{ label: 'Coque personnalisée' }, { label: 'verre trempé' }], constraints: { time: { note: '2 h par semaine' }, stock: { note: null }, production: { note: 'Impression sur place' }, budget: { amount: 150, period: 'month' } } } };
const mk = () => ({ sections: { commercial: [
  { id: 'p1', category: 'commercial', entity: { type: 'product', id: 'a', title: 'Coque personnalisée iPhone 15' }, figures: { sales: 12 } },
  { id: 'p2', category: 'commercial', entity: { type: 'product', id: 'b', title: 'Gourde 500 ml' }, figures: { sales: 3 } },
  { id: 'p3', category: 'commercial', entity: { type: 'product', id: 'c', title: 'Verre Trempé iPhone 14' } },
  { id: 's1', category: 'commercial', entity: { type: 'store', id: 'weekday:mon' } }] }, weekly: { items: [{ id: 'p2' }, { id: 'p1' }] } });

test('GO-1 featured offers orient the product opportunities (accent / case insensitive); figures and weekly ranking are untouched; the block says what Général says', () => {
  const r = orientWithGeneral(mk(), ctx);
  assert.deepEqual(r.general.focus, ['p1', 'p3']); assert.equal(r.sections.commercial[0].orientation.featuredOffer, 'Coque personnalisée'); assert.equal(r.sections.commercial[1].orientation, undefined); assert.equal(r.sections.commercial[3].orientation, undefined, 'only products');
  assert.deepEqual([r.general.state, r.general.priority, r.general.deadline, r.general.constraints.production, r.general.constraints.budget], ['PRESENT', 'Attirer du monde en boutique', '2026-12-24', 'Impression sur place', { amount: 150, period: 'month' }]);
  assert.deepEqual(r.weekly.items.map((x) => x.id), ['p2', 'p1'], 'the weekly ranking rule is not changed'); assert.equal(r.sections.commercial[0].figures.sales, 12, 'business figures untouched');
});
test('GO-2 no context / empty context / broken input never break the recommendations', () => {
  assert.equal(orientWithGeneral(mk(), null).general.state, 'NOT_AVAILABLE'); assert.equal(describeGeneral({ objectives: {} }).state, 'EMPTY');
  const r = mk(); assert.doesNotThrow(() => orientWithGeneral(r, { objectives: { featured_offers: 'oops', constraints: 5 } })); assert.equal(r.sections.commercial.length, 4);
  assert.doesNotThrow(() => orientWithGeneral({}, ctx));
});
