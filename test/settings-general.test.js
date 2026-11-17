// Paramètres -> Général: validation, rights, per-section versions, establishments, merchant isolation. Memory repository, no network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createGeneralService, GeneralError } from '../src/settings-general/service.js';
import { createMemoryGeneralRepository } from '../src/settings-general/repository.js';
import * as M from '../src/settings-general/model.js';

const A = '11111111-1111-4111-8111-111111111111'; const B = '22222222-2222-4222-8222-222222222222';
const mk = () => { const repo = createMemoryGeneralRepository({ merchants: { [A]: 'Boutique A', [B]: 'Atelier B' } }); return { repo, svc: createGeneralService({ repo }) }; };
const ta = { merchantId: A }; const tb = { merchantId: B };
const code = async (p) => { try { await p; return null; } catch (e) { return e instanceof GeneralError ? e.code : `OTHER:${e.message}`; } };

test('SG-1 a section never saved reads as "À renseigner" (empty), no default belongs to any merchant', async () => {
  const { svc } = mk();
  const o = await svc.overview({ tenant: ta, role: 'OWNER' }); assert.equal(o.sections.length, 7); assert.ok(o.sections.filter((s) => s.id !== 'profile').every((s) => s.filled === false));
  const act = await svc.read({ tenant: ta, role: 'OWNER', section: 'activity' }); assert.deepEqual([act.data.main, act.data.channels, act.data.clientele, act.version], [null, [], null, null]);
  const reg = await svc.read({ tenant: ta, role: 'OWNER', section: 'regional' }); assert.deepEqual(reg.data, { currency: null, timezone: null }, 'no Europe/Brussels / EUR default for a merchant that has none');
  assert.equal((await svc.read({ tenant: ta, role: 'OWNER', section: 'profile' })).data.name, 'Boutique A');
});

test('SG-2 profile: the name is required, URL must be https, e-mail and phone are validated; an invalid save changes NOTHING', async () => {
  const { svc } = mk();
  const e = await svc.save({ tenant: ta, role: 'OWNER', actor: 'u1', section: 'profile', data: { name: '', website: 'http://x.be', email: 'nope', phone: '12' } }).catch((x) => x);
  assert.equal(e.code, 'VALIDATION'); assert.deepEqual(Object.keys(e.errors).sort(), ['email', 'name', 'phone', 'website']);
  assert.equal((await svc.read({ tenant: ta, role: 'OWNER', section: 'profile' })).data.name, 'Boutique A', 'nothing was written');
  const ok = await svc.save({ tenant: ta, role: 'OWNER', actor: 'u1', section: 'profile', data: { name: 'Boutique  Alpha ', description: 'Atelier', website: 'https://exemple.be', email: 'a@exemple.be', phone: '+32 81 00 00 00' } });
  assert.equal(ok.data.name, 'Boutique Alpha'); assert.equal(ok.data.phone, '+3281000000'); assert.equal(ok.version, 1);
  assert.equal(M.normalisePhone('081 00 00 00', 'BE'), '+3281000000'); assert.equal(M.normalisePhone('081 00 00 00', 'FR'), undefined);
});

test('SG-3 rights: a reader cannot save through the service; the legal section is closed to non owner/admin; another merchant is invisible', async () => {
  const { svc } = mk();
  assert.equal(await code(svc.save({ tenant: ta, role: 'VIEWER', actor: 'u', section: 'activity', data: {} })), 'FORBIDDEN_ROLE');
  assert.equal(await code(svc.read({ tenant: ta, role: 'VIEWER', section: 'legal' })), 'FORBIDDEN_ROLE');
  assert.equal((await svc.overview({ tenant: ta, role: 'VIEWER' })).sections.find((s) => s.id === 'legal').locked, true);
  assert.equal((await svc.read({ tenant: ta, role: 'VIEWER', section: 'profile' })).canWrite, false);
  await svc.save({ tenant: ta, role: 'ADMIN', actor: 'u', section: 'activity', data: { main: { value: 'retail' }, channels: [{ value: 'shop' }] } });
  assert.equal((await svc.read({ tenant: tb, role: 'OWNER', section: 'activity' })).data.main, null, 'merchant B does not see merchant A');
  assert.equal(await code(svc.read({ tenant: {}, role: 'OWNER', section: 'activity' })), 'TENANT_REQUIRED');
});

