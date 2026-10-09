import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';

import * as CI from '../src/creative-intelligence/index.js';
import * as P from '../src/creative-intelligence/production.js';
import * as R from '../src/resources/index.js';
import {
  creativeBrandInterface, isExpressionNonEmpty, normalizeExpressionSystem, validateBrandMemory, validateCoreForApproval,
} from '../src/branding/index.js';
import { buildBrandPackage } from '../scripts/build-benchmark-brand-package.mjs';

// Canonical HABB brand package for Benchmark 001 (`// HBB-N` markers follow the numbered test list of the bootstrap mandate).
// HABB is configuration: the package lives in benchmarks/creative-intelligence/, nothing about it is in src/.

const load = async (file) => JSON.parse(await readFile(new URL(`../benchmarks/creative-intelligence/${file}`, import.meta.url), 'utf8'));
const pkg = await load('habb-brand-canonical-v1.json');
const config = await load('habb-creative-benchmark-001.json');
const expressionFile = await load('habb-expression-system-benchmark-001.json');
const built = buildBrandPackage(pkg.inputs, expressionFile.expression_system);
const HABB_BRAND_ID = '4c487848-8d41-4e30-8f3f-66afd09b4be4'; // pinned: if this ever changes, the canonical identity was regenerated
const MERCHANT = '36b1a1a7-2a48-416a-9dfe-ce66fe1ec2a5';
const out = pkg.outputs;
const iface = creativeBrandInterface(built.context);
const reasonOf = (report, id) => report.bindings.find((b) => b.id === id)?.reason;

