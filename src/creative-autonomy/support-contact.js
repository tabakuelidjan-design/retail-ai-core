// DETECTED ANCHORING versus CONFIRMED CONTACT (C2, 2026-11-06). Two different facts, never merged:
//   - the ANCHORING is measured on the PRODUCT: the body's base (not the tip of a hanging cable) is placed on the contact line (scene_plate.py, body_anchor.py). It is always known.
//   - the CONTACT with the DECOR is measured on the DECOR image (the scene WITHOUT the product): is there, at the contact line and across the width of the base, the surface the stage asked for?
//     A request that DESCRIBES a ledge proves nothing (`verified_in_image` stays false until this measure says so).
// Outcome: SUPPORT_CONFIRMED, or SUPPORT_UNCONFIRMED = "À vérifier par le propriétaire": never refused, never accepted on its own, and NEVER compensated by a block drawn afterwards. The list `missing` says what would confirm it.
// Measure (luminance, local, deterministic): a SUPPORT EDGE is a horizontal step of the row-averaged luminance, over the width of the base, within EDGE_TOLERANCE_PX of the contact line, that most columns agree on.
import { decodePng } from '../creative-intelligence/png-pixels.js';
import { encodePng } from '../creative-intelligence/png-encode.js';

export const CONTACT_STATUS = Object.freeze({ CONFIRMED: 'SUPPORT_CONFIRMED', UNCONFIRMED: 'SUPPORT_UNCONFIRMED' });
export const OWNER_REVIEW_LABEL = 'À vérifier par le propriétaire';
export const CONTACT_LIMITS = Object.freeze({ edge_tolerance_px: 12, min_step_levels: 6, min_coverage: 0.8, window_px: 28, margin_share: 0.25, horizon_min_rows_above: 20, horizon_min_width_share: 0.6 });

const lum = (p, i) => 0.299 * p[i] + 0.587 * p[i + 1] + 0.114 * p[i + 2];

/** The strongest horizontal step of the row-averaged luminance in rows [y0, y1] over columns [x0, x1]: { row, step, coverage } (step = signed levels, coverage = share of columns that agree on its sign). */
function strongestStep({ width, height, pixels }, x0, x1, y0, y1) {
  const xa = Math.max(0, Math.floor(x0)); const xb = Math.min(width - 1, Math.ceil(x1)); const ya = Math.max(2, Math.floor(y0)); const yb = Math.min(height - 3, Math.ceil(y1));
  if (xb - xa < 8 || yb <= ya) return null;
  const rowMean = (y) => { let s = 0; for (let x = xa; x <= xb; x += 1) s += lum(pixels, (y * width + x) * 4); return s / (xb - xa + 1); };
  let best = null;
  for (let y = ya; y <= yb; y += 1) {
    const above = (rowMean(y - 1) + rowMean(y - 2)) / 2; const below = (rowMean(y) + rowMean(y + 1)) / 2; const step = below - above;
    if (!best || Math.abs(step) > Math.abs(best.step)) best = { row: y, step };
  }
  let agree = 0;
  for (let x = xa; x <= xb; x += 1) {
    const col = (yy) => lum(pixels, (yy * width + x) * 4);
    const d = (col(best.row) + col(best.row + 1)) / 2 - (col(best.row - 1) + col(best.row - 2)) / 2;
    if (Math.sign(d) === Math.sign(best.step) && Math.abs(d) >= 0.4 * Math.abs(best.step)) agree += 1;
  }
  return { row: best.row, step: Math.round(best.step * 10) / 10, coverage: Math.round((agree / (xb - xa + 1)) * 100) / 100 };
}

/** A wall/floor line ABOVE the contact: a strong horizontal step across most of the frame width, at least `horizon_min_rows_above` rows above the contact line. */
function horizonAbove(img, contactY) {
  const found = strongestStep(img, 0, img.width - 1, 0.2 * img.height, contactY - CONTACT_LIMITS.horizon_min_rows_above);
  return found && Math.abs(found.step) >= CONTACT_LIMITS.min_step_levels && found.coverage >= CONTACT_LIMITS.horizon_min_width_share ? found : null;
}

/**
 * @param {Buffer|Uint8Array} decorPng the DECOR without the product (what the image model drew)
 * @param {{ x:number, y:number, base_w_px:number, drop_px:number, anchored:boolean, source:string }} contact the product's body contact on the canvas (meta.body_anchor of scene_plate.py)
 * @param {'FLOOR'|'LEDGE'|'STEP'|'BENCH'|'TABLE'} supportSurface what the stage asked for ('FLOOR' when the stage says nothing)
 */
