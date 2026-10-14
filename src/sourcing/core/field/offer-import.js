// P6-LITE OFFER IMPORT. One door for everything a supplier sends: a pasted quotation, a pasted chat, the text layer of a PDF, a quote typed by hand, facts already extracted elsewhere.
// It does NOT invent a second store: an import is recorded as an OFFER (a thin index record in `case.offers`) over the EXISTING evidence machinery - the original text is a conversation item,
// every proposed fact is a candidate (same lifecycle: CONFIRM / CORRECT / REJECT, same ledger, same conflicts). The OfferDraft below is a pure VIEW over those records.
// Rules (tested): nothing is invented; a missing value is UNKNOWN, never a default; a supplier fact is a SUPPLIER_CLAIM and never VERIFIED; the original text is never altered;
// importing the same text twice changes nothing (content-derived id); the owner's own lines of a chat never become supplier facts.
import { extractFacts, detectLang } from '../extract/index.js';
import { mk } from '../extract/shared.js';
import * as conv from '../conversation.js';
import { CANDIDATE_STATE, SPEAKER, FACT_STATUS } from '../provenance.js';
import { caseFacts, typeOfKey, sameFactValue } from '../case-facts.js';

export const OFFER_SOURCE = Object.freeze({ PASTED_QUOTE: 'PASTED_QUOTE', CHAT: 'CHAT', PDF_TEXT: 'PDF_TEXT', MANUAL: 'MANUAL', EXTRACTED: 'EXTRACTED' });
export const IMPORTER_VERSION = 'offer-import-1';
const MAX_TEXT = 200000;

/** Deterministic 64-bit content hash (isomorphic: the same in the browser, on the server and in tests). Not a security primitive: an identity for content. */
export function contentHash(input) {
  const s = String(input); let h1 = 0x811c9dc5; let h2 = 0x9747b28c;
  for (let i = 0; i < s.length; i += 1) { const c = s.charCodeAt(i); h1 = Math.imul(h1 ^ c, 0x01000193); h2 = Math.imul(h2 ^ (c + i), 0x85ebca6b); h2 ^= h2 >>> 13; }
  return `${(h1 >>> 0).toString(16).padStart(8, '0')}${(h2 >>> 0).toString(16).padStart(8, '0')}`;
}
/** Content-derived id: same source + same supplier + same text = the same offer. */
export const offerIdOf = ({ source, supplier = '', text }) => `off-${contentHash(`${source}\u0001${String(supplier).trim().toLowerCase()}\u0001${String(text).replace(/\r\n?/g, '\n').trim()}`)}`;

// ---------- chat ------------------------------------------------------------------------------------------------------------------------------------------------------------
const ROLE_SUPPLIER = /^(supplier|vendor|seller|sales|sales rep|factory|manufacturer|他|对方|卖家|供应商|厂家|业务)$/i;
const ROLE_ME = /^(me|myself|buyer|moi|vous|you|i|我|买家|客户)$/i;
const TS = String.raw`(?:\[[^\]\n]{2,30}\]\s*|\(\d{1,2}:\d{2}[^)\n]*\)\s*|\d{1,4}[-/.]\d{1,2}[-/.]\d{1,4}[ T]\d{1,2}:\d{2}(?::\d{2})?\s*[-–]?\s*|\d{1,2}:\d{2}(?::\d{2})?\s*[-–]?\s*)`;
const MARKER = new RegExp(`^\\s*(${TS})?([A-Za-z\\u4e00-\\u9fff][\\w\\u4e00-\\u9fff .'\\-]{0,28}?)\\s*[:：]\\s*(.*)$`);
// words that begin a LINE of a quotation ("Price: ...") and must never be mistaken for the name of a chat participant
const FIELD_LABELS = new Set(['price', 'unit price', 'moq', 'material', 'size', 'packing', 'packaging', 'package', 'sample', 'payment', 'lead time', 'delivery', 'model', 'color', 'colour', 'note', 'notes', 'total', 'shipping', 'incoterm', 'port', 'warranty', 'brand', 'item', 'qty', 'quantity', 'certificate', 'certificates', 'logo', 'customization', 'dimension', 'dimensions', 'weight', 'product', 'description', 'remark', 'remarks', 'terms', 'validity', 'prix', 'délai', 'paiement']);

