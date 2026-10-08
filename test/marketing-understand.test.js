import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';

import * as understand from '../src/marketing/understand.js';
import * as findingModule from '../src/marketing/finding.js';
import * as signalModule from '../src/marketing/market-signal.js';
import * as contextModule from '../src/marketing/marketing-context.js';
import * as materialityModule from '../src/marketing/materiality.js';
import * as domainFitModule from '../src/marketing/domain-fit.js';
import {
  buildDomainFit, assessMateriality, buildMarketSignal, buildMarketingContext, buildMarketingFinding, evaluateFindingReadiness,
  findingFreshness, isMarketSignalExpired, marketSignalFreshness, normalizeMarketSignal, normalizeMarketingFinding,
  normalizeMaterialityAssessment, MarketingUnderstandError,
} from '../src/marketing/understand.js';
import {
  approveBrandCore, approveBrandMemory, buildBrandContext, buildBrandCoreProposal, buildBrandIdentity, buildBrandMemoryDraft,
  normalizeBrandSnapshot, submitBrandMemoryForReview,
} from '../src/branding/index.js';
import { buildMarketingFacts } from '../src/marketing/build.js';
import { phase3Inputs } from '../src/marketing/phase3-contract.js';
import { normalizeTraffic } from '../src/marketing/traffic.js';
import { normalizeSearch } from '../src/marketing/search.js';
import { NOW, TZ, cleanTrafficRaw, config, ledgerOf, makeMarketingData } from './fixtures/marketing-sample.js';

// ------------------------------------------------------------------ fixtures
const M1 = '11111111-1111-4111-8111-111111111111';
const M2 = '22222222-2222-4222-8222-222222222222';
const B1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B2 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const tenant = (merchantId = M1) => ({ merchantId, source: 'env' });
const AS_OF = '2026-10-08T12:00:00Z';

const brandOf = (merchantId, brandId, status = 'ACTIVE') => buildBrandIdentity({
  tenant: tenant(merchantId), brandId, name: 'Brand', status, createdAt: '2026-10-01T09:00:00Z', defaultLocale: 'fr-BE', supportedLocales: ['fr-BE'],
});

// A real Core -> Memory -> Context flow (the same one Branding uses), parameterized by merchant and brand.
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
  const draft = buildBrandMemoryDraft({
    tenant: t, brand, id: 'mem-v1', createdAt: '2026-10-08T12:00:00Z', core,
    content: { hard_rules: [], design_tokens: { colors: { primary: '#112233' } } },
  }).memory;
  const reviewed = submitBrandMemoryForReview({ memory: draft, core, tenant: t, brand });
  const memory = approveBrandMemory({ memory: reviewed, core, tenant: t, brand, resolvedActor: actor, approvedAt: '2026-10-08T13:00:00Z' }).approvedMemory;
  return buildBrandContext({ tenant: t, brand, core, memory });
}

const provenanceOf = (over = {}) => ({ source_system: 'internal_pos', completeness: 'PARTIAL', evidence_kind: 'observed', ...over });
const signalFields = (over = {}) => ({
  signal_class: 'INTERNAL_MEASUREMENT', signal_type: 'LOST_DEMAND', subject_refs: ['product://widget'], source_ref: 'source/pos-1',
  detected_at: '2026-10-08T10:00:00Z', expires_at: '2026-10-15T10:00:00Z', evidence_refs: ['ev/1'], limitations: ['small sample'],
  provenance: provenanceOf(), ...over,
});
const signal = (over = {}, extra = {}) => buildMarketSignal({ tenant: tenant(), ...signalFields(over), ...extra });

const axis = (status, reasons = ['REASON'], evidence = ['ev/1']) => ({ status, reason_codes: reasons, evidence_refs: evidence });
const material = () => assessMateriality({ ECONOMIC: axis('MATERIAL') });
const fit = (over = {}) => ({ status: 'MARKETING_RELEVANT', reason_codes: ['FITS'], evidence_refs: [], target_domains: [], ...over });

const context = (over = {}) => buildMarketingContext({ tenant: tenant(), asOf: AS_OF, ...over });
const findingFields = (over = {}) => ({
  finding_type: 'PROBLEM', subject_refs: ['product://widget'], statement: 'Visits do not turn into orders.',
  scope: [{ dimension: 'CHANNEL', value: 'organic_search' }], window: { start: '2026-10-01T00:00:00Z', end: '2026-10-08T00:00:00Z' },
  baseline_ref: 'baseline/prev-week', evidence_refs: ['ev/1'], contradictory_evidence_refs: ['ev/9'], limitations: ['one week only'],
  data_gaps: [{ gap_code: 'NO_MARGIN', owner_domain: 'FINANCE', description: 'unit margin not exposed yet' }],
  is: [{ dimension: 'PRODUCT', value: 'widget', evidence_refs: ['ev/1'] }], is_not: [{ dimension: 'PRODUCT', value: 'gadget' }],
  materiality: material(), domain_fit: fit(), created_at: '2026-10-08T12:00:00Z', expires_at: '2026-10-22T12:00:00Z',
  hypotheses: [{ statement: 'Delivery wording may deter buyers.', mechanism: 'unclear delivery time could reduce checkout starts', supporting_evidence_refs: ['ev/1'], contradicting_evidence_refs: ['ev/9'], unknowns: ['no checkout funnel data'], testability: 'TESTABLE_LATER' }],
  ...over,
});
const finding = (over = {}, ctx = context()) => buildMarketingFinding({ tenant: tenant(), context: ctx, ...findingFields(over) });

const code = (fn) => {
  try { fn(); } catch (error) { assert.ok(error instanceof MarketingUnderstandError, `expected MarketingUnderstandError, got ${error}`); return error.code; }
  assert.fail('expected an error');
  return null;
};
const isDeepFrozen = (v) => v == null || typeof v !== 'object' || (Object.isFrozen(v) && Object.values(v).every(isDeepFrozen));
const everyObject = (v, visit) => { if (v && typeof v === 'object') { visit(v); Object.values(v).forEach((x) => everyObject(x, visit)); } };

// ------------------------------------------------------------------ MarketSignal (1-24)

test('MarketSignal: a valid signal is accepted, normalized and given a deterministic id', () => {
  const s = signal({ locale: 'fr-be', market: 'BE', observed_at: '2026-10-08T09:00:00Z' });
  assert.equal(s.merchant_id, M1);
  assert.equal(s.brand_id, null);
  assert.equal(s.locale, 'fr-BE');
  assert.match(s.signal_id, /^msig_[0-9a-f]{32}$/);
  assert.equal(signal({ locale: 'fr-be', market: 'BE', observed_at: '2026-10-08T09:00:00Z' }).signal_id, s.signal_id); // same content, same id
  assert.notEqual(signal({ signal_type: 'SOCIAL_TREND' }).signal_id, s.signal_id);
  assert.deepEqual(normalizeMarketSignal(JSON.parse(JSON.stringify(s)), { tenant: tenant() }), s); // re-validating stored data is stable
});

test('MarketSignal: closed schema - unknown key, unknown class, empty/invalid type, missing source are all refused', () => {
  assert.equal(code(() => signal({}, { campaign: 'x' })), 'MKT_UNKNOWN_KEY');
  assert.equal(code(() => signal({}, { causal_claim: true })), 'MKT_UNKNOWN_KEY');
  assert.equal(code(() => signal({ signal_class: 'RUMOUR' })), 'MKT_SIGNAL_INVALID_CLASS');
  assert.equal(code(() => signal({ signal_type: '' })), 'MKT_SIGNAL_INVALID_TYPE');
  assert.equal(code(() => signal({ signal_type: 'social trend' })), 'MKT_SIGNAL_INVALID_TYPE');
  assert.equal(code(() => signal({ signal_type: 'social_trend' })), 'MKT_SIGNAL_INVALID_TYPE');
  assert.equal(code(() => signal({ source_ref: undefined })), 'MKT_SIGNAL_SOURCE_REQUIRED');
  assert.equal(code(() => signal({ source_ref: '  ' })), 'MKT_SIGNAL_SOURCE_REQUIRED');
});

