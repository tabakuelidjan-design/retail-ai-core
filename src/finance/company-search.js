// One company-search experience over replaceable providers.
//
//   number input  -> normalise + validate offline -> VIES (official EU VAT service)        [existing lookup provider chain]
//   name input    -> CompanySearchProvider (name search)                                    [replaceable]
//   selection     -> resolve: VIES fills address / VAT confirmation for the chosen company
//   nothing usable / provider down -> manual entry, always available
//
// PRIMARY source: the Belgian register (CBEAPI over the official KBO/BCE open data) via a replaceable registry provider; VIES only confirms VAT activity;
// OpenPeppol is a secondary name source. Sole traders (natural persons) are never listed by name, only returned for an exact number.
// Legitimate sources only. The BCE/KBO Public Search website is NEVER scraped (automated queries are prohibited).
// Name-search provider today: the OpenPeppol Directory public search API (free, official). It knows only companies that are
// registered on Peppol and returns no address, so results are enriched through VIES. A fuller provider (for example a licensed
// KBO data service or a locally imported KBO Open Data copy) can replace it by implementing the CompanySearchProvider contract.

import { normalizeBelgianNumber } from './company.js';

/**
 * CompanySearchProvider contract:
 *   { name: string, label: string,
 *     search({ query, limit }) => Promise<{ status: 'OK'|'UNAVAILABLE'|'NOT_CONFIGURED', results: Array<{ name, enterpriseNumber, status?, city? }>, reason? }> }
 * `enterpriseNumber` is the 10-digit Belgian number (digits only). Providers never return credentials, and never scrape.
 */

const TIMEOUT_MS = 8000;
const signal = () => (typeof AbortSignal !== 'undefined' && AbortSignal.timeout ? AbortSignal.timeout(TIMEOUT_MS) : undefined);

export const NoSearchProvider = {
  name: 'none', label: 'No company-name search configured',
  async search() { return { status: 'NOT_CONFIGURED', results: [] }; },
};

const NAME_LANG_ORDER = ['fr', 'nl', 'en', 'de'];
const pickName = (names) => {
  const list = (names ?? []).filter((n) => n?.name);
  for (const l of NAME_LANG_ORDER) { const hit = list.find((n) => n.language === l); if (hit) return hit.name; }
  return list[0]?.name ?? null;
};

/** Belgian enterprise number (10 digits) from a Peppol participant id: 0208:<digits> or 9925:be<digits>; null otherwise. */
export function enterpriseDigitsFromParticipant(value) {
  const v = String(value ?? '').toLowerCase();
  const m = /^0208:(\d{9,10})$/.exec(v) ?? /^9925:be(\d{9,10})$/.exec(v);
  if (!m) return null;
  const n = normalizeBelgianNumber(m[1]);
  return n.ok ? n.digits : null;
}

/** OpenPeppol Directory public search (free, official). Belgian participants only; results are de-duplicated per enterprise number. */
export function createPeppolDirectoryProvider({ fetchImpl = fetch, endpoint = 'https://directory.peppol.eu/search/1.0/json' } = {}) {
  return {
    name: 'peppol_directory', label: 'OpenPeppol Directory (companies registered on Peppol only)',
    async search({ query, limit = 10 }) {
      const url = `${endpoint}?${new URLSearchParams({ q: query, country: 'BE', rpc: String(Math.min(50, Math.max(limit * 3, 10))) })}`;
      let res;
      try { res = await fetchImpl(url, { method: 'GET', headers: { Accept: 'application/json' }, signal: signal() }); } catch (e) { return { status: 'UNAVAILABLE', results: [], reason: `NETWORK: ${e.message}` }; }
      if (!res.ok) return { status: 'UNAVAILABLE', results: [], reason: `HTTP_${res.status}` };
      let j;
      try { j = await res.json(); } catch { return { status: 'UNAVAILABLE', results: [], reason: 'INVALID_RESPONSE' }; }
      const byNumber = new Map();
      for (const m of j.matches ?? []) {
        const digits = enterpriseDigitsFromParticipant(m?.participantID?.value);
        if (!digits) continue;
        const entity = (m.entities ?? []).find((e) => !e.countryCode || e.countryCode === 'BE') ?? m.entities?.[0];
        const name = pickName(entity?.name);
        if (!name) continue;
        if (!byNumber.has(digits)) byNumber.set(digits, { name, enterpriseNumber: digits, status: entity?.regDate ? `Registered on Peppol since ${entity.regDate}` : 'Registered on Peppol' });
      }
      return { status: 'OK', results: [...byNumber.values()].slice(0, limit), total: j['total-result-count'] ?? null };
    },
  };
}

