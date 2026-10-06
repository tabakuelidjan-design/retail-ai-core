// English deterministic extraction. Narrow, high-value patterns only; nothing is inferred beyond what the words say, and every guess-like step is flagged.
import { parseNumberToken } from './numbers.js';
import { INCOTERMS, PLACES, COLOURS, segments, sentences, within, boundaryBetween, mk, currencyOf } from './shared.js';

const CUR = '(?:US\\$|USD|RMB|CNY|EUR|[$¥￥€])'; const NUM = '\\d[\\d.,]*\\d|\\d';
const RX_PRICE_A = new RegExp(`(${CUR})\\s?(${NUM})`, 'gi');
const RX_PRICE_B = new RegExp(`(?<![A-Za-z0-9.,])(${NUM})\\s?(USD|RMB|CNY|EUR|dollars?|yuan|euros?)\\b`, 'gi');
const UNIT = '(?:pcs?|pieces?|units?|sets?)';
const RX_QTY = new RegExp(`(?<![A-Za-z0-9.,])(\\d[\\d,]*)\\s?\\+?\\s?${UNIT}\\b`, 'gi');
const SKIP_PRICE_CLAUSE = /freight|shipping|tooling|\bmou?ld\b|set-?up|deposit|prepay|\bDHL\b|\bexpress\b|logo fee|insurance/i;

export function priceTokens(text) {
  const out = [];
  for (const m of text.matchAll(RX_PRICE_A)) out.push({ start: m.index, end: m.index + m[0].length, cur: m[1], num: m[2] });
  for (const m of text.matchAll(RX_PRICE_B)) out.push({ start: m.index, end: m.index + m[0].length, cur: m[2], num: m[1] });
  return out.sort((a, b) => a.start - b.start).filter((t, i, a) => !a.slice(0, i).some((p) => p.start < t.end && t.start < p.end));
}
export function qtyTokens(text) {
  const out = [];
  for (const m of text.matchAll(RX_QTY)) {
    const before = text.slice(Math.max(0, m.index - 22), m.index); const after = text.slice(m.index + m[0].length, m.index + m[0].length + 22);
    if (/(?:MOQ|minimum(?: order)?(?: quantity)?)[\s:=]*(?:is|of|are)?[\s:=]*(?:about|around|at least)?\s*$/i.test(before)) continue;
    if (/^\s*(?:is\s+)?(?:minimum|MOQ|min\.?\s*order)/i.test(after)) continue;
    if (/^\s*(?:per|\/|in (?:a|one)|each)\s*(?:master\s+)?(?:carton|ctn|box|colou?r)/i.test(after)) continue;
    if (/(?:carton|ctn|box)\s*(?:of|:|=)\s*$/i.test(before)) continue;
    out.push({ start: m.index, end: m.index + m[0].length, num: m[1] });
  }
  return out;
}

/**
 * Binds each price to ITS quantity. A price can be written BEFORE its quantity ("USD 8 for 50 pcs", "$7.20/pc at 100", "$8/pc MOQ 50") or AFTER it ("50 pcs: $8", "For 300 pcs we can do USD 6.80").
 * The old rule paired every quantity with the NEXT price, so in "USD 8 for 50 pcs, USD 7.20 for 100 pcs" the 50 stole the 7.20 that belongs to 100. Now every possible binding is an explicit edge with a
 * strength (a connective such as "for/at/MOQ", or a separator such as ":" and "=", beats mere adjacency, which beats a bare comma) and the strongest edges win, each price and each quantity used once.
 * A price never crosses a sentence boundary to reach a quantity.
 */
