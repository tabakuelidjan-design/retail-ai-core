// Shared helpers of the deterministic fact extractor (isomorphic, pure). A candidate is a PROPOSAL pointing at an exact span of the original text.
export const EXTRACTOR_NAME = 'rules';
export const EXTRACTOR_VERSION = 'rules-1';

/** Incoterms the landed-cost engine supports (core/landed.js INCOTERMS). FAS is deliberately absent: it stays unparsed instead of being mapped to something else. */
export const INCOTERMS = ['EXW', 'FCA', 'FOB', 'CFR', 'CIF', 'CPT', 'CIP', 'DAP', 'DPU', 'DDP'];
export const PLACES = new Set(['Shenzhen', 'Ningbo', 'Shanghai', 'Guangzhou', 'Qingdao', 'Xiamen', 'Tianjin', 'Yantian', 'Shekou', 'Dalian', 'Hong Kong', 'Dongguan', 'Foshan', 'Zhongshan', 'Yiwu', 'Nansha', 'Huizhou']);
export const ZH_PLACES = { 深圳: 'Shenzhen', 宁波: 'Ningbo', 上海: 'Shanghai', 广州: 'Guangzhou', 青岛: 'Qingdao', 厦门: 'Xiamen', 天津: 'Tianjin', 盐田: 'Yantian', 蛇口: 'Shekou', 大连: 'Dalian', 香港: 'Hong Kong', 东莞: 'Dongguan', 佛山: 'Foshan', 中山: 'Zhongshan', 义乌: 'Yiwu', 南沙: 'Nansha', 惠州: 'Huizhou' };
export const COLOURS = { black: 'black', white: 'white', blue: 'blue', red: 'red', green: 'green', pink: 'pink', purple: 'purple', yellow: 'yellow', orange: 'orange', grey: 'grey', gray: 'grey', silver: 'silver', gold: 'gold', brown: 'brown', navy: 'navy', beige: 'beige', transparent: 'transparent' };
export const ZH_COLOURS = { 黑: 'black', 白: 'white', 蓝: 'blue', 红: 'red', 绿: 'green', 粉: 'pink', 紫: 'purple', 黄: 'yellow', 橙: 'orange', 灰: 'grey', 银: 'silver', 金: 'gold', 棕: 'brown' };

/** Document claims: the token found in the text -> the claim key. A claim is NEVER a received document. */
export const DOC_TOKENS = [
  { key: 'CE', rx: /(?<![A-Za-z0-9])CE(?![A-Za-z0-9])/g }, { key: 'UN383', rx: /UN\s?38\.?3/gi }, { key: 'ROHS', rx: /RoHS/gi }, { key: 'REACH', rx: /(?<![A-Za-z])REACH(?![A-Za-z])/g },
  { key: 'FCC', rx: /(?<![A-Za-z])FCC(?![A-Za-z])/g }, { key: 'SDS', rx: /(?<![A-Za-z])M?SDS(?![A-Za-z])/g }, { key: 'IEC62133', rx: /IEC\s?62133/gi }, { key: 'TEST_REPORT', rx: /test reports?/gi },
];

const BOUNDARY = /[,，;；。\n]|[.!?](?=\s|$)/g;
/** Comma-level segments (a claim, a negation or a context usually lives inside one). */
export function segments(text) {
  const out = []; let start = 0; const t = String(text);
  for (const m of t.matchAll(BOUNDARY)) { out.push({ start, end: m.index, text: t.slice(start, m.index) }); start = m.index + m[0].length; }
  out.push({ start, end: t.length, text: t.slice(start) }); return out.filter((s) => s.text.trim());
}
const SENT = /[;\n。；]|[.!?](?=\s|$)/g;
/** Sentence-level clauses. */
export function sentences(text) {
  const out = []; let start = 0; const t = String(text);
  for (const m of t.matchAll(SENT)) { out.push({ start, end: m.index, text: t.slice(start, m.index) }); start = m.index + m[0].length; }
  out.push({ start, end: t.length, text: t.slice(start) }); return out.filter((s) => s.text.trim());
}
export const within = (list, pos) => list.find((s) => pos >= s.start && pos <= s.end) ?? { start: 0, end: 0, text: '' };
export const boundaryBetween = (text, a, b) => { const piece = text.slice(a, b); return /[;\n。；]|[.!?]\s/.test(piece); };

/** Candidate factory: rawText is ALWAYS the exact slice of the original; the extractor never sets a decision state. */
export function mk(text, lang, key, value, start, end, extra = {}) {
  return { key, value, rawText: text.slice(start, end), span: [start, end], context: extra.context ?? 'product', lang, confidence: extra.confidence ?? 'HIGH', flags: extra.flags ?? [], needsCorrection: extra.needsCorrection ?? false, ...(extra.suggestion ? { suggestion: extra.suggestion } : {}), matchReason: extra.reason ?? key, extractor: { name: EXTRACTOR_NAME, version: EXTRACTOR_VERSION, method: 'RULE' } };
}

export function currencyOf(token) {
  const t = String(token);
  if (/^(?:USD|usd)$/.test(t)) return { code: 'USD', symbol: false }; if (/^US\$$/i.test(t) || /^dollars?$/i.test(t) || /^美元$|^美金$|^刀$/.test(t)) return { code: 'USD', symbol: false };
  if (t === '$') return { code: 'USD', symbol: true };
  if (/^(?:RMB|rmb|CNY|yuan)$/.test(t) || /^元$|^块钱?$|^人民币$/.test(t)) return { code: 'CNY', symbol: false };
  if (t === '¥' || t === '￥') return { code: 'CNY', symbol: true };
  if (/^(?:EUR|euros?)$/i.test(t) || t === '€' || t === '欧元') return { code: 'EUR', symbol: t === '€' ? false : false };
  return null;
}

/** The portion of the text not covered by any candidate span (kept so nothing the supplier said is lost). */
export function unparsedOf(text, candidates) {
  const mask = new Array(text.length).fill(false);
  for (const c of candidates) for (let i = c.span[0]; i < c.span[1]; i++) mask[i] = true;
  const kept = []; let cur = '';
  for (let i = 0; i < text.length; i++) { if (mask[i]) { if (cur.trim()) kept.push(cur); cur = ''; } else cur += text[i]; }
  if (cur.trim()) kept.push(cur);
  return kept.flatMap((k) => k.split(/[,，;；。\n]|[.!?](?=\s|$)/)).map((s) => s.trim()).filter((s) => s.length >= 2 && /[\p{L}\p{N}]/u.test(s));
}