/** Splits a pasted chat into turns. A line without a marker continues the previous turn. A marker naming the supplier or the owner (or a name in `meNames`) sets the speaker; any other name leaves the speaker UNKNOWN (never guessed). */
export function parseChat(text, { meNames = [] } = {}) {
  const lines = String(text ?? '').replace(/\r\n?/g, '\n').split('\n'); const turns = []; const mine = new Set(meNames.map((n) => String(n).trim().toLowerCase()).filter(Boolean));
  for (const line of lines) {
    if (!line.trim()) { if (turns.length) turns.at(-1).text += '\n'; continue; }
    const m = MARKER.exec(line); let name = m ? m[2].trim() : null;
    if (name && FIELD_LABELS.has(name.toLowerCase()) && !m[1]) name = null; // "Price: 6.80" is a field of a quotation, not a speaker
    if (name) {
      const speaker = ROLE_SUPPLIER.test(name) ? SPEAKER.SUPPLIER : ROLE_ME.test(name) || mine.has(name.toLowerCase()) ? SPEAKER.ME : SPEAKER.UNKNOWN;
      turns.push({ speaker, name, at: m[1] ? m[1].replace(/[\[\]()]/g, '').trim() : null, text: m[3] ?? '' });
    } else if (turns.length) turns.at(-1).text += `\n${line}`; else turns.push({ speaker: SPEAKER.UNKNOWN, name: null, at: null, text: line });
  }
  return turns.map((t) => ({ ...t, text: t.text.trim() })).filter((t) => t.text);
}
/** A text is read as a chat only when it HAS markers: two or more lines with a role word / a timestamp, or two alternating names that are not quotation labels. */
export function looksLikeChat(text, opts = {}) {
  const lines = String(text ?? '').split(/\r?\n/); let strong = 0; const names = new Set(); let generic = 0;
  for (const l of lines) { const m = MARKER.exec(l); if (!m) continue; const n = m[2].trim().toLowerCase(); if (ROLE_SUPPLIER.test(n) || ROLE_ME.test(n) || m[1] || (opts.meNames ?? []).some((x) => String(x).toLowerCase() === n)) strong += 1; else if (!FIELD_LABELS.has(n)) { names.add(n); generic += 1; } }
  return strong >= 2 || (names.size >= 2 && generic >= 3);
}

// ---------- fields that are not in the V1 extractor ------------------------------------------------------------------------------------------------------------
const clean = (s) => String(s).replace(/\s+/g, ' ').replace(/^[\s:=\-–,]+|[\s,;.]+$/g, '').trim();
const CUSTOM_TOKENS = [['custom logo', /custom(?:ised|ized|ised)?\s+logo|logo\s+(?:custom(?:isation|ization)|printing|print|engraving)|(?:print|engrave)\s+(?:your\s+|a\s+)?logo/gi], ['OEM', /\bOEM\b/g], ['ODM', /\bODM\b/g], ['private label', /private[- ]label|own brand/gi], ['UV printing', /\bUV[- ]print(?:ing)?\b/gi], ['laser engraving', /laser[- ]engrav(?:ing|e)/gi], ['custom packaging', /custom(?:ised|ized)?\s+(?:packag(?:ing|e)|box)/gi], ['custom colour', /custom(?:ised|ized)?\s+colou?rs?/gi]];
const PAY_TOKENS = [['T/T', /\bT\/?T\b/g], ['L/C', /\bL\/C\b/g], ['D/P', /\bD\/P\b/g], ['PayPal', /paypal/gi], ['Western Union', /western union/gi], ['Alipay', /alipay/gi], ['WeChat Pay', /wechat pay/gi], ['Trade Assurance', /trade assurance/gi], ['escrow', /\bescrow\b/gi]];
const SHIP_TOKENS = [['sea', /\bby sea\b|\bsea freight\b|\bocean freight\b/gi], ['air', /\bby air\b|\bair freight\b/gi], ['express', /\b(?:DHL|FedEx|UPS|TNT|express)\b/g], ['rail', /\brail(?:way)?\b/gi]];