test('SG-4 activity: choices are checked, "Autre" needs its label, a precise label is allowed for printing, the other values are kept on a later save', async () => {
  const { svc } = mk();
  assert.equal((await svc.save({ tenant: ta, role: 'OWNER', actor: 'u', section: 'activity', data: { main: { value: 'other' }, channels: [{ value: 'nope' }] } }).catch((x) => x)).code, 'VALIDATION');
  const a = await svc.save({ tenant: ta, role: 'OWNER', actor: 'u', section: 'activity', data: { main: { value: 'retail' }, complementary: [{ value: 'personalisation' }, { value: 'printing', label: 'Impression UV' }], channels: [{ value: 'shop' }, { value: 'online' }], clientele: 'both' } });
  assert.deepEqual(a.data.complementary[1], { value: 'printing', label: 'Impression UV' });
  const b = await svc.save({ tenant: ta, role: 'OWNER', actor: 'u', section: 'activity', expectedVersion: a.version, data: { ...a.data, clientele: null } });
  assert.deepEqual([b.version, b.data.channels.length, b.data.clientele], [2, 2, null]);
  assert.equal((await svc.save({ tenant: ta, role: 'OWNER', actor: 'u', section: 'activity', expectedVersion: 2, data: { ...b.data, channels: [{ value: 'shop' }, { value: 'shop' }] } }).catch((x) => x)).code, 'VALIDATION', 'duplicate');
});

test('SG-5 a stale save is REFUSED with the current value (no silent replacement); same for regional', async () => {
  const { svc } = mk();
  const first = await svc.save({ tenant: ta, role: 'OWNER', actor: 'u', section: 'selling_modes', data: { modes: [{ value: 'stock' }] } });
  await svc.save({ tenant: ta, role: 'OWNER', actor: 'v', section: 'selling_modes', expectedVersion: first.version, data: { modes: [{ value: 'stock' }, { value: 'personalised' }] } });
  const e = await svc.save({ tenant: ta, role: 'OWNER', actor: 'u', section: 'selling_modes', expectedVersion: first.version, data: { modes: [{ value: 'preorder' }] } }).catch((x) => x);
  assert.equal(e.code, 'CONFLICT'); assert.equal(e.current.data.modes.length, 2, 'the other person\'s value is still there');
  const r1 = await svc.save({ tenant: ta, role: 'OWNER', actor: 'u', section: 'regional', data: { currency: 'eur', timezone: 'Europe/Brussels' } });
  await svc.save({ tenant: ta, role: 'OWNER', actor: 'v', section: 'regional', expectedVersion: r1.version, data: { currency: 'EUR', timezone: 'Europe/Paris' } });
  assert.equal(await code(svc.save({ tenant: ta, role: 'OWNER', actor: 'u', section: 'regional', expectedVersion: r1.version, data: { currency: 'EUR', timezone: 'UTC' } })), 'CONFLICT');
  assert.equal((await svc.read({ tenant: ta, role: 'OWNER', section: 'regional' })).data.timezone, 'Europe/Paris');
});

test('SG-6 regional: ISO currency and IANA zone only (no abbreviation); selling modes: a per-family precision only for catalogue families', async () => {
  const { svc } = mk();
  for (const bad of [{ currency: 'EURO', timezone: 'Europe/Brussels' }, { currency: 'EUR', timezone: 'CET' }, { currency: '', timezone: '' }, { currency: 'XXX1', timezone: 'UTC+1' }]) assert.equal(await code(svc.save({ tenant: ta, role: 'OWNER', actor: 'u', section: 'regional', data: bad })), 'VALIDATION');
  const svc2 = createGeneralService({ repo: createMemoryGeneralRepository({ merchants: { [A]: 'A' } }), catalogueFamilies: async () => ['coques'] });
  assert.equal(await code(svc2.save({ tenant: ta, role: 'OWNER', actor: 'u', section: 'selling_modes', data: { modes: [{ value: 'stock' }], by_family: { gourdes: [{ value: 'stock' }] } } })), 'VALIDATION');
  assert.equal((await svc2.save({ tenant: ta, role: 'OWNER', actor: 'u', section: 'selling_modes', data: { modes: [{ value: 'stock' }], by_family: { coques: [{ value: 'personalised' }] } } })).data.by_family.coques[0].value, 'personalised');
});

