// SCORING of one provider run against the canonical script. No winner is chosen by WER: the primary metrics are EXACT identifier accuracy (no partial credit), CRITICAL sourcing-fact accuracy (through Nordla's own
// extractor), context lift (PASS B - PASS A), natural-speech quality (WER on the owner's reference transcript + manual meaning-error review), hallucination in silence/noise, continuous stability and latency.
// The verdict is REJECT / PROMISING / STRONG CANDIDATE against GATES that were fixed BEFORE any run and must not be lowered to find a winner; if no engine is STRONG the result is NO WINNER.
import { extractFacts } from '../../src/sourcing/core/extract/index.js';
import { normalizeSpoken } from '../../src/sourcing/core/extract/spoken.js';
import { canon } from '../voice-bench/identifiers.mjs';
import { resolveIdentifier, asrCandidates } from './resolve.mjs';
import { KEY_REFERENCES } from './corpus.mjs';

export const GATES = Object.freeze({
  strong: { keyReferenceExactPassB: 0.95, criticalFactsPassB: 0.95, maxHallucinationEvents: 2, maxHallucinatedWords: 5, loops: 0, errors: 0, naturalWerMax: 0.20 },
  promising: { keyReferenceExactPassB: 0.70, criticalFactsPassB: 0.85, loops: 0, errors: 0 },
  note: 'Fixed before the first run. Do not lower them to select an engine; if nothing reaches STRONG CANDIDATE the answer is NO WINNER.',
});

// ---- text helpers -----------------------------------------------------------------------------------------------------------------------------------------------------------------
const joinWords = (words, mode) => (mode === 'concat' ? words.map((w) => w.text).join('') : words.map((w) => w.text).join(' ')).replace(/\s+([.,!?;:])/g, '$1').replace(/\s+/g, ' ').trim();
export const tokensOf = (s) => normalizeSpoken(String(s ?? '')).toLowerCase().replace(/[$]/g, ' dollars ').replace(/[^a-z0-9.%\s-]/g, ' ').replace(/(?<!\d)\.|\.(?!\d)/g, ' ').replace(/-/g, ' ').split(/\s+/).filter(Boolean);
export function wer(ref, hyp) { const r = tokensOf(ref); const h = tokensOf(hyp); const d = Array.from({ length: r.length + 1 }, (_, i) => [i, ...Array(h.length).fill(0)]); for (let j = 0; j <= h.length; j++) d[0][j] = j; for (let i = 1; i <= r.length; i++) for (let j = 1; j <= h.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (r[i - 1] === h[j - 1] ? 0 : 1)); return { errors: d[r.length][h.length], refWords: r.length, wer: r.length ? d[r.length][h.length] / r.length : null }; }
/** A loop = the same 2..6-word sequence repeated 4 or more times in a row. */
export function hasLoop(text) { const t = tokensOf(text); for (let n = 2; n <= 6; n++) for (let i = 0; i + n * 4 <= t.length; i++) { let ok = true; for (let k = 1; k < 4 && ok; k++) for (let j = 0; j < n; j++) if (t[i + j] !== t[i + k * n + j]) { ok = false; break; } if (ok) return true; } return false; }

// ---- windows ----------------------------------------------------------------------------------------------------------------------------------------------------------------------
/** markers: [{ itemId, startSec }] in order, endSec = the end of the recording. A window runs from an item's marker to the next marker. */
export function windowsOf(markers, endSec) { return markers.map((m, i) => ({ id: m.itemId, startSec: m.startSec, endSec: i + 1 < markers.length ? markers[i + 1].startSec : endSec })); }
/** Assigns what the provider said to each window by AUDIO time (a word by its middle; a segment without word timing by its middle). */
export function textByWindow(result, windows) {
  const mode = result.providerMeta?.joinMode ?? 'space'; const out = Object.fromEntries(windows.map((w) => [w.id, []]));
  const put = (mid, unit) => { const w = windows.find((x) => mid >= x.startSec && mid < x.endSec); if (w) out[w.id].push(unit); };
  for (const s of result.segments) { if (s.words?.length) for (const w of s.words) put((w.startSec + w.endSec) / 2, w); else put((s.startSec + s.endSec) / 2, { text: s.text, startSec: s.startSec, endSec: s.endSec, whole: true }); }
  return Object.fromEntries(Object.entries(out).map(([id, ws]) => [id, joinWords(ws, mode)]));
}

