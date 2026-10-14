// EU Safety Gate matching (pure). The alerts come from an adapter (the official weekly XML reports, ingested locally); this module only MATCHES them against
// the Product Case. "NO_MATCH_FOUND" is never "safe": alerts cover only what authorities notified, and brand/model/barcode data are often missing.
const norm = (s) => String(s ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const words = (s) => String(s ?? '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter((w) => w.length > 2);
const STOP = new Set(['the', 'and', 'for', 'with', 'pro', 'new', 'mini', 'set', 'pcs', 'type', 'model', 'product', 'black', 'white']);

export const HAZARD_CLASSES = Object.freeze({
  FIRE: /fire|burn|overheat|thermal|battery|explos/i, ELECTRIC_SHOCK: /electric|shock|insulation|voltage/i, CHEMICAL: /chemical|lead|cadmium|phthalate|toxic|pah|nickel|bisphenol|azo/i,
  CHOKING: /chok|small part|suffocat|asphyx/i, INJURY: /injur|cut|laceration|sharp|fall|entrap|crush/i, STRANGULATION: /strangul|cord|drawstring/i, HEALTH: /microbiolog|health|allerg|irritat/i, HEARING: /hearing|noise/i, ENVIRONMENT: /environment/i,
});
export const hazardsOf = (text) => Object.entries(HAZARD_CLASSES).filter(([, rx]) => rx.test(String(text ?? ''))).map(([k]) => k);

/** Nordla category -> words that identify the same product group in an alert's category / product / name text. */
const GROUPS = {
  power_bank: ['power bank', 'powerbank', 'battery', 'charger', 'accumulator'], usb_charger: ['charger', 'adapter', 'adaptor', 'power supply', 'usb'], usb_cable: ['cable', 'usb'], bluetooth_speaker: ['speaker', 'bluetooth', 'audio'],
  bluetooth_earbuds: ['earphone', 'earbud', 'headphone', 'headset', 'bluetooth'], led_lamp_mains: ['lamp', 'led', 'light', 'lighting'], toy_plastic: ['toy', 'doll', 'game', 'slime', 'puzzle'], plush_toy: ['toy', 'plush', 'soft'],
  textile_children: ['child', 'baby', 'clothing', 'garment', 'hood', 'drawstring'], textile_adult: ['clothing', 'garment', 'textile'], cosmetic_product: ['cosmetic', 'cream', 'shampoo', 'lotion', 'perfume', 'make-up', 'hair'],
  kitchenware_plastic: ['food contact', 'kitchenware', 'container', 'tableware'], water_bottle: ['bottle', 'food contact', 'flask'], tableware_glass_ceramic: ['ceramic', 'glass', 'tableware', 'mug', 'cup'], jewelry_costume: ['jewel', 'necklace', 'bracelet', 'earring'],
  ppe_item: ['protective', 'glove', 'mask', 'helmet', 'respirator'], small_appliance_mains: ['appliance', 'hair', 'kettle', 'heater', 'fan'], battery_standalone: ['battery', 'cell', 'accumulator'],
};

/**
 * @param {{ identity: { brand?: string|null, model?: string|null, gtin?: string|null, name?: string|null, category?: string|null }, alerts: object[],
 *           source: { mode: 'LIVE_VERIFIED'|'CACHED'|'OFFLINE_VERIFICATION_REQUIRED'|'MANUAL', fetchedAt?: string|null, coverage?: string|null } }} args
 */
export function matchSafetyGate({ identity, alerts, source }) {
  if (!alerts || source.mode === 'OFFLINE_VERIFICATION_REQUIRED') return { status: 'NOT_CHECKED', matches: [], hazards: [], source, note: 'The Safety Gate could not be consulted: OFFLINE - VERIFICATION REQUIRED. This is not a clean result and does not prove safety.' };
  const gtin = String(identity.gtin ?? '').replace(/\D/g, ''); const brand = norm(identity.brand); const model = norm(identity.model);
  const nameWords = new Set(words(identity.name).filter((w) => !STOP.has(w))); const group = GROUPS[identity.category] ?? [];
  const exact = []; const probable = []; const similar = [];
  for (const a of alerts) {
    const abc = String(a.barcode ?? '').replace(/\D/g, ''); const am = norm(a.model); const ab = norm(a.brand);
    const hay = `${a.category ?? ''} ${a.product ?? ''} ${a.name ?? ''} ${a.description ?? ''}`.toLowerCase();
    const mk = (basis) => ({ alertNumber: a.caseNumber ?? a.alertNumber ?? null, basis, brand: a.brand ?? null, model: a.model ?? null, name: a.name ?? a.product ?? null, category: a.category ?? null, hazards: [...new Set([...hazardsOf(a.riskType), ...hazardsOf(a.danger)])], riskLevel: a.level ?? null, countryOfOrigin: a.countryOfOrigin ?? null, url: a.URLrecall ?? null, date: a.date ?? null });
    if (gtin.length >= 8 && abc && abc === gtin) { exact.push(mk('BARCODE')); continue; }
    if (brand && model && ab && am && ab === brand && am === model) { exact.push(mk('BRAND_AND_MODEL')); continue; }
    if (model.length >= 5 && am && am === model) { probable.push(mk('MODEL_ONLY')); continue; }
    const aw = new Set(words(a.name ?? a.product).filter((w) => !STOP.has(w))); const common = [...nameWords].filter((w) => aw.has(w));
    if (brand && ab && ab === brand && common.length >= 2) { probable.push(mk('BRAND_AND_NAME')); continue; }
    if (group.length && group.some((g) => hay.includes(g)) && /china/i.test(String(a.countryOfOrigin ?? '')) && (common.length >= 1 || group.filter((g) => hay.includes(g)).length >= 2)) similar.push(mk('SIMILAR_PRODUCT'));
  }
  const status = exact.length ? 'EXACT_MATCH' : probable.length ? 'PROBABLE_MATCH' : similar.length ? 'SIMILAR_PRODUCT_RISK' : 'NO_MATCH_FOUND';
  const matches = [...exact, ...probable, ...similar.slice(0, 8)];
  const hazards = [...new Set(matches.flatMap((m) => m.hazards))];
  return { status, matches, hazards, similarCount: similar.length, source, note: status === 'NO_MATCH_FOUND' ? 'NO MATCH FOUND does not prove safety. Only products notified by authorities appear in the Safety Gate, many alerts lack brand, model or barcode, and only the weeks ingested were searched.' : status === 'SIMILAR_PRODUCT_RISK' ? 'Similar products were notified. This is a risk signal for this TYPE of product, not a finding about this exact product.' : null };
}
