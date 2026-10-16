import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';

import * as L from '../src/asset-library/index.js';

// Synthetic fixtures only: the repository is public, no real HABB file is read here.
function crc32(buf) {
  let c; let crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) { c = (crc ^ buf[n]) & 0xff; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crc = (crc >>> 8) ^ c; }
  return (crc ^ 0xffffffff) >>> 0;
}
const chunk = (type, data) => {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
};
function png(w, h, colorType = 2, seed = 0) {
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = colorType;
  const bpp = colorType === 6 ? 4 : 3;
  const raw = Buffer.alloc((w * bpp + 1) * h, seed);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

test('AL-1 image headers: png / alpha / jpeg / webp / garbage', () => {
  assert.deepEqual(L.readImageInfo(new Uint8Array(png(30, 20, 6))), { media_type: 'image/png', width_px: 30, height_px: 20, has_alpha: true });
  assert.equal(L.readImageInfo(new Uint8Array(png(30, 20, 2))).has_alpha, false);
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0, 17, 8, 0x01, 0x00, 0x02, 0x00, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]);
  assert.deepEqual(L.readImageInfo(new Uint8Array(jpeg)), { media_type: 'image/jpeg', width_px: 512, height_px: 256, has_alpha: false });
  const webp = Buffer.alloc(30); webp.write('RIFF', 0); webp.write('WEBP', 8); webp.write('VP8X', 12); webp[24] = 99; webp[27] = 49;
  assert.equal(L.readImageInfo(new Uint8Array(webp)).width_px, 100);
  assert.equal(L.readImageInfo(new Uint8Array(webp)).height_px, 50);
  assert.equal(L.readImageInfo(new Uint8Array(32)), null);
  assert.equal(L.readImageInfo('nope'), null);
});

test('AL-2 indexer: opaque refs, no path leaks, dedupe, rights stay UNVERIFIED', () => {
  const root = mkdtempSync(join(tmpdir(), 'al-'));
  mkdirSync(join(root, 'sub'));
  writeFileSync(join(root, 'a.png'), png(40, 40, 2, 1));
  writeFileSync(join(root, 'copy.png'), png(40, 40, 2, 1)); // same bytes
  writeFileSync(join(root, 'sub', 'nanobananas-123.png'), png(40, 40, 2, 2));
  writeFileSync(join(root, 'sub', 'tyeso-flair.png'), png(40, 40, 2, 3));
  writeFileSync(join(root, 'note.txt'), 'x');
  const r = L.indexFolder(root, { namespace: 'test' });
  assert.equal(r.entries.length, 3);
  assert.equal(r.duplicates.length, 1);
  assert.equal(r.skipped[0].reason, 'NOT_A_MEDIA_FILE');
  for (const e of r.entries) {
    assert.match(e.source_ref, /^private-asset:\/\/test\/[0-9a-f]{16}$/);
    assert.equal(e.rights_status, 'UNVERIFIED');
    assert.equal(e.approval_status, 'NOT_REVIEWED');
    assert.equal(JSON.stringify(e).includes(root.replaceAll('\\', '/')), false);
  }
  const byName = Object.fromEntries(r.entries.map((e) => [e.original_name, e.origin_class]));
  assert.equal(byName['nanobananas-123.png'], 'AI_GENERATED');
  assert.equal(byName['tyeso-flair.png'], 'SUPPLIER_IMAGE');
  assert.equal(byName['a.png'], 'UNCLASSIFIED');
  assert.throws(() => L.indexFolder(root, { namespace: 'Bad Name' }), TypeError);
});

function entry(over = {}) {
  const hash = over.content_hash ?? 'a'.repeat(64);
  return { asset_id: L.assetIdFor(hash), source_ref: `private-asset://t/${hash.slice(0, 16)}`, kind: 'IMAGE', stage: 'ORIGINAL', media_type: 'image/png', width_px: 1080, height_px: 1350, content_hash: hash, bytes: 10, original_name: 'x.png', ...over };
}

test('AL-3 entry contract is closed and refuses paths and unnamed decisions', () => {
  assert.throws(() => L.normalizeEntry({ ...entry(), extra: 1 }), /not part of this contract/);
  assert.throws(() => L.normalizeEntry({ ...entry(), source_ref: 'C:/Users/x/a.png' }), /opaque/);
  assert.throws(() => L.normalizeEntry({ ...entry(), rights_status: 'OWNER_CONFIRMED' }), /evidence reference/);
  assert.throws(() => L.normalizeEntry({ ...entry(), approval_status: 'APPROVED' }), /approval reference/);
  assert.throws(() => L.normalizeEntry({ ...entry(), content_hash: 'xyz' }), /sha-256/);
  assert.equal(L.normalizeEntry(entry()).origin_class, 'UNCLASSIFIED');
});