test('MarketSignal: tenant and brand scope - merchant_id/brand_id are derived, never trusted from the caller', () => {
  assert.equal(code(() => signal({}, { merchant_id: M2 })), 'MKT_UNKNOWN_KEY'); // not even accepted as input to build
  assert.equal(code(() => signal({}, { brand_id: B1 })), 'MKT_UNKNOWN_KEY');
  const own = signal();
  assert.equal(code(() => normalizeMarketSignal({ ...own, merchant_id: M2 }, { tenant: tenant() })), 'MKT_SIGNAL_TENANT_MISMATCH');
  assert.equal(code(() => buildMarketSignal({ tenant: { merchantId: M1, source: 'guess' }, ...signalFields() })), 'MKT_TENANT_INVALID');
  assert.equal(code(() => buildMarketSignal({ ...signalFields() })), 'MKT_TENANT_INVALID');
  // a brand resolved for ANOTHER merchant is refused
  assert.equal(code(() => buildMarketSignal({ tenant: tenant(), brand: brandOf(M2, B1), ...signalFields() })), 'MKT_SIGNAL_BRAND_MISMATCH');
  assert.equal(code(() => buildMarketSignal({ tenant: tenant(), brand: brandOf(M1, B1, 'INACTIVE'), ...signalFields() })), 'MKT_BRAND_INACTIVE');
  assert.equal(code(() => buildMarketSignal({ tenant: tenant(), brand: { brand_id: B1 }, ...signalFields() })), 'MKT_BRAND_IDENTITY_INVALID');
  // brand_id on a stored signal must be the resolved brand
  const branded = buildMarketSignal({ tenant: tenant(), brand: brandOf(M1, B1), ...signalFields() });
  assert.equal(branded.brand_id, B1);
  assert.equal(code(() => normalizeMarketSignal(branded, { tenant: tenant(), brand: brandOf(M1, B2) })), 'MKT_SIGNAL_BRAND_MISMATCH');
  assert.equal(signal().brand_id, null); // no brand_id is ever invented
});

test('MarketSignal: subject/evidence refs are opaque tokens; duplicates collapse; limitations are kept and deduplicated', () => {
  for (const bad of ['has space', 'someone@example.com', 'https://x/?gclid=1', '', ' ']) {
    assert.equal(code(() => signal({ subject_refs: [bad] })), 'MKT_INVALID_FIELD', bad);
  }
  assert.equal(code(() => signal({ subject_refs: 'product://widget' })), 'MKT_INVALID_FIELD');
  const s = signal({ evidence_refs: ['ev/1', 'ev/1', 'ev/2'], limitations: ['small sample', 'small sample'], subject_refs: ['segment://vip', 'topic:ramadan-2026'] });
  assert.deepEqual(s.evidence_refs, ['ev/1', 'ev/2']);
  assert.deepEqual(s.subject_refs, ['segment://vip', 'topic:ramadan-2026']); // opaque refs accepted as-is, never expanded
  assert.deepEqual(s.limitations, ['INTERNAL_MEASUREMENT_IS_NOT_CAUSAL_PROOF', 'small sample']);
});

test('MarketSignal: timestamps need an explicit offset and a real date; expiry and observation order are enforced', () => {
  for (const bad of ['2026-10-08', '2026-10-08T10:00:00', 'yesterday', '2026-02-31T10:00:00Z', '2026-10-08T25:00:00Z', 20261008]) {
    assert.equal(code(() => signal({ detected_at: bad })), 'MKT_INVALID_TIMESTAMP', String(bad));
  }
  assert.equal(code(() => signal({ expires_at: '2026-10-08T10:00:00Z' })), 'MKT_SIGNAL_INVALID_EXPIRY'); // equal
  assert.equal(code(() => signal({ expires_at: '2026-10-01T10:00:00Z' })), 'MKT_SIGNAL_INVALID_EXPIRY'); // before
  assert.equal(code(() => signal({ observed_at: '2026-10-08T10:00:01Z' })), 'MKT_SIGNAL_INVALID_OBSERVED_AT');
  assert.equal(signal({ observed_at: '2026-10-08T10:00:00Z' }).observed_at, '2026-10-08T10:00:00.000Z'); // observed == detected is fine
  assert.equal(signal({ detected_at: '2026-10-08T12:00:00+02:00' }).detected_at, '2026-10-08T10:00:00.000Z'); // offsets normalize to UTC
});

test('MarketSignal freshness: pure helpers with an explicit clock - expired signals stay auditable and are never fresh', () => {
  const s = signal();
  assert.equal(isMarketSignalExpired(s, '2026-10-09T00:00:00Z'), false);
  assert.equal(marketSignalFreshness(s, '2026-10-09T00:00:00Z'), 'FRESH');
  assert.equal(marketSignalFreshness(s, '2026-10-15T10:00:00Z'), 'STALE'); // at expiry
  assert.equal(isMarketSignalExpired(s, new Date('2026-10-20T00:00:00Z')), true);
  assert.equal(code(() => isMarketSignalExpired(s)), 'MKT_INVALID_TIMESTAMP'); // no implicit clock
  assert.equal(s.signal_id.startsWith('msig_'), true); // the expired signal is still a complete, readable object
});

test('MarketSignal never becomes causal, whatever its class or evidence kind', () => {
  for (const [signal_class, evidence_kind] of [['INTERNAL_MEASUREMENT', 'attributed'], ['EXTERNAL_SIGNAL', 'inferred'], ['MANUAL_OBSERVATION', 'observed']]) {
    const s = signal({ signal_class, provenance: provenanceOf({ evidence_kind }) });
    assert.equal(s.provenance.causal_claim, false);
    assert.ok(s.limitations[0].endsWith('_NOT_CAUSAL_PROOF') || s.limitations[0].endsWith('_NOT_A_MERCHANT_FACT') || s.limitations[0].endsWith('_NOT_STATISTICAL_PROOF'));
  }
  assert.ok(signal({ provenance: provenanceOf({ evidence_kind: 'attributed' }) }).provenance.limitations.includes('ATTRIBUTION_IS_NOT_CAUSAL_PROOF'));
  assert.ok(signal({ provenance: provenanceOf({ evidence_kind: 'inferred' }) }).provenance.limitations.includes('ATTRIBUTION_IS_NOT_CAUSAL_PROOF'));
  assert.equal(code(() => signal({ provenance: provenanceOf({ causal_claim: true }) })), 'MKT_CAUSAL_CLAIM_FORBIDDEN');
  assert.equal(signal({ provenance: provenanceOf({ causal_claim: false }) }).provenance.causal_claim, false);
  assert.equal(code(() => signal({ provenance: provenanceOf({ evidence_kind: 'proven' }) })), 'MKT_INVALID_FIELD');
  assert.equal(code(() => signal({ provenance: provenanceOf({ verdict: 'x' }) })), 'MKT_UNKNOWN_KEY');
  assert.deepEqual(signal({ signal_class: 'EXTERNAL_SIGNAL' }).limitations[0], 'EXTERNAL_SIGNAL_IS_NOT_A_MERCHANT_FACT');
  assert.deepEqual(signal({ signal_class: 'MANUAL_OBSERVATION' }).limitations[0], 'MANUAL_OBSERVATION_IS_NOT_STATISTICAL_PROOF');
});

test('MarketSignal: deep-frozen output, caller input never mutated or frozen', () => {
  const fields = signalFields({ subject_refs: ['product://widget'], provenance: provenanceOf({ filters: { country: 'BE' }, window: { start: '2026-10-01T00:00:00Z', end: '2026-10-08T00:00:00Z' } }) });
  const before = structuredClone(fields);
  const s = buildMarketSignal({ tenant: tenant(), ...fields });
  assert.ok(isDeepFrozen(s));
  assert.deepEqual(fields, before);
  assert.equal(Object.isFrozen(fields.provenance), false);
  assert.equal(Object.isFrozen(fields.provenance.filters), false);
  assert.throws(() => { s.merchant_id = M2; }, TypeError);
});

test('MarketSignal privacy: closed schema, no customer profile or contact field can be stored', () => {
  for (const key of ['email', 'phone', 'customer_name', 'customer', 'customer_profile', 'notes']) {
    assert.equal(code(() => signal({ signal_class: 'MANUAL_OBSERVATION' }, { [key]: 'x' })), 'MKT_UNKNOWN_KEY', key);
  }
  assert.equal(code(() => signal({ provenance: provenanceOf({ customer_email: 'someone@example.com' }) })), 'MKT_UNKNOWN_KEY');
  assert.equal(code(() => signal({ provenance: provenanceOf({ filters: { query: { email: 'someone@example.com' } } }) })), 'MKT_INVALID_FIELD'); // filters stay flat primitives
  assert.equal(code(() => signal({ subject_refs: ['ceo@example.com'] })), 'MKT_INVALID_FIELD');
});

// ------------------------------------------------------------------ MarketingContext (25-35)

const facts = ({ open = false, merchantId = M1 } = {}) => {
  const data = makeMarketingData();
  const cfg = config();
  const traffic = open ? normalizeTraffic(cleanTrafficRaw()) : null;
  return buildMarketingFacts({ ledger: ledgerOf(data, cfg), data, traffic, ads: null, search: null, now: NOW, timeZone: TZ, config: cfg, merchantId });
};

