// Provider-independent bridge between the D composer and ANY image-generation provider. It defines what a provider is allowed to do for HABB and enforces the rest:
//
//   - a provider may produce ONE thing: a full-bleed background plate, exactly the canvas size. It never touches the product, a face, or a locked text;
//   - LOCKED PIXELS NEVER LEAVE THE MACHINE: the request carries a written intent and a size, never a product image, a customer photo or the locked copy. (A provider that needs a
//     reference image is refused unless the owner enabled `allow_reference_upload` for that provider: the default is no.)
//   - cost: estimated before, reserved against a hard ceiling BEFORE the call (the existing campaign budget), refused (no call) when it would pass; the real cost is recorded;
//   - the plate goes UNDER the locked layers; the composer then measures that the product pixels, the locked copy, the safe zones and the contrast are intact, and refuses a busy ground under text;
//   - every attempt is a version in an append-only log (parent, provider, parameters hash, intent hash, cost, spec hash, sha256, status); only a NAMED HUMAN reference moves a version to APPROVED / REJECTED;
//   - no provider is connected in this repository: `createNotConnectedProvider()` is the default and its generate() throws PROVIDER_NOT_CONNECTED. A real adapter (Qwen image, Nano Banana, others)
//     is a separate, owner-authorised change that implements the same four members; nothing here calls a network.

import { createHash } from 'node:crypto';
import { decodePng } from '../creative-intelligence/png-pixels.js';
import { createCampaignBudget, CampaignBudgetError } from '../creative-campaign/budget.js';
import { composeCreative } from './compose.js';

export const AI_ERROR = Object.freeze({
  PROVIDER_NOT_CONNECTED: 'PROVIDER_NOT_CONNECTED', BUDGET_EXCEEDED: 'AI_BUDGET_EXCEEDED', REFERENCE_UPLOAD_NOT_ALLOWED: 'AI_REFERENCE_UPLOAD_NOT_ALLOWED', INVALID_PLATE: 'AI_INVALID_PLATE',
  GATE_FAILED: 'AI_QUALITY_GATE_FAILED', MODE_NOT_ENABLED: 'AI_MODE_NOT_ENABLED', INVALID_DECISION: 'AI_INVALID_DECISION', UNAUTHORISED: 'AI_NOT_AUTHORISED',
});
/**
 * Operating modes. PLATE_ONLY is the secure initial mode and the ONLY enabled one: the model produces a background plate, nothing else. The others are named here so that the
 * architecture is explicit (docs/chantier-d/CREATIVE-AI-ARCHITECTURE.md section 9), and refused until the owner enables them mode by mode, with their own gates.
 */
export const AI_MODE = Object.freeze({
  PLATE_ONLY: Object.freeze({ enabled: true }),
  SCENE_AND_AMBIANCE: Object.freeze({ enabled: false }),
  ORIGINAL_COMPOSITION: Object.freeze({ enabled: false }),
  ART_DIRECTION_PROPOSALS: Object.freeze({ enabled: false }),
});

export class AiLayerError extends Error {
  constructor(code, message, detail = {}) { super(message); this.name = 'AiLayerError'; this.code = code; this.detail = detail; }
}
const fail = (code, message, detail) => { throw new AiLayerError(code, message, detail); };
const sha = (b) => createHash('sha256').update(b).digest('hex');
const round = (x) => Math.round(x * 1e9) / 1e9;
const canonical = (v) => (Array.isArray(v) ? `[${v.map(canonical).join(',')}]` : v && typeof v === 'object' ? `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}` : JSON.stringify(v ?? null));

/**
 * The provider port. `capabilities.operations` must include 'BACKGROUND_PLATE'. `estimate(request)` returns the worst-case cost in euros (a number, never a guess hidden in generate()).
 * `generate(request)` returns { png: Uint8Array, usage: { cost_eur, model } }. `needs_reference_image` is true for a provider that cannot work without a picture.
 */
export function createNotConnectedProvider() {
  return Object.freeze({
    id: 'NOT_CONNECTED', capabilities: Object.freeze({ operations: Object.freeze([]), needs_reference_image: false }),
    estimate: () => fail(AI_ERROR.PROVIDER_NOT_CONNECTED, 'no image provider is connected (none is chosen; connecting one needs the owner authorisation, a key and a budget)'),
    generate: () => fail(AI_ERROR.PROVIDER_NOT_CONNECTED, 'no image provider is connected'),
  });
}

/** A provider-neutral request. It contains no pixel of any locked layer and no locked text. */
export function buildPlateRequest({ spec, intent, constraints = [], seedLabel = 'a' }) {
  if (typeof intent !== 'string' || intent.trim().length < 8 || intent.length > 600) fail(AI_ERROR.INVALID_PLATE, 'the intent must be a written sentence (8 to 600 characters)', { field: 'intent' });
  return Object.freeze({
    operation: 'BACKGROUND_PLATE',
    size: Object.freeze({ width: spec.canvas.width, height: spec.canvas.height }),
    intent: intent.trim(),
    // standing constraints of the HABB visual rules, sent as words to the provider; they are also CHECKED afterwards by the composer (they are not trusted)
    constraints: Object.freeze([...new Set(['no text, no letters, no logo', 'no product, no phone, no person, no face', 'no decorative hearts, leaves or branches', 'no gold effect, no glow, no heavy shadow', 'flat natural light', ...constraints])]),
    keep_clear: Object.freeze(spec.layers.filter((l) => l.type === 'image' && l.role !== 'background').map((l) => ({ layer: l.id, box: l.box }))), // where the locked product will sit: geometry only, never pixels
    seed_label: seedLabel,
  });
}

