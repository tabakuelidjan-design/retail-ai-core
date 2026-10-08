import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import * as lostDemandModule from '../src/marketing/lost-demand.js';
import * as calendarModule from '../src/marketing/calendar-signals.js';
import * as manualModule from '../src/marketing/manual-observation.js';
import * as producerModule from '../src/marketing/signal-producer.js';
import { LOST_DEMAND_KIND, LOST_DEMAND_SIGNAL_TYPE, produceLostDemandSignal } from '../src/marketing/lost-demand.js';
import { CALENDAR_KIND, CALENDAR_SIGNAL_TYPE, produceCalendarSignal } from '../src/marketing/calendar-signals.js';
import { produceManualObservationSignal } from '../src/marketing/manual-observation.js';
import {
  MarketingUnderstandError, assessMateriality, buildMarketingContext, buildMarketingFinding, evaluateFindingReadiness,
  isMarketSignalExpired, marketSignalFreshness, normalizeMarketSignal,
} from '../src/marketing/understand.js';
import {
  approveBrandCore, approveBrandMemory, buildBrandContext, buildBrandCoreProposal, buildBrandIdentity, buildBrandMemoryDraft,
  normalizeBrandSnapshot, submitBrandMemoryForReview,
} from '../src/branding/index.js';

// ------------------------------------------------------------------ fixtures
const M1 = '11111111-1111-4111-8111-111111111111';
const M2 = '22222222-2222-4222-8222-222222222222';
const B1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B2 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const tenant = (merchantId = M1) => ({ merchantId, source: 'env' });
const AS_OF = '2026-10-08T12:00:00Z';

const brandOf = (merchantId, brandId) => buildBrandIdentity({
  tenant: tenant(merchantId), brandId, name: 'Brand', createdAt: '2026-10-01T09:00:00Z', defaultLocale: 'fr-BE', supportedLocales: ['fr-BE'],
});

// A real Core -> Memory -> Context flow, as Branding itself builds it.
function readyBrandContext(merchantId = M1, brandId = B1) {
  const t = tenant(merchantId);
  const brand = brandOf(merchantId, brandId);
  const snapshot = normalizeBrandSnapshot({
    id: 'snapshot-1', merchant_id: merchantId, brand_id: brandId, version: 1, status: 'READY',
    created_at: '2026-10-08T09:00:00Z', observed_at: '2026-10-08T09:00:00Z',
    evidence: [{ id: 'e1', provenance: 'observed', statement: 'Observed', completeness: 'COMPLETE', source: { system: 'internal', observed_at: '2026-10-08T08:00:00Z', kind: 'INTERNAL_FACT' } }],
  });
  const actor = { user_id: 'user-owner-1', role: 'OWNER', merchant_id: merchantId };
  const proposal = buildBrandCoreProposal({
    id: 'core-v1', tenant: t, brand, createdAt: '2026-10-08T10:00:00Z', snapshot,
    decisions: {
      category: 'category', buying_contexts: ['context'], value_proposition: 'Value', positioning: 'Position', core_promise: 'Promise',
      reasons_to_believe: ['Reason'], personality: ['clear'], voice: { traits: ['clear'], do: ['be specific'], dont: ['invent'] },
      exclusions: ['do not mislead'], distinctive_assets: [], evidence_refs: ['e1'],
    },
  }).core;
  const core = approveBrandCore({ proposal, snapshot, tenant: t, brand, resolvedActor: actor, approvedAt: '2026-10-08T10:30:00Z' }).approvedCore;
  const draft = buildBrandMemoryDraft({ tenant: t, brand, id: 'mem-v1', createdAt: '2026-10-08T12:00:00Z', core, content: { hard_rules: [], design_tokens: { colors: { primary: '#112233' } } } }).memory;
  const reviewed = submitBrandMemoryForReview({ memory: draft, core, tenant: t, brand });
  const memory = approveBrandMemory({ memory: reviewed, core, tenant: t, brand, resolvedActor: actor, approvedAt: '2026-10-08T13:00:00Z' }).approvedMemory;
  return buildBrandContext({ tenant: t, brand, core, memory });
}

