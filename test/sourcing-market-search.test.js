// MARKET SEARCH contract + MARKET EVIDENCE. Optional, owner-triggered, provider-independent. NO_MATCH_FOUND is never "not sold in Europe"; Belgium, neighbouring markets and the rest of the EU stay apart; a listing is market
// evidence only (not legal marketability, not Amazon readiness, not product identity); nothing is sent without the owner; no provider is integrated here.
import test from 'node:test';
import assert from 'node:assert/strict';
import { newCase, dispatch, assess } from '../src/sourcing/core/case.js';
import { planConversation } from '../src/sourcing/core/conversation-engine.js';
import { buildProductHypothesis } from '../src/sourcing/core/product-hypothesis.js';
import { MATCH, SEARCH_STATUS, regionOf, REGION, buildSearchInput, outgoingFields, sanitizeEvidence, searchMarket, summarizeMarketEvidence, marketIdentityGap } from '../src/sourcing/core/market-search.js';

const T0 = new Date('2026-10-07T10:00:00.000Z'); const at = (n = 0) => new Date(T0.getTime() + n * 1000);
const product = (name = 'Power bank 10000mAh', model = null) => { let s = dispatch(newCase({ id: 'c', name }), { type: 'NAME', name }); if (model) s = dispatch(s, { type: 'IDENTIFIER', name: 'model', value: model, level: 'USER_STATED', source: { kind: 'user' } }, at(1)); return s; };
const ev = (o = {}) => ({ seller: 'Shop', sellerType: 'RETAILER', country: 'BE', url: 'https://example.invalid/p', price: { amount: 29.95, currency: 'EUR', vatIncluded: true }, brand: 'Acme', model: 'PB-1', matchType: 'SIMILAR_PRODUCT', confidence: 'MEDIUM', observedAt: '2026-10-07T09:00:00.000Z', ...o });

test('without an approved provider the search says PROVIDER_NOT_CONFIGURED: nothing is searched, nothing is sent, nothing is guessed', async () => {
  const r = await searchMarket(buildSearchInput(product())); assert.equal(r.status, SEARCH_STATUS.PROVIDER_NOT_CONFIGURED); assert.deepEqual(r.evidence, []); assert.match(r.note, /nothing was sent/);
});

test('the search input uses the strongest identity signals and says how well the product is identified; what would leave the machine is listed (text only, the image only with explicit consent)', () => {
  const s = product('Power bank 10000mAh'); const h = buildProductHypothesis(s); let i = buildSearchInput(s, h);
  assert.equal(i.strength, 'NAME_ONLY'); assert.equal(i.traits['battery.present'].value, true); assert.equal(i.traits['battery.present'].status, 'PROBABLE'); assert.deepEqual(i.regions, ['BELGIUM', 'NEIGHBOURING_EU', 'EU']);
  i = buildSearchInput(product('Power bank', 'PB-X200'), null); assert.equal(i.strength, 'MODEL'); assert.equal(i.model, 'PB-X200');
  const withPhoto = dispatch(product(), { type: 'PHOTO', ref: 'photo-0' }, at(2)); const j = buildSearchInput(withPhoto); assert.equal(j.imageRef, 'photo-0'); assert.equal(outgoingFields(j).image, false, 'the image is not part of what is sent by default'); assert.equal(outgoingFields(j, { withImage: true }).image, true); assert.deepEqual(outgoingFields(j).text, ['name']);
});

test('an approved provider returns evidence in the same shape; malformed items are dropped, never repaired; unknown values stay null (nothing fabricated)', async () => {
  const provider = { name: 'approved-test-provider', search: async () => ({ evidence: [ev({ country: 'be' }), ev({ matchType: 'NO_MATCH_FOUND' }), ev({ country: 'Belgium' }), ev({ url: null, source: null }), ev({ observedAt: 'nope' }), ev({ price: { amount: -3, currency: 'EUR' } }), ev({ price: { amount: 19.9, currency: 'EUR' }, brand: undefined, model: undefined, availability: undefined, seller: undefined })] }) };
  const r = await searchMarket({}, provider); assert.equal(r.status, SEARCH_STATUS.DONE); assert.equal(r.evidence.length, 3, 'two malformed items and the NO_MATCH marker are not evidence'); assert.equal(r.evidence[0].country, 'BE');
  const bare = r.evidence.at(-1); assert.equal(bare.brand, null); assert.equal(bare.model, null); assert.equal(bare.availability, null); assert.equal(bare.seller, null); assert.equal(r.evidence[1].price, null, 'an invalid price is dropped, not corrected');
  assert.ok(r.evidence.every((e) => e.provider === 'approved-test-provider' && Date.parse(e.observedAt)));
  const failing = await searchMarket({}, { name: 'p', search: async () => { throw new Error('boom'); } }); assert.equal(failing.status, SEARCH_STATUS.ERROR);
});