test('MarketingContext: needs the canonical tenant and an explicit clock', () => {
  assert.equal(code(() => buildMarketingContext({ asOf: AS_OF })), 'MKT_TENANT_INVALID');
  assert.equal(code(() => buildMarketingContext({ tenant: { merchantId: M1 }, asOf: AS_OF })), 'MKT_TENANT_INVALID');
  assert.equal(code(() => buildMarketingContext({ tenant: tenant() })), 'MKT_INVALID_TIMESTAMP');
  const ctx = context();
  assert.deepEqual([ctx.merchant_id, ctx.brand_id, ctx.brand, ctx.as_of], [M1, null, null, '2026-10-08T12:00:00.000Z']); // merchant-wide: no brand
  assert.deepEqual(Object.keys(ctx.context_inputs), ['SALES', 'INVENTORY', 'FINANCE', 'OPERATIONAL_CAPACITY']);
  assert.equal('domain_inputs' in ctx, false);
});

test('MarketingContext: a brand-scoped context needs a READY Brand Context of that exact brand and merchant', () => {
  const ready = readyBrandContext();
  const ctx = context({ brandId: B1, brandContext: ready });
  assert.equal(ctx.brand_id, B1);
  assert.deepEqual(ctx.brand.core_ref, { id: 'core-v1', version: 1 });
  assert.equal(JSON.stringify(ctx).includes('hard_rules'), false); // the brand context is referenced, not copied
  const gated = buildBrandContext({ tenant: tenant(), brand: brandOf(M1, B1), core: null, memory: null });
  assert.equal(gated.status, 'GATED');
  assert.equal(code(() => context({ brandId: B1, brandContext: gated })), 'MKT_CONTEXT_BRAND_NOT_READY');
  assert.equal(code(() => context({ brandId: B1 })), 'MKT_CONTEXT_BRAND_NOT_READY');
  assert.equal(code(() => context({ brandId: B2, brandContext: ready })), 'MKT_CONTEXT_BRAND_MISMATCH');
  assert.equal(code(() => context({ brandId: B1, brandContext: readyBrandContext(M2, B1) })), 'MKT_CONTEXT_TENANT_MISMATCH');
  assert.equal(code(() => context({ brandContext: ready })), 'MKT_CONTEXT_BRAND_MISMATCH'); // brand_id is never inferred from the context
});

test('MarketingContext: signals of another merchant, or scoped to another brand, are refused; merchant-wide signals pass', () => {
  const other = buildMarketSignal({ tenant: tenant(M2), ...signalFields() });
  assert.equal(code(() => context({ marketSignals: [other] })), 'MKT_CONTEXT_TENANT_MISMATCH');
  const wide = signal();
  const forB1 = buildMarketSignal({ tenant: tenant(), brand: brandOf(M1, B1), ...signalFields({ signal_type: 'SEARCH_DEMAND' }) });
  const forB2 = buildMarketSignal({ tenant: tenant(), brand: brandOf(M1, B2), ...signalFields({ signal_type: 'REPUTATION' }) });
  const ready1 = readyBrandContext(M1, B1);
  assert.equal(context({ brandId: B1, brandContext: ready1, marketSignals: [wide, forB1] }).market_signals.length, 2); // wide + own brand
  assert.equal(code(() => context({ brandId: B1, brandContext: ready1, marketSignals: [forB2] })), 'MKT_CONTEXT_BRAND_MISMATCH'); // another brand's signal
  assert.equal(code(() => context({ marketSignals: [forB1] })), 'MKT_CONTEXT_BRAND_MISMATCH'); // brand signal in a merchant-wide context
  assert.equal(code(() => context({ marketSignals: [wide, wide] })), 'MKT_CONTEXT_DUPLICATE_SIGNAL');
  // two brands of one merchant keep distinct signals
  assert.notEqual(forB1.signal_id, forB2.signal_id);
  assert.deepEqual([forB1.brand_id, forB2.brand_id], [B1, B2]);
});

test('MarketingContext: expired signals stay in the context, labelled STALE (never silently fresh)', () => {
  const fresh = signal({ signal_type: 'SEARCH_DEMAND' });
  const stale = signal({ detected_at: '2026-09-01T10:00:00Z', expires_at: '2026-09-08T10:00:00Z' });
  const ctx = context({ marketSignals: [fresh, stale] });
  assert.equal(ctx.market_signals.length, 2);
  assert.deepEqual(ctx.signal_freshness.map((x) => x.freshness), ['FRESH', 'STALE']);
});

test('MarketingContext reuses phase3Inputs unchanged: a GATED conversion stays GATED, an OPEN one is consumed without recomputation', () => {
  const gatedFacts = facts();
  const gated = context({ measurementFacts: gatedFacts }).measurement;
  assert.equal(gated.conversion.status, 'GATED');
  assert.equal(gated.conversion.traffic, null); // no traffic number ever appears behind a closed gate
  assert.deepEqual(gated, phase3Inputs(gatedFacts));
  const openFacts = facts({ open: true });
  const open = context({ measurementFacts: openFacts }).measurement;
  assert.equal(open.conversion.status, 'OPEN');
  assert.deepEqual(open.conversion.traffic, openFacts.traffic); // same numbers, no recalculation
  assert.equal(open.causal_claims, false);
  assert.notEqual(open.conversion.traffic, openFacts.traffic); // a copy, not an alias of the caller's facts
  assert.equal(context().measurement, null);
});

test('MarketingContext: measurement of another merchant is refused; search facts stay observations', () => {
  assert.equal(code(() => context({ measurementFacts: facts({ merchantId: M2 }) })), 'MKT_CONTEXT_TENANT_MISMATCH');
  const data = makeMarketingData();
  const cfg = config({ brandRules: [] });
  const search = normalizeSearch({
    source_system: 'search_console', method: 'manual_export', window: { start: '2026-08-01', end: '2026-09-01' }, filters: { search_type: 'web', country: null, device: null },
    reported_totals: { clicks: 10, impressions: 500 }, query_rows: [{ query: 'phone case', impressions: 400, clicks: 2, position: 12 }], page_rows: [],
  });
  const f = buildMarketingFacts({ ledger: ledgerOf(data, cfg), data, traffic: null, ads: null, search, now: NOW, timeZone: TZ, config: cfg, merchantId: M1 });
  assert.equal(context({ measurementFacts: f }).measurement.search.not_a_conversion_input, true);
  assert.equal(code(() => context({ measurementFacts: 'facts' })), 'MKT_INVALID_FIELD');
});

test('MarketingContext: owner-computed context facts are typed and sourced; nothing is recalculated; customers are refs only', () => {
  const ctx = context({
    contextInputs: { INVENTORY: { refs: ['inventory://snapshot-1'], facts: [{ fact_key: 'available_units', subject_ref: 'product://widget', value: 12, unit: 'unit', source_ref: 'inventory/snap-1', observed_at: '2026-10-08T08:00:00Z' }] } },
    customerSegmentRefs: ['segment://vip'], productRefs: ['product://widget'], offerRefs: ['offer://spring'], calendarRefs: ['calendar://eid-2026'],
  });
  assert.equal(ctx.context_inputs.INVENTORY.facts[0].value, 12);
  assert.deepEqual(ctx.customer_segment_refs, ['segment://vip']);
  const f = (over) => ({ fact_key: 'unit_margin', value: 0.3, source_ref: 'finance/m', observed_at: '2026-10-08T08:00:00Z', ...over });
  assert.equal(code(() => context({ contextInputs: { FINANCE: { facts: [f({ source_ref: undefined })] } } })), 'MKT_INVALID_FIELD'); // no source, no fact
  assert.equal(code(() => context({ contextInputs: { FINANCE: { facts: [f({ value: Number.NaN })] } } })), 'MKT_INVALID_FIELD');
  assert.equal(code(() => context({ contextInputs: { FINANCE: { facts: [f({ value: { margin: 1 } })] } } })), 'MKT_INVALID_FIELD');
  assert.equal(code(() => context({ contextInputs: { FINANCE: { facts: [f(), f()] } } })), 'MKT_DUPLICATE_ENTRY');
  assert.equal(code(() => context({ contextInputs: { CUSTOMERS: { facts: [] } } })), 'MKT_UNKNOWN_KEY'); // no customer profile data in the context
  // input categories are not domains: the old domain-looking names are refused, and OPERATIONAL_CAPACITY is not a REFER target
  for (const old of ['SALES_PRODUCT', 'OPERATIONS']) assert.equal(code(() => context({ contextInputs: { [old]: { refs: ['x/1'] } } })), 'MKT_UNKNOWN_KEY', old);
  assert.deepEqual(context({ domainInputs: { SALES: { refs: ['x/1'] } } }).context_inputs.SALES.refs, []); // the old option name is no longer honoured
  assert.equal(code(() => buildDomainFit(fit({ status: 'REFER_TO_DOMAIN', target_domains: ['OPERATIONAL_CAPACITY'], evidence_refs: ['ev/1'] }))), 'MKT_DOMAIN_FIT_UNKNOWN_TARGET');
  assert.equal(context({ contextInputs: { OPERATIONAL_CAPACITY: { facts: [{ fact_key: 'capacity_window', value: 'weeks_2', source_ref: 'ops/cap-1', observed_at: '2026-10-08T08:00:00Z' }] } } }).context_inputs.OPERATIONAL_CAPACITY.facts[0].fact_key, 'capacity_window');
  assert.equal(code(() => context({ contextInputs: { FINANCE: { facts: [f({ email: 'x' })] } } })), 'MKT_UNKNOWN_KEY');
});

