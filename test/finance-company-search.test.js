import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { createViesProvider, ManualProvider } from '../src/finance/company.js';
import { NoSearchProvider, classifyQuery, createPeppolDirectoryProvider, enterpriseDigitsFromParticipant, toFormFields } from '../src/finance/company-search.js';
import { CUSTOMER_BODY, baseSettings, startApp } from './finance-dashboard-helpers.js';

// Synthetic companies only. Numbers pass the Belgian checksum but belong to nobody.
const VIES = {
  '0000000196': { valid: true, name: 'CLIENT EXEMPLE SA', address: 'AVENUE TEST 2\n5000 NAMUR' },
  '0000000097': { valid: true, name: 'AUTRE SOCIETE SRL', address: 'RUE DU TEST 5\n1000 BRUXELLES' },
};
const participant = (value, names, over = {}) => ({ participantID: { scheme: 'iso6523-actorid-upis', value }, entities: [{ name: names, countryCode: 'BE', regDate: '2025-06-02', ...over }] });
const MATCHES = [
  participant('0208:0000000196', [{ name: 'Client Exemple NV', language: 'nl' }, { name: 'Client Exemple SA', language: 'fr' }]),
  participant('9925:be0000000196', [{ name: 'Client Exemple SA', language: 'fr' }]), // same company under the VAT scheme
  participant('0208:0000000097', [{ name: 'Autre Societe SRL', language: 'fr' }]),
  participant('0208:0000000295', [{ name: 'Exemple Troisieme SPRL', language: 'fr' }]), // valid number, not VAT-registered in VIES
  participant('0208:0123456789', [{ name: 'Invalid Checksum Ltd', language: 'en' }]), // dropped: checksum
  { participantID: { scheme: 'iso6523-actorid-upis', value: '0088:1234567890123' }, entities: [{ name: [{ name: 'Foreign GLN', language: 'en' }], countryCode: 'BE' }] }, // dropped: not a Belgian scheme
];

function harness({ matches = MATCHES, peppol = 'ok', vies = 'ok' } = {}) {
  const calls = { vies: [], peppol: [] };
  const viesFetch = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.vies.push(body.vatNumber);
    if (vies === 'down') throw new Error('offline');
    return { ok: true, json: async () => VIES[body.vatNumber] ?? { valid: false } };
  };
  const peppolFetch = async (url) => {
    calls.peppol.push(String(url));
    if (peppol === 'down') throw new Error('offline');
    if (peppol === '503') return { ok: false, status: 503, json: async () => ({}) };
    return { ok: true, json: async () => ({ 'total-result-count': matches.length, matches }) };
  };
  return { calls, opts: { lookupProviders: () => [createViesProvider({ fetchImpl: viesFetch }), ManualProvider], companySearchProvider: () => createPeppolDirectoryProvider({ fetchImpl: peppolFetch }) } };
}
const withSearch = (cfg, fn) => async () => { const h = harness(cfg); const a = await startApp(h.opts); try { await fn(a, h, await a.authed()); } finally { await a.close(); } };
const search = async (c, query) => (await c.post('/api/companies/search', { query })).data;
const ALL_FIELDS = ['name', 'vatNumber', 'enterpriseNumber', 'street', 'postalCode', 'city', 'countryCode'];

// ---------- number search (VIES) ----------
test('VAT lookup with ONE result: normalised, validated, official data fills every field automatically', withSearch({}, async (a, h, c) => {
  const r = await search(c, 'BE 0000.000.196');
  assert.equal(r.status, 'FOUND');
  assert.equal(r.mode, 'number');
  assert.equal(r.results.length, 1);
  assert.equal(r.autoFill.source, 'vies');
  assert.match(r.autoFill.sourceLabel, /VIES/);
  assert.deepEqual(r.autoFill.form, { name: 'CLIENT EXEMPLE SA', vatNumber: 'BE0000000196', enterpriseNumber: '0000.000.196', street: 'AVENUE TEST 2', postalCode: '5000', city: 'NAMUR', countryCode: 'BE' });
  assert.deepEqual(h.calls.vies, ['0000000196']); // exactly one official call, with the normalised digits
  assert.equal(h.calls.peppol.length, 0); // a number never goes to the name-search provider
}));

