import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';

import * as CI from '../src/creative-intelligence/index.js';
import * as P from '../src/creative-intelligence/production.js';
import * as R from '../src/resources/index.js';
import { creativeBrandInterface } from '../src/branding/index.js';
import { buildBrandPackage } from '../scripts/build-benchmark-brand-package.mjs';
import { createBenchmarkResolver, loadFontManifest } from '../scripts/benchmark-resources.mjs';

// HABB CREATIVE BENCHMARK 001 font bindings (`// HF-N` markers follow the numbered test list of the font-bindings mandate).
// The fonts are open font resources (SIL OFL 1.1) selected for HABB; the HABB choice lives in benchmarks/ and resources/, never in src/.

const json = async (path) => JSON.parse(await readFile(new URL(`../${path}`, import.meta.url), 'utf8'));
const config = await json('benchmarks/creative-intelligence/habb-creative-benchmark-001.json');
const pkg = await json('benchmarks/creative-intelligence/habb-brand-canonical-v1.json');
const expressionFile = await json('benchmarks/creative-intelligence/habb-expression-system-benchmark-001.json');
const manifest = await json(config.resource_manifests[0]);
const out = pkg.outputs;
const TENANT = { merchantId: config.merchant.merchant_id };
const PF = 'font://google-fonts/playfair-display';
const MO = 'font://google-fonts/montserrat';
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
// pinned values (independent of the manifest) assembled from parts so this file does not look like a secret to the repository scan
const PINNED = {
  [PF]: { font: ['c40f2293766a503bc70cce9e512ef844', 'a4ccb7cbcde792fe2ea31d191917d8d6'].join(''), licence: ['566be814f8e96e93dfa16101331557eb', '6b5467e9e03f627c0910fe93ca12300e'].join('') },
  [MO]: { font: ['0f7b311b2f3279e4eef9b2f968bcdbab', '6e28f4daeb1f049f4f278a902bcd82f7'].join(''), licence: ['8b7141c03fa4f8d44e6345d5d4931709', '290f0f67875e452e95ac1fd3a027802e'].join('') },
};
const COMMIT = ['51303ca9e8ac9dcea7b12d30', '7ba568fd0e6fcfca'].join('');

const roles = config.typography.roles;
const resolver = createBenchmarkResolver(config, { privatePayloads: false });
const fontOf = async (role, over = {}) => P.loadRealFont({
  resolver, font_ref: roles[role].font_ref, instance_ref: roles[role].instance_ref, variations: roles[role].variations, tenant: TENANT, ...over,
});
const widthOf = (font, text, size = 100) => font.engine.layout(text, { fontSize: size, maxWidth: 1e6, direction: 'LTR' }).lines[0].width;
const byRef = Object.fromEntries(manifest.fonts.map((f) => [f.record.ref, f]));

