import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import * as R from '../src/resources/index.js';
import * as CI from '../src/creative-intelligence/index.js';
import { PAYLOAD, assetDims, documentParts, fonts as declaredFonts, solved } from './creative-intelligence-fixtures.js';

// `// PC2-N text` markers are rows of the PRE-C2 coverage matrix (docs/architecture/creative-pre-c2-foundation.md).

const M1 = '11111111-1111-4111-8111-111111111111';
const M2 = '22222222-2222-4222-8222-222222222222';
const T = { merchantId: M1 };
const code = async (promise) => { try { await promise; } catch (error) { return error.code; } return 'NO_ERROR'; };
const codeSync = (fn) => { try { fn(); } catch (error) { return error.code; } return 'NO_ERROR'; };
const isDeepFrozen = (v) => v == null || typeof v !== 'object' || (Object.isFrozen(v) && Object.values(v).every(isDeepFrozen));

const fontBytes = new Uint8Array(await readFile(new URL('./fixtures/fonts/DejaVuSans.ttf', import.meta.url)));
const fontHash = R.sha256(fontBytes);
const imageBytes = Uint8Array.from(Buffer.from(PAYLOAD.split(',')[1], 'base64'));

const formatMetadata = (over = {}) => ({
  canvas: { width: 1080, height: 1350, unit: 'px' }, medium: 'DIGITAL', safe_zones: [], forbidden_zones: [], production_constraints: [], ...over,
});
const fontMetadata = (over = {}) => ({
  family: 'DejaVu Sans', style: 'normal', weight: 400, version: '2.37', format: 'ttf', content_hash: fontHash, license_ref: 'license://dejavu-fonts', ...over,
});
const assetMetadata = (over = {}) => ({
  media_type: 'image/png', width_px: 1, height_px: 1, content_hash: R.sha256(imageBytes), origin: 'SYNTHETIC', approval_ref: null, ...over,
});
const rec = (ref, kind, over = {}) => ({
  ref, kind, merchant_id: M1, version: 1, status: 'ACTIVE', metadata: null, evidence_ref: `evidence://${kind.toLowerCase()}`, ...over,
});

const catalogue = () => R.createStaticResourceAdapter({
  adapter_id: 'catalogue',
  records: [rec('item://a', 'PRODUCT'), rec('item://b', 'CATEGORY'), rec('ghost://c', 'ASSET', { metadata: assetMetadata() }), rec('policy://p', 'POLICY', { metadata: { scope: 'promo' } })],
  payloads: { 'ghost://c': imageBytes },
});
const platform = () => R.createStaticResourceAdapter({
  adapter_id: 'platform',
  records: [
    rec('format://f', 'FORMAT', { merchant_id: null, metadata: formatMetadata() }),
    rec('font://dejavu', 'FONT', { merchant_id: null, metadata: fontMetadata() }),
  ],
  payloads: { 'font://dejavu': fontBytes },
});
const common = (...extra) => R.createCommonResourceResolver({ adapters: [catalogue(), platform(), ...extra] });

// ------------------------------------------------------------------ resolver core (1-13)

