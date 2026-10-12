// CONTEXT of the two passes. PASS A = ZERO CONTEXT (nothing is sent but the audio and the language). PASS B = NORDLA CONTEXT: the terms Nordla would know before or during the conversation, handed to each provider
// ONLY through that provider's DOCUMENTED mechanism (hotwords / keyterms / additional_vocab + sounds_like / context terms / prompt). Nothing is corrected afterwards: the benchmark measures the ASR's own improvement.
// The exact payload actually sent is written into every result (`contextApplied`). The 30 synthetic identifiers are NOT here: they would only enter a pass that explicitly allows it (PASS C, off by default).
import { KEY_REFERENCES } from './corpus.mjs';

export const TRADE_TERMS = Object.freeze(['MOQ', 'FOB', 'EXW', 'CIF', 'CE', 'RoHS', 'REACH', 'UN38.3', 'USB-C', 'PD']);
const SPOKEN_ACRONYM = { MOQ: ['M O Q', 'em oh queue'], FOB: ['F O B', 'eff oh bee'], EXW: ['E X W', 'ex works'], CIF: ['C I F'], CE: ['C E', 'see ee'], RoHS: ['rose', 'R O H S'], REACH: ['reach'], 'UN38.3': ['U N thirty eight point three', 'U N thirty eight three'], 'USB-C': ['U S B C', 'USB type C'], PD: ['P D', 'power delivery'] };

const UNITS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine'];
const TEENS = ['ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen']; const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];
const pairWords = (s) => { const n = Number(s); if (n < 10) return `${UNITS[0]} ${UNITS[n]}`.replace(/^zero zero$/, 'zero zero'); if (n < 20) return TEENS[n - 10]; return `${TENS[Math.floor(n / 10)]}${n % 10 ? ` ${UNITS[n % 10]}` : ''}`; };
/** Generic spoken variants of an identifier (letters spelled, digits one by one or by pairs): rules, not a dictionary, and not copied from the script. */
export function spokenVariants(id) {
  const groups = String(id).replace(/[^A-Za-z0-9]/g, ' ').trim() ? (String(id).match(/[A-Za-z]+|\d+/g) ?? []) : []; const forms = [[]];
  const fork = (parts) => { const out = []; for (const base of forms) for (const p of parts) out.push([...base, p]); forms.length = 0; forms.push(...out); };
  for (const g of groups) {
    if (/^[A-Za-z]+$/.test(g)) fork([g.toUpperCase().split('').join(' ')]);
    else { const digits = g.split('').map((d) => UNITS[Number(d)]).join(' '); const opts = [digits]; if (g.length === 3) opts.push(`${UNITS[Number(g[0])]} ${pairWords(g.slice(1))}`); if (g.length === 3 && g[0] === '0') opts.push(`zero ${pairWords(g.slice(1))}`); if (g.length === 4) opts.push(`${pairWords(g.slice(0, 2))} ${pairWords(g.slice(2))}`); if (g.length === 2) opts.push(pairWords(g)); fork([...new Set(opts)]); }
  }
  return [...new Set(forms.map((f) => f.join(' ').replace(/\s+/g, ' ')))].slice(0, 4);
}

/** @param {{ brand?: string, supplier?: string, productName?: string, extraTerms?: string[] }} owner optional facts Nordla would already know (from a local file of the benchmark session) */
export function nordlaTerms(owner = {}) {
  const identifiers = [...KEY_REFERENCES]; const names = [owner.brand, owner.supplier, owner.productName].filter(Boolean).map(String); const extra = (owner.extraTerms ?? []).map(String);
  return { identifiers, trade: [...TRADE_TERMS], names, extra, all: [...new Set([...identifiers, ...TRADE_TERMS, ...names, ...extra])] };
}
const DOMAIN = 'B2B sourcing conversation with a supplier in China: product models, MOQ, price, Incoterms, certificates.';

/** Per-provider context builders. Each returns { mechanism, payload, checks } where payload is EXACTLY what is sent (and recorded). */
export const CONTEXT_BUILDERS = {
  soniox(t) { const terms = t.all; return { mechanism: 'context.terms + context.general (Soniox real-time config)', payload: { context: { general: [{ key: 'domain', value: 'B2B sourcing from China' }, { key: 'topic', value: 'product references, MOQ, price, Incoterms, certificates' }], text: DOMAIN, terms } }, checks: { maxTokens: 8000, approxTokens: Math.ceil((terms.join(' ').length + DOMAIN.length) / 3.5), ok: terms.join(' ').length + DOMAIN.length < 8000 * 3 } }; },
  assemblyai(t) { const terms = t.all.filter((x) => x.length <= 50).slice(0, 100); return { mechanism: 'keyterms_prompt + prompt (Universal-3.6 Pro streaming query parameters)', payload: { keyterms_prompt: terms, prompt: DOMAIN }, checks: { maxTerms: 100, maxChars: 50, terms: terms.length, ok: terms.length <= 100 && terms.every((x) => x.length <= 50) && DOMAIN.length <= 1750 } }; },
  speechmatics(t) { const vocab = [...t.identifiers.map((id) => ({ content: id, sounds_like: spokenVariants(id) })), ...t.trade.map((w) => ({ content: w, ...(SPOKEN_ACRONYM[w] ? { sounds_like: SPOKEN_ACRONYM[w] } : {}) })), ...t.names.map((w) => ({ content: w })), ...t.extra.map((w) => ({ content: w }))]; return { mechanism: 'transcription_config.additional_vocab with sounds_like (Speechmatics real-time StartRecognition)', payload: { additional_vocab: vocab }, checks: { recommendedMax: 1000, items: vocab.length, ok: vocab.length <= 1000 && vocab.every((v) => v.content.split(/\s+/).length <= 6) } }; },
  alibaba(t) { const vocabulary = t.all.map((text) => ({ text, weight: 4, lang: 'en' })); return { mechanism: 'custom vocabulary (hotwords) created via the vocabulary API, then vocabulary_id in the recognition request (Fun-ASR)', payload: { vocabulary }, checks: { weightRange: [1, 5], maxAsciiWords: 7, ok: vocabulary.every((v) => v.text.split(/\s+/).length <= 7 && v.weight >= 1 && v.weight <= 5) } }; },
  qwen3(t) { const prompt = `Vocabulary and exact spellings: ${t.all.join(', ')}.`; return { mechanism: 'free-text context in the system prompt (--prompt of qwen-asr)', payload: { prompt }, checks: { ok: prompt.length < 4000 } }; },
  fake(t) { return { mechanism: 'test double: records the terms', payload: { terms: t.all }, checks: { ok: true } }; },
};
export const NO_CONTEXT = Object.freeze({ mechanism: 'none (PASS A: zero context)', payload: {}, checks: { ok: true } });
export function buildContext(providerId, pass, owner = {}) { if (pass === 'A') return NO_CONTEXT; if (pass !== 'B') throw new Error(`unknown pass: ${pass} (A = zero context, B = Nordla context)`); const f = CONTEXT_BUILDERS[providerId]; if (!f) throw new Error(`no documented context mechanism registered for ${providerId}`); const c = f(nordlaTerms(owner)); if (!c.checks.ok) throw new Error(`context for ${providerId} exceeds the documented limits: ${JSON.stringify(c.checks)}`); return c; }