const provenanceOf = (over = {}) => ({ source_system: 'trusted_adapter', completeness: 'PARTIAL', evidence_kind: 'observed', ...over });
const common = (over = {}) => ({
  subject_refs: ['query://wireless-charger'], source_ref: 'adapter/export-1', evidence_refs: ['ev/1'],
  detected_at: '2026-10-08T10:00:00Z', expires_at: '2026-10-22T10:00:00Z', provenance: provenanceOf(), ...over,
});
const lost = (over = {}, scope = {}) => produceLostDemandSignal({ tenant: tenant(), kind: 'ZERO_RESULT_SEARCH', ...common(), ...over, ...scope });
const WINDOW = { start: '2026-12-20T00:00:00Z', end: '2026-12-27T00:00:00Z' };
const cal = (over = {}, scope = {}) => produceCalendarSignal({ tenant: tenant(), kind: 'LOCAL_EVENT', ...common({ subject_refs: ['event://winter-market'] }), effective_window: WINDOW, ...over, ...scope });
const manualProv = (over = {}) => ({ source_system: 'counter_log', completeness: 'PARTIAL', evidence_kind: 'observed', ...over });
const man = (over = {}, scope = {}) => produceManualObservationSignal({
  tenant: tenant(), observation_type: 'PRODUCT_REQUEST', ...common({ subject_refs: ['category://phone-cases'], provenance: manualProv() }), observed_at: '2026-10-08T09:00:00Z', ...over, ...scope,
});

const code = (fn) => {
  try { fn(); } catch (error) { assert.ok(error instanceof MarketingUnderstandError, `expected MarketingUnderstandError, got ${error}`); return error.code; }
  assert.fail('expected an error');
  return null;
};
const isDeepFrozen = (v) => v == null || typeof v !== 'object' || (Object.isFrozen(v) && Object.values(v).every(isDeepFrozen));
const everyObject = (v, visit) => { if (v && typeof v === 'object') { visit(v); Object.values(v).forEach((x) => everyObject(x, visit)); } };

// ------------------------------------------------------------------ Lost Demand (1-13)

test('Lost Demand: the three V1 kinds map to a stable INTERNAL_MEASUREMENT signal_type', () => {
  assert.deepEqual(Object.keys(LOST_DEMAND_KIND), ['ZERO_RESULT_SEARCH', 'UNAVAILABLE_PRODUCT_INTEREST', 'OUT_OF_STOCK_INTEREST']);
  const expected = {
    ZERO_RESULT_SEARCH: 'LOST_DEMAND_ZERO_RESULT_SEARCH',
    UNAVAILABLE_PRODUCT_INTEREST: 'LOST_DEMAND_UNAVAILABLE_PRODUCT_INTEREST',
    OUT_OF_STOCK_INTEREST: 'LOST_DEMAND_OUT_OF_STOCK_INTEREST',
  };
  assert.deepEqual({ ...LOST_DEMAND_SIGNAL_TYPE }, expected);
  for (const [kind, type] of Object.entries(expected)) {
    const s = lost({ kind });
    assert.equal(s.signal_class, 'INTERNAL_MEASUREMENT', kind);
    assert.equal(s.signal_type, type, kind);
    assert.ok(s.limitations.includes('INTERNAL_MEASUREMENT_IS_NOT_CAUSAL_PROOF'));
  }
  assert.equal(code(() => lost({ kind: 'MANUAL_REQUEST' })), 'MKT_LOST_DEMAND_INVALID_KIND'); // human requests belong to Manual Observation
  assert.equal(code(() => lost({ kind: 'zero_result_search' })), 'MKT_LOST_DEMAND_INVALID_KIND');
  assert.equal(code(() => lost({ kind: undefined })), 'MKT_LOST_DEMAND_INVALID_KIND');
  assert.equal(code(() => lost({ kind: 'toString' })), 'MKT_LOST_DEMAND_INVALID_KIND'); // not an inherited property
});

