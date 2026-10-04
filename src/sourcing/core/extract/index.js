// FactExtractor: the ONLY door from supplier text to candidate facts. Pure and deterministic: same text, same result. It never decides, never applies anything to a case,
// never calls the network. Input: original text (+ language hint). Output: candidates (each pointing at an exact span of the original) and the text left unparsed.
import { extractEn } from './en.js';
import { extractZh } from './zh.js';
import { extractDocClaims } from './claims.js';
import { EXTRACTOR_NAME, EXTRACTOR_VERSION, unparsedOf } from './shared.js';

export { EXTRACTOR_NAME, EXTRACTOR_VERSION };
const CJK = /[㐀-鿿]/g;

export function detectLang(text) {
  const t = String(text ?? ''); const cjk = (t.match(CJK) ?? []).length; const letters = (t.match(/[A-Za-z]/g) ?? []).length;
  if (!cjk) return letters ? 'en' : 'unknown';
  return cjk / Math.max(1, cjk + letters) > 0.15 ? 'zh' : 'en';
}

/** @param {{ text: string, lang?: 'auto'|'en'|'zh', context?: object }} input */
export function extractFacts({ text, lang = 'auto' } = {}) {
  const t = String(text ?? ''); const l = lang === 'auto' ? detectLang(t) : lang;
  const hasCjk = (t.match(CJK) ?? []).length > 0;
  const raw = [...extractEn(t, l), ...(hasCjk ? extractZh(t, l) : []), ...extractDocClaims(t, l)];
  const seen = new Set(); const candidates = [];
  for (const c of raw) { const k = `${c.key}|${c.context}|${JSON.stringify(c.value)}`; if (seen.has(k)) continue; seen.add(k); candidates.push(c); }
  candidates.sort((a, b) => a.span[0] - b.span[0] || a.key.localeCompare(b.key));
  return { lang: l, candidates, unparsed: unparsedOf(t, candidates), extractor: { name: EXTRACTOR_NAME, version: EXTRACTOR_VERSION } };
}