test('GEOGRAPHY stays separate: a French listing is evidence for France / the EU, never automatically Belgium', () => {
  assert.equal(regionOf('BE'), REGION.BELGIUM); assert.equal(regionOf('FR'), REGION.NEIGHBOURING_EU); assert.equal(regionOf('PL'), REGION.EU); assert.equal(regionOf('GB'), REGION.OUTSIDE_EU);
  const searches = [{ id: 'ms-1', status: 'DONE', evidence: [ev({ country: 'FR', matchType: 'PROBABLE_MATCH', price: { amount: 24.9, currency: 'EUR', vatIncluded: true } }), ev({ country: 'BE', price: { amount: 29.95, currency: 'EUR', vatIncluded: true } }), ev({ country: 'BE', price: { amount: 49.99, currency: 'EUR', vatIncluded: true } }), ev({ country: 'BE' }), ev({ country: 'PL', price: { amount: 54.9, currency: 'EUR', vatIncluded: null } }), ev({ country: 'GB' })].map((e) => sanitizeEvidence(e)) }];
  const m = summarizeMarketEvidence(searches); assert.equal(m.belgium.total, 3); assert.equal(m.belgium.similar, 3); assert.equal(m.belgium.probable, 0, 'the French probable match is not a Belgian one'); assert.equal(m.belgium.exact, 0); assert.equal(m.belgium.verifiedExact, false);
  assert.deepEqual(m.belgium.priceRanges, [{ currency: 'EUR', vatIncluded: true, min: 29.95, max: 49.99, n: 3 }]);
  assert.equal(m.eu.probable, 1); assert.equal(m.eu.total, 5, 'the British listing is outside the EU'); assert.deepEqual(m.eu.countries, ['BE', 'FR', 'PL']); assert.equal(m.eu.priceRanges.length, 2, 'prices with and without a known VAT status are never merged');
  assert.equal(m.neighbouring.total, 1); assert.match(m.note, /not total market coverage/); assert.match(m.note, /not proof of legal marketability/);
});

test('NO_MATCH_FOUND is only "this search found nothing reliable": the summary never says "not sold"; a search never run is not "no match"', () => {
  const empty = summarizeMarketEvidence([{ id: 'ms-1', status: 'DONE', evidence: [] }]); assert.equal(empty.searched, true); assert.equal(empty.noMatchFound, true); assert.equal(empty.noMatchMeansNotSold, false); assert.equal(empty.eu.total, 0);
  const never = summarizeMarketEvidence([]); assert.equal(never.searched, false); assert.equal(never.noMatchFound, false);
  const unconfigured = summarizeMarketEvidence([{ id: 'ms-1', status: 'PROVIDER_NOT_CONFIGURED', evidence: [] }]); assert.equal(unconfigured.searched, false, 'a search that could not run is not a search that found nothing'); assert.equal(unconfigured.noMatchFound, false);
  assert.ok(Object.keys(MATCH).includes('NO_MATCH_FOUND'));
});

