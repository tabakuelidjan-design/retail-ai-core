import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';

import { buildSocialProposal, writeDeliveryPackage, lintClaimsLikeE } from '../src/asset-library/index.js';
import { encodeJpeg } from '../src/studio-compose/index.js';

// D -> E. Part 1 always runs (D's own mirror of E's rules). Part 2 runs E's REAL code against D's output when E's checkout is available
// (SOCIAL_E_DIR, or the sibling worktree); the CI workflow of this branch checks E's branch out for exactly that. Synthetic data only.
const sha = (b) => createHash('sha256').update(b).digest('hex');
const jpeg = (seed) => { const px = new Uint8Array(16 * 16 * 4); for (let i = 0; i < px.length; i++) px[i] = i % 4 === 3 ? 255 : (i * seed) & 255; return encodeJpeg({ width: 16, height: 16, pixels: px }); };
const CONFIRMED = [{ excerpts: ['25 €', '25,00 €'], requires: 'coque' }];
const asset = (bytes, over = {}) => ({ ref: 'asset://habb-chantier-d/test/a', version: 1, sha256: sha(bytes), content_type: 'image/jpeg', width: 1080, height: 1350, ai_generated: false, alt_text: 'une coque de téléphone', ...over });
const base = (bytes, over = {}) => ({ proposal_id: 'habb-test:1', subject: { kind: 'product', ref: 'shopify:coque', label: 'Coque' }, asset: asset(bytes), caption: 'Ta photo, ta coque. Coque personnalisée : 25 €.', hashtags: ['Namur'], targets: [{ platform: 'instagram', format: 'IMAGE' }], ...over });

test('SP-1 proposal: schema, producer, ai flag, alt text, jpeg for Instagram images, fingerprint format', () => {
  const b = jpeg(3);
  const p = buildSocialProposal(base(b), { confirmed: CONFIRMED });
  assert.equal(p.schema, 'social-post-proposal.v1');
  assert.equal(p.producer, 'chantier-d');
  assert.equal(p.asset.ai_generated, false);
  assert.throws(() => buildSocialProposal(base(b, { asset: asset(b, { content_type: 'image/png' }) }), { confirmed: CONFIRMED }), /JPEG only/);
  assert.throws(() => buildSocialProposal(base(b, { asset: asset(b, { ai_generated: undefined }) }), { confirmed: CONFIRMED }), /ai_generated/);
  assert.throws(() => buildSocialProposal(base(b, { asset: asset(b, { alt_text: '' }) }), { confirmed: CONFIRMED }), /alt_text/);
  assert.equal(buildSocialProposal(base(b, { asset: asset(b, { ai_generated: true }) }), { confirmed: CONFIRMED }).asset.ai_generated, true);
  assert.throws(() => buildSocialProposal(base(b, { asset: asset(b, { sha256: 'abc' }) }), { confirmed: CONFIRMED }), /fingerprint/);
  assert.throws(() => buildSocialProposal(base(b, { targets: [{ platform: 'instagram', format: 'IMAGE' }, { platform: 'instagram', format: 'IMAGE' }] }), { confirmed: CONFIRMED }), /duplicate/);
  assert.throws(() => buildSocialProposal(base(b, { targets: [{ platform: 'facebook', format: 'REEL' }] }), { confirmed: CONFIRMED }), /does not support/);
  assert.throws(() => buildSocialProposal(base(b, { suggested_date: '2026-10-21 17:00' }), { confirmed: CONFIRMED }), /ISO instant/);
});

test('SP-2 claims: only the owner-confirmed coque price passes; any other price, discount, delay or guarantee is refused', () => {
  const b = jpeg(4);
  assert.ok(buildSocialProposal(base(b), { confirmed: CONFIRMED }));
  for (const bad of ['Gourde à 28,90 €.', 'Coque à 23,50 €.', '-20 % cette semaine', 'Livraison gratuite', 'Prête en 24 h', 'Le moins cher de Namur']) {
    assert.throws(() => buildSocialProposal(base(b, { caption: `Coque personnalisée. ${bad}` }), { confirmed: CONFIRMED }), (e) => e.detail.claims?.length > 0, bad);
  }
  assert.equal(lintClaimsLikeE('Prête en environ 5 minutes, selon le modèle.', { confirmed: CONFIRMED }).length, 0);
  assert.equal(lintClaimsLikeE('25 € pour une gourde', { confirmed: CONFIRMED }).length, 1);
});

test('SP-3 story needs no caption; a feed image does; carousel needs 2 to 10 assets', () => {
  const b = jpeg(5);
  assert.ok(buildSocialProposal(base(b, { caption: '', targets: [{ platform: 'instagram', format: 'STORY' }] }), { confirmed: CONFIRMED }));
  assert.throws(() => buildSocialProposal(base(b, { caption: '' }), { confirmed: CONFIRMED }), /caption is required/);
  assert.throws(() => buildSocialProposal({ ...base(b), asset: undefined, targets: [{ platform: 'instagram', format: 'CAROUSEL' }] }, { confirmed: CONFIRMED }), /2 to 10/);
});

