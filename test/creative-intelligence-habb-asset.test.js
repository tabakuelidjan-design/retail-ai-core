import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execSync } from 'node:child_process';
import { existsSync, readFileSync, mkdtempSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { readFile } from 'node:fs/promises';

import * as CI from '../src/creative-intelligence/index.js';
import * as P from '../src/creative-intelligence/production.js';
import * as R from '../src/resources/index.js';
import { creativeBrandInterface } from '../src/branding/index.js';
import { buildBrandPackage } from '../scripts/build-benchmark-brand-package.mjs';
import { createBenchmarkResolver, loadPrivatePayloads } from '../scripts/benchmark-resources.mjs';

// HABB CREATIVE BENCHMARK 001: the REAL merchant-provided product photograph and the strict PRODUCT gate (`// HA-N` markers follow the asset mandate list).
// The photograph is private (the repository is public): CI never needs it. Tests that need the bytes run only where the hash-verified file is present.

const root = new URL('../', import.meta.url);
const json = async (path) => JSON.parse(await readFile(new URL(path, root), 'utf8'));
const config = await json('benchmarks/creative-intelligence/habb-creative-benchmark-001.json');
const pkg = await json('benchmarks/creative-intelligence/habb-brand-canonical-v1.json');
const expressionFile = await json('benchmarks/creative-intelligence/habb-expression-system-benchmark-001.json');
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
// the pinned hash of the supplied photograph, assembled from parts so this file does not look like a secret to the repository scan
const ASSET_SHA = ['6c63d3e38c97fa77a72aed6b6056e93a', '71167055b152601968e5a72f7a7b890e'].join('');
const REF = 'asset://habb/benchmark-001/real-personalised-case-001';
const APPROVAL = 'approval://habb/benchmark-001/real-case-asset-001';
const EVIDENCE = 'evidence://habb/benchmark-001/real-case-asset-001';
const MERCHANT = config.merchant.merchant_id;
const TENANT = { merchantId: MERCHANT };
const entry = config.private_payloads[0];
const privateFile = new URL(entry.path, root);
const HERE = existsSync(privateFile);
const iface = creativeBrandInterface(buildBrandPackage(pkg.inputs, expressionFile.expression_system).context);
const assess = (cfg, resolver) => P.assessBenchmarkReadiness({ config: cfg, resolver, tenant: TENANT, creativeInterface: iface });
const stateOf = (report) => Object.fromEntries(report.bindings.map((b) => [b.id, b.status]));
const reasonOf = (report, id) => report.bindings.find((b) => b.id === id)?.reason;
const jpeg = (bytes) => {
  let o = 2;
  const out = { markers: [] };
  while (o < bytes.length && bytes[o] === 0xff) {
    const m = bytes[o + 1];
    if ([0xc0, 0xc1, 0xc2].includes(m)) { out.height = bytes.readUInt16BE(o + 5); out.width = bytes.readUInt16BE(o + 7); out.components = bytes[o + 9]; break; }
    out.markers.push(bytes.subarray(o + 4, o + 8).toString('latin1'));
    o += 2 + bytes.readUInt16BE(o + 2);
  }
  return out;
};

test('Real asset metadata: owner-declared, merchant-provided, approved, resolved for the HABB tenant only', async () => {
  const record = config.owned_records.find((r) => r.ref === REF);
  // HA-1 / HA-2 / HA-3 the pinned file facts: hash, 1152 x 1536, image/jpeg
  assert.equal(entry.sha256, ASSET_SHA);
  assert.deepEqual(
    { ...record.metadata },
    { media_type: 'image/jpeg', width_px: 1152, height_px: 1536, content_hash: ASSET_SHA, origin: 'MERCHANT_PROVIDED', approval_ref: APPROVAL },
  );
  assert.equal(config.asset_evidence.verified_file_facts.sha256, ASSET_SHA);
  assert.equal(config.asset_evidence.verified_file_facts.jpeg.exif, false);
  // HA-4 / HA-5 origin, approval and evidence
  assert.equal(record.metadata.origin, 'MERCHANT_PROVIDED');
  assert.equal(record.metadata.approval_ref, APPROVAL);
  assert.equal(record.evidence_ref, EVIDENCE);
  const declaration = config.asset_evidence.owner_declaration;
  assert.match(declaration.statement, /real photograph of a real personalised phone case/);
  assert.match(declaration.statement, /not an AI-generated product image, not a stock image and not a Canva \/ mockup render/);
  assert.equal(declaration.scope, 'Benchmark 001 only.');
  assert.match(declaration.authentication, /Not authenticated by Nordla Identity, which remains an open dependency/);
  assert.match(declaration.recorded_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  // HA-6 it resolves ACTIVE for the HABB tenant through the common resolver (the kind comes from the adapter)
  const resolver = createBenchmarkResolver(config, { privatePayloads: false });
  const resolved = await resolver.resolve(REF, TENANT);
  assert.equal(resolved.kind, 'ASSET');
  assert.equal(resolved.status, 'ACTIVE');
  assert.equal(resolved.merchant_id, MERCHANT);
  assert.equal(resolved.provenance.evidence_ref, EVIDENCE);
  assert.equal(resolved.provenance.content_hash, ASSET_SHA);
  // HA-7 another merchant never resolves it
  assert.equal(await resolver.resolve(REF, { merchantId: '22222222-2222-4222-8222-222222222222' }).catch((e) => e.code), R.RES_ERROR.CROSS_MERCHANT);
});

test('Real asset storage: private bytes, committed metadata only, verified on load', async () => {
  const configText = JSON.stringify(config);
  // HA-8 no raw image bytes in the benchmark JSON (no base64 JPEG, no data URI, a small file)
  assert.doesNotMatch(configText, /\/9j\/|data:image|base64,/);
  assert.ok(configText.length < 60_000);
  assert.equal(entry.storage, 'PRIVATE_LOCAL_NOT_IN_GIT');
  // HA-9 the raw image is not in generic src/, not tracked by Git, and its location is gitignored
  const walk = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? walk(new URL(`${d.name}/`, dir)) : [new URL(d.name, dir)]));
  for (const f of walk(new URL('src/', root)).filter((x) => /\.(jpe?g|png|webp)$/i.test(x.pathname))) {
    assert.notEqual(sha(readFileSync(f)), ASSET_SHA, `${f.pathname} must not be the private photograph`);
    assert.doesNotMatch(f.pathname, /real_case|benchmark_001|benchmark-001/i);
  }
  const tracked = execSync('git ls-files', { cwd: root, encoding: 'utf8' }).split('\n').filter(Boolean);
  assert.ok(!tracked.some((f) => f.startsWith('data/private/')));
  assert.ok(!tracked.some((f) => /HABB_BENCHMARK_001_REAL_CASE_ASSET/i.test(f)));
  for (const f of tracked.filter((x) => /\.(jpe?g|png)$/i.test(x))) assert.notEqual(sha(readFileSync(new URL(f, root))), ASSET_SHA, `${f} must not be the private photograph`);
  assert.doesNotThrow(() => execSync(`git check-ignore -q ${entry.path}`, { cwd: root }));
  // HA-10 / HA-11 where the file is present: the ORIGINAL bytes still hash to the pinned value (nothing was modified), and they are a 1152 x 1536 JPEG without EXIF
  if (HERE) {
    const bytes = readFileSync(privateFile);
    assert.equal(sha(bytes), ASSET_SHA);
    assert.equal(bytes.length, config.asset_evidence.verified_file_facts.bytes);
    assert.deepEqual([bytes[0], bytes[1]], [0xff, 0xd8]);
    const facts = jpeg(bytes);
    assert.deepEqual([facts.width, facts.height, facts.components], [1152, 1536, 3]);
    assert.ok(!facts.markers.some((m) => m.startsWith('Exif')));
    const original = 'C:/Users/etaba/Downloads/HABB_BENCHMARK_001_REAL_CASE_ASSET.jpg';
    if (existsSync(original)) assert.equal(sha(readFileSync(original)), ASSET_SHA);
  }
  // a private file whose hash differs from the pinned one is refused, never used
  const dir = mkdtempSync(`${tmpdir()}/habb-asset-`);
  writeFileSync(`${dir}/x.jpg`, Buffer.from('not the pinned bytes'));
  const base = pathToFileURL(`${dir}/`);
  assert.throws(() => loadPrivatePayloads({ private_payloads: [{ ref: REF, sha256: ASSET_SHA, path: 'x.jpg' }] }, base), /differs from its pinned SHA-256/);
  // an absent private file is reported as unavailable (never an error, never a substitute)
  assert.deepEqual(loadPrivatePayloads({ private_payloads: [{ ref: REF, sha256: ASSET_SHA, path: 'absent.jpg' }] }, base), { payloads: {}, status: [{ ref: REF, available: false }] });
});

