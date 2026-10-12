// IDENTIFIER RESOLUTION (LAB model of the future Nordla layer): ASR evidence + a controlled KNOWN-reference set -> identifier CANDIDATES.
//   - the ASR text is evidence and is NEVER rewritten (`asrEvidence` is frozen and returned as it came);
//   - a known reference can only be PROPOSED as a candidate (source KNOWN_NEAR, needsConfirmation: true), when it is the unique nearest known reference within `maxDistance` edits of what was heard;
//   - an ambiguous snap (two known references at the same distance) proposes nothing as the top candidate;
//   - the scorer measures RAW ASR accuracy and RESOLVED CANDIDATE accuracy separately, and counts confident-wrong proposals (a known reference proposed for a different expected one).
// Used only by the benchmark. The production counterpart would add photo/OCR, documents, supplier catalogue and market evidence as further sources.
import { identifierCandidates, editDistance, canon } from '../voice-bench/identifiers.mjs';

/** What the ASR text says, read as identifiers. The text is read whole AND clause by clause (a comma or full stop ends a clause), so "8755C, MOQ five hundred" is not glued into one token. Nothing is added from any known list. */
export function asrCandidates(text) {
  const seen = new Map(); for (const part of [String(text ?? ''), ...String(text ?? '').split(/[,;.!?]\s+|[,;.!?]$/)]) { if (!part.trim()) continue; for (const c of identifierCandidates(part).candidates) { const k = canon(c.canonical); if (!seen.has(k)) seen.set(k, c); } }
  return [...seen.values()];
}
export function resolveIdentifier(asrText, known = [], { maxDistance = 2 } = {}) {
  const asrEvidence = Object.freeze({ text: String(asrText ?? '') }); const knownCanon = [...new Set(known.map(canon))];
  const asr = asrCandidates(asrEvidence.text).map((c) => ({ ...c, source: 'ASR', exactKnown: knownCanon.includes(canon(c.canonical)) }));
  const cands = [...asr]; let ambiguous = false;
  for (const c of asr) {
    if (c.exactKnown) continue; const ranked = knownCanon.map((k) => ({ k, d: editDistance(canon(c.canonical), k) })).filter((x) => x.d <= maxDistance).sort((a, b) => a.d - b.d); if (!ranked.length) continue;
    if (ranked.length > 1 && ranked[1].d === ranked[0].d) { ambiguous = true; continue; }
    if (!cands.some((x) => x.source === 'KNOWN_NEAR' && canon(x.canonical) === ranked[0].k)) cands.push({ id: ranked[0].k, canonical: ranked[0].k, display: ranked[0].k, source: 'KNOWN_NEAR', distance: ranked[0].d, via: c.canonical, evidence: [`unique nearest known reference to what was heard ("${c.canonical}", ${ranked[0].d} edit${ranked[0].d > 1 ? 's' : ''}): a CANDIDATE to confirm, not a correction`], confidence: ranked[0].d === 1 ? 'MEDIUM' : 'LOW', needsConfirmation: true });
  }
  const rank = (c) => (c.source === 'ASR' && c.exactKnown ? 0 : c.source === 'KNOWN_NEAR' ? 1 + (c.distance ?? 9) / 10 : 3);
  const sorted = cands.sort((a, b) => rank(a) - rank(b)); const top = sorted[0] ?? null;
  return { asrEvidence, candidates: sorted, top, ambiguous, asrUnchanged: true };
}