test('SG-7 legal: Belgian BCE and VAT check digits, status coherence, billing address, nothing HABB by default', async () => {
  assert.equal(M.normaliseBce('0403.170.701'), '0403.170.701'); assert.equal(M.normaliseBce('0403170702'), undefined); assert.equal(M.normaliseBeVat('BE 0403.170.701'), 'BE0403170701');
  const { svc } = mk();
  const ok = await svc.save({ tenant: ta, role: 'OWNER', actor: 'u', section: 'legal', data: { legal_name: 'Alpha SRL', country: 'BE', legal_form: 'SRL', enterprise_number: '0403170701', vat_status: 'registered', vat_number: 'BE0403170701', billing: { use_primary: true } } });
  assert.deepEqual([ok.data.enterprise_number, ok.data.vat_number], ['0403.170.701', 'BE0403170701']);
  const e = await svc.save({ tenant: ta, role: 'OWNER', actor: 'u', section: 'legal', expectedVersion: ok.version, data: { ...ok.data, enterprise_number: '1234567890', vat_status: 'none', vat_number: 'BE0403170701' } }).catch((x) => x);
  assert.deepEqual(Object.keys(e.errors).sort(), ['enterprise_number', 'vat_number']);
  assert.equal((await svc.save({ tenant: ta, role: 'OWNER', actor: 'u', section: 'legal', expectedVersion: ok.version, data: { ...ok.data, billing: { use_primary: false, street: 'Rue 1', postal_code: '5000' } } }).catch((x) => x)).errors['billing.city'], 'Ville obligatoire.');
  assert.equal((await svc.read({ tenant: tb, role: 'OWNER', section: 'legal' })).data.legal_name, null);
});

test('SG-8 establishments: first one is the main one, one main only, archive keeps the id, hours are validated (order, overlap), exceptions win', async () => {
  const { svc } = mk();
  const place = (over = {}) => ({ name: 'Boutique', functions: [{ value: 'shop' }, { value: 'workshop' }], address: { street: 'Rue de Bruxelles 18', postal_code: '5000', city: 'Namur', country: 'BE' }, visibility: 'public', publish_contact: true, hours: { mon: [{ from: '10:00', to: '18:00' }], sat: [{ from: '10:00', to: '18:00' }] }, exceptions: [], ...over });
  const one = await svc.saveEstablishment({ tenant: ta, role: 'OWNER', actor: 'u', establishment: place() }); const id1 = one.id;
  assert.equal(one.data.establishments[0].isPrimary, true);
  const two = await svc.saveEstablishment({ tenant: ta, role: 'OWNER', actor: 'u', establishment: place({ name: 'Dépôt', visibility: 'internal', publish_contact: false, functions: [{ value: 'depot' }] }) });
  assert.equal(two.data.establishments.filter((e) => e.isPrimary).length, 1);
  assert.equal(await code(svc.archiveEstablishment({ tenant: ta, role: 'OWNER', actor: 'u', establishmentId: id1 })), 'PRIMARY_REQUIRED');
  await svc.makePrimary({ tenant: ta, role: 'OWNER', actor: 'u', establishmentId: two.id });
  const arch = await svc.archiveEstablishment({ tenant: ta, role: 'OWNER', actor: 'u', establishmentId: id1 }); assert.equal(arch.data.establishments.find((e) => e.id === id1).archived, true, 'archived, the id is kept');
  const bad = await svc.saveEstablishment({ tenant: ta, role: 'OWNER', actor: 'u', establishment: place({ name: 'X', hours: { mon: [{ from: '10:00', to: '12:00' }, { from: '11:00', to: '13:00' }], tue: [{ from: '18:00', to: '09:00' }] }, visibility: 'internal', publish_contact: true, exceptions: [{ date: '2026-02-30', closed: true }] }) }).catch((x) => x);
  assert.deepEqual(Object.keys(bad.errors).sort(), ['exceptions.0.date', 'hours.mon', 'hours.tue', 'publish_contact']);
  const v = M.validateEstablishment(place({ exceptions: [{ date: '2026-12-25', closed: true, reason: 'Noël' }, { date: '2026-11-21', slots: [{ from: '10:00', to: '13:00' }] }] })).value;
  assert.deepEqual([M.hoursOn(v, '2026-12-25').closed, M.hoursOn(v, '2026-12-25').source], [true, 'exception']); assert.equal(M.hoursOn(v, '2026-11-21').slots[0].to, '13:00');
  assert.deepEqual([M.hoursOn(v, '2026-11-16').closed, M.hoursOn(v, '2026-11-17').closed, M.hoursOn(v, '2026-11-22').closed], [false, true, true], 'Monday open, Tuesday closed, Sunday closed');
  assert.equal((await svc.read({ tenant: tb, role: 'OWNER', section: 'establishments' })).data.establishments.length, 0, 'merchant B has none');
});