/**
 * BelgianCompanyRegistry contract (the PRIMARY source, replaceable):
 *   { name, label,
 *     getByNumber(digits) => { status: 'FOUND'|'NOT_FOUND'|'UNAVAILABLE'|'NOT_CONFIGURED', company?, reason? }
 *     search({ query, limit }) => { status: 'OK'|'UNAVAILABLE'|'NOT_CONFIGURED', companies: [], reason? } }
 * company = { name, enterpriseNumber (10 digits), status, legalForm, address: {street, postalCode, city, countryCode}, personalData: boolean }
 * `personalData` is true for a sole trader (natural person). Registries never log these details.
 */
export const NoRegistry = {
  name: 'none', label: 'No Belgian company register configured',
  async getByNumber() { return { status: 'NOT_CONFIGURED' }; },
  async search() { return { status: 'NOT_CONFIGURED', companies: [] }; },
};

const titleCase = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : null);
function fromCbeApi(d) {
  const n = normalizeBelgianNumber(d?.cbe_number);
  if (!n.ok) return null;
  const a = d.address ?? null;
  const personal = d.type === 'natural_person';
  const street = a ? [a.street, [a.street_number, a.box].filter(Boolean).join('/')].filter(Boolean).join(' ') : '';
  const situation = d.juridical_situation && d.juridical_situation_code !== '000' ? ` (${d.juridical_situation})` : '';
  return {
    name: (personal ? d.denomination : d.denomination_with_legal_form || d.denomination) ?? null,
    enterpriseNumber: n.enterpriseNumber, digits: n.digits,
    status: d.status ? `${titleCase(d.status)}${situation}` : null, active: d.status === 'active',
    legalForm: d.juridical_form_short || null, personalData: personal,
    address: a ? { street, postalCode: a.post_code ?? '', city: a.city ?? '', countryCode: a.country_code || 'BE' } : null,
  };
}

/** CBEAPI (cbeapi.be): REST API over the official KBO/BCE open data files. Free tier = monthly snapshot. Bearer key from CBEAPI_KEY. */
export function createCbeApiProvider({ apiKey, fetchImpl = fetch, baseUrl = 'https://cbeapi.be/api/v1' } = {}) {
  if (!apiKey) return NoRegistry;
  async function get(path) {
    let res;
    try { res = await fetchImpl(`${baseUrl}${path}`, { method: 'GET', headers: { Accept: 'application/json', Authorization: `Bearer ${apiKey}` }, signal: signal() }); } catch (e) { return { unavailable: `NETWORK: ${e.name === 'TimeoutError' ? 'timeout' : 'failed'}` }; }
    if (res.status === 404) return { notFound: true };
    if (res.status === 401 || res.status === 403) return { unavailable: 'AUTH_REJECTED' };
    if (res.status === 429) return { unavailable: 'RATE_LIMITED' };
    if (!res.ok) return { unavailable: `HTTP_${res.status}` };
    try { return { json: await res.json() }; } catch { return { unavailable: 'INVALID_RESPONSE' }; }
  }
  return {
    name: 'cbeapi', label: 'Belgian company register (KBO/BCE via CBEAPI)',
    async getByNumber(digits) {
      const r = await get(`/company/${encodeURIComponent(digits)}`);
      if (r.notFound) return { status: 'NOT_FOUND' };
      if (r.unavailable) return { status: 'UNAVAILABLE', reason: r.unavailable };
      const c = fromCbeApi(r.json?.data);
      return c ? { status: 'FOUND', company: c } : { status: 'NOT_FOUND' };
    },
    async search({ query, limit = 10 }) {
      const r = await get(`/company/search?${new URLSearchParams({ name: query })}`);
      if (r.notFound) return { status: 'OK', companies: [] };
      if (r.unavailable) return { status: 'UNAVAILABLE', companies: [], reason: r.unavailable };
      const list = Array.isArray(r.json?.data) ? r.json.data : [];
      return { status: 'OK', companies: list.map(fromCbeApi).filter(Boolean).slice(0, Math.max(limit, 10)) };
    },
  };
}

