// "Qwen pleins pouvoirs" test, configuration B0 ONLY (owner decision 2026-11-07: concept B, B0 first; B1 and the retouch C are decided after the first comparison).
// PURE module: builds the exact request and the plan (prompt, images, parameters, cost, stable plan id). No network, no key, no file written. Nothing here spends anything.
//
// B0 = ONE image-edit call, n = 2 variants of the SAME request, ONE input image (the frame holding the authentic product on a neutral grey), prompt_extend OFF, fixed seed.
// The model sees the product here (the old ENVIRONMENT FIRST mode sent an empty frame). The authentic pixels are restored over the model's output afterwards (restore_pair.py);
// the raw output and the restored version are BOTH kept and shown side by side.
import { createHash } from 'node:crypto';
import { priceImagesEur } from '../marketing-creative/alibaba/budget.js';
import { IMAGE_EDIT_MODEL, IMAGE_EDIT_PROVIDER_ID, NEGATIVE_PROMPT_MAX_CHARS } from '../marketing-creative/alibaba/qwen-image-edit.js';

const sha = (v) => createHash('sha256').update(v).digest('hex');

export const B0 = Object.freeze({
  id: 'B0', concept: 'B', concept_name: 'Cent pour cent',
  model: IMAGE_EDIT_MODEL, provider: IMAGE_EDIT_PROVIDER_ID, region: 'eu-central-1', scope: 'GLOBAL',
  operation: 'IMAGE_EDIT', purpose: 'NORDLA_SCENE_PRODUCTION',
  n: 2, size: '1080*1350', seed: 424242, input_images: 1,
  parameters_sent: Object.freeze({ n: 2, size: '1080*1350', prompt_extend: false, watermark: false, seed: 424242, negative_prompt: '(see request)' }),
  parameters_not_sent: Object.freeze({ enable_thinking: 'not sent: the documented default is true but it REQUIRES prompt_extend=true, so with prompt_extend=false it has no effect (B1 tests it)', prompt_extend_mode: 'not sent (T2I only)' }),
  ceiling_eur: 0.10, // the application cap for this ONE attempt (the global per-run cap stays 0.60 EUR, the monthly cap 5 EUR)
});

/** The scene text. The order follows section 10 of PROPOSITION-QWEN-PLEINS-POUVOIRS.md: idea, useful geometry, materials, invariants, real prohibitions. One language (English), no empty words. */
export function buildB0Prompt({ canvas = [1080, 1350], baseTipY = 945 } = {}) {
  const [, H] = canvas; const pct = (y) => Math.round((y / H) * 100);
  const tip = pct(baseTipY); const edge = tip + 2; const face = tip + 10; const titleFrom = 80;
  return [
    // 1. THE IDEA
    'Premium advertising photograph, 4:5 portrait, for a Belgian gift and tech store.',
    'Idea: the product of image 1 is a 20,000 mAh power bank with a round black display reading 100%; behind it, one large perfectly circular disc of soft cool-white light on the wall repeats the circle of that display, as charge shown as a full circle.',
    // 2. THE USEFUL GEOMETRY
    'Keep the frame, the proportions, and the exact position and size of the product in image 1.',
    `The product stands on the top surface of a low, wide matte graphite stone block that spans the whole frame width; the straight front edge of the block is at about ${edge}% of the frame height, just in front of the lowest point of the product's base (about ${tip}%), and the plain front face of the block continues down to about ${face}%. The product's cable hangs over that edge, in front of the plain face.`,
    'Camera slightly above the block, medium framing, with the perspective already present in image 1 (the product seen from a three-quarter, slightly raised view).',
    'Light: one soft, wide key light from the left, the same direction and the same softness as the light already on the product, with a gentle falloff to the right. A soft contact shadow under the product and a soft shadow of the hanging cable on the front face of the block, both falling to the right.',
    `The disc of light sits behind the product, centred slightly above its middle, about 60% of the frame width in diameter, with a soft edge. Keep the lowest ${100 - titleFrom}% of the frame calm and uncluttered, a darker graphite floor, for a title added later.`,
    // 3. THE MATERIALS
    'Materials: a deep aubergine wall in matte plaster with no reflections, a matte graphite stone block, a darker matte graphite floor.',
    // 4. THE INVARIANTS
    'Image 1 is the only reference for the product. Keep the product exactly as in image 1: its shape and proportions, its pale blue colour, its angle of view, the printed marks "45W", "REMAX" and "20000mAh", the ring text "FAST CHARGING POWER BANK 20000mAh", the display showing "100%" with its green bolt, the two ports on top (USB-C and orange USB-A), the side socket, the woven loop cable at the top left and the hanging cable with its USB-C connector. Do not redraw, recolour, relight, move or retouch the product.',
    // 5. THE PROHIBITIONS THAT ARE REALLY NEEDED
    'Add no brand marks, inscriptions, letters, numbers or watermark beyond those already printed on the product. No second product, no hands, no people, no plants.',
  ].join(' ');
}

