// What Growth really receives from Général (the module allowlist), end to end through the common service: the featured offers must be part of it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createGeneralService } from '../src/settings-general/service.js';
import { createMemoryGeneralRepository } from '../src/settings-general/repository.js';
import { orientWithGeneral } from '../src/growth/server/general-orientation.js';

const M = '11111111-1111-4111-8111-111111111111';
test('GC-1 the growth context carries priority, deadline, featured offers and constraints, and the offers are then recognised in the opportunities', async () => {
  const svc = createGeneralService({ repo: createMemoryGeneralRepository({ merchants: { [M]: 'Boutique' } }) });
  await svc.save({ tenant: { merchantId: M }, role: 'OWNER', actor: 'u', section: 'objectives', data: { priority: { value: 'sales' }, featured_offers: [{ label: 'Coque personnalisée' }], constraints: { time: { note: '2 h' } } } });
  const ctx = await svc.contextFor({ tenant: { merchantId: M }, module: 'growth' });
  assert.deepEqual(ctx.objectives.featured_offers, [{ label: 'Coque personnalisée' }]); assert.equal(ctx.objectives.priority.label, 'Développer les ventes'); assert.ok(!('legal' in ctx));
  const r = orientWithGeneral({ sections: { commercial: [{ id: 'p1', category: 'commercial', entity: { type: 'product', id: 'a', title: 'Coque personnalisée Samsung S24' } }, { id: 'p2', category: 'commercial', entity: { type: 'product', id: 'b', title: 'Gourde 500 ml' } }] } }, ctx);
  assert.deepEqual(r.general.focus, ['p1']); assert.equal(r.sections.commercial[1].orientation, undefined);
});