test('Common resolver: one authoritative answer from the owner, kind from the owner, scope enforced', async () => {
  const resolver = common();
  // PC2-1 an exact ACTIVE resource resolves, with its provenance
  const r = await resolver.resolve('item://a', T);
  assert.deepEqual([r.kind, r.status, r.merchant_id, r.version], ['PRODUCT', 'ACTIVE', M1, 1]);
  assert.deepEqual(Object.keys(r.provenance).sort(), ['adapter_id', 'content_hash', 'evidence_ref', 'resolver_version']);
  assert.equal(r.provenance.adapter_id, 'catalogue');
  assert.equal(r.provenance.evidence_ref, 'evidence://product');
  assert.ok(isDeepFrozen(r));
  // PC2-2 a reference nobody owns stays UNRESOLVED (no kind, never READY)
  const none = await resolver.resolve('item://nobody', T);
  assert.deepEqual([none.kind, none.status, none.provenance], [null, 'UNRESOLVED', null]);
  assert.equal(await code(resolver.require('item://nobody', 'PRODUCT', T)), R.RES_ERROR.NOT_ACTIVE);
  // PC2-3 a resource of another merchant is refused deterministically (and a merchant-less asset too)
  const foreign = R.createCommonResourceResolver({ adapters: [R.createStaticResourceAdapter({ adapter_id: 'other', records: [rec('x://1', 'ASSET', { merchant_id: M2, metadata: assetMetadata() }), rec('x://2', 'CLAIM', { merchant_id: null, metadata: { approved_wording: 'w', approval_ref: 'approval://1' } })] })] });
  assert.equal(await code(foreign.resolve('x://1', T)), R.RES_ERROR.CROSS_MERCHANT);
  assert.equal(await code(foreign.resolve('x://2', T)), R.RES_ERROR.CROSS_MERCHANT);
  assert.equal(await code(foreign.resolve('x://1', { merchantId: M2 })), 'NO_ERROR'); // its owner can
  // PC2-4 two owner adapters resolving the same reference is a conflict, never a pick
  const twin = R.createStaticResourceAdapter({ adapter_id: 'twin', records: [rec('item://a', 'PRODUCT')] });
  assert.equal(await code(common(twin).resolve('item://a', T)), R.RES_ERROR.CONFLICT);
  assert.equal(codeSync(() => R.createCommonResourceResolver({ adapters: [catalogue(), catalogue()] })), R.RES_ERROR.DUPLICATE_ADAPTER);
  // PC2-5 the kind comes from the owner, not from the text of the reference
  const liar = R.createCommonResourceResolver({ adapters: [R.createStaticResourceAdapter({ adapter_id: 'liar', records: [rec('product://really-an-asset', 'ASSET', { metadata: assetMetadata() }), rec('asset://really-a-category', 'CATEGORY')] })] });
  assert.equal((await liar.resolve('product://really-an-asset', T)).kind, 'ASSET');
  assert.equal((await liar.resolve('asset://really-a-category', T)).kind, 'CATEGORY');
  assert.equal(await code(liar.require('product://really-an-asset', 'PRODUCT', T)), R.RES_ERROR.KIND_MISMATCH);
  // PC2-6 FORMAT resolves through the same common resolver (no separate format resolver)
  const format = await resolver.require('format://f', 'FORMAT', T);
  assert.deepEqual(Object.keys(format.metadata).sort(), ['canvas', 'forbidden_zones', 'medium', 'production_constraints', 'safe_zones']);
  assert.deepEqual(format.metadata.canvas, { width: 1080, height: 1350, unit: 'px' });
  assert.equal(format.merchant_id, null);
  // PC2-7 a FORMAT cannot state a channel
  // PC2-8 a FORMAT cannot state a placement
  // PC2-9 a FORMAT cannot state an aspect ratio as truth
  for (const key of ['channel', 'placement', 'aspect_ratio']) {
    assert.equal(codeSync(() => R.normalizeFormatMetadata({ ...formatMetadata(), [key]: 'X' })), R.RES_ERROR.METADATA_INVALID, key);
  }
  assert.equal(codeSync(() => R.normalizeFormatMetadata({ ...formatMetadata(), canvas: { width: 1, height: 1, unit: 'px', aspect_ratio: '1:1' } })), R.RES_ERROR.METADATA_INVALID);
  // PC2-10 a non-px FORMAT resolves truthfully, but the current Creative intake refuses it (it converts nothing)
  const mm = R.createCommonResourceResolver({ adapters: [R.createStaticResourceAdapter({ adapter_id: 'p', records: [rec('format://a4', 'FORMAT', { merchant_id: null, metadata: formatMetadata({ canvas: { width: 210, height: 297, unit: 'mm' }, medium: 'PHYSICAL' }) })] })] });
  const mmFormat = await mm.require('format://a4', 'FORMAT', T);
  assert.equal(mmFormat.metadata.canvas.unit, 'mm');
  const { buildM3World } = await import('./creative-intelligence-m3-world.js');
  const world = buildM3World();
  assert.equal(codeSync(() => CI.buildIntakeFromHandoff({ handoff: world.handoff, deliverable_ref: world.imageSpec.deliverable_id, resolved_format: { ...mmFormat, ref: world.imageSpec.format_ref }, created_at: '2026-10-09T10:30:00Z' })), CI.CI_ERROR.CANVAS_INVALID);
  // PC2-11 a FONT payload never enters a DesignDocument: the document holds the canonical ref only
  const payload = await resolver.loadPayload('font://dejavu', T);
  assert.equal(payload.bytes.length, fontBytes.length);
  const doc = solved().document;
  assert.ok(!JSON.stringify(doc).includes(fontHash));
  assert.ok(!JSON.stringify(doc).includes('DejaVu'));
  assert.ok(!('bytes' in doc) && !JSON.stringify(await resolver.resolve('font://dejavu', T)).includes('bytes'));
  // PC2-12 a raw URL is never an identity: refused before any adapter is asked
  let asked = 0;
  const spy = R.createCommonResourceResolver({ adapters: [{ adapter_id: 'spy', supported_kinds: ['ASSET'], resolve: () => { asked += 1; return null; } }] });
  for (const url of ['https://cdn.example.com/a.png', 'data:image/png;base64,AAAA', 'file:///etc/passwd', 'blob:abc', 'cdn.example.com/a.png']) {
    assert.equal(await code(spy.resolve(url, T)), R.RES_ERROR.INVALID_REFERENCE, url);
  }
  assert.equal(asked, 0);
  // PC2-13 revoked, expired or restricted resources are returned as such and are never usable
  const states = R.createCommonResourceResolver({ adapters: [R.createStaticResourceAdapter({ adapter_id: 's', records: ['REVOKED', 'EXPIRED', 'RESTRICTED'].map((status) => rec(`s://${status}`, 'PRODUCT', { status })) })] });
  for (const status of ['REVOKED', 'EXPIRED', 'RESTRICTED']) {
    assert.equal((await states.resolve(`s://${status}`, T)).status, status);
    assert.equal(await code(states.require(`s://${status}`, 'PRODUCT', T)), R.RES_ERROR.NOT_ACTIVE, status);
    assert.equal(await code(states.loadPayload(`s://${status}`, T)), R.RES_ERROR.NOT_ACTIVE, status);
  }
});