/** Extra supplier statements an offer usually carries and that the V1 extractor does not read. Same candidate shape (exact span of the original, never a decision), every value a plain string. */
export function extractOfferExtras(text, lang = 'en') {
  const t = String(text ?? ''); const out = [];
  const add = (key, value, a, b, extra = {}) => out.push(mk(t, lang, key, value, a, b, { confidence: 'MEDIUM', ...extra }));
  for (const m of t.matchAll(/\b(?:packing|packaging|package)\s*(?:is|are|:|=|-)?\s*([^.;\n]{2,80})/gi)) { const v = clean(m[1]); if (v.length >= 2) { const a = m.index + m[0].lastIndexOf(m[1]); add('offer.packaging', v, a, a + m[1].length, { reason: 'packaging statement' }); } }
  if (!out.some((c) => c.key === 'offer.packaging')) for (const m of t.matchAll(/\b(opp bag|poly ?bag|gift box|colou?r box|white box|neutral packing|blister(?: pack)?|individual(?:ly)? (?:packed|packing|packaging)|paper box|kraft box)\b/gi)) { add('offer.packaging', clean(m[1]).toLowerCase(), m.index, m.index + m[0].length, { reason: 'packaging term' }); break; }
  for (const m of t.matchAll(/\b(?:production|manufacturing|mass production)\s*(?:lead\s*)?(?:time|cycle|period)?\s*(?:is|are|:|=|-|about|around|within)?\s*(\d{1,3})(?:\s*(?:-|–|~|to)\s*(\d{1,3}))?\s*(days?|working days?|weeks?)\b/gi)) {
    const w = /week/i.test(m[3]); const lo = Number(m[1]) * (w ? 7 : 1); const hi = m[2] ? Number(m[2]) * (w ? 7 : 1) : lo; if (hi < lo) continue;
    add('offer.productionDays', lo === hi ? String(lo) : `${lo}-${hi}`, m.index, m.index + m[0].length, { confidence: 'HIGH', flags: w ? ['WEEKS_CONVERTED'] : [], reason: 'production time' });
  }
  const sampleSent = t.split(/(?<=[.!?;\n])/).reduce((acc, s) => { const start = acc.pos; acc.pos += s.length; if (/sample/i.test(s)) acc.list.push({ s, start }); return acc; }, { pos: 0, list: [] }).list;
  for (const { s, start } of sampleSent) {
    const r = /\b(non[- ]refundable|not refundable|no refund|refundable|refunded?|deducted from (?:the )?(?:bulk )?order)\b/i.exec(s);
    if (r) add('offer.sampleRefund', /non|not|no refund/i.test(r[1]) ? 'NOT_REFUNDABLE' : 'REFUNDABLE', start + r.index, start + r.index + r[0].length, { context: 'sample', reason: 'sample refund statement' });
    const d = /\b(?:sample\s*(?:time|lead\s*time|delivery)|ready in)\s*(?:is|:|=|-|about|within)?\s*(\d{1,2})(?:\s*(?:-|–|~|to)\s*(\d{1,2}))?\s*(days?)/i.exec(s);
    if (d) add('offer.sampleDays', d[2] ? `${d[1]}-${d[2]}` : d[1], start + d.index, start + d.index + d[0].length, { context: 'sample', reason: 'sample lead time' });
  }
  const span = (hits) => (hits.length ? [Math.min(...hits.map((h) => h.a)), Math.max(...hits.map((h) => h.b))] : null);
  const collect = (tokens) => { const hits = []; for (const [name, rx] of tokens) for (const m of t.matchAll(new RegExp(rx.source, rx.flags))) hits.push({ name, a: m.index, b: m.index + m[0].length }); return hits; };
  const cust = collect(CUSTOM_TOKENS); if (cust.length) { const [a, b] = span(cust); add('offer.customization', [...new Set(cust.map((h) => h.name))].join(', '), a, b, { reason: 'customisation statement' }); }
  const pay = collect(PAY_TOKENS); if (pay.length) { const [a, b] = span(pay); add('offer.paymentMethods', [...new Set(pay.map((h) => h.name))].join(', '), a, b, { reason: 'payment methods' }); }
  const ship = collect(SHIP_TOKENS); if (ship.length) { const [a, b] = span(ship); add('offer.shippingMethod', [...new Set(ship.map((h) => h.name))].join(', '), a, b, { reason: 'shipping methods mentioned' }); }
  for (const m of t.matchAll(/\b(?:(\d{1,2})\s*(months?|years?)\s*warranty|warranty\s*(?:of|:|=|is)?\s*(\d{1,2})\s*(months?|years?))\b/gi)) { add('offer.warranty', `${m[1] ?? m[3]} ${(m[2] ?? m[4]).toLowerCase()}`, m.index, m.index + m[0].length, { reason: 'warranty statement' }); break; }
  for (const m of t.matchAll(/\b(?:comes? with|includes?|including|with free)\s+(?:a\s+|an\s+|one\s+|free\s+)?([^.;\n]{3,60})/gi)) { const v = clean(m[1]); if (v.length >= 3 && !/^(?:the\s+)?(?:price|shipping|freight|tax)/i.test(v)) { const a = m.index + m[0].lastIndexOf(m[1]); add('offer.accessories', v, a, a + m[1].length, { reason: 'included items' }); break; } }
  // what the supplier says it IS: a claim, never an established fact
  const fac = /\b(?:we are|we're|i am)\s+(?:a\s+|the\s+)?(?:\w+\s+)?(?:factory|manufacturer|producer)\b|\bfactory[- ]direct\b|\bour (?:own )?factory\b|\bsource factory\b/i.exec(t); const trd = /\b(?:we are|we're)\s+(?:a\s+)?(?:\w+\s+)?(?:trading|trade)\s+(?:company|firm)\b|\btrading company\b/i.exec(t);
  if (fac && !trd) add('supplier.type', 'FACTORY', fac.index, fac.index + fac[0].length, { reason: 'the supplier says it is a factory (a claim, not an established fact)' });
  else if (trd) add('supplier.type', 'TRADING', trd.index, trd.index + trd[0].length, { reason: 'the supplier says it is a trading company' });
  // Chinese equivalents (few, exact)
  if (/[㐀-鿿]/.test(t)) {
    for (const [rx, key, val] of [[/(?:我们是|我们是一家|源头)工厂|工厂直销|自有工厂/, 'supplier.type', 'FACTORY'], [/贸易公司|我们是贸易/, 'supplier.type', 'TRADING']]) { const m = rx.exec(t); if (m && !out.some((c) => c.key === key)) add(key, val, m.index, m.index + m[0].length, { lang: 'zh', reason: '供应商自述' }); }
    const pk = /包装\s*[:：]?\s*([^，。；;\n]{2,30})/.exec(t); if (pk && !out.some((c) => c.key === 'offer.packaging')) { const a = pk.index + pk[0].indexOf(pk[1]); add('offer.packaging', clean(pk[1]), a, a + pk[1].length, { reason: '包装' }); }
    const pt = /(?:生产周期|生产时间|大货交期)\s*[:：]?\s*(\d{1,3})(?:\s*[-~到至]\s*(\d{1,3}))?\s*(?:天|日)/.exec(t); if (pt && !out.some((c) => c.key === 'offer.productionDays')) add('offer.productionDays', pt[2] ? `${pt[1]}-${pt[2]}` : pt[1], pt.index, pt.index + pt[0].length, { confidence: 'HIGH', reason: '生产周期' });
  }
  const seen = new Set(); return out.filter((c) => { const k = `${c.key}|${c.context}|${c.value}`; if (seen.has(k)) return false; seen.add(k); return true; }).sort((a, b) => a.span[0] - b.span[0] || a.key.localeCompare(b.key));
}

