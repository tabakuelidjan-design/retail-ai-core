// IDENTIFIER RESOLUTION (LAB PROTOTYPE of a concept, deterministic, no model, no dictionary of SKUs). A recogniser does not output "RB-980HB"; it outputs what it heard: "R B nine eight zero H B",
// "RB 980 HB", "are be nine eighty age be"... This module turns SPEECH CANDIDATES into IDENTIFIER CANDIDATES with their evidence, and never decides:
//   - it never silently corrects: a candidate comes with `needsConfirmation` (true unless an independent source already agrees);
//   - it can be fed other evidence later (a model typed by the owner, OCR of a visible label, a supplier document, market-search candidates): `known` identifiers only RAISE a candidate that is within ONE edit of
//     them and still ask for confirmation; they are never substituted;
//   - there is no list of products: the structure is generic (letters + digit groups + letters).
// Used by tools/voice-bench/compare-eval.mjs to measure how far the ASR output is from a usable identifier. If it proves useful it would be promoted to src/sourcing/core/identifiers.js.

const DIGIT = { zero: '0', oh: '0', o: '0', one: '1', won: '1', two: '2', to: '2', too: '2', three: '3', four: '4', for: '4', five: '5', six: '6', seven: '7', eight: '8', ate: '8', nine: '9' };
const TEEN = { ten: '10', eleven: '11', twelve: '12', thirteen: '13', fourteen: '14', fifteen: '15', sixteen: '16', seventeen: '17', eighteen: '18', nineteen: '19' };
const TENS = { twenty: '20', thirty: '30', forty: '40', fifty: '50', sixty: '60', seventy: '70', eighty: '80', ninety: '90' };
const LETTER_NAMES = { a: 'A', ay: 'A', b: 'B', be: 'B', bee: 'B', c: 'C', see: 'C', sea: 'C', d: 'D', dee: 'D', e: 'E', f: 'F', ef: 'F', g: 'G', gee: 'G', h: 'H', aitch: 'H', age: 'H', i: 'I', eye: 'I', j: 'J', jay: 'J', k: 'K', kay: 'K', l: 'L', el: 'L', m: 'M', em: 'M', n: 'N', en: 'N', p: 'P', pee: 'P', q: 'Q', cue: 'Q', r: 'R', are: 'R', s: 'S', ess: 'S', t: 'T', tee: 'T', u: 'U', you: 'U', v: 'V', vee: 'V', w: 'W', x: 'X', ex: 'X', y: 'Y', why: 'Y', z: 'Z', zed: 'Z', zee: 'Z' };
const STOP = new Set(['the','and','are','you','for','our','but','not','its','can','has','had','was','one','two','his','her','she','who','did','get','got','how','new','now','old','see','use','way','yes','is','it','we','of','to','in','on','at','as','an','or','so','if','my','me','he','be','by','do','go','no','up','us','am','this','that','with','have','from','they','will','your','what','when','model','reference','price','colors','colours']);
export const canon = (s) => String(s ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
export function editDistance(a, b) { const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]); for (let j = 0; j <= b.length; j++) d[0][j] = j; for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)); return d[a.length][b.length]; }

/** Tokens of the heard text -> a sequence of symbols: { t: 'L', v: 'R' } letters, { t: 'D', v: '980' } digit groups, with the words they came from. */
function symbols(text) {
  const toks = String(text).replace(/[,.;:!?]+/g, ' ').replace(/-/g, ' ').toLowerCase().split(/\s+/).filter(Boolean); const out = []; let i = 0;
  while (i < toks.length) {
    const w = toks[i]; const n = toks[i + 1];
    if (/^\d+$/.test(w)) { out.push({ t: 'D', v: w, from: [w] }); i++; continue; }
    if (TENS[w] && n && DIGIT[n] && n !== 'to' && n !== 'for' && n !== 'o' && n !== 'oh') { out.push({ t: 'D', v: String(Number(TENS[w]) + Number(DIGIT[n])), from: [w, n] }); i += 2; continue; }
    if (TENS[w]) { out.push({ t: 'D', v: TENS[w], from: [w] }); i++; continue; } if (TEEN[w]) { out.push({ t: 'D', v: TEEN[w], from: [w] }); i++; continue; }
    if (DIGIT[w] && !['to', 'too', 'for', 'o', 'won', 'ate'].includes(w)) { out.push({ t: 'D', v: DIGIT[w], from: [w] }); i++; continue; }
    if (/^[a-z]{2,3}$/.test(w) && !LETTER_NAMES[w] && !DIGIT[w] && !STOP.has(w)) { out.push({ t: 'L', v: w.toUpperCase(), from: [w], glued: true }); i++; continue; } // "rb", "zf", "hb": letters glued by the recogniser
    if (/^[a-z]\d+[a-z]*$|^\d+[a-z]+$|^[a-z]+\d+[a-z]*$/.test(w)) { out.push({ t: 'A', v: w.toUpperCase(), from: [w] }); i++; continue; } // already alphanumeric ("rb980hb", "8755c")
    if (LETTER_NAMES[w] && (w.length === 1 || ['bee', 'see', 'dee', 'gee', 'aitch', 'jay', 'kay', 'pee', 'cue', 'ess', 'tee', 'vee', 'zed', 'zee', 'ex', 'ef', 'em', 'el', 'en', 'eye', 'age', 'are', 'be', 'ay'].includes(w))) { out.push({ t: 'L', v: LETTER_NAMES[w], from: [w] }); i++; continue; }
    out.push({ t: 'W', v: w, from: [w] }); i++;
  }
  return out;
}