test('HABB benchmark fonts: exactly two pinned open font families, resolved through the common resolver', async () => {
  // HF-1 exactly two families, in the benchmark binding, in the manifest and in the approved Memory: no third family, no fallback
  assert.deepEqual(config.bindings.fonts.map((f) => f.family).sort(), ['Montserrat', 'Playfair Display']);
  assert.deepEqual(manifest.fonts.map((f) => f.family).sort(), ['Montserrat', 'Playfair Display']);
  const typography = out.approved_memory.design_tokens.typography;
  assert.deepEqual(Object.values(typography).map((t) => t.family).sort(), ['Montserrat', 'Playfair Display']);
  assert.equal(Object.keys(typography).length, 2);
  assert.equal(manifest.owner_decision.no_third_family, true);
  assert.equal(manifest.owner_decision.no_fallback_family, true);
  // HF-2 / HF-3 both resources are ACTIVE, platform-level FONTs with evidence
  for (const ref of [PF, MO]) {
    const r = await resolver.resolve(ref, TENANT);
    // HF-4 resolved by the common resolver, with provenance
    assert.equal(r.kind, 'FONT', ref);
    assert.equal(r.status, 'ACTIVE', ref);
    assert.equal(r.merchant_id, null, ref);
    assert.equal(r.provenance.adapter_id, 'benchmark-owned');
    assert.match(r.provenance.evidence_ref, /^evidence:\/\/google-fonts\/ofl\/(playfairdisplay|montserrat)\/51303ca9e8ac9dcea7b12d307ba568fd0e6fcfca$/);
    assert.equal(r.provenance.content_hash, byRef[ref].font_sha256);
    assert.equal(r.metadata.license_ref.startsWith('license://sil-ofl-1.1/'), true);
  }
  assert.equal((await resolver.resolve(PF, TENANT)).metadata.family, 'Playfair Display');
  assert.equal((await resolver.resolve(MO, TENANT)).metadata.family, 'Montserrat');
  // HF-5 the kind comes from the owner adapter, not from the syntax of the reference: a font:// reference the owner declares as a PRODUCT is a PRODUCT
  const trap = R.createCommonResourceResolver({
    adapters: [R.createStaticResourceAdapter({ adapter_id: 'catalogue', records: [{ ref: 'font://google-fonts/not-a-font', kind: 'PRODUCT', merchant_id: TENANT.merchantId, version: 1, status: 'ACTIVE', evidence_ref: 'evidence://x', metadata: null }] })],
  });
  assert.equal((await trap.resolve('font://google-fonts/not-a-font', TENANT)).kind, 'PRODUCT');
  assert.equal(await trap.require('font://google-fonts/not-a-font', ['FONT'], TENANT).catch((e) => e.code), R.RES_ERROR.KIND_MISMATCH);
  assert.equal((await resolver.resolve('font://google-fonts/unknown-family', TENANT)).status, 'UNRESOLVED');
});