test('Lost Demand: a subject and an auditable evidence are mandatory', () => {
  assert.equal(code(() => lost({ subject_refs: [] })), 'MKT_LOST_DEMAND_SUBJECT_REQUIRED');
  assert.equal(code(() => lost({ subject_refs: undefined })), 'MKT_LOST_DEMAND_SUBJECT_REQUIRED');
  assert.equal(code(() => lost({ evidence_refs: [] })), 'MKT_LOST_DEMAND_EVIDENCE_REQUIRED');
  assert.equal(code(() => lost({ evidence_refs: undefined })), 'MKT_LOST_DEMAND_EVIDENCE_REQUIRED');
  assert.equal(code(() => lost({ subject_refs: ['has space'] })), 'MKT_INVALID_FIELD'); // shape stays the M1 rule
  assert.deepEqual(lost({ subject_refs: ['query://wireless-charger', 'product://abc', 'category://phone-cases'] }).subject_refs.length, 3);
});

test('Lost Demand: tenant and brand are derived from the resolved context, never from the input', () => {
  assert.equal(lost().merchant_id, M1);
  assert.equal(lost().brand_id, null); // merchant-wide: no brand is invented
  assert.equal(lost({}, { brand: brandOf(M1, B1) }).brand_id, B1);
  for (const key of ['merchant_id', 'brand_id', 'signal_id']) assert.equal(code(() => lost({ [key]: M2 })), 'MKT_UNKNOWN_KEY', key);
  assert.equal(code(() => lost({}, { brand: brandOf(M2, B1) })), 'MKT_SIGNAL_BRAND_MISMATCH');
  assert.equal(code(() => produceLostDemandSignal({ kind: 'ZERO_RESULT_SEARCH', ...common() })), 'MKT_TENANT_INVALID');
  assert.equal(code(() => produceLostDemandSignal({ tenant: { merchantId: M1, source: 'guess' }, kind: 'ZERO_RESULT_SEARCH', ...common() })), 'MKT_TENANT_INVALID');
});

test('Lost Demand: effective_window is optional; invalid timestamps are refused; no action, budget or recommendation can ride along', () => {
  assert.equal(lost().effective_window, null);
  assert.deepEqual(lost({ effective_window: WINDOW }).effective_window, { start: '2026-12-20T00:00:00.000Z', end: '2026-12-27T00:00:00.000Z' });
  for (const bad of ['2026-10-08', '2026-10-08T10:00:00', 'soon', '2026-02-31T10:00:00Z']) {
    assert.equal(code(() => lost({ detected_at: bad })), 'MKT_INVALID_TIMESTAMP', bad);
  }
  assert.equal(code(() => lost({ expires_at: '2026-10-08T10:00:00Z' })), 'MKT_SIGNAL_INVALID_EXPIRY');
  for (const key of ['campaign', 'budget', 'recommendation', 'stock_to_buy', 'expected_revenue', 'score', 'action', 'quantity', 'signal_class', 'signal_type']) {
    assert.equal(code(() => lost({ [key]: 'x' })), 'MKT_UNKNOWN_KEY', key);
  }
});

test('Lost Demand: deterministic id, deep-frozen, never causal, input untouched', () => {
  const input = common({ provenance: provenanceOf({ evidence_kind: 'attributed', filters: { country: 'BE' } }) });
  const before = structuredClone(input);
  const a = produceLostDemandSignal({ tenant: tenant(), kind: 'OUT_OF_STOCK_INTEREST', ...input });
  const b = produceLostDemandSignal({ tenant: tenant(), kind: 'OUT_OF_STOCK_INTEREST', ...input });
  assert.equal(a.signal_id, b.signal_id);
  assert.match(a.signal_id, /^msig_[0-9a-f]{32}$/);
  assert.notEqual(lost({ kind: 'ZERO_RESULT_SEARCH' }).signal_id, lost({ kind: 'OUT_OF_STOCK_INTEREST' }).signal_id);
  assert.ok(isDeepFrozen(a));
  assert.deepEqual(input, before);
  assert.equal(Object.isFrozen(input.provenance), false);
  assert.equal(a.provenance.causal_claim, false);
  assert.ok(a.provenance.limitations.includes('ATTRIBUTION_IS_NOT_CAUSAL_PROOF'));
  assert.equal(code(() => lost({ provenance: provenanceOf({ causal_claim: true }) })), 'MKT_CAUSAL_CLAIM_FORBIDDEN');
  assert.deepEqual(normalizeMarketSignal(JSON.parse(JSON.stringify(a)), { tenant: tenant() }), a); // a canonical MarketSignal, no producer-specific shape
});

