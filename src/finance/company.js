// Company lookup behind a provider interface, so a commercial provider can replace these without touching invoice logic.
//
// Legitimate Belgian sources investigated (Sept 2026):
//   * EU VIES (official, free, no authentication): validates a VAT number and returns the registered name and address
//     as declared for VAT. It cannot search by name and does not return legal form. Implemented below (`vies`).
//   * KBO/BCE Public Search web page: free for people, but AUTOMATED/BULK SCRAPING IS PROHIBITED. Never scraped here.
//   * KBO/BCE official web service: paid (per-request pricing). Not used in V1; would be a future provider.
//   * KBO Open Data: free monthly CSV (registration required, attribution to FPS Economy). A possible later provider
//     for name search against a locally imported copy.
// `manual` is the default: the merchant enters the company by hand, always available.

const CHECK_LEN = 2;

/** Normalise a Belgian enterprise/VAT number and verify its mod-97 check digits. Pure, offline. */
export function normalizeBelgianNumber(input) {
  if (input === null || input === undefined) return { ok: false, reason: 'EMPTY' };
  let digits = String(input).toUpperCase().replace(/^BE/, '').replace(/[^0-9]/g, '');
  if (digits.length === 9) digits = `0${digits}`; // numbers were historically written without the leading zero
  if (digits.length !== 10) return { ok: false, reason: 'NOT_10_DIGITS' };
  if (!/^[01]/.test(digits)) return { ok: false, reason: 'MUST_START_WITH_0_OR_1' };
  const base = Number(digits.slice(0, 8));
  const check = Number(digits.slice(8, 8 + CHECK_LEN));
  if (97 - (base % 97) !== check) return { ok: false, reason: 'CHECKSUM_INVALID' };
  return { ok: true, digits, enterpriseNumber: `${digits.slice(0, 4)}.${digits.slice(4, 7)}.${digits.slice(7)}`, vatNumber: `BE${digits}`, peppolId: `0208:${digits}` };
}

export const ManualProvider = {
  name: 'manual',
  async lookup() { return { status: 'MANUAL_ENTRY_REQUIRED', source: 'manual', company: null }; },
};

/** Parse the multi-line address VIES returns ("STREET 1\n5000 CITY"). Unparseable input is kept as a raw street line. */
export function parseViesAddress(address) {
  const lines = String(address ?? '').split(/\r?\n/).map((l) => l.trim()).filter((l) => l && l !== '---');
  const last = lines.at(-1) ?? '';
  const m = /^(\d{4})\s+(.+)$/.exec(last);
  return m ? { street: lines.slice(0, -1).join(', '), postalCode: m[1], city: m[2] } : { street: lines.join(', '), postalCode: '', city: '' };
}

export function createViesProvider({ fetchImpl = fetch, endpoint = 'https://ec.europa.eu/taxation_customs/vies/rest-api/check-vat-number', now = () => new Date().toISOString() } = {}) {
  return {
    name: 'vies',
    async lookup({ vatNumber, enterpriseNumber }) {
      const n = normalizeBelgianNumber(vatNumber ?? enterpriseNumber);
      if (!n.ok) return { status: 'INVALID_NUMBER', reason: n.reason, source: 'vies', company: null }; // never sent to VIES
      let res;
      try {
        res = await fetchImpl(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ countryCode: 'BE', vatNumber: n.digits }) });
      } catch (e) { return { status: 'UNAVAILABLE', reason: `NETWORK: ${e.message}`, source: 'vies', company: null }; }
      if (!res.ok) return { status: 'UNAVAILABLE', reason: `HTTP_${res.status}`, source: 'vies', company: null };
      const j = await res.json();
      if (j.userError && j.userError !== 'VALID' && j.userError !== 'INVALID') return { status: 'UNAVAILABLE', reason: String(j.userError), source: 'vies', company: null };
      if (j.valid !== true) return { status: 'NOT_FOUND', reason: 'NOT_VAT_REGISTERED_ACCORDING_TO_VIES', source: 'vies', company: null };
      const addr = parseViesAddress(j.address);
      return {
        status: 'FOUND', source: 'vies', retrievedAt: now(),
        company: { kind: 'business', name: j.name && j.name !== '---' ? j.name : '', vatNumber: n.vatNumber, enterpriseNumber: n.enterpriseNumber, peppolId: n.peppolId, address: { ...addr, countryCode: 'BE' }, source: 'vies', verifiedAt: now() },
        limitations: ['VIES_CONFIRMS_VAT_REGISTRATION_AND_DECLARED_NAME_ADDRESS_ONLY', 'NO_LEGAL_FORM', 'NO_NAME_SEARCH'],
      };
    },
  };
}

/** Provider chain: the first provider that returns FOUND wins; otherwise the most informative failure is returned. */
export function createCompanyLookup(providers = [ManualProvider]) {
  return {
    providers: providers.map((p) => p.name),
    async lookup(query) {
      if (!query?.vatNumber && !query?.enterpriseNumber && !query?.name) return { status: 'INVALID_QUERY', reason: 'NAME_OR_NUMBER_REQUIRED', company: null };
      let last = { status: 'MANUAL_ENTRY_REQUIRED', company: null, source: 'manual' };
      for (const p of providers) {
        const r = await p.lookup(query);
        if (r.status === 'FOUND') return r;
        if (r.status !== 'MANUAL_ENTRY_REQUIRED' || last.status === 'MANUAL_ENTRY_REQUIRED') last = r;
      }
      return last;
    },
  };
}