// ---------- manual quote ----------------------------------------------------------------------------------------------------------------------------------------------------
const DEC = /^\d+(?:\.\d+)?$/; const INT = /^\d+$/;
const MANUAL_FIELDS = [
  // [input name, label written into the original, key, validator, context]
  ['model', 'Model', 'identifier.model', (v) => (v ? v : null)], ['currency', 'Currency', 'quote.currency', (v) => (['USD', 'CNY', 'EUR'].includes(String(v).toUpperCase()) ? String(v).toUpperCase() : null)],
  ['unitPrice', 'Unit price', 'quote.unitPrice', (v) => (DEC.test(v) && Number(v) > 0 ? v : null)], ['moq', 'MOQ', 'quote.moq', (v) => (INT.test(v) && Number(v) > 0 ? v : null)],
  ['incoterm', 'Incoterm', 'quote.incoterm', (v) => (['EXW', 'FCA', 'FOB', 'CFR', 'CIF', 'CPT', 'CIP', 'DAP', 'DPU', 'DDP'].includes(String(v).toUpperCase()) ? String(v).toUpperCase() : null)], ['port', 'Port', 'quote.port', (v) => (v ? v : null)],
  ['leadTimeDays', 'Lead time (days)', 'quote.leadTime', (v) => (INT.test(v) && Number(v) > 0 ? { min: v, max: v, unit: 'days' } : null)], ['depositPct', 'Deposit %', 'payment.depositPct', (v) => (INT.test(v) && Number(v) <= 100 ? v : null)], ['balancePct', 'Balance %', 'payment.balancePct', (v) => (INT.test(v) && Number(v) <= 100 ? v : null)],
  ['samplePrice', 'Sample price', 'quote.samplePrice', (v) => (DEC.test(v) && Number(v) >= 0 ? v : null), 'sample'], ['material', 'Material', 'spec.material', (v) => (v ? String(v).toLowerCase() : null)],
  ['packaging', 'Packaging', 'offer.packaging', (v) => (v ? v : null)], ['productionDays', 'Production time (days)', 'offer.productionDays', (v) => (/^\d+(?:-\d+)?$/.test(v) ? v : null)], ['customization', 'Customisation', 'offer.customization', (v) => (v ? v : null)],
  ['paymentMethods', 'Payment methods', 'offer.paymentMethods', (v) => (v ? v : null)], ['warranty', 'Warranty', 'offer.warranty', (v) => (v ? v : null)], ['accessories', 'Included', 'offer.accessories', (v) => (v ? v : null)],
];
const asTiers = (v) => (Array.isArray(v) ? v : []).map((r) => ({ minQty: String(r?.minQty ?? '').trim(), unitPrice: String(r?.unitPrice ?? '').trim() }));