test('SG-9 the name written here is the name every module already reads (merchants.name); the consumers list is honest', async () => {
  const { svc, repo } = mk();
  await svc.save({ tenant: ta, role: 'OWNER', actor: 'u', section: 'profile', data: { name: 'Nouveau nom' } });
  assert.equal(await repo.merchantName(A), 'Nouveau nom'); assert.equal(await repo.merchantName(B), 'Atelier B');
  const { consumers } = await svc.overview({ tenant: ta, role: 'OWNER' });
  const by = (st) => consumers.filter((c) => c.state === st).map((c) => c.module);
  assert.deepEqual(by('VERIFIED'), ['Core', 'Marketing (brouillons Google et vidéo)']); assert.deepEqual(by('API_VERIFIED'), ['Stock, Achats et Sourcing']); assert.deepEqual(by('WAITING_SUPPLIER'), ['Connexions']);
  assert.ok(!consumers.some((c) => c.state === 'READS'), 'no claim without a proof level'); assert.ok(consumers.filter((c) => c.state === 'AWAITS_SESSION').length >= 2 && consumers.filter((c) => c.state === 'TO_CONNECT').length >= 2); assert.deepEqual(by('WIRED'), ['Growth (objectifs)']);
});

test('SG-10 objectives: one priority (Autre needs its label), valid date, up to 10 distinct offers, budget needs its period; modules read only their allowlisted fields', async () => {
  const { svc } = mk();
  const e = await svc.save({ tenant: ta, role: 'OWNER', actor: 'u', section: 'objectives', data: { priority: { value: 'other' }, deadline: '2026-02-30', featured_offers: [{ label: 'Coques' }, { label: 'coques' }], constraints: { budget: { amount: 300 }, stock: { note: 'x'.repeat(201) } } } }).catch((x) => x);
  assert.deepEqual(Object.keys(e.errors).sort(), ['constraints.budget.period', 'constraints.stock.note', 'deadline', 'featured_offers', 'priority']);
  assert.equal((await svc.read({ tenant: ta, role: 'OWNER', section: 'objectives' })).version, null, 'nothing stored');
  const ok = await svc.save({ tenant: ta, role: 'OWNER', actor: 'u', section: 'objectives', data: { priority: { value: 'traffic', note: 'Avant Noël' }, expected_result: '30 visites de plus par semaine', deadline: '2026-12-24', featured_offers: [{ label: 'Coques personnalisées' }, { label: 'Verre trempé' }], constraints: { budget: { amount: '250.456', period: 'month' }, time: { note: '2 h par semaine' } } } });
  assert.deepEqual([ok.data.priority.value, ok.data.constraints.budget.amount, ok.data.featured_offers.length, ok.version], ['traffic', 250.46, 2, 1]);
  assert.equal((await svc.read({ tenant: tb, role: 'OWNER', section: 'objectives' })).data.priority, null, 'merchant B sees nothing');
  const mk2 = await svc.contextFor({ tenant: ta, module: 'marketing' }); assert.equal(mk2.objectives.priority.value, 'traffic'); assert.equal(mk2.profile.name, 'Boutique A'); assert.ok(!('legal' in mk2));
  const st = await svc.contextFor({ tenant: ta, module: 'stock' }); assert.deepEqual(Object.keys(st.objectives), ['constraints']); assert.ok(!('priority' in st.objectives));
  assert.equal(await code(svc.contextFor({ tenant: ta, module: 'inconnu' })), 'MODULE_UNKNOWN');
  assert.equal((await svc.overview({ tenant: ta, role: 'OWNER' })).sections.find((s) => s.id === 'objectives').filled, true);
});