test('MarketingContext: deep-frozen output; caller inputs never mutated', () => {
  const s = signal();
  const f = facts({ open: true });
  const inputs = { measurementFacts: f, marketSignals: [s], contextInputs: { SALES: { refs: ['sales://w'] } }, productRefs: ['product://widget'] };
  const before = structuredClone({ ...inputs, marketSignals: [] });
  const ctx = context(inputs);
  assert.ok(isDeepFrozen(ctx));
  assert.deepEqual(structuredClone({ ...inputs, marketSignals: [] }), before);
  assert.equal(Object.isFrozen(f.traffic), false); // the caller's facts were not frozen through the context
  assert.equal(Object.isFrozen(inputs.contextInputs.SALES), false);
});

// ------------------------------------------------------------------ Materiality (36-46)

test('Materiality: closed axes and statuses', () => {
  assert.equal(code(() => assessMateriality({ SENTIMENT: axis('MATERIAL') })), 'MKT_MATERIALITY_INVALID_AXIS');
  assert.equal(code(() => assessMateriality({ ECONOMIC: axis('HUGE') })), 'MKT_MATERIALITY_INVALID_STATUS');
  assert.equal(code(() => assessMateriality({ ECONOMIC: { ...axis('MATERIAL'), score: 9 } })), 'MKT_UNKNOWN_KEY');
  assert.equal(code(() => assessMateriality({ ECONOMIC: axis('UNKNOWN', []) })), 'MKT_MATERIALITY_REASON_REQUIRED');
  assert.equal(code(() => assessMateriality({ ECONOMIC: axis('MATERIAL', ['R'], []) })), 'MKT_MATERIALITY_EVIDENCE_REQUIRED');
  assert.equal(code(() => assessMateriality({ ECONOMIC: axis('NOT_MATERIAL', ['R'], []) })), 'MKT_MATERIALITY_EVIDENCE_REQUIRED');
  assert.equal(code(() => assessMateriality({ ECONOMIC: axis('MATERIAL', ['not a token']) })), 'MKT_INVALID_FIELD');
});

test('Materiality aggregation is deterministic and visible - no score, no weights, no hard-coded threshold', () => {
  const a = assessMateriality({ ECONOMIC: axis('MATERIAL'), RISK: axis('NOT_MATERIAL'), CUSTOMER: axis('MATERIAL', ['A'], ['ev/2']) });
  assert.equal(a.overall, 'MATERIAL'); // two MATERIAL axes: still just MATERIAL, not "more material"
  assert.deepEqual(a.deciding_axes, ['ECONOMIC', 'CUSTOMER']);
  assert.equal(assessMateriality({ ECONOMIC: axis('MATERIAL') }).overall, 'MATERIAL');

  const u = assessMateriality({ ECONOMIC: axis('NOT_MATERIAL'), CUSTOMER: axis('UNKNOWN'), STRATEGIC: axis('NOT_APPLICABLE'), RISK: axis('NOT_APPLICABLE'), OPERATIONAL: axis('NOT_APPLICABLE') });
  assert.deepEqual([u.overall, u.deciding_axes], ['UNKNOWN', ['CUSTOMER']]);

  const allNot = { ECONOMIC: axis('NOT_MATERIAL'), CUSTOMER: axis('NOT_MATERIAL'), STRATEGIC: axis('NOT_APPLICABLE'), RISK: axis('NOT_MATERIAL'), OPERATIONAL: axis('NOT_APPLICABLE') };
  const n = assessMateriality(allNot);
  assert.deepEqual([n.overall, n.deciding_axes], ['NOT_MATERIAL', ['ECONOMIC', 'CUSTOMER', 'RISK']]); // NOT_APPLICABLE does not vote

  const na = assessMateriality(Object.fromEntries(['ECONOMIC', 'CUSTOMER', 'STRATEGIC', 'RISK', 'OPERATIONAL'].map((k) => [k, axis('NOT_APPLICABLE')])));
  assert.equal(na.overall, 'UNKNOWN'); // nothing applicable -> we cannot call it NOT_MATERIAL

  // an axis nobody assessed is UNKNOWN, never silently NOT_MATERIAL
  const partial = assessMateriality({ ECONOMIC: axis('NOT_MATERIAL') });
  assert.equal(partial.overall, 'UNKNOWN');
  assert.deepEqual(partial.axes.RISK, { status: 'UNKNOWN', reason_codes: ['AXIS_NOT_ASSESSED'], evidence_refs: [] });
  assert.equal(assessMateriality().overall, 'UNKNOWN');

  // reasons and evidence are preserved per axis
  assert.deepEqual(a.axes.CUSTOMER, { status: 'MATERIAL', reason_codes: ['A'], evidence_refs: ['ev/2'] });
  // no numeric/global score anywhere
  everyObject(a, (o) => { assert.ok(!('score' in o) && !('weight' in o) && !('threshold' in o)); Object.values(o).forEach((v) => assert.notEqual(typeof v, 'number')); });
  assert.ok(isDeepFrozen(a));
});

test('Materiality has no hard-coded business threshold: no currency, no numeric comparison in its source', async () => {
  const text = await readFile(new URL('../src/marketing/materiality.js', import.meta.url), 'utf8');
  const source = text.split('\n').filter((line) => !line.trim().startsWith('//')).join('\n');
  assert.doesNotMatch(source, /€|\bEUR\b|\bUSD\b/);
  assert.doesNotMatch(source, /[<>]=?\s*\d|\d\s*[<>]=?/); // no `x < 100`, no `500 > y`
  assert.doesNotMatch(source, /\bthreshold\b|\bscore\b|\bweight/i);
});

test('Materiality: a forged overall that disagrees with its own axes is refused when re-validated', () => {
  const ok = material();
  assert.deepEqual(normalizeMaterialityAssessment(JSON.parse(JSON.stringify(ok))), ok);
  assert.equal(code(() => normalizeMaterialityAssessment({ ...JSON.parse(JSON.stringify(ok)), overall: 'NOT_MATERIAL' })), 'MKT_MATERIALITY_OVERALL_MISMATCH');
  assert.equal(code(() => normalizeMaterialityAssessment({ ...JSON.parse(JSON.stringify(ok)), score: 90 })), 'MKT_UNKNOWN_KEY');
});

// ------------------------------------------------------------------ Domain Fit (47-54)

test('Domain Fit: the four outcomes; REFER_TO_DOMAIN needs targets, reasons and evidence', () => {
  assert.equal(buildDomainFit(fit()).status, 'MARKETING_RELEVANT');
  assert.equal(buildDomainFit(fit({ status: 'NO_MATERIAL_SIGNAL' })).status, 'NO_MATERIAL_SIGNAL');
  assert.equal(buildDomainFit(fit({ status: 'NOT_MEASURABLE' })).status, 'NOT_MEASURABLE');
  const refer = buildDomainFit(fit({ status: 'REFER_TO_DOMAIN', target_domains: ['INVENTORY', 'FINANCE'], evidence_refs: ['ev/1'], reason_codes: ['STOCK_LOW'] }));
  assert.deepEqual([refer.target_domains, refer.reason_codes, refer.evidence_refs], [['INVENTORY', 'FINANCE'], ['STOCK_LOW'], ['ev/1']]);
  assert.equal(code(() => buildDomainFit(fit({ status: 'REFER_TO_DOMAIN', evidence_refs: ['ev/1'] }))), 'MKT_DOMAIN_FIT_TARGET_REQUIRED');
  assert.equal(code(() => buildDomainFit(fit({ status: 'REFER_TO_DOMAIN', target_domains: ['INVENTORY'] }))), 'MKT_DOMAIN_FIT_EVIDENCE_REQUIRED');
  assert.equal(code(() => buildDomainFit(fit({ status: 'REFER_TO_DOMAIN', target_domains: ['MARKETING'], evidence_refs: ['ev/1'] }))), 'MKT_DOMAIN_FIT_UNKNOWN_TARGET');
  assert.equal(code(() => buildDomainFit(fit({ target_domains: ['INVENTORY'] }))), 'MKT_DOMAIN_FIT_TARGET_NOT_ALLOWED');
  assert.equal(code(() => buildDomainFit(fit({ status: 'LATER' }))), 'MKT_DOMAIN_FIT_INVALID_STATUS');
  assert.equal(code(() => buildDomainFit(fit({ reason_codes: [] }))), 'MKT_DOMAIN_FIT_REASON_REQUIRED');
  assert.deepEqual(buildDomainFit(fit({ status: 'NOT_MEASURABLE', reason_codes: ['A', 'A', 'B'] })).reason_codes, ['A', 'B']);
});