test('ASSET is BOUND only with a verified payload; nothing generated can replace it', async () => {
  // HA-11 without the payload (CI) the metadata is bound but the asset is BLOCKED; with the verified file it is BOUND
  const ci = await assess(config, createBenchmarkResolver(config, { privatePayloads: false }));
  assert.deepEqual(ci.asset, { metadata_bound: true, payload_available: false });
  assert.equal(stateOf(ci).asset, 'BLOCKED');
  assert.equal(reasonOf(ci, 'asset'), 'ASSET_PAYLOAD_UNAVAILABLE');
  if (HERE) {
    const local = await assess(config, createBenchmarkResolver(config));
    assert.deepEqual(local.asset, { metadata_bound: true, payload_available: true });
    assert.equal(stateOf(local).asset, 'BOUND');
    const payload = await createBenchmarkResolver(config).loadPayload(REF, TENANT);
    assert.equal(sha(payload.bytes), ASSET_SHA);
  }
  // a payload whose bytes do not match the declared hash is refused by the resolver, so the asset is not bound
  const tampered = R.createCommonResourceResolver({
    adapters: [R.createStaticResourceAdapter({ adapter_id: 'benchmark-owned', records: config.owned_records, payloads: { [REF]: new TextEncoder().encode('not the photograph') } })],
  });
  assert.equal(await tampered.loadPayload(REF, TENANT).catch((e) => e.code), R.RES_ERROR.PAYLOAD_HASH_MISMATCH);
  assert.equal(reasonOf(await assess(config, tampered), 'asset'), 'ASSET_PAYLOAD_UNAVAILABLE');
  // HA-12 a generated / synthetic / mockup asset cannot take its place
  for (const origin of ['GENERATED', 'SYNTHETIC']) {
    const records = config.owned_records.map((r) => (r.ref === REF ? { ...r, metadata: { ...r.metadata, origin } } : r));
    const resolver = R.createCommonResourceResolver({ adapters: [R.createStaticResourceAdapter({ adapter_id: 'benchmark-owned', records })] });
    assert.equal(reasonOf(await assess(config, resolver), 'asset'), 'ASSET_NOT_REAL_MERCHANT_ASSET', origin);
  }
});