// ------------------------------------------------------------------ Calendar / Seasonality (14-23)

test('Calendar: the three kinds map to a stable EXTERNAL_SIGNAL signal_type', () => {
  assert.deepEqual(Object.keys(CALENDAR_KIND), ['LOCAL_EVENT', 'SEASONAL_WINDOW', 'COMMERCIAL_OCCASION']);
  assert.deepEqual({ ...CALENDAR_SIGNAL_TYPE }, { LOCAL_EVENT: 'CALENDAR_LOCAL_EVENT', SEASONAL_WINDOW: 'CALENDAR_SEASONAL_WINDOW', COMMERCIAL_OCCASION: 'CALENDAR_COMMERCIAL_OCCASION' });
  for (const kind of Object.keys(CALENDAR_KIND)) {
    const s = cal({ kind });
    assert.equal(s.signal_class, 'EXTERNAL_SIGNAL', kind); // never a fact about the merchant, never MANUAL_OBSERVATION
    assert.equal(s.signal_type, CALENDAR_SIGNAL_TYPE[kind], kind);
    assert.ok(s.limitations.includes('EXTERNAL_SIGNAL_IS_NOT_A_MERCHANT_FACT'));
  }
  assert.equal(code(() => cal({ kind: 'HOLIDAY' })), 'MKT_CALENDAR_INVALID_KIND');
  assert.equal(code(() => cal({ kind: undefined })), 'MKT_CALENDAR_INVALID_KIND');
});

test('Calendar: effective_window is required, may be in the future, and must end after it starts', () => {
  assert.equal(code(() => cal({ effective_window: undefined })), 'MKT_CALENDAR_EFFECTIVE_WINDOW_REQUIRED');
  assert.equal(code(() => cal({ effective_window: null })), 'MKT_CALENDAR_EFFECTIVE_WINDOW_REQUIRED');
  const future = cal();
  assert.ok(Date.parse(future.effective_window.start) > Date.parse(future.detected_at)); // the phenomenon is still ahead
  assert.deepEqual(future.effective_window, { start: '2026-12-20T00:00:00.000Z', end: '2026-12-27T00:00:00.000Z' });
  assert.equal(code(() => cal({ effective_window: { start: '2026-12-27T00:00:00Z', end: '2026-12-20T00:00:00Z' } })), 'MKT_SIGNAL_INVALID_EFFECTIVE_WINDOW');
  assert.equal(code(() => cal({ effective_window: { start: '2026-12-20T00:00:00Z', end: '2026-12-20T00:00:00Z' } })), 'MKT_SIGNAL_INVALID_EFFECTIVE_WINDOW'); // end <= start
  assert.equal(code(() => cal({ effective_window: { start: '2026-12-20', end: '2026-12-27T00:00:00Z' } })), 'MKT_SIGNAL_INVALID_EFFECTIVE_WINDOW');
});

test('Calendar: subject and evidence mandatory; locale/market propagated; expires_at independent of effective_window', () => {
  assert.equal(code(() => cal({ subject_refs: [] })), 'MKT_CALENDAR_SUBJECT_REQUIRED');
  assert.equal(code(() => cal({ evidence_refs: [] })), 'MKT_CALENDAR_EVIDENCE_REQUIRED');
  const s = cal({ locale: 'nl-be', market: 'BE', observed_at: '2026-10-08T09:00:00Z' });
  assert.deepEqual([s.locale, s.market, s.observed_at], ['nl-BE', 'BE', '2026-10-08T09:00:00.000Z']);
  // the evidence expires (2026-10-22) long before the event (December): freshness follows expires_at only
  assert.equal(marketSignalFreshness(s, '2026-11-15T00:00:00Z'), 'STALE');
  assert.equal(marketSignalFreshness(s, '2026-10-10T00:00:00Z'), 'FRESH');
  assert.equal(isMarketSignalExpired(cal({ expires_at: '2027-01-15T00:00:00Z' }), '2026-12-22T00:00:00Z'), false); // a window in progress is not "expired"
  for (const key of ['text', 'caption', 'recommendation', 'campaign', 'budget', 'holiday_name', 'merchant_id']) {
    assert.equal(code(() => cal({ [key]: 'x' })), 'MKT_UNKNOWN_KEY', key); // no generated marketing text, no recommendation
  }
});