test('Domain Fit carries a diagnosis only - no execution decision can be attached', () => {
  for (const key of ['lever', 'budget', 'campaign', 'action', 'execute', 'publish']) {
    assert.equal(code(() => buildDomainFit({ ...fit(), [key]: 'x' })), 'MKT_UNKNOWN_KEY', key);
  }
  assert.ok(isDeepFrozen(buildDomainFit(fit())));
});

// ------------------------------------------------------------------ MarketingFinding (55-80)

test('Finding: PROBLEM, OPPORTUNITY, NO_MATERIAL_SIGNAL and NOT_MEASURABLE are all valid and derive a deterministic id', () => {
  const p = finding();
  assert.match(p.finding_id, /^mfd_[0-9a-f]{32}$/);
  assert.equal(finding().finding_id, p.finding_id);
  assert.notEqual(finding({ statement: 'A different sentence.' }).finding_id, p.finding_id);
  assert.equal(finding({ finding_type: 'OPPORTUNITY' }).finding_type, 'OPPORTUNITY');
  const none = finding({ finding_type: 'NO_MATERIAL_SIGNAL', subject_refs: [], evidence_refs: [], hypotheses: [], materiality: assessMateriality({ ECONOMIC: axis('NOT_MATERIAL') }) });
  assert.equal(none.finding_type, 'NO_MATERIAL_SIGNAL');
  const nm = finding({ finding_type: 'NOT_MEASURABLE', subject_refs: [], evidence_refs: [], hypotheses: [], domain_fit: fit({ status: 'NOT_MEASURABLE' }) });
  assert.equal(nm.finding_type, 'NOT_MEASURABLE');
  assert.equal(code(() => finding({ finding_type: 'WINNING_IDEA' })), 'MKT_FINDING_INVALID_TYPE');
  assert.equal(code(() => finding({ finding_type: 'REFER_TO_DOMAIN' })), 'MKT_FINDING_INVALID_TYPE'); // a domain_fit outcome, never a finding_type
});

test('Finding: closed schema - no campaign, budget, creative, final cause, score or spend can be stored', () => {
  for (const key of ['campaign', 'budget', 'creative', 'final_cause', 'recommended_spend', 'random_score', 'confidence', 'lever', 'channel', 'price']) {
    assert.equal(code(() => finding({ [key]: 'x' })), 'MKT_UNKNOWN_KEY', key);
  }
  assert.equal(code(() => finding({ merchant_id: M2 })), 'MKT_UNKNOWN_KEY');
  assert.equal(code(() => finding({ brand_id: B1 })), 'MKT_UNKNOWN_KEY');
  assert.equal(code(() => finding({ finding_id: 'mfd_x' })), 'MKT_UNKNOWN_KEY');
  assert.equal(code(() => finding({ materiality: { ...material(), score: 92 } })), 'MKT_UNKNOWN_KEY');
});

test('Finding: statement is required and bounded; subjects and evidence are required for PROBLEM/OPPORTUNITY', () => {
  assert.equal(code(() => finding({ statement: '' })), 'MKT_INVALID_FIELD');
  assert.equal(code(() => finding({ statement: 'x'.repeat(501) })), 'MKT_INVALID_FIELD');
  assert.equal(code(() => finding({ subject_refs: [] })), 'MKT_FINDING_SUBJECT_REQUIRED');
  assert.equal(code(() => finding({ evidence_refs: [] })), 'MKT_FINDING_EVIDENCE_REQUIRED');
  assert.equal(code(() => finding({ finding_type: 'OPPORTUNITY', evidence_refs: [] })), 'MKT_FINDING_EVIDENCE_REQUIRED');
  assert.equal(code(() => finding({ finding_type: 'NOT_MEASURABLE', data_gaps: [] })), 'MKT_FINDING_DATA_GAP_REQUIRED'); // a NOT_MEASURABLE must say what is missing
});

test('Finding: contradictory evidence, limitations, data gaps and IS / IS NOT are first-class and preserved', () => {
  const f = finding();
  assert.deepEqual(f.contradictory_evidence_refs, ['ev/9']);
  assert.ok(f.limitations.includes('one week only'));
  assert.deepEqual(f.data_gaps, [{ gap_code: 'NO_MARGIN', owner_domain: 'FINANCE', description: 'unit margin not exposed yet' }]);
  assert.deepEqual(f.is, [{ dimension: 'PRODUCT', value: 'widget', evidence_refs: ['ev/1'] }]);
  assert.deepEqual(f.is_not, [{ dimension: 'PRODUCT', value: 'gadget', evidence_refs: [] }]);
  assert.deepEqual(f.scope, [{ dimension: 'CHANNEL', value: 'organic_search', evidence_refs: [] }]);
  assert.equal(f.baseline_ref, 'baseline/prev-week');
  // IS / IS NOT: bounded dimension+value entries, never free sentences, never promoted to a hypothesis
  assert.equal(code(() => finding({ is: [{ dimension: '', value: 'x' }] })), 'MKT_INVALID_FIELD');
  assert.equal(code(() => finding({ is: [{ dimension: 'PRODUCT', value: '' }] })), 'MKT_INVALID_FIELD');
  assert.equal(code(() => finding({ is: [{ dimension: 'PRODUCT', value: 'a sentence with spaces' }] })), 'MKT_INVALID_FIELD');
  assert.equal(code(() => finding({ is: [{ dimension: 'PRODUCT', value: 'x', cause: 'y' }] })), 'MKT_UNKNOWN_KEY');
  assert.equal(code(() => finding({ is: [{ dimension: 'PRODUCT', value: 'widget' }], is_not: [{ dimension: 'PRODUCT', value: 'widget' }] })), 'MKT_FINDING_IS_IS_NOT_CONFLICT');
  assert.equal(code(() => finding({ is: [{ dimension: 'A', value: 'b' }, { dimension: 'A', value: 'b' }] })), 'MKT_DUPLICATE_ENTRY');
  const noIsHyp = finding({ hypotheses: [] });
  assert.deepEqual(noIsHyp.hypotheses, []); // IS entries alone create no hypothesis
  // a data gap is structured, never an estimate
  assert.equal(code(() => finding({ data_gaps: [{ gap_code: 'NO_MARGIN', description: 'x', estimate: 12 }] })), 'MKT_UNKNOWN_KEY');
  assert.equal(code(() => finding({ data_gaps: [{ gap_code: 'X', owner_domain: 'MARKETING', description: 'x' }] })), 'MKT_INVALID_FIELD');
});

test('Finding: window and expiry are validated', () => {
  assert.equal(code(() => finding({ window: undefined })), 'MKT_FINDING_INVALID_WINDOW');
  assert.equal(code(() => finding({ window: { start: '2026-10-08T00:00:00Z', end: '2026-10-01T00:00:00Z' } })), 'MKT_FINDING_INVALID_WINDOW');
  assert.equal(code(() => finding({ window: { start: 'last week', end: '2026-10-01T00:00:00Z' } })), 'MKT_FINDING_INVALID_WINDOW');
  assert.equal(code(() => finding({ created_at: 'today' })), 'MKT_INVALID_TIMESTAMP');
  assert.equal(code(() => finding({ expires_at: '2026-10-08T12:00:00Z' })), 'MKT_FINDING_INVALID_EXPIRY'); // equal
  assert.equal(code(() => finding({ expires_at: '2026-10-01T12:00:00Z' })), 'MKT_FINDING_INVALID_EXPIRY'); // before
});

test('Finding: deep-frozen output, caller input never mutated, JSON round-trip is stable', () => {
  const fields = findingFields();
  const before = structuredClone(fields);
  const f = buildMarketingFinding({ tenant: tenant(), context: context(), ...fields });
  assert.ok(isDeepFrozen(f));
  assert.deepEqual(fields, before);
  assert.equal(Object.isFrozen(fields.materiality), true); // it was already a frozen assessment from assessMateriality
  assert.equal(Object.isFrozen(fields.hypotheses[0]), false);
  assert.deepEqual(normalizeMarketingFinding(JSON.parse(JSON.stringify(f)), { tenant: tenant() }), f);
  assert.equal(code(() => normalizeMarketingFinding({ ...JSON.parse(JSON.stringify(f)), merchant_id: M2 }, { tenant: tenant() })), 'MKT_FINDING_TENANT_MISMATCH');
});