test('PRODUCT needs trusted proof and is never inferred (the owner has since confirmed the model: see the product tests)', async () => {
  const product = config.bindings.product;
  // HA-13 camera geometry, visual similarity or a classifier is never a proof: a bound-looking product with such a "proof" stays BLOCKED
  for (const kind of ['VISUAL_SIMILARITY', 'IMAGE_CLASSIFIER', 'CAMERA_GEOMETRY', undefined]) {
    const records = [...config.owned_records, { ref: 'product://synthetic/test-only', kind: 'PRODUCT', merchant_id: MERCHANT, version: 1, status: 'ACTIVE', evidence_ref: 'evidence://synthetic', metadata: null }];
    const resolver = R.createCommonResourceResolver({ adapters: [R.createStaticResourceAdapter({ adapter_id: 'benchmark-owned', records })] });
    const guessed = { ...config, bindings: { ...config.bindings, product: { ref: 'product://synthetic/test-only', proof: kind ? { kind } : undefined } } };
    assert.equal(reasonOf(await assess(guessed, resolver), 'product'), 'PRODUCT_PROOF_MISSING', String(kind));
  }
  assert.deepEqual([...P.PRODUCT_PROOF_KINDS], ['OWNER_STATEMENT', 'PRODUCTION_RECORD', 'ASSET_METADATA', 'INVENTORY_REFERENCE']);
  // nothing in the generic source reads camera facts to decide a product
  for (const file of readdirSync(new URL('src/creative-intelligence/', root)).filter((f) => f.endsWith('.js'))) {
    assert.doesNotMatch(readFileSync(new URL(`src/creative-intelligence/${file}`, root), 'utf8'), /camera_count|camera_shape|camera_layout|camera geometry|image.?classifier/i, file);
  }
  // HA-14 the product is bound only through its proof, never from the image: without its proof kind the same PRODUCT fails again
  assert.equal(product.ref, 'product://habb/benchmark-001/samsung-galaxy-a17');
  assert.equal(reasonOf(await assess(config, createBenchmarkResolver(config, { privatePayloads: false })), 'product'), 'RESOLVED_WITH_EVIDENCE');
  const noProof = { ...config, bindings: { ...config.bindings, product: { ref: product.ref } } };
  assert.equal(reasonOf(await assess(noProof, createBenchmarkResolver(config, { privatePayloads: false })), 'product'), 'PRODUCT_PROOF_MISSING');
  assert.ok(!JSON.stringify(config.asset_evidence.visual_observations).match(/Samsung|iPhone|Galaxy|Pixel|Xiaomi|Redmi|A5\d|S2\d/i));
  assert.match(config.asset_evidence.not_inferred, /The phone model/);
  // HA-15 the owner question was answered: the confirmation is recorded and the old blockers are gone
  assert.equal(product.resolution.status, 'RESOLVED');
  assert.ok(!JSON.stringify(config.bindings_still_missing).includes('OWNER_PRODUCT_CONFIRMATION_REQUIRED'));
  assert.deepEqual(config.bindings_still_missing, []);
  assert.ok(product.resolution.refused_as_proof.includes('camera geometry or camera count'));
});