test('every accepted way of writing the same number gives the same company', withSearch({}, async (a, h, c) => {
  for (const q of ['BE0000000196', 'be 0000 000 196', '0000.000.196', '000000196', 'BE 0.000.000.196']) {
    const r = await search(c, q);
    assert.equal(r.status, 'FOUND', q);
    assert.equal(r.autoFill.form.vatNumber, 'BE0000000196', q);
  }
}));

test('INVALID VAT: refused offline with a clear reason, and nothing is sent to any provider', withSearch({}, async (a, h, c) => {
  for (const q of ['BE0123456789', '12345', 'BE0000000195']) {
    const r = await search(c, q);
    assert.equal(r.status, 'INVALID_NUMBER', q);
    assert.equal(r.manualEntryAvailable, true);
    assert.equal(r.results.length, 0);
    assert.equal(r.autoFill, undefined);
  }
  assert.equal(h.calls.vies.length + h.calls.peppol.length, 0);
}));

test('a valid number that VIES does not know: NO_RESULT, the normalised number is kept, manual entry offered', withSearch({}, async (a, h, c) => {
  const r = await search(c, '0000.000.295');
  assert.equal(r.status, 'NO_RESULT');
  assert.equal(r.reason, 'NOT_VAT_REGISTERED');
  assert.equal(r.partial.form.enterpriseNumber, '0000.000.295');
  assert.equal(r.manualEntryAvailable, true);
}));

// ---------- name search ----------
test('company-name search with MULTIPLE results: de-duplicated, enough context to choose, sources shown', withSearch({}, async (a, h, c) => {
  const r = await search(c, 'exemple');
  assert.equal(r.status, 'OK');
  assert.equal(r.mode, 'name');
  assert.equal(r.results.length, 3); // the VAT-scheme duplicate is merged, the invalid checksum and the foreign scheme are dropped
  assert.equal(r.autoFill, null); // several matches: the merchant chooses
  const [first, second, third] = r.results;
  assert.deepEqual([first.name, first.enterpriseNumber, first.vatNumber, first.city], ['CLIENT EXEMPLE SA', '0000.000.196', 'BE0000000196', 'NAMUR']);
  assert.deepEqual([second.name, second.city], ['AUTRE SOCIETE SRL', 'BRUXELLES']);
  assert.match(first.status, /Registered on Peppol since 2025-06-02/);
  assert.equal(first.source, 'vies');
  assert.equal(third.name, 'Exemple Troisieme SPRL');
  assert.equal(third.needsResolve, true); // no VIES record: address not known yet
  assert.equal(third.city, null);
  assert.ok(r.sources.some((s) => /OpenPeppol/.test(s)) && r.sources.some((s) => /VIES/.test(s)));
  assert.equal(h.calls.peppol.length, 1);
  assert.match(h.calls.peppol[0], /country=BE/);
  assert.match(h.calls.peppol[0], /q=exemple/);
}));

test('SELECTING a result fills every available field, and equals what the search list showed', withSearch({}, async (a, h, c) => {
  const list = await search(c, 'exemple');
  const hit = list.results[0];
  const r = (await c.post('/api/companies/resolve', { enterpriseNumber: hit.enterpriseNumber, name: hit.name })).data;
  assert.equal(r.status, 'FOUND');
  assert.deepEqual(Object.keys(r.result.form).sort(), [...ALL_FIELDS].sort());
  for (const f of ALL_FIELDS) assert.ok(r.result.form[f], `${f} is filled`);
  assert.deepEqual(r.result.form, hit.form);
  assert.equal(r.result.source, 'vies');
  assert.equal(r.result.vatVerified, true);
  // a hit VIES does not know is resolved partially: name and enterprise number are kept, the rest is left for the merchant
  const partial = (await c.post('/api/companies/resolve', { enterpriseNumber: '0000000295', name: 'Exemple Troisieme SPRL', status: 'Registered on Peppol since 2025-06-02' })).data;
  assert.equal(partial.status, 'PARTIAL');
  assert.deepEqual([partial.result.form.name, partial.result.form.enterpriseNumber, partial.result.form.street, partial.result.form.city], ['Exemple Troisieme SPRL', '0000.000.295', '', '']);
  assert.equal(partial.result.source, 'peppol_directory');
  assert.equal((await c.post('/api/companies/resolve', { enterpriseNumber: 'BE0123456789' })).status, 422);
}));

