// THE FINAL REVIEW (AD route, owner's night mission 2026-11-15): after the render, the restoration of the authentic product and the montage of the title and of the official logo, Creator looks at its OWN finished advertisement
// next to the source photograph and the phone-size preview, and answers five questions about what is VISIBLE: is the product faithful, does the decor help, does the headline agree with the image, does it read on a phone, and what in the
// picture gives the customer a concrete reason to buy. It is the point where Creator judges its own image. It is ONE vision call (no repair), an OPINION that never destroys an image already paid for: an answer that cannot be used
// is recorded as NOT_MEASURABLE and the advertisement goes to the owner flagged "not reviewed". The deterministic measures (pixel fidelity, text and logo checks) always weigh more than the model's opinion (finalVerdictOf).
import { createHash } from 'node:crypto';
import { obj, text, word, renderContract, validateSpec } from '../creative-brain/contract.js';
import { parseAnswer } from '../creative-brain/model-port.js';
import { JUDGMENT_EXAMPLES } from './concept-route.js';

export const REVIEW_VERSION = 'ad-final-review@1';
export const FIDELITY = Object.freeze({ OK: 'OK', ALTERED: 'ALTERED' });
export const DECOR = Object.freeze({ FITS: 'FITS', GENERIC: 'GENERIC' });
export const HEADLINE_IMAGE = Object.freeze({ AGREES: 'AGREES', CONTRADICTS: 'CONTRADICTS' });
export const LEGIBILITY = Object.freeze({ LEGIBLE: 'LEGIBLE', POOR: 'POOR' });
export const YES_NO = Object.freeze({ YES: 'YES', NO: 'NO' });
export const REVIEW_VERDICT = Object.freeze({ PUBLISHABLE: 'PUBLISHABLE', REVISE: 'REVISE', REJECT: 'REJECT', NOT_REVIEWED: 'NOT_REVIEWED' });
const MODEL_VERDICTS = Object.freeze({ PUBLISHABLE: 'PUBLISHABLE', REVISE: 'REVISE', REJECT: 'REJECT' });
const item = (vocab) => obj({ verdict: word(vocab), evidence: text({ max: 260 }) });

export const finalReviewSpec = () => obj({
  product_fidelity: item(FIDELITY), decor: item(DECOR), headline_image: item(HEADLINE_IMAGE), phone_legibility: item(LEGIBILITY),
  reason_to_buy: obj({ concrete: word(YES_NO), seen_in_the_picture: text({ max: 260 }), what_it_gives_the_customer: text({ max: 220 }) }),
  verdict: word(MODEL_VERDICTS), why: text({ max: 300 }),
});

const NO_ELEMENT = /^\s*(aucun|aucune|none|n\/a|nothing|rien)\b/i;
/** Structural consistency of the model's OWN answers (nothing lexical about art): a verdict of PUBLISHABLE cannot stand on a failed item or on a reason that points at nothing visible. */
export function reviewViolations(v) {
  const out = [];
  const failed = [];
  if (v.product_fidelity?.verdict !== FIDELITY.OK) failed.push('product_fidelity');
  if (v.decor?.verdict !== DECOR.FITS) failed.push('decor');
  if (v.headline_image?.verdict !== HEADLINE_IMAGE.AGREES) failed.push('headline_image');
  if (v.phone_legibility?.verdict !== LEGIBILITY.LEGIBLE) failed.push('phone_legibility');
  if (v.reason_to_buy?.concrete !== YES_NO.YES) failed.push('reason_to_buy');
  if (v.verdict === MODEL_VERDICTS.PUBLISHABLE && failed.length) out.push({ field: 'verdict', rule: 'PUBLISHABLE_WITH_A_FAILED_ITEM', message: `PUBLISHABLE cannot stand with ${failed.join(', ')} not satisfied` });
  if (v.reason_to_buy?.concrete === YES_NO.YES && NO_ELEMENT.test(v.reason_to_buy.seen_in_the_picture ?? '')) out.push({ field: 'reason_to_buy.seen_in_the_picture', rule: 'REASON_WITHOUT_A_VISIBLE_ELEMENT', message: 'a concrete reason to buy must name what is seen in the picture' });
  return out;
}