test('Calendar: never causal, deterministic, deep-frozen', () => {
  const s = cal();
  assert.equal(s.provenance.causal_claim, false);
  assert.equal(cal().signal_id, s.signal_id);
  assert.notEqual(cal({ kind: 'SEASONAL_WINDOW' }).signal_id, s.signal_id);
  assert.ok(isDeepFrozen(s));
  assert.equal(code(() => cal({ provenance: provenanceOf({ causal_claim: true }) })), 'MKT_CAUSAL_CLAIM_FORBIDDEN');
});

// ------------------------------------------------------------------ Manual Observation (24-35)

test('Manual Observation: class MANUAL_OBSERVATION, signal_type MANUAL_<TYPE>, non-statistical limitation present', () => {
  for (const type of ['PRODUCT_REQUEST', 'STORE_HESITATION', 'SERVICE_QUESTION']) {
    const s = man({ observation_type: type });
    assert.equal(s.signal_class, 'MANUAL_OBSERVATION', type);
    assert.equal(s.signal_type, `MANUAL_${type}`, type);
    assert.equal(s.limitations[0], 'MANUAL_OBSERVATION_IS_NOT_STATISTICAL_PROOF');
  }
  assert.equal(man({ limitations: ['SMALL_SAMPLE'] }).limitations.length, 2);
  assert.equal(code(() => man({ observation_type: undefined })), 'MKT_MANUAL_OBSERVATION_TYPE_REQUIRED');
  assert.equal(code(() => man({ observation_type: ' ' })), 'MKT_MANUAL_OBSERVATION_TYPE_REQUIRED');
  for (const bad of ['product request', 'product_request', 'MANUAL_PRODUCT_REQUEST', 'X'.repeat(58), 'PRODUCT-REQUEST', 7]) {
    assert.equal(code(() => man({ observation_type: bad })), 'MKT_MANUAL_OBSERVATION_INVALID_TYPE', String(bad));
  }
  assert.equal(man({ observation_type: 'X'.repeat(57) }).signal_type.length, 64); // the longest allowed
});

test('Manual Observation: observed_at is mandatory and cannot be after detected_at; subject and evidence mandatory', () => {
  assert.equal(code(() => man({ observed_at: undefined })), 'MKT_MANUAL_OBSERVATION_OBSERVED_AT_REQUIRED');
  assert.equal(code(() => man({ observed_at: null })), 'MKT_MANUAL_OBSERVATION_OBSERVED_AT_REQUIRED');
  assert.equal(code(() => man({ observed_at: '2026-10-08T10:00:01Z' })), 'MKT_SIGNAL_INVALID_OBSERVED_AT'); // after detected_at
  assert.equal(man({ observed_at: '2026-10-08T10:00:00Z' }).observed_at, '2026-10-08T10:00:00.000Z'); // equal is fine
  assert.equal(code(() => man({ observed_at: 'this morning' })), 'MKT_INVALID_TIMESTAMP');
  assert.equal(code(() => man({ subject_refs: [] })), 'MKT_MANUAL_OBSERVATION_SUBJECT_REQUIRED');
  assert.equal(code(() => man({ evidence_refs: [] })), 'MKT_MANUAL_OBSERVATION_EVIDENCE_REQUIRED');
});