// ---- critical fact matchers (through Nordla's real extractor where it exists) -----------------------------------------------------------------------------------------------------
const num = (v) => String(v).replace(/,/g, '');
export function factHolds(text, f) {
  const n = normalizeSpoken(String(text ?? '')); const c = extractFacts({ text: n, lang: 'en' }).candidates; const by = (k) => c.filter((x) => x.key === k); const lower = n.toLowerCase();
  switch (f.type) {
    case 'moq': return by('quote.moq').some((x) => num(x.value) === f.value);
    case 'unitPrice': return by('quote.unitPrice').some((x) => num(x.value) === f.value) || by('quote.tiers').some((x) => (x.value ?? []).some((t) => num(t.unitPrice) === f.value));
    case 'currency': return by('quote.currency').some((x) => x.value === f.value);
    case 'incoterm': return by('quote.incoterm').some((x) => x.value === f.value);
    case 'port': return by('quote.port').some((x) => String(x.value).toLowerCase() === f.value.toLowerCase());
    case 'tier': return by('quote.tiers').some((x) => (x.value ?? []).some((t) => num(t.minQty) === f.value && num(t.unitPrice) === f.unitPrice)) || (by('quote.moq').some((x) => num(x.value) === f.value) && by('quote.unitPrice').some((x) => num(x.value) === f.unitPrice)) || new RegExp(`\\b${f.value}\\b[^.]*\\b${f.unitPrice}\\b`).test(lower);
    case 'leadTime': return by('quote.leadTime').some((x) => num(x.value?.max) === f.value);
    case 'deposit': return by('payment.depositPct').some((x) => num(x.value) === f.value);
    case 'balance': return by('payment.balancePct').some((x) => num(x.value) === f.value);
    case 'colourCount': return by('variant.colourCount').some((x) => num(x.value) === f.value);
    case 'cartonQty': return by('carton.qty').some((x) => num(x.value) === f.value) || new RegExp(`\\bcarton\\s+(?:quantity|qty)\\s+(?:is\\s+)?${f.value}\\b|\\b${f.value}\\s*(?:pcs?|pieces?)\\s*(?:per|in (?:a|one)|/)\\s*(?:master\\s+)?(?:carton|ctn)\\b`, 'i').test(lower); // the ASR is scored on what was heard, not on whether Nordla's extractor knows this phrasing
    case 'power': return new RegExp(`\\b${f.value}\\s*-?\\s*(w|watts?)\\b`, 'i').test(lower);
    case 'capacity': return new RegExp(`\\b${Number(f.value).toLocaleString('en-US').replace(/,/g, ',?')}\\s*(mah|milli-?amp)`, 'i').test(lower.replace(/,/g, '')) || new RegExp(`\\b${f.value}\\s*(mah|milli-?amp)`, 'i').test(lower.replace(/,/g, ''));
    case 'token': return f.value === 'USB-C' ? /\busb[-\s]?c\b|\btype[-\s]?c\b/i.test(lower) : f.value === 'PD' ? /\bpd\b|power delivery/i.test(lower) : lower.includes(f.value.toLowerCase());
    case 'claim': return c.some((x) => x.key === `docClaim.${f.value}` && x.value !== 'NOT_AVAILABLE');
    default: return false;
  }
}

// ---- scoring ------------------------------------------------------------------------------------------------------------------------------------------------------------------------
const median = (a) => { const s = a.filter((x) => Number.isFinite(x)).sort((p, q) => p - q); return s.length ? s[Math.floor(s.length / 2)] : null; };
const pct = (a, p) => { const s = a.filter((x) => Number.isFinite(x)).sort((x, y) => x - y); return s.length ? s[Math.min(s.length - 1, Math.floor(s.length * p))] : null; };
const ratio = (a, b) => (b ? a / b : null);

/**
 * @param {{ script: object, windows: {id,startSec,endSec}[], references: Record<string,string>, result: object, knownSets?: { key: string[], catalogue: string[] } }} a
 */
