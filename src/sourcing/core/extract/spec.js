// SPECIFICATION facts from English text (isomorphic, pure, deterministic): the product-specific things a supplier says that Nordla's information needs wait for - a capacity (mAh, Wh, ml...), a material,
// what a product is compatible with, the age range. Narrow patterns only; nothing is inferred beyond the words. Each candidate points at an exact span, like every other extracted fact.
import { mk } from './shared.js';

const CAP = /(?<![A-Za-z0-9.,])(\d+(?:,\d+)*(?:\.\d+)?)\s?(mAh|Wh|ml|cl|litres?|liters?|oz)\b/gi;
const MATERIAL = /\b(?:materials?\s*(?:is|are|:|=)?|made\s+(?:of|from)|made\s+in)\s+((?:food[- ]grade\s+)?(?:stainless steel(?:\s*(?:201|304|316))?|silicone|tpu|tpe|abs|polypropylene|pp|pet|pvc|eva|tritan|glass|ceramic|aluminium|aluminum|leather|pu leather|cotton|polyester|nylon|bamboo|wood|zinc alloy|brass|copper|iron|rubber|acrylic|cardboard|paper|metal|plastic)(?:\s+(?:alloy|plastic|resin|fabric|steel|leather))?)\b/gi;
const COMPAT = /\b(?:compatible with|compatibility\s*(?:is|:)?|fits?|suitable for|designed for)\s+((?:iphone|galaxy|samsung|pixel|xiaomi|redmi|huawei|oppo|oneplus|ipad|airpods|macbook)[A-Za-z0-9 +/-]{0,38}?)(?=[.,;:!?]|\s+(?:and|with|in|we|but|only)\b|$)/gi;
const AGE_PLUS = /\b(\d{1,2})\s?\+\s?(?:years?|yrs?|y)\b|\b(?:ages?|aged|for\s+(?:children|kids)\s+(?:over|above|aged|from))\s+(\d{1,2})(?:\s*(?:to|-)\s*(\d{1,2}))?\b/gi;

const UNIT = { mah: 'mAh', wh: 'Wh', ml: 'ml', cl: 'ml', l: 'L', litre: 'L', litres: 'L', liter: 'L', liters: 'L', oz: 'oz' };

export function extractSpec(text, lang = 'en') {
  const out = []; const t = String(text ?? '');
  for (const m of t.matchAll(CAP)) {
    const unitKey = m[2].toLowerCase(); let amount = Number(m[1].replace(/,/g, '')); if (!Number.isFinite(amount) || amount <= 0) continue;
    if (unitKey === 'cl') amount *= 10; const unit = UNIT[unitKey]; const ratingTight = unit === 'mAh' || unit === 'Wh';
    out.push(mk(t, lang, 'spec.capacity', { amount, unit }, m.index, m.index + m[0].length, { confidence: 'HIGH', reason: ratingTight ? 'battery capacity' : 'volume', context: unit === 'mAh' ? 'mah' : unit === 'Wh' ? 'wh' : 'volume' })); // one context per measure: 10 000 mAh and 37 Wh describe the same battery, they never contradict each other
  }
  for (const m of t.matchAll(MATERIAL)) { const s0 = m.index + m[0].lastIndexOf(m[1]); out.push(mk(t, lang, 'spec.material', m[1].toLowerCase().replace(/\s+/g, ' '), s0, s0 + m[1].length, { confidence: 'MEDIUM', reason: 'material statement' })); }
  for (const m of t.matchAll(COMPAT)) { const v = m[1].trim().replace(/\s+/g, ' '); const s0 = m.index + m[0].indexOf(m[1]); out.push(mk(t, lang, 'spec.compatibility', v, s0, s0 + v.length, { confidence: /compatible|compatibility/i.test(m[0]) ? 'HIGH' : 'MEDIUM', reason: 'compatibility statement' })); }
  for (const m of t.matchAll(AGE_PLUS)) { const min = Number(m[1] ?? m[2]); const max = m[3] ? Number(m[3]) : null; if (!Number.isFinite(min) || min > 99) continue; out.push(mk(t, lang, 'spec.ageRange', { minYears: min, maxYears: max }, m.index, m.index + m[0].length, { confidence: 'MEDIUM', reason: 'age range' })); }
  return out;
}
