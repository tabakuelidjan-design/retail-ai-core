import test from 'node:test';
import assert from 'node:assert/strict';

import {
  normalizeArtDirection, normalizeConceptSet, substituteWordsIn, SUBSTITUTE_LEXICON,
} from '../src/creative-brain/index.js';
import {
  detectSubstitutes, familiesOf, isSafeText, PRODUCT_FAMILIES, productNameWords, PRODUCT_REASON, PRODUCT_STATUS, resolveProductIdentity,
} from '../src/creative-production/index.js';
import { artDirectionAnswer, CONCEPTS } from './creative-brain-world.js';
import { campaignBrief } from './creative-campaign-world.js';
import { produced } from './creative-production-world.js';
import { createHash } from 'node:crypto';

// THE ATTEMPT 12 SUBSTITUTE-DETECTION ISSUE (`// SD-N` markers). The scene plan of Attempt 12 asked for "a bare polymer shell resting on a worn wooden counter, half its surface still untouched": an unfinished
// version of the product, which the generator drew as a large white hero object three times. The lexicon of the time did not know the word. The detection is now RELATIVE to the product, an unverified product is an
// explicit state, and a requested product is never replaced by a visually similar one.

const ATTEMPT_12 = [
  'A bare polymer shell resting on a worn wooden counter, half its surface still untouched',
  'A pool of focused light on the counter',
  'A faint human silhouette emerging in wet ink on the shell\'s surface',
  'A worn wooden shop counter',
  'A small brass alignment guide',
  'Soft dust particles in the light',
  'A folded personal photograph lying flat beside the curing station',
];
const concept = normalizeConceptSet(CONCEPTS)[0];
const element = (text) => ({ element: text, reason: 'they show the maker has just finished, the care taken in the making', zone: 'BACKGROUND' });
const refused = (text) => { try { normalizeArtDirection(artDirectionAnswer({ narrative_elements: [element(text)] }), { concept }); return false; } catch (e) { return e.code === 'BRAIN_FORBIDDEN_CONTENT'; } };
const identity = (over = {}) => resolveProductIdentity({ brief: { ...campaignBrief(), ...over } });

test('SD-1 REGRESSION: the exact scene of Attempt 12 is refused where it holds a look-alike of the product, and only there', () => {
  assert.deepEqual(ATTEMPT_12.map((t) => substituteWordsIn(t).length > 0), [true, false, true, false, false, false, false]);
  assert.deepEqual(ATTEMPT_12.map(refused), [true, false, true, false, false, false, false], 'the art direction contract refuses them too');
  const id = identity();
  assert.deepEqual(ATTEMPT_12.map((t) => detectSubstitutes({ text: t, identity: id }).length > 0), [true, false, true, false, false, false, false]);
});

test('SD-2 each word that names a look-alike of the product, or an unfinished version of it, is refused on its own, in the lexicon and in a narrative element', () => {
  const lookAlikes = SUBSTITUTE_LEXICON.product_look_alikes;
  assert.deepEqual([...lookAlikes], ['shell', 'housing', 'casing', 'sleeve', 'bumper', 'blank', 'polymer', 'silicone', 'protector', 'étui', 'boîtier', 'hoesje', 'unprinted', 'unfinished', 'half finished']);
  for (const word of lookAlikes) {
    assert.deepEqual(substituteWordsIn(`a quiet ${word} on the bench`), [word], word);
    if (!word.includes(' ')) assert.equal(substituteWordsIn(`two quiet ${word}s on the bench`).length, 1, `${word} (plural)`);
    assert.ok(refused(`a quiet ${word} on the bench`), `${word} (element)`);
  }
  assert.deepEqual(substituteWordsIn('a half-finished piece'), ['half finished']);
  assert.deepEqual(substituteWordsIn('worn wood, brass, linen, paper, light, dust, a cup of tea, a window'), [], 'ordinary things of a scene are not refused');
});