test('Manual Observation privacy: no free text, no profile, no contact detail, no transcript can be stored', () => {
  for (const key of ['customer_name', 'name', 'email', 'phone', 'address', 'note', 'notes', 'comment', 'description', 'transcript', 'conversation', 'full_note', 'customer', 'customer_profile']) {
    assert.equal(code(() => man({ [key]: 'x' })), 'MKT_UNKNOWN_KEY', key);
  }
  // values cannot carry a sentence, an address or a contact either
  assert.equal(code(() => man({ subject_refs: ['someone@example.com'] })), 'MKT_INVALID_FIELD');
  assert.equal(code(() => man({ subject_refs: ['Marie asked twice'] })), 'MKT_INVALID_FIELD');
  assert.equal(code(() => man({ source_ref: 'https://shop.example/?email=a' })), 'MKT_INVALID_FIELD');
  assert.equal(code(() => man({ evidence_refs: ['call me on 0470 12 34 56'] })), 'MKT_INVALID_FIELD');
  assert.equal(code(() => man({ limitations: ['customers kept asking about this all day'] })), 'MKT_INVALID_FIELD'); // codes only, no sentences
  assert.deepEqual(man({ limitations: ['SMALL_SAMPLE', 'SMALL_SAMPLE', 'ONE_DAY_ONLY'] }).limitations.slice(1), ['SMALL_SAMPLE', 'ONE_DAY_ONLY']);
  // provenance carries nothing free-form
  assert.equal(code(() => man({ provenance: manualProv({ source_system: 'Marie at the counter' }) })), 'MKT_INVALID_FIELD');
  for (const extra of [{ filters: { who: 'x' } }, { attribution_model: 'x' }, { source_fields: ['x'] }, { window: WINDOW }, { note: 'x' }]) {
    assert.equal(code(() => man({ provenance: manualProv(extra) })), 'MKT_UNKNOWN_KEY', JSON.stringify(extra));
  }
  assert.equal(code(() => man({ provenance: undefined })), 'MKT_INVALID_FIELD');
  assert.equal(code(() => man({ provenance: manualProv({ limitations: ['one remark about a customer'] }) })), 'MKT_INVALID_FIELD');
});

test('Manual Observation: deterministic, deep-frozen, never causal, scope preserved', () => {
  const a = man();
  assert.equal(man().signal_id, a.signal_id);
  assert.notEqual(man({ observation_type: 'SERVICE_QUESTION' }).signal_id, a.signal_id);
  assert.ok(isDeepFrozen(a));
  assert.equal(a.provenance.causal_claim, false);
  assert.equal(code(() => man({ provenance: manualProv({ causal_claim: true }) })), 'MKT_UNKNOWN_KEY'); // not even expressible
  assert.equal(a.brand_id, null); // merchant-wide stays merchant-wide
  const scoped = man({}, { brand: brandOf(M1, B1) });
  assert.equal(scoped.brand_id, B1); // brand-scoped stays brand-scoped
  assert.notEqual(scoped.signal_id, a.signal_id);
  assert.equal(code(() => man({}, { brand: brandOf(M2, B1) })), 'MKT_SIGNAL_BRAND_MISMATCH');
  assert.equal(code(() => man({ merchant_id: M2 })), 'MKT_UNKNOWN_KEY');
});

// ------------------------------------------------------------------ Integration M1.5 -> M1 (36-46)

const three = () => [lost({ kind: 'OUT_OF_STOCK_INTEREST' }), cal(), man()];
const context = (over = {}) => buildMarketingContext({ tenant: tenant(), asOf: AS_OF, ...over });
const axis = (status, evidence) => ({ status, reason_codes: ['REASON'], evidence_refs: evidence });
const finding = (over = {}, ctx = context()) => buildMarketingFinding({
  tenant: tenant(), context: ctx, finding_type: 'OPPORTUNITY', subject_refs: ['category://phone-cases'], statement: 'Demand that the offer does not serve.',
  window: { start: '2026-10-01T00:00:00Z', end: '2026-10-08T00:00:00Z' }, evidence_refs: ['ev/1'],
  materiality: assessMateriality({ CUSTOMER: axis('MATERIAL', ['ev/1']) }),
  domain_fit: { status: 'MARKETING_RELEVANT', reason_codes: ['FITS'] }, created_at: '2026-10-08T12:00:00Z', expires_at: '2026-10-15T00:00:00Z', ...over,
});