export function scoreRun({ script, windows, references = {}, result, knownSets = null }) {
  const texts = textByWindow(result, windows); const K1 = knownSets?.key ?? [...KEY_REFERENCES]; const K2 = knownSets?.catalogue ?? null; const items = [];
  for (const it of script.items) {
    const text = texts[it.id] ?? ''; const row = { id: it.id, kind: it.kind, section: it.section, heard: text };
    if (it.expect.identifier) {
      const exp = it.expect.identifier; const cands = asrCandidates(text); const rawCorrect = cands.some((c) => canon(c.canonical) === canon(exp));
      const r1 = resolveIdentifier(text, K1); const r2 = K2 ? resolveIdentifier(text, K2) : null; const topIs = (r, e) => !!r.top && canon(r.top.canonical) === canon(e); const wrongKnown = (r, known) => !!r.top && r.top.source !== 'ASR' ? !topIs(r, exp) : !!r.top && r.top.exactKnown && !topIs(r, exp) && known.map(canon).includes(canon(r.top.canonical));
      row.identifier = { expected: exp, rawCorrect, falseCandidates: cands.filter((c) => canon(c.canonical) !== canon(exp)).map((c) => c.canonical), candidates: cands.map((c) => c.canonical), isKey: K1.map(canon).includes(canon(exp)), resolvedKey: { correct: topIs(r1, exp), top: r1.top?.canonical ?? null, source: r1.top?.source ?? null, confidentWrong: wrongKnown(r1, K1) }, resolvedCatalogue: r2 ? { correct: topIs(r2, exp), top: r2.top?.canonical ?? null, source: r2.top?.source ?? null, confidentWrong: wrongKnown(r2, K2) } : null };
    }
    const facts = (it.expect.facts ?? []).filter((f) => f.type !== 'identifier'); if (facts.length) row.facts = facts.map((f) => ({ ...f, ok: factHolds(text, f) }));
    if (it.kind === 'natural') { const ref = references[it.id]; row.natural = ref ? { ...wer(ref, text), reference: ref } : { referenceMissing: true }; }
    if (it.expect.silent) { const w = tokensOf(text); row.silence = { words: w.length, text: w.length ? text : '' }; }
    items.push(row);
  }
  const idRows = items.filter((r) => r.identifier); const keyRows = idRows.filter((r) => r.identifier.isKey); const synRows = idRows.filter((r) => !r.identifier.isKey);
  const acc = (rows, f) => ({ n: rows.length, ok: rows.filter(f).length, rate: ratio(rows.filter(f).length, rows.length) });
  const factRows = items.flatMap((r) => (r.facts ?? []).map((f) => ({ item: r.id, ...f }))); const factTypes = {}; for (const f of factRows) { (factTypes[f.type] ??= { n: 0, ok: 0 }).n++; if (f.ok) factTypes[f.type].ok++; }
  const nat = items.filter((r) => r.natural && !r.natural.referenceMissing); const natErr = nat.reduce((a, r) => a + r.natural.errors, 0); const natRef = nat.reduce((a, r) => a + r.natural.refWords, 0);
  const sil = items.filter((r) => r.silence); const silWords = sil.reduce((a, r) => a + r.silence.words, 0); const silSec = windows.filter((w) => sil.some((r) => r.id === w.id)).reduce((a, w) => a + (w.endSec - w.startSec), 0);
  const segs = result.segments; const lags = segs.map((s) => s.lagMs).filter(Number.isFinite); const totalMin = result.audioSec / 60; const wordsPerSeg = segs.map((s) => tokensOf(s.text).length);
  const metrics = {
    identifiers: { keyReferences: acc(keyRows, (r) => r.identifier.rawCorrect), synthetic: acc(synRows, (r) => r.identifier.rawCorrect), all: acc(idRows, (r) => r.identifier.rawCorrect), falseCandidates: idRows.reduce((a, r) => a + r.identifier.falseCandidates.length, 0) },
    resolved: { keyReferences: acc(keyRows, (r) => r.identifier.resolvedKey.correct), syntheticWithKeyKnown: acc(synRows, (r) => r.identifier.resolvedKey.correct), confidentWrongKey: idRows.filter((r) => r.identifier.resolvedKey.confidentWrong).length, falseSnapOnUnknown: synRows.filter((r) => r.identifier.resolvedKey.source === 'KNOWN_NEAR' && !r.identifier.resolvedKey.correct).length, catalogue: K2 ? acc(idRows, (r) => r.identifier.resolvedCatalogue?.correct) : null, confidentWrongCatalogue: K2 ? idRows.filter((r) => r.identifier.resolvedCatalogue?.confidentWrong).length : null },
    criticalFacts: { overall: acc(factRows, (f) => f.ok), byType: Object.fromEntries(Object.entries(factTypes).map(([k, v]) => [k, { ...v, rate: ratio(v.ok, v.n) }])) },
    natural: { items: nat.length, referenceMissing: items.filter((r) => r.natural?.referenceMissing).length, wer: ratio(natErr, natRef), errors: natErr, refWords: natRef },
    hallucination: { windows: sil.length, seconds: Math.round(silSec * 10) / 10, words: silWords, events: sil.filter((r) => r.silence.words > 0).length, wordsPerMinute: silSec ? Math.round((silWords / (silSec / 60)) * 10) / 10 : null, samples: sil.filter((r) => r.silence.words).map((r) => ({ id: r.id, text: r.silence.text })) },
    stability: { loops: hasLoop(result.rawTranscript) ? 1 : 0, errors: result.errors.length, segments: segs.length, segmentsPerMinute: totalMin ? Math.round((segs.length / totalMin) * 10) / 10 : null, wordsPerSegmentMedian: median(wordsPerSeg), crashed: result.errors.length > 0 },
    latency: { lagMsMedian: median(lags), lagMsP90: pct(lags, 0.9), lagMsMax: lags.length ? Math.max(...lags) : null, note: 'measured, but latency is not the primary decision criterion' },
  };
  return { provider: result.provider, model: result.model, pass: result.pass, audioSha256: result.audioSha256, metrics, items };
}

