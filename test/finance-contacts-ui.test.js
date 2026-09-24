// Phase 2 (Contacts UI): this codebase has no DOM/browser test harness (no jsdom, no headless browser) -
// only the i18n layer is unit-tested by loading its plain-script source with `new Function` (see
// finance-i18n.test.js). These tests follow the same two techniques already used there:
//   1. pure-logic unit tests, by loading the small DOM-free helpers out of views-contacts.js with minimal
//      stubs (no real document needed - they only format strings);
//   2. structural/regression guards on the source text itself, the same style as finance-i18n.test.js's
//      "UI language is separate from the document language" test.
// Actual rendering (list/drawer DOM output, responsive layout) was verified manually in the built-in
// browser preview at 1920/1440/768/375px - see the Phase 2 report, section E.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (f) => readFileSync(new URL(`../src/finance/ui/${f}`, import.meta.url), 'utf8');
const contactsSrc = read('views-contacts.js');
const appSrc = read('app.js');

// ---------- pure-logic: withCur / fmtDateShort / relation derivation ----------
// These three helpers touch no DOM (no document.*), so they can be pulled out of the real source and
// exercised directly with a minimal I18N/CUR_SYMBOL stub - never reimplemented/copy-pasted for the test.
function loadHelpers(lang) {
  const CUR_SYMBOL = { EUR: '€', USD: '$', GBP: '£' };
  const I18N = { getLang: () => lang, tag: () => ({ fr: 'fr-BE', nl: 'nl-BE', en: 'en-GB' }[lang]) };
  const tt = (s) => s; // identity: these tests only check placement/logic, not translation text itself
  const src = `${contactsSrc}\nreturn { withCur, fmtDateShort, relationKey, relationText };`;
  // eslint-disable-next-line no-new-func
  return new Function('CUR_SYMBOL', 'I18N', 'tt', src)(CUR_SYMBOL, I18N, tt);
}

test('withCur: currency symbol placement follows the same fr/nl/en rule as fmtMoney, and never fabricates an amount', () => {
  const { withCur } = loadHelpers('fr');
  assert.equal(withCur('840,00', 'EUR'), '840,00 €');
  assert.equal(withCur(null, 'EUR'), '—');
  assert.equal(withCur(undefined, 'EUR'), '—');
  assert.equal(loadHelpers('nl').withCur('840,00', 'EUR'), '€ 840,00');
  assert.equal(loadHelpers('en').withCur('840.00', 'USD'), '$840.00');
});

test('fmtDateShort: a valid ISO date formats, a missing/invalid one is an em dash, never a fabricated date', () => {
  const { fmtDateShort } = loadHelpers('fr');
  assert.equal(fmtDateShort(null), '—');
  assert.equal(fmtDateShort(''), '—');
  assert.equal(fmtDateShort('not-a-date'), '—');
  assert.match(fmtDateShort('2026-09-22'), /22 sept\.?/);
});

test('relation derivation: exactly customer-only / supplier-only / both / none, matching the Phase 1 role definition', () => {
  const { relationKey } = loadHelpers('fr');
  assert.equal(relationKey({ isCustomer: true, isSupplier: false }), 'customer');
  assert.equal(relationKey({ isCustomer: false, isSupplier: true }), 'supplier');
  assert.equal(relationKey({ isCustomer: true, isSupplier: true }), 'both');
  assert.equal(relationKey({ isCustomer: false, isSupplier: false }), 'none');
});

// ---------- structural / regression guards on the source ----------
test('routing: #/contacts is a real route, #/companies redirects into it (never removed), and the nav has exactly one Contacts entry', () => {
  assert.match(appSrc, /parts\[0\] === 'contacts'/);
  assert.match(appSrc, /parts\[0\] === 'companies'.*location\.hash = /);
  const navMatch = appSrc.match(/const NAV = \[[\s\S]*?\n\];/);
  assert.ok(navMatch, 'NAV array found');
  assert.equal((navMatch[0].match(/'#\/contacts'/g) || []).length, 1, 'exactly one #/contacts nav entry');
  assert.equal((navMatch[0].match(/'#\/companies'/g) || []).length, 0, 'no separate #/companies nav entry (single Contacts item, not three)');
});

