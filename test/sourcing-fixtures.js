// Synthetic fixtures for the China-sourcing tests. Everything here is INVENTED (names, models, documents, alerts): no real supplier, lab or product.
import { newCase, dispatch, assess } from '../src/sourcing/core/case.js';
import { RULEBOOK } from '../src/sourcing/core/rulebook/index.js';
import { KEY_TRAITS } from '../src/sourcing/core/taxonomy.js';

export const NOW = new Date('2026-10-03T12:00:00Z');
export const MFR = 'Shenzhen Brightway Electronics Co., Ltd';
export const LIVE_CLEAN = { alerts: [], source: { mode: 'LIVE_VERIFIED', fetchedAt: NOW.toISOString(), coverage: 'synthetic: 0 alerts' } };

/** A tiny pipeline: events applied in order on a fresh case. */
export function build(events, { name = '' } = {}) {
  let c = newCase({ id: 'case-test', name, now: NOW });
  for (const e of events) c = dispatch(c, e, NOW);
  return c;
}
export const run = (c, externals = { safety: LIVE_CLEAN }, extra = {}) => assess(c, { now: NOW, externals, ...extra });
/** TEST ONLY: what the rulebook would look like once an expert had reviewed every rule. Proves GO stays reachable, and that today's honest statuses are what hold it back. */
export const REVIEWED_RULEBOOK = RULEBOOK.map((r) => ({ ...r, review: { status: 'VERIFIED_PRIMARY_TEXT_ONLY', basis: 'test override' } }));

// ---- events ----------------------------------------------------------------------------------------------------------------------------------------------------------------
export const ident = ({ name, category, model = 'X-100', brand = 'Brightway', manufacturer = MFR }) => [
  { type: 'NAME', name }, { type: 'CATEGORY', category },
  { type: 'IDENTIFIER', name: 'model', value: model, level: 'USER_STATED' }, { type: 'IDENTIFIER', name: 'brand', value: brand, level: 'USER_STATED' }, { type: 'IDENTIFIER', name: 'manufacturer', value: manufacturer, level: 'USER_STATED' },
];
/** The owner looked at the product and answered every key trait (USER_STATED beats the category guess). */
export const traits = (values) => KEY_TRAITS.map((t) => ({ type: 'TRAIT', trait: t, value: values[t] ?? false }));
export const extraTraits = (values) => Object.entries(values).map(([trait, value]) => ({ type: 'TRAIT', trait, value }));
export const importer = [{ type: 'PLACING', placing: { underOwnNameOrBrand: false, manufacturerEstablishedInEU: false, euAuthorisedRepresentative: false, substantialModification: false } }];
export const ownBrand = [{ type: 'PLACING', placing: { underOwnNameOrBrand: true, manufacturerEstablishedInEU: false, euAuthorisedRepresentative: false, substantialModification: false } }];
export const commercial = ({ unitPrice = 4.2, qty = 1000, moq = 500, price = 19.99, target = 30, duty = 2.7, code = '8504.40' } = {}) => [
  { type: 'QUOTE', quote: { unitPrice, currency: 'USD', qty, moq, incoterm: 'FOB', leadTimeDays: 20, carton: '40x30x30 cm / 12 kg / 50 units' } },
  { type: 'COSTS', costs: { fx: { rate: 0.92, date: '2026-10-02', source: 'USER_ENTERED' }, costs: { freight: { total: 600, status: 'ESTIMATED' } }, importVat: { ratePct: 21, recoverable: true } } },
  { type: 'CUSTOMS', customs: { chosenCode: code, duty: { ratePct: duty, kind: 'USER_ENTERED', source: 'owner' } } },
  { type: 'SALE', sale: { sellingPriceGross: price, vatRatePct: 21, targetContributionPct: target } },
];

// ---- synthetic documents ---------------------------------------------------------------------------------------------------------------------------------------------
export const eudoc = ({ model = 'X-100', mfr = MFR, product = 'Product', directives = [], standards = [], date = '2026-03-15', complete = true } = {}) => `EU DECLARATION OF CONFORMITY
Manufacturer: ${mfr}
${complete ? 'Address: Building 5, Longhua District, Shenzhen City, China\n' : ''}Product name: ${product}
Model: ${model}
${complete ? 'This declaration of conformity is issued under the sole responsibility of the manufacturer.\n' : ''}The object of the declaration described above is in conformity with the relevant Union harmonisation legislation: ${directives.join(', ')}.
Harmonised standards applied: ${standards.join(', ')}.
${complete ? `Signed for and on behalf of: Li Wei\nName: Li Wei   Function: General Manager\nPlace and date of issue: Shenzhen, ${date}\nSignature: signed` : ''}`;

