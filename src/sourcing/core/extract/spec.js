// SPECIFICATION facts from English text (isomorphic, pure, deterministic): the product-specific things a supplier says that Nordla's information needs wait for - a capacity (mAh, Wh, ml...), a material,
// what a product is compatible with, the age range. Narrow patterns only; nothing is inferred beyond the words. Each candidate points at an exact span, like every other extracted fact.
import { mk } from './shared.js';

const CAP = /(?<![A-Za-z0-9.,])(?:(?:capacit(?:y|é|e)|capacity)\s*[:=]?\s*)?(\d+(?:,\d+)*(?:\.\d+)?)\s?(mAh|Wh|ml|cl|litres?|liters?|oz)\b/gi;
const MATERIAL = /\b(?:materials?\s*(?:is|are|:|=)?|made\s+(?:of|from)|made\s+in)\s+((?:food[- ]grade\s+)?(?:stainless steel(?:\s*(?:201|304|316))?|silicone|tpu|tpe|abs|polypropylene|pp|pet|pvc|eva|tritan|glass|ceramic|aluminium|aluminum|leather|pu leather|cotton|polyester|nylon|bamboo|wood|zinc alloy|brass|copper|iron|rubber|acrylic|cardboard|paper|metal|plastic)(?:\s+(?:alloy|plastic|resin|fabric|steel|leather))?)\b/gi;
const COMPAT = /\b(?:compatible with|compatibility\s*(?:is|:)?|fits?|suitable for|designed for)\s+((?:iphone|galaxy|samsung|pixel|xiaomi|redmi|huawei|oppo|oneplus|ipad|airpods|macbook)[A-Za-z0-9 +/-]{0,38}?)(?=[.,;:!?]|\s+(?:and|with|in|we|but|only)\b|$)/gi;
const AGE_PLUS = /\b(\d{1,2})\s?\+\s?(?:years?|yrs?|y)\b|\b(?:ages?|aged|for\s+(?:children|kids)\s+(?:over|above|aged|from))\s+(\d{1,2})(?:\s*(?:to|-)\s*(\d{1,2}))?\b/gi;