/** What kind of input is this? Numbers are validated offline and never treated as a name. */
export function classifyQuery(input) {
  const raw = String(input ?? '').replace(/[\x00-\x1F\x7F]/g, '').trim();
  if (!raw) return { mode: 'empty', raw };
  if (/^(BE)?[\s.\-]*\d[\d\s.\-]*$/i.test(raw)) return { mode: 'number', raw };
  if (raw.length < 3) return { mode: 'too_short', raw };
  return { mode: 'name', raw: raw.slice(0, 80) };
}

const vatOf = (digits) => `BE${digits}`;
const sourceLabel = { cbeapi: 'Belgian company register (KBO/BCE via CBEAPI)', vies: 'EU VIES (official VAT service)', peppol_directory: 'OpenPeppol Directory', directory: 'Your company directory' };
export const PERSONAL_DATA_LABEL = 'SOLE TRADER / PERSONAL DATA';

/** The exact set of form fields a selected result fills. The UI assigns these and nothing else. */
export function toFormFields(c) {
  return { name: c.name ?? '', vatNumber: c.vatNumber ?? '', enterpriseNumber: c.enterpriseNumber ?? '', street: c.address?.street ?? '', postalCode: c.address?.postalCode ?? '', city: c.address?.city ?? '', countryCode: c.address?.countryCode ?? 'BE' };
}

const resultOf = (c, source, extra = {}) => ({
  key: `${source}:${c.enterpriseNumber ?? c.id ?? c.name}`, id: c.id ?? null, name: c.name, enterpriseNumber: c.enterpriseNumber ?? null, vatNumber: c.vatNumber ?? null,
  city: c.address?.city ?? c.city ?? null, postalCode: c.address?.postalCode ?? null, status: c.status ?? null, source, sourceLabel: sourceLabel[source] ?? source,
  address: c.address ?? null, vatVerified: source === 'vies', legalForm: c.legalForm ?? null, personalData: !!c.personalData, personalDataLabel: c.personalData ? PERSONAL_DATA_LABEL : null, form: toFormFields(c), ...extra,
});

/**
 * @param {{numberLookup: {lookup: Function}, nameProvider: object, directorySearch?: (q: string) => Promise<object[]>, enrichLimit?: number}} deps
 * numberLookup: createCompanyLookup(...) over VIES; nameProvider: a CompanySearchProvider; directorySearch: saved companies (merchant-scoped).
 */
