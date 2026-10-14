import { ARTIFACT as A, RELIGHT as R, SHADOW as SH } from './constants.js';
import {
  alphaExtremaShare, dilate, labelComponents, lumaAt,
} from './pixels.js';

// ARTIFACT DETECTION on the integrated scene. The product, the shadow and the plate are known separately, so every artifact is measured against what it should be:
//   HALO                 the ring just outside the product differs from the plate by more than the shadow explains          FLOATING_OBJECT       the product does not touch its support, or the contact is not darkened
//   DETACHED_SHADOW      a shadow piece that does not touch the contact region                                                DOUBLE_SHADOW         two shadow lobes, or the plate already carries a shadow at the contact
//   SHADOW_DIRECTION     the shadow falls the wrong way for the declared light                                                CLIPPING              the product lost highlights / shadows, or is cut by the canvas
//   DEFORMATION          the product was stretched                                                                            ALPHA_NOISE           the placed alpha ramp is jagged
// Each returns { code, ok, value, limit }; `clean` is true only if every check is ok. A check that cannot be measured is NOT ok.

const check = (code, value, limit, ok) => Object.freeze({ code, ok: Boolean(ok), value, limit });
const unmeasurable = (code, reason) => Object.freeze({ code, ok: false, value: null, limit: null, reason });

/**
 * @param {object} input { plate, composite, placed, shadow? (layer), geometry? (shadow geometry), light?, relight_measured?, placement, cutout_size: { width, height } }
 */
