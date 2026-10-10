import { createHash } from 'node:crypto';

import { DIMENSIONS, DIMENSION_QUESTIONS } from './dimensions.js';
import { CRITIQUE_ERROR, CritiqueError } from './critique.js';

// Pairwise review: which of two technically eligible candidates better satisfies the SAME brief, by the same named dimensions. There is no score and no opaque winner: each
// dimension carries a preference with evidence, and Nordla derives the overall answer from the counts. Both candidates must have passed the deterministic gates; otherwise there is
// nothing to compare (NOT_MEASURABLE), never a preference.

export const PREFERENCE = Object.freeze({
  PREFER_A: 'PREFER_A', PREFER_B: 'PREFER_B', NO_CLEAR_PREFERENCE: 'NO_CLEAR_PREFERENCE', NOT_MEASURABLE: 'NOT_MEASURABLE',
});
const DIM_PREFERENCE = Object.freeze(['A', 'B', 'NONE', 'NOT_MEASURABLE']);
const FORBIDDEN_KEYS = ['score', 'scores', 'rating', 'rank', 'ranking', 'beauty', 'points', 'weight', 'winner', 'best', 'confidence', 'model', 'provider', 'prompt', 'approved', 'publish'];
const SCORE_IN_TEXT = /\b\d+(\.\d+)?\s*(\/|out of)\s*(5|10|100)\b|\b(score|rating|rated)\b\s*[:=]?\s*\d/i;
const MIN_DECISIVE_MARGIN = 2;

const fail = (code, message, field) => { throw new CritiqueError(code, message, field); };

/** @param {object} raw { dimensions: [{ dimension, preference: 'A'|'B'|'NONE'|'NOT_MEASURABLE', evidence }] } */
export function normalizeComparison(raw, context) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw) || Object.keys(raw).length !== 1 || !Array.isArray(raw.dimensions)) fail(CRITIQUE_ERROR.MALFORMED, 'a comparison holds exactly one field: dimensions', 'comparison');
  const seen = new Map();
  raw.dimensions.forEach((d, i) => {
    const at = `dimensions[${i}]`;
    if (d === null || typeof d !== 'object' || Array.isArray(d)) fail(CRITIQUE_ERROR.MALFORMED, `${at} must be an object`, at);
    for (const [key, value] of Object.entries(d)) {
      if (FORBIDDEN_KEYS.includes(key.toLowerCase())) fail(CRITIQUE_ERROR.FORBIDDEN_KEY, `${at}.${key} is not allowed`, `${at}.${key}`);
      if (!['dimension', 'preference', 'evidence'].includes(key)) fail(CRITIQUE_ERROR.MALFORMED, `${at}.${key} is not part of a comparison`, `${at}.${key}`);
      if (typeof value !== 'string') fail(CRITIQUE_ERROR.NUMERIC_VALUE, `${at}.${key} must be text`, `${at}.${key}`);
    }
    if (!DIMENSIONS.includes(d.dimension)) fail(CRITIQUE_ERROR.UNKNOWN_DIMENSION, `${at}.dimension is not a known dimension`, `${at}.dimension`);
    if (seen.has(d.dimension)) fail(CRITIQUE_ERROR.DUPLICATE_DIMENSION, `${at}.dimension repeats a dimension`, `${at}.dimension`);
    if (!DIM_PREFERENCE.includes(d.preference)) fail(CRITIQUE_ERROR.UNKNOWN_OUTCOME, `${at}.preference must be A, B, NONE or NOT_MEASURABLE`, `${at}.preference`);
    const decisive = d.preference === 'A' || d.preference === 'B';
    if (decisive && (d.evidence ?? '').trim().length < 12) fail(CRITIQUE_ERROR.EVIDENCE_MISSING, `${at}.evidence: a preference needs visual evidence`, `${at}.evidence`);
    if (SCORE_IN_TEXT.test(d.evidence ?? '')) fail(CRITIQUE_ERROR.NUMERIC_SCORE_IN_TEXT, `${at}.evidence holds a numeric score`, `${at}.evidence`);
    seen.set(d.dimension, { dimension: d.dimension, preference: d.preference, evidence: (d.evidence ?? '').trim().replace(/\s+/g, ' ') || 'No evidence given.' });
  });
  const dimensions = DIMENSIONS.map((dimension) => seen.get(dimension) ?? { dimension, preference: 'NOT_MEASURABLE', evidence: 'The model gave no answer for this dimension.' });
  return Object.freeze({ ...context, dimensions: Object.freeze(dimensions.map((x) => Object.freeze(x))) });
}

/**
 * The overall answer, derived by Nordla from the per-dimension preferences:
 *   - either candidate not technically eligible, or more than half the dimensions not measurable -> NOT_MEASURABLE
 *   - otherwise the candidate preferred in at least MIN_DECISIVE_MARGIN more dimensions wins, unless the overall-shippability dimension prefers the other -> NO_CLEAR_PREFERENCE
 */