test('SP-4 delivery package: E asset-library layout, fingerprint of every asset checked, refuses a proposal naming an undelivered asset', () => {
  const b = jpeg(6); const dir = mkdtempSync(join(tmpdir(), 'pkg-'));
  const p = buildSocialProposal(base(b), { confirmed: CONFIRMED });
  const out = writeDeliveryPackage(dir, { proposals: [p], files: [{ ref: p.asset.ref, version: 1, content_type: 'image/jpeg', bytes: b }] });
  assert.deepEqual(out, { proposals: 1, assets: 1 });
  const index = JSON.parse(readFileSync(join(dir, 'assets', 'index.json'), 'utf8'));
  assert.equal(index.assets[0].sha256, p.asset.sha256);
  assert.ok(existsSync(join(dir, 'assets', 'files', `${p.asset.sha256}.jpg`)));
  assert.throws(() => writeDeliveryPackage(mkdtempSync(join(tmpdir(), 'pkg-')), { proposals: [p], files: [] }), /not delivered/);
  assert.throws(() => writeDeliveryPackage(mkdtempSync(join(tmpdir(), 'pkg-')), { proposals: [p], files: [{ ref: p.asset.ref, version: 1, content_type: 'image/jpeg', bytes: jpeg(7) }] }), /not delivered/);
});

// ---- Part 2: E's real code ---------------------------------------------------------------------------------------------------------
const E_DIR = process.env.SOCIAL_E_DIR ?? resolve(import.meta.dirname, '../../retail-ai-core-social-e-wt');
const haveE = existsSync(join(E_DIR, 'src/social/service.js'));
const maybe = haveE ? test : test.skip;
const load = (f) => import(pathToFileURL(join(E_DIR, 'src/social', f)).href);

maybe('SE-1 E accepts the D package: created, submitted for review, delivered bytes verified, nothing approved or scheduled by D', async () => {
  const { createMemoryStore } = await load('store.js');
  const { createSocialService } = await load('service.js');
  const { createAssetLibrary } = await load('assets.js');
  const post = await load('post.js');
  const b1 = jpeg(11); const b2 = jpeg(12);
  const a1 = asset(b1, { ref: 'asset://habb-chantier-d/test/one' }); const a2 = asset(b2, { ref: 'asset://habb-chantier-d/test/two', height: 1920 });
  const proposals = [
    buildSocialProposal(base(b1, { proposal_id: 'habb-test:one', asset: a1, targets: [{ platform: 'instagram', format: 'IMAGE' }, { platform: 'facebook', format: 'IMAGE' }], suggested_date: '2026-10-21T17:00:00+02:00' }), { confirmed: CONFIRMED }),
    buildSocialProposal(base(b2, { proposal_id: 'habb-test:two', asset: a2, caption: '', targets: [{ platform: 'instagram', format: 'STORY' }], suggested_date: '2026-10-22T09:00:00+02:00' }), { confirmed: CONFIRMED }),
  ];
  const dir = mkdtempSync(join(tmpdir(), 'e-'));
  writeDeliveryPackage(dir, { proposals, files: [{ ref: a1.ref, version: 1, content_type: 'image/jpeg', bytes: b1 }, { ref: a2.ref, version: 1, content_type: 'image/jpeg', bytes: b2 }] });
  const confirmed = [{ id: 'coque-25', excerpts: ['25 €', '25,00 €'], requires: 'coque', source: 'test', confirmed_at: '2026-08-05' }];
  const service = createSocialService({ store: createMemoryStore(), confirmedFacts: confirmed });
  const delivered = JSON.parse(readFileSync(join(dir, 'proposals.json'), 'utf8'));
  const report = await service.importProposals(delivered, { id: 'chantier-d', role: 'agent' });
  assert.deepEqual(report.map((r) => r.result), ['CREATED', 'CREATED', 'CREATED']);
  assert.ok(report.every((r) => !r.problems), JSON.stringify(report));
  const posts = await service.list();
  assert.equal(posts.length, 3);
  assert.ok(posts.every((p) => p.state === 'READY_FOR_REVIEW'), posts.map((p) => p.state).join());
  assert.ok(posts.every((p) => !p.approval && !p.publication), 'D must not approve or publish');
  await assert.rejects(() => service.act(posts[0].id, 'approve', { id: 'chantier-d', role: 'agent' }, { content_hash: service.contentHashOf(posts[0]) }));
  const lib = createAssetLibrary(join(dir, 'assets'));
  for (const p of posts) {
    const a = p.asset;
    const got = await lib.register({ ref: a.ref, version: a.version, file: join(dir, 'assets/files', `${a.sha256}.jpg`) });
    assert.equal(got.sha256, a.sha256);
  }
  const again = await service.importProposals(delivered, { id: 'chantier-d', role: 'agent' });
  assert.deepEqual(again.map((r) => r.result), ['UNCHANGED', 'UNCHANGED', 'UNCHANGED']);
  for (const p of posts) assert.deepEqual(post.readinessProblems(p, { confirmed }), []);
  assert.deepEqual(post.autoPublishBlockers(posts.find((p) => p.platform === 'instagram' && p.format === 'IMAGE')), []);
  assert.deepEqual(post.autoPublishBlockers(posts.find((p) => p.format === 'STORY')), ['FORMAT_STORY_IS_MANUAL_IN_V1']);
});

maybe('SE-2 what the D mirror refuses, E refuses too (no drift on the claim rules)', async () => {
  const post = await load('post.js');
  const confirmed = [{ id: 'coque-25', excerpts: ['25 €'], requires: 'coque' }];
  for (const caption of ['Coque personnalisée : 25 €.', 'Gourde à 28,90 €.', 'Prête en environ 5 minutes, selon le modèle.', '-20 % sur tout', 'Livraison gratuite', 'Prête en 24 h']) {
    const mine = lintClaimsLikeE(caption, { confirmed }).length > 0;
    const theirs = post.lintClaims({ caption, hashtags: [] }, { confirmed }).length > 0;
    assert.equal(mine, theirs, caption);
  }
});