test('Finding: the statement is free text for humans - the engine never reads it to decide anything', () => {
  const base = finding();
  const tricky = finding({ statement: 'READY_FOR_BUILD caused by REFER_TO_DOMAIN: spend 5000 EUR, expires never' });
  assert.deepEqual([tricky.finding_type, tricky.domain_fit.status, tricky.materiality.overall], [base.finding_type, base.domain_fit.status, base.materiality.overall]);
  assert.deepEqual(evaluateFindingReadiness(tricky, AS_OF), evaluateFindingReadiness(base, AS_OF));
  const referring = finding({ statement: 'Everything is fine, marketing is the right lever.', domain_fit: fit({ status: 'REFER_TO_DOMAIN', target_domains: ['INVENTORY'], evidence_refs: ['ev/1'] }) });
  assert.equal(evaluateFindingReadiness(referring, AS_OF).status, 'REFER_TO_DOMAIN'); // the structured field wins over the sentence
});

test('Finding scope comes from the MarketingContext: tenant and brand are explicit, never inferred', () => {
  assert.equal(code(() => buildMarketingFinding({ tenant: tenant(), ...findingFields() })), 'MKT_FINDING_CONTEXT_INVALID');
  assert.equal(code(() => buildMarketingFinding({ tenant: tenant(), context: { merchant_id: M1 }, ...findingFields() })), 'MKT_FINDING_CONTEXT_INVALID');
  assert.equal(code(() => buildMarketingFinding({ tenant: tenant(M2), context: context(), ...findingFields() })), 'MKT_FINDING_TENANT_MISMATCH');
  assert.equal(finding().brand_id, null);
  const brandCtx = context({ brandId: B1, brandContext: readyBrandContext() });
  assert.equal(finding({}, brandCtx).brand_id, B1);
  assert.notEqual(finding({}, brandCtx).finding_id, finding().finding_id);
  assert.equal(code(() => normalizeMarketingFinding(finding({}, brandCtx), { tenant: tenant(), brand: brandOf(M1, B2) })), 'MKT_FINDING_BRAND_MISMATCH');
  // a brand-scoped context never admits another brand's signal, so a brand Finding cannot cite one
  const otherBrandSignal = buildMarketSignal({ tenant: tenant(), brand: brandOf(M1, B2), ...signalFields() });
  assert.equal(code(() => context({ brandId: B1, brandContext: readyBrandContext(), marketSignals: [otherBrandSignal] })), 'MKT_CONTEXT_BRAND_MISMATCH');
});

test('Finding keeps what the cited signals said: their limitations travel, and an already-expired signal is flagged', () => {
  const external = signal({ signal_class: 'EXTERNAL_SIGNAL', signal_type: 'SOCIAL_TREND', provenance: provenanceOf({ evidence_kind: 'inferred' }), limitations: ['one platform only'] });
  const expired = signal({ signal_type: 'SEARCH_DEMAND', detected_at: '2026-09-01T10:00:00Z', expires_at: '2026-09-08T10:00:00Z' });
  const ctx = context({ marketSignals: [external, expired] });
  const f = finding({ evidence_refs: [external.signal_id], contradictory_evidence_refs: [expired.signal_id], expires_at: '2026-10-15T10:00:00Z' }, ctx);
  for (const l of ['EXTERNAL_SIGNAL_IS_NOT_A_MERCHANT_FACT', 'one platform only', 'ATTRIBUTION_IS_NOT_CAUSAL_PROOF', 'CITED_SIGNAL_EXPIRED', 'one week only']) {
    assert.ok(f.limitations.includes(l), l);
  }
  const unrelated = finding({ evidence_refs: ['ev/1'] }, ctx);
  assert.equal(unrelated.limitations.includes('CITED_SIGNAL_EXPIRED'), false); // only cited signals contribute
  assert.equal(unrelated.limitations.includes('EXTERNAL_SIGNAL_IS_NOT_A_MERCHANT_FACT'), false);
});

test('Evidence freshness bound: a Finding cannot outlive the signals that support it (expires_at <= min(signal.expires_at))', () => {
  const early = signal({ signal_type: 'SEARCH_DEMAND', expires_at: '2026-10-12T10:00:00Z' });
  const late = signal({ signal_type: 'REPUTATION', expires_at: '2026-10-20T10:00:00Z' });
  const ctx = context({ marketSignals: [early, late] });
  const at = (iso) => ({ expires_at: iso });
  assert.equal(code(() => finding({ evidence_refs: [early.signal_id], ...at('2026-10-12T10:00:01Z') }, ctx)), 'MKT_FINDING_OUTLIVES_EVIDENCE');
  assert.equal(finding({ evidence_refs: [early.signal_id], ...at('2026-10-12T10:00:00Z') }, ctx).expires_at, '2026-10-12T10:00:00.000Z'); // equal to the bound is allowed
  // the bound is the MINIMUM over every supporting signal
  assert.equal(code(() => finding({ evidence_refs: [early.signal_id, late.signal_id], ...at('2026-10-15T00:00:00Z') }, ctx)), 'MKT_FINDING_OUTLIVES_EVIDENCE');
  assert.equal(finding({ evidence_refs: [late.signal_id], ...at('2026-10-20T10:00:00Z') }, ctx).expires_at, '2026-10-20T10:00:00.000Z');
  // contradictory evidence is not support: it does not bound the Finding
  assert.equal(finding({ evidence_refs: [late.signal_id], contradictory_evidence_refs: [early.signal_id], ...at('2026-10-18T00:00:00Z') }, ctx).finding_id.startsWith('mfd_'), true);
  // refs that are not signals of the context (measurement facts, other evidence) impose no bound
  assert.equal(finding({ evidence_refs: ['ev/1'], ...at('2027-01-01T00:00:00Z') }, ctx).expires_at, '2027-01-01T00:00:00.000Z');
  // support also counts when it is only cited by the materiality or domain-fit evidence
  const viaMateriality = assessMateriality({ ECONOMIC: axis('MATERIAL', ['R'], [early.signal_id]) });
  assert.equal(code(() => finding({ materiality: viaMateriality, ...at('2026-10-20T00:00:00Z') }, ctx)), 'MKT_FINDING_OUTLIVES_EVIDENCE');
  const viaFit = fit({ status: 'REFER_TO_DOMAIN', target_domains: ['INVENTORY'], evidence_refs: [early.signal_id] });
  assert.equal(code(() => finding({ domain_fit: viaFit, ...at('2026-10-20T00:00:00Z') }, ctx)), 'MKT_FINDING_OUTLIVES_EVIDENCE');
});

test('Evidence freshness bound: a signal already expired at created_at stays visible for audit but is never active proof', () => {
  const expired = signal({ signal_type: 'SEARCH_DEMAND', detected_at: '2026-09-01T10:00:00Z', expires_at: '2026-10-08T12:00:00Z' }); // expires exactly at created_at
  const ctx = context({ marketSignals: [expired] });
  assert.equal(ctx.signal_freshness[0].freshness, 'STALE'); // still in the context, labelled
  assert.equal(code(() => finding({ evidence_refs: [expired.signal_id] }, ctx)), 'MKT_FINDING_EVIDENCE_SIGNAL_EXPIRED');
  assert.equal(code(() => finding({ materiality: assessMateriality({ ECONOMIC: axis('MATERIAL', ['R'], [expired.signal_id]) }) }, ctx)), 'MKT_FINDING_EVIDENCE_SIGNAL_EXPIRED');
  assert.equal(code(() => finding({ domain_fit: fit({ status: 'REFER_TO_DOMAIN', target_domains: ['INVENTORY'], evidence_refs: [expired.signal_id] }) }, ctx)), 'MKT_FINDING_EVIDENCE_SIGNAL_EXPIRED');
  // usable as contradictory evidence: the Finding keeps it, flagged, and stays auditable
  const f = finding({ contradictory_evidence_refs: [expired.signal_id] }, ctx);
  assert.deepEqual(f.contradictory_evidence_refs, [expired.signal_id]);
  assert.ok(f.limitations.includes('CITED_SIGNAL_EXPIRED'));
  // the expired signal is never among the Finding's active support, so it can never be what makes it READY_FOR_BUILD
  assert.equal(f.evidence_refs.includes(expired.signal_id), false);
  assert.equal(JSON.stringify(f.materiality).includes(expired.signal_id), false);
});

