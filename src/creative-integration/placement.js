import { PLACEMENT as P, STATE } from './constants.js';

// REALISTIC PLACEMENT RULES. A placement is judged against the scene it goes into BEFORE any shadow or light is computed; an impossible one is PLACEMENT_INVALID with every reason named. The rules are geometric
// and explicit (no model): rotation, scale, visibility, size plausibility, perspective (scale along the depth of the support surface), the horizon, the support surface, grounding and the occlusion order.
// The product is scaled uniformly and not rotated in this phase (the layer contract forbids rotation of the product pixels), so a tilt is refused rather than approximated.

const inPolygon = (poly, x, y) => {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i, i += 1) {
    const [xi, yi] = poly[i]; const [xj, yj] = poly[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
};

const overlap = (a, b) => Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)) * Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));

/**
 * @param {object} input
 *   scene:     { width, height, horizon_y?, support: { kind: 'HORIZONTAL_PLANE', line_y?, polygon? } | { kind: 'VERTICAL_PLANE' }, depth_scale?: { ref_y, ref_px_per_cm } }
 *   placed:    result of placeCutout (rect, opaque, contact_y) + placement { scale, scale_x?, scale_y?, rotation_deg?, anchor }
 *   product:   { real_height_cm?, may_tilt? }
 *   neighbours: [{ opaque: {x0,y0,x1,y1}, contact_y, z }] other placed products;  z: this product's z
 *   occluders: [{ rect: {x,y,width,height}, z }] layers drawn OVER this product;  protected: [{x,y,width,height}] in scene px
 * @returns {{ state, reasons: string[], measurements }}
 */
export function validatePlacement({ scene, placed, placement, product = {}, neighbours = [], z = 30, occluders = [], protectedRegions = [] }) {
  const reasons = []; const m = {};
  const o = placed.opaque; const w = o.x1 - o.x0 + 1; const h = o.y1 - o.y0 + 1;
  if (!(Number.isFinite(placement.scale) && placement.scale > 0)) reasons.push('SCALE_INVALID');
  if ((placement.rotation_deg ?? 0) !== 0) reasons.push(product.may_tilt ? 'ROTATION_UNSUPPORTED_IN_THIS_PHASE' : (Math.abs(placement.rotation_deg) > P.max_tilt_deg ? 'TILT_TOO_LARGE' : 'ROTATION_UNSUPPORTED_IN_THIS_PHASE'));
  if (placement.scale_x !== undefined && placement.scale_y !== undefined && Math.abs(placement.scale_x / placement.scale_y - 1) > P.aspect_tolerance) reasons.push('ASPECT_DEFORMED');

  const vx0 = Math.max(0, o.x0); const vy0 = Math.max(0, o.y0); const vx1 = Math.min(scene.width - 1, o.x1); const vy1 = Math.min(scene.height - 1, o.y1);
  const visible = Math.max(0, vx1 - vx0 + 1) * Math.max(0, vy1 - vy0 + 1) / (w * h); m.visible_share = visible;
  if (visible < P.min_visible_share) reasons.push('OUTSIDE_THE_CANVAS');

  const heightShare = h / scene.height; m.height_share = heightShare;
  if (heightShare < P.min_height_share || heightShare > P.max_height_share) reasons.push('SIZE_IMPLAUSIBLE');

  const support = scene.support ?? { kind: 'HORIZONTAL_PLANE' };
  const standing = (placement.anchor ?? 'BOTTOM_CENTER') === 'BOTTOM_CENTER';
  if (standing && support.kind === 'HORIZONTAL_PLANE') {
    if (scene.horizon_y !== undefined && !(placed.contact_y > scene.horizon_y)) reasons.push('CONTACT_ABOVE_THE_HORIZON');
    if (support.line_y !== undefined && Math.abs(placed.contact_y - support.line_y) > P.contact_tolerance_px) reasons.push('NOT_ON_THE_SUPPORT_LINE');
    if (support.polygon) {
      const cy = placed.contact_y - 1;
      const probes = [[o.x0, cy], [(o.x0 + o.x1) / 2, cy], [o.x1, cy]];
      if (!probes.every(([px, py]) => inPolygon(support.polygon, px, py))) reasons.push('NOT_ON_THE_SUPPORT_SURFACE');
    }
    if (scene.depth_scale && product.real_height_cm && scene.horizon_y !== undefined) {
      const ppc = scene.depth_scale.ref_px_per_cm * ((placed.contact_y - scene.horizon_y) / (scene.depth_scale.ref_y - scene.horizon_y));
      const expected = ppc * product.real_height_cm; m.expected_height_px = expected; m.height_px = h;
      if (Math.abs(h / expected - 1) > P.scale_tolerance) reasons.push('SCALE_INCONSISTENT_WITH_DEPTH');
    }
  }
  if (standing && support.kind === 'VERTICAL_PLANE') reasons.push('A_STANDING_PRODUCT_NEEDS_A_HORIZONTAL_SUPPORT');
  if (!standing && support.kind === 'HORIZONTAL_PLANE' && !product.may_lie_flat) reasons.push('A_HANGING_PLACEMENT_NEEDS_A_VERTICAL_SUPPORT');

  // occlusion order between products: on a horizontal plane the one farther from the camera (smaller contact_y) must be behind (smaller z) when they overlap
  for (const nb of neighbours) {
    const a = { x: o.x0, y: o.y0, width: w, height: h }; const b = { x: nb.opaque.x0, y: nb.opaque.y0, width: nb.opaque.x1 - nb.opaque.x0 + 1, height: nb.opaque.y1 - nb.opaque.y0 + 1 };
    if (overlap(a, b) > 0) {
      if (placed.contact_y === nb.contact_y) reasons.push('OVERLAP_AT_THE_SAME_DEPTH');
      else if ((placed.contact_y < nb.contact_y) !== (z < nb.z)) reasons.push('OCCLUSION_ORDER_CONTRADICTS_DEPTH');
    }
  }
  for (const oc of occluders) {
    if (oc.z <= z) continue;
    for (const pr of protectedRegions) if (overlap(oc.rect, pr) > P.max_occlusion_of_protected) { reasons.push('OCCLUDES_A_PROTECTED_REGION'); break; }
  }
  return Object.freeze({ state: reasons.length ? STATE.PLACEMENT_INVALID : STATE.READY_FOR_COMPOSITE, reasons: Object.freeze([...new Set(reasons)]), measurements: Object.freeze(m) });
}
