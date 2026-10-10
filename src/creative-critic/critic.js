import { createHash } from 'node:crypto';

import { DIMENSIONS, DIMENSION_QUESTIONS, OUTCOME } from './dimensions.js';
import {
  CritiqueError, normalizeCritique, notMeasurableCritique,
} from './critique.js';

// The Creative Critic: it looks at the actual RENDERED candidate PNG and judges perceptual / creative dimensions, through a vision-language model behind a PORT. The model is
// an implementation detail of the port: nothing about a provider or a model enters this module or the critique it returns. The critic is BLIND by construction: its instruction is
// built only from the brief's public facts, the brand's own principles, the deterministic facts it must NOT re-judge, and the dimension questions; it never receives a human
// review, a defect list or an expected answer.

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

/** The instruction the model receives. Nothing in it is specific to a product, a campaign or a previous review. */
export function buildCriticInstruction({ brief, dimensions = DIMENSIONS }) {
  const system = [
    'You are the Nordla Creative Critic. You look at ONE rendered marketing image and judge it, dimension by dimension, as a demanding creative director for a premium retail brand would.',
    'You judge only what you can SEE in the image. You never judge facts that are checked elsewhere (the wording and truth of claims and prices, the identity and geometry of the product, fonts, collisions, bounds, brand rules): assume they are correct and verified.',
    'Return ONLY one JSON object: { "dimensions": [ { "dimension": "...", "outcome": "...", "evidence": "...", "revision_hint": "..." } ] } with exactly one entry per dimension listed below, in that order.',
    'outcome is one of PASS, FAIL, REVIEW_REQUIRED, NOT_MEASURABLE. PASS means the expectation is met. FAIL means it clearly is not. REVIEW_REQUIRED means it is arguable and a person should look. NOT_MEASURABLE means it cannot be judged from the image.',
    'evidence: one or two concrete sentences about what is visible in the image that justifies the outcome. A judgment without visible evidence is not accepted.',
    'revision_hint: only for FAIL or REVIEW_REQUIRED. One sentence about the INTENT of a change in plain words (for example "give the supporting text a calmer, clearly secondary treatment"). Never coordinates, sizes, pixel or percentage values, font names or sizes, or colour codes.',
    'Never give a score, a rating, a number out of ten, a rank or a winner. Never say whether the image is approved or may be published: you give an opinion, a person decides.',
  ].join(' ');
  const questions = dimensions.map((d) => `- ${d}: ${DIMENSION_QUESTIONS[d]}`).join('\n');
  const user = [
    'THE BRIEF (public facts):', JSON.stringify(brief.public_facts ?? {}),
    'THE BRAND\'S OWN PRINCIPLES (the standard to judge against):', JSON.stringify(brief.brand_principles ?? {}),
    'ALREADY VERIFIED BY DETERMINISTIC GATES (do not re-judge):', JSON.stringify(brief.verified_elsewhere ?? []),
    'THE DIMENSIONS (answer every one):', questions,
  ].join('\n');
  return { system, user };
}

function parseJsonObject(text) {
  const trimmed = String(text ?? '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  const start = trimmed.indexOf('{'); const end = trimmed.lastIndexOf('}');
  if (start < 0 || end < start) throw new CritiqueError('CRITIQUE_MALFORMED', 'the model returned no JSON object', 'answer');
  try { return JSON.parse(trimmed.slice(start, end + 1)); } catch { throw new CritiqueError('CRITIQUE_MALFORMED', 'the model returned invalid JSON', 'answer'); }
}

/**
 * @param {object} deps  vlm: { invoke({ system, user, images: [{ label, media_type, bytes }] }) -> { text, model?, request_id?, usage?, cost_eur? } }
 */
export function createCreativeCritic({ vlm } = {}) {
  if (typeof vlm?.invoke !== 'function') throw new TypeError('a vision-language port is required');
  return Object.freeze({
    /**
     * @param {object} input { candidate: { ref, png_bytes }, brief } -> { critique, provenance }
     * `critique` is the canonical, immutable Nordla object; `provenance` is adapter-level (model, request id, cost) and is NOT part of it.
     */
    async critique({ candidate, brief }) {
      const png = candidate?.png_bytes;
      const ref = candidate?.ref;
      if (typeof ref !== 'string' || !ref) throw new TypeError('candidate.ref is required');
      // no image, no judgment: nothing is invented and the model is not even called
      if (!png || png.length < 8) {
        return { critique: notMeasurableCritique({ candidate_ref: ref, candidate_sha256: sha256(png ?? new Uint8Array()) }, 'there is no rendered image to look at'), provenance: { called: false, reason: 'NO_VISUAL_EVIDENCE' } };
      }
      const context = { candidate_ref: ref, candidate_sha256: sha256(png) };
      const instruction = buildCriticInstruction({ brief });
      let reply;
      try {
        reply = await vlm.invoke({ ...instruction, images: [{ label: 'candidate', media_type: 'image/png', bytes: png }] });
      } catch (error) {
        const provenance = { called: true, failure: { code: error?.code ?? null, status: error?.status ?? null, request_id: error?.requestId ?? null } };
        return { critique: notMeasurableCritique(context, 'the vision model could not be reached'), provenance };
      }
      const provenance = { called: true, model: reply.model ?? null, request_id: reply.request_id ?? null, usage: reply.usage ?? null, cost_eur: reply.cost_eur ?? null };
      try {
        return { critique: normalizeCritique(parseJsonObject(reply.text), context), provenance };
      } catch (error) {
        if (!(error instanceof CritiqueError)) throw error;
        // a malformed or non-conforming answer is classified, never repaired and never a pass
        return { critique: notMeasurableCritique(context, 'the model answer did not conform to the critique contract'), provenance: { ...provenance, rejected: { code: error.code, field: error.field } } };
      }
    },
  });
}

export const countOutcomes = (critique) => Object.fromEntries(Object.values(OUTCOME).map((o) => [o, critique.dimensions.filter((d) => d.outcome === o).length]));