test('M1.5 -> M1: each producer output enters the MarketingContext, alone or mixed, with no change to the M1 core', () => {
  const [l, c, m] = three();
  for (const s of [l, c, m]) assert.equal(context({ marketSignals: [s] }).market_signals.length, 1);
  const mixed = context({ marketSignals: [l, c, m] });
  assert.deepEqual(mixed.market_signals.map((s) => s.signal_class), ['INTERNAL_MEASUREMENT', 'EXTERNAL_SIGNAL', 'MANUAL_OBSERVATION']);
  assert.deepEqual(mixed.signal_freshness.map((x) => x.freshness), ['FRESH', 'FRESH', 'FRESH']);
  assert.ok(isDeepFrozen(mixed));
  assert.equal(code(() => context({ marketSignals: [l, l] })), 'MKT_CONTEXT_DUPLICATE_SIGNAL');
  // the producers add types, never fields: the envelope is exactly the M1 one
  const keys = Object.keys(l);
  for (const s of [c, m]) assert.deepEqual(Object.keys(s), keys);
});

test('M1.5 -> M1: staleness, brand scope and merchant scope are enforced by the unchanged M1 context', () => {
  const stale = lost({ expires_at: '2026-10-08T11:00:00Z' }); // expires before AS_OF
  const ctx = context({ marketSignals: [stale, cal()] });
  assert.deepEqual(ctx.signal_freshness.map((x) => x.freshness), ['STALE', 'FRESH']); // a stale signal stays STALE (and in the context)
  const forB1 = man({}, { brand: brandOf(M1, B1) });
  assert.equal(code(() => context({ marketSignals: [forB1] })), 'MKT_CONTEXT_BRAND_MISMATCH'); // brand signal in a merchant-wide context
  const ready = readyBrandContext();
  assert.equal(context({ brandId: B1, brandContext: ready, marketSignals: [forB1, cal()] }).market_signals.length, 2); // own brand + merchant-wide
  const forB2 = man({ observation_type: 'SERVICE_QUESTION' }, { brand: brandOf(M1, B2) });
  assert.equal(code(() => context({ brandId: B1, brandContext: ready, marketSignals: [forB2] })), 'MKT_CONTEXT_BRAND_MISMATCH');
  const otherMerchant = produceLostDemandSignal({ tenant: tenant(M2), kind: 'ZERO_RESULT_SEARCH', ...common() });
  assert.equal(code(() => context({ marketSignals: [otherMerchant] })), 'MKT_CONTEXT_TENANT_MISMATCH');
});

test('M1.5 -> M1: a Finding can cite a producer signal; the evidence freshness bound and the expired-evidence rule still apply', () => {
  const l = lost({ expires_at: '2026-10-12T00:00:00Z' });
  const m = man({ expires_at: '2026-10-20T00:00:00Z' });
  const ctx = context({ marketSignals: [l, m] });
  const f = finding({ evidence_refs: [l.signal_id, m.signal_id], expires_at: '2026-10-12T00:00:00Z' }, ctx);
  assert.deepEqual(f.evidence_refs, [l.signal_id, m.signal_id]);
  // the producers' caveats travel to the Finding
  assert.ok(f.limitations.includes('INTERNAL_MEASUREMENT_IS_NOT_CAUSAL_PROOF'));
  assert.ok(f.limitations.includes('MANUAL_OBSERVATION_IS_NOT_STATISTICAL_PROOF'));
  // bound: the Finding cannot outlive the earliest supporting signal
  assert.equal(code(() => finding({ evidence_refs: [l.signal_id, m.signal_id], expires_at: '2026-10-12T00:00:01Z' }, ctx)), 'MKT_FINDING_OUTLIVES_EVIDENCE');
  assert.equal(evaluateFindingReadiness(f, '2026-10-09T00:00:00Z').status, 'READY_FOR_BUILD'); // only because the Finding is built, fresh, material, relevant
  assert.equal(evaluateFindingReadiness(f, '2026-10-12T00:00:00Z').status, 'STALE');
});