/** A quote typed by the owner becomes a canonical original text (one "label: value" line per field) and candidates that point at the exact typed characters. A value that does not validate is KEPT as written
 *  with needsCorrection (never reinterpreted, never dropped, never blocks the others). Empty inputs produce nothing: a missing value is UNKNOWN, not zero. */
export function manualOffer(input = {}, lang = 'en') {
  const lines = []; const cands = []; const put = (label, raw, key, value, ctx = 'product', extra = {}) => {
    const prefix = `${label}: `; const start = lines.join('\n').length + (lines.length ? 1 : 0) + prefix.length; lines.push(`${prefix}${raw}`);
    cands.push({ key, value, rawText: String(raw), span: [start, start + String(raw).length], context: ctx, lang, confidence: value === null ? 'LOW' : 'HIGH', flags: [...(value === null ? ['AMBIGUOUS_NUMBER'] : []), 'TYPED_BY_OWNER'], needsCorrection: value === null, reason: 'typed by the owner', ...extra });
  };
  for (const [name, label, key, check, ctx] of MANUAL_FIELDS) { const raw = String(input[name] ?? '').trim(); if (!raw) continue; put(label, raw, key, check(raw), ctx ?? 'product'); }
  const tiers = asTiers(input.tiers).filter((r) => r.minQty || r.unitPrice);
  if (tiers.length) { const raw = tiers.map((r) => `${r.minQty || '?'} pcs = ${r.unitPrice || '?'}`).join(', '); const ok = tiers.every((r) => INT.test(r.minQty) && Number(r.minQty) > 0 && DEC.test(r.unitPrice) && Number(r.unitPrice) > 0); const dup = new Set(tiers.map((r) => r.minQty)).size !== tiers.length; put('Price tiers', raw, 'quote.tiers', ok && !dup ? tiers.slice().sort((a, b) => Number(a.minQty) - Number(b.minQty)) : null, 'product', dup ? { flags: ['DUPLICATE_THRESHOLD', 'TYPED_BY_OWNER'] } : {}); }
  for (const doc of Array.isArray(input.certificates) ? input.certificates : []) { const k = String(doc).toUpperCase().replace(/[\s.]/g, ''); const key = { UN383: 'UN383', UN38_3: 'UN383', CE: 'CE', ROHS: 'ROHS', REACH: 'REACH', FCC: 'FCC', SDS: 'SDS', MSDS: 'SDS', IEC62133: 'IEC62133', TESTREPORT: 'TEST_REPORT' }[k]; if (key) put('Certificate claimed', String(doc), `docClaim.${key}`, 'CLAIMED'); }
  const note = String(input.notes ?? '').trim(); if (note) lines.push(`Notes: ${note}`);
  return { text: lines.join('\n'), candidates: cands };
}

