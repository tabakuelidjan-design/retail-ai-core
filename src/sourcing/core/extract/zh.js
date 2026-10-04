// Chinese deterministic extraction: a SMALL set of defensible patterns for numbers, units, payment words, lead time, model identifiers, colours and document claims.
// It does NOT understand Chinese. Anything it does not match stays in `unparsed`, and the Chinese original is always preserved (rawText / span point into it).
import { parseNumberToken, wanToNumber } from './numbers.js';
import { ZH_PLACES, ZH_COLOURS, INCOTERMS, segments, within, boundaryBetween, mk, currencyOf } from './shared.js';

const UNIT = '(?:个|件|台|套|只|pcs|PCS)';
const NUMW = '\\d[\\d,.]*万?';
const ZH_CUR = '(?:元|块钱|块|人民币|美元|美金|刀|欧元)';
const RX_PRICE_B = new RegExp(`(?<![A-Za-z0-9.,])(\\d[\\d.,]*\\d|\\d)\\s?(${ZH_CUR})`, 'g');
const RX_PRICE_A = /(美元|美金|人民币|欧元)\s?(\d[\d.,]*\d|\d)/g;
const RX_QTY = new RegExp(`(?<![A-Za-z0-9.,])(${NUMW})\\s?${UNIT}(?:以上)?`, 'g');

function qty(raw) { // "1万" -> 10000 (explicit, flagged); plain digits via the shared number rules
  const w = wanToNumber(raw); if (raw.endsWith('万')) return { value: w, ambiguous: w === null, flags: ['WAN_CONVERTED'] };
  const n = parseNumberToken(raw.replace(/,/g, ',') , 'quantity'); return { value: n.value, ambiguous: n.ambiguous, flags: n.flags };
}
const ptoks = (text) => { const out = []; for (const m of text.matchAll(RX_PRICE_B)) out.push({ start: m.index, end: m.index + m[0].length, cur: m[2], num: m[1] }); for (const m of text.matchAll(RX_PRICE_A)) out.push({ start: m.index, end: m.index + m[0].length, cur: m[1], num: m[2] }); return out.sort((a, b) => a.start - b.start).filter((t, i, a) => !a.slice(0, i).some((p) => p.start < t.end && t.start < p.end)); };

