import test from 'node:test';
import assert from 'node:assert/strict';

import { BrainError } from '../src/creative-brain/validation.js';
import {
  buildCopyAdaptInstruction, buildCopyWriteInstruction, CLAIM_WORDS, COPY_ADAPT_RULES, COPY_WRITE_RULES, createCopyAdapter, createCopyWriter, verifyAdaptation, verifyGeneration,
} from '../src/creative-planning/index.js';
import { fact, priceFact, scriptedCopyPort } from './creative-planning-world.js';

// THE COPY POLICY (`// CP-N` markers): an adapted or a generated text is checked by deterministic guards before it can enter a plan.

const adapt = (source, adapted, capacityChars = 1000) => verifyAdaptation({ source, adapted, capacityChars });
const generate = (generated, facts, usedRefs, purpose = 'HEADLINE', capacityChars = 1000) => verifyGeneration({ generated, facts, usedRefs, purpose, capacityChars });

test('CP-1 a faithful condensation passes; each kind of unfaithfulness has its own code', () => {
  const source = 'Notre coque personnalisée à 25 € est imprimée à Namur, prête en 5 minutes. Contactez @habb_be ou https://habb.be.';
  assert.deepEqual(adapt(source, 'Coque personnalisée à 25 €, imprimée à Namur en 5 minutes. @habb_be https://habb.be'), []);
  assert.deepEqual(adapt(source, 'Coque à 30 € en 5 minutes. @habb_be https://habb.be'), ['FIGURE_CHANGED']);
  assert.deepEqual(adapt(source, 'Coque à 25 imprimée à Namur en 5 minutes. @habb_be https://habb.be'), ['SYMBOL_CHANGED']);
  assert.deepEqual(adapt(source, 'Coque à 25 € à Namur en 5 minutes. @autre https://habb.be'), ['LINK_OR_HANDLE_CHANGED']);
  assert.deepEqual(adapt(source, 'Coque à 25 € imprimée à Bruxelles en 5 minutes. @habb_be https://habb.be'), ['NEW_NAME']);
  assert.deepEqual(adapt(source, 'La meilleure coque à 25 € en 5 minutes. @habb_be https://habb.be'), ['NEW_CLAIM_WORD']);
  assert.ok(adapt(source, '').includes('EMPTY'));
  assert.ok(adapt(source, 'x'.repeat(2000), 100).includes('TOO_LONG'));
});

test('CP-2 negations are not flipped, in any of the four languages', () => {
  assert.deepEqual(adapt('Ce produit ne contient pas de plastique.', 'Produit sans plastique.'), []);
  assert.deepEqual(adapt('Ce produit ne contient pas de plastique.', 'Produit en plastique.'), ['NEGATION_CHANGED']);
  assert.deepEqual(adapt('Dit product bevat geen plastic.', 'Product met plastic.'), ['NEGATION_CHANGED']);
  assert.deepEqual(adapt('Das Produkt enthält kein Plastik.', 'Das Produkt enthält Plastik.'), ['NEGATION_CHANGED']);
  assert.deepEqual(adapt('This is not waterproof.', 'This is waterproof.'), ['NEGATION_CHANGED']);
});

test('CP-3 a claim word may stay if the source has it, but never appears from nowhere (English, French, Dutch, German)', () => {
  for (const [source, ok, bad] of [
    ['Our cases are handmade in Namur.', 'Handmade cases from Namur.', 'Guaranteed cases from Namur.'],
    ['Nos coques sont fabriquées à Namur.', 'Coques fabriquées à Namur.', 'Coques certifiées à Namur.'],
    ['Onze hoesjes zijn gratis te testen.', 'Gratis te testen.', 'Bewezen hoesjes.'],
    ['Unsere Hüllen sind handgemacht.', 'Handgemachte Hüllen.', 'Zertifiziert handgemacht und exklusiv.'],
  ]) {
    assert.deepEqual(adapt(source, ok), [], ok);
    assert.ok(adapt(source, bad).length > 0, bad);
  }
  assert.ok(CLAIM_WORDS.length > 50 && CLAIM_WORDS.every((w) => w === w.toLowerCase()));
});

