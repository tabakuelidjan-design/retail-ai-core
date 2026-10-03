// Three realistic FIELD cases, played through the real server API and the real engines (synthetic names, models and documents). Used by the acceptance test and by the
// document generator (docs/sourcing-field-acceptance.md). Each case: photo -> identity -> supplier -> price + MOQ -> documents -> questions -> compliance -> Safety Gate ->
// customs -> Amazon observations -> landed cost -> maximum purchase price -> verdict -> offline reopen.
import PDFDocument from 'pdfkit';
import http from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { newCase, dispatch, assess, recordDecision, safetyFacts } from '../src/sourcing/core/case.js';
import { createMemoryStore } from '../src/sourcing/store/file-store.js';
import { createSourcingApp } from '../src/sourcing/server/app.js';
import { createFakeProvider } from '../src/sourcing/adapters/ai-provider.js';
import { NOW, MFR, eudoc, testReport } from './sourcing-fixtures.js';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'sourcing');
export const TOKEN = 'realistic-cases-token-0123456789ab';

export const pdfOf = (text) => new Promise((resolve) => { const d = new PDFDocument({ margin: 40 }); const chunks = []; d.on('data', (c) => chunks.push(c)); d.on('end', () => resolve(Buffer.concat(chunks))); for (const line of text.split('\n')) d.fontSize(11).text(line); d.end(); });