// field-note forms: "45W", "65 w", "power 45 watts" (W followed by "/", a letter or a digit is something else: "w/ logo", "Wh"); "4 sorties", "4 outputs", "4 ports", "sorties: 4"; "capacité 20000" (no unit)
const POWER = /(?<![A-Za-z0-9.,])(?:(?:puissance|power|watt(?:age)?)\s*[:=]?\s*)?(\d+(?:\.\d+)?)\s?(?:W|watts?)(?![A-Za-z0-9/])/gi;
const OUTPUTS_A = /(?<![A-Za-z0-9.,])(\d{1,2})\s?(?:sorties?|outputs?(?:\s+ports?)?|ports?)(?![A-Za-z])/gi;
const OUTPUTS_B = /\b(?:sorties?|outputs?|ports?)\s*[:=]\s*(\d{1,2})(?![\dA-Za-z.,])/gi;
const CAP_NO_UNIT = /\b(?:capacit(?:y|é|e)|capacity)\s*[:=]?\s*(\d+(?:,\d{3})*)(?![\dA-Za-z.,])/gi;
// stock: "in stock", "en stock", "déjà on stock", "ready stock", "stock available/ready/disponible"; the opposite is read too, so "not in stock" can never become IN_STOCK; a question or a condition is no claim
const OUT_OF_STOCK = /out[\s-]+of[\s-]+stock|not[\s-]+in[\s-]+stock|no[\s-]+stock|pas[\s-]+(?:de|en)[\s-]+stock|rupture(?:[\s-]+de[\s-]+stock)?|plus[\s-]+de[\s-]+stock/gi;
const IN_STOCK = /(?<![\p{L}])(?:(?:déjà|deja|already)\s+)?(?:en|on|in)[\s-]+stock(?![\p{L}])|ready[\s-]+stock(?![\p{L}])|stock[\s-]+(?:ready|available|disponibles?|dispo)(?![\p{L}])/giu;
const CONDITIONAL = /(?:\bif|\bsi|\bwhether|\bis\s+it|\best-ce\s+qu(?:e|')|\bcheck)\s*$/i;

const UNIT = { mah: 'mAh', wh: 'Wh', ml: 'ml', cl: 'ml', l: 'L', litre: 'L', litres: 'L', liter: 'L', liters: 'L', oz: 'oz' };

export function extractSpec(text, lang = 'en') {
  const out = []; const t = String(text ?? '');
  for (const m of t.matchAll(CAP)) {
    const unitKey = m[2].toLowerCase(); let amount = Number(m[1].replace(/,/g, '')); if (!Number.isFinite(amount) || amount <= 0) continue;
    if (unitKey === 'cl') amount *= 10; const unit = UNIT[unitKey]; const ratingTight = unit === 'mAh' || unit === 'Wh';
    out.push(mk(t, lang, 'spec.capacity', { amount, unit }, m.index, m.index + m[0].length, { confidence: 'HIGH', reason: ratingTight ? 'battery capacity' : 'volume', context: unit === 'mAh' ? 'mah' : unit === 'Wh' ? 'wh' : 'volume' })); // one context per measure: 10 000 mAh and 37 Wh describe the same battery, they never contradict each other
  }
  for (const m of t.matchAll(CAP_NO_UNIT)) { const hit = out.some((c) => c.key === 'spec.capacity' && c.span[0] <= m.index + m[0].length && m.index <= c.span[1]); if (hit) continue; out.push(mk(t, lang, 'spec.capacity', null, m.index, m.index + m[0].length, { confidence: 'LOW', context: 'unit_unknown', needsCorrection: true, flags: ['UNIT_NOT_STATED'], reason: 'capacity without a unit' })); }
  for (const m of t.matchAll(POWER)) out.push(mk(t, lang, 'spec.power', { amount: Number(m[1]), unit: 'W' }, m.index, m.index + m[0].length, { reason: 'power in watts', context: 'power' }));
  for (const re of [OUTPUTS_A, OUTPUTS_B]) for (const m of t.matchAll(re)) { if (Number(m[1]) < 1) continue; out.push(mk(t, lang, 'spec.outputCount', String(Number(m[1])), m.index, m.index + m[0].length, { confidence: 'MEDIUM', reason: 'number of outputs' })); }
  const noStock = []; for (const m of t.matchAll(OUT_OF_STOCK)) { noStock.push([m.index, m.index + m[0].length]); out.push(mk(t, lang, 'offer.stockStatus', 'OUT_OF_STOCK', m.index, m.index + m[0].length, { confidence: 'MEDIUM', reason: 'stock statement' })); }
  for (const m of t.matchAll(IN_STOCK)) { const e = m.index + m[0].length; if (noStock.some(([a, b]) => m.index < b && a < e)) continue; if (CONDITIONAL.test(t.slice(Math.max(0, m.index - 14), m.index)) || /^\s*\?/.test(t.slice(e))) continue; if (/(?:not|no|pas|non|sans|n't)\s+(?:\w+\s+)?$/i.test(t.slice(Math.max(0, m.index - 14), m.index))) continue; out.push(mk(t, lang, 'offer.stockStatus', 'IN_STOCK', m.index, e, { confidence: 'MEDIUM', reason: 'stock statement' })); }
  for (const m of t.matchAll(MATERIAL)) { const s0 = m.index + m[0].lastIndexOf(m[1]); out.push(mk(t, lang, 'spec.material', m[1].toLowerCase().replace(/\s+/g, ' '), s0, s0 + m[1].length, { confidence: 'MEDIUM', reason: 'material statement' })); }
  for (const m of t.matchAll(COMPAT)) { const v = m[1].trim().replace(/\s+/g, ' '); const s0 = m.index + m[0].indexOf(m[1]); out.push(mk(t, lang, 'spec.compatibility', v, s0, s0 + v.length, { confidence: /compatible|compatibility/i.test(m[0]) ? 'HIGH' : 'MEDIUM', reason: 'compatibility statement' })); }
  for (const m of t.matchAll(AGE_PLUS)) { const min = Number(m[1] ?? m[2]); const max = m[3] ? Number(m[3]) : null; if (!Number.isFinite(min) || min > 99) continue; out.push(mk(t, lang, 'spec.ageRange', { minYears: min, maxYears: max }, m.index, m.index + m[0].length, { confidence: 'MEDIUM', reason: 'age range' })); }
  return out;
}