export function decidePairwise({ comparison, a_eligible: aEligible, b_eligible: bEligible }) {
  const counts = { A: 0, B: 0, NONE: 0, NOT_MEASURABLE: 0 };
  comparison.dimensions.forEach((d) => { counts[d.preference] += 1; });
  let status;
  let reason;
  if (!aEligible || !bEligible) { status = PREFERENCE.NOT_MEASURABLE; reason = 'A_CANDIDATE_IS_NOT_TECHNICALLY_ELIGIBLE'; }
  else if (counts.NOT_MEASURABLE * 2 > DIMENSIONS.length) { status = PREFERENCE.NOT_MEASURABLE; reason = 'MOST_DIMENSIONS_COULD_NOT_BE_COMPARED'; }
  else {
    const margin = counts.A - counts.B;
    const overall = comparison.dimensions.find((d) => d.dimension === 'OVERALL_SHIPPABILITY')?.preference;
    if (Math.abs(margin) < MIN_DECISIVE_MARGIN) { status = PREFERENCE.NO_CLEAR_PREFERENCE; reason = 'THE_DIMENSIONS_DO_NOT_SEPARATE_THE_CANDIDATES'; }
    else if ((margin > 0 && overall === 'B') || (margin < 0 && overall === 'A')) { status = PREFERENCE.NO_CLEAR_PREFERENCE; reason = 'THE_OVERALL_DIMENSION_CONTRADICTS_THE_COUNT'; }
    else { status = margin > 0 ? PREFERENCE.PREFER_A : PREFERENCE.PREFER_B; reason = 'MORE_DIMENSIONS_FAVOUR_ONE_CANDIDATE'; }
  }
  const body = { a_ref: comparison.a_ref, b_ref: comparison.b_ref, status, reason, counts };
  return Object.freeze({ comparison_id: `cpw_${createHash('sha256').update(JSON.stringify(body)).digest('hex').slice(0, 32)}`, ...body, dimensions: comparison.dimensions });
}

export function buildComparisonInstruction({ brief }) {
  const system = [
    'You are the Nordla Creative Critic comparing TWO rendered images, A and B, made for the SAME brief. Decide, dimension by dimension, which one better satisfies the brief.',
    'Return ONLY one JSON object: { "dimensions": [ { "dimension": "...", "preference": "A|B|NONE|NOT_MEASURABLE", "evidence": "..." } ] } with exactly one entry per dimension listed below.',
    'preference A or B needs one concrete sentence of visible evidence. NONE means no clear difference. Never give a score, a rating, a number out of ten or an overall winner score; never say anything is approved.',
    'You judge only what you can see; claims, prices, product identity, fonts and brand rules are verified elsewhere and assumed correct.',
  ].join(' ');
  const user = [
    'THE BRIEF (public facts):', JSON.stringify(brief.public_facts ?? {}),
    'THE BRAND\'S OWN PRINCIPLES:', JSON.stringify(brief.brand_principles ?? {}),
    'THE DIMENSIONS:', DIMENSIONS.map((d) => `- ${d}: ${DIMENSION_QUESTIONS[d]}`).join('\n'),
  ].join('\n');
  return { system, user };
}

function parseJsonObject(text) {
  const trimmed = String(text ?? '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  const start = trimmed.indexOf('{'); const end = trimmed.lastIndexOf('}');
  if (start < 0 || end < start) throw new CritiqueError(CRITIQUE_ERROR.MALFORMED, 'the model returned no JSON object', 'answer');
  try { return JSON.parse(trimmed.slice(start, end + 1)); } catch { throw new CritiqueError(CRITIQUE_ERROR.MALFORMED, 'the model returned invalid JSON', 'answer'); }
}

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

export function createPairwiseComparer({ vlm }) {
  if (typeof vlm?.invoke !== 'function') throw new TypeError('a vision-language port is required');
  return Object.freeze({
    /** @param {object} input { a: { ref, png_bytes, eligible }, b: { ref, png_bytes, eligible }, brief } */
    async compare({ a, b, brief }) {
      const context = { a_ref: a.ref, a_sha256: sha256(a.png_bytes ?? new Uint8Array()), b_ref: b.ref, b_sha256: sha256(b.png_bytes ?? new Uint8Array()) };
      const empty = (reason) => decidePairwise({ comparison: Object.freeze({ ...context, dimensions: DIMENSIONS.map((dimension) => ({ dimension, preference: 'NOT_MEASURABLE', evidence: reason })) }), a_eligible: false, b_eligible: false });
      // only technically eligible candidates are compared, and only with both images in hand
      if (!a.eligible || !b.eligible) return { comparison: empty('A candidate is not technically eligible.'), provenance: { called: false, reason: 'A_CANDIDATE_IS_NOT_TECHNICALLY_ELIGIBLE' } };
      if (!a.png_bytes?.length || !b.png_bytes?.length) return { comparison: empty('A rendered image is missing.'), provenance: { called: false, reason: 'NO_VISUAL_EVIDENCE' } };
      let reply;
      try {
        reply = await vlm.invoke({ ...buildComparisonInstruction({ brief }), images: [{ label: 'A', media_type: 'image/png', bytes: a.png_bytes }, { label: 'B', media_type: 'image/png', bytes: b.png_bytes }] });
      } catch (error) {
        return { comparison: empty('The vision model could not be reached.'), provenance: { called: true, failure: { code: error?.code ?? null, status: error?.status ?? null, request_id: error?.requestId ?? null } } };
      }
      const provenance = { called: true, model: reply.model ?? null, request_id: reply.request_id ?? null, cost_eur: reply.cost_eur ?? null };
      try {
        const comparison = normalizeComparison(parseJsonObject(reply.text), context);
        return { comparison: decidePairwise({ comparison, a_eligible: true, b_eligible: true }), provenance };
      } catch (error) {
        if (!(error instanceof CritiqueError)) throw error;
        return { comparison: empty('The model answer did not conform to the comparison contract.'), provenance: { ...provenance, rejected: { code: error.code, field: error.field } } };
      }
    },
  });
}
