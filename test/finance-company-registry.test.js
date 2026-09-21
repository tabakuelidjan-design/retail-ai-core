import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createViesProvider, ManualProvider } from '../src/finance/company.js';
import { NoRegistry, PERSONAL_DATA_LABEL, createCbeApiProvider, createPeppolDirectoryProvider } from '../src/finance/company-search.js';
import { baseSettings, startApp } from './finance-dashboard-helpers.js';

// SYNTHETIC fixtures shaped like real CBEAPI responses. Numbers pass the Belgian checksum but belong to nobody; no real person or company.
const legal = (digits, formatted, name, form, city, over = {}) => ({
  cbe_number: digits, cbe_number_formatted: formatted, denomination: name, denomination_with_legal_form: `${name} ${form}`,
  address: { street: 'Rue des Tests', street_number: '5', box: '', post_code: '5000', city, country_code: 'BE' },
  juridical_form_short: form, juridical_situation: 'Situation normale', juridical_situation_code: '000', status: 'active', type: 'legal_person', ...over,
});
const REGISTRY = {
  '0000000196': legal('0000000196', '0000.000.196', 'ATELIER EXEMPLE', 'SRL', 'Namur'),
  '0000000097': legal('0000000097', '0000.000.097', 'BOUTIQUE EXEMPLE', 'SA', 'Liege', { address: { street: 'Place Demo', street_number: '1', box: '3', post_code: '4000', city: 'Liege', country_code: 'BE' } }),
  '0000000295': legal('0000000295', '0000.000.295', 'EXEMPLE ASBL', 'ASBL', 'Mons', { status: 'active' }), // not in VIES
  '0000000394': legal('0000000394', '0000.000.394', 'ANCIENNE EXEMPLE', 'SRL', 'Gand', { status: 'inactive', juridical_situation: 'Faillite', juridical_situation_code: '050' }),
  // synthetic sole trader with obviously fake data
  '0000000493': { cbe_number: '0000000493', denomination: 'Exemple, Test', denomination_with_legal_form: 'Exemple, Test', address: { street: 'Rue Fictive', street_number: '1', box: '', post_code: '1000', city: 'Bruxelles', country_code: 'BE' }, status: 'active', type: 'natural_person', juridical_situation_code: '000' },
};
const VIES = { '0000000196': { valid: true, name: 'VIES NAME', address: 'AVENUE VIES 1\n9999 AILLEURS' }, '0000000097': { valid: true }, '0000000493': { valid: true } };

function fakeFetch({ mode = 'ok' } = {}) {
  const calls = [];
  const fn = async (url, init) => {
    const u = new URL(url); calls.push({ path: u.pathname + u.search, auth: init?.headers?.Authorization });
    if (mode === 'down') throw new Error('offline');
    if (mode === '429') return { ok: false, status: 429, json: async () => ({}) };
    if (mode === '401') return { ok: false, status: 401, json: async () => ({}) };
    const m = /\/company\/(\d+)$/.exec(u.pathname);
    if (m) return REGISTRY[m[1]] ? { ok: true, status: 200, json: async () => ({ data: REGISTRY[m[1]] }) } : { ok: false, status: 404, json: async () => ({ errors: [{ message: 'Company not found' }] }) };
    if (u.pathname.endsWith('/company/search')) {
      const t = (u.searchParams.get('name') ?? '').toLowerCase();
      return { ok: true, status: 200, json: async () => ({ data: Object.values(REGISTRY).filter((c) => c.denomination.toLowerCase().includes(t)) }) };
    }
    return { ok: false, status: 500, json: async () => ({}) };
  };
  fn.calls = calls; return fn;
}
function setup({ registry = 'ok', vies = 'ok', peppol = null, key = 'synthetic-key' } = {}) {
  const f = fakeFetch({ mode: registry }); const viesCalls = [];
  const viesFetch = async (url, init) => { const b = JSON.parse(init.body); viesCalls.push(b.vatNumber); if (vies === 'down') throw new Error('offline'); return { ok: true, json: async () => VIES[b.vatNumber] ?? { valid: false } }; };
  const peppolFetch = async () => ({ ok: true, json: async () => ({ matches: peppol ?? [] }) });
  return { f, viesCalls, opts: { companyRegistry: () => createCbeApiProvider({ apiKey: key, fetchImpl: f }), lookupProviders: () => [createViesProvider({ fetchImpl: viesFetch }), ManualProvider], companySearchProvider: () => createPeppolDirectoryProvider({ fetchImpl: peppolFetch }) } };
}
const run = (cfg, fn) => async () => { const s = setup(cfg); const a = await startApp(s.opts); try { await fn(a, s, await a.authed()); } finally { await a.close(); } };
const search = async (c, q) => (await c.post('/api/companies/search', { query: q })).data;

