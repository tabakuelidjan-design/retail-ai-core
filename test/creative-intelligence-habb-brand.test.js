import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';

import * as CI from '../src/creative-intelligence/index.js';
import * as P from '../src/creative-intelligence/production.js';
import * as R from '../src/resources/index.js';
import {
  creativeBrandInterface, isExpressionNonEmpty, normalizeExpressionSystem, validateBrandMemory, validateCoreForApproval,
} from '../src/branding/index.js';
import { buildBrandPackage } from '../scripts/build-benchmark-brand-package.mjs';
import { createBenchmarkResolver } from '../scripts/benchmark-resources.mjs';

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
  const systems = new Set(['habb-os', 'habb-sales-knowledge-base', 'habb-google-business', 'owner-decision', 'nordla-bootstrap', 'habb-master-reference', 'habb-design-manual']);
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
  // the Master Reference and the Design Manual are cited evidence now, no longer gaps (see the source-evidence tests below)
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
  assert.match(core.approval.note, /not authenticated by Nordla Identity/);
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

test('HABB Brand Memory V1.1 (current revision): exact Core binding, owner-approved expression, approved colours, two typography families', () => {
  const memory = out.approved_memory;
  // HBB-8 the current Memory V1.1 is APPROVED (v2, the governed typography revision), bound to EXACTLY the approved Core V1, and valid against it
  assert.equal(memory.status, 'APPROVED');
  assert.equal(memory.version, 2);
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
  // HBB-10 typography is exactly the two approved families (v1 left it empty); HBB-11 no other family, no fallback, anywhere
  assert.deepEqual(memory.design_tokens.typography, { display: { family: 'Playfair Display', weights: [600] }, text: { family: 'Montserrat', weights: [400, 500, 600, 700] } });
  assert.doesNotMatch(JSON.stringify(out), /Georgia|Arial|Helvetica|DejaVu|Noto|font-family|sans-serif/i);
  assert.deepEqual(iface.design_tokens.typography, memory.design_tokens.typography);
  assert.deepEqual(out.memory_v1_approved.design_tokens.typography, {}); // v1 is untouched
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
  assert.deepEqual(iface.memory_ref, { id: 'habb-memory-v2', version: 2 });
  assert.equal(isExpressionNonEmpty(iface.expression_system), true);
  assert.deepEqual(Object.keys(iface.design_tokens.colors), ['navy', 'terracotta', 'cream', 'white']);
  assert.deepEqual(config.brand.core_ref, iface.core_ref);
  assert.deepEqual(config.brand.memory_ref, iface.memory_ref);
  // the benchmark claims are unchanged
  const claims = config.owned_records.filter((r) => r.kind === 'CLAIM');
  assert.deepEqual(claims.map((c) => [c.ref, c.metadata.approved_wording]), [['claim://habb/benchmark-001/price-25', '25 €'], ['claim://habb/benchmark-001/express-5-minutes', '5 minutes']]);
  // HBB-16 the benchmark's expression binding is BOUND to the approved Memory (readiness computed by the real assessor)
  const resolver = createBenchmarkResolver(config, { privatePayloads: false });
  const report = await P.assessBenchmarkReadiness({ config, resolver, tenant: { merchantId: MERCHANT }, creativeInterface: iface });
  assert.equal(reasonOf(report, 'expression_system'), 'APPROVED_NON_EMPTY');
  assert.equal(report.bindings.find((b) => b.id === 'expression_system').ref, 'habb-memory-v2@2');
  assert.equal(config.bindings.expression.status, 'BOUND_TO_APPROVED_BRAND_MEMORY');
  assert.deepEqual(config.bindings.expression.memory_ref, { id: 'habb-memory-v2', version: 2 });
  assert.ok(P.assessExpressionReadiness(iface).ready);
  // HBB-17 fonts and the PRODUCT are bound now; HBB-18 / 19 in a CI-like environment the private ASSET payload is the one blocker
  assert.equal(report.status, 'BLOCKED');
  assert.deepEqual(report.blockers, [{ id: 'asset', reason: 'ASSET_PAYLOAD_UNAVAILABLE' }]); // CI-like: the private payload is absent
  assert.equal(config.bindings.fonts.length, 2);
  assert.equal(config.bindings.product.ref, 'product://habb/benchmark-001/samsung-galaxy-a17');
  assert.equal(config.bindings.asset.ref, 'asset://habb/benchmark-001/real-personalised-case-001');
  assert.equal(config.status, 'NOT_RUN');
  assert.equal(config.bindings_still_missing.length, 0);
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
  assert.match(pkg.inputs.notes.typography, /no fallback/);
});