export const testReport = ({ model = 'X-100', mfr = MFR, product = 'Product', standards = [], lab = 'Pearl Delta Testing Services Ltd', accredited = true, date = '2026-03-10', issue = '2026-03-12', no = 'R-2603-0045', rohs = false } = {}) => `TEST REPORT
Report No.: ${no}
Testing laboratory: ${lab}
${accredited ? 'Accreditation: CNAS L0139, ISO/IEC 17025\n' : ''}Applicant: ${mfr}
Manufacturer: ${mfr}
Product name: ${product}
Model: ${model}
Standards tested: ${standards.join(', ')}.
${rohs ? 'Substances restricted by RoHS were tested: result pass.\n' : ''}Date of test: ${date}
Date of issue: ${issue}
Page 1 of 1`;

export const doc = (text, extra = {}) => ({ type: 'DOCUMENT', text, fileName: extra.fileName ?? 'doc.txt', ...extra });

/** Complete, consistent evidence sets, per regime. */
export const docsFor = {
  charger: (model) => [
    doc(eudoc({ model, product: 'USB charger', directives: ['2014/35/EU', '2014/30/EU', '2011/65/EU'], standards: ['EN 62368-1:2014', 'EN 55032:2015', 'EN 55035:2017', 'EN IEC 63000:2018'] }), { id: 'dc' }),
    doc(testReport({ model, product: 'USB charger', standards: ['EN 62368-1:2014', 'EN 55032:2015', 'EN 55035:2017'], rohs: true }), { id: 'tr', fileName: 'report.txt' }),
  ],
  powerbank: (model) => [
    doc(eudoc({ model, product: 'Power bank', directives: ['2014/30/EU', '2011/65/EU'], standards: ['EN 55032:2015', 'EN 55035:2017', 'EN IEC 63000:2018', 'IEC 62133-2:2017'] }), { id: 'dc' }),
    doc(testReport({ model, product: 'Power bank', standards: ['EN 55032:2015', 'EN 55035:2017', 'IEC 62133-2:2017'], rohs: true }), { id: 'tr' }),
    doc(testReport({ model, product: 'Power bank', standards: ['IEC 62133-2:2017'], no: 'R-2603-0046' }), { id: 'bat', docType: 'BATTERY_DOC' }),
    doc(`UN 38.3 test summary\nManual of Tests and Criteria, Section 38.3 - lithium battery test summary\nModel: ${model}\nManufacturer: ${MFR}\nAll tests passed. Date of issue: 2026-02-20\nTesting laboratory: Pearl Delta Testing Services Ltd\nAccreditation: CNAS L0139`, { id: 'un', docType: 'UN383' }),
  ],
  bluetooth: (model) => [
    doc(eudoc({ model, product: 'Bluetooth speaker', directives: ['2014/53/EU', '2011/65/EU'], standards: ['ETSI EN 300 328', 'ETSI EN 301 489-17', 'EN 62368-1:2014', 'EN IEC 63000:2018'] }), { id: 'dc' }),
    doc(testReport({ model, product: 'Bluetooth speaker', standards: ['ETSI EN 300 328', 'ETSI EN 301 489-17', 'EN 62368-1:2014'], rohs: true }), { id: 'tr' }),
  ],
  toy: (model) => [
    doc(eudoc({ model, product: 'Toy', directives: ['2009/48/EC'], standards: ['EN 71-1:2014', 'EN 71-2:2011', 'EN 71-3:2019'] }), { id: 'dc' }),
    doc(testReport({ model, product: 'Toy', standards: ['EN 71-1:2014', 'EN 71-2:2011', 'EN 71-3:2019'] }), { id: 'tr' }),
  ],
  bottle: (model) => [
    doc(`Declaration of Compliance - food contact materials\nRegulation (EC) 1935/2004 and Regulation (EU) 10/2011\nManufacturer: ${MFR}\nAddress: Building 5, Longhua District, Shenzhen City, China\nProduct name: Drinking bottle\nModel: ${model}\nWe declare that the article complies with the regulations above.\nPlace and date of issue: Shenzhen, 2026-03-01`, { id: 'fcm', docType: 'FCM_DOC' }),
    doc(testReport({ model, product: 'Drinking bottle', standards: ['EN 13130-1:2004', 'EN 1186-1:2002'] }), { id: 'tr' }),
  ],
};