/** Words for the provider's negative_prompt (documented for the qwen-image-3.0 series; the stricter documented 500-character cut applies). "text" and "logo" alone would contradict keeping the printed marks (REMAX, 45W, 20000mAh...), so only ADDED marks and inscriptions are named. */
export const B0_NEGATIVE = 'second product, duplicate product, extra cable, extra port, hands, people, plants, added text, extra letters, extra inscriptions, added brand marks, watermark, distorted product, redrawn artwork, changed printed marks';

export function buildB0Request({ canvas, baseTipY } = {}) {
  const prompt = buildB0Prompt({ canvas, baseTipY });
  if (B0_NEGATIVE.length > NEGATIVE_PROMPT_MAX_CHARS) throw new RangeError('the negative prompt exceeds the documented cut');
  return Object.freeze({
    kind: 'PRODUCT_IN_SCENE', request_id: `b0-${sha(prompt).slice(0, 12)}`, capability: 'IMAGE_EDIT', text_policy: 'NO_CRITICAL_TEXT', // the adapter's envelope; the text is the owner-reviewed prompt below
    purpose: B0.purpose, size: B0.size, n: B0.n, seed: B0.seed,
    prompt, negative_prompt: B0_NEGATIVE,
  });
}

/**
 * The plan for authorisation. The plan id is CONTENT-ADDRESSED: it changes if, and only if, something that decides what is sent or what it may cost changes
 * (the exact prompt, the negative prompt, the parameters, the bytes of the frame, the bytes of the cut-out, the model, the region, the ceiling, and the three source files that build, run and send the request).
 */
export function buildB0Plan({ frameBytes, frameMeta, builderSha256, adapterSha256, runnerSha256 = null, usdToEur = 0.92 }) {
  if (!frameBytes?.length) throw new TypeError('frameBytes is required');
  const request = buildB0Request({ canvas: frameMeta?.canvas, baseTipY: frameMeta?.planned_body_lowest_point_y });
  const usd = priceImagesEur({ n: B0.n, size: B0.size.replace('*', 'x'), usdToEur: 1, inputImages: B0.input_images }); // the ledger counts USD = EUR: the cautious figure
  const money = {
    image_call_usd: Math.round(usd * 1e5) / 1e5, calls: 1, output_images: B0.n, input_images: B0.input_images, text_calls: 0, vision_calls: 0,
    breakdown: `${B0.n} x 0.03438 USD (1K tier: 1080*1350 = 1,458,000 px <= 2,250,000) + ${B0.input_images} x 0.00275 USD (input image)`,
    MAX_authorised_eur_ledger_basis: Math.round(usd * 1e4) / 1e4, // the SpendGuard reserves this BEFORE the call and refuses past it
    ESTIMATE_eur_at_0_92: Math.round(usd * usdToEur * 1e4) / 1e4,
    CEILING_application_eur: B0.ceiling_eur, CEILING_fits: usd <= B0.ceiling_eur, no_automatic_retry: true,
    note: 'The invoice is read in the Alibaba console after the attempt; the usage reported by Alibaba in the response is recorded. Nothing else is billed in B0: no text call, no vision call.',
  };
  const identity = {
    model: B0.model, provider: B0.provider, region: B0.region, scope: B0.scope, operation: B0.operation, purpose: B0.purpose,
    prompt_sha256: sha(request.prompt), negative_prompt_sha256: sha(request.negative_prompt),
    parameters: { n: B0.n, size: B0.size, seed: B0.seed, prompt_extend: false, watermark: false }, input_image_sha256: sha(frameBytes),
    product_cutout_sha256: frameMeta?.product_cutout_sha256 ?? null, ceiling_eur: B0.ceiling_eur, builder_sha256: builderSha256, adapter_sha256: adapterSha256, runner_sha256: runnerSha256,
  };
  const plan_id = `b0-${sha(JSON.stringify(identity)).slice(0, 16)}`;
  return Object.freeze({ plan_id, config: B0.id, concept: `${B0.concept} (${B0.concept_name})`, identity, request, money, frame: { bytes: frameBytes.length, sha256: sha(frameBytes), canvas: frameMeta?.canvas ?? null, placement: frameMeta?.placement ?? null, background_grey: frameMeta?.background_grey ?? null } });
}