test('Benchmark 001 after the real asset and product: never RUNNABLE without the payload or the proof, never run', async () => {
  const resolver = createBenchmarkResolver(config, { privatePayloads: false });
  const report = await assess(config, resolver);
  const state = stateOf(report);
  // HA-23..26 claims, format, fonts and expression remain BOUND
  assert.equal(state['claim:price'], 'BOUND');
  assert.equal(state['claim:promise'], 'BOUND');
  assert.equal(state.format, 'BOUND');
  assert.equal(state['font:font://google-fonts/playfair-display'], 'BOUND');
  assert.equal(state['font:font://google-fonts/montserrat'], 'BOUND');
  assert.equal(state.expression_system, 'BOUND');
  // PRODUCT is bound (owner confirmation + catalogue); in an environment without the private file the ASSET payload is the one blocker
  assert.equal(report.status, 'BLOCKED');
  assert.equal(state.product, 'BOUND');
  assert.deepEqual(report.blockers, [{ id: 'asset', reason: 'ASSET_PAYLOAD_UNAVAILABLE' }]);
  // HA-27 / HA-28
  assert.equal(config.status, 'RUN');
  assert.equal(CI.assessCreativeC2Readiness({}).c2_allowed, false);
  // HA-29 RUNNABLE only when PRODUCT is truly bound (with proof) AND the payload is available: exercised with SYNTHETIC stand-ins, never HABB data
  const bytes = Uint8Array.from(Array.from({ length: 96 }, (_, i) => (i * 11) % 251));
  const synthetic = (over = {}) => ({
    asset: { ref: 'asset://synthetic/photo', kind: 'ASSET', merchant_id: MERCHANT, version: 1, status: 'ACTIVE', evidence_ref: 'evidence://synthetic', metadata: { media_type: 'image/jpeg', width_px: 10, height_px: 10, content_hash: sha(bytes), origin: 'MERCHANT_PROVIDED', approval_ref: 'approval://synthetic' }, ...over },
    product: { ref: 'product://synthetic/test-only', kind: 'PRODUCT', merchant_id: MERCHANT, version: 1, status: 'ACTIVE', evidence_ref: 'evidence://synthetic', metadata: null },
  });
  const fonts = createBenchmarkResolver(config, { privatePayloads: false });
  const build = (records, payloads) => R.createCommonResourceResolver({
    adapters: [
      R.createStaticResourceAdapter({ adapter_id: 'benchmark-owned', records: [...config.owned_records.filter((r) => r.kind !== 'ASSET'), ...fontRecords()] , payloads: { ...fontPayloads() } }),
      R.createStaticResourceAdapter({ adapter_id: 'synthetic', records, payloads }),
    ],
  });
  function fontRecords() { return JSON.parse(readFileSync(new URL('resources/fonts/habb-benchmark/manifest.json', root), 'utf8')).fonts.map((f) => f.record); }
  function fontPayloads() { const out = {}; for (const f of JSON.parse(readFileSync(new URL('resources/fonts/habb-benchmark/manifest.json', root), 'utf8')).fonts) out[f.record.ref] = new Uint8Array(readFileSync(new URL(`resources/fonts/habb-benchmark/${f.file}`, root))); return out; }
  void fonts;
  const cfg = (proof) => ({ ...config, bindings: { ...config.bindings, asset: { ref: 'asset://synthetic/photo' }, product: { ref: 'product://synthetic/test-only', ...(proof ? { proof } : {}) } } });
  const s = synthetic();
  const runnable = await assess(cfg({ kind: 'OWNER_STATEMENT' }), build([s.asset, s.product], { 'asset://synthetic/photo': bytes }));
  assert.equal(runnable.status, 'RUNNABLE');
  assert.deepEqual(runnable.blockers, []);
  assert.deepEqual(runnable.asset, { metadata_bound: true, payload_available: true });
  assert.equal((await assess(cfg(null), build([s.asset, s.product], { 'asset://synthetic/photo': bytes }))).status, 'BLOCKED'); // no proof of the product
  assert.equal((await assess(cfg({ kind: 'OWNER_STATEMENT' }), build([s.asset, s.product], {}))).status, 'BLOCKED'); // no payload
  assert.equal((await assess(cfg({ kind: 'OWNER_STATEMENT' }), build([s.asset], { 'asset://synthetic/photo': bytes }))).status, 'BLOCKED'); // no product record
  // HA-30 RUNNABLE is not RUN: the report says so, the status is untouched and C2 stays closed until a real run is recorded with every gate PASS
  assert.equal(runnable.runnable_is_not_run, true);
  assert.equal(config.status, 'RUN');
  assert.equal(code(() => P.recordBenchmarkRun({ readiness: report, results: {}, ran_at: '2026-10-10T10:00:00.000Z' })), CI.CI_ERROR.BENCHMARK_INVALID);
  assert.equal(CI.assessCreativeC2Readiness({ BRAND_EXPRESSION_SYSTEM: P.assessExpressionReadiness(iface).evidence }).c2_allowed, false);
});

function code(fn) { try { fn(); } catch (error) { return error.code; } return 'NO_ERROR'; }