test('a selected result can be saved to the directory with every field, then found again without any network call', withSearch({}, async (a, h, c) => {
  const f = (await search(c, 'BE0000000196')).autoFill;
  const saved = await c.post('/api/companies', { kind: 'business', name: f.form.name, vatNumber: f.form.vatNumber, enterpriseNumber: f.form.enterpriseNumber, address: { street: f.form.street, postalCode: f.form.postalCode, city: f.form.city, countryCode: f.form.countryCode }, source: 'vies' });
  assert.equal(saved.status, 201);
  assert.deepEqual([saved.data.name, saved.data.vatNumber, saved.data.enterpriseNumber, saved.data.address.street, saved.data.address.postalCode, saved.data.address.city, saved.data.address.countryCode, saved.data.source], ['CLIENT EXEMPLE SA', 'BE0000000196', '0000.000.196', 'AVENUE TEST 2', '5000', 'NAMUR', 'BE', 'vies']);
  const before = h.calls.vies.length;
  const again = await search(c, 'BE0000000196');
  assert.equal(again.status, 'FOUND');
  assert.equal(again.autoFill.source, 'directory');
  assert.match(again.message, /already in your directory/);
  assert.equal(h.calls.vies.length, before); // exact match in the directory: no external call
}));

test('saved companies are listed first for a name search, and another merchant never sees them', async () => {
  const h = harness();
  const A = await startApp({ ...h.opts, merchantId: 'merchant-A' });
  try {
    const c = await A.authed();
    await c.post('/api/companies', { ...CUSTOMER_BODY, name: 'Exemple Local SRL', vatNumber: 'BE0000000097' });
    const r = await search(c, 'exemple');
    assert.equal(r.results[0].source, 'directory');
    assert.equal(r.results[0].name, 'Exemple Local SRL');
    assert.ok(r.results[0].id);
    assert.equal(r.results.filter((x) => x.enterpriseNumber === '0000.000.097').length, 1); // not shown twice
  } finally { await A.close(); }
});

// ---------- no result / unavailable / manual ----------
test('NO RESULT: a clear message that also explains the coverage limit, and manual entry stays available', withSearch({ matches: [] }, async (a, h, c) => {
  const r = await search(c, 'zzzz unknown company');
  assert.equal(r.status, 'NO_RESULT');
  assert.equal(r.results.length, 0);
  assert.equal(r.manualEntryAvailable, true);
  assert.match(r.message, /Peppol/);
  assert.match(r.message, /manually/);
}));

test('PROVIDER UNAVAILABLE (name search down, HTTP error, VIES down): manual fallback, never an error page', async () => {
  for (const cfg of [{ peppol: 'down' }, { peppol: '503' }]) {
    const h = harness(cfg); const a = await startApp(h.opts);
    try { const r = await search(await a.authed(), 'exemple'); assert.equal(r.status, 'PROVIDER_UNAVAILABLE'); assert.equal(r.manualEntryAvailable, true); assert.match(r.message, /manually/); } finally { await a.close(); }
  }
  const h = harness({ vies: 'down' }); const a = await startApp(h.opts);
  try {
    const c = await a.authed();
    const num = await search(c, 'BE0000000196');
    assert.equal(num.status, 'PROVIDER_UNAVAILABLE');
    assert.equal(num.manualEntryAvailable, true);
    const res = (await c.post('/api/companies/resolve', { enterpriseNumber: '0000000196', name: 'Client Exemple SA' })).data;
    assert.equal(res.status, 'PROVIDER_UNAVAILABLE');
    assert.equal(res.result.form.name, 'Client Exemple SA'); // what is known is kept
    assert.equal(res.result.form.enterpriseNumber, '0000.000.196');
    const name = await search(c, 'exemple'); // VIES down only stops the enrichment: names and numbers still come back
    assert.equal(name.status, 'OK');
    assert.ok(name.results.every((x) => x.needsResolve === true && x.enterpriseNumber));
  } finally { await a.close(); }
});

