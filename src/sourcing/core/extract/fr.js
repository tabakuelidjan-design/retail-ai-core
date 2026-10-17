// French deterministic extraction of the three supplier terms the English rules cannot read from a French note: MINIMUM ORDER ("Quantité minimale : 100 unités"), LEAD TIME ("Délai de fabrication : 15 jours")
// and the quantity the supplier OFFERS ("Nous proposons 100 gourdes"). Same contract as en.js: a PROPOSAL pointing at an exact span of the original, nothing is applied, nothing is inferred.
// Three different quantities, three different keys, never merged: quote.moq (the supplier's minimum), quote.offeredQty (what the supplier says it offers / quotes for), and the owner's planned quantity
// (case context, never written by an extractor). quote.offeredQty is kept in the ledger only (conversation.compile returns no event for it), so it can never become the MOQ or the quantity ordered.
import { parseNumberToken } from './numbers.js';
import { segments, sentences, within, mk } from './shared.js';

const SP = '[ \\u00a0\\u202f]';
// 1 000 / 1 000 (nbsp) / 1.000 / 1,000 / 100. The thousands forms are tried first and must end on a non-digit.
const QTY = `\\d{1,3}(?:${SP}\\d{3}|[.,]\\d{3})+(?!\\d)|\\d+`;
const UNIT = '(?:pi[eè]ces?|pcs?|unit[eé]s?|exemplaires?|articles?)';
const UNIT_FR = '(?:pi[eè]ces?|unit[eé]s?|exemplaires?|articles?)'; // no "pcs": "minimum 25 pcs" is English wording and stays with en.js
const NOT_PER_COLOUR_EN = '(?!\\s*(?:per|each|\\/)\\s*colou?rs?)'; // English "per colour" belongs to en.js (moq.perColour)

/** Quantity token -> same shape as parseNumberToken. "1 000" -> 1000; "1.000" is French 1000 but English 1.0: refused as ambiguous (a person decides), never guessed. */
function qtyOf(raw) {
  const r = String(raw).replace(new RegExp(SP, 'g'), '');
  if (/^\d{1,3}(\.\d{3})+$/.test(r)) return { raw: String(raw), value: null, ambiguous: true, flags: ['AMBIGUOUS_NUMBER'], suggestion: r.replace(/\./g, '') };
  return parseNumberToken(r, 'quantity');
}

// MOQ cue (before the number). "MOQ" alone is also read by en.js; identical results are merged by extractFacts.
const MOQ_CUE = `(?:quantit[eé]\\s+(?:minimale?|minimum)(?:\\s+de\\s+commande)?|commande\\s+minimale?|minimum\\s+(?:de\\s+commande|d['’]achat)|qt[eé]\\s+min(?:imale?)?\\.?|MOQ)`;
const RX_MOQ_CUE = new RegExp(`(?<![\\p{L}])${MOQ_CUE}(?:\\s+(?:avec|pour|par|sans)\\s+[^.,;:!?\\d]{1,40}?)?\\s*(?:est\\s+(?:de\\s+)?|sera\\s+(?:de\\s+)?|de\\s+|:|=|-|–)?\\s*(?:d['’]environ\\s+|environ\\s+|au\\s+moins\\s+)?(${QTY})(?:\\s*(${UNIT}))?`, 'giu');
// "minimum de 100 pièces" / "minimum 100 unités": here the unit is REQUIRED (otherwise "minimum 5 jours" would be read as a quantity)
const RX_MOQ_MIN = new RegExp(`(?<![\\p{L}])(?:minimum|min\\.?)\\s+(?:de\\s+|d['’])?(${QTY})\\s*(${UNIT_FR})${NOT_PER_COLOUR_EN}`, 'giu');
// "100 pièces minimum" / "100 unités au minimum"
const RX_MOQ_AFTER = new RegExp(`(?<![\\p{L}\\d])(${QTY})\\s*(${UNIT})\\s+(?:au\\s+)?minimum(?![\\p{L}])${NOT_PER_COLOUR_EN}`, 'giu');

const moqContext = (seg, sent, single) => {
  const cue = (s) => (/par\s+couleur/i.test(s) ? 'per_colour' : /logo|gravure|impression|marquage|personnalisation/i.test(s) ? (/emballage|packaging/i.test(s) && !/logo/i.test(s) ? 'custom_packaging' : 'custom_logo') : /emballage|packaging/i.test(s) ? 'custom_packaging' : /[eé]chantillon/i.test(s) ? 'sample' : null);
  return cue(seg) ?? (single ? (() => { const c = cue(sent); return c === 'sample' ? null : c; })() : null) ?? 'product';
};