export function measureSupportContact({ decorPng, contact, supportSurface = 'FLOOR' }) {
  const img = decodePng(decorPng); const L = CONTACT_LIMITS;
  const half = (contact.base_w_px / 2) * (1 + L.margin_share);
  const edge = strongestStep(img, contact.x - half, contact.x + half, contact.y - L.window_px, contact.y + L.window_px);
  const hangs = contact.anchored === true && contact.drop_px > 0;
  const missing = []; const measurements = { contact_row: contact.y, base_width_px: contact.base_w_px, hanging_part_px: contact.drop_px, strongest_edge_near_contact: edge };
  const edgeAtContact = Boolean(edge) && Math.abs(edge.step) >= L.min_step_levels && edge.coverage >= L.min_coverage && Math.abs(edge.row - contact.y) <= L.edge_tolerance_px;
  if (supportSurface === 'FLOOR') {
    const horizon = horizonAbove(img, contact.y); measurements.horizon_above_contact = horizon;
    if (!horizon) missing.push('NO_FLOOR_PLANE_FOUND: no wall/floor line above the contact line, so the contact cannot be placed on a continuous floor');
    if (hangs) missing.push(`HANGING_PART_ON_A_PLANE: a part hangs ${contact.drop_px} px below the contact line; on a plain floor its tip floats or crosses the floor and the three-dimensional relation cannot be measured (it needs an edge to hang over)`);
  } else if (!edgeAtContact) {
    missing.push(edge
      ? `NO_SUPPORT_EDGE_AT_CONTACT: the ${supportSurface} requested is not drawn where the base rests (the strongest horizontal edge within ${L.window_px} px is at row ${edge.row}, ${Math.abs(edge.row - contact.y)} px from the contact line, step ${edge.step} levels, ${Math.round(edge.coverage * 100)} % of the base width agree; needed: within ${L.edge_tolerance_px} px, step >= ${L.min_step_levels}, >= ${L.min_coverage * 100} %)`
      : 'NO_SUPPORT_EDGE_AT_CONTACT: no horizontal edge can be measured around the contact line');
  }
  const confirmed = missing.length === 0;
  return Object.freeze({ status: confirmed ? CONTACT_STATUS.CONFIRMED : CONTACT_STATUS.UNCONFIRMED, status_label: confirmed ? null : OWNER_REVIEW_LABEL, anchoring: { detected_on: contact.source, anchored: contact.anchored === true }, support_requested: supportSurface, measurements, missing, verified_in_image: confirmed });
}

/**
 * The crop shown to the owner for an "À vérifier" contact: the base, the contact line (a thin cyan line) and everything that hangs below it, enlarged with hard pixels (no smoothing: a halo or a gap must be visible).
 * @param {Buffer|Uint8Array} compositePng the finished image WITHOUT text (decor + real product)
 * @returns {{ png: Buffer, rect: { x, y, width, height }, scale: number }}
 */
export function contactReviewCrop({ compositePng, contact, box, scale = 3 }) {
  const img = decodePng(compositePng);
  const x0 = Math.max(0, Math.round(box.x0 - 24)); const x1 = Math.min(img.width, Math.round(box.x0 + box.w + 24));
  const y0 = Math.max(0, Math.round(contact.y - 180)); const y1 = Math.min(img.height, Math.round(box.y0 + box.h + 40));
  const w = x1 - x0; const h = y1 - y0; const out = new Uint8Array(w * scale * h * scale * 4);
  for (let y = 0; y < h * scale; y += 1) for (let x = 0; x < w * scale; x += 1) {
    const si = ((y0 + Math.floor(y / scale)) * img.width + x0 + Math.floor(x / scale)) * 4; const di = (y * w * scale + x) * 4;
    out[di] = img.pixels[si]; out[di + 1] = img.pixels[si + 1]; out[di + 2] = img.pixels[si + 2]; out[di + 3] = 255;
  }
  const ly = (contact.y - y0) * scale; // the contact line, 2 px thick
  for (let t = 0; t < 2; t += 1) for (let x = 0; x < w * scale; x += 1) { const di = ((ly + t) * w * scale + x) * 4; if (ly + t >= 0 && ly + t < h * scale) { out[di] = 0; out[di + 1] = 220; out[di + 2] = 255; } }
  return { png: Buffer.from(encodePng({ width: w * scale, height: h * scale, pixels: out })), rect: { x: x0, y: y0, width: w, height: h }, scale };
}