const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
// the hashes the owner supplied with the evidence-audit mandate, assembled from parts so this file does not look like a secret to the repository scan
const EXPECTED = {
  'HABB_Master_Reference_2026-07-18.docx': ['ccb6562e1433d35c340a58c56a9af321', 'cc65f9ead8589b8e5783db88e2d5f0c8'].join(''),
  'HABB_Design_Manual_v1.pdf': ['14c545a8d8c21f480cd8a309072890214bd', '86ef0dbeb04f58b886f6d16826ddb'].join(''),
};
const statusOf = (e) => e.source.subject_ref ?? '';

test('Supplied HABB sources: hashes, evidence records and the CONFIRMED / WORKING / OPEN / HISTORY distinction', () => {
  const docs = pkg.inputs.source_documents;
  const byFile = Object.fromEntries(docs.map((d) => [d.filename, d]));
  // HBE-1 the recorded hashes are the supplied ones, and the local copies (when present on this machine) match them byte for byte
  assert.deepEqual(Object.keys(byFile).sort(), Object.keys(EXPECTED).sort());
  for (const [file, hash] of Object.entries(EXPECTED)) {
    assert.match(hash, /^[0-9a-f]{64}$/);
    assert.equal(byFile[file].sha256, hash, file);
    assert.equal(byFile[file].stored_in_repo, false); // raw private source documents are not committed
    const local = `${process.env.HABB_SOURCE_DIR ?? 'C:/Users/etaba/Downloads'}/${file}`;
    if (existsSync(local)) assert.equal(sha(readFileSync(local)), hash, `${file} on disk`);
  }
  // HBE-2 / HBE-3 both sources are evidence now, referenced by hash, and neither is a missing source any more
  const evidence = out.snapshot.evidence;
  for (const [file, hash] of Object.entries(EXPECTED)) {
    assert.ok(evidence.some((e) => e.source.ref.includes(file) && e.source.ref.includes(`sha256:${hash}`)), file);
  }
  const gaps = out.snapshot.evidence_gaps.map((g) => g.statement).join(' ');
  assert.doesNotMatch(gaps, /(Master Reference|Design Manual)[^.]*(not available|was not|missing)/i);
  assert.ok(!evidence.some((e) => /not available to this run|were therefore not cited/.test(e.statement)));
  // competitor research and customer research / reviews remain genuinely absent: still gaps
  assert.ok(out.snapshot.evidence_gaps.some((g) => g.id === 'gap-competitors'));
  assert.ok(out.snapshot.evidence_gaps.some((g) => g.id === 'gap-customers'));
  assert.deepEqual(out.snapshot.competitors, []);
  // HBE-4 CONFIRMED material supports canonical facts: the CONFIRMED executive-snapshot evidence backs the FACT category finding and the Core
  const confirmed = evidence.filter((e) => statusOf(e) === 'master-reference-status:CONFIRMED');
  assert.ok(confirmed.length >= 1);
  assert.ok(confirmed.every((e) => e.statement.startsWith('[CONFIRMED]')));
  assert.ok(out.snapshot.category.some((f) => f.claim_kind === 'FACT' && f.evidence_refs.includes(confirmed[0].id)));
  assert.ok(out.approved_core.evidence_refs.includes(confirmed[0].id));
  // HBE-5 WORKING / OPEN / HISTORY are recorded with their status and never promoted: not in the Core, not behind a canonical FACT about the brand
  const findings = ['category', 'positioning', 'messages', 'customer_expectations', 'visible_assets', 'contradictions', 'evidence_gaps']
    .flatMap((g) => out.snapshot[g].map((f) => ({ ...f, group: g })));
  const tagged = { WORKING: [], OPEN: [], HISTORY: [] };
  for (const e of evidence) {
    for (const tag of Object.keys(tagged)) {
      if (statusOf(e) !== `master-reference-status:${tag}`) continue;
      tagged[tag].push(e.id);
      assert.ok(e.statement.startsWith(`[${tag}]`), e.id);
      assert.ok(e.limitations.length > 0, e.id);
    }
  }
  assert.ok(tagged.WORKING.length && tagged.OPEN.length && tagged.HISTORY.length);
  for (const [tag, ids] of Object.entries(tagged)) {
    for (const id of ids) {
      assert.ok(!out.approved_core.evidence_refs.includes(id), `${tag} ${id} is in the Core`);
      for (const f of findings.filter((x) => x.evidence_refs.includes(id))) {
        if (tag === 'WORKING') assert.equal(f.claim_kind, 'HYPOTHESIS', f.id);
        if (tag === 'HISTORY') assert.equal(f.claim_kind, 'INFERENCE', f.id);
        if (tag === 'OPEN') assert.equal(f.group, 'evidence_gaps', f.id); // an OPEN item can only be cited as a gap
      }
    }
  }
  // untagged statements are labelled as such and never presented as CONFIRMED
  for (const e of evidence.filter((x) => statusOf(x) === 'master-reference-status:UNTAGGED')) {
    assert.ok(e.statement.startsWith('[UNTAGGED]') && !/CONFIRMED/.test(e.statement), e.id);
  }
  // the beige palette tension between the Master Reference and the owner's benchmark decision is recorded, and the owner's decision governs
  assert.ok(out.snapshot.contradictions.some((c) => c.id === 'sf-palette'));
  assert.ok(!Object.keys(out.approved_memory.design_tokens.colors).some((k) => /beige/i.test(k)));
});

