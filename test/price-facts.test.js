import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { lintPriceChannel, buildSocialProposal } from '../src/asset-library/index.js';

// The price of a coque is two dated, sourced facts (shop, web). Proposed entries for chantier E's registry: docs/chantier-d/e-proposals/confirmed-facts-prices.json.
const file = JSON.parse(readFileSync(new URL('../docs/chantier-d/e-proposals/confirmed-facts-prices.json', import.meta.url), 'utf8'));
const [shop, web] = file.facts;

test('PF-1 the proposed entries are dated and sourced, carry the verified value, and keep no other price', () => {
  for (const f of file.facts) {
    assert.match(f.id, /^coque-25-(boutique|web)$/);
    assert.match(f.confirmed_at, /^\d{4}-\d{2}-\d{2}$/);
    assert.ok(f.source.length > 40, 'a source is stated');
    assert.equal(f.verified_value, '25.00 EUR');
    assert.deepEqual(f.excerpts, ['25 €', '25,00 €']);
    assert.equal(f.requires, 'coque');
  }
  assert.equal(shop.channel, 'IN_STORE');
  assert.equal(web.channel, 'WEB');
  assert.match(web.source, /Shopify Admin GraphQL/);
  assert.match(web.source, /83 products/);
  assert.match(web.source, /2026-10-17/);
  assert.equal(/\d{2}[.,]\d{2}/.test(JSON.stringify(file).replace(/25[.,]00/g, '')), false, 'no other price in the file');
});

test('PF-2 a price names its channel: both channels confirmed -> either is accepted, none is refused; only the shop confirmed -> an online claim is refused', () => {
  const both = [shop, web];
  const ok = (t, facts) => lintPriceChannel(t, { confirmed: facts }).length === 0;
  assert.ok(ok('Coque personnalisée : 25 € en boutique.', both));
  assert.ok(ok('Coque personnalisée : 25 € en ligne.', both));
  assert.ok(ok('Coque personnalisée 25 €. Prix en boutique.', both));
  assert.equal(ok('Coque personnalisée : 25 €.', both), false);
  assert.ok(ok('Coque personnalisée : 25 € en boutique.', [shop]));
  assert.equal(ok('Coque personnalisée : 25 € en ligne.', [shop]), false); // web copy waits for the web fact
  assert.ok(ok('Une coque personnalisée, prête en environ 5 minutes.', both)); // no price: nothing to say
});

test('PF-3 D will not emit web-price copy without the WEB fact in the registry it is given', () => {
  const base = { proposal_id: 'd:price', subject: { kind: 'product', ref: 'x', label: 'Coque' }, asset: { ref: 'asset://t/p', version: 1, sha256: 'a'.repeat(64), content_type: 'image/jpeg', width: 1080, height: 1350, ai_generated: false, alt_text: 'x' }, hashtags: [], targets: [{ platform: 'facebook', format: 'IMAGE' }], caption: 'Coque personnalisée : 25 € en ligne.' };
  assert.throws(() => buildSocialProposal(base, { confirmed: [shop] }), /shop price or the web price/);
  assert.ok(buildSocialProposal(base, { confirmed: [shop, web] }));
});

const E_DIR = process.env.SOCIAL_E_DIR ?? resolve(import.meta.dirname, '../../retail-ai-core-social-e-wt');
const maybe = existsSync(join(E_DIR, 'src/social/post.js')) ? test : test.skip;

maybe('PF-4 chantier E\'s own claim filter accepts a caption covered by these entries and blocks it without them (extra keys are ignored by E)', async () => {
  const { lintClaims } = await import(pathToFileURL(join(E_DIR, 'src/social/post.js')).href);
  const post = { caption: 'Coque personnalisée : 25 € en ligne.', hashtags: [] };
  assert.deepEqual(lintClaims(post, { confirmed: file.facts }), []);
  assert.ok(lintClaims(post, { confirmed: [] }).length > 0);
  assert.ok(lintClaims({ caption: 'Coque personnalisée : 23,50 € en ligne.', hashtags: [] }, { confirmed: file.facts }).length > 0);
});
