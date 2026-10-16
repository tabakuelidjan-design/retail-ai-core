import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';

import { buildSocialProposal } from '../src/asset-library/index.js';

// `alternative_to` (D -> E). Part 1: what D emits. Part 2: E's behaviour WITH THE PROPOSED PATCH (docs/chantier-d/e-proposals/alternative-to.patch). E's own files are never modified:
// the patch is applied to a throw-away checkout (the CI does it on its own checkout of E; locally, point SOCIAL_E_DIR at a patched COPY). Without the patch, Part 2 is skipped by design.
const sha = (s) => createHash('sha256').update(s).digest('hex');
const CONFIRMED = [{ excerpts: ['25 €'], requires: 'coque', channel: 'IN_STORE' }];
const mk = (id, over = {}) => ({
  proposal_id: id, subject: { kind: 'product', ref: 'shopify:coque', label: 'Coque' },
  asset: { ref: `asset://t/${id}`, version: 1, sha256: sha(id), content_type: 'image/jpeg', width: 1080, height: 1350, ai_generated: false, alt_text: 'une coque' },
  caption: 'Votre photo, votre coque. Coque personnalisée : 25 € en boutique.', hashtags: ['Namur'], targets: [{ platform: 'instagram', format: 'IMAGE' }, { platform: 'facebook', format: 'IMAGE' }], suggested_date: '2026-10-19T12:00:00+02:00', ...over,
});

test('AT-1 D emits alternative_to: sorted, de-duplicated, at most 5, never itself; absent when there is none', () => {
  const p = buildSocialProposal(mk('d:D1', { alternative_to: ['habb-editorial-2026-10-16:P02', 'habb-editorial-2026-10-16:P01', 'habb-editorial-2026-10-16:P01'] }), { confirmed: CONFIRMED });
  assert.deepEqual(p.alternative_to, ['habb-editorial-2026-10-16:P01', 'habb-editorial-2026-10-16:P02']);
  assert.equal('alternative_to' in buildSocialProposal(mk('d:D2'), { confirmed: CONFIRMED }), false);
  assert.throws(() => buildSocialProposal(mk('d:D1', { alternative_to: ['d:D1'] }), { confirmed: CONFIRMED }), /alternative_to/);
  assert.throws(() => buildSocialProposal(mk('d:D1', { alternative_to: ['a:1x', 'a:2x', 'a:3x', 'a:4x', 'a:5x', 'a:6x'] }), { confirmed: CONFIRMED }), /at most 5/);
});

test('AT-2 D refuses a shop price that does not say it is the shop price, and a promise of a checking process', () => {
  assert.throws(() => buildSocialProposal(mk('d:D1', { caption: 'Votre coque personnalisée : 25 €.' }), { confirmed: CONFIRMED }), /shop price or the web price/);
  assert.ok(buildSocialProposal(mk('d:D1'), { confirmed: CONFIRMED }));
  assert.throws(() => buildSocialProposal(mk('d:D1', { caption: 'Votre coque. On vérifie votre fichier avant impression.' }), { confirmed: CONFIRMED }), /checking process/);
  assert.throws(() => buildSocialProposal(mk('d:D1', { caption: 'Votre coque personnalisée : 24,90 € en ligne.' }), { confirmed: CONFIRMED }), /nobody confirmed/);
});

const E_DIR = process.env.SOCIAL_E_DIR ?? resolve(import.meta.dirname, '../../retail-ai-core-social-e-wt');
const patched = existsSync(join(E_DIR, 'src/social/exclusivity.js'));
const maybe = patched ? test : test.skip;
const load = (f) => import(pathToFileURL(join(E_DIR, 'src/social', f)).href);

maybe('AT-3 with the proposed E patch, the variants D really emits cannot be approved together, whatever the import order, and survive a re-import', async () => {
  const { createMemoryStore } = await load('store.js');
  const { createSocialService } = await load('service.js');
  const confirmed = [{ id: 'coque-25', excerpts: ['25 €'], requires: 'coque', source: 'owner', confirmed_at: '2026-08-05' }];
  const D = { id: 'chantier-d', role: 'agent' }; const OWNER = { id: 'owner:habb', role: 'owner' };
  const original = (id) => ({ ...buildSocialProposal(mk(id, { caption: 'Votre photo sur votre coque, prête en environ 5 minutes.' }), { confirmed: CONFIRMED }) });
  const variant = (id, of) => buildSocialProposal(mk(id, { alternative_to: [of] }), { confirmed: CONFIRMED });
  for (const order of ['original-first', 'variant-first']) {
    const service = createSocialService({ store: createMemoryStore(), confirmedFacts: confirmed });
    const o = original('habb-editorial-2026-10-16:P01'); const v = variant('habb-chantier-d-visuel:D1', 'habb-editorial-2026-10-16:P01');
    await service.importProposals(order === 'original-first' ? [o, v] : [v, o], D);
    const posts = await service.list();
    const slot = (proposal, platform) => posts.find((p) => p.origin.proposal_id === proposal && p.platform === platform);
    const approve = async (id) => service.act(id, 'approve', OWNER, { expected_hash: service.contentHashOf(await service.get(id)) });
    await approve(slot(o.proposal_id, 'instagram').id);
    await assert.rejects(() => approve(slot(v.proposal_id, 'instagram').id), (e) => e.code === 'SOCIAL_CONFLICT');
    await approve(slot(o.proposal_id, 'facebook').id);
    await assert.rejects(() => approve(slot(v.proposal_id, 'facebook').id), (e) => e.code === 'SOCIAL_CONFLICT');
    const re = await service.importProposals([o, v], D);
    assert.ok(re.every((r) => r.result === 'UNCHANGED'), JSON.stringify(re));
    await assert.rejects(() => approve(slot(v.proposal_id, 'instagram').id), (e) => e.code === 'SOCIAL_CONFLICT');
  }
});