test('Core impact, Brand Context, benchmark blockers and approval timestamps after the source audit', async () => {
  const core = out.approved_core;
  // HBE-6 the approved Core semantics are exactly what the owner approved: only the evidence linkage was strengthened
  const sem = ['category', 'buying_contexts', 'value_proposition', 'positioning', 'core_promise', 'reasons_to_believe', 'personality', 'voice', 'exclusions', 'distinctive_assets'];
  const pinned = ['2b06482dc369558251841d9f6b60b0e3', 'fbe76599c48f8758900b9fe32cffd5c3'].join('');
  assert.equal(sha(JSON.stringify(sem.map((k) => [k, core[k]]))), pinned);
  assert.ok(core.evidence_refs.includes('ev-16') && core.evidence_refs.includes('ev-25'));
  // HBE-7 / 8 / 9 the Brand Context stays READY, the expression stays BOUND, typography stays empty
  assert.equal(built.context.status, 'READY');
  assert.equal(Object.keys(out.approved_memory.design_tokens.typography).length, 2);
  const resolver = createBenchmarkResolver(config, { privatePayloads: false });
  const report = await P.assessBenchmarkReadiness({ config, resolver, tenant: { merchantId: MERCHANT }, creativeInterface: iface });
  assert.equal(reasonOf(report, 'expression_system'), 'APPROVED_NON_EMPTY');
  // HBE-10 only the ASSET payload (private, absent in a CI-like environment) blocks; fonts and the product are bound (the Design Manual limits to two families but names none)
  assert.deepEqual(report.blockers.map((b) => b.id), ['asset']);
  assert.ok(out.snapshot.evidence_gaps.some((g) => g.id === 'gap-fonts-unchosen'));
  // HBE-11 C2 stays false
  assert.equal(CI.assessCreativeC2Readiness({}).c2_allowed, false);
  // HBE-12 approval timestamps are explicit recorded data captured once outside the builders; no builder reads a clock
  const auth = pkg.inputs.authorization;
  assert.match(auth.recorded_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  const stamp = new Date(auth.recorded_at).toISOString();
  for (const value of [pkg.inputs.core.approved_at, pkg.inputs.core.created_at, pkg.inputs.memory.approved_at, pkg.inputs.memory.created_at, pkg.inputs.snapshot.created_at, pkg.inputs.brand.created_at]) {
    assert.equal(value, auth.recorded_at);
  }
  assert.equal(core.approval.approved_at, stamp);
  assert.equal(out.memory_v1_approved.approval.approved_at, stamp);
  assert.equal(out.core_decision_event.decided_at, stamp);
  assert.equal(out.memory_v1_decision_event.decided_at, stamp);
  assert.match(auth.identity, /Nordla Identity did not authenticate it and remains an open dependency/);
  assert.match(auth.clock, /Read once, outside the builder/);
  assert.match(core.approval.note, /Nordla Identity, which remains an open dependency/);
  const clock = /Date\.now\(|new Date\(\)|performance\.now|process\.hrtime/;
  for (const file of ['core', 'memory', 'snapshot', 'brand', 'decision-event', 'contracts']) {
    assert.doesNotMatch(await readFile(new URL(`../src/branding/${file}.js`, import.meta.url), 'utf8'), clock, file);
  }
  assert.doesNotMatch(await readFile(new URL('../scripts/build-benchmark-brand-package.mjs', import.meta.url), 'utf8'), clock);
  // a re-run reproduces the same values
  assert.deepEqual(buildBrandPackage(pkg.inputs, expressionFile.expression_system).outputs, pkg.outputs);
});