test('with the name-search provider down, saved companies are still offered', async () => {
  const h = harness({ peppol: 'down' }); const a = await startApp(h.opts);
  try {
    const c = await a.authed();
    await c.post('/api/companies', { ...CUSTOMER_BODY, name: 'Exemple Local SRL' });
    const r = await search(c, 'exemple');
    assert.equal(r.status, 'OK');
    assert.equal(r.results[0].name, 'Exemple Local SRL');
    assert.match(r.message, /not available/);
  } finally { await a.close(); }
});

test('MANUAL FALLBACK: providers switched off in Settings, or a query that is too short, still leaves manual entry', async () => {
  const s = baseSettings(); s.companySearch.provider = 'none'; s.companyLookup.provider = 'manual';
  const a = await startApp({ settings: s });
  try {
    const c = await a.authed();
    const name = await search(c, 'exemple');
    assert.equal(name.status, 'SEARCH_NOT_CONFIGURED');
    assert.equal(name.manualEntryAvailable, true);
    const num = await search(c, 'BE0000000196');
    assert.equal(num.status, 'SEARCH_NOT_CONFIGURED');
    assert.equal(num.manualEntryAvailable, true);
    assert.equal((await search(c, 'ab')).status, 'QUERY_TOO_SHORT');
    assert.equal((await search(c, '')).status, 'QUERY_TOO_SHORT');
    const manual = await c.post('/api/companies', { ...CUSTOMER_BODY, source: 'manual' }); // the merchant can always just type it
    assert.equal(manual.status, 201);
    assert.equal(manual.data.source, 'manual');
  } finally { await a.close(); }
});

test('the search is a settings choice: name-search and VAT-lookup providers are validated', async () => {
  const a = await startApp({});
  try {
    const c = await a.authed();
    assert.equal((await c.put('/api/settings', { companySearch: { provider: 'scraper' } })).status, 422);
    const ok = await c.put('/api/settings', { companySearch: { provider: 'none' }, companyLookup: { provider: 'manual' } });
    assert.equal(ok.status, 200);
    assert.equal(ok.data.settings.companySearch.provider, 'none');
  } finally { await a.close(); }
});

test('the search endpoints need a session and a CSRF token', withSearch({}, async (a, h, c) => {
  assert.equal((await a.client().raw('POST', '/api/companies/search', { query: 'exemple' }, { noCsrf: true })).status, 401);
  assert.equal((await a.client().raw('POST', '/api/companies/resolve', { enterpriseNumber: '0000000196' }, { noCsrf: true })).status, 401);
  assert.equal((await c.raw('POST', '/api/companies/search', { query: 'exemple' }, { noCsrf: true })).status, 403);
}));

// ---------- providers and helpers ----------
test('classifyQuery: numbers are never treated as names, names need 3+ characters, control characters are stripped', () => {
  for (const q of ['BE0123456789', 'be 0123.456.789', '0123.456.789', '123456789', '  BE 0000 000 196 ']) assert.equal(classifyQuery(q).mode, 'number', q);
  assert.equal(classifyQuery('Atelier Namur').mode, 'name');
  assert.equal(classifyQuery('Atelier 2000 SRL').mode, 'name'); // contains letters: a name even though it has digits
  assert.equal(classifyQuery('ab').mode, 'too_short');
  assert.equal(classifyQuery('  ').mode, 'empty');
  assert.equal(classifyQuery('ate\x07lier').raw, 'atelier');
  assert.equal(classifyQuery('x'.repeat(200)).raw.length, 80);
});