/** Append-only version log. A decision needs a named human reference; a machine cannot approve. */
export function createVersionLog() {
  const versions = [];
  const human = (ref) => { if (typeof ref !== 'string' || !/^(approval|owner-decision):\/\/[A-Za-z0-9._:/-]+$/.test(ref)) fail(AI_ERROR.INVALID_DECISION, 'a decision needs an approval:// or owner-decision:// reference naming the human', { field: 'ref' }); return ref; };
  return {
    append(record) { const v = { version: versions.length + 1, status: 'PROPOSED', decided_by: null, ...record }; versions.push(Object.freeze(v)); return v; },
    decide(version, status, ref) {
      if (!['APPROVED', 'REJECTED'].includes(status)) fail(AI_ERROR.INVALID_DECISION, 'a decision is APPROVED or REJECTED');
      const i = versions.findIndex((v) => v.version === version);
      if (i < 0) fail(AI_ERROR.INVALID_DECISION, 'unknown version');
      versions[i] = Object.freeze({ ...versions[i], status, decided_by: human(ref) });
      return versions[i];
    },
    list: () => versions.slice(),
    latest: () => versions.at(-1) ?? null,
  };
}

/**
 * One generation step. Order: validate -> estimate -> reserve (refuse = no call) -> generate -> validate the plate -> compose with every gate -> log a version (PROPOSED).
 * @param {object} p { spec (without plate), images, fonts, palette, provider, budget (createCampaignBudget), log (createVersionLog), intent, constraints?, parent? , allow_reference_upload? , critic? }
 * @returns {{ version, creative, request, cost_eur }} creative is the composer result with the plate as the bottom layer; deliverable only if every hard gate passed.
 */
export async function generatePlateStep({ spec, images, fonts, palette, provider, budget, log, intent, constraints = [], parent = null, allow_reference_upload = false, critic = null, mode = 'PLATE_ONLY' }) {
  if (!AI_MODE[mode]?.enabled) fail(AI_ERROR.MODE_NOT_ENABLED, `the mode ${mode} is not enabled: only PLATE_ONLY is (the secure initial mode)`, { mode });
  if (provider.capabilities.needs_reference_image && !allow_reference_upload) fail(AI_ERROR.REFERENCE_UPLOAD_NOT_ALLOWED, 'this provider needs a reference image; uploading locked pixels is not enabled', { provider: provider.id });
  const request = buildPlateRequest({ spec, intent, constraints, seedLabel: `v${log.list().length + 1}` });
  const estimate = provider.estimate(request); // throws PROVIDER_NOT_CONNECTED for the default provider: nothing reserved, nothing called
  if (!(Number.isFinite(estimate) && estimate >= 0)) fail(AI_ERROR.INVALID_PLATE, 'the provider returned no usable estimate');
  try { budget.reserve(`plate:${log.list().length + 1}`, estimate); } catch (e) {
    if (e instanceof CampaignBudgetError) fail(AI_ERROR.BUDGET_EXCEEDED, 'the estimate would pass the ceiling: no call was made', e.detail);
    throw e;
  }
  const out = await provider.generate(request);
  const png = out?.png;
  let dims;
  try { dims = decodePng(png); } catch { fail(AI_ERROR.INVALID_PLATE, 'the provider did not return a readable PNG'); }
  if (dims.width !== request.size.width || dims.height !== request.size.height) fail(AI_ERROR.INVALID_PLATE, 'the plate is not the requested size', { got: [dims.width, dims.height], wanted: [request.size.width, request.size.height] });
  const cost = out.usage?.cost_eur;
  if (!(Number.isFinite(cost) && cost >= 0)) fail(AI_ERROR.INVALID_PLATE, 'the provider did not report its cost');
  const withPlate = { ...spec, layers: [{ type: 'image', id: 'plate', key: '__plate', role: 'background' }, ...spec.layers] };
  const creative = composeCreative({ spec: withPlate, images: new Map([...images, ['__plate', png]]), fonts, palette });
  const critique = critic ? await critic({ jpeg: creative.jpeg, record: creative.record }) : { status: 'SKIPPED_NO_CRITIC' };
  const version = log.append({
    parent: parent ?? null, kind: 'PLATE_GENERATION', provider_id: provider.id, model: out.usage?.model ?? null, intent_hash: sha(new TextEncoder().encode(request.intent)), request_hash: sha(new TextEncoder().encode(canonical(request))),
    estimate_eur: round(estimate), cost_eur: round(cost), over_estimate: cost > estimate + 1e-9, spec_hash: creative.record.spec_hash, plate_sha256: sha(png), png_sha256: creative.png_sha256, jpeg_sha256: creative.jpeg_sha256,
    deliverable: creative.record.deliverable, failed_gates: creative.record.checks.filter((c) => c.outcome === 'FAIL').map((c) => c.id), critic: critique.status ?? 'UNKNOWN',
  });
  return { version, creative, request, cost_eur: round(cost) };
}

export { createCampaignBudget };
