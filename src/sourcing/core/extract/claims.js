// Document CLAIMS ("we have CE", "RoHS可以提供", "we do not have FCC"): one implementation for both languages, with the English and Chinese cue words combined, so a negation or a
// promise is never missed because the text mixes languages. A claim is a statement by the supplier: it is never a received document and never evidence.
import { DOC_TOKENS, segments, within, mk } from './shared.js';

const NEG = [/\b(?:no|not|don'?t|do not|doesn'?t|without|haven'?t|have not|never|lack)\b[^.;\n]{0,25}$/i, /(?:没有|没|无|未|不是|没办法|不提供)[^，。;；]{0,6}$/];
const PROMISE = [/\b(?:will|can|could|going to|gonna|shall)\s+(?:\w+\s+){0,2}(?:send|provide|supply|offer|give|share|issue|email|forward|prepare|arrange)\b/i, /可以提供|能提供|可提供|可以发|可以给|会提供|发给你|发给您|可以做/];
const CLAIM = [/\b(?:have|has|got|passed|certified|certificate|comply|complies|available|we do)\b/i, /有|已通过|通过|认证|证书|符合|具备/];

export function extractDocClaims(text, lang) {
  const out = []; const seen = new Set(); const segs = segments(text);
  for (const d of DOC_TOKENS) {
    for (const m of text.matchAll(d.rx)) {
      if (seen.has(d.key)) break;
      const seg = within(segs, m.index); if (/[?？]\s*$/.test(seg.text.trim())) continue;
      const before = text.slice(seg.start, m.index); const neg = NEG.some((r) => r.test(before));
      const win = text.slice(seg.start, Math.min(seg.end, m.index + m[0].length + 30));
      const promised = !neg && PROMISE.some((r) => r.test(win)); const cue = CLAIM.some((r) => r.test(win));
      const value = neg ? 'NOT_AVAILABLE' : promised ? 'PROMISED' : 'CLAIMED';
      seen.add(d.key); out.push(mk(text, lang, `docClaim.${d.key}`, value, m.index, m.index + m[0].length, { confidence: neg || promised || cue ? 'HIGH' : 'LOW', flags: ['SUPPLIER_STATEMENT'], reason: 'document claim: a statement, not a received document' }));
    }
  }
  return out;
}