export function detectArtifacts({
  plate, composite, placed, shadow = null, geometry = null, relightMeasured = null, placement = {}, cutoutSize = null, ignoreDarkening = false,
}) {
  const findings = []; const { width: W, height: Hh } = composite;
  const alphaScene = new Uint8Array(W * Hh); const shadowScene = new Uint8Array(W * Hh);
  const r = placed.rect;
  for (let y = 0; y < placed.rgba.height; y += 1) for (let x = 0; x < placed.rgba.width; x += 1) { const sx = r.x + x; const sy = r.y + y; if (sx >= 0 && sy >= 0 && sx < W && sy < Hh) alphaScene[sy * W + sx] = placed.rgba.pixels[(y * placed.rgba.width + x) * 4 + 3]; }
  if (shadow) for (let y = 0; y < shadow.height; y += 1) for (let x = 0; x < shadow.width; x += 1) { const sx = shadow.x + x; const sy = shadow.y + y; if (sx >= 0 && sy >= 0 && sx < W && sy < Hh) shadowScene[sy * W + sx] = shadow.pixels[(y * shadow.width + x) * 4 + 3]; }

  // HALO: the ring outside the product (alpha 0, within halo_ring_px of alpha >= 128), where no shadow is, must equal the plate
  {
    const hard = new Uint8Array(W * Hh); for (let i = 0; i < hard.length; i += 1) if (alphaScene[i] >= 128) hard[i] = 1;
    const reach = dilate(hard, W, Hh, A.halo_ring_px); let tested = 0; let bad = 0;
    for (let i = 0; i < hard.length; i += 1) {
      if (hard[i] || !reach[i] || alphaScene[i] > 8 || shadowScene[i] > 5) continue; tested += 1;
      const delta = lumaAt(composite.pixels, i * 4) - lumaAt(plate.pixels, i * 4); // a renderer's own soft shadow (declared by the caller) darkens the ring: only a LIGHTER ring is a halo then
      if ((ignoreDarkening ? delta : Math.abs(delta)) > A.halo_luma_delta) bad += 1;
    }
    const share = tested ? bad / tested : 0;
    findings.push(check('HALO', share, A.halo_max_share, share <= A.halo_max_share));
  }

  // clipping and cropping
  {
    const o = placed.opaque; const cropped = o.x0 < 0 || o.y0 < 0 || o.x1 >= W || o.y1 >= Hh;
    findings.push(check('CROPPED_BY_THE_CANVAS', cropped ? 1 : 0, 0, !cropped));
    if (relightMeasured) findings.push(check('CLIPPING', relightMeasured.new_clip_share, R.clip_share_max, relightMeasured.new_clip_share <= R.clip_share_max));
  }

  // deformation
  if (cutoutSize) {
    const sx = placed.rgba.width / cutoutSize.width; const sy = placed.rgba.height / cutoutSize.height; const e = Math.abs(sx / sy - 1);
    findings.push(check('DEFORMATION', e, 0.01, e <= 0.01));
  }

  if (shadow && geometry) {
    const c = geometry.contact_region;
    if (c) {
      // FLOATING: the contact is darkened under the product
      let covered = 0; let cols = 0;
      for (let x = c.x0; x <= c.x1; x += 1) {
        // the lowest product row of this column within 3 px of the declared contact line (the renderer draws at a fractional position: a sub-pixel gap is not a floating product)
        let yb = -1; for (let yy = Math.min(Hh - 1, c.contact_y); yy >= c.contact_y - 3; yy -= 1) if (alphaScene[yy * W + x] >= 128) { yb = yy; break; }
        if (yb < 0) continue; cols += 1;
        let m = 0; for (let t = 1; t < 4; t += 1) { const yy = yb + t; if (yy < Hh) m = Math.max(m, shadowScene[yy * W + x]); }
        if (m >= 0.15 * 255) covered += 1;
      }
      const coverage = cols ? covered / cols : 0;
      findings.push(check('FLOATING_OBJECT', coverage, SH.min_contact_coverage, coverage >= SH.min_contact_coverage));
      // DETACHED: every shadow piece touches the contact region
      const mask = new Uint8Array(W * Hh); for (let i = 0; i < mask.length; i += 1) if (shadowScene[i] >= 0.1 * 255) mask[i] = 1;
      const { list, labels } = labelComponents(mask, W, Hh);
      const contactMask = new Uint8Array(W * Hh); for (let x = c.x0; x <= c.x1; x += 1) for (let y = c.y0; y <= c.contact_y + 1; y += 1) if (y >= 0 && y < Hh) contactMask[y * W + x] = 1;
      const near = dilate(contactMask, W, Hh, SH.max_detach_px); const touching = new Set();
      for (let i = 0; i < mask.length; i += 1) if (mask[i] && near[i]) touching.add(labels[i]);
      const detached = list.filter((comp) => !touching.has(comp.id) && comp.area > 4).length;
      findings.push(check('DETACHED_SHADOW', detached, 0, detached === 0));
      findings.push(check('DOUBLE_SHADOW_LOBES', list.filter((comp) => comp.area > 4).length, SH.max_lobes, list.filter((comp) => comp.area > 4).length <= SH.max_lobes));
      // the plate already carries a shadow at the contact
      const o = placed.opaque; const strip = []; const ref = [];
      const sh = Math.max(3, Math.round((o.y1 - o.y0) * 0.06)); const margin = Math.round((o.x1 - o.x0) * 0.15);
      for (let y = c.contact_y; y < Math.min(Hh, c.contact_y + sh); y += 1) for (let x = Math.max(0, o.x0 - margin); x <= Math.min(W - 1, o.x1 + margin); x += 1) strip.push(lumaAt(plate.pixels, (y * W + x) * 4));
      for (let y = Math.min(Hh - 1, c.contact_y + 2 * sh); y < Math.min(Hh, c.contact_y + 3 * sh); y += 1) for (let x = Math.max(0, o.x0 - margin); x <= Math.min(W - 1, o.x1 + margin); x += 1) ref.push(lumaAt(plate.pixels, (y * W + x) * 4));
      if (strip.length && ref.length) {
        const med = (v) => [...v].sort((p, q) => p - q)[v.length >> 1]; const drop = 1 - med(strip) / Math.max(1, med(ref));
        findings.push(check('PLATE_SHADOW_AT_CONTACT', drop, 0.18, drop <= 0.18));
      } else findings.push(unmeasurable('PLATE_SHADOW_AT_CONTACT', 'no plate pixels under the contact'));
      // direction
      if (Math.abs(geometry.kx) > 0.2 && geometry.centroid_x !== null) {
        const centre = (placed.opaque.x0 + placed.opaque.x1) / 2; const wrong = Math.sign(geometry.centroid_x - centre) !== Math.sign(geometry.kx);
        findings.push(check('SHADOW_DIRECTION', wrong ? 1 : 0, 0, !wrong));
      }
    }
  } else if (placement.anchor !== 'CENTER' && !shadow) findings.push(unmeasurable('FLOATING_OBJECT', 'no shadow layer: the contact cannot be judged'));

  // ALPHA_NOISE of the placed alpha ramp
  {
    const noise = alphaExtremaShare(placed.rgba.pixels, placed.rgba.width, placed.rgba.height, 4, 3);
    findings.push(check('ALPHA_NOISE', noise, A.alpha_noise_max, noise <= A.alpha_noise_max));
  }
  return Object.freeze({ clean: findings.every((f) => f.ok), findings: Object.freeze(findings) });
}