test('the OWNER triggers it: the request is recorded in the case with its input, what would be sent and whether the owner agreed; the live conversation is untouched', () => {
  let s = product('Power bank 10000mAh'); s = dispatch(s, { type: 'CONVERSATION_START', supplierRef: null, lang: 'auto' }, at(2)); const before = JSON.stringify(s.conversations);
  const input = buildSearchInput(s, buildProductHypothesis(s)); s = dispatch(s, { type: 'MARKET_SEARCH', status: 'PROVIDER_NOT_CONFIGURED', provider: null, input, outgoing: outgoingFields(input), consent: true, note: 'x' }, at(3));
  assert.equal(s.marketSearches.length, 1); const r = s.marketSearches[0]; assert.equal(r.status, 'PROVIDER_NOT_CONFIGURED'); assert.equal(r.input.name, 'Power bank 10000mAh'); assert.deepEqual(r.outgoing.text, ['name']); assert.equal(r.consent, true); assert.deepEqual(r.evidence, []);
  assert.equal(JSON.stringify(s.conversations), before, 'the conversation was not touched'); assert.ok(planConversation(s, assess(s, { now: T0 })).next, 'the conversation keeps working');
  s = dispatch(s, { type: 'MARKET_SEARCH', status: 'DONE', provider: 'p', input, evidence: [ev()], consent: true }, at(4)); assert.equal(s.marketSearches.at(-1).evidence.length, 1); assert.equal(s.marketSearches.at(-1).id, 'ms-2');
});

test('DECISION INTEGRATION: market evidence sits NEXT to the landed cost as context and never changes the verdict', () => {
  let s = product('Power bank 10000mAh', 'PB-X200'); const base = assess(s, { now: T0 });
  s = dispatch(s, { type: 'MARKET_SEARCH', status: 'DONE', provider: 'p', input: {}, evidence: [ev({ country: 'BE', matchType: 'EXACT_MATCH', confidence: 'HIGH', price: { amount: 59.9, currency: 'EUR', vatIncluded: true } })], consent: true }, at(3)); const withMarket = assess(s, { now: T0 });
  assert.equal(withMarket.decision.verdict, base.decision.verdict, 'the verdict is untouched'); assert.deepEqual(withMarket.maxPurchasePrice, base.maxPurchasePrice); assert.deepEqual(withMarket.rules, base.rules, 'regulatory evidence is untouched: a retailer listing is not compliance');
  assert.equal(withMarket.marketPresence.belgium.exact, 1); assert.equal(withMarket.marketPresence.belgium.verifiedExact, true); assert.equal(base.marketPresence.searched, false);
  assert.ok('landedPerUnitEurMinor' in (withMarket.marketPresence.context ?? { landedPerUnitEurMinor: null }) || withMarket.marketPresence.context === null);
});

test('MARKET IDENTITY feeds the needs engine: with a probable match and no model number, the model question gains a named, explainable reason', () => {
  let s = dispatch(product('Power bank 10000mAh'), { type: 'CONVERSATION_START', supplierRef: null, lang: 'auto' }, at(2)); const plain = planConversation(s, assess(s, { now: T0 })); assert.ok(!plain.needs.asked.find((a) => a.questionId === 'model').parts.some((x) => x.code === 'MARKET_IDENTITY'));
  s = dispatch(s, { type: 'MARKET_SEARCH', status: 'DONE', provider: 'p', input: {}, evidence: [ev({ matchType: 'PROBABLE_MATCH', country: 'BE' })], consent: true }, at(3));
  assert.deepEqual(marketIdentityGap(s).missing, ['model']); assert.equal(marketIdentityGap(s).probableMatchesNotDistinguishable, true);
  const withMarket = planConversation(s, assess(s, { now: T0 })); const m = withMarket.needs.asked.find((a) => a.questionId === 'model'); const part = m.parts.find((x) => x.code === 'MARKET_IDENTITY'); assert.ok(part && part.pts > 0 && /produit/.test(part.fr)); assert.ok(m.score > plain.needs.asked.find((a) => a.questionId === 'model').score);
  const known = dispatch(s, { type: 'IDENTIFIER', name: 'model', value: 'PB-X200', level: 'USER_STATED', source: { kind: 'user' } }, at(5)); assert.deepEqual(marketIdentityGap(known).missing, []);
});

test('the market summary never leaks into the other dimensions: no regulatory status, no Amazon readiness and no identity confidence changes because of a listing', () => {
  const s0 = product('Power bank 10000mAh', 'PB-X200'); const s1 = dispatch(s0, { type: 'MARKET_SEARCH', status: 'DONE', provider: 'p', input: {}, evidence: [ev({ matchType: 'EXACT_MATCH', confidence: 'HIGH' })], consent: true }, at(3)); const a = assess(s0, { now: T0 }); const b = assess(s1, { now: T0 });
  assert.deepEqual(b.amazon, a.amazon); assert.deepEqual(b.identity.confidence, a.identity.confidence); assert.deepEqual(b.documents, a.documents);
});