export function extractZh(text, lang) {
  const out = []; const segs = segments(text);
  // ---- prices and tiers (Chinese currency words only; Latin codes and symbols are handled by the English rules) ----
  const prices = ptoks(text);
  const qtys = []; for (const m of text.matchAll(RX_QTY)) { const before = text.slice(Math.max(0, m.index - 6), m.index); const after = text.slice(m.index + m[0].length, m.index + m[0].length + 3); if (/起订量[:：]?$|MOQ[:：]?\s*$/i.test(before) || /^起订|^\/?箱|^每箱/.test(after) || /每箱$/.test(before)) continue; qtys.push({ start: m.index, end: m.index + m[0].length, num: m[1] }); }
  const used = new Set(); const pairs = [];
  for (const q of qtys) { const nextQ = qtys.find((x) => x.start > q.start)?.start ?? Infinity; const p = prices.find((x) => !used.has(x) && x.start >= q.end && x.start < nextQ && x.start - q.end <= 30 && !boundaryBetween(text, q.end, x.start)); if (p) { used.add(p); pairs.push({ q, p }); } }
  if (pairs.length) {
    const start = Math.min(...pairs.map((x) => Math.min(x.q.start, x.p.start))); const end = Math.max(...pairs.map((x) => Math.max(x.q.end, x.p.end)));
    const rows = pairs.map(({ q, p }) => ({ qn: qty(q.num), pn: parseNumberToken(p.num, 'price') })); const bad = rows.some((r) => r.qn.ambiguous || r.pn.ambiguous);
    out.push(mk(text, lang, 'quote.tiers', rows.map((r) => ({ minQty: r.qn.value, unitPrice: r.pn.value })), start, end, { flags: bad ? ['AMBIGUOUS_NUMBER'] : [], needsCorrection: bad, reason: '数量-单价' }));
  }
  const seenCur = new Set();
  for (const p of prices) {
    if (!used.has(p)) { const n = parseNumberToken(p.num, 'price'); out.push(mk(text, lang, 'quote.unitPrice', n.value, p.start, p.end, { confidence: n.ambiguous ? 'LOW' : 'HIGH', flags: n.flags, needsCorrection: n.ambiguous, ...(n.suggestion ? { suggestion: n.suggestion } : {}), reason: '价格' })); }
    const c = currencyOf(p.cur); if (c && !seenCur.has(c.code)) { seenCur.add(c.code); out.push(mk(text, lang, 'quote.currency', c.code, p.start, p.end, { reason: '币种' })); }
  }
  // ---- MOQ ----
  const moqRx = new RegExp(`(?:最小)?起订量\\s*[:：]?\\s*(${NUMW})\\s*${UNIT}?|(${NUMW})\\s*${UNIT}\\s*起订`, 'g');
  for (const m of text.matchAll(moqRx)) {
    const raw = m[1] ?? m[2]; const n = qty(raw); const seg = within(segs, m.index).text;
    const ctx = /每\s*个?颜色|每色/.test(seg) ? 'per_colour' : /logo|LOGO|Logo|定制|OEM|ODM|印|丝印|烫金/.test(seg) ? 'custom_logo' : /包装/.test(seg) ? 'custom_packaging' : /样品/.test(seg) ? 'sample' : 'product';
    out.push(mk(text, lang, 'quote.moq', n.value, m.index, m.index + m[0].length, { context: ctx, needsCorrection: n.ambiguous, flags: n.flags, confidence: n.ambiguous ? 'LOW' : 'HIGH', reason: '起订量' }));
  }
  // ---- place after an Incoterm, or a loading port word ----
  const placeRx = new RegExp(`(${INCOTERMS.join('|')})\\s*(${Object.keys(ZH_PLACES).join('|')})`, 'g');
  for (const m of text.matchAll(placeRx)) { const s0 = m.index + m[0].length - m[2].length; out.push(mk(text, lang, 'quote.port', ZH_PLACES[m[2]], s0, s0 + m[2].length, { reason: '贸易术语后的地点 (original kept in rawText)' })); }
  if (!out.some((c) => c.key === 'quote.port')) for (const m of text.matchAll(new RegExp(`(${Object.keys(ZH_PLACES).join('|')})港`, 'g'))) out.push(mk(text, lang, 'quote.port', ZH_PLACES[m[1]], m.index, m.index + m[0].length, { confidence: 'MEDIUM', reason: '港' }));
  // ---- deposit / balance ----
  const dep = /定金\s*(\d{1,3})\s?%|订金\s*(\d{1,3})\s?%|(\d{1,3})\s?%\s*(?:定金|订金|预付款|预付)/.exec(text);
  const bal = /尾款\s*(\d{1,3})\s?%|(\d{1,3})\s?%\s*尾款/.exec(text);
  let depV = null; if (dep) { depV = Number(dep[1] ?? dep[2] ?? dep[3]); out.push(mk(text, lang, 'payment.depositPct', String(depV), dep.index, dep.index + dep[0].length, { reason: '定金' })); }
  if (bal) { const b = Number(bal[1] ?? bal[2]); const bad = depV !== null && depV + b !== 100; out.push(mk(text, lang, 'payment.balancePct', String(b), bal.index, bal.index + bal[0].length, { needsCorrection: bad, flags: bad ? ['SUM_NOT_100'] : [], reason: '尾款' })); }
  else if (depV !== null) { const w = /尾款/.exec(text); if (w) out.push(mk(text, lang, 'payment.balancePct', String(100 - depV), w.index, w.index + w[0].length, { confidence: 'MEDIUM', flags: ['DERIVED'], reason: '100 减去已说明的定金' })); }
  const due = /(发货前|出货前|装船前|装货前|交货前|见提单|提单副本)[^，。;；,]{0,6}尾款|尾款[^，。;；,]{0,6}(发货前|出货前|装船前|装货前|交货前|见提单|提单副本)/.exec(text);
  if (due) { const w = due[1] ?? due[2]; out.push(mk(text, lang, 'payment.balanceDue', /提单/.test(w) ? 'against B/L' : /交货/.test(w) ? 'before delivery' : /装/.test(w) && !/发货|出货/.test(w) ? 'before loading' : 'before shipment', due.index, due.index + due[0].length, { reason: '尾款时间' })); }
  // ---- lead time ----
  const lt = /(?:交期|货期|生产周期|交货期|交货时间|生产时间)\s*[:：]?\s*(?:大概|大约|约)?\s*(\d{1,3})(?:\s?[-~～到至]\s?(\d{1,3}))?\s*(个工作日|工作日|天|日|周|个星期|星期)/.exec(text);
  if (lt) { const wk = /周|星期/.test(lt[3]); const lo = Number(lt[1]) * (wk ? 7 : 1); const hi = Number(lt[2] ?? lt[1]) * (wk ? 7 : 1); out.push(mk(text, lang, 'quote.leadTime', { min: String(lo), max: String(hi), unit: 'days' }, lt.index, lt.index + lt[0].length, { flags: wk ? ['WEEKS_CONVERTED'] : [], reason: '交期' })); }
  // ---- model identifier (as written) ----
  const mm = /(?:型号|型號)\s*(?:是|为|:|：)?\s*([A-Za-z0-9][A-Za-z0-9\-_/.]*[A-Za-z0-9]|[A-Za-z0-9])(?:\s([A-Z]\d+[A-Za-z]?)\b)?/.exec(text);
  if (mm) { let val = mm[2] && /^[A-Za-z]{1,4}$/.test(mm[1]) ? `${mm[1]} ${mm[2]}` : mm[1]; val = val.replace(/[.\-_/]+$/, ''); if (/\d/.test(val) && val.length >= 3 && !/^\d{1,3}$/.test(val)) { const s0 = mm.index + mm[0].indexOf(val); out.push(mk(text, lang, 'identifier.model', val, s0, s0 + val.length, { reason: '型号 (kept as written)' })); } }
  else { const bm = /(?:这款|这个|款|的)\s*型号\s*(?:是|为)?\s*([A-Za-z0-9][A-Za-z0-9\-_/.]*[A-Za-z0-9])/.exec(text); void bm; const lm = /型号是\s*([A-Za-z0-9][A-Za-z0-9\-_/.]*[A-Za-z0-9])/.exec(text); void lm; }
  const m2 = /型号(?:是|为)?\s*([A-Za-z][A-Za-z0-9\-_/.]*\d[A-Za-z0-9\-_/.]*)/.exec(text); if (m2 && !out.some((c) => c.key === 'identifier.model')) out.push(mk(text, lang, 'identifier.model', m2[1], m2.index + m2[0].indexOf(m2[1]), m2.index + m2[0].indexOf(m2[1]) + m2[1].length, { reason: '型号 (kept as written)' }));
  // 这款型号是 XJ-9000B 的充电宝: the label word, then the identifier
  if (!out.some((c) => c.key === 'identifier.model')) { const m3 = /型号(?:是|为)\s*([A-Za-z0-9][A-Za-z0-9\-_/.]*[A-Za-z0-9])/.exec(text); if (m3) { const s0 = m3.index + m3[0].indexOf(m3[1]); out.push(mk(text, lang, 'identifier.model', m3[1], s0, s0 + m3[1].length, { reason: '型号 (kept as written)' })); } }
  // ---- colours ----
  const col = /颜色(?:有|是|:|：)?\s*((?:[黑白蓝红绿粉紫黄橙灰银金棕]色?(?:\s*[、,，和及与]\s*)?)+)/.exec(text);
  if (col) { const names = [...col[1]].filter((ch) => ZH_COLOURS[ch]).map((ch) => ZH_COLOURS[ch]); const s0 = col.index + col[0].indexOf(col[1]); if (names.length) out.push(mk(text, lang, 'variant.colours', [...new Set(names)], s0, s0 + col[1].length, { reason: '颜色' })); }
  for (const seg of segs) { const neg = /不能混色|不可以混色|不能混|不可混色|颜色不能混/.exec(seg.text); const pos = neg ? null : /可以混色|能混色|颜色可以混|可混色|混色可以/.exec(seg.text); const m = neg ?? pos; if (m) out.push(mk(text, lang, 'moq.mixedColours', !neg, seg.start + m.index, seg.start + m.index + m[0].length, { reason: neg ? '不能混色' : '可以混色' })); }
  // ---- carton ----
  const cq = new RegExp(`每箱\\s*(\\d[\\d,]*)\\s*${UNIT}`).exec(text); if (cq) { const n = parseNumberToken(cq[1], 'quantity'); out.push(mk(text, lang, 'carton.qty', n.value, cq.index, cq.index + cq[0].length, { needsCorrection: n.ambiguous, flags: n.flags, reason: '每箱' })); }
  const gw = /毛重\s*[:：]?\s*(\d+(?:\.\d+)?)\s*(kg|KG|公斤|千克|g|克)/.exec(text); if (gw) out.push(mk(text, lang, 'carton.grossWeight', { amount: gw[1], unit: /kg|KG|公斤|千克/.test(gw[2]) ? 'kg' : 'g' }, gw.index, gw.index + gw[0].length, { reason: '毛重' }));
  const nw = /净重\s*[:：]?\s*(\d+(?:\.\d+)?)\s*(kg|KG|公斤|千克|g|克)/.exec(text); if (nw) out.push(mk(text, lang, 'carton.netWeight', { amount: nw[1], unit: /kg|KG|公斤|千克/.test(nw[2]) ? 'kg' : 'g' }, nw.index, nw.index + nw[0].length, { reason: '净重' }));
  const dim = /(\d+(?:\.\d+)?)\s*[x×*]\s*(\d+(?:\.\d+)?)\s*[x×*]\s*(\d+(?:\.\d+)?)\s*(cm|mm|m|厘米)/i.exec(text);
  if (dim) { const carton = /箱规|外箱|纸箱|箱/.test(within(segs, dim.index).text); out.push(mk(text, lang, carton ? 'carton.dimensions' : 'product.dimensions', { l: dim[1], w: dim[2], h: dim[3], unit: dim[4] === '厘米' ? 'cm' : dim[4].toLowerCase() }, dim.index, dim.index + dim[0].length, { reason: '尺寸' })); }
  return out;
}