export function createCompanySearch({ numberLookup, nameProvider = NoSearchProvider, registry = NoRegistry, directorySearch = async () => [], enrichLimit = 6 }) {
  const manual = { manualEntryAvailable: true };

  /**
   * Primary path for one exact number: the Belgian register gives name, address, status; VIES only confirms that the VAT number is
   * active (the VAT number is filled in only when VIES confirms it). Returns null when the register has no usable answer.
   */
  async function fromRegistry(n) {
    const reg = await registry.getByNumber(n.digits);
    if (reg.status !== 'FOUND') return { miss: reg.status, reason: reg.reason ?? null };
    const c = reg.company;
    const vies = await numberLookup.lookup({ vatNumber: n.vatNumber });
    const vatOk = vies.status === 'FOUND';
    const res = resultOf({ ...c, enterpriseNumber: n.enterpriseNumber, vatNumber: vatOk ? n.vatNumber : null }, 'cbeapi', { vatVerified: vatOk, vatState: vatOk ? 'ACTIVE' : vies.status === 'NOT_FOUND' ? 'NOT_REGISTERED' : 'UNCHECKED' });
    const notes = [];
    if (!c.active) notes.push(`Register status: ${c.status ?? 'not active'}. Check before invoicing.`);
    if (!vatOk) notes.push(vies.status === 'NOT_FOUND' ? 'No active VAT registration was found in VIES, so the VAT number was left empty.' : 'The VAT number could not be checked right now, so it was left empty.');
    if (c.personalData) notes.push(`${PERSONAL_DATA_LABEL}: this is a natural person. Nothing is saved unless you save this customer.`);
    return { result: res, message: ['Filled in from the Belgian company register.', ...notes].join(' ') };
  }

  /** Enrich a name-search hit with address/VAT confirmation from VIES. Never throws; a failure just leaves the hit as it is. */
  async function resolveNumber(digits, fallback = {}) {
    const r = await numberLookup.lookup({ vatNumber: vatOf(digits) });
    if (r.status === 'FOUND') return { found: true, company: { ...r.company, status: fallback.status ?? null } };
    return { found: false, reason: r.status, company: { name: fallback.name ?? null, enterpriseNumber: normalizeBelgianNumber(digits).enterpriseNumber, vatNumber: null, address: null, status: fallback.status ?? null } };
  }

  return {
    /** Resolve one selected hit (by enterprise number) to full company fields. */
    async resolve({ enterpriseNumber, name = null, status = null }) {
      const n = normalizeBelgianNumber(enterpriseNumber);
      if (!n.ok) return { status: 'INVALID_NUMBER', reason: n.reason, ...manual };
      const primary = await fromRegistry(n);
      if (primary.result) return { status: 'FOUND', result: primary.result, ...manual, message: primary.message };
      const r = await resolveNumber(n.digits, { name, status });
      if (r.found) return { status: 'FOUND', result: resultOf(r.company, 'vies'), ...manual, message: 'Official data filled in from EU VIES. Check it before saving.' };
      if (r.reason === 'UNAVAILABLE') return { status: 'PROVIDER_UNAVAILABLE', result: resultOf({ ...r.company, vatNumber: null }, 'peppol_directory'), ...manual, message: 'The official lookup is not available right now. The name and enterprise number were kept: complete the address by hand.' };
      return { status: 'PARTIAL', result: resultOf(r.company, 'peppol_directory'), ...manual, message: 'This number is not VAT-registered according to VIES, so no address is available. The name and enterprise number were kept: complete the rest by hand.' };
    },

    async search(input) {
      const q = classifyQuery(input);
      if (q.mode === 'empty' || q.mode === 'too_short') return { status: 'QUERY_TOO_SHORT', mode: q.mode, results: [], ...manual, message: 'Type at least 3 letters of the name, or a VAT / enterprise number.' };

      if (q.mode === 'number') {
        const n = normalizeBelgianNumber(q.raw);
        if (!n.ok) return { status: 'INVALID_NUMBER', mode: 'number', reason: n.reason, results: [], ...manual, message: 'This is not a valid Belgian VAT / enterprise number. Check it, or enter the company manually.' };
        const saved = (await directorySearch(n.digits)).filter((c) => c.enterpriseNumber === n.enterpriseNumber || c.vatNumber === n.vatNumber);
        if (saved.length) return { status: 'FOUND', mode: 'number', results: saved.map((c) => resultOf(c, 'directory')), autoFill: resultOf(saved[0], 'directory'), ...manual, message: 'This company is already in your directory.' };
        const primary = await fromRegistry(n);
        if (primary.result) return { status: 'FOUND', mode: 'number', results: [primary.result], autoFill: primary.result, ...manual, message: primary.message };
        const r = await numberLookup.lookup({ vatNumber: n.vatNumber });
        if (r.status === 'FOUND') { const res = resultOf(r.company, 'vies'); return { status: 'FOUND', mode: 'number', results: [res], autoFill: res, ...manual, message: 'Official data found and filled in. Check it, then save.' }; }
        if (r.status === 'MANUAL_ENTRY_REQUIRED') return { status: 'SEARCH_NOT_CONFIGURED', mode: 'number', results: [], ...manual, message: 'The official VAT lookup is switched off in Settings. Enter the company manually.' };
        if (r.status === 'NOT_FOUND') { const res = resultOf({ name: null, enterpriseNumber: n.enterpriseNumber, vatNumber: null, address: null }, 'vies', { vatVerified: false }); return { status: 'NO_RESULT', mode: 'number', reason: 'NOT_VAT_REGISTERED', results: [], partial: res, ...manual, message: 'The number is valid but VIES has no VAT registration for it. Enter the company manually.' }; }
        return { status: 'PROVIDER_UNAVAILABLE', mode: 'number', reason: r.reason ?? r.status, results: [], ...manual, message: 'The official lookup is not available right now. Enter the company manually.' };
      }

      // name search: saved companies first, then the provider
      const saved = await directorySearch(q.raw);
      const savedResults = saved.slice(0, 5).map((c) => resultOf(c, 'directory'));
      // primary: the Belgian register. Sole traders (natural persons) are never listed: they can only be found by exact number.
      const reg = await registry.search({ query: q.raw, limit: 10 });
      if (reg.status === 'OK') {
        const seen = new Set(savedResults.map((r) => r.enterpriseNumber));
        const legal = reg.companies.filter((c) => !c.personalData);
        const hidden = reg.companies.length - legal.length;
        const listed = legal.filter((c) => !seen.has(c.enterpriseNumber)).map((c) => resultOf({ ...c, vatNumber: null }, 'cbeapi', { needsVatCheck: true, vatVerified: false }));
        const results = [...savedResults, ...listed];
        if (results.length) {
          const extra = hidden ? ` ${hidden} sole trader${hidden > 1 ? 's were' : ' was'} not listed (personal data): search by exact enterprise / VAT number to find one.` : '';
          return { status: 'OK', mode: 'name', results, autoFill: null, hiddenPersonalCount: hidden, ...manual, sources: [registry.label, 'EU VIES (VAT check on selection)'], message: (results.length === 1 ? 'One company found. Select it to fill the form.' : `${results.length} companies found. Choose the right one.`) + extra };
        }
        if (hidden) return { status: 'NO_RESULT', mode: 'name', results: [], hiddenPersonalCount: hidden, ...manual, sources: [registry.label], message: `No company found. ${hidden} sole trader${hidden > 1 ? 's matched' : ' matched'} but ${hidden > 1 ? 'are' : 'is'} not listed (personal data): search by exact enterprise / VAT number, or enter the company manually.` };
      }
      // secondary: OpenPeppol (registered on Peppol only), enriched through VIES
      const p = await nameProvider.search({ query: q.raw, limit: 10 });
      if (p.status === 'NOT_CONFIGURED') return { status: savedResults.length ? 'OK' : 'SEARCH_NOT_CONFIGURED', mode: 'name', results: savedResults, ...manual, message: savedResults.length ? 'Showing your saved companies. Company-name search is not configured: use a VAT number or enter manually.' : 'Company-name search is not configured. Search by VAT / enterprise number, or enter the company manually.' };
      if (p.status === 'UNAVAILABLE') return { status: savedResults.length ? 'OK' : 'PROVIDER_UNAVAILABLE', mode: 'name', reason: p.reason, results: savedResults, ...manual, message: 'The company search is not available right now.' + (savedResults.length ? ' Showing your saved companies.' : ' Enter the company manually.') };
      const known = new Set(savedResults.map((r) => r.enterpriseNumber));
      const hits = p.results.filter((h) => !known.has(normalizeBelgianNumber(h.enterpriseNumber).enterpriseNumber));
      // enrich the first hits through VIES so the list can show the city and the VAT number is confirmed
      const enriched = await Promise.all(hits.map(async (h, i) => {
        if (i >= enrichLimit) return resultOf({ name: h.name, enterpriseNumber: normalizeBelgianNumber(h.enterpriseNumber).enterpriseNumber, vatNumber: vatOf(h.enterpriseNumber), status: h.status, address: null }, 'peppol_directory', { needsResolve: true });
        const r = await resolveNumber(h.enterpriseNumber, { name: h.name, status: h.status });
        return r.found ? resultOf({ ...r.company, name: r.company.name || h.name }, 'vies', { needsResolve: false, status: h.status }) : resultOf({ name: h.name, enterpriseNumber: normalizeBelgianNumber(h.enterpriseNumber).enterpriseNumber, vatNumber: null, status: h.status, address: null }, 'peppol_directory', { needsResolve: true, vatVerified: false });
      }));
      const results = [...savedResults, ...enriched];
      if (!results.length) return { status: 'NO_RESULT', mode: 'name', results: [], ...manual, message: 'No company found. This search only knows companies registered on Peppol: try the VAT / enterprise number, or enter the company manually.', sources: [nameProvider.label] };
      const only = results.length === 1 && results[0].source !== 'directory' && !results[0].needsResolve ? results[0] : null;
      return { status: 'OK', mode: 'name', results, autoFill: only, ...manual, sources: [nameProvider.label, 'EU VIES (official VAT service)'], message: results.length === 1 ? 'One company found.' : `${results.length} companies found. Choose the right one.` };
    },
  };
}