test('number: the register is primary and fills name, number, street+number(+box), postal code, city, country, status; VIES only confirms VAT', run({}, async (a, s, c) => {
  const r = await search(c, 'BE 0000.000.097');
  assert.equal(r.status, 'FOUND');
  assert.equal(r.autoFill.source, 'cbeapi');
  assert.deepEqual(r.autoFill.form, { name: 'BOUTIQUE EXEMPLE SA', vatNumber: 'BE0000000097', enterpriseNumber: '0000.000.097', street: 'Place Demo 1/3', postalCode: '4000', city: 'Liege', countryCode: 'BE' });
  assert.equal(r.autoFill.vatVerified, true);
  assert.equal(r.autoFill.vatState, 'ACTIVE');
  assert.equal(r.autoFill.status, 'Active');
  assert.equal(s.f.calls[0].auth, 'Bearer synthetic-key');
  assert.deepEqual(s.viesCalls, ['0000000097']);
}));

test('number: the register wins over VIES for the name and address; VIES data is not used to fill them', run({}, async (a, s, c) => {
  const r = await search(c, '0000000196');
  assert.equal(r.autoFill.form.name, 'ATELIER EXEMPLE SRL');
  assert.equal(r.autoFill.form.street, 'Rue des Tests 5');
  assert.equal(r.autoFill.form.city, 'Namur');
}));

test('number: VAT left empty when VIES does not confirm it, or is down; the register data still fills', run({}, async (a, s, c) => {
  const r = await search(c, '0000000295');
  assert.equal(r.status, 'FOUND');
  assert.equal(r.autoFill.form.vatNumber, '');
  assert.equal(r.autoFill.vatState, 'NOT_REGISTERED');
  assert.equal(r.autoFill.form.city, 'Mons');
  assert.match(r.message, /VAT number was left empty/);
}));
test('number: VIES unavailable does not block the register result', run({ vies: 'down' }, async (a, s, c) => {
  const r = await search(c, '0000000196');
  assert.equal(r.status, 'FOUND'); assert.equal(r.autoFill.vatState, 'UNCHECKED'); assert.equal(r.autoFill.form.vatNumber, ''); assert.equal(r.autoFill.form.name, 'ATELIER EXEMPLE SRL');
}));
test('number: an inactive / bankrupt company is shown with its status and a warning', run({}, async (a, s, c) => {
  const r = await search(c, '0000000394');
  assert.equal(r.status, 'FOUND'); assert.match(r.autoFill.status, /Inactive.*Faillite/); assert.match(r.message, /Register status/);
}));

test('sole trader by EXACT number: allowed, labelled SOLE TRADER / PERSONAL DATA, nothing saved by the search', run({}, async (a, s, c) => {
  const r = await search(c, '0000000493');
  assert.equal(r.status, 'FOUND');
  assert.equal(r.autoFill.personalData, true);
  assert.equal(r.autoFill.personalDataLabel, PERSONAL_DATA_LABEL);
  assert.equal(PERSONAL_DATA_LABEL, 'SOLE TRADER / PERSONAL DATA');
  assert.match(r.message, /SOLE TRADER \/ PERSONAL DATA/);
  assert.equal((await c.get('/api/companies')).data.rows?.length ?? (await c.get('/api/companies')).data.length ?? 0, 0, 'the search must not persist anything');
}));