/** PASS_B - PASS_A (positive = the Nordla context helped). WER and hallucination: negative = better. */
export function contextLift(A, B) {
  const d = (b, a) => (Number.isFinite(b) && Number.isFinite(a) ? Math.round((b - a) * 1000) / 1000 : null); const a = A.metrics; const b = B.metrics;
  return { keyReferenceExact: d(b.identifiers.keyReferences.rate, a.identifiers.keyReferences.rate), syntheticExactSpillover: d(b.identifiers.synthetic.rate, a.identifiers.synthetic.rate), criticalFacts: d(b.criticalFacts.overall.rate, a.criticalFacts.overall.rate), naturalWer: d(b.natural.wer, a.natural.wer), hallucinatedWords: d(b.hallucination.words, a.hallucination.words), resolvedKey: d(b.resolved.keyReferences.rate, a.resolved.keyReferences.rate) };
}

/** REJECT / PROMISING / STRONG CANDIDATE. "Never production ready": this only says whether an engine deserves to go further. */
export function verdict(B, A = null) {
  const m = B.metrics; const g = GATES; const reasons = []; const key = m.identifiers.keyReferences.rate ?? 0; const facts = m.criticalFacts.overall.rate ?? 0; const wer = m.natural.wer;
  const strong = { keyReferenceExact: key >= g.strong.keyReferenceExactPassB, criticalFacts: facts >= g.strong.criticalFactsPassB, hallucination: m.hallucination.events <= g.strong.maxHallucinationEvents && m.hallucination.words <= g.strong.maxHallucinatedWords, noLoops: m.stability.loops <= g.strong.loops, noErrors: m.stability.errors <= g.strong.errors, naturalSpeech: wer === null || wer <= g.strong.naturalWerMax };
  for (const [k, ok] of Object.entries(strong)) if (!ok) reasons.push(`not STRONG: ${k}`);
  const isStrong = Object.values(strong).every(Boolean); const isPromising = (key >= g.promising.keyReferenceExactPassB || facts >= g.promising.criticalFactsPassB) && m.stability.loops <= g.promising.loops && m.stability.errors <= g.promising.errors;
  void A; return { verdict: isStrong ? 'STRONG CANDIDATE' : isPromising ? 'PROMISING' : 'REJECT', gates: strong, reasons };
}
export const overall = (verdicts) => (verdicts.some((v) => v === 'STRONG CANDIDATE') ? 'AT LEAST ONE STRONG CANDIDATE' : 'NO WINNER');