test('SD-3 the detection is relative to the product: the objects of its family are refused for it and only for it', () => {
  const phone = identity();
  assert.equal(phone.family, 'PROTECTIVE_CASE');
  const bottle = identity({ public_facts: { product: 'Gourde isotherme en acier' } });
  assert.equal(bottle.family, 'DRINKWARE');
  for (const word of PRODUCT_FAMILIES.PROTECTIVE_CASE.words) assert.ok(detectSubstitutes({ text: `a ${word} on the bench`, identity: phone }).length > 0, `${word} for a case`);
  for (const word of PRODUCT_FAMILIES.DRINKWARE.words) assert.ok(detectSubstitutes({ text: `a ${word} on the bench`, identity: bottle }).length > 0, `${word} for a bottle`);
  assert.equal(detectSubstitutes({ text: 'a glass bottle on the bench', identity: phone }).length, 0, 'a bottle is a fine prop beside a phone case');
  assert.equal(detectSubstitutes({ text: 'a worn leather sleeve of notes', identity: bottle }).length > 0, true, 'the Brain lexicon applies to every product');
  assert.deepEqual(detectSubstitutes({ text: 'a bottle and a bumper', identity: phone }).map((h) => [h.kind, h.words]), [['LEXICON', ['bumper']]]);
  assert.deepEqual(detectSubstitutes({ text: 'a flask', identity: bottle }).map((h) => h.kind), ['FAMILY']);
});

test('SD-4 the words that name the product are refused in any layer text', () => {
  const id = identity({ public_facts: { product: 'Plaque céramique personnalisée' } });
  assert.deepEqual(productNameWords('Plaque céramique personnalisée'), ['plaque', 'céramique', 'personnalisée']);
  assert.deepEqual(detectSubstitutes({ text: 'a ceramic tray', identity: id }).map((h) => h.kind), []);
  assert.ok(detectSubstitutes({ text: 'a céramique bowl', identity: id }).some((h) => h.kind === 'PRODUCT_NAME'));
  assert.deepEqual(productNameWords('A'), []); assert.deepEqual(productNameWords(''), []);
  assert.equal(isSafeText('a worn wooden counter', id), true); assert.equal(isSafeText('a plaque on the wall', id), false);
});

test('SD-5 product families come from the words of the description; two families make the product ambiguous', () => {
  assert.deepEqual(familiesOf('Coque personnalisée pour téléphone'), ['PROTECTIVE_CASE']);
  assert.deepEqual(familiesOf('Gourde en acier'), ['DRINKWARE']);
  assert.deepEqual(familiesOf('Cadre photo en bambou'), ['FRAMED_PRINT']);
  assert.deepEqual(familiesOf('Coffret cadeau'), ['GIFT_BOX']);
  assert.deepEqual(familiesOf('Un objet sans nom connu'), []);
  assert.deepEqual(familiesOf('Gourde et coque assorties').sort(), ['DRINKWARE', 'PROTECTIVE_CASE']);
  const ambiguous = identity({ public_facts: { product: 'Gourde et coque assorties' } });
  assert.equal(ambiguous.status, PRODUCT_STATUS.AMBIGUOUS); assert.ok(ambiguous.reasons.includes(PRODUCT_REASON.PRODUCT_DESCRIPTION_MATCHES_SEVERAL_FAMILIES)); assert.equal(ambiguous.family, null);
});

test('SD-6 the product identity is VERIFIED only when it is pinned and traceable; everything else is an explicit state with its reasons', () => {
  const ok = identity();
  assert.equal(ok.status, PRODUCT_STATUS.VERIFIED); assert.deepEqual(ok.reasons, []); assert.match(ok.identity_id, /^pid_/); assert.ok(Object.isFrozen(ok));
  assert.equal(ok.product_ref, 'product://test/runtime-case'); assert.equal(ok.asset_ref, 'asset://test/runtime/real-case'); assert.equal(ok.sha256.length, 64); assert.ok(ok.protected_region_count > 0);
  const cases = [
    ['no product reference', { ids: {} }, PRODUCT_STATUS.MISSING, PRODUCT_REASON.NO_PRODUCT_REFERENCE],
    ['no asset', { asset: {} }, PRODUCT_STATUS.MISSING, PRODUCT_REASON.NO_PRODUCT_ASSET],
    ['not described', { public_facts: {} }, PRODUCT_STATUS.AMBIGUOUS, PRODUCT_REASON.PRODUCT_NOT_DESCRIBED],
    ['not pinned', { asset: { ...campaignBrief().asset, sha256: undefined } }, PRODUCT_STATUS.AMBIGUOUS, PRODUCT_REASON.ASSET_NOT_PINNED],
    ['no outline', { identity_annotations: {} }, PRODUCT_STATUS.UNSUPPORTED, PRODUCT_REASON.NO_OUTLINE_FOR_LOCAL_SEGMENTATION],
    ['a short outline', { identity_annotations: { outline: [[0, 0], [1, 1]] } }, PRODUCT_STATUS.UNSUPPORTED, PRODUCT_REASON.NO_OUTLINE_FOR_LOCAL_SEGMENTATION],
  ];
  for (const [name, over, status, reason] of cases) {
    const id = identity(over);
    assert.equal(id.status, status, name); assert.ok(id.reasons.includes(reason), `${name}: ${id.reasons}`);
  }
  assert.equal(identity({ ids: {}, asset: {} }).status, PRODUCT_STATUS.MISSING, 'missing outranks everything');
  assert.equal(identity({ public_facts: {}, identity_annotations: {} }).status, PRODUCT_STATUS.AMBIGUOUS, 'ambiguous outranks unsupported');
});