test('Peppol Directory provider: only Belgian schemes with a valid number, one entry per company, language preference, safe query encoding', async () => {
  assert.equal(enterpriseDigitsFromParticipant('0208:0000000196'), '0000000196');
  assert.equal(enterpriseDigitsFromParticipant('9925:be0000000196'), '0000000196');
  assert.equal(enterpriseDigitsFromParticipant('0208:0123456789'), null);
  assert.equal(enterpriseDigitsFromParticipant('0088:1234'), null);
  let url;
  const p = createPeppolDirectoryProvider({ fetchImpl: async (u) => { url = String(u); return { ok: true, json: async () => ({ matches: MATCHES, 'total-result-count': 6 }) }; } });
  const r = await p.search({ query: 'a&b=c#x', limit: 10 });
  assert.equal(r.status, 'OK');
  assert.equal(r.results.length, 3);
  assert.equal(r.results[0].name, 'Client Exemple SA'); // French name preferred over Dutch
  assert.ok(url.includes('q=a%26b%3Dc%23x'), url); // the query cannot inject parameters
  assert.ok(url.startsWith('https://directory.peppol.eu/'));
  assert.equal((await createPeppolDirectoryProvider({ fetchImpl: async () => ({ ok: true, json: async () => { throw new Error('bad json'); } }) }).search({ query: 'x' })).status, 'UNAVAILABLE');
  assert.equal((await NoSearchProvider.search()).status, 'NOT_CONFIGURED');
});

test('toFormFields is the single mapping used to fill the form and covers every field, with safe defaults', () => {
  assert.deepEqual(Object.keys(toFormFields({})).sort(), [...ALL_FIELDS].sort());
  assert.equal(toFormFields({}).countryCode, 'BE');
  assert.deepEqual(toFormFields({ name: 'N', vatNumber: 'V', enterpriseNumber: 'E', address: { street: 'S', postalCode: 'P', city: 'C', countryCode: 'FR' } }), { name: 'N', vatNumber: 'V', enterpriseNumber: 'E', street: 'S', postalCode: 'P', city: 'C', countryCode: 'FR' });
});

test('NO SCRAPING: the BCE/KBO public search is not referenced anywhere in the source, and only the official APIs are called', () => {
  const walk = (d) => readdirSync(d).flatMap((f) => { const p = `${d}/${f}`; return statSync(p).isDirectory() ? walk(p) : [p]; });
  const src = walk(new URL('../src', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')).filter((f) => f.endsWith('.js'));
  for (const f of src) assert.ok(!/kbopub|economie\.fgov\.be\/.*(search|zoek)|kbo-bce-public/i.test(readFileSync(f, 'utf8')), f);
  const providers = readFileSync(new URL('../src/finance/company-search.js', import.meta.url), 'utf8') + readFileSync(new URL('../src/finance/company.js', import.meta.url), 'utf8');
  const urls = [...providers.matchAll(/https?:\/\/[A-Za-z0-9./_-]+/g)].map((m) => new URL(m[0]).host);
  assert.deepEqual([...new Set(urls)].sort(), ['cbeapi.be', 'directory.peppol.eu', 'ec.europa.eu']);
});

// ---------- UI: one shared component, exact labels ----------
test('UI: ONE shared search component is used by Add company, New invoice and New quote, with the exact labels', () => {
  const ui = readFileSync(new URL('../src/finance/ui/app.js', import.meta.url), 'utf8').replace(/\/\/.*$/gm, '');
  assert.equal((ui.match(/function companySearchBox\(/g) ?? []).length, 1); // defined once
  assert.equal((ui.match(/companySearchBox\(\{ onPick:/g) ?? []).length, 2); // two call sites: the shared invoice/quote form and the company dialog
  assert.match(ui, /function viewForm\(kind, editId\)/); // the same form serves invoices AND quotes
  assert.ok(ui.includes("'Search company name or VAT / enterprise number'"));
  assert.ok(ui.includes("'Search'"));
  assert.match(ui, /\/api\/companies\/search/);
  assert.match(ui, /\/api\/companies\/resolve/);
  assert.ok(!/\/api\/companies\/lookup/.test(ui)); // the old VAT-only lookup button is gone
  assert.match(ui, /function fillFromResult\(/); // one mapping fills the form; nothing is guessed in the browser
  assert.match(ui, /sourceText\(/); // the source of the data is always shown
  assert.ok(!/innerHTML/.test(ui));
});