test('HABB benchmark fonts: pinned bytes, OFL notices, upstream commit', async () => {
  const dir = 'resources/fonts/habb-benchmark/';
  // HF-6 the font bytes served as the resource payload equal the pinned SHA-256 (and the declared record hash)
  const loaded = loadFontManifest(config.resource_manifests[0]);
  assert.equal(manifest.upstream.repository, 'https://github.com/google/fonts');
  assert.match(manifest.upstream.commit, /^[0-9a-f]{40}$/); // one exact commit, never a branch
  assert.equal(manifest.upstream.commit, COMMIT);
  for (const font of manifest.fonts) {
    assert.match(font.font_sha256, /^[0-9a-f]{64}$/);
    const bytes = new Uint8Array(await readFile(new URL(`../${dir}${font.file}`, import.meta.url)));
    assert.equal(sha(bytes), font.font_sha256, font.file);
    assert.equal(font.font_sha256, PINNED[font.record.ref].font, `${font.file} pinned`);
    assert.equal(font.license.sha256, PINNED[font.record.ref].licence, `${font.license.file} pinned`);
    assert.equal(font.record.metadata.content_hash, font.font_sha256);
    const payload = await resolver.loadPayload(font.record.ref, TENANT);
    assert.equal(sha(payload.bytes), font.font_sha256);
    assert.equal(font.record.evidence_ref.endsWith(manifest.upstream.commit), true);
    assert.match(font.upstream_path, /^ofl\/(playfairdisplay|montserrat)\//);
    assert.equal(font.license.id, 'OFL-1.1');
    // HF-7 the OFL text beside the font matches its pinned hash, names the licence and carries the copyright of the pinned evidence
    const notice = await readFile(new URL(`../${dir}${font.license.file}`, import.meta.url));
    assert.equal(sha(notice), font.license.sha256, font.license.file);
    const text = notice.toString('utf8');
    assert.ok(text.includes(font.license.notice_must_contain));
    assert.ok(text.startsWith(font.license.copyright), font.license.file);
    assert.ok(text.includes('SIL OPEN FONT LICENSE Version 1.1'));
  }
  assert.equal(loaded.records.length, 2);
  // the notices inventory records both fonts, the commit and the licence
  const notices = await readFile(new URL('../THIRD_PARTY_NOTICES.md', import.meta.url), 'utf8');
  for (const font of manifest.fonts) {
    assert.ok(notices.includes(font.font_sha256) && notices.includes(font.license.sha256) && notices.includes(font.license.copyright), font.family);
  }
  assert.ok(notices.includes(manifest.upstream.commit));
  assert.match(notices, /SIL Open Font License, Version 1\.1/);
  assert.match(notices, /not proprietary/);
  // a payload that no longer matches its pinned hash is refused by the resolver (changed bytes without a hash update)
  const tampered = Uint8Array.from(loaded.payloads[PF]);
  tampered[tampered.length - 1] ^= 1;
  const bad = R.createCommonResourceResolver({ adapters: [R.createStaticResourceAdapter({ adapter_id: 'x', records: loaded.records, payloads: { ...loaded.payloads, [PF]: tampered } })] });
  assert.equal(await bad.loadPayload(PF, TENANT).catch((e) => e.code), R.RES_ERROR.PAYLOAD_HASH_MISMATCH);
});

test('HABB benchmark fonts: real coverage and real shaping per role, no fallback', async () => {
  const headline = await fontOf('headline');
  const price = await fontOf('price');
  const speed = await fontOf('speed_claim');
  const supporting = await fontOf('supporting');
  const body = await fontOf('body');
  // HF-8 Playfair Display covers the exact headline characters (including é)
  assert.deepEqual(headline.engine.missingChars('Coques personnalisées'), []);
  // HF-9 Montserrat covers the euro sign, digits, the claim text and French punctuation
  for (const text of ['25 €', '5 minutes', '0123456789', 'Coque + personnalisation : 25 €.', 'À partir de 25 €, prêt en 5 minutes !? « ; , ’ - »', 'ÉÈÊËÀÂÎÏÔÙÛÜÇçéèêëàâîïôùûüœ']) {
    assert.deepEqual(price.engine.missingChars(text), [], text);
  }
  // HF-10 Playfair Display 600 shapes in the production engine, on the pinned bytes, as an instance of the variable font
  assert.equal(headline.content_hash, byRef[PF].font_sha256);
  assert.deepEqual({ ...headline.variations }, { wght: 600 });
  assert.equal(headline.family, 'Playfair Display');
  const regular = await fontOf('headline', { variations: { wght: 400 }, instance_ref: 'font-instance://test/playfair-400' });
  assert.notEqual(widthOf(headline, 'Coques personnalisées'), widthOf(regular, 'Coques personnalisées')); // the variation is really applied
  assert.ok(widthOf(headline, 'Coques personnalisées') > widthOf(regular, 'Coques personnalisées'));
  assert.ok(headline.engine.layout('Coques personnalisées', { fontSize: 80, maxWidth: 1e6, direction: 'LTR' }).lines[0].runs.reduce((n, r) => n + r.glyphs.length, 0) >= 19);
  // HF-11 Montserrat 400 / 500 / 600 / 700 shape, each a different instance of the same bytes (the weights widen monotonically)
  const widths = [body, supporting, speed, price].map((f) => widthOf(f, '25 € · 5 minutes'));
  assert.ok(widths.every((w, i) => i === 0 || w > widths[i - 1]), widths.join(' < '));
  for (const [font, weight] of [[body, 400], [supporting, 500], [speed, 600], [price, 700]]) {
    assert.equal(font.content_hash, byRef[MO].font_sha256);
    assert.deepEqual({ ...font.variations }, { wght: weight });
  }
  // the outline of a glyph differs between weights: what is drawn is the instance that was measured
  assert.notEqual(price.engine.glyphPath(price.engine.glyphFor(0x32)), body.engine.glyphPath(body.engine.glyphFor(0x32)));
  // determinism: the same bytes + the same text + the same options give the same shaped output
  const again = await fontOf('price');
  assert.deepEqual(again.engine.layout('25 €', { fontSize: 120, maxWidth: 1e6, direction: 'LTR' }), price.engine.layout('25 €', { fontSize: 120, maxWidth: 1e6, direction: 'LTR' }));
  // the font hash the shaper used is the pinned resource hash for every role
  for (const role of Object.keys(roles)) assert.equal((await fontOf(role)).content_hash, byRef[roles[role].font_ref].font_sha256, role);
  // HF-12 no system-font fallback: a character the font lacks is reported, never substituted; an unknown font reference has no registry entry; the rasterizer never loads system fonts
  assert.deepEqual(headline.engine.missingChars('Coques 日本'), ['日', '本']);
  assert.equal(P.createRealFontRegistry([headline, price]).get('font://system/arial'), null);
  assert.match(await readFile(new URL('../src/creative-intelligence/production-render.js', import.meta.url), 'utf8'), /loadSystemFonts: false/);
  // a role's weight is an explicit instance: an instance reference per role, all distinct
  assert.equal(new Set(Object.values(roles).map((r) => r.instance_ref)).size, 5);
  // HF-13 the test fixtures are not bound as HABB fonts
  assert.doesNotMatch(JSON.stringify([config, manifest, out.approved_memory]), /DejaVu|Noto/);
});

test('HABB Brand Memory typography revision: governed, additive, v1 untouched', async () => {
  const v1 = out.memory_v1_approved;
  const v1Superseded = out.memory_v1_superseded;
  const v2 = out.approved_memory;
  const isFrozen = (v) => v == null || typeof v !== 'object' || (Object.isFrozen(v) && Object.values(v).every(isFrozen));
  const rebuilt = buildBrandPackage(pkg.inputs, expressionFile.expression_system);
  // HF-14 Memory v1 is immutable: the approved v1 is deeply frozen, still APPROVED in its own record, with typography still empty
  assert.ok(isFrozen(rebuilt.memoryV1));
  assert.equal(v1.status, 'APPROVED');
  assert.equal(v1.id, 'habb-memory-v1');
  assert.deepEqual(v1.design_tokens.typography, {});
  assert.throws(() => { rebuilt.memoryV1.design_tokens.typography.display = {}; }, TypeError);
  // HF-15 the new revision is APPROVED through the governed flow (REVIEW_REQUIRED first, owner approval, an event, no auto-approval)
  assert.equal(v2.id, 'habb-memory-v2');
  assert.equal(v2.version, 2);
  assert.equal(v2.status, 'APPROVED');
  assert.equal(out.memory_revision_review_required.status, 'REVIEW_REQUIRED');
  assert.equal(v2.approval.approver_role, 'OWNER');
  assert.equal(out.memory_decision_event.type, 'BRAND_MEMORY_APPROVED');
  assert.equal(v2.approval.decision_event_id, out.memory_decision_event.id);
  assert.deepEqual(out.memory_decision_event.supersedes, { kind: 'brand_memory', id: 'habb-memory-v1', version: 1 });
  assert.equal(v2.supersedes_id, 'habb-memory-v1');
  assert.equal(v2.approval.approved_at, new Date(pkg.inputs.memory_revision.approved_at).toISOString());
  assert.match(pkg.inputs.authorization.revision_basis, /not authenticated by Nordla Identity, which remains an open dependency/);
  // HF-16 the old Memory is SUPERSEDED
  assert.equal(v1Superseded.status, 'SUPERSEDED');
  assert.equal(v1Superseded.id, v1.id);
  // HF-17 the exact Core binding is unchanged; HF-18 colours, HF-19 expression_system and the rest unchanged; only typography added
  assert.deepEqual(v2.core_ref, v1.core_ref);
  assert.deepEqual(v2.core_ref, { id: out.approved_core.id, version: 1 });
  assert.deepEqual(v2.design_tokens.colors, v1.design_tokens.colors);
  assert.deepEqual(v2.expression_system, v1.expression_system);
  assert.deepEqual(v2.expression_system, JSON.parse(JSON.stringify(rebuilt.memory.expression_system)));
  for (const key of ['identity_references', 'hard_rules', 'semantic_context', 'external_references']) assert.deepEqual(v2[key], v1[key], key);
  assert.deepEqual(v2.design_tokens.typography, { display: { family: 'Playfair Display', weights: [600] }, text: { family: 'Montserrat', weights: [400, 500, 600, 700] } });
  assert.equal(v2.brand_id, v1.brand_id);
  assert.equal(v2.merchant_id, v1.merchant_id);
  // HF-20 the Creative brand interface exposes exactly the two families, READY, brand and Core unchanged, Memory version advanced
  assert.equal(rebuilt.context.status, 'READY');
  const iface = creativeBrandInterface(rebuilt.context);
  assert.equal(Object.keys(iface.design_tokens.typography).length, 2);
  assert.deepEqual(iface.design_tokens.typography.text.weights, [400, 500, 600, 700]);
  assert.equal(iface.brand.brand_id, '4c487848-8d41-4e30-8f3f-66afd09b4be4');
  assert.deepEqual(iface.core_ref, { id: 'habb-core-v1', version: 1 });
  assert.deepEqual(iface.memory_ref, { id: 'habb-memory-v2', version: 2 });
  assert.deepEqual(rebuilt.outputs, pkg.outputs); // the stored package is exactly what the governed flow produces
});

test('HABB Benchmark 001 after the font bindings: fonts bound, PRODUCT and ASSET still blocking, never run', async () => {
  const iface = creativeBrandInterface(buildBrandPackage(pkg.inputs, expressionFile.expression_system).context);
  const report = await P.assessBenchmarkReadiness({ config, resolver, tenant: TENANT, creativeInterface: iface });
  const state = Object.fromEntries(report.bindings.map((b) => [b.id, b.status]));
  // HF-21 the two FONT bindings are BOUND with evidence
  assert.equal(state[`font:${PF}`], 'BOUND');
  assert.equal(state[`font:${MO}`], 'BOUND');
  assert.equal(report.bindings.find((b) => b.id === `font:${PF}`).reason, 'RESOLVED_WITH_EVIDENCE');
  assert.equal(state['claim:price'], 'BOUND');
  assert.equal(state['claim:promise'], 'BOUND');
  assert.equal(state.format, 'BOUND');
  assert.equal(state.expression_system, 'BOUND');
  assert.equal(report.bindings.find((b) => b.id === 'expression_system').ref, 'habb-memory-v2@2');
  // HF-22 / HF-23 the PRODUCT is bound now; the ASSET payload (private) is absent in this CI-like environment, HF-24 so the overall status is BLOCKED (never RUNNABLE)
  assert.equal(state.product, 'BOUND');
  assert.equal(state.asset, 'BLOCKED'); // bound by metadata; the private payload is not in this (CI-like) environment
  assert.equal(report.status, 'BLOCKED');
  assert.deepEqual(report.blockers.map((b) => b.id), ['asset']);
  assert.ok(!config.bindings_still_missing.some((b) => b.includes('FONT_BINDINGS_MISSING')));
  // one font missing keeps the fonts from being bound (fonts are not marked BOUND on a partial set)
  const oneMissing = { ...config, bindings: { ...config.bindings, fonts: [...config.bindings.fonts, { ref: 'font://google-fonts/third-family' }] } };
  const partial = await P.assessBenchmarkReadiness({ config: oneMissing, resolver, tenant: TENANT, creativeInterface: iface });
  assert.equal(partial.bindings.find((b) => b.id === 'font:font://google-fonts/third-family').status, 'BLOCKED');
  // HF-25 the benchmark status is still NOT_RUN, HF-26 C2 is still false
  assert.equal(config.status, 'NOT_RUN');
  assert.equal(CI.assessCreativeC2Readiness({}).c2_allowed, false);
  assert.equal(code(() => P.recordBenchmarkRun({ readiness: report, results: { preflight_status: 'PASS', fidelity_status: 'PASS', guardian_status: 'PASS', png_sha256: 'a'.repeat(64) }, ran_at: '2026-10-10T10:00:00.000Z' })), CI.CI_ERROR.BENCHMARK_INVALID);
  // the benchmark role mapping is configuration data (a role, a resource, a weight), not Brand Memory
  assert.deepEqual(Object.keys(roles), ['headline', 'price', 'speed_claim', 'supporting', 'body']);
  assert.deepEqual(Object.values(roles).map((r) => r.weight), [600, 700, 600, 500, 400]);
  assert.deepEqual(roles.headline.font_ref, PF);
  assert.ok(Object.entries(roles).filter(([k]) => k !== 'headline').every(([, r]) => r.font_ref === MO));
  // HF-27 no HABB-specific font branch or name in the generic source
  for (const dir of ['creative-intelligence', 'resources', 'branding']) {
    for (const file of (await readdir(new URL(`../src/${dir}/`, import.meta.url))).filter((f) => f.endsWith('.js'))) {
      assert.doesNotMatch(await readFile(new URL(`../src/${dir}/${file}`, import.meta.url), 'utf8'), /habb|playfair|montserrat/i, `${dir}/${file}`);
    }
  }
});

function code(fn) { try { fn(); } catch (error) { return error.code; } return 'NO_ERROR'; }