// ------------------------------------------------------------------ extra rows (62-)

test('Common resolver: adapters stay honest, evidence is mandatory, payloads are verified and ephemeral', async () => {
  const resolver = common();
  // PC2-62 an adapter may only answer for the kinds it declared
  const overreach = { adapter_id: 'overreach', supported_kinds: ['ASSET'], resolve: async (r) => ({ ref: r, kind: 'PRODUCT', merchant_id: M1, version: 1, status: 'ACTIVE', metadata: null, evidence_ref: 'evidence://x' }) };
  assert.equal(await code(R.createCommonResourceResolver({ adapters: [overreach] }).resolve('a://b', T)), R.RES_ERROR.ADAPTER_KIND_UNDECLARED);
  // PC2-63 an ACTIVE resource without an evidence reference is refused (no evidence, no readiness)
  const noEvidence = R.createCommonResourceResolver({ adapters: [R.createStaticResourceAdapter({ adapter_id: 'ne', records: [rec('a://b', 'PRODUCT', { evidence_ref: null })] })] });
  assert.equal(await code(noEvidence.resolve('a://b', T)), R.RES_ERROR.EVIDENCE_REQUIRED);
  // PC2-64 only FONT and FORMAT may be platform-level
  assert.deepEqual([...R.PLATFORM_LEVEL_KINDS].sort(), ['FONT', 'FORMAT']);
  assert.deepEqual([...R.PAYLOAD_KINDS].sort(), ['ASSET', 'FONT']);
  // PC2-65 an adapter outage is a refusal, never "not found"
  const down = { adapter_id: 'down', supported_kinds: ['ASSET'], resolve: async () => { throw new Error(['sk', 'live', '1234567890'].join('_')); } };
  const failure = await R.createCommonResourceResolver({ adapters: [down] }).resolve('a://b', T).catch((e) => e);
  assert.equal(failure.code, R.RES_ERROR.ADAPTER_FAILED);
  assert.ok(!(failure.message + JSON.stringify(failure.detail)).includes('sk_live'));
  // PC2-66 a payload is checked against the content hash its owner declared
  const asset = await resolver.loadPayload('ghost://c', T);
  assert.equal(asset.content_hash, R.sha256(imageBytes));
  const tampered = R.createCommonResourceResolver({ adapters: [R.createStaticResourceAdapter({ adapter_id: 't', records: [rec('a://b', 'ASSET', { metadata: assetMetadata() })], payloads: { 'a://b': Uint8Array.from([1, 2, 3]) } })] });
  assert.equal(await code(tampered.loadPayload('a://b', T)), R.RES_ERROR.PAYLOAD_HASH_MISMATCH);
  // PC2-67 only an ASSET or a FONT has a payload
  assert.equal(await code(resolver.loadPayload('item://a', T)), R.RES_ERROR.KIND_MISMATCH);
  assert.equal(await code(resolver.loadPayload('format://f', T)), R.RES_ERROR.KIND_MISMATCH);
  // PC2-68 the common resolver satisfies the Creative consumer boundary (and resolveIntakeResources) with no adapter
  const boundary = CI.createResourceBoundary({ resolver: resolver.asBoundaryResolver() });
  const viaBoundary = await boundary.require('item://a', ['PRODUCT'], T);
  assert.equal(viaBoundary.provenance.adapter_id, 'catalogue');
  assert.equal(viaBoundary.kind, 'PRODUCT');
  assert.equal(await code(boundary.require('item://nobody', ['PRODUCT'], T)), CI.CI_ERROR.RESOURCE_NOT_ACTIVE);
  // PC2-69 provenance carries the adapter, the evidence, the version and the content hash
  const font = await resolver.resolve('font://dejavu', T);
  assert.equal(font.provenance.content_hash, fontHash);
  assert.equal(font.version, 1);
  assert.equal(font.provenance.resolver_version, R.RESOURCE_RESOLVER_VERSION);
  // PC2-70 a CLAIM carries its approved wording AND the reference of its approval
  assert.equal(codeSync(() => R.normalizeClaimMetadata({ approved_wording: '19,90 €' })), R.RES_ERROR.INVALID_REFERENCE);
  assert.equal(codeSync(() => R.normalizeClaimMetadata({ approved_wording: '19,90 €', approval_ref: 'https://x.test/a' })), R.RES_ERROR.INVALID_REFERENCE);
  assert.equal(R.normalizeClaimMetadata({ approved_wording: '19,90 €', approval_ref: 'approval://p1' }).approved_wording, '19,90 €');
  // PC2-71 free metadata (POLICY, PRODUCT...) can never carry a location or a payload
  assert.equal(codeSync(() => R.normalizeMetadata('POLICY', { preview: 'https://x.test/a.png' })), R.RES_ERROR.METADATA_LOCATION);
  assert.equal(codeSync(() => R.normalizeMetadata('PRODUCT', { n: [{ blob: 'data:image/png;base64,AAAA' }] })), R.RES_ERROR.METADATA_LOCATION);
  assert.deepEqual(R.normalizeMetadata('POLICY', { scope: 'promo' }), { scope: 'promo' });
  // PC2-72 FONT and ASSET metadata are strict (hash, version, licence reference; no URL)
  assert.equal(codeSync(() => R.normalizeFontMetadata({ ...fontMetadata(), content_hash: 'abc' })), R.RES_ERROR.METADATA_INVALID);
  assert.equal(codeSync(() => R.normalizeFontMetadata({ ...fontMetadata(), license_ref: 'https://x.test/l' })), R.RES_ERROR.INVALID_REFERENCE);
  assert.equal(R.normalizeFontMetadata({ ...fontMetadata(), license_ref: null }).license_ref, null);
  assert.equal(codeSync(() => R.normalizeAssetMetadata({ ...assetMetadata(), url: 'x' })), R.RES_ERROR.METADATA_INVALID);
  // PC2-73 the resolver core performs no network access and never reads a reference to decide what it names
  for (const file of ['resolver.js', 'metadata.js', 'adapters.js', 'constants.js']) {
    const text = await readFile(new URL(`../src/resources/${file}`, import.meta.url), 'utf8');
    assert.doesNotMatch(text, /\bfetch\(|node:http|node:https|node:net|process\.env|\.startsWith\(|\.split\(['"]:\/\//, file);
  }
  // PC2-74 the declared Creative fixtures still work: declared-metrics fonts and the document fixtures are untouched
  assert.ok(declaredFonts().get('font:synthetic-sans'));
  assert.ok(documentParts() && assetDims());
});