test('MarketSignal effective_window: the period of the phenomenon, independent of observed_at and expires_at', () => {
  assert.equal(signal().effective_window, null);
  const upcoming = signal({
    signal_type: 'LOCAL_EVENT', signal_class: 'EXTERNAL_SIGNAL', observed_at: '2026-10-08T09:00:00Z',
    effective_window: { start: '2026-12-20T00:00:00Z', end: '2026-12-27T00:00:00Z' }, expires_at: '2026-10-15T10:00:00Z',
  });
  assert.deepEqual(upcoming.effective_window, { start: '2026-12-20T00:00:00.000Z', end: '2026-12-27T00:00:00.000Z' }); // future window, evidence expires long before
  assert.equal(upcoming.observed_at, '2026-10-08T09:00:00.000Z'); // observed_at untouched
  assert.equal(code(() => signal({ observed_at: '2026-10-08T10:00:01Z', effective_window: { start: '2026-12-20T00:00:00Z', end: '2026-12-27T00:00:00Z' } })), 'MKT_SIGNAL_INVALID_OBSERVED_AT'); // the rule stays
  assert.equal(code(() => signal({ effective_window: { start: '2026-12-27T00:00:00Z', end: '2026-12-20T00:00:00Z' } })), 'MKT_SIGNAL_INVALID_EFFECTIVE_WINDOW');
  assert.equal(code(() => signal({ effective_window: { start: '2026-12-20T00:00:00Z', end: '2026-12-20T00:00:00Z' } })), 'MKT_SIGNAL_INVALID_EFFECTIVE_WINDOW'); // end must be strictly after start
  assert.equal(code(() => signal({ effective_window: { start: '2026-12-20', end: '2026-12-27T00:00:00Z' } })), 'MKT_SIGNAL_INVALID_EFFECTIVE_WINDOW');
  assert.equal(code(() => signal({ effective_window: { start: '2026-12-20T00:00:00Z' } })), 'MKT_SIGNAL_INVALID_EFFECTIVE_WINDOW');
  assert.equal(code(() => signal({ effective_window: { start: '2026-12-20T00:00:00Z', end: '2026-12-27T00:00:00Z', key: 'x' } })), 'MKT_UNKNOWN_KEY');
  // freshness is driven by expires_at only, never by the effective window
  assert.equal(marketSignalFreshness(upcoming, '2026-11-01T00:00:00Z'), 'STALE');
  assert.deepEqual(normalizeMarketSignal(JSON.parse(JSON.stringify(upcoming)), { tenant: tenant() }), upcoming);
});

test('REFER_TO_DOMAIN registry is exactly the canonical Level-2 domain map, minus MARKETING', async () => {
  const refer = (target) => buildDomainFit(fit({ status: 'REFER_TO_DOMAIN', target_domains: [target], evidence_refs: ['ev/1'] }));
  const canonical = ['FINANCE', 'ANALYSES', 'SALES', 'INVENTORY', 'BUYING_SUPPLIERS', 'BRANDING', 'SALES_DEVELOPMENT', 'COMPLIANCE', 'AFTER_SALES_SERVICE'];
  assert.deepEqual(Object.values(understand.TARGET_DOMAIN).sort(), [...canonical].sort());
  for (const target of canonical) assert.deepEqual(refer(target).target_domains, [target], target);
  // renamed or removed destinations, and Marketing itself, are refused
  for (const gone of ['MARKETING', 'SALES_PRODUCT', 'AFTER_SALES', 'SERVICE_SUPPORT', 'CUSTOMERS', 'SITE_COMMERCE', 'OPERATIONS']) {
    assert.equal(code(() => refer(gone)), 'MKT_DOMAIN_FIT_UNKNOWN_TARGET', gone);
  }
  assert.equal(code(() => finding({ data_gaps: [{ gap_code: 'X', owner_domain: 'CUSTOMERS', description: 'x' }] })), 'MKT_INVALID_FIELD'); // gap owners use the same registry
  assert.equal(finding({ data_gaps: [{ gap_code: 'X', owner_domain: 'AFTER_SALES_SERVICE', description: 'x' }] }).data_gaps[0].owner_domain, 'AFTER_SALES_SERVICE');
  assert.equal(Object.isFrozen(understand.TARGET_DOMAIN), true);
  // the registry must not drift from the canonical document: every entry appears in its approved domain map
  const doc = await readFile(new URL('../NORDLA-CANONICAL-ARCHITECTURE.md', import.meta.url), 'utf8');
  const map = doc.slice(doc.indexOf('Approved domain map:'), doc.indexOf('A domain may know what is abnormal'));
  const label = { BUYING_SUPPLIERS: 'Buying & Suppliers', SALES_DEVELOPMENT: 'Sales Development', AFTER_SALES_SERVICE: 'After-Sales Service' };
  for (const target of canonical) {
    const name = label[target] ?? target.charAt(0) + target.slice(1).toLowerCase();
    assert.ok(map.includes(`- ${name}\n`) || map.includes(`- ${name}\r\n`), `${target} is not in the canonical domain map`);
  }
});

// ------------------------------------------------------------------ CandidateHypothesis (81-95)

test('CandidateHypothesis exists only inside a Finding and keeps refs, unknowns and testability', () => {
  const [h] = finding().hypotheses;
  assert.match(h.hypothesis_id, /^mhy_[0-9a-f]{32}$/);
  assert.deepEqual([h.supporting_evidence_refs, h.contradicting_evidence_refs, h.unknowns, h.testability], [['ev/1'], ['ev/9'], ['no checkout funnel data'], 'TESTABLE_LATER']);
  // no standalone builder/normalizer is exported anywhere on the public M1 surface
  for (const mod of [understand, findingModule, signalModule, contextModule, materialityModule, domainFitModule]) {
    assert.deepEqual(Object.keys(mod).filter((name) => /hypothes/i.test(name)), [], 'no hypothesis export');
  }
  assert.equal(finding({ hypotheses: [{ statement: 'a', mechanism: 'b', testability: 'UNKNOWN' }] }).hypotheses[0].supporting_evidence_refs.length, 0);
});

test('CandidateHypothesis: statement/mechanism required; testability is an explicit enum; no status, confidence or confirmation', () => {
  const hyp = (over) => ({ statement: 's', mechanism: 'm', testability: 'TESTABLE_NOW', ...over });
  assert.equal(code(() => finding({ hypotheses: [hyp({ statement: '' })] })), 'MKT_INVALID_FIELD');
  assert.equal(code(() => finding({ hypotheses: [hyp({ mechanism: ' ' })] })), 'MKT_INVALID_FIELD');
  assert.equal(code(() => finding({ hypotheses: [hyp({ testability: 'LIKELY' })] })), 'MKT_HYPOTHESIS_INVALID_TESTABILITY');
  assert.equal(code(() => finding({ hypotheses: [hyp({ testability: undefined })] })), 'MKT_HYPOTHESIS_INVALID_TESTABILITY');
  for (const testability of ['TESTABLE_NOW', 'TESTABLE_LATER', 'NOT_TESTABLE', 'UNKNOWN']) {
    assert.equal(finding({ hypotheses: [hyp({ testability })] }).hypotheses[0].testability, testability);
  }
  // a hypothesis can never be CONFIRMED / PROVEN / FACT, nor carry a made-up confidence
  for (const extra of [{ status: 'CONFIRMED' }, { status: 'PROVEN' }, { status: 'FACT' }, { confirmed: true }, { confidence: 92 }, { causal_claim: true }]) {
    assert.equal(code(() => finding({ hypotheses: [hyp(extra)] })), 'MKT_UNKNOWN_KEY', JSON.stringify(extra));
  }
  // NOT_TESTABLE / UNKNOWN hypotheses are kept, with their unknowns - not deleted
  const kept = finding({ hypotheses: [hyp({ testability: 'NOT_TESTABLE', unknowns: ['no data', 'no data', 'no control'] })] }).hypotheses[0];
  assert.deepEqual(kept.unknowns, ['no data', 'no control']);
  assert.equal(code(() => finding({ hypotheses: [hyp(), hyp()] })), 'MKT_DUPLICATE_ENTRY');
});

test('A mechanism stays a candidate: no output of any M1 function ever contains causal_claim=true', () => {
  const s = signal({ provenance: provenanceOf({ evidence_kind: 'attributed' }) });
  const ctx = context({ measurementFacts: facts({ open: true }), marketSignals: [s] });
  const f = finding({ hypotheses: [{ statement: 'X caused Y', mechanism: 'X causes Y', testability: 'TESTABLE_NOW' }] }, ctx);
  for (const output of [s, ctx, f, evaluateFindingReadiness(f, AS_OF), material(), buildDomainFit(fit())]) {
    everyObject(output, (o) => assert.notEqual(o.causal_claim, true));
    everyObject(output, (o) => assert.notEqual(o.causal_claims, true));
  }
  assert.equal(f.causal_claim, undefined);
  assert.equal(ctx.measurement.causal_claims, false);
  assert.equal(f.hypotheses[0].testability, 'TESTABLE_NOW'); // "X causes Y" is only ever a mechanism sentence
});

// ------------------------------------------------------------------ Freshness / readiness (96-108)

test('Finding freshness uses an explicit clock only: FRESH before expiry, STALE at and after', () => {
  const f = finding();
  assert.equal(findingFreshness(f, '2026-10-22T11:59:59Z'), 'FRESH');
  assert.equal(findingFreshness(f, '2026-10-22T12:00:00Z'), 'STALE');
  assert.equal(findingFreshness(f, '2026-12-01T00:00:00Z'), 'STALE');
  assert.equal(findingFreshness(f, new Date('2026-10-09T00:00:00Z')), 'FRESH');
  assert.equal(code(() => findingFreshness(f)), 'MKT_INVALID_TIMESTAMP');
  assert.equal(code(() => evaluateFindingReadiness(f)), 'MKT_INVALID_TIMESTAMP');
});