test('M1.5 -> M1: an expired producer signal is never active proof, but stays citable as contradictory evidence', () => {
  const expired = cal({ expires_at: '2026-10-08T12:00:00Z' }); // expires exactly at created_at
  const ctx = context({ marketSignals: [expired] });
  assert.equal(isMarketSignalExpired(expired, '2026-10-08T12:00:00Z'), true);
  assert.equal(code(() => finding({ evidence_refs: [expired.signal_id] }, ctx)), 'MKT_FINDING_EVIDENCE_SIGNAL_EXPIRED');
  assert.equal(code(() => finding({ materiality: assessMateriality({ CUSTOMER: axis('MATERIAL', [expired.signal_id]) }) }, ctx)), 'MKT_FINDING_EVIDENCE_SIGNAL_EXPIRED');
  const f = finding({ contradictory_evidence_refs: [expired.signal_id] }, ctx);
  assert.deepEqual(f.contradictory_evidence_refs, [expired.signal_id]);
  assert.ok(f.limitations.includes('CITED_SIGNAL_EXPIRED'));
  assert.equal(f.evidence_refs.includes(expired.signal_id), false); // it cannot be what makes the Finding ready
});

test('Producers diagnose nothing: no Finding, no readiness, no action - they only return a MarketSignal', async () => {
  const outputs = three();
  for (const s of outputs) {
    for (const forbidden of ['finding_type', 'materiality', 'domain_fit', 'hypotheses', 'readiness', 'status', 'lever', 'budget', 'campaign', 'recommendation']) {
      assert.equal(forbidden in s, false, forbidden);
    }
    everyObject(s, (o) => assert.notEqual(o.causal_claim, true));
    assert.notEqual(s.provenance.causal_claim, true);
  }
  // nothing in the producer modules can build a Finding, evaluate readiness or act
  const names = [lostDemandModule, calendarModule, manualModule, producerModule].flatMap((m) => Object.keys(m)).join(' ');
  assert.doesNotMatch(names, /finding|readiness|hypothes|materiality|publish|send|buyAds|execute|spend|price|stock/i);
  const dir = new URL('../src/marketing/', import.meta.url);
  for (const name of ['lost-demand', 'calendar-signals', 'manual-observation', 'signal-producer']) {
    const text = await readFile(new URL(`${name}.js`, dir), 'utf8');
    assert.doesNotMatch(text, /from '\.\/(finding|materiality|domain-fit|marketing-context)\.js'/, `${name} must not import the diagnosis layers`);
    assert.doesNotMatch(text, /READY_FOR_BUILD/, name);
  }
});

test('Producers are pure: no implicit clock, randomness, network, database, filesystem, LLM or merchant-specific code', async () => {
  const dir = new URL('../src/marketing/', import.meta.url);
  for (const name of ['lost-demand', 'calendar-signals', 'manual-observation', 'signal-producer']) {
    const text = await readFile(new URL(`${name}.js`, dir), 'utf8');
    const code = text.split('\n').filter((line) => !line.trim().startsWith('//')).join('\n');
    assert.doesNotMatch(code, /Date\.now|new Date\(|Math\.random|randomUUID|process\.env|fetch\(|readFile|writeFile|createClient|XMLHttpRequest|require\(/, name);
    assert.doesNotMatch(code, /from '(node:(fs|http|https|net|child_process)|[^']*(supabase|shopify|sync|connectors)[^']*)'/i, name);
    assert.doesNotMatch(code, /anthropic|openai|gemini|qwen|prompt/i, name);
    assert.doesNotMatch(text, /habb|shopify|namur|belgi/i, name);
  }
  // every producer goes through the canonical constructor, never around it
  for (const name of ['lost-demand', 'calendar-signals', 'manual-observation']) {
    const text = await readFile(new URL(`${name}.js`, dir), 'utf8');
    assert.match(text, /produceMarketSignal/, name);
  }
  assert.match(await readFile(new URL('signal-producer.js', dir), 'utf8'), /import \{ buildMarketSignal \} from '\.\/market-signal\.js'/);
});