test('SG-11 supplier links: only a location Nordla really holds can be tied, one place per location, editing the place keeps the links, nothing is invented', async () => {
  const { svc, repo } = mk();
  const place = (over = {}) => ({ name: 'Boutique', functions: [{ value: 'shop' }], address: { street: 'Rue 1', postal_code: '5000', city: 'Namur', country: 'BE' }, visibility: 'public', hours: {}, ...over });
  const p1 = await svc.saveEstablishment({ tenant: ta, role: 'OWNER', actor: 'u', establishment: place() }); const p2 = await svc.saveEstablishment({ tenant: ta, role: 'OWNER', actor: 'u', establishment: place({ name: 'Dépôt', visibility: 'internal' }) });
  assert.deepEqual((await svc.supplierLocations({ tenant: ta, role: 'OWNER' })).locations, [], 'no supplier connected: nothing to tie');
  assert.equal(await code(svc.linkSupplierLocation({ tenant: ta, role: 'OWNER', actor: 'u', establishmentId: p1.id, provider: 'shopify', externalId: 'gid://x/Location/1' })), 'LOCATION_UNKNOWN');
  repo.seedLocations(A, [{ name: 'Namur', type: 'shop', source_system: 'shopify', source_id: 'gid://x/Location/1' }, { name: 'Dépôt', type: 'warehouse', source_system: 'shopify', source_id: 'gid://x/Location/2' }]);
  const ok = await svc.linkSupplierLocation({ tenant: ta, role: 'OWNER', actor: 'u', establishmentId: p1.id, provider: 'shopify', externalId: 'gid://x/Location/1' });
  assert.deepEqual(ok.data.establishments.find((e) => e.id === p1.id).links, [{ provider: 'shopify', external_id: 'gid://x/Location/1' }]);
  assert.equal(await code(svc.linkSupplierLocation({ tenant: ta, role: 'OWNER', actor: 'u', establishmentId: p2.id, provider: 'shopify', externalId: 'gid://x/Location/1' })), 'LOCATION_ALREADY_LINKED');
  assert.equal(await code(svc.linkSupplierLocation({ tenant: ta, role: 'VIEWER', actor: 'u', establishmentId: p1.id, provider: 'shopify', externalId: 'gid://x/Location/2' })), 'FORBIDDEN_ROLE');
  await svc.saveEstablishment({ tenant: ta, role: 'OWNER', actor: 'u', establishment: { ...place({ name: 'Boutique renommée' }), id: p1.id } });
  const after = (await svc.read({ tenant: ta, role: 'OWNER', section: 'establishments' })).data.establishments.find((e) => e.id === p1.id); assert.equal(after.name, 'Boutique renommée'); assert.equal(after.links.length, 1, 'editing the place keeps its supplier link');
  const list = await svc.supplierLocations({ tenant: ta, role: 'OWNER' }); assert.deepEqual(list.locations.map((l) => l.establishmentId), [p1.id, null]);
  assert.equal((await svc.supplierLocations({ tenant: tb, role: 'OWNER' })).locations.length, 0, 'merchant B holds no location of A');
  const un = await svc.linkSupplierLocation({ tenant: ta, role: 'OWNER', actor: 'u', establishmentId: p1.id, provider: 'shopify', externalId: 'gid://x/Location/1', unlink: true }); assert.deepEqual(un.data.establishments.find((e) => e.id === p1.id).links, []);
  assert.equal((await svc.supplierLocations({ tenant: ta, role: 'OWNER' })).locations[0].establishmentId, null);
});