// ---------- planning (pure) --------------------------------------------------------------------------------------------------------------------------------------------------
/** @param {{ source: string, text?: string, manual?: object, supplier?: string, lang?: string, meNames?: string[] }} ev */
export function planOffer(ev) {
  const source = Object.values(OFFER_SOURCE).includes(ev.source) ? ev.source : OFFER_SOURCE.PASTED_QUOTE;
  if (source === OFFER_SOURCE.MANUAL) {
    const m = manualOffer(ev.manual ?? {}, ev.lang && ev.lang !== 'auto' ? ev.lang : 'en'); if (!m.text.trim()) throw new Error('an offer needs at least one value or some text');
    return { source, text: m.text, turns: [{ speaker: SPEAKER.SUPPLIER, name: null, at: null, text: m.text }], typed: m.candidates, speakerAssumed: false };
  }
  const text = String(ev.text ?? '').replace(/\r\n?/g, '\n').slice(0, MAX_TEXT); if (!text.trim()) throw new Error('an offer needs some text');
  if (source === OFFER_SOURCE.CHAT && looksLikeChat(text, ev)) return { source, text, turns: parseChat(text, ev), typed: null, speakerAssumed: false };
  // not a chat (or no markers at all): ONE statement, taken as the supplier's because the owner said this is what the supplier sent - the assumption is recorded on the offer
  return { source, text, turns: [{ speaker: SPEAKER.SUPPLIER, name: null, at: null, text: text.trim() }], typed: null, speakerAssumed: source === OFFER_SOURCE.CHAT };
}

// ---------- reducer (called by core/case.js for OFFER_IMPORT) ---------------------------------------------------------------------------------------------------
const COMMERCIAL = new Set(['quote.unitPrice', 'quote.tiers', 'quote.moq', 'quote.leadTime', 'quote.incoterm', 'quote.port', 'quote.currency', 'quote.samplePrice', 'payment.depositPct', 'payment.balancePct', 'payment.balanceDue', 'offer.packaging', 'offer.productionDays', 'offer.customization', 'offer.paymentMethods', 'offer.sampleRefund', 'offer.sampleDays', 'offer.accessories', 'offer.shippingMethod', 'offer.warranty']);
export const isCommercialKey = (k) => COMMERCIAL.has(k);

/** Applies one OFFER_IMPORT to the (already cloned) draft state. Idempotent: the same content is never recorded twice. */
export function applyOfferImport(s, ev, at) {
  s.offers ??= [];
  const plan = planOffer(ev); const supplier = String(ev.supplier ?? s.supplier?.name ?? '').trim();
  const id = ev.offerId ?? offerIdOf({ source: plan.source, supplier, text: plan.text });
  if (s.offers.some((o) => o.id === id)) return { id, duplicate: true };
  if (supplier && !s.supplier?.name) s.supplier = { ...s.supplier, name: supplier };
  const previous = s.offers.at(-1) ?? null; const revision = ev.revision === true || (ev.revision !== false && previous !== null && s.quotes.length > 0);
  conv.start(s, { supplierRef: supplier || s.supplier?.name || null, lang: ev.lang ?? 'auto' }, at); const c = s.conversations.at(-1); const itemIds = [];
  const before = s.candidates.length;
  for (const turn of plan.turns) {
    const speaker = turn.speaker === SPEAKER.ME ? SPEAKER.ME : turn.speaker === SPEAKER.UNKNOWN ? SPEAKER.UNKNOWN : SPEAKER.SUPPLIER;
    conv.addItem(s, { convId: c.id, speaker, text: turn.text, lang: ev.lang ?? 'auto', extract: speaker !== SPEAKER.ME && !plan.typed, source: plan.source, speakerName: turn.name ?? undefined, turnAt: turn.at ?? undefined }, at);
    const item = c.items.at(-1); if (turn.name) item.speakerName = turn.name; if (turn.at) item.turnAt = turn.at; itemIds.push(item.id);
    if (speaker !== SPEAKER.ME) {
      const lang = item.lang; const extras = plan.typed ? [] : extractOfferExtras(turn.text, lang);
      for (const x of plan.typed ?? extras) s.candidates.push({ ...x, id: conv.nextId('cand', s.candidates), convId: c.id, itemId: item.id, speaker, basis: 'ORIGINAL', state: CANDIDATE_STATE.PROPOSED, proposedAt: at });
    }
  }
  const mine = s.candidates.slice(before); const unparsed = [];
  if (!plan.typed) for (const turn of plan.turns) if (turn.speaker !== SPEAKER.ME) { try { for (const u of extractFacts({ text: turn.text, lang: ev.lang ?? 'auto' }).unparsed) if (unparsed.length < 40) unparsed.push(u); } catch { /* the view still works without it */ } }
  for (const cand of mine) { cand.offerId = id; if (revision) cand.supersedes = true; if (plan.speakerAssumed) cand.flags = [...new Set([...(cand.flags ?? []), 'SPEAKER_ASSUMED'])]; }
  conv.finish(s, { convId: c.id }, at);
  s.offers.push({ id, seq: s.offers.length + 1, source: plan.source, kind: revision ? 'REVISION' : 'INITIAL', importedAt: at, supplier: supplier || null, convId: c.id, itemIds, candidateIds: mine.map((x) => x.id), textHash: contentHash(plan.text), chars: plan.text.length, lang: c.items[0]?.lang ?? null, previousOfferId: previous?.id ?? null, speakerAssumed: plan.speakerAssumed, unparsed, importer: IMPORTER_VERSION });
  return { id, duplicate: false, candidates: mine.length };
}

