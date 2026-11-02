// SCENE AROUND THE REAL PRODUCT (Creative Production V1, premium path). It replaces ONLY the background renderer of the Creative Autonomy route.
//
//   Nordla's STAGE (framing, position)  ->  PLATE: the real cut-out placed on a neutral canvas, exactly where the compositor will put it   (scene_plate.py, local)
//   -> ONE image edit, n variants: the model SEES the product and builds the concept's scene around it                                      (qwen-image-edit.js, existing lane)
//   -> per variant: where did the model really draw the product, a ghost edge, a second product, contact shadow, reflection, light side       (scene_check.py, local)
//   -> the best passing variant becomes the scene; the compositor puts the AUTHENTIC pixels back at the measured place, the text layer on top (compose_stage.py)
//
// What is reused, unchanged in its guarantees: the edit lane (Frankfurt only, one model, no retry, prompt_extend off, scoped clearance from the real bytes BEFORE any
// reservation, spend guard, journal, private output store), the owner's media authorisation record (deriveCandidateAuthorization: the plate is an image derived from
// the authorised photo), the compositor and its fidelity proof, the environment structure measure (environment-suitability.js).
// What this module adds is the wiring and the per-variant decision. Nothing is generated into the product pixels that reach the owner.
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { editProductImage, IMAGE_EDIT_MODEL, IMAGE_EDIT_PROVIDER_ID } from '../marketing-creative/alibaba/qwen-image-edit.js';
import { deriveCandidateAuthorization } from '../marketing-creative/alibaba/qwen-vision.js';
import { decodePng } from '../creative-intelligence/png-pixels.js';
import { zoneObjectStructure, SUITABILITY } from '../creative-runtime/environment-suitability.js';
import { FORBIDDEN_DECOR } from './stage-contract.js';

const run$ = promisify(execFile);
const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPTS = resolve(HERE, '../../scripts/creative-autonomy');
const sha = (b) => createHash('sha256').update(b).digest('hex');

export const SCENE_PURPOSE = 'NORDLA_SCENE_PRODUCTION';
export const SCENE_BACKEND = 'SCENE_AROUND_PRODUCT';
export const SCENE_DEFAULTS = Object.freeze({ variants: 3, image_calls: 1 });
export const SCENE_ERROR = Object.freeze({
  NO_VARIANT_PASSED: 'SCENE_NO_VARIANT_PASSED',
  GEOMETRY_CHANGED: 'SCENE_GEOMETRY_CHANGED_NEEDS_NEW_SCENE',
  CALL_LIMIT: 'SCENE_IMAGE_CALL_LIMIT',
});

// ---- the words of the request: Nordla's decisions, translated. HABB's exclusions go ONLY to the negative prompt: a positive prompt never names what must not
// appear (lesson of the 2026-10-10 live run: "no phone" in the positive prompt, a phone in the image).
const TONE_WORDS = { DEEP_BLACK: 'near-black', CHARCOAL: 'charcoal grey', BRAND_NAVY: 'deep navy', BRAND_TERRACOTTA: 'terracotta', COOL_GREY: 'cool grey', WHITE: 'white' };
const BACKDROP_WORDS = { SEAMLESS_SWEEP: 'a seamless sweep', INFINITE_DARK: 'a deep space without a visible horizon', WALL_AND_FLOOR: 'a wall meeting the floor behind it' };
const FLOOR_WORDS = { MATTE: 'a matte surface', SATIN: 'a satin surface with a soft sheen', MIRROR: 'a polished reflective surface' };
const SIDE_WORDS = { LEFT: 'from the left', RIGHT: 'from the right', FRONT: 'from the front', BACK: 'from behind, as a rim', TOP: 'from above' };
const HEIGHT_WORDS = { LOW: 'seen from slightly below', PRODUCT_CENTER: 'seen at the object\'s mid height', HIGH: 'seen from slightly above' };
export const SCENE_NEGATIVE = Object.freeze([
  'second bottle', 'another product', 'duplicate object', 'people', 'hands', 'face', 'logos', 'letters', 'words', 'numbers', 'watermark', 'signage',
  'neon', 'artificial glow', 'lens flare', 'beige', 'cream', 'sand colour', 'ivory', 'gold', 'golden', 'glitter', 'hearts', 'leaves', 'foliage', 'flowers', 'plants', 'marble', 'velvet', 'bokeh',
  'cartoon', 'illustration', '3d render look', 'plastic look', 'distorted perspective',
  ...FORBIDDEN_DECOR.filter((w) => /^[a-z]+$/.test(w)),
]);
const clip = (s, n) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n).replace(/[.\s]+$/, '');