test('SG-12 module places: marketing/creative get only public places that agreed to share contact details; stock/sourcing get every active place without street or contact; the priority carries its label', async () => {
  const { svc } = mk();
  const base = { functions: [{ value: 'shop' }], address: { street: 'Rue Secrète 9', postal_code: '5000', city: 'Namur', country: 'BE' }, phone: '+3281000000', hours: {} };
  await svc.saveEstablishment({ tenant: ta, role: 'OWNER', actor: 'u', establishment: { ...base, name: 'Public partagé', visibility: 'public', publish_contact: true } });
  await svc.saveEstablishment({ tenant: ta, role: 'OWNER', actor: 'u', establishment: { ...base, name: 'Public discret', visibility: 'public', publish_contact: false } });
  await svc.saveEstablishment({ tenant: ta, role: 'OWNER', actor: 'u', establishment: { ...base, name: 'Interne', visibility: 'internal' } });
  await svc.save({ tenant: ta, role: 'OWNER', actor: 'u', section: 'objectives', data: { priority: { value: 'sales' }, featured_offers: [{ label: 'Coques' }] } });
  const mkt = await svc.contextFor({ tenant: ta, module: 'marketing' }); assert.deepEqual(mkt.places.map((p) => p.name), ['Public partagé']); assert.equal(mkt.places[0].phone, '+3281000000'); assert.equal(mkt.objectives.priority.label, 'Développer les ventes');
  const stock = await svc.contextFor({ tenant: ta, module: 'stock' }); assert.equal(stock.places.length, 3); assert.ok(stock.places.every((p) => !('phone' in p) && !('address' in p)), 'no street, no contact for stock');
  const cr = await svc.contextFor({ tenant: ta, module: 'creative' }); assert.deepEqual(cr.places.map((p) => p.name), ['Public partagé']); assert.ok(!('legal' in cr));
});

test('SG-13 legal check: read only comparison with Finance seller profile; absent table / no profile / differences are reported, nothing is written, a viewer cannot read it', async () => {
  const { svc, repo } = mk();
  await svc.save({ tenant: ta, role: 'OWNER', actor: 'u', section: 'legal', data: { legal_name: 'Alpha SRL', country: 'BE', enterprise_number: '0403170701', vat_status: 'registered', vat_number: 'BE0403170701' } });
  let c = await svc.legalCheck({ tenant: ta, role: 'OWNER' }); assert.deepEqual([c.finance, c.readyForNewDocuments, c.differences.length], ['TABLE_ABSENT', true, 0]); assert.match(c.note, /Aucune bascule/);
  repo.seedSellerProfile(A, { none: true }); c = await svc.legalCheck({ tenant: ta, role: 'OWNER' }); assert.equal(c.finance, 'NO_PROFILE');
  repo.seedSellerProfile(A, { version: 3, profile: { legalName: 'ALPHA srl', country: 'BE', enterpriseNumber: '0403 170 701', vatNumber: 'BE0403170701' } });
  c = await svc.legalCheck({ tenant: ta, role: 'OWNER' }); assert.deepEqual([c.finance, c.financeVersion, c.differences], ['PRESENT', 3, []], 'same facts in another format: no difference');
  repo.seedSellerProfile(A, { version: 4, profile: { legalName: 'Beta SA', country: 'BE', enterpriseNumber: '0403170701', vatNumber: 'BE0999999999' } });
  c = await svc.legalCheck({ tenant: ta, role: 'OWNER' }); assert.deepEqual(c.differences.map((d) => d.field).sort(), ['legalName', 'vatNumber']); assert.match(c.note, /rien n’est remplacé/);
  assert.equal((await svc.read({ tenant: ta, role: 'OWNER', section: 'legal' })).data.legal_name, 'Alpha SRL', 'Général is untouched by the check');
  assert.equal(await code(svc.legalCheck({ tenant: ta, role: 'VIEWER' })), 'FORBIDDEN_ROLE');
  assert.deepEqual(c.proposedSellerProfile && [c.proposedSellerProfile.legalName, c.proposedSellerProfile.vatRegistered, c.proposedSellerProfile.billingAddress], ['Alpha SRL', true, 'ESTABLISHMENT_MAIN'], 'a proposal for the NEXT version, only when the facts are complete');
  assert.ok(!('saveSellerProfile' in repo) && !('recordSellerProfile' in repo), 'Général has no way to write Finance: issued documents keep their identity');
  const empty = await svc.legalCheck({ tenant: tb, role: 'OWNER' }); assert.deepEqual([empty.readyForNewDocuments, empty.missing.includes('legal_name')], [false, true]);
});