test('AL-4 publishability needs genuine origin AND owner-confirmed rights AND approval', () => {
  const lib = L.createAssetLibrary([entry({ origin_class: 'HABB_DESIGN' }), entry({ content_hash: 'b'.repeat(64), origin_class: 'SUPPLIER_IMAGE' })]);
  const [a, b] = lib.list();
  assert.deepEqual(lib.publishability(a.asset_id).reasons, ['RIGHTS_UNVERIFIED', 'APPROVAL_NOT_REVIEWED']);
  lib.recordRights(a.asset_id, 'OWNER_CONFIRMED', 'evidence://habb/owner-2026-10-16');
  assert.equal(lib.publishability(a.asset_id).publishable, false);
  lib.recordApproval(a.asset_id, 'APPROVED', 'approval://habb/owner-2026-10-16');
  assert.equal(lib.publishability(a.asset_id).publishable, true);
  assert.equal(lib.get(a.asset_id).version, 3);
  // a supplier image stays blocked by its origin even with rights + approval recorded
  lib.recordRights(b.asset_id, 'OWNER_CONFIRMED', 'evidence://habb/x');
  lib.recordApproval(b.asset_id, 'APPROVED', 'approval://habb/x');
  assert.deepEqual(lib.publishability(b.asset_id).reasons, ['ORIGIN_SUPPLIER_IMAGE']);
  assert.throws(() => lib.assertPublishable([a.asset_id, b.asset_id]), (e) => e.code === 'NOT_PUBLISHABLE' && e.detail.blocked.length === 1);
  assert.equal(lib.summary().publishable, 1);
});