/** The structured edit request (qwen-image-edit.js builds the provider prompt from it). Exported for review and tests: no hidden wording. */
export function buildSceneRequest({ concept, artDirection: art, stage, width, height, n, purpose = SCENE_PURPOSE }) {
  if (!concept || !art || !stage?.camera || !stage?.key_light) throw new TypeError('concept, art direction and stage are required');
  const realism = art.realism === 'EDITORIAL_STYLISED' ? 'an editorial commercial photograph' : 'a photorealistic commercial photograph, real materials, real optics';
  const scene = [
    `${realism}, ${HEIGHT_WORDS[stage.camera.height] ?? ''}`,
    `The image tells this idea: ${clip(concept.central_idea, 260)}; ${clip(concept.visual_metaphor, 260)}`,
    `Atmosphere: ${clip(art.atmosphere, 260)}`,
    `Materials: ${clip(art.material_language, 220)}`,
    `Light: ${clip(art.lighting_intent, 220)}; the key light comes ${SIDE_WORDS[stage.key_light.side] ?? 'from the side'}, ${String(stage.key_light.temperature ?? 'NEUTRAL').toLowerCase()} in colour`,
    `Setting: ${BACKDROP_WORDS[stage.backdrop] ?? 'a set'} in ${TONE_WORDS[stage.backdrop_tone] ?? 'a dark tone'}, the object standing on ${FLOOR_WORDS[stage.floor_finish] ?? 'a surface'}`,
    'Leave calm space on the side opposite the object, for a headline added later',
  ].join('. ');
  return Object.freeze({
    request_id: `scene-${sha(scene).slice(0, 12)}`,
    capability: 'IMAGE_EDIT', text_policy: 'NO_CRITICAL_TEXT', purpose, size: `${width}*${height}`, n,
    scene,
    product_role: 'it stays exactly where it stands in the reference image, at the same size, upright and resting on the surface, with a natural contact shadow under it'
      + (stage.floor_finish === 'MIRROR' ? ' and its reflection directly below it' : '') + ', lit by the same light as the scene',
    preserve: ['its position and size in the frame', 'its outline and proportions', 'its lid, clip and every printed mark', 'its colour and finish'],
    forbid: [...SCENE_NEGATIVE],
  });
}

/** Side zones next to the restored product (the environment-suitability structure measure): clutter that competes with the product. Evidence, not a gate. */
export function integrationZones(png, meta) {
  const img = decodePng(png);
  const [bx, by] = meta.bottom_front; const ty = meta.top_front[1]; const h = by - ty; const w = Math.max(8, Math.round(h * 0.3));
  const zones = { left: { x: bx - 1.6 * w, y: ty, width: w, height: h }, right: { x: bx + 0.6 * w, y: ty, width: w, height: h } };
  const out = {};
  for (const [k, z] of Object.entries(zones)) {
    if (z.x < 0 || z.x + z.width > img.width) { out[k] = null; continue; }
    const m = zoneObjectStructure(img, z); out[k] = m.structure_share == null ? null : Math.round(m.structure_share * 10000) / 10000;
  }
  const busy = Object.values(out).some((v) => v != null && v > SUITABILITY.max_structure_share * 4);
  return { structure_share: out, busy, limit_for_warning: SUITABILITY.max_structure_share * 4 };
}

/**
 * @param {object} o
 *  baseEngines   localEngines() of run.js: examine and compose stay the real local engines
 *  config        the IMAGE workspace config (loadAlibabaCreativeConfig): Frankfurt, qwen-image-3.0-pro
 *  authorization the owner's EXTERNAL_MEDIA_AUTHORIZATION for the product photo, purpose NORDLA_SCENE_PRODUCTION, IMAGE_EDIT, derived images transmissible
 *  photoSha256   the SHA-256 of the authorised photo (the plate must be derived from it)
 *  budget, journal, outputStore, fetchImpl   as for the edit lane
 *  variants      images in the ONE call (default 3)        maxImageCalls  default 1
 */