test('SD-7 bytes that are not the pinned asset, and a campaign that names another product, are ambiguous: the product is never silently another one', () => {
  const brief = campaignBrief();
  const bytes = Uint8Array.from([1, 2, 3]);
  const pinned = { ...brief, asset: { ...brief.asset, sha256: createHash('sha256').update(bytes).digest('hex') } };
  assert.equal(resolveProductIdentity({ brief: pinned, bytes }).status, PRODUCT_STATUS.VERIFIED);
  const wrong = resolveProductIdentity({ brief: pinned, bytes: Uint8Array.from([9, 9, 9]) });
  assert.equal(wrong.status, PRODUCT_STATUS.AMBIGUOUS); assert.ok(wrong.reasons.includes(PRODUCT_REASON.ASSET_BYTES_DO_NOT_MATCH_THE_PINNED_HASH));
  const other = resolveProductIdentity({ brief, campaignProductRef: 'product://another' });
  assert.equal(other.status, PRODUCT_STATUS.AMBIGUOUS); assert.ok(other.reasons.includes(PRODUCT_REASON.CAMPAIGN_NAMES_ANOTHER_PRODUCT));
  assert.equal(resolveProductIdentity({ brief, campaignProductRef: brief.ids.product_ref }).status, PRODUCT_STATUS.VERIFIED);
  assert.notEqual(wrong.identity_id, resolveProductIdentity({ brief: pinned, bytes }).identity_id);
});

test('SD-8 a production for a product that cannot be verified is INTENT_ONLY: no layer, no request, no cost, no replacement', async () => {
  for (const [name, over] of [['missing', { asset: {} }], ['ambiguous', { public_facts: {} }], ['unsupported', { identity_annotations: {} }]]) {
    const { result } = await produced({}, { productionBrief: { ...campaignBrief(), ...over } });
    assert.equal(result.status, 'INTENT_ONLY', name);
    assert.ok(result.scenes.every((s) => s.status === 'INTENT_ONLY' && s.layers.length === 0 && s.composite === null), name);
    assert.deepEqual(result.shared_layers, [], `${name}: nothing is requested from any generator`);
    assert.equal(result.production.budget.generated_layers, 0);
    assert.ok(result.scenes.every((s) => s.blocks.some((b) => b.code === 'PRODUCT_IDENTITY_NOT_VERIFIED')));
    assert.ok(result.scenes.every((s) => s.text_layers.length > 0), `${name}: the copy is kept with the intent`);
    assert.ok(result.production.blocks.some((b) => b.code === 'PRODUCT_IDENTITY_NOT_VERIFIED'));
  }
});

test('SD-9 a shared art direction that holds a look-alike blocks the whole production, with the elements named, and requests nothing', async () => {
  // an art direction that passed an older lexicon is simulated by adding the element to a valid one
  const planned = await produced({ art: {} });
  const art = planned.campaign.shared.art_direction;
  const tainted = { ...planned.campaign, shared: { ...planned.campaign.shared, art_direction: { ...art, narrative_elements: [{ element: 'a bare polymer shell on the bench', reason: art.narrative_elements[0].reason, zone: 'MIDGROUND' }, ...art.narrative_elements] } } };
  const out = await planned.planner.plan({ campaignResult: tainted, brief: planned.brief, request: planned.request });
  assert.equal(out.status, 'BLOCKED');
  const block = out.production.blocks.find((b) => b.code === 'ART_DIRECTION_HOLDS_A_SUBSTITUTE');
  assert.ok(block); assert.deepEqual(block.detail.elements.map((e) => e.element), ['a bare polymer shell on the bench']);
  assert.ok(out.scenes.every((s) => s.status === 'BLOCKED' && s.layers.length === 0)); assert.deepEqual(out.shared_layers, []);
});