test('HABB brand identity: one stable brand_id, French benchmark locale', () => {
  // HBB-1 one stable HABB brand_id exists, differs from the merchant_id and is the one the benchmark and the package agree on
  assert.equal(out.brand.brand_id, HABB_BRAND_ID);
  assert.equal(pkg.inputs.brand.brand_id, HABB_BRAND_ID);
  assert.equal(config.brand.brand_id, HABB_BRAND_ID);
  assert.notEqual(HABB_BRAND_ID, MERCHANT);
  assert.equal(out.brand.merchant_id, MERCHANT);
  assert.match(HABB_BRAND_ID, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(out.brand.name, 'HABB');
  assert.equal(out.brand.status, 'ACTIVE');
  assert.equal(out.brand.parent_brand_id, null);
  // HBB-2 default locale fr-BE
  assert.equal(out.brand.default_locale, 'fr-BE');
  // HBB-3 supported locales are exactly [fr-BE] (no English, Albanian, Dutch or Arabic added)
  assert.deepEqual(out.brand.supported_locales, ['fr-BE']);
});

test('HABB snapshot: built from readable HABB evidence only, gaps stated, nothing fabricated', () => {
  const snapshot = out.snapshot;
  // HBB-4 READY, every evidence comes from a known readable HABB source or an owner decision, no URL, no competitor, no customer research
  assert.equal(snapshot.status, 'READY');
  const systems = new Set(['habb-os', 'habb-sales-knowledge-base', 'habb-google-business', 'owner-decision', 'nordla-bootstrap']);
  for (const e of snapshot.evidence) {
    assert.ok(systems.has(e.source.system), e.id);
    assert.doesNotMatch(e.source.ref, /^https?:/i, e.id);
    assert.ok(['MERCHANT_PROVIDED', 'INTERNAL_FACT'].includes(e.source.kind), e.id);
    assert.equal(e.provenance, 'observed', e.id); // each statement is literally in its source; nothing is passed off as observed otherwise
  }
  assert.deepEqual(snapshot.competitors, []);
  assert.ok(!snapshot.evidence.some((e) => e.source.kind === 'DIRECT_COMPETITOR' || e.source.kind === 'CUSTOMER_REVIEW'));
  const ids = new Set(snapshot.evidence.map((e) => e.id));
  for (const group of ['category', 'positioning', 'messages', 'customer_expectations', 'visible_assets', 'contradictions', 'evidence_gaps']) {
    assert.ok(snapshot[group].length > 0, group);
    for (const f of snapshot[group]) for (const ref of f.evidence_refs) assert.ok(ids.has(ref), `${f.id} -> ${ref}`);
  }
  // the two sources the mandate named but that were not available are recorded as gaps, never cited as evidence
  const gaps = snapshot.evidence_gaps.map((g) => g.statement).join(' ');
  assert.match(gaps, /Master Reference/);
  assert.match(gaps, /Design Manual/);
  assert.ok(!snapshot.evidence.some((e) => /Master Reference|Design Manual|Design Bible/.test(e.source.ref)));
  // the 25 EUR / 24.90 EUR price difference is kept as a contradiction, not resolved silently
  assert.match(snapshot.contradictions[0].statement, /25 EUR.*24\.90 EUR/);
});

test('HABB Core V1: valid, governed, approved by a resolved owner, bound to the HABB brand', () => {
  const core = out.approved_core;
  // HBB-5 the Core passes approval validation
  assert.deepEqual(validateCoreForApproval(built.core), { ok: true, reasons: [] });
  // HBB-6 it is APPROVED through the governed flow (version 1, HABB brand, decision event recorded, no auto-approval)
  assert.equal(core.status, 'APPROVED');
  assert.equal(core.version, 1);
  assert.equal(core.brand_id, HABB_BRAND_ID);
  assert.equal(core.merchant_id, MERCHANT);
  assert.equal(core.snapshot_ref.id, out.snapshot.id);
  assert.equal(out.core_decision_event.type, 'BRAND_CORE_APPROVED');
  assert.equal(core.approval.decision_event_id, out.core_decision_event.id);
  assert.equal(core.approval.approver_role, 'OWNER');
  assert.deepEqual(out.core_decision_event.subject, { kind: 'brand_core', id: core.id, version: 1 });
  assert.match(core.approval.note, /Not an authenticated Nordla identity/);
  assert.equal(core.category, 'Personalised gifts, personalised everyday products, and curated lifestyle-tech retail.');
  assert.ok(!/printing service/i.test(core.category));
  assert.deepEqual(core.buying_contexts.length, 5);
  assert.deepEqual(core.reasons_to_believe.length, 6);
  assert.ok(!core.reasons_to_believe.some((r) => /minutes|speed|fast|guarantee/i.test(r))); // no unsupported universal speed guarantee
  // HBB-7 concrete exclusions exist
  assert.equal(core.exclusions.length, 5);
  assert.ok(core.exclusions.some((x) => /fake gold/.test(x)) && core.exclusions.some((x) => /generic AI-generated visual identity/.test(x)));
  // no invented asset ref: the Core carries no distinctive asset (the brand line is a verbal cue kept in Memory)
  assert.deepEqual(core.distinctive_assets, []);
  assert.ok(core.evidence_refs.every((r) => out.snapshot.evidence.some((e) => e.id === r)));
});

test('HABB Brand Memory V1.1: exact Core binding, owner-approved expression, approved colours, empty typography', () => {
  const memory = out.approved_memory;
  // HBB-8 Memory V1.1 is APPROVED, version 1, bound to EXACTLY the approved Core V1, and valid against it
  assert.equal(memory.status, 'APPROVED');
  assert.equal(memory.version, 1);
  assert.deepEqual(memory.core_ref, { id: out.approved_core.id, version: 1 });
  assert.deepEqual(validateBrandMemory(built.memory, { core: built.core }), { ok: true, reasons: [] });
  assert.ok(validateBrandMemory(built.memory, { core: { ...built.core, version: 2 } }).reasons.includes('BRAND_MEMORY_CORE_MISMATCH'));
  assert.equal(memory.brand_id, HABB_BRAND_ID);
  assert.equal(out.memory_decision_event.type, 'BRAND_MEMORY_APPROVED');
  assert.equal(memory.approval.decision_event_id, out.memory_decision_event.id);
  assert.equal(memory.approval.approver_role, 'OWNER');
  // HBB-9 the expression system is EXACTLY the owner-approved content, normalized, untouched
  assert.deepEqual(memory.expression_system, JSON.parse(JSON.stringify(normalizeExpressionSystem(expressionFile.expression_system))));
  assert.equal(isExpressionNonEmpty(memory.expression_system), true);
  assert.ok(!('locale_overrides' in memory.expression_system));
  // HBB-10 typography is empty; HBB-11 and no font, fallback or otherwise, is introduced anywhere
  assert.deepEqual(memory.design_tokens.typography, {});
  assert.doesNotMatch(JSON.stringify(out), /Georgia|Arial|Helvetica|Montserrat|Playfair|DejaVu|Noto|font-family|sans-serif/i);
  assert.deepEqual(iface.design_tokens.typography, {});
  // HBB-12 the colours are exactly the approved initial tokens
  assert.deepEqual(memory.design_tokens.colors, { navy: '#183247', terracotta: '#C56E54', cream: '#FBF8F3', white: '#FFFFFF' });
  // HBB-13 no beige / sand default token
  assert.ok(!Object.keys(memory.design_tokens.colors).some((k) => /beige|sand|sable/i.test(k)));
  assert.ok(!Object.values(memory.design_tokens.colors).includes('#EFE9E1'));
  // no logo ref is invented; no hard rule is forced into the DSL; benchmark claims are not smuggled in as registry claims
  assert.deepEqual(memory.identity_references, { primary_logo_ref: null, approved_logo_refs: [] });
  assert.deepEqual(memory.hard_rules, []);
  assert.deepEqual(memory.external_references.claim_refs, []);
});

test('HABB Creative brand interface and Benchmark 001 binding', async () => {
  // HBB-14 the Brand Context is READY
  assert.equal(built.context.status, 'READY');
  // HBB-15 the Creative interface exposes the HABB identity, exact refs, expression system and colours; typography stays empty
  assert.equal(iface.brand.brand_id, HABB_BRAND_ID);
  assert.deepEqual(iface.core_ref, { id: 'habb-core-v1', version: 1 });
  assert.deepEqual(iface.memory_ref, { id: 'habb-memory-v1', version: 1 });
  assert.equal(isExpressionNonEmpty(iface.expression_system), true);
  assert.deepEqual(Object.keys(iface.design_tokens.colors), ['navy', 'terracotta', 'cream', 'white']);
  assert.deepEqual(config.brand.core_ref, iface.core_ref);
  assert.deepEqual(config.brand.memory_ref, iface.memory_ref);
  // the benchmark claims are unchanged
  const claims = config.owned_records.filter((r) => r.kind === 'CLAIM');
  assert.deepEqual(claims.map((c) => [c.ref, c.metadata.approved_wording]), [['claim://habb/benchmark-001/price-25', '25 €'], ['claim://habb/benchmark-001/express-5-minutes', '5 minutes']]);
  // HBB-16 the benchmark's expression binding is BOUND to the approved Memory (readiness computed by the real assessor)
  const resolver = R.createCommonResourceResolver({ adapters: [R.createStaticResourceAdapter({ adapter_id: 'benchmark-owned', records: config.owned_records })] });
  const report = await P.assessBenchmarkReadiness({ config, resolver, tenant: { merchantId: MERCHANT }, creativeInterface: iface });
  assert.equal(reasonOf(report, 'expression_system'), 'APPROVED_NON_EMPTY');
  assert.equal(report.bindings.find((b) => b.id === 'expression_system').ref, 'habb-memory-v1@1');
  assert.equal(config.bindings.expression.status, 'BOUND_TO_APPROVED_BRAND_MEMORY');
  assert.deepEqual(config.bindings.expression.memory_ref, { id: 'habb-memory-v1', version: 1 });
  assert.ok(P.assessExpressionReadiness(iface).ready);
  // HBB-17 / 18 / 19 still BLOCKED, and for the right reasons: fonts, PRODUCT, real ASSET
  assert.equal(report.status, 'BLOCKED');
  assert.deepEqual(report.blockers, [
    { id: 'product', reason: 'BINDING_MISSING' }, { id: 'asset', reason: 'BINDING_MISSING' }, { id: 'fonts', reason: 'BINDING_MISSING' },
  ]);
  assert.equal(config.bindings.fonts.length, 0);
  assert.equal(config.bindings.product.ref, null);
  assert.equal(config.bindings.asset.ref, null);
  assert.equal(config.status, 'NOT_RUN');
  assert.equal(config.bindings_still_missing.length, 3);
  // HBB-20 C2 stays false
  assert.equal(CI.assessCreativeC2Readiness({ BRAND_EXPRESSION_SYSTEM: P.assessExpressionReadiness(iface).evidence }).c2_allowed, false);
  assert.equal(CI.assessCreativeC2Readiness({}).c2_allowed, false);
});

test('HABB stays configuration; the bootstrap is reproducible and never mints a new identity', async () => {
  // HBB-21 no HABB-specific branch or identifier in the generic source
  for (const dir of ['creative-intelligence', 'resources', 'branding']) {
    for (const file of (await readdir(new URL(`../src/${dir}/`, import.meta.url))).filter((f) => f.endsWith('.js'))) {
      const source = await readFile(new URL(`../src/${dir}/${file}`, import.meta.url), 'utf8');
      assert.doesNotMatch(source, /habb|36b1a1a7|4c487848/i, `${dir}/${file}`);
    }
  }
  // HBB-22 re-running the derivation gives the same brand_id and byte-identical outputs; the script has no way to mint an id
  const again = buildBrandPackage(pkg.inputs, expressionFile.expression_system);
  assert.equal(again.brand.brand_id, HABB_BRAND_ID);
  assert.deepEqual(again.outputs, pkg.outputs);
  assert.deepEqual(JSON.parse(JSON.stringify(built.outputs)), pkg.outputs);
  const script = await readFile(new URL('../scripts/build-benchmark-brand-package.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(script, /randomUUID|uuid\(|Math\.random|Date\.now|new Date\(/);
  assert.match(pkg.inputs.expression_file, /habb-expression-system-benchmark-001\.json$/);
  assert.match(pkg.inputs.notes.brand_id, /MUST preserve this brand_id/);
  assert.match(pkg.inputs.notes.typography, /No fallback font/);
});