export async function startField({ alerts = [], aiSuggestions = [], ocrText = '' } = {}) {
  const ai = createFakeProvider({ region: 'EU', describe: { suggestions: aiSuggestions }, label: { text: ocrText } });
  const safety = { get: async () => ({ alerts, source: { mode: 'LIVE_VERIFIED', fetchedAt: NOW.toISOString(), newestPublication: '2026-10-02', coverage: 'synthetic week set' } }), refresh: async () => ({ ok: true }) };
  const app = createSourcingApp({ token: TOKEN, store: createMemoryStore(), safety, ai, ecb: async () => ({ date: '2026-10-02', perEur: { USD: 1.08 } }), uiDir: join(SRC, 'ui'), coreDir: join(SRC, 'core'), now: () => NOW });
  const server = http.createServer(app.handler); await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (path, { method = 'GET', body } = {}) => { const r = await fetch(base + path, { method, headers: { 'content-type': 'application/json', 'x-sourcing-token': TOKEN }, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, body: await r.json().catch(() => null) }; };
  return { call, ai, close: () => new Promise((r) => server.close(r)) };
}
const b64 = (x) => Buffer.from(x).toString('base64');

/** The phone's local copy of the Safety Gate cache, as the UI keeps it. */
async function phoneSafety(f) { const r = await f.call('/api/safety/alerts'); return { alerts: r.body.alerts, source: r.body.source }; }

export const CASES = [
  {
    id: 'case-1', title: 'CASE 1 - simple low-regulatory-risk product: bamboo kitchen organiser',
    async play(f) {
      let c = newCase({ id: 'f1', name: 'Bamboo kitchen organiser', now: NOW });
      const photo = await f.call('/api/ai/describe', { method: 'POST', body: { imageBase64: b64('photo'), imageMime: 'image/jpeg', consent: true } });
      c = dispatch(c, { type: 'PHOTO', ref: 'photo-0' }, NOW);
      if (photo.body.suggestions[0]) c = dispatch(c, { type: 'CATEGORY', category: photo.body.suggestions[0].categoryId, level: 'AI_SUGGESTED' }, NOW);
      c = dispatch(c, { type: 'CATEGORY', category: 'household_general' }, NOW); // the owner confirms
      for (const [n, v] of [['model', 'BK-220'], ['brand', 'Greenline'], ['manufacturer', 'Yiwu Greenline Housewares Co., Ltd']]) c = dispatch(c, { type: 'IDENTIFIER', name: n, value: v, level: 'USER_STATED' }, NOW);
      for (const t of ['electrical.present', 'battery.present', 'radio.present', 'childrenUse', 'foodContact', 'cosmetic', 'ppe', 'textile', 'medical', 'chemicalMixture']) c = dispatch(c, { type: 'TRAIT', trait: t, value: false }, NOW);
      c = dispatch(c, { type: 'SUPPLIER', supplier: { name: 'Yiwu Greenline Housewares', booth: 'Hall 2 / C-114', market: 'Canton Fair' } }, NOW);
      c = dispatch(c, { type: 'PLACING', placing: { underOwnNameOrBrand: false, manufacturerEstablishedInEU: false, euAuthorisedRepresentative: false, substantialModification: false } }, NOW);
      c = dispatch(c, { type: 'QUOTE', quote: { unitPrice: '1.85', currency: 'USD', qty: 1200, moq: 1000, incoterm: 'FOB', leadTimeDays: 25, carton: '60x40x35 cm / 14 kg / 24 units' } }, NOW);
      const fx = await f.call('/api/fx?currency=USD');
      c = dispatch(c, { type: 'COSTS', costs: { fx: fx.body, costs: { freight: { total: 520, status: 'ESTIMATED' }, inboundLogistics: { total: 90, status: 'ESTIMATED' } }, importVat: { ratePct: 21, recoverable: true } } }, NOW);
      c = dispatch(c, { type: 'CUSTOMS', customs: { chosenCode: '4421.99', duty: { ratePct: 0, kind: 'USER_ENTERED', source: 'owner: ask the broker' } } }, NOW);
      c = dispatch(c, { type: 'AMAZON_OBS', observation: { marketplace: 'amazon.be', price: '9.99', asin: 'B0TEST0001', reviews: 340, rating: 4.3, source: 'MANUAL' } }, NOW);
      c = dispatch(c, { type: 'AMAZON_OBS', observation: { marketplace: 'amazon.fr', price: '10.49', reviews: 128, rating: 4.1 } }, NOW);
      c = dispatch(c, { type: 'SALE', sale: { sellingPriceGross: '9.99', vatRatePct: 21, targetContributionPct: 30, priceBasis: 'OBSERVED' } }, NOW);
      return { c, phone: await phoneSafety(f) };
    },
  },
  {
    id: 'case-2', title: 'CASE 2 - power bank 10,000 mAh with partial documents and a similar Safety Gate alert',
    alerts: [{ caseNumber: 'SR/00531/26', category: 'Electrical appliances and equipment', product: 'Power bank', name: 'Portable battery charger', brand: 'Voltix', model: 'VX-10K', riskType: 'Fire', danger: 'The lithium battery can overheat and cause a fire.', countryOfOrigin: 'China', level: 'Serious risk' }],
    async play(f) {
      let c = newCase({ id: 'f2', name: 'Power bank 10000mAh slim', now: NOW });
      c = dispatch(c, { type: 'PHOTO', ref: 'photo-0' }, NOW); c = dispatch(c, { type: 'CATEGORY', category: 'power_bank' }, NOW);
      for (const [n, v] of [['model', 'PB-10S'], ['brand', 'Brightway'], ['manufacturer', MFR]]) c = dispatch(c, { type: 'IDENTIFIER', name: n, value: v, level: 'USER_STATED' }, NOW);
      for (const [t, v] of Object.entries({ 'electrical.present': true, 'battery.present': true, 'radio.present': false, childrenUse: false, foodContact: false, cosmetic: false, ppe: false, textile: false, medical: false, chemicalMixture: false, 'battery.chemistry': 'li_ion', 'electrical.maxVoltageAc': 0, 'electrical.maxVoltageDc': 5, 'electrical.mainsConnected': false })) c = dispatch(c, { type: 'TRAIT', trait: t, value: v }, NOW);
      c = dispatch(c, { type: 'SUPPLIER', supplier: { name: 'Shenzhen Brightway Electronics', booth: 'Hall 11 / A-30', market: 'Canton Fair' } }, NOW);
      c = dispatch(c, { type: 'PLACING', placing: { underOwnNameOrBrand: false, manufacturerEstablishedInEU: false, euAuthorisedRepresentative: false } }, NOW);
      c = dispatch(c, { type: 'QUOTE', quote: { unitPrice: '4.60', currency: 'USD', qty: 800, moq: 500, incoterm: 'FOB', leadTimeDays: 30 } }, NOW);
      const fx = await f.call('/api/fx?currency=USD');
      c = dispatch(c, { type: 'COSTS', costs: { fx: fx.body, costs: { freight: { total: 700, status: 'ESTIMATED' }, testing: { total: 450, status: 'ESTIMATED' } }, importVat: { ratePct: 21, recoverable: true } } }, NOW);
      c = dispatch(c, { type: 'CUSTOMS', customs: { chosenCode: '8507.60', duty: { ratePct: 2.7, kind: 'USER_ENTERED', source: 'owner: ask the broker' } } }, NOW);
      // a native-text PDF Declaration of Conformity through the server; a battery report as typed-from-the-paper (no UN 38.3 yet)
      const dc = await pdfOf(eudoc({ model: 'PB-10S', product: 'Power bank', directives: ['2014/30/EU', '2011/65/EU'], standards: ['EN 55032:2015', 'EN 55035:2017', 'EN IEC 63000:2018'] }));
      const ex = await f.call('/api/documents/extract', { method: 'POST', body: { fileName: 'doc.pdf', mime: 'application/pdf', dataBase64: dc.toString('base64') } });
      c = dispatch(c, { type: 'DOCUMENT', id: 'dc-pdf', fileName: 'doc.pdf', text: ex.body.text, textSource: ex.body.textSource ?? 'NATIVE' }, NOW);
      c = dispatch(c, { type: 'DOCUMENT', id: 'bat-typed', fileName: 'typed from the paper', textSource: 'TRANSCRIBED', docType: 'BATTERY_DOC', text: 'TEST REPORT\nManufacturer: Shenzhen Brightway Electronics Co., Ltd\nModel: PB-10S\nStandards: IEC 62133-2:2017\nTesting laboratory: Pearl Delta Testing Services Ltd\nDate of issue: 2026-02-10' }, NOW);
      for (const [m, p] of [['amazon.be', '24.99'], ['amazon.de', '22.99'], ['amazon.nl', '25.50']]) c = dispatch(c, { type: 'AMAZON_OBS', observation: { marketplace: m, price: p, reviews: 900, rating: 4.2 } }, NOW);
      c = dispatch(c, { type: 'CONTEXT', context: { channels: ['own_site', 'amazon'] } }, NOW);
      c = dispatch(c, { type: 'SALE', sale: { sellingPriceGross: '23.99', vatRatePct: 21, targetContributionPct: 30, priceBasis: 'TARGET' } }, NOW);
      return { c, phone: await phoneSafety(f) };
    },
  },
  {
    id: 'case-3', title: 'CASE 3 - Bluetooth earbuds: photographed Declaration (OCR, confirmed), connectivity unanswered',
    async play(f) {
      let c = newCase({ id: 'f3', name: 'Bluetooth earbuds TWS-5', now: NOW });
      c = dispatch(c, { type: 'PHOTO', ref: 'photo-0' }, NOW); c = dispatch(c, { type: 'CATEGORY', category: 'bluetooth_earbuds' }, NOW);
      for (const [n, v] of [['model', 'TWS-5'], ['brand', 'Soundlet'], ['manufacturer', 'Dongguan Soundlet Audio Technology Co., Ltd']]) c = dispatch(c, { type: 'IDENTIFIER', name: n, value: v, level: 'USER_STATED' }, NOW);
      for (const [t, v] of Object.entries({ 'electrical.present': true, 'battery.present': true, 'radio.present': true, childrenUse: false, foodContact: false, cosmetic: false, ppe: false, textile: false, medical: false, chemicalMixture: false, 'battery.chemistry': 'li_ion', 'electrical.maxVoltageAc': 0, 'electrical.maxVoltageDc': 5, 'electrical.mainsConnected': false })) c = dispatch(c, { type: 'TRAIT', trait: t, value: v }, NOW);
      c = dispatch(c, { type: 'SUPPLIER', supplier: { name: 'Dongguan Soundlet Audio', booth: 'Hall 14 / F-08', market: 'Global Sources' } }, NOW);
      c = dispatch(c, { type: 'PLACING', placing: { underOwnNameOrBrand: true, manufacturerEstablishedInEU: false, euAuthorisedRepresentative: false } }, NOW);
      c = dispatch(c, { type: 'QUOTE', quote: { unitPrice: '5.40', currency: 'USD', qty: 600, moq: 300, incoterm: 'EXW', leadTimeDays: 35 } }, NOW);
      const fx = await f.call('/api/fx?currency=USD');
      c = dispatch(c, { type: 'COSTS', costs: { fx: fx.body, costs: { originCharges: { total: 120, status: 'ESTIMATED' }, freight: { total: 480, status: 'ESTIMATED' }, testing: { total: 900, status: 'ESTIMATED' }, labelling: { total: 150, status: 'ESTIMATED' } }, importVat: { ratePct: 21, recoverable: true } } }, NOW);
      c = dispatch(c, { type: 'CUSTOMS', customs: { chosenCode: '8518.30', duty: { ratePct: 0, kind: 'USER_ENTERED', source: 'owner: ask the broker' } } }, NOW);
      // the photo of the paper Declaration, read by the (fake, EU-hosted) reader after consent, then checked and confirmed by the owner
      const text = eudoc({ model: 'TWS-5', mfr: 'Dongguan Soundlet Audio Technology Co., Ltd', product: 'Bluetooth earbuds', directives: ['2014/53/EU', '2011/65/EU'], standards: ['ETSI EN 300 328', 'ETSI EN 301 489-17', 'EN 62368-1:2014', 'EN IEC 63000:2018'] });
      const ocr = await f.call('/api/documents/extract', { method: 'POST', body: { fileName: 'paper-doc.jpg', mime: 'image/jpeg', dataBase64: b64('photo-bytes'), consent: true } });
      c = dispatch(c, { type: 'DOCUMENT', id: 'dc-photo', fileName: 'paper-doc.jpg', text: ocr.body.text, textSource: ocr.body.textSource, photoRef: 'docphoto-dc' }, NOW);
      c = dispatch(c, { type: 'DOCUMENT_CONFIRM', id: 'dc-photo' }, NOW);
      for (const [m, p] of [['amazon.fr', '17.99'], ['amazon.de', '16.99']]) c = dispatch(c, { type: 'AMAZON_OBS', observation: { marketplace: m, price: p, reviews: 2100, rating: 4.0 } }, NOW);
      c = dispatch(c, { type: 'CONTEXT', context: { channels: ['own_site', 'amazon'] } }, NOW);
      c = dispatch(c, { type: 'SALE', sale: { sellingPriceGross: '17.99', vatRatePct: 21, targetContributionPct: 30, priceBasis: 'OBSERVED' } }, NOW);
      c = dispatch(c, { type: 'SALE_AMAZON', sale: { sellingPriceGross: '17.99', vatRatePct: 21, lines: [{ key: 'referral', kind: 'pct_of_gross', status: 'UNKNOWN' }, { key: 'fulfilment', kind: 'per_unit', status: 'UNKNOWN' }] } }, NOW);
      return { c, phone: await phoneSafety(f), ocrText: text };
    },
  },
];

/** Run one case; returns the live assessment and the assessment after an OFFLINE reopen (JSON round trip, phone cache two days old, no server). */
export async function runCase(def) {
  const text = def.id === 'case-3' ? eudoc({ model: 'TWS-5', mfr: 'Dongguan Soundlet Audio Technology Co., Ltd', product: 'Bluetooth earbuds', directives: ['2014/53/EU', '2011/65/EU'], standards: ['ETSI EN 300 328', 'ETSI EN 301 489-17', 'EN 62368-1:2014', 'EN IEC 63000:2018'] }) : '';
  const f = await startField({ alerts: def.alerts ?? [], aiSuggestions: [{ categoryId: 'household_general', confidence: 'MEDIUM', level: 'AI_SUGGESTED' }], ocrText: text });
  try {
    const { c, phone } = await def.play(f);
    const live = assess(c, { now: NOW, externals: { safety: phone } });
    const saved = recordDecision(c, live, NOW); await f.call(`/api/cases/${saved.id}`, { method: 'PUT', body: saved });
    const back = (await f.call(`/api/cases/${saved.id}`)).body;
    const later = new Date(NOW.getTime() + 2 * 86400000);
    const offline = assess(JSON.parse(JSON.stringify(back)), { now: later, externals: { safety: { alerts: phone.alerts, source: { ...phone.source, mode: 'CACHED' } } } });
    return { live, offline, saved: back };
  } finally { await f.close(); }
}