test('AL-5 only a human reference records a decision; reclassify never grants rights', () => {
  const lib = L.createAssetLibrary([entry()]);
  const id = lib.list()[0].asset_id;
  assert.throws(() => lib.recordRights(id, 'OWNER_CONFIRMED', 'ok'), /approval:\/\/ or evidence:\/\//);
  assert.throws(() => lib.recordRights(id, 'UNVERIFIED', 'evidence://x/y'), /OWNER_CONFIRMED or RESTRICTED/);
  assert.throws(() => lib.recordApproval(id, 'APPROVED', 'https://evil/x'), /approval:\/\//);
  lib.reclassify(id, 'HABB_PHOTO');
  assert.equal(lib.get(id).rights_status, 'UNVERIFIED');
  assert.equal(lib.history().length, 2);
  assert.throws(() => lib.get('nope-nope-nope'), (e) => e.code === 'UNKNOWN_ASSET');
  assert.throws(() => L.createAssetLibrary([entry(), entry()]), (e) => e.code === 'DUPLICATE_ID');
});

const handoff = (over = {}) => ({
  contract: L.ASSET_HANDOFF, version: 1, asset_id: 'a-aaaaaaaaaaaaaaaa', content_hash: 'a'.repeat(64), source_ref: 'private-asset://t/aaaaaaaaaaaaaaaa', media_type: 'image/png',
  width_px: 1080, height_px: 1350, channel: 'INSTAGRAM_FEED', stage: 'CREATION', asset_version: 1, origin_class: 'HABB_DESIGN', rights_status: 'UNVERIFIED',
  approval: { status: 'NOT_REVIEWED', ref: null }, product_refs: [], derived_from: null, produced_by: 'ASSISTANT_PROPOSAL', engine_run_id: null, published: false, ...over,
});

test('AL-6 asset handoff: never published, format per channel, ready stage needs a publishable asset, engine names its run', () => {
  assert.ok(L.validateAssetHandoff(handoff()));
  assert.throws(() => L.validateAssetHandoff(handoff({ published: true })), /never publishes/);
  assert.throws(() => L.validateAssetHandoff(handoff({ height_px: 1080 })), /1080x1350/);
  assert.throws(() => L.validateAssetHandoff(handoff({ stage: 'PUBLISH_READY' })), /publishable/);
  assert.throws(() => L.validateAssetHandoff(handoff({ produced_by: 'NORDLA_ENGINE' })), /names its run/);
  assert.ok(L.validateAssetHandoff(handoff({ produced_by: 'NORDLA_ENGINE', engine_run_id: 'run-1' })));
  assert.ok(L.validateAssetHandoff(handoff({ stage: 'PUBLISH_READY', rights_status: 'OWNER_CONFIRMED', approval: { status: 'APPROVED', ref: 'approval://h/1' } })));
  assert.throws(() => L.validateAssetHandoff({ ...handoff(), extra: 1 }), /not part of the contract/);
});

test('AL-7 assetHandoffFor downgrades a not-publishable ready asset instead of lying', () => {
  const e = L.normalizeEntry(entry({ stage: 'PUBLISH_READY', origin_class: 'HABB_DESIGN' }));
  const h = L.assetHandoffFor(e, { channel: 'INSTAGRAM_FEED', produced_by: 'HUMAN_DESIGNER' });
  assert.equal(h.stage, 'CREATION');
  assert.equal(h.published, false);
});

const catalogue = new Map([['shopify:coque-iphone-13', { title: 'Coque personnalisée – Apple iPhone 13', price_eur: 25 }], ['shopify:coffret-coeur', { title: 'Coffret cadeau cœur classique', price_eur: 4.9 }]]);
const item = (i, kind, over = {}) => ({ item_id: `i${i}`, kind, channel: kind === 'POST' ? 'INSTAGRAM_FEED' : 'INSTAGRAM_STORY', day: 1, product_ref: 'shopify:coque-iphone-13', objective: 'o', concept: 'photo du produit sur fond uni', hook: 'Prêt en 5 minutes', caption: 'Coque à 25 €', asset_refs: [], asset_status: 'MISSING', claims: [], validation_status: 'PROPOSED', blockers: [], ...over });
const plan = (items) => ({ contract: L.CAMPAIGN_HANDOFF, version: 1, campaign_id: 'c1', window: { start: '2026-10-17', end: '2026-10-30' }, items, status: 'PROPOSED', execution: 'PROPOSAL_ONLY' });
const full = () => [...Array(8).keys()].map((i) => item(i, 'POST')).concat([...Array(14).keys()].map((i) => item(100 + i, 'STORY')), [...Array(3).keys()].map((i) => item(200 + i, 'REEL', { channel: 'INSTAGRAM_REEL' })));

test('AL-8 editorial plan: counts, catalogue price, forbidden motifs, unverified commercial claims', () => {
  assert.equal(L.checkEditorialPlan(plan(full()), { catalogue }).ok, true);
  const bad = full();
  bad[0] = item(0, 'POST', { caption: 'Coque à 24,90 €' });
  bad[1] = item(1, 'POST', { concept: 'cœurs dorés en arrière-plan' });
  bad[2] = item(2, 'POST', { hook: 'Livraison gratuite' });
  bad[3] = item(3, 'POST', { product_ref: 'shopify:inconnu' });
  const r = L.checkEditorialPlan(plan(bad), { catalogue });
  assert.deepEqual(r.problems.map((p) => p.code).sort(), ['FORBIDDEN_DECORATIVE_MOTIF', 'PRICE_MISMATCH', 'PRODUCT_NOT_IN_CATALOGUE', 'UNVERIFIED_COMMERCIAL_CLAIM']);
  // a heart that IS the product (owner rule 2026-08-26) is not a violation
  const heart = full(); heart[0] = item(0, 'POST', { product_ref: 'shopify:coffret-coeur', concept: 'le coffret cœur seul sur fond uni', caption: '4,90 €' });
  assert.equal(L.checkEditorialPlan(plan(heart), { catalogue }).ok, true);
  assert.equal(L.checkEditorialPlan(plan(full().slice(1)), { catalogue }).problems[0].code, 'WRONG_COUNT_POSTS');
  const fewReels = full().slice(0, -1);
  assert.equal(L.checkEditorialPlan(plan(fewReels), { catalogue }).ok, false);
  assert.equal(L.checkEditorialPlan(plan(fewReels), { catalogue, reelsBlockedReason: 'footage missing' }).ok, true);
  assert.throws(() => L.assertEditorialPlan(plan(bad), { catalogue }), (e) => e.detail.problems.length === 4);
});

test('AL-9 campaign handoff: approved needs approved claims and ready assets; execution is proposal only', () => {
  const ok = full(); ok[0] = item(0, 'POST', { validation_status: 'APPROVED', asset_refs: ['a-1'], asset_status: 'READY', claims: [{ text: 'Prêt en 5 minutes', claim_ref: null }] });
  assert.throws(() => L.validateCampaignHandoff(plan(ok)), /claim_ref/);
  ok[0].claims = [{ text: 'Prêt en 5 minutes', claim_ref: 'claim://habb/5min' }];
  assert.ok(L.validateCampaignHandoff(plan(ok)));
  ok[0].asset_status = 'MISSING';
  assert.throws(() => L.validateCampaignHandoff(plan(ok)), /ready assets/);
  assert.throws(() => L.validateCampaignHandoff({ ...plan(full()), execution: 'PUBLISH' }), /PROPOSAL_ONLY/);
  const dup = full(); dup[1].item_id = dup[0].item_id;
  assert.throws(() => L.validateCampaignHandoff(plan(dup)), /duplicate/);
});