export function createSceneEngine({ baseEngines, config, authorization, photoSha256, budget, journal = null, outputStore, fetchImpl = globalThis.fetch,
  variants = SCENE_DEFAULTS.variants, maxImageCalls = SCENE_DEFAULTS.image_calls, edit = editProductImage,
  python = process.env.NORDLA_PYTHON || (process.platform === 'win32' ? 'python' : 'python3') } = {}) {
  if (typeof baseEngines?.examine !== 'function' || typeof baseEngines?.compose !== 'function') throw new TypeError('the real local examination and compositor are required');
  if (config?.imageModel !== IMAGE_EDIT_MODEL || config?.region !== 'eu-central-1') throw new Error('the scene engine runs qwen-image-3.0-pro in Frankfurt only');
  if (authorization?.purpose !== SCENE_PURPOSE || !authorization?.allowed_operations?.includes('IMAGE_EDIT')) throw new Error('EXTERNAL_MEDIA_SHARING_NOT_AUTHORIZED: a NORDLA_SCENE_PRODUCTION / IMAGE_EDIT record is required');
  if (!/^[0-9a-f]{64}$/.test(photoSha256 ?? '')) throw new TypeError('photoSha256 is required');
  if (!budget?.reserveImages) throw new TypeError('SpendGuard is required');
  if (!outputStore?.readBytes || !outputStore?.storeUrl) throw new TypeError('a readable private output store is required');
  if (!Number.isInteger(variants) || variants < 1 || variants > 6) throw new RangeError('variants: 1 to 6');
  const py = async (script, args) => JSON.parse((await run$(python, [join(SCRIPTS, script), ...args], { maxBuffer: 1 << 24, timeout: 300_000 })).stdout.trim().split('\n').pop());
  let calls = 0; let cache = null;

  async function render({ stage, concept, artDirection, canvas, stagePath, examPath, rgbaPath, outPath }) {
    const W = canvas.width; const H = canvas.height;
    const key = JSON.stringify({ W, H, camera: stage.camera });
    if (cache) {
      // a refinement that keeps the geometry (text placement only) reuses the scene: no new paid call
      if (cache.key !== key) throw Object.assign(new Error(`${SCENE_ERROR.GEOMETRY_CHANGED}: a new framing or position needs a new paid scene, which this plan does not authorise`), { code: SCENE_ERROR.GEOMETRY_CHANGED });
      copyFileSync(cache.scenePath, outPath); copyFileSync(`${cache.scenePath}.json`, `${outPath}.json`);
      return Object.freeze({ ...cache.info, reused_scene: true, image_cost_eur: 0 });
    }
    if (calls >= maxImageCalls) throw Object.assign(new Error(`${SCENE_ERROR.CALL_LIMIT}: ${maxImageCalls} image call(s) authorised`), { code: SCENE_ERROR.CALL_LIMIT });
    const dir = dirname(outPath);
    const platePath = join(dir, 'scene_plate.png');
    const plate = await py('scene_plate.py', [examPath, rgbaPath, stagePath, String(W), String(H), platePath]);
    const plateBytes = readFileSync(platePath);
    const plateSha = sha(plateBytes);
    // the plate is an image DERIVED from the authorised photo: its clearance is the owner's record, bound to the plate's own bytes (refused otherwise)
    const clearance = deriveCandidateAuthorization({ authorization, source_asset_sha256: photoSha256, candidate_ref: `scene-plate://${plateSha}`, candidate_sha256: plateSha });
    const request = buildSceneRequest({ concept, artDirection, stage, width: W, height: H, n: variants });
    calls += 1; // counted BEFORE the call: a failed call still consumed the authorised call
    const result = await edit({ config, authorization: clearance, asset: { ref: `scene-plate://${plateSha}`, bytes: plateBytes, media_type: 'image/png' }, request, budget, journal, outputStore, fetchImpl });
    const outputs = result.outputs ?? [result.output];
    const reports = [];
    for (let i = 0; i < outputs.length; i += 1) {
      const bytes = await outputStore.readBytes(outputs[i]);
      const ext = result.output_infos?.[i]?.media_type === 'image/jpeg' ? 'jpg' : 'png';
      const rawPath = join(dir, `scene_v${i + 1}.provider.${ext}`); writeFileSync(rawPath, bytes);
      const normPath = join(dir, `scene_v${i + 1}.png`);
      let rep;
      try { rep = await py('scene_check.py', [rawPath, `${platePath}.json`, rgbaPath, examPath, stagePath, normPath]); } catch (error) { rep = { pass: false, rejections: ['SCENE_NOT_MEASURABLE'], warnings: [], error: String(error.message).slice(0, 200) }; }
      if (rep.compose_meta) {
        try { rep.integration_zone = integrationZones(readFileSync(normPath), rep.compose_meta); if (rep.integration_zone.busy) rep.warnings.push('BUSY_INTEGRATION_ZONE'); } catch { rep.integration_zone = null; }
      }
      reports.push({ variant: i + 1, provider_sha256: sha(bytes), path: normPath, ...rep });
    }
    const summary = reports.map(({ variant, pass, rejections, warnings, alignment, ghost, duplicate, contact_shadow: shadow, reflection, light, product_level: level, integration_zone: zone, provider_sha256: psha }) => ({
      variant, pass, rejections, warnings, provider_sha256: psha,
      alignment: alignment && { dx: alignment.dx, dy: alignment.dy, scale: alignment.scale, edge_ncc: alignment.edge_ncc }, ghost, duplicate, contact_shadow: shadow, reflection, light, product_level: level, integration_zone: zone,
    }));
    writeFileSync(join(dir, 'scene_variants.json'), JSON.stringify({ request: { ...request, prompt_note: 'the provider prompt is built from this request by qwen-image-edit.js#buildProductEditPrompt' }, plate: { ...plate, sha256: plateSha }, model: result.model, request_id: result.request_id, cost_eur: result.cost_eur_estimated, variants: summary }, null, 1));
    const passing = reports.filter((r) => r.pass);
    if (!passing.length) {
      throw Object.assign(new Error(`${SCENE_ERROR.NO_VARIANT_PASSED}: ${summary.map((v) => `v${v.variant} ${v.rejections.join('+')}`).join('; ')}`), { code: SCENE_ERROR.NO_VARIANT_PASSED, evidence: { variants: summary } });
    }
    // the best passing variant: the product where the model drew it, no ghost, then fewer realism warnings, then a measured contact shadow
    const score = (r) => r.alignment.edge_ncc - (r.ghost?.share ?? 0) - 0.05 * r.warnings.length + (r.contact_shadow?.present ? 0.05 : 0);
    const chosen = passing.reduce((a, b) => (score(b) > score(a) ? b : a));
    copyFileSync(chosen.path, outPath); copyFileSync(`${chosen.path}.json`, `${outPath}.json`);
    const info = Object.freeze({
      resolution: [W, H], foreground_props: 0, render_backend: SCENE_BACKEND, model: result.model, request_id: result.request_id ?? null,
      image_sha256: chosen.provider_sha256, image_cost_eur: result.cost_eur_estimated ?? null, images_billed: outputs.length,
      source_photo_transmitted: 'PLATE_DERIVED_FROM_THE_AUTHORISED_PHOTO', clearance_id: result.clearance_id ?? null, plate_sha256: plateSha,
      chosen_variant: chosen.variant, variants: summary, reused_scene: false,
    });
    cache = { key, scenePath: chosen.path, info };
    return info;
  }

  return Object.freeze({
    ...baseEngines,
    name: Object.freeze({ ...baseEngines.name, render: `scène générée autour du produit réel (${IMAGE_EDIT_MODEL}, édition, ${variants} variantes)`, renderProvider: IMAGE_EDIT_PROVIDER_ID }),
    sceneMode: true,
    // what this engine may transmit and the ONLY source it is bound to (checked by the Shopify entrypoint before any run)
    binding: Object.freeze({ transmits_source_media: true, source_sha256: photoSha256, authorization_id: authorization.authorization_id ?? null }),
    render,
    stats: () => ({ image_calls: calls, scene_cached: Boolean(cache) }),
  });
}