test('No implicit clock or randomness anywhere in the M1 engine', async () => {
  const dir = new URL('../src/marketing/', import.meta.url);
  const files = ['understand-constants', 'understand-validation', 'market-signal', 'marketing-context', 'materiality', 'domain-fit', 'finding', 'understand'];
  for (const name of files) {
    const text = await readFile(new URL(`${name}.js`, dir), 'utf8');
    assert.doesNotMatch(text, /Date\.now|new Date\(\)|Math\.random|randomUUID|process\.env|fetch\(|readFile|writeFile|createClient/, name);
    assert.doesNotMatch(text, /anthropic|openai|gemini|qwen|prompt/i, name);
  }
});

test('Readiness: READY_FOR_BUILD only for a fresh, material, marketing-relevant PROBLEM/OPPORTUNITY', () => {
  assert.deepEqual(evaluateFindingReadiness(finding(), AS_OF), { status: 'READY_FOR_BUILD', reason_codes: ['FRESH_MATERIAL_MARKETING_RELEVANT'] });
  assert.equal(evaluateFindingReadiness(finding({ finding_type: 'OPPORTUNITY' }), AS_OF).status, 'READY_FOR_BUILD');
  assert.ok(isDeepFrozen(evaluateFindingReadiness(finding(), AS_OF)));
});

test('Readiness: every other route, with the documented precedence STALE > REFER > NOT_MEASURABLE > NO_MATERIAL_SIGNAL > READY', () => {
  const refer = fit({ status: 'REFER_TO_DOMAIN', target_domains: ['INVENTORY'], evidence_refs: ['ev/1'] });
  assert.equal(evaluateFindingReadiness(finding({ domain_fit: refer }), AS_OF).status, 'REFER_TO_DOMAIN');
  assert.equal(evaluateFindingReadiness(finding({ finding_type: 'NOT_MEASURABLE' }), AS_OF).status, 'NOT_MEASURABLE');
  assert.equal(evaluateFindingReadiness(finding({ domain_fit: fit({ status: 'NOT_MEASURABLE' }) }), AS_OF).status, 'NOT_MEASURABLE');
  const notMaterial = assessMateriality({ ECONOMIC: axis('NOT_MATERIAL'), CUSTOMER: axis('NOT_APPLICABLE'), STRATEGIC: axis('NOT_APPLICABLE'), RISK: axis('NOT_APPLICABLE'), OPERATIONAL: axis('NOT_APPLICABLE') });
  assert.equal(evaluateFindingReadiness(finding({ materiality: notMaterial }), AS_OF).status, 'NO_MATERIAL_SIGNAL');
  assert.equal(evaluateFindingReadiness(finding({ finding_type: 'NO_MATERIAL_SIGNAL', subject_refs: [], evidence_refs: [] }), AS_OF).status, 'NO_MATERIAL_SIGNAL');
  assert.equal(evaluateFindingReadiness(finding({ domain_fit: fit({ status: 'NO_MATERIAL_SIGNAL' }) }), AS_OF).status, 'NO_MATERIAL_SIGNAL');
  // materiality still UNKNOWN: never READY on unknowns
  assert.deepEqual(evaluateFindingReadiness(finding({ materiality: assessMateriality() }), AS_OF), { status: 'NOT_MEASURABLE', reason_codes: ['MATERIALITY_UNKNOWN'] });
  // STALE beats everything, including a READY-looking and a REFER finding
  const later = '2026-10-23T00:00:00Z';
  assert.equal(evaluateFindingReadiness(finding(), later).status, 'STALE');
  assert.equal(evaluateFindingReadiness(finding({ domain_fit: refer }), later).status, 'STALE');
  assert.equal(evaluateFindingReadiness(finding({ finding_type: 'NOT_MEASURABLE' }), later).status, 'STALE');
  // REFER beats NOT_MEASURABLE type, which beats NO_MATERIAL
  assert.equal(evaluateFindingReadiness(finding({ finding_type: 'NOT_MEASURABLE', domain_fit: refer }), AS_OF).status, 'REFER_TO_DOMAIN');
  assert.equal(evaluateFindingReadiness(finding({ materiality: notMaterial, domain_fit: fit({ status: 'NOT_MEASURABLE' }) }), AS_OF).status, 'NOT_MEASURABLE');
});

test('Readiness: a Finding is never READY when Marketing is not the relevant domain, whatever else it says', () => {
  for (const status of ['REFER_TO_DOMAIN', 'NO_MATERIAL_SIGNAL', 'NOT_MEASURABLE']) {
    const domain = status === 'REFER_TO_DOMAIN' ? fit({ status, target_domains: ['FINANCE'], evidence_refs: ['ev/1'] }) : fit({ status });
    for (const finding_type of ['PROBLEM', 'OPPORTUNITY']) {
      assert.notEqual(evaluateFindingReadiness(finding({ finding_type, domain_fit: domain }), AS_OF).status, 'READY_FOR_BUILD', `${finding_type}/${status}`);
    }
  }
});

// ------------------------------------------------------------------ boundaries / non-regression (109-126)

test('Domain boundaries: M1 exposes diagnosis only - no margin, stock, customer, creative, publish, spend or price logic', async () => {
  const exported = Object.keys(understand).join(' ');
  assert.doesNotMatch(exported, /publish|send|buyAds|buy_ads|changePrice|change_price|changeStock|execute|approveSpend|forceCampaign|margin|stock|creative|guardian|campaign/i);
  const dir = new URL('../src/marketing/', import.meta.url);
  for (const name of ['market-signal', 'marketing-context', 'materiality', 'domain-fit', 'finding']) {
    const text = await readFile(new URL(`${name}.js`, dir), 'utf8');
    const imports = [...text.matchAll(/from '([^']+)'/g)].map((m) => m[1]);
    for (const spec of imports) {
      assert.doesNotMatch(spec, /creative|guardian|inventory|finance|customers|sync|shopify|supabase/i, `${name} imports ${spec}`);
    }
  }
});

test('Existing Marketing Measurement is untouched: report document, gates, provenance, search observations', () => {
  const f = facts();
  assert.equal(f.causal_claims, false);
  assert.equal(f.gates.traffic_conversion.status, 'GATED');
  assert.equal(phase3Inputs({ gates: {}, search: {} }).search.status, 'ABSENT');
  const data = makeMarketingData();
  const cfg = config();
  const again = buildMarketingFacts({ ledger: ledgerOf(data, cfg), data, traffic: null, ads: null, search: null, now: NOW, timeZone: TZ, config: cfg, merchantId: M1 });
  assert.deepEqual(again, f); // deterministic, and building a context did not change the builder
  assert.deepEqual(context({ measurementFacts: f }).measurement.conversion, { status: 'GATED', reasons: ['NO_TRAFFIC_FACTS'], traffic: null });
});

test('Repository hygiene: no HABB/merchant name in the generic M1 code, CLI untouched, Branding not modified by M1', async () => {
  const dir = new URL('../src/marketing/', import.meta.url);
  for (const name of ['understand-constants', 'understand-validation', 'market-signal', 'marketing-context', 'materiality', 'domain-fit', 'finding', 'understand']) {
    assert.doesNotMatch(await readFile(new URL(`${name}.js`, dir), 'utf8'), /habb|shopify|namur|belgi/i, name);
  }
  const index = await readFile(new URL('index.js', dir), 'utf8');
  assert.doesNotMatch(index, /understand|MarketSignal|MarketingFinding/);
  const files = await readdir(new URL('../src/branding/', import.meta.url));
  assert.ok(files.includes('interfaces.js'));
});
test('Coverage matrix: the doc maps all 131 mandate cases, and every test it names exists', async () => {
  const doc = await readFile(new URL('../docs/architecture/marketing-m1-understand-contract.md', import.meta.url), 'utf8');
  const self = await readFile(new URL(import.meta.url), 'utf8');
  const matrix = doc.slice(doc.indexOf('<!-- coverage-matrix:start -->'), doc.indexOf('<!-- coverage-matrix:end -->'));
  const rows = [...matrix.matchAll(/^\| (\d+) \| (.+?) \| (.+?) \|$/gm)].map((m) => ({ n: Number(m[1]), name: m[3] }));
  assert.deepEqual(rows.map((r) => r.n), Array.from({ length: 131 }, (_, i) => i + 1));
  for (const { n, name } of rows) {
    const known = name.startsWith('test/marketing.test.js') || self.includes(`test('${name}'`);
    assert.ok(known, `mandate case ${n} names a test that does not exist: ${name}`);
  }
});