/** For a pasted chat whose names nobody could classify: the events that tell the system who a NAME is (one decision per name, applied to every line that name wrote). */
export function attributeNameEvents(state, offerId, name, speaker) {
  const o = (state.offers ?? []).find((x) => x.id === offerId); if (!o) throw new Error(`unknown offer: ${offerId}`);
  const c = state.conversations.find((x) => x.id === o.convId); const n = String(name).trim().toLowerCase();
  return c.items.filter((i) => i.speaker === SPEAKER.UNKNOWN && String(i.speakerName ?? '').trim().toLowerCase() === n).map((i) => ({ type: 'CONVERSATION_ATTRIBUTE', convId: c.id, itemId: i.id, speaker, summary: `owner says ${name} is ${speaker}` }));
}

// ---------- the OfferDraft view -------------------------------------------------------------------------------------------------------------------------------------------------
export const SECTIONS = Object.freeze({
  identity: ['identifier.model', 'identifier.brand', 'identifier.manufacturer', 'supplier.type'],
  price: ['quote.currency', 'quote.unitPrice', 'quote.tiers', 'quote.moq'],
  logistics: ['quote.incoterm', 'quote.port', 'quote.leadTime', 'offer.productionDays', 'offer.shippingMethod', 'carton.qty', 'carton.dimensions', 'carton.grossWeight', 'carton.netWeight', 'offer.stockStatus'],
  samples: ['quote.samplePrice', 'offer.sampleRefund', 'offer.sampleDays'],
  specs: ['spec.material', 'product.dimensions', 'spec.capacity', 'spec.power', 'spec.outputCount', 'spec.compatibility', 'spec.ageRange', 'variant.colours', 'variant.colourCount'],
  packaging: ['offer.packaging', 'offer.accessories'],
  claims: [], // docClaim.*
  payment: ['payment.depositPct', 'payment.balancePct', 'payment.balanceDue', 'offer.paymentMethods'],
  customization: ['offer.customization'],
  other: ['offer.warranty'],
});
export const sectionOf = (key) => (key.startsWith('docClaim.') ? 'claims' : Object.entries(SECTIONS).find(([, keys]) => keys.includes(key))?.[0] ?? 'other');
/** What an offer is expected to say. Absent => an explicit UNKNOWN row (never a default value). */
export const EXPECTED_KEYS = Object.freeze(['identifier.model', 'quote.currency', 'quote.unitPrice|quote.tiers', 'quote.moq', 'quote.incoterm', 'quote.leadTime|offer.productionDays', 'payment.depositPct|offer.paymentMethods', 'spec.material', 'offer.packaging']);