test('name search: legal entities are listed with address data; sole traders are NEVER listed (only counted)', run({}, async (a, s, c) => {
  const r = await search(c, 'exemple');
  assert.equal(r.status, 'OK'); assert.equal(r.mode, 'name');
  const numbers = r.results.map((x) => x.enterpriseNumber).sort();
  assert.deepEqual(numbers, ['0000.000.097', '0000.000.196', '0000.000.295', '0000.000.394']);
  assert.ok(r.results.every((x) => !x.personalData));
  assert.equal(r.hiddenPersonalCount, 1);
  assert.match(r.message, /1 sole trader was not listed/);
  const blob = JSON.stringify(r);
  assert.ok(!blob.includes('Exemple, Test') && !blob.includes('Rue Fictive') && !blob.includes('0000.000.493'), 'no sole-trader detail may leak into the list response');
  const one = r.results.find((x) => x.enterpriseNumber === '0000.000.196');
  assert.equal(one.city, 'Namur'); assert.equal(one.form.street, 'Rue des Tests 5'); assert.equal(one.source, 'cbeapi'); assert.equal(one.needsVatCheck, true);
}));
test('name search: only sole traders match -> nothing listed, guided to the exact number, manual entry stays available', run({}, async (a, s, c) => {
  const r = await search(c, 'Test');
  assert.equal(r.status, 'NO_RESULT'); assert.equal(r.results.length, 0); assert.equal(r.hiddenPersonalCount, 1); assert.equal(r.manualEntryAvailable, true);
  assert.ok(!JSON.stringify(r).includes('Rue Fictive'));
}));

test('selecting a listed company resolves through the register + VIES check and fills every field', run({}, async (a, s, c) => {
  const r = await c.post('/api/companies/resolve', { enterpriseNumber: '0000.000.196', name: 'x' });
  assert.equal(r.data.status, 'FOUND');
  assert.deepEqual(Object.keys(r.data.result.form).sort(), ['city', 'countryCode', 'enterpriseNumber', 'name', 'postalCode', 'street', 'vatNumber']);
  assert.equal(r.data.result.form.vatNumber, 'BE0000000196'.replace('BE0000000196', s.viesCalls.includes('0000000196') ? 'BE0000000196' : ''));
}));

test('fallback chain: register has no record -> VIES supplies the data; nothing anywhere -> manual entry', run({}, async (a, s, c) => {
  const gone = setup({}); gone.opts.companyRegistry = () => createCbeApiProvider({ apiKey: 'k', fetchImpl: async () => ({ ok: false, status: 404, json: async () => ({}) }) });
  const b = await startApp(gone.opts); try {
    const cc = await b.authed();
    const r = await search(cc, '0000000097'); assert.equal(r.status, 'FOUND'); assert.equal(r.autoFill.source, 'vies');
    const n = await search(cc, '0000000493'); assert.equal(n.status, 'FOUND'); // VIES knows it in this fixture; personal-data flag comes only from the register
    const none = await search(cc, '0000000394'); assert.equal(none.status, 'NO_RESULT'); assert.equal(none.manualEntryAvailable, true);
  } finally { await b.close(); }
}));
test('register unavailable / rate-limited / rejected key: falls back to VIES then manual, with a clear state', async () => {
  for (const mode of ['down', '429', '401']) {
    const s = setup({ registry: mode }); const a = await startApp(s.opts);
    try {
      const c = await a.authed();
      const r = await search(c, '0000000196'); assert.equal(r.status, 'FOUND'); assert.equal(r.autoFill.source, 'vies', mode);
      const nm = await search(c, 'exemple'); assert.ok(['NO_RESULT', 'OK', 'PROVIDER_UNAVAILABLE'].includes(nm.status)); assert.equal(nm.manualEntryAvailable, true);
    } finally { await a.close(); }
  }
});
test('name search falls back to OpenPeppol (secondary) when the register is unavailable', async () => {
  const s = setup({ registry: 'down', peppol: [{ participantID: { value: '0208:0000000196' }, entities: [{ name: [{ name: 'Atelier Peppol SRL', language: 'fr' }], countryCode: 'BE' }] }] });
  const a = await startApp(s.opts);
  try { const r = await search(await a.authed(), 'atelier'); assert.equal(r.status, 'OK'); assert.equal(r.results[0].source, 'vies'); assert.equal(r.results[0].enterpriseNumber, '0000.000.196'); } finally { await a.close(); }
});