test('CP-4 generation rests on the facts it cites: a figure, a link, a name, a claim or a price from nowhere is refused', () => {
  const facts = [fact(), priceFact()];
  assert.deepEqual(generate('Coques personnalisées prêtes en cinq minutes', facts, ['fact://descr']), []);
  assert.deepEqual(generate('Coque personnalisée : 25 €', facts, ['fact://price']), []);
  assert.deepEqual(generate('Coque personnalisée : 25 €', facts, ['fact://descr']), ['FIGURE_NOT_IN_A_FACT', 'PRICE_NOT_FROM_A_PRICE_FACT']);
  assert.deepEqual(generate('Prête en 5 minutes', facts, ['fact://descr']), ['FIGURE_NOT_IN_A_FACT']);
  assert.deepEqual(generate('Voir habb.be et @habb_be', facts, ['fact://descr']), ['LINK_OR_HANDLE_NOT_IN_A_FACT']);
  assert.deepEqual(generate('Une idée de Madame Dupont', facts, ['fact://descr']), ['NAME_NOT_IN_A_FACT']);
  assert.deepEqual(generate('La meilleure coque garantie', facts, ['fact://descr']), ['CLAIM_WORD_NOT_IN_A_FACT']);
  assert.deepEqual(generate('Coque personnalisée', facts, []), ['USES_NO_FACT']);
  assert.deepEqual(generate('Coque', facts, ['fact://other']), ['USES_A_FACT_IT_WAS_NOT_GIVEN']);
  assert.deepEqual(generate('Découvrez-la', facts, [], 'CTA'), []);
  assert.deepEqual(generate('Découvrez-la pour 9 €', facts, [], 'CTA'), ['FIGURE_NOT_IN_A_FACT', 'PRICE_NOT_FROM_A_PRICE_FACT']);
  assert.ok(generate('x'.repeat(50), facts, ['fact://descr'], 'HEADLINE', 10).includes('TOO_LONG'));
});

test('CP-5 the instructions state every rule of their contract, and the answer is a closed contract', async () => {
  const a = buildCopyAdaptInstruction({ source: 'Texte', role: 'HEADLINE', capacityChars: 100, locale: 'fr' });
  const w = buildCopyWriteInstruction({ purpose: 'HEADLINE', facts: [fact()], objective: 'UNKNOWN', audience: 'UNKNOWN', capacityChars: 100, locale: 'fr' });
  for (const r of COPY_ADAPT_RULES) assert.ok(a.system.includes(`RULE ${r.id}: ${r.statement}`), r.id);
  for (const r of COPY_WRITE_RULES) assert.ok(w.system.includes(`RULE ${r.id}: ${r.statement}`), r.id);
  assert.ok(a.system.includes('answer.text') && a.system.includes('answer.rationale') && w.system.includes('answer.uses_fact_refs'));
  assert.deepEqual(JSON.parse(a.user), { role: 'HEADLINE', locale: 'fr', character_limit: 100, source_text: 'Texte' });
  const port = scriptedCopyPort('adapt', [{ text: 'Court', rationale: 'ok', extra: 1 }, { text: 'Court', rationale: 'ok', surprise: 'x' }, '{"text": 5, "rationale": "ok"}']);
  const adapter = createCopyAdapter({ complete: port.complete });
  for (let i = 0; i < 3; i += 1) await assert.rejects(adapter.adapt({ source: 'Texte long', role: 'HEADLINE', capacityChars: 50, locale: 'fr' }), BrainError);
});

test('CP-6 an adapter or writer whose port fails raises a BrainError with safe diagnostics only', async () => {
  const adapter = createCopyAdapter({ complete: async () => { throw Object.assign(new Error('key sk-secret in the message'), { code: 'UPSTREAM' }); } });
  await assert.rejects(adapter.adapt({ source: 'x', role: 'HEADLINE', capacityChars: 10, locale: 'fr' }), (e) => e instanceof BrainError && e.code === 'BRAIN_PORT_FAILED' && !JSON.stringify(e).includes('sk-secret'));
  const writer = createCopyWriter({ complete: async () => ({ text: 'not json' }) });
  await assert.rejects(writer.write({ purpose: 'HEADLINE', facts: [fact()], objective: 'UNKNOWN', audience: 'UNKNOWN', capacityChars: 50, locale: 'fr' }), (e) => e instanceof BrainError);
});

test('CP-7 FUZZ: a text is always faithful to itself, and no single appended figure or claim word survives', () => {
  const mulberry = (seed) => () => { let t = (seed += 0x6D2B79F5); t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const r = mulberry(99);
  const bits = ['Notre atelier', 'imprime vos photos', 'à Namur', 'en 5 minutes', 'pour 25 €', 'sans plastique', 'avec @habb_be', 'Venez nous voir', 'sur https://habb.be', 'les mardis'];
  for (let n = 0; n < 200; n += 1) {
    const source = `${Array.from({ length: 2 + Math.floor(r() * 5) }, () => bits[Math.floor(r() * bits.length)]).join(', ')}.`;
    assert.deepEqual(adapt(source, source), [], source);
    assert.ok(adapt(source, `${source} 7`).includes('FIGURE_CHANGED'));
    assert.ok(adapt(source, `${source} Garantie`).includes('NEW_CLAIM_WORD'));
  }
});