const CONNECT = '(?:for|at|from|over|above|x|min(?:imum)?\\.?|MOQ|if you (?:buy|order)|when you (?:buy|order)|if (?:buying|ordering)|when (?:buying|ordering))';
const RX_FWD = new RegExp(`^\\s*(?:(?:\\/|per\\s+)\\s*[A-Za-z]+\\s*)?(?:each\\s+)?(?:,\\s*)?${CONNECT}\\s+(?:the\\s+)?(\\d{1,3}(?:,\\d{3})+|\\d+)(\\s*\\+)?(\\s*${UNIT}\\b)?`, 'id');
const SEP_STRONG = /^[\s]*(?:[:=\-–—→@]|->|=>)[\s]*(?:(?:we can do|can do|is|at|price|each|only)\s*)*$|^\s*(?:(?:we can do|can do|is|at|price is|price|each|only)\s+)+$/i;
const BARE_OK = /^\s*(?:$|[,;.)]|and\b|or\b|\/)/i; // a bare number after a connective counts as a quantity only when the next word is not a unit of something else
function pairTiers(text, prices, qtys) {
  const edges = []; const fwdQty = new Map();
  const qtyAt = (start, end, num) => { const hit = qtys.find((q) => q.start === start) ?? fwdQty.get(start); if (hit) return hit; const q = { start, end, num, bare: true }; fwdQty.set(start, q); return q; };
  for (const p of prices) {
    const rest = text.slice(p.end); const m = RX_FWD.exec(rest);
    if (m) {
      const numStart = p.end + m.indices[1][0]; const withUnit = !!m[3]; const after = rest.slice(m[0].length);
      if (withUnit || BARE_OK.test(after) || /^\s*(?:US\$|USD|RMB|CNY|EUR|[$¥￥€])/i.test(after)) {
        const end = p.end + m[0].length; const q = qtyAt(numStart, end, m[1]);
        if (!boundaryBetween(text, p.end, numStart)) edges.push({ p, q, strength: 3, dist: numStart - p.end });
      }
    }
  }
  for (const q of qtys) {
    for (const p of prices) {
      if (p.start < q.end) continue; const between = text.slice(q.end, p.start); if (between.length > 60 || boundaryBetween(text, q.end, p.start)) continue;
      const strength = SEP_STRONG.test(between) ? 3 : /^\s*$/.test(between) ? 2 : /^\s*,\s*$/.test(between) ? 1 : 0;
      if (strength) edges.push({ p, q, strength, dist: p.start - q.end });
    }
  }
  edges.sort((a, b) => b.strength - a.strength || a.dist - b.dist || a.q.start - b.q.start);
  const usedP = new Set(); const usedQ = new Set(); const pairs = [];
  for (const e of edges) { if (usedP.has(e.p) || usedQ.has(e.q.start)) continue; usedP.add(e.p); usedQ.add(e.q.start); pairs.push({ q: e.q, p: e.p }); }
  return { pairs, used: usedP };
}

const moqContext = (seg, sent, singleMoq) => {
  const cue = (s) => (/per\s*colou?r/i.test(s) ? 'per_colour' : /logo|custom|OEM|ODM|print|brand/i.test(s) ? (/packag/i.test(s) && !/logo/i.test(s) ? 'custom_packaging' : 'custom_logo') : /packag/i.test(s) ? 'custom_packaging' : /sample/i.test(s) ? 'sample' : null);
  return cue(seg) ?? (singleMoq ? cue(sent) : null) ?? 'product';
};