test('no CBEAPI_KEY: the register is off and the previous behaviour (VIES / OpenPeppol / manual) is unchanged', async () => {
  assert.equal(createCbeApiProvider({ apiKey: '' }), NoRegistry);
  assert.equal((await NoRegistry.getByNumber('0000000196')).status, 'NOT_CONFIGURED');
});

test('CBEAPI provider: maps the real response shape; 404 -> NOT_FOUND; 429/401/timeout -> UNAVAILABLE with a safe reason; the key is never in results', async () => {
  const p = createCbeApiProvider({ apiKey: 'secret-key-123', fetchImpl: fakeFetch() });
  const r = await p.getByNumber('0000000097');
  assert.equal(r.status, 'FOUND'); assert.equal(r.company.address.street, 'Place Demo 1/3'); assert.equal(r.company.legalForm, 'SA'); assert.equal(r.company.personalData, false);
  assert.equal((await p.getByNumber('0000000999')).status, 'NOT_FOUND');
  for (const [mode, reason] of [['429', 'RATE_LIMITED'], ['401', 'AUTH_REJECTED'], ['down', /NETWORK/]]) {
    const q = await createCbeApiProvider({ apiKey: 'secret-key-123', fetchImpl: fakeFetch({ mode }) }).getByNumber('0000000196');
    assert.equal(q.status, 'UNAVAILABLE'); assert.match(q.reason, reason instanceof RegExp ? reason : new RegExp(reason));
    assert.ok(!JSON.stringify(q).includes('secret-key-123'));
  }
  assert.equal((await p.getByNumber('0000000493')).company.personalData, true);
});

test('settings: registry switch validated; default is cbeapi; turning it off reverts to VIES / OpenPeppol', async () => {
  const off = baseSettings(); off.companySearch = { registry: 'none', provider: 'peppol_directory' };
  const s = setup(); const { companyRegistry, ...noHook } = s.opts; const a = await startApp({ ...noHook, settings: off }); // no test hook: the settings decide
  try { const r = await search(await a.authed(), '0000000196'); assert.equal(r.autoFill.source, 'vies'); } finally { await a.close(); }
  const a2 = await startApp(setup().opts);
  try { const c = await a2.authed(); const bad = await c.put('/api/settings', { companySearch: { registry: 'nope' } }); assert.equal(bad.status, 422); } finally { await a2.close(); }
});

test('privacy and hygiene: the registry adapter never logs, never persists, no scraping; UI shows the label and saves sole traders only on explicit action', () => {
  const src = readFileSync(new URL('../src/finance/company-search.js', import.meta.url), 'utf8');
  assert.ok(!/console\.(log|warn|error|info|debug)/.test(src), 'no logging in the search module');
  assert.ok(!/kbopub|economie\.fgov/i.test(src), 'no scraping of BCE/KBO Public Search');
  assert.ok(/cbeapi\.be\/api\/v1/.test(src));
  const ui = readFileSync(new URL('../src/finance/ui/app.js', import.meta.url), 'utf8');
  assert.match(ui, /SOLE TRADER \/ PERSONAL DATA/);
  assert.match(ui, /if \(m\.personal\) m\.saveCompany = false/);
  const server = readFileSync(new URL('../src/finance/server/app.js', import.meta.url), 'utf8');
  assert.ok(!/CBEAPI_KEY/.test(server.replace(/process\.env\.CBEAPI_KEY/, '')), 'the key is read from the environment only');
});