// Lead time. The cue is a production / preparation / delay word, the number must follow it closely. A bare "Livraison en Belgique" has no number after it and is never read.
const DELAY_OF = `(?:de|d['’])\\s*(?:la\\s+)?`;
const LT_KEY = `(?:d[eé]lais?(?:\\s+${DELAY_OF}(?:fabrication|production|r[eé]alisation|pr[eé]paration|livraison|exp[eé]dition))?|dur[eé]e\\s+${DELAY_OF}(?:fabrication|production)|fabrication|production|pr[eé]paration|r[eé]alisation|livraison)`;
const LT_NUM = `(?:environ\\s+|approximativement\\s+|~\\s*)?(\\d{1,3})(?:\\s?(?:-|–|à|a|ou|to)\\s?(\\d{1,3}))?\\s*(?:(jours?|j|semaines?|sem)(?![\\p{L}])(?:\\s+(?:ouvr[eé]s?|ouvrables?|calendaires?))?)`;
const RX_LT_A = new RegExp(`(?<![\\p{L}])${LT_KEY}\\s*(?:est|sera|serait|:|=|-|–)?\\s*(?:de\\s+|d['’]|en\\s+|sous\\s+|dans\\s+)?${LT_NUM}`, 'iu');
const RX_LT_B = new RegExp(`(?<![\\p{L}])(?:fabriqu[eé]e?s?|produit(?:e|s|es)?|pr[eê]te?s?|livr[eé]e?s?|exp[eé]di[eé]e?s?)\\s+(?:en|sous|dans)\\s+${LT_NUM}`, 'iu');

// Offered quantity: "Nous proposons 100 gourdes", "nous pouvons vous fournir 500 pièces". The word after the number must be a thing, not a price, a duration or a percentage.
const RX_OFFER = new RegExp(`(?<![\\p{L}])(?:nous|on|je)\\s+(?:vous\\s+)?(?:propos(?:ons|e)|offrons|offre|pouvons\\s+(?:vous\\s+)?(?:fournir|livrer|proposer))\\s+(?:(?:une\\s+)?quantit[eé]\\s+de\\s+|un\\s+lot\\s+de\\s+)?(${QTY})(${SP}+)(?!(?:€|euros?|eur|usd|dollars?|rmb|cny|yuan|jours?|semaines?|mois|%|pour\\s*cent)(?![\\p{L}]))([\\p{L}][\\p{L}'’-]*)`, 'giud');

export function extractFr(text, lang) {
  const out = []; const segs = segments(text); const sents = sentences(text);

  // ---- MOQ ----
  const moqs = [];
  const addMoq = (m, num, re) => { if (!moqs.some((x) => x.start < m.index + m[0].length && m.index < x.end)) moqs.push({ start: m.index, end: m.index + m[0].length, num, re }); };
  for (const m of text.matchAll(RX_MOQ_CUE)) addMoq(m, m[1]);
  for (const m of text.matchAll(RX_MOQ_MIN)) addMoq(m, m[1]);
  for (const m of text.matchAll(RX_MOQ_AFTER)) addMoq(m, m[1]);
  for (const mo of moqs) {
    const seg = within(segs, mo.start).text; const sent = within(sents, mo.start); const single = moqs.filter((x) => x.start >= sent.start && x.start <= sent.end).length === 1;
    const n = qtyOf(mo.num); const ctx = moqContext(seg, sent.text, single);
    const perColour = ctx === 'per_colour' && /par\s+couleur/i.test(text.slice(mo.start, mo.end)); // as en.js: a minimum PER COLOUR is its own fact, not the product MOQ
    out.push(mk(text, lang, perColour ? 'moq.perColour' : 'quote.moq', n.value, mo.start, mo.end, perColour ? { needsCorrection: n.ambiguous, flags: n.flags, ...(n.suggestion ? { suggestion: n.suggestion } : {}), reason: 'minimum par couleur' } : { context: ctx, needsCorrection: n.ambiguous, flags: n.flags, confidence: n.ambiguous ? 'LOW' : 'HIGH', ...(n.suggestion ? { suggestion: n.suggestion } : {}), reason: 'quantité minimale de commande' }));
  }

  // ---- lead time ----
  const lt = RX_LT_A.exec(text) ?? RX_LT_B.exec(text);
  if (lt) {
    const wk = /^s/i.test(lt[3]); const lo = Number(lt[1]) * (wk ? 7 : 1); const hi = Number(lt[2] ?? lt[1]) * (wk ? 7 : 1);
    const delivery = /^livraison|d[eé]lais?\s+(?:de|d['’])\s*(?:la\s+)?(?:livraison|exp[eé]dition)|^(?:livr|exp[eé]di)/i.test(lt[0]); // may include transport, not only manufacturing: lower confidence
    out.push(mk(text, lang, 'quote.leadTime', { min: String(Math.min(lo, hi)), max: String(Math.max(lo, hi)), unit: 'days' }, lt.index, lt.index + lt[0].length, { confidence: delivery ? 'MEDIUM' : 'HIGH', flags: wk ? ['WEEKS_CONVERTED'] : [], reason: 'délai' }));
  }

  // ---- offered quantity (NOT the MOQ, NOT the quantity ordered) ----
  for (const m of text.matchAll(RX_OFFER)) {
    const numStart = m.indices[1][0]; const end = m.index + m[0].length; const n = qtyOf(m[1]);
    out.push(mk(text, lang, 'quote.offeredQty', n.value, numStart, end, { needsCorrection: n.ambiguous, flags: n.flags, confidence: n.ambiguous ? 'LOW' : 'HIGH', ...(n.suggestion ? { suggestion: n.suggestion } : {}), reason: 'quantité proposée par le fournisseur' }));
  }
  return out;
}
