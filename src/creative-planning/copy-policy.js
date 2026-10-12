import {
  obj, list, renderContract, renderRules, text, validateAnswer,
} from '../creative-brain/contract.js';
import { askAndNormalize } from '../creative-brain/model-port.js';
import { BRAIN_ERROR, fail } from '../creative-brain/validation.js';
import { codePoints } from './text-units.js';

// THE COPY POLICY. Three modes decide what Nordla may do with a text (see COPY_MODE): LOCKED is never rewritten, ADAPTABLE may be condensed with its meaning kept, GENERATABLE may be written from
// VERIFIED facts only. Nordla never invents a price, a product claim, a legal, supplier or compliance fact, or any commercial fact.
//
// A language model may be asked to adapt or to write, behind a port, under a closed contract; its answer is then CHECKED by deterministic guards before it can enter a plan. The guards are
// conservative heuristics, not a proof of meaning: they refuse an answer that changes a figure, a link, a name, adds a claim word that the source does not hold, or flips a negation. A refused
// adaptation never reaches a plan (the text stays locked); a plan keeps every adapted or generated text marked as such, and owner approval of the result stays PENDING.

const FIGURE = /\d+(?:[.,:/]\d+)*/gu;
const SYMBOL = /[€$£%]/gu;
const HANDLE = /https?:\/\/\S*[^\s.,;:!?)\]]|[\p{L}\p{N}._+-]+@[\p{L}\p{N}-]+\.[\p{L}\p{N}.-]*[\p{L}\p{N}]|[#@][\p{L}\p{N}_]+/gu;
const CAPITALIZED = /(?<![\p{L}\p{N}])\p{Lu}\p{Ll}{2,}/gu;
const CURRENCY_AMOUNT = /(?:[€$£]\s?\d|\d\s?(?:[€$£]|eur\b|euros?\b|usd\b|dollars?\b))/iu;

// Words that state a claim, an offer or a guarantee (English, French, Dutch, German). A word of this list may appear in an adapted or generated text only if the source text (or the facts it was
// written from) already holds it. The list is conservative and extensible; it is a guard, never a license.
export const CLAIM_WORDS = Object.freeze([
  'best', 'leading', 'leader', 'guarantee', 'guaranteed', 'certified', 'official', 'officially', 'clinically', 'proven', 'free', 'organic', 'sustainable', 'handmade', 'unbreakable', 'waterproof', 'lifetime', 'discount', 'sale', 'exclusive', 'cheapest',
  'meilleur', 'meilleure', 'garanti', 'garantie', 'certifié', 'certifiée', 'officiel', 'officielle', 'prouvé', 'gratuit', 'gratuite', 'bio', 'écologique', 'écoresponsable', 'artisanal', 'fabriqué', 'incassable', 'étanche', 'promo', 'soldes', 'exclusif', 'exclusive',
  'beste', 'gegarandeerd', 'gecertificeerd', 'officieel', 'bewezen', 'gratis', 'biologisch', 'handgemaakt', 'onbreekbaar', 'waterdicht', 'korting', 'uitverkoop', 'exclusief',
  'garantiert', 'zertifiziert', 'offiziell', 'kostenlos', 'handgemacht', 'wasserdicht', 'rabatt', 'exklusiv',
]);
const NEGATIONS = Object.freeze(['not', 'no', 'never', 'without', 'ne', 'pas', 'jamais', 'sans', 'aucun', 'aucune', 'geen', 'niet', 'nooit', 'zonder', 'kein', 'keine', 'nicht', 'ohne']);

const wordsOf = (t) => String(t).toLowerCase().match(/[\p{L}\p{N}'’-]+/gu) ?? [];
// a claim word is recognised with up to two letters of inflection (a plural, a feminine, a conjugation): "certifié", "certifiées" and "certifiée" are the same claim
const claimWordsIn = (t) => new Set(wordsOf(t).map((w) => w.replace(/['’]/g, '')).map((w) => CLAIM_WORDS.find((c) => w === c || (w.startsWith(c) && w.length - c.length <= 2))).filter(Boolean));
const negationsIn = (t) => new Set(wordsOf(t).filter((w) => NEGATIONS.includes(w)));
const multiset = (list) => [...list].sort().join('\u0001');
const figuresIn = (t) => String(t).match(FIGURE) ?? [];
const symbolsIn = (t) => String(t).match(SYMBOL) ?? [];
const handlesIn = (t) => String(t).match(HANDLE) ?? [];
/** Capitalized words that are not the first word of a sentence: names (a heuristic, language-dependent, and conservative). */
function namesIn(t) {
  const s = String(t); const out = new Set();
  for (const m of s.matchAll(CAPITALIZED)) {
    const before = s.slice(0, m.index).trimEnd();
    if (before === '' || /[.!?…:]$/u.test(before)) continue;
    out.add(m[0]);
  }
  return out;
}

/** @returns {string[]} problem codes: why an ADAPTED text is not acceptable as a faithful condensation of its source ([] = acceptable). */
export function verifyAdaptation({ source, adapted, capacityChars }) {
  const problems = [];
  if (!String(adapted).trim()) problems.push('EMPTY');
  if (codePoints(adapted) > capacityChars) problems.push('TOO_LONG');
  if (multiset(figuresIn(adapted)) !== multiset(figuresIn(source))) problems.push('FIGURE_CHANGED');
  if (multiset(symbolsIn(adapted)) !== multiset(symbolsIn(source))) problems.push('SYMBOL_CHANGED');
  if (multiset(handlesIn(adapted)) !== multiset(handlesIn(source))) problems.push('LINK_OR_HANDLE_CHANGED');
  const sourceNames = namesIn(source);
  if ([...namesIn(adapted)].some((n) => !sourceNames.has(n) && !String(source).includes(n))) problems.push('NEW_NAME');
  const sourceClaims = claimWordsIn(source);
  if ([...claimWordsIn(adapted)].some((w) => !sourceClaims.has(w))) problems.push('NEW_CLAIM_WORD');
  if ((negationsIn(source).size > 0) !== (negationsIn(adapted).size > 0)) problems.push('NEGATION_CHANGED');
  return problems;
}

/** @returns {string[]} problem codes: why a GENERATED text is not acceptable given only the facts it was allowed to use ([] = acceptable). */
export function verifyGeneration({ generated, facts, usedRefs, purpose, capacityChars }) {
  const problems = [];
  const base = facts.map((f) => f.statement).join(' \n ');
  if (!String(generated).trim()) problems.push('EMPTY');
  if (codePoints(generated) > capacityChars) problems.push('TOO_LONG');
  const allowed = new Set(facts.map((f) => f.fact_ref));
  if (usedRefs.some((r) => !allowed.has(r))) problems.push('USES_A_FACT_IT_WAS_NOT_GIVEN');
  if (facts.length > 0 && purpose !== 'CTA' && usedRefs.length === 0) problems.push('USES_NO_FACT');
  const used = facts.filter((f) => usedRefs.includes(f.fact_ref));
  const usedText = used.map((f) => f.statement).join(' \n ');
  const grounded = usedRefs.length ? usedText : (purpose === 'CTA' ? '' : base);
  const groundedFigures = new Set(figuresIn(grounded));
  if (figuresIn(generated).some((n) => !groundedFigures.has(n))) problems.push('FIGURE_NOT_IN_A_FACT');
  const groundedHandles = new Set(handlesIn(grounded));
  if (handlesIn(generated).some((h) => !groundedHandles.has(h))) problems.push('LINK_OR_HANDLE_NOT_IN_A_FACT');
  const groundedNames = namesIn(grounded);
  if ([...namesIn(generated)].some((n) => !groundedNames.has(n) && !grounded.includes(n))) problems.push('NAME_NOT_IN_A_FACT');
  const groundedClaims = claimWordsIn(grounded);
  if ([...claimWordsIn(generated)].some((w) => !groundedClaims.has(w))) problems.push('CLAIM_WORD_NOT_IN_A_FACT');
  if (CURRENCY_AMOUNT.test(generated) && !used.some((f) => f.kind === 'PRICE')) problems.push('PRICE_NOT_FROM_A_PRICE_FACT');
  return problems;
}

const refuse = (stage, problems) => fail(BRAIN_ERROR.RULE_VIOLATION, `${stage}: the text is refused by the copy policy`, stage, { problem: problems[0], words: problems });

// ---- the two model contracts (spec-driven: the same spec validates the answer and is stated in the instruction)
export const COPY_ADAPT_SPEC = obj({ text: text({ max: 1200 }), rationale: text() });
export const COPY_ADAPT_RULES = Object.freeze([
  { id: 'ADAPT_FITS_THE_LIMIT', statement: 'the adapted text is not longer than the character limit given in the request', check: (v, ctx) => { if (codePoints(v.text) > ctx.capacity_chars) refuse('COPY_ADAPT', ['TOO_LONG']); } },
  {
    id: 'ADAPT_KEEPS_EVERY_FIGURE_AND_LINK',
    statement: 'every number, currency sign, percentage, link, email address and hashtag of the source text stays exactly as written, and none is added',
    check: (v, ctx) => { const p = verifyAdaptation({ source: ctx.source, adapted: v.text, capacityChars: ctx.capacity_chars }).filter((c) => ['FIGURE_CHANGED', 'SYMBOL_CHANGED', 'LINK_OR_HANDLE_CHANGED'].includes(c)); if (p.length) refuse('COPY_ADAPT', p); },
  },
  {
    id: 'ADAPT_KEEPS_THE_MEANING',
    statement: 'no name, claim, guarantee, offer or negation is added, removed or reversed: you shorten and restructure, you never change what the text says',
    check: (v, ctx) => { const p = verifyAdaptation({ source: ctx.source, adapted: v.text, capacityChars: ctx.capacity_chars }).filter((c) => ['NEW_NAME', 'NEW_CLAIM_WORD', 'NEGATION_CHANGED', 'EMPTY'].includes(c)); if (p.length) refuse('COPY_ADAPT', p); },
  },
]);
export const COPY_ADAPT_CONTRACT = Object.freeze({ stage: 'COPY_ADAPT', spec: COPY_ADAPT_SPEC, rules: COPY_ADAPT_RULES });

export const COPY_WRITE_SPEC = obj({ text: text({ max: 1200 }), uses_fact_refs: list(text({ max: 200 }), { min: 0, max: 8 }), rationale: text() });
export const COPY_WRITE_RULES = Object.freeze([
  { id: 'WRITE_FITS_THE_LIMIT', statement: 'the text is not longer than the character limit given in the request', check: (v, ctx) => { if (codePoints(v.text) > ctx.capacity_chars) refuse('COPY_WRITE', ['TOO_LONG']); } },
  {
    id: 'WRITE_USES_ONLY_THE_GIVEN_FACTS',
    statement: 'the text rests only on the facts given in the request, and uses_fact_refs lists the fact_ref of every fact it uses',
    check: (v, ctx) => { const p = verifyGeneration({ generated: v.text, facts: ctx.facts, usedRefs: v.uses_fact_refs, purpose: ctx.purpose, capacityChars: ctx.capacity_chars }).filter((c) => ['USES_A_FACT_IT_WAS_NOT_GIVEN', 'USES_NO_FACT', 'EMPTY'].includes(c)); if (p.length) refuse('COPY_WRITE', p); },
  },
  {
    id: 'WRITE_INVENTS_NO_FIGURE_NAME_OR_CLAIM',
    statement: 'the text holds no number, link, name, guarantee, offer or claim word that the facts it uses do not hold; it never states a price unless a price fact is used',
    check: (v, ctx) => { const p = verifyGeneration({ generated: v.text, facts: ctx.facts, usedRefs: v.uses_fact_refs, purpose: ctx.purpose, capacityChars: ctx.capacity_chars }).filter((c) => ['FIGURE_NOT_IN_A_FACT', 'LINK_OR_HANDLE_NOT_IN_A_FACT', 'NAME_NOT_IN_A_FACT', 'CLAIM_WORD_NOT_IN_A_FACT', 'PRICE_NOT_FROM_A_PRICE_FACT'].includes(c)); if (p.length) refuse('COPY_WRITE', p); },
  },
]);
export const COPY_WRITE_CONTRACT = Object.freeze({ stage: 'COPY_WRITE', spec: COPY_WRITE_SPEC, rules: COPY_WRITE_RULES });

const COMMON = ['Return ONLY one JSON object, described exactly by these lines (Nordla refuses an answer that does not follow them):'];
const CLOSING = 'You never use JSON numbers (digits inside a text are fine). rationale is one concise sentence of why this text, for the record; it is not a reasoning log. Write in the language of the request.';

/** The instruction of the adaptation: the source text, the limit and the purpose, with the contract stated. */
export function buildCopyAdaptInstruction({ source, role, capacityChars, locale }) {
  const system = [
    'You are the Nordla copy adapter. A text must be made shorter for the space it has, and its meaning must stay exactly the same.',
    ...COMMON, ...renderContract(COPY_ADAPT_SPEC, 'answer'), ...renderRules(COPY_ADAPT_RULES), CLOSING,
  ].join('\n');
  return { system, user: JSON.stringify({ role, locale, character_limit: capacityChars, source_text: source }) };
}

/** The instruction of the writing: the purpose, the facts it may rest on, the objective, the limit. */
export function buildCopyWriteInstruction({ purpose, facts, objective, audience, capacityChars, locale }) {
  const system = [
    'You are the Nordla copy writer. You write one short text for the given purpose, from the verified facts you are given and from nothing else.',
    ...COMMON, ...renderContract(COPY_WRITE_SPEC, 'answer'), ...renderRules(COPY_WRITE_RULES), CLOSING,
  ].join('\n');
  return { system, user: JSON.stringify({ purpose, locale, character_limit: capacityChars, objective, audience, facts: facts.map((f) => ({ fact_ref: f.fact_ref, kind: f.kind, statement: f.statement })) }) };
}

/** The ADAPT stage: one model completion behind the port, then the closed contract and the guards. */
export function createCopyAdapter({ complete }) {
  return Object.freeze({
    async adapt({ source, role, capacityChars, locale }) {
      const ctx = { source, capacity_chars: capacityChars };
      const { value, meta } = await askAndNormalize({
        complete, instruction: buildCopyAdaptInstruction({ source, role, capacityChars, locale }), stage: 'COPY_ADAPT', spec: COPY_ADAPT_SPEC, normalize: (raw) => validateAnswer(COPY_ADAPT_CONTRACT, raw, 'adaptation', ctx),
      });
      return { text: value.text, rationale: value.rationale, meta };
    },
  });
}

/** The WRITE stage: one model completion behind the port, then the closed contract and the guards. */
export function createCopyWriter({ complete }) {
  return Object.freeze({
    async write({ purpose, facts, objective, audience, capacityChars, locale }) {
      const ctx = { facts, purpose, capacity_chars: capacityChars };
      const { value, meta } = await askAndNormalize({
        complete, instruction: buildCopyWriteInstruction({ purpose, facts, objective, audience, capacityChars, locale }), stage: 'COPY_WRITE', spec: COPY_WRITE_SPEC, normalize: (raw) => validateAnswer(COPY_WRITE_CONTRACT, raw, 'writing', ctx),
      });
      return { text: value.text, uses_fact_refs: value.uses_fact_refs, rationale: value.rationale, meta };
    },
  });
}