const REVIEW = (c) => ({ state: c.state === CANDIDATE_STATE.PROPOSED ? 'PENDING' : c.state, at: c.decidedAt ?? null, by: c.decidedBy ?? null, ...(c.original ? { original: c.original, reviewedValue: c.correctedValue ?? null } : {}), ...(c.rejectedReason ? { reason: c.rejectedReason } : {}) });
const statusOf = (c) => (c.state === CANDIDATE_STATE.CORRECTED ? FACT_STATUS.USER_PROVIDED : c.state === CANDIDATE_STATE.CONFLICT ? FACT_STATUS.CONFLICT : c.state === CANDIDATE_STATE.REJECTED ? 'REJECTED' : FACT_STATUS.SUPPLIER_CLAIM);

/** Pure view: the normalized draft of one offer, built from the candidates / ledger / conflicts that already exist. Nothing here is stored. */
export function offerDraft(state, offerId) {
  const o = (state.offers ?? []).find((x) => x.id === offerId); if (!o) return null;
  const current = new Map(caseFacts(state).map((f) => [f.key, f]));
  const cands = state.candidates.filter((c) => c.offerId === o.id);
  const fields = cands.map((c) => {
    const led = state.ledger.find((e) => e.source?.candidateId === c.id) ?? null; const cf = state.conflicts.find((x) => x.candidateId === c.id && x.state === 'OPEN') ?? null;
    const curF = typeOfKey(c.key) ? current.get(c.key) ?? null : null; const mine = c.correctedValue ?? c.value; const decided = c.state === CANDIDATE_STATE.CONFIRMED || c.state === CANDIDATE_STATE.CORRECTED;
    // THIS screen reviews what one offer said; the case may hold something else today (a later offer, a later correction). The current fact is shown beside it so the two can never be mistaken for each other.
    const currentFact = curF ? { fact_type: curF.fact_type, value: curF.value, unit: curF.unit, source_type: curF.source_type, review_status: curF.review_status, revision: curF.revision } : null; const historical = decided && currentFact !== null && !sameFactValue(c.key, mine, currentFact.value);
    return { id: c.id, key: c.key, context: c.context, section: sectionOf(c.key), current: currentFact, historical, reverted: c.correctionReverted ?? null, value: c.correctedValue ?? c.value, originalValue: c.value, status: statusOf(c), review: REVIEW(c), rawText: c.rawText, span: c.span, speaker: c.speaker, flags: c.flags ?? [], needsCorrection: c.needsCorrection === true, confidence: c.confidence, supersedes: c.supersedes === true, ledgerId: led?.id ?? null, conflictId: cf?.id ?? null, itemId: c.itemId };
  });
  const live = fields.filter((f) => f.status !== 'REJECTED');
  const unknown = EXPECTED_KEYS.filter((alt) => !alt.split('|').some((k) => live.some((f) => f.key === k && f.context === 'product'))).map((alt) => ({ key: alt.split('|')[0], alternatives: alt.split('|'), status: FACT_STATUS.UNKNOWN, value: null, section: sectionOf(alt.split('|')[0]) }));
  const sections = {}; for (const f of fields) (sections[f.section] ??= []).push(f);
  const count = (st) => fields.filter((f) => f.review.state === st).length;
  return { id: o.id, seq: o.seq, kind: o.kind, source: o.source, importedAt: o.importedAt, supplier: o.supplier, previousOfferId: o.previousOfferId, textHash: o.textHash, chars: o.chars, speakerAssumed: o.speakerAssumed === true,
    fields, sections, unknown, unparsed: o.unparsed ?? [], counts: { total: fields.length, pending: count('PENDING'), confirmed: count('CONFIRMED'), corrected: count('CORRECTED'), rejected: count('REJECTED'), conflict: count('CONFLICT') },
    isLatest: (state.offers ?? []).at(-1)?.id === o.id, complete: fields.length > 0 && fields.every((f) => f.review.state !== 'PENDING'), unknownSpeakers: [...new Set(state.conversations.find((c) => c.id === o.convId)?.items.filter((i) => i.speaker === SPEAKER.UNKNOWN).map((i) => i.speakerName ?? '(unnamed)') ?? [])], noVerified: true };
}
export const listOffers = (state) => (state.offers ?? []).map((o) => ({ id: o.id, seq: o.seq, kind: o.kind, source: o.source, importedAt: o.importedAt, supplier: o.supplier, previousOfferId: o.previousOfferId }));
export { detectLang };