/**
 * @param {string} heard the ASR text @param {{ known?: string[] }} ctx identifiers already known from other evidence (owner, OCR, document, market search)
 * @returns {{ candidates: { id: string, canonical: string, display: string, evidence: string[], confidence: 'LOW'|'MEDIUM'|'HIGH', needsConfirmation: boolean }[] }}
 */
export function identifierCandidates(heard, ctx = {}) {
  const out = new Map(); const add = (canonical, display, evidence, confidence) => { const k = canon(canonical); if (k.length < 3 || !/\d/.test(k) || !/[A-Z0-9]/.test(k)) return; const prev = out.get(k); if (prev) { prev.evidence.push(...evidence); if (['LOW', 'MEDIUM', 'HIGH'].indexOf(confidence) > ['LOW', 'MEDIUM', 'HIGH'].indexOf(prev.confidence)) prev.confidence = confidence; } else out.set(k, { id: k, canonical: k, display, evidence, confidence, needsConfirmation: true }); };
  const text = String(heard ?? ''); // the RAW heard text: the extractor's number normaliser would read "nine eight zero" as 17, which is right for quantities and wrong for identifiers
  for (const m of text.matchAll(/\b([A-Za-z]{1,4}[-\s]?\d{2,5}[A-Za-z]{0,3}|\d{3,5}[-\s]?[A-Za-z]{1,3})\b/g)) if (!STOP.has((/^[A-Za-z]+/.exec(m[1])?.[0] ?? '').toLowerCase())) add(m[1], m[1].toUpperCase().replace(/\s+/g, '-'), [`written form in the transcript: "${m[1]}"`], 'HIGH');
  const sy = symbols(heard); // the spoken form: letters + digit groups + letters, in order, ONLY around a digit group
  for (let i = 0; i < sy.length; i++) {
    if (sy[i].t !== 'D' && sy[i].t !== 'A') continue; let j = i; while (j + 1 < sy.length && (sy[j + 1].t === 'D' || sy[j + 1].t === 'A')) j++;
    const lead = []; let l = i - 1; while (l >= 0 && sy[l].t === 'L' && lead.length < 4) { lead.unshift(sy[l]); l--; } const tail = []; let r = j + 1; while (r < sy.length && sy[r].t === 'L' && tail.length < 3) { tail.push(sy[r]); r++; }
    const mid = sy.slice(i, j + 1); const digits = mid.map((x) => x.v).join(''); const L = lead.map((x) => x.v).join(''); const T = tail.map((x) => x.v).join(''); const words = [...lead, ...mid, ...tail].flatMap((x) => x.from).join(' ');
    if (!L && !T && digits.length < 4) { i = j; continue; } // a lone small number is a quantity, not a reference
    add(`${L}${digits}${T}`, `${L}${L && digits ? '-' : ''}${digits}${T}`, [`spoken form: "${words}"`], (L || T) && digits.length >= 2 ? 'MEDIUM' : 'LOW');
    const alt = digits.replace(/^0+/, ''); if (alt !== digits && alt.length >= 2 && (L || T)) add(`${L}${alt}${T}`, `${L}-${alt}${T}`, [`spoken form without the leading zero: "${words}"`], 'LOW');
    i = j;
  }
  const known = (ctx.known ?? []).map(canon); const list = [...out.values()];
  for (const c of list) { const hit = known.find((k) => k === c.canonical); if (hit) { c.confidence = 'HIGH'; c.needsConfirmation = false; c.evidence.push('agrees with an identifier already known from another source'); } }
  for (const k of known) if (!out.has(k)) { const near = list.find((c) => editDistance(c.canonical, k) === 1); if (near) { near.evidence.push(`one edit from the known identifier ${k} (NOT substituted: ask)`); list.push({ id: k, canonical: k, display: k, evidence: [`known from another source, one edit from what was heard (${near.canonical})`], confidence: 'MEDIUM', needsConfirmation: true }); } }
  const dominated = (c) => list.some((d) => d !== c && d.canonical.length > c.canonical.length && d.canonical.includes(c.canonical)); // "RB980" is a fragment of "RB980HB": keep the one that covers more of what was heard
  for (let k = list.length - 1; k >= 0; k--) if (dominated(list[k])) list.splice(k, 1);
  return { candidates: list.sort((a, b) => ['LOW', 'MEDIUM', 'HIGH'].indexOf(b.confidence) - ['LOW', 'MEDIUM', 'HIGH'].indexOf(a.confidence) || a.canonical.length - b.canonical.length) };
}