test('the new script is registered so #/contacts can actually load in the browser', () => {
  const html = read('index.html');
  assert.match(html, /views-contacts\.js/);
  const server = readFileSync(new URL('../src/finance/server/app.js', import.meta.url), 'utf8');
  assert.match(server, /'\/views-contacts\.js'/);
});

test('no client-side money arithmetic: the list/drawer only format server-provided amountReceivable/amountPayable strings, never derive a new amount from cents', () => {
  // Phase 3 (real "Trier" sort control) reads amountReceivableCents/amountPayableCents once, purely as a
  // numeric sort key (negated for descending order) - it never combines them, never derives a new amount
  // from them, and never feeds them into a money formatter. That distinction is what this test guards:
  // the Cents fields still may not reach withCur()/fmtMoney() or any displayed string.
  assert.doesNotMatch(contactsSrc, /withCur\([^)]*Cents|fmtMoney\([^)]*Cents/, 'a *Cents field must never be formatted/displayed directly');
  assert.doesNotMatch(contactsSrc, /grossCents\s*[+\-*/]|Cents\s*[+\-]\s*Cents/, 'no cents arithmetic in the Contacts UI');
  const sortKeyLine = contactsSrc.split('\n').find((l) => l.includes('amountReceivableCents') || l.includes('amountPayableCents'));
  assert.ok(sortKeyLine, 'the *Cents fields are still referenced somewhere (the sort key)');
  assert.match(sortKeyLine, /\bsort\b|\bkey\b/, 'the only place *Cents fields are read is the sort-key map, not the list/drawer rendering');
});

test('no per-row network call: each api() call site is a single whole-view or whole-drawer action, never inside a .map/.forEach', () => {
  // Phase 3 (Archivés tab) added 3 real call sites on top of the original 3:
  // GET /api/contacts?role=archived (list load, parallel with the main list), and the
  // archive/restore actions (POST /api/companies/:id/archive|restore) in the drawer footer.
  const apiCalls = contactsSrc.match(/\bapi\(/g) || [];
  assert.equal(apiCalls.length, 6, 'GET /api/contacts (list), GET /api/contacts?role=archived (list), GET /api/contacts/:id (drawer), GET /api/companies/:id (edit prefill), POST .../archive, POST .../restore - no more');
  assert.doesNotMatch(contactsSrc, /\.(?:forEach|map)\([^)]*=>[^}]*\bapi\(/s, 'no api() call written inside a row-iteration callback');
});

test('Phase 2 never builds a Transactions section/tab: contactDetail always returns transactions: [] (Phase 1 scope), so the drawer must not render one', () => {
  // Only the explanatory code comment may mention "Transactions" (documenting the exclusion) - no quoted
  // literal ("rendered text") and no read of c.transactions anywhere in the file.
  assert.doesNotMatch(contactsSrc, /['"]Transactions['"]/);
  assert.doesNotMatch(contactsSrc, /\.transactions\b/);
});

test('REGRESSION: a search that matches nothing is never confused with "no contacts exist at all" (found and fixed during manual verification)', () => {
  const emptyDirectoryLine = contactsSrc.split('\n').find((l) => l.includes('Your contacts will appear here.'));
  const guardLine = contactsSrc.split('\n').find((l) => l.includes('!all.length'));
  assert.ok(guardLine, 'the empty-directory branch condition exists');
  assert.match(guardLine, /search\.value\.trim\(\)/, 'the empty-directory message must not show while a search is active');
  assert.ok(emptyDirectoryLine, 'the empty-directory message string is still present');
});

test('creating a contact never asks for an isCustomer/isSupplier checkbox: roles stay derived, never captured on the form', () => {
  assert.doesNotMatch(contactsSrc, /type:\s*['"]checkbox['"]/, 'the Contacts view itself never renders a form checkbox');
  // companyModal (the reused create/edit form, in app.js) has no role checkbox either - unchanged from Phase 1.
  const modalFn = appSrc.slice(appSrc.indexOf('function companyModal'), appSrc.indexOf('function companyModal') + 2500);
  assert.doesNotMatch(modalFn, /checkbox/);
});