export function extractEn(text, lang) {
  const out = []; const segs = segments(text); const sents = sentences(text);
  const prices = priceTokens(text); const qtys = qtyTokens(text);

  // ---- tiers (quantity -> price pairs), then lone prices ----
  const tierPrices = prices.filter((p) => !SKIP_PRICE_CLAUSE.test(within(segs, p.start).text) && !/sample/i.test(within(sents, p.start).text));
  const { pairs, used } = pairTiers(text, tierPrices, qtys);
  const priceCand = (p, extra) => { const n = parseNumberToken(p.num, 'price'); return { n, amb: n.ambiguous, ...extra }; };
  if (pairs.length) {
    const start = Math.min(...pairs.map((x) => Math.min(x.q.start, x.p.start))); const end = Math.max(...pairs.map((x) => Math.max(x.q.end, x.p.end)));
    const rows = pairs.map(({ q, p }) => ({ qn: parseNumberToken(q.num, 'quantity'), pn: parseNumberToken(p.num, 'price'), p })).sort((a, b) => (a.qn.value === null || b.qn.value === null ? 0 : Number(a.qn.value) - Number(b.qn.value)));
    const amb = rows.some((r) => r.qn.ambiguous || r.pn.ambiguous); const dup = rows.some((r, i) => r.qn.value !== null && rows.findIndex((x) => x.qn.value === r.qn.value) !== i);
    out.push(mk(text, lang, 'quote.tiers', rows.map((r) => ({ minQty: r.qn.value, unitPrice: r.pn.value })), start, end, { confidence: rows.every((r) => !/^[$¥￥€]$/.test(r.p.cur)) ? 'HIGH' : 'MEDIUM', flags: [...(amb ? ['AMBIGUOUS_NUMBER'] : []), ...(dup ? ['DUPLICATE_THRESHOLD'] : [])], needsCorrection: amb || dup, reason: 'quantity-price pairs' }));
  }
  for (const p of prices) {
    if (used.has(p)) continue;
    const seg = within(segs, p.start).text; const sent = within(sents, p.start).text;
    if (/sample/i.test(sent) && !SKIP_PRICE_CLAUSE.test(seg)) { const n = parseNumberToken(p.num, 'price'); out.push(mk(text, lang, 'quote.samplePrice', n.value, p.start, p.end, { context: 'sample', needsCorrection: n.ambiguous, flags: n.flags, ...(n.suggestion ? { suggestion: n.suggestion } : {}), reason: 'sample price' })); continue; }
    if (SKIP_PRICE_CLAUSE.test(seg)) continue;
    const n = parseNumberToken(p.num, 'price');
    out.push(mk(text, lang, 'quote.unitPrice', n.value, p.start, p.end, { confidence: n.ambiguous ? 'LOW' : 'HIGH', flags: n.flags, needsCorrection: n.ambiguous, ...(n.suggestion ? { suggestion: n.suggestion } : {}), reason: 'price with currency' }));
  }
  void priceCand;
  if (prices.length) { // currency: one candidate per distinct currency, flagged when only a symbol told us
    const seen = new Set();
    for (const p of prices) { const c = currencyOf(p.cur); if (!c || seen.has(c.code)) continue; seen.add(c.code); const ambiguous = c.symbol; out.push(mk(text, lang, 'quote.currency', c.code, p.start, p.end, { confidence: ambiguous ? 'MEDIUM' : 'HIGH', flags: [...(ambiguous ? ['CURRENCY_FROM_SYMBOL'] : []), ...(seen.size > 1 ? ['MULTIPLE_CURRENCIES'] : [])], reason: 'currency' })); }
  }

  // ---- MOQ ----
  const moqs = [];
  for (const m of text.matchAll(/\b(?:MOQ|minimum order(?: quantity)?|min\.? order(?: quantity)?)\b\s*(?:is|of|:|=|-|are)?\s*(?:about|around|at least)?\s*(\d[\d,]*)\s*(?:pcs?|pieces?|units?|sets?)?/gi)) moqs.push({ start: m.index, end: m.index + m[0].length, num: m[1] });
  for (const m of text.matchAll(/(\d[\d,]*)\s*(?:pcs?|pieces?|units?|sets?)\s*(?:is\s+)?(?:minimum|MOQ|min\.?\s*order)\b/gi)) if (!moqs.some((x) => x.start < m.index + m[0].length && m.index < x.end)) moqs.push({ start: m.index, end: m.index + m[0].length, num: m[1] });
  for (const mo of moqs) {
    const seg = within(segs, mo.start).text; const sent = within(sents, mo.start); const same = moqs.filter((x) => x.start >= sent.start && x.start <= sent.end).length === 1;
    if (/per\s*colou?r/i.test(seg) && /MOQ\s+per/i.test(text.slice(mo.start, mo.end + 12))) continue; // handled as moq.perColour
    const n = parseNumberToken(mo.num, 'quantity'); const ctx = moqContext(seg, sent.text, same);
    out.push(mk(text, lang, 'quote.moq', n.value, mo.start, mo.end, { context: ctx, needsCorrection: n.ambiguous, flags: n.flags, confidence: n.ambiguous ? 'LOW' : 'HIGH', reason: 'minimum order quantity' }));
  }

  // ---- Incoterm + place ----
  for (const m of text.matchAll(/(?<![A-Za-z0-9])(EXW|FCA|FOB|CFR|CIF|CPT|CIP|DAP|DPU|DDP)(?![A-Za-z0-9])/g)) {
    if (!INCOTERMS.includes(m[1])) continue;
    out.push(mk(text, lang, 'quote.incoterm', m[1], m.index, m.index + m[0].length, { confidence: 'HIGH', reason: 'Incoterm' }));
    const after = text.slice(m.index + m[0].length); const pm = /^\s*[,:-]?\s*([A-Z][A-Za-z]+(?:\s[A-Z][A-Za-z]+)?)/.exec(after);
    if (pm) {
      let place = pm[1]; const STOP = /^(Port|Price|And|With|Is|At|For|The|Please|We|Our|USD|RMB|EUR|CNY|MOQ|Payment|Delivery|Lead|Total)$/;
      const words = place.split(' '); if (STOP.test(words[0])) continue; if (words.length > 1 && STOP.test(words[1])) place = words[0];
      const off = m.index + m[0].length + pm[0].indexOf(pm[1]); const listed = PLACES.has(place);
      out.push(mk(text, lang, 'quote.port', place, off, off + place.length, { confidence: listed ? 'HIGH' : 'MEDIUM', flags: listed ? [] : ['UNLISTED_PLACE'], reason: 'place after Incoterm' }));
    }
  }

  // ---- payment ----
  let dep = null; let bal = null;
  const mDep = /(\d{1,3})\s?%\s*(?:T\/T\s*)?(?:as\s+)?(?:deposit|down\s?payment|advance|prepay(?:ment)?|in advance)/i.exec(text) ?? /(?:deposit|down\s?payment|advance(?: payment)?)\s*(?:of|:|is|=)?\s*(\d{1,3})\s?%/i.exec(text);
  const mBal = /(\d{1,3})\s?%\s*(?:balance|before shipment|against\s+(?:copy of\s+)?B\/?L|after\s+(?:inspection|production)|on delivery|at shipment|before delivery)/i.exec(text) ?? /balance\s*(?:of|:|is|=)?\s*(\d{1,3})\s?%/i.exec(text);
  const mSlash = !mDep && !mBal ? /\b(?:payment(?:\s+terms?)?|T\/T|terms)\b[^.\n]{0,25}?(\d{1,3})\s?%?\s*\/\s*(\d{1,3})\s?%?/i.exec(text) : null;
  if (mDep) { dep = Number(mDep[1]); out.push(mk(text, lang, 'payment.depositPct', mDep[1], mDep.index, mDep.index + mDep[0].length, { reason: 'deposit percentage' })); }
  if (mSlash) { dep = Number(mSlash[1]); bal = Number(mSlash[2]); const bad = dep + bal !== 100; out.push(mk(text, lang, 'payment.depositPct', mSlash[1], mSlash.index, mSlash.index + mSlash[0].length, { reason: 'payment split a/b', needsCorrection: bad, flags: bad ? ['SUM_NOT_100'] : [] })); out.push(mk(text, lang, 'payment.balancePct', mSlash[2], mSlash.index, mSlash.index + mSlash[0].length, { reason: 'payment split a/b', needsCorrection: bad, flags: bad ? ['SUM_NOT_100'] : [] })); }
  if (mBal) { bal = Number(mBal[1]); const bad = dep !== null && dep + bal !== 100; out.push(mk(text, lang, 'payment.balancePct', mBal[1], mBal.index, mBal.index + mBal[0].length, { reason: 'balance percentage', needsCorrection: bad, flags: bad ? ['SUM_NOT_100'] : [] })); }
  else if (dep !== null && !mSlash) { const w = /\bbalance\b/i.exec(text); if (w) out.push(mk(text, lang, 'payment.balancePct', String(100 - dep), w.index, w.index + w[0].length, { confidence: 'MEDIUM', flags: ['DERIVED'], reason: '100 minus the stated deposit' })); }
  const due = /(?:balance|remaining|rest|\d{1,3}\s?%)[^.\n]{0,25}?\b(before shipment|before delivery|against\s+(?:copy of\s+)?B\/?L|after inspection|on delivery|at shipment|before loading)\b/i.exec(text);
  if (due) { const i = due.index + due[0].toLowerCase().lastIndexOf(due[1].toLowerCase()); out.push(mk(text, lang, 'payment.balanceDue', due[1].toLowerCase().replace(/\s+/g, ' ').replace('b/l', 'B/L').replace('bl', 'B/L'), i, i + due[1].length, { reason: 'when the balance is due' })); }

  // ---- lead time ----
  const lt = /(?:lead\s?time|production(?:\s+(?:time|period|cycle))?|delivery(?:\s+time)?|ready in|ready within|ship(?:ped|ment)?(?:\s+(?:in|within))?|within)\s*(?:is|of|:|=)?\s*(?:about|around|approx\.?)?\s*(\d{1,3})(?:\s?(?:-|–|to)\s?(\d{1,3}))?\s*(?:(?:working|business|calendar)\s+)?(days?|weeks?)/i.exec(text) ?? /(\d{1,3})(?:\s?(?:-|–|to)\s?(\d{1,3}))?\s*(?:(?:working|business|calendar)\s+)?(days?|weeks?)\s+(?:of\s+)?(?:lead\s?time|production|delivery)/i.exec(text);
  if (lt) { const wk = /^w/i.test(lt[3]); const lo = Number(lt[1]) * (wk ? 7 : 1); const hi = Number(lt[2] ?? lt[1]) * (wk ? 7 : 1); out.push(mk(text, lang, 'quote.leadTime', { min: String(lo), max: String(hi), unit: 'days' }, lt.index, lt.index + lt[0].length, { flags: wk ? ['WEEKS_CONVERTED'] : [], reason: 'lead time' })); }

  // ---- colours ----
  const COL = Object.keys(COLOURS).join('|');
  const cl = new RegExp(`(?:colou?rs?(?:\\s+(?:available|are|include|we have))?\\s*[:\\-]?\\s*|available in\\s+)((?:${COL})(?:\\s*(?:,|and|&|/|or)\\s*(?:${COL}))*)`, 'i').exec(text);
  if (cl) { const list = [...cl[1].toLowerCase().matchAll(new RegExp(COL, 'g'))].map((x) => COLOURS[x[0]]); const s0 = cl.index + cl[0].indexOf(cl[1]); out.push(mk(text, lang, 'variant.colours', [...new Set(list)], s0, s0 + cl[1].length, { reason: 'colour list' })); }
  if (!cl) { // a list of two or more colours after "we have / we offer / comes in": proposed with a lower confidence (it may describe something else)
    const bl = new RegExp(`(?:we have|we offer|we do|comes? in|are available in|is available in)\\s+((?:${COL})(?:\\s*(?:,|and|&|/|or)\\s*(?:${COL}))+)`, 'i').exec(text);
    if (bl) { const list = [...bl[1].toLowerCase().matchAll(new RegExp(COL, 'g'))].map((x) => COLOURS[x[0]]); const s0 = bl.index + bl[0].indexOf(bl[1]); out.push(mk(text, lang, 'variant.colours', [...new Set(list)], s0, s0 + bl[1].length, { confidence: 'MEDIUM', reason: 'colour list after "we have"' })); }
  }
  const cc = /(?<!per\s)\b(\d{1,2})\s+colou?rs?\b/i.exec(text); if (cc) out.push(mk(text, lang, 'variant.colourCount', cc[1], cc.index, cc.index + cc[0].length, { reason: 'colour count' }));
  for (const seg of segs) {
    const neg = /\b(?:cannot|can't|can not|couldn't|unable to|no|not|don't|do not)\s+(?:be\s+)?mix(?:ed|ing)?|\bcolou?rs?\s+(?:cannot|can't|can not)\s+be\s+mix(?:ed)?/i.exec(seg.text);
    const pos = neg ? null : /\b(?:can|could|may|able to|allowed to|ok to)\s+(?:be\s+)?mix(?:ed)?\b|\bmix(?:ed|ing)?\s+(?:the\s+)?colou?rs?\b|\bcolou?rs?\s+(?:can|could)\s+be\s+mix(?:ed)?\b|\bmixed colou?rs?\s+(?:is |are )?(?:ok|okay|fine|accepted|possible)\b/i.exec(seg.text);
    const m = neg ?? pos; if (m) out.push(mk(text, lang, 'moq.mixedColours', !neg, seg.start + m.index, seg.start + m.index + m[0].length, { reason: neg ? 'mixing refused' : 'mixing allowed' }));
  }
  const pc = /(\d[\d,]*)\s*(?:pcs?|pieces?|units?)?\s*(?:per|each|\/)\s*colou?rs?\b/i.exec(text) ?? /MOQ\s+per\s+colou?rs?\s*(?:is|:|=)?\s*(\d[\d,]*)/i.exec(text);
  if (pc) { const n = parseNumberToken(pc[1], 'quantity'); out.push(mk(text, lang, 'moq.perColour', n.value, pc.index, pc.index + pc[0].length, { needsCorrection: n.ambiguous, flags: n.flags, reason: 'minimum per colour' })); }

  // ---- carton ----
  const cq = /(\d[\d,]*)\s*(?:pcs?|pieces?|units?|sets?)\s*(?:per|\/|in (?:a|one)|each)\s*(?:master\s+)?(?:carton|ctn|box)\b/i.exec(text) ?? /\b(?:carton|ctn|box)\s*(?:of|:|=)\s*(\d[\d,]*)\s*(?:pcs?|pieces?|units?)?/i.exec(text);
  if (cq) { const n = parseNumberToken(cq[1], 'quantity'); out.push(mk(text, lang, 'carton.qty', n.value, cq.index, cq.index + cq[0].length, { needsCorrection: n.ambiguous, flags: n.flags, reason: 'units per carton' })); }
  const dim = /(\d+(?:\.\d+)?)\s*[x×*]\s*(\d+(?:\.\d+)?)\s*[x×*]\s*(\d+(?:\.\d+)?)\s*(cm|mm|m)\b/i.exec(text);
  if (dim) { const isCarton = /carton|ctn|packing|box|size|dimension/i.test(within(segs, dim.index).text) && /carton|ctn|packing|box/i.test(within(segs, dim.index).text); out.push(mk(text, lang, isCarton ? 'carton.dimensions' : 'product.dimensions', { l: dim[1], w: dim[2], h: dim[3], unit: dim[4].toLowerCase() }, dim.index, dim.index + dim[0].length, { reason: 'three dimensions' })); }
  const gw = /(?:G\.?\s?W\.?|gross\s+weight)\s*[:=]?\s*(\d+(?:\.\d+)?)\s*(kgs?|g)\b/i.exec(text); if (gw) out.push(mk(text, lang, 'carton.grossWeight', { amount: gw[1], unit: /^kg/i.test(gw[2]) ? 'kg' : 'g' }, gw.index, gw.index + gw[0].length, { reason: 'gross weight' }));
  const nw = /(?:N\.?\s?W\.?|net\s+weight)\s*[:=]?\s*(\d+(?:\.\d+)?)\s*(kgs?|g)\b/i.exec(text); if (nw) out.push(mk(text, lang, 'carton.netWeight', { amount: nw[1], unit: /^kg/i.test(nw[2]) ? 'kg' : 'g' }, nw.index, nw.index + nw[0].length, { reason: 'net weight' }));

  // ---- identifiers: preserved EXACTLY as written ----
  const mm = /\b(model(?:\s+(?:no\.?|number|name|type))?|type(?:\s+no\.?)?|item\s+(?:no\.?|number)|part\s+(?:no\.?|number)|P\/N|article\s+(?:no\.?|number))\s*[:#=]?\s*(?:is\s+)?([A-Za-z0-9][A-Za-z0-9\-_/.]*[A-Za-z0-9]|[A-Za-z0-9])(?:\s([A-Z]\d+[A-Za-z]?)\b)?/i.exec(text);
  if (mm) {
    let val = mm[3] && /^[A-Za-z]{1,4}$/.test(mm[2]) ? `${mm[2]} ${mm[3]}` : mm[2]; val = val.replace(/[.\-_/]+$/, '');
    if (/\d/.test(val) && val.length >= 3 && !/^\d{1,3}$/.test(val)) { const s0 = mm.index + mm[0].indexOf(val, mm[1].length); out.push(mk(text, lang, 'identifier.model', val, s0, s0 + val.length, { confidence: /^model/i.test(mm[1]) ? 'HIGH' : 'MEDIUM', reason: 'model identifier, kept as written' })); }
  }
  if (!out.some((c) => c.key === 'identifier.model')) { // no label: only a code-shaped word at the very START of the message ("PB-X200. MOQ is 50 pcs."), proposed LOW with a warning
    const um = /^\s*([A-Z]{1,5}-?[A-Z]?\d{2,5}[A-Z]{0,2}(?:[-/][A-Z0-9]+)?)(?=[\s.,;:!?]|$)/.exec(text);
    if (um && !/^(?:UN|IEC|ISO|EN|ETSI|ASTM|IP|USB|HDMI|RJ|LED|GB|CE|FCC)-?\d/.test(um[1])) { const s0 = um.index + um[0].indexOf(um[1]); out.push(mk(text, lang, 'identifier.model', um[1], s0, s0 + um[1].length, { confidence: 'LOW', flags: ['UNLABELLED_IDENTIFIER'], reason: 'a code at the start of the message, kept as written' })); }
  }
  const br = /\bbrand(?:\s+name)?\s*[:=]\s*([^\n,;.]{2,40})/i.exec(text); if (br) { const s0 = br.index + br[0].indexOf(br[1]); out.push(mk(text, lang, 'identifier.brand', br[1].trim(), s0, s0 + br[1].trim().length, { confidence: 'MEDIUM', reason: 'brand' })); }
  const mf = /\b(?:manufacturer|factory name|company name)\s*[:=]\s*([^\n,;]{3,60})/i.exec(text); if (mf) { const s0 = mf.index + mf[0].indexOf(mf[1]); out.push(mk(text, lang, 'identifier.manufacturer', mf[1].trim(), s0, s0 + mf[1].trim().length, { confidence: 'MEDIUM', reason: 'manufacturer name' })); }

  return out;
}