export function buildFinalReviewInstruction({ brief = {}, headline = '', proposal = null, product = null, measured = null } = {}) {
  const system = [
    'You are the Nordla art director and you review your OWN finished advertisement before the owner sees it. The image is ONE sheet with three panels: SOURCE PHOTO (the real photograph of the product, the reference), FINAL AD (the advertisement as it would be published, with its title and the official logo) and PHONE PREVIEW (the same advertisement at phone width). Judge ONLY what you can see on the sheet. Write in French (fr-BE).',
    'product_fidelity: compare the product in FINAL AD with the product in SOURCE PHOTO: same proportions, same colour, same printed marks and inscriptions, same ports and cable. OK only if you see no difference; ALTERED if anything differs (say what).',
    'decor: does the place, the objects and the light help a customer understand why one carries THIS product (FITS), or could the same decor present any other object (GENERIC)?',
    'headline_image: read the headline given in user.headline. AGREES when nothing in it is contradicted by the image; CONTRADICTS when it names a colour, an object, a place or a claim that the image does not show or contradicts (a headline that names a colour the product does not have contradicts the image).',
    'phone_legibility: in PHONE PREVIEW, are the title and the logo readable and clear of the product, without effort? LEGIBLE or POOR.',
    'reason_to_buy: concrete YES only if a customer who sees the image alone (then the headline) understands a need and what this product gives in that moment; seen_in_the_picture names the visible element(s) that carry it (write AUCUN when there is none); what_it_gives_the_customer says what the person gains, in one sentence. A calm, pretty or local picture is NOT a reason by itself, and neither is a characteristic that is merely visible.',
    'verdict: PUBLISHABLE only when every item above is satisfied; REVISE when the advertisement can be corrected without a new idea (say what in why); REJECT when the idea itself gives no reason to buy. Evidence is one sentence about what is visible. No score, no number.',
    'Reference judgments by the owner, for ANY product (do not reproduce their places or objects): ' + JUDGMENT_EXAMPLES.slice(0, 2).join(' '),
    'Return ONLY one JSON object, described exactly by these lines (Nordla refuses an answer that does not follow them):', ...renderContract(finalReviewSpec(), 'answer'),
    'Be concise: respect the lengths, an answer that is cut off is refused.',
  ].join('\n');
  const user = JSON.stringify({ brief: { objective: brief.objective ?? null, audience: brief.audience ?? null }, headline, product, retained_proposal: proposal, measured_by_nordla: measured });
  return { system, user };
}

/** The review of the model does not decide alone: a measured defect always lowers the verdict (never raises it), and a review that could not be made is NOT_REVIEWED. */
export function finalVerdictOf({ review, measured = null }) {
  const reasons = [];
  const defects = [...(measured?.defects ?? [])];
  if ((measured?.fidelity_max_levels ?? 0) > 2) defects.push('PRODUCT_PIXELS_DIFFER_FROM_THE_PHOTO');
  if (defects.length) reasons.push(`measured defects: ${defects.join(', ')}`);
  if (!review) return { verdict: REVIEW_VERDICT.NOT_REVIEWED, publishable: false, reasons: ['the final review could not be made: the owner must look at the image', ...reasons] };
  let verdict = review.verdict;
  if (defects.length && verdict === REVIEW_VERDICT.PUBLISHABLE) verdict = REVIEW_VERDICT.REVISE;
  return { verdict, publishable: verdict === REVIEW_VERDICT.PUBLISHABLE, reasons: [review.why, ...reasons].filter(Boolean) };
}

/**
 * @param {object} o vlm: { invoke({ system, user, images }) -> { text, model, request_id, cost_eur } } (ONE call, the port allows one); sheetBytes: the PNG sheet; ref: its candidate ref.
 * @returns {{ review: object|null, provenance: object }} review null = NOT_MEASURABLE (port failure or an answer that does not follow the contract); never throws for those.
 */
export async function runFinalReview({ vlm, sheetBytes, ref, brief, headline, proposal, product, measured }) {
  if (typeof vlm?.invoke !== 'function') throw new TypeError('a vision-language port is required');
  const sha = createHash('sha256').update(sheetBytes ?? new Uint8Array()).digest('hex');
  if (!sheetBytes || sheetBytes.length < 8) return { review: null, provenance: { called: false, reason: 'NO_VISUAL_EVIDENCE', sheet_sha256: sha, version: REVIEW_VERSION } };
  let reply;
  try { reply = await vlm.invoke({ ...buildFinalReviewInstruction({ brief, headline, proposal, product, measured }), images: [{ label: 'sheet', media_type: 'image/png', bytes: sheetBytes }] }); } catch (error) {
    return { review: null, provenance: { called: true, failure: { code: error?.code ?? null, status: error?.status ?? null, message: String(error?.message ?? '').slice(0, 200) }, sheet_sha256: sha, version: REVIEW_VERSION } };
  }
  const provenance = { called: true, model: reply.model ?? null, request_id: reply.request_id ?? null, cost_eur: reply.cost_eur ?? null, sheet_sha256: sha, version: REVIEW_VERSION, ref };
  try {
    const value = validateSpec(finalReviewSpec(), parseAnswer(reply.text, 'final_review'), 'final_review');
    const violations = reviewViolations(value);
    if (violations.length) return { review: null, provenance: { ...provenance, rejected: { rules: violations.map((x) => `${x.field} ${x.rule}`), answer: value } } };
    return { review: value, provenance };
  } catch (error) {
    if (!error?.code) throw error;
    return { review: null, provenance: { ...provenance, rejected: { code: error.code, field: error.field ?? null } } };
  }
}
