// Layout Constraint Engine V1. Deterministic geometry: no LLM, no randomness, no clock (the revision timestamp is an explicit input).
//
//   output context (canvas, margins, safe zones, forbidden zones) -> usable rectangle
//   + a declarative recipe (slots as fractions of the usable rectangle)
//   -> boxes -> product / logo fitted by their real aspect ratio (never distorted) -> text fitted (never below min_font_size)
//   -> constraints verified -> a NEW revision of the DesignDocument + a report.
//
// The engine never shrinks text below its minimum, never moves a locked layer, never hides a problem: whatever does not fit is
// reported (TEXT_DOES_NOT_FIT with the layer's overflow_policy) and the preflight will fail it.

import {
  CI_ERROR as E, CONSTRAINT_KIND, GEOMETRY_EPSILON, LAYER_ORIGIN, LAYER_TYPE, NEGATIVE_SPACE, TEXT_DIRECTION, VISIBILITY,
} from './constants.js';
import { reviseDesignDocument } from './design-document.js';
import { layerBounds } from './layers.js';
import { getLayoutRecipe } from './layout-recipes.js';
import { fitText } from './typography.js';
import {
  area, contains, deepFreeze, enumValue, fail, intersects, iso, number,
} from './validation.js';

const r3 = (v) => Math.round(v * 1000) / 1000;

function intersection(a, b) {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const right = Math.min(a.x + a.width, b.x + b.width);
  const bottom = Math.min(a.y + a.height, b.y + b.height);
  return right - x > GEOMETRY_EPSILON && bottom - y > GEOMETRY_EPSILON ? { x, y, width: right - x, height: bottom - y } : null;
}

/** The biggest rectangle left of `rect` once `zone` is removed (ties: above, below, start side, end side). */
function carve(rect, zone) {
  if (!intersects(rect, zone)) return rect;
  const candidates = [
    { x: rect.x, y: rect.y, width: rect.width, height: zone.y - rect.y },
    { x: rect.x, y: zone.y + zone.height, width: rect.width, height: rect.y + rect.height - (zone.y + zone.height) },
    { x: rect.x, y: rect.y, width: zone.x - rect.x, height: rect.height },
    { x: zone.x + zone.width, y: rect.y, width: rect.x + rect.width - (zone.x + zone.width), height: rect.height },
  ].filter((c) => c.width > GEOMETRY_EPSILON && c.height > GEOMETRY_EPSILON);
  if (!candidates.length) return null;
  return candidates.reduce((best, c) => (area(c) > area(best) ? c : best));
}

/** Usable rectangle: canvas - margins - negative space, inside the largest safe zone, minus the forbidden zones. */
export function computeUsableRect(outputContext, { marginRatio = 0.06, minMargin = 0, negativeSpace = NEGATIVE_SPACE.NONE } = {}) {
  const { canvas, safe_zones: safe, forbidden_zones: forbidden, direction } = outputContext;
  const margin = r3(Math.max(Math.min(canvas.width, canvas.height) * marginRatio, minMargin));
  let rect = { x: margin, y: margin, width: canvas.width - 2 * margin, height: canvas.height - 2 * margin };
  const rtl = direction === TEXT_DIRECTION.RTL;
  const space = enumValue(negativeSpace, NEGATIVE_SPACE, 'negative_space', E.LAYOUT_INPUT_INVALID);
  // negative space is reserved on the named side: TOP / BOTTOM, or the START / END edge (START is the left edge for LTR, the right for RTL)
  const cut = (side, ratio) => {
    if (side === 'TOP') rect = { ...rect, y: rect.y + rect.height * ratio, height: rect.height * (1 - ratio) };
    else if (side === 'BOTTOM') rect = { ...rect, height: rect.height * (1 - ratio) };
    else if ((side === 'START') !== rtl) rect = { ...rect, x: rect.x + rect.width * ratio, width: rect.width * (1 - ratio) };
    else rect = { ...rect, width: rect.width * (1 - ratio) };
  };
  if (space === NEGATIVE_SPACE.SURROUNDING) {
    const extra = Math.min(rect.width, rect.height) * 0.08;
    rect = { x: rect.x + extra, y: rect.y + extra, width: rect.width - 2 * extra, height: rect.height - 2 * extra };
  } else if (space !== NEGATIVE_SPACE.NONE) cut(space, 0.2);
  if (safe.length) {
    const zone = [...safe].sort((a, b) => (area(b) - area(a)) || (a.zone_id < b.zone_id ? -1 : 1))[0];
    rect = intersection(rect, zone);
    if (!rect) fail(E.LAYOUT_UNSATISFIABLE, 'the canvas margins leave nothing inside the safe zone', { field: 'output_context.safe_zones' });
  }
  for (const zone of [...forbidden].sort((a, b) => (a.zone_id < b.zone_id ? -1 : 1))) {
    rect = carve(rect, zone);
    if (!rect) fail(E.LAYOUT_UNSATISFIABLE, 'the forbidden zones leave no usable area', { field: 'output_context.forbidden_zones' });
  }
  if (rect.width < 1 || rect.height < 1) fail(E.LAYOUT_UNSATISFIABLE, 'the usable area is too small', { field: 'output_context' });
  return deepFreeze({ x: r3(rect.x), y: r3(rect.y), width: r3(rect.width), height: r3(rect.height) });
}

const slotBox = (usable, slot, mirror) => {
  const x = mirror ? 1 - slot.x - slot.w : slot.x;
  return { x: r3(usable.x + x * usable.width), y: r3(usable.y + slot.y * usable.height), width: r3(slot.w * usable.width), height: r3(slot.h * usable.height) };
};

function fitInto(box, dims, { align, rtl = false } = {}) {
  if (!['START', 'CENTER', 'END'].includes(align)) fail(E.LAYOUT_INPUT_INVALID, 'a media slot states its alignment (START | CENTER | END): nothing is centred by default', { field: 'slot.align' });
  if (!dims) return { box, aspectKnown: false };
  const scale = Math.min(box.width / dims.width_px, box.height / dims.height_px);
  const width = r3(dims.width_px * scale);
  const height = r3(dims.height_px * scale);
  const left = (align === 'START') !== rtl;
  const x = align === 'CENTER' ? box.x + (box.width - width) / 2 : left ? box.x : box.x + box.width - width;
  return { box: { x: r3(x), y: r3(box.y + (box.height - height) / 2), width, height }, aspectKnown: true };
}

/** Verifies the layer-level and document-level constraints. Returns a (possibly empty) list of violations. */
export function evaluateConstraints({ layers, constraints = [], output_context: ctx }) {
  const byId = new Map(layers.map((l) => [l.id, l]));
  const all = [];
  for (const layer of layers) for (const c of layer.constraints) all.push({ ...c, subject: layer.id });
  for (const c of constraints) all.push(c);
  const violations = [];
  for (const c of all) {
    const subject = byId.get(c.subject);
    const target = c.target ? byId.get(c.target) : null;
    if (!subject) { violations.push({ kind: c.kind, subject: c.subject, target: c.target, reason: 'SUBJECT_MISSING' }); continue; }
    if (subject.visibility === VISIBILITY.HIDDEN) continue;
    if (c.target && !target) { violations.push({ kind: c.kind, subject: c.subject, target: c.target, reason: 'TARGET_MISSING' }); continue; }
    const s = layerBounds(subject);
    const t = target ? layerBounds(target) : null;
    let bad = false;
    switch (c.kind) {
      case CONSTRAINT_KIND.MIN_MARGIN:
        bad = s.x < c.value - GEOMETRY_EPSILON || s.y < c.value - GEOMETRY_EPSILON
          || s.x + s.width > ctx.canvas.width - c.value + GEOMETRY_EPSILON || s.y + s.height > ctx.canvas.height - c.value + GEOMETRY_EPSILON;
        break;
      case CONSTRAINT_KIND.NO_OVERLAP: bad = intersects(s, t, GEOMETRY_EPSILON); break;
      case CONSTRAINT_KIND.ABOVE: bad = s.y + s.height > t.y + GEOMETRY_EPSILON; break;
      case CONSTRAINT_KIND.BELOW: bad = s.y < t.y + t.height - GEOMETRY_EPSILON; break;
      case CONSTRAINT_KIND.ALIGN_CENTER_X: bad = Math.abs((s.x + s.width / 2) - (t.x + t.width / 2)) > 0.5; break;
      case CONSTRAINT_KIND.WITHIN_SAFE_ZONE:
        bad = ctx.safe_zones.length > 0 && !ctx.safe_zones.some((z) => contains(z, s, GEOMETRY_EPSILON));
        break;
      default: bad = true;
    }
    if (bad) violations.push({ kind: c.kind, subject: c.subject, target: c.target, reason: 'CONSTRAINT_NOT_MET' });
  }
  return violations;
}

const slotRoleOf = (layer) => {
  if (layer.type === LAYER_TYPE.PRODUCT) return 'PRODUCT';
  if (layer.type === LAYER_TYPE.LOGO) return 'LOGO';
  if (layer.type === LAYER_TYPE.TEXT) return layer.text_role;
  return null;
};

/**
 * Places the layers of a document into the slots of a recipe. Returns { status, document, placements, unplaced, violations,
 * usable_rect, recipe_id }. `document` is a NEW revision (the input is untouched). `fonts` is a font registry; `assets` maps an
 * asset_ref to its real pixel size ({ width_px, height_px }) so products and logos keep their exact aspect ratio.
 */
export function solveLayout({
  document, recipe_id: recipeId, fonts, assets = {}, negative_space: negativeSpace = NEGATIVE_SPACE.NONE, created_at: createdAt,
} = {}) {
  const recipe = getLayoutRecipe(recipeId);
  if (!recipe) fail(E.LAYOUT_RECIPE_UNKNOWN, 'unknown layout recipe', { field: 'recipe_id' });
  if (!fonts || typeof fonts.get !== 'function') fail(E.LAYOUT_INPUT_INVALID, 'a font registry is required', { field: 'fonts' });
  const at = iso(createdAt, 'created_at');
  for (const [key, dims] of Object.entries(assets)) {
    number(dims?.width_px, `assets.${key}.width_px`, { min: 1, code: E.LAYOUT_INPUT_INVALID });
    number(dims?.height_px, `assets.${key}.height_px`, { min: 1, code: E.LAYOUT_INPUT_INVALID });
  }
  const ctx = document.output_context;
  const rtl = ctx.direction === TEXT_DIRECTION.RTL;
  const minMargin = Math.max(0, ...document.layers.flatMap((l) => l.constraints).filter((c) => c.kind === CONSTRAINT_KIND.MIN_MARGIN).map((c) => c.value));
  const usable = computeUsableRect(ctx, { marginRatio: recipe.margin_ratio, minMargin, negativeSpace });
  const mirror = rtl && recipe.mirror_on_rtl;

  const used = new Set();
  const placements = [];
  const unplaced = [];
  const violations = [];
  const next = [];
  for (const layer of document.layers) {
    const role = slotRoleOf(layer);
    const slot = role ? recipe.slots.find((s) => s.role === role) : null;
    if (!slot) { next.push(layer); if (role) unplaced.push({ layer_id: layer.id, reason: 'NO_SLOT_FOR_ROLE' }); continue; }
    if (layer.locked) { next.push(layer); unplaced.push({ layer_id: layer.id, reason: 'LOCKED' }); continue; }
    if (layer.visibility === VISIBILITY.HIDDEN) { next.push(layer); unplaced.push({ layer_id: layer.id, reason: 'HIDDEN' }); continue; }
    if (used.has(slot.role)) { next.push(layer); unplaced.push({ layer_id: layer.id, reason: 'SLOT_ALREADY_USED' }); continue; }
    used.add(slot.role);
    const box = slotBox(usable, slot, mirror);
    const notes = [];
    if (layer.type === LAYER_TYPE.TEXT) {
      const font = fonts.get(layer.font_ref);
      const geometry = { x: box.x, y: box.y, width: box.width, height: box.height, rotation_deg: 0 };
      if (!font) {
        notes.push('FONT_MISSING');
        next.push({ ...layer, geometry });
        violations.push({ code: 'FONT_MISSING', layers: [layer.id] });
      } else {
        const placed = { ...layer, geometry };
        const fit = fitText(placed, font);
        next.push({ ...placed, font_size: fit.font_size });
        if (!fit.fits) {
          notes.push('TEXT_DOES_NOT_FIT');
          violations.push({ code: 'TEXT_DOES_NOT_FIT', layers: [layer.id], overflow_policy: layer.overflow_policy, reasons: [...fit.reasons] });
        }
      }
    } else {
      const assetRef = layer.type === LAYER_TYPE.PRODUCT ? layer.asset_ref : layer.source_ref;
      const fitted = fitInto(box, assets[assetRef], { align: slot.align, rtl });
      if (!fitted.aspectKnown) notes.push('ASPECT_UNKNOWN');
      next.push({ ...layer, geometry: { ...fitted.box, rotation_deg: 0 } });
    }
    placements.push({ layer_id: layer.id, slot: slot.role, box, notes });
  }

  // verify what the recipe promised: every placed layer inside the usable area, no two placed layers overlapping
  const placedIds = new Set(placements.map((p) => p.layer_id));
  const placedLayers = next.filter((l) => placedIds.has(l.id));
  for (const l of placedLayers) {
    if (!contains(usable, layerBounds(l), GEOMETRY_EPSILON)) violations.push({ code: 'OUTSIDE_USABLE_AREA', layers: [l.id] });
  }
  for (let i = 0; i < placedLayers.length; i += 1) {
    for (let j = i + 1; j < placedLayers.length; j += 1) {
      if (intersects(layerBounds(placedLayers[i]), layerBounds(placedLayers[j]), GEOMETRY_EPSILON)) {
        violations.push({ code: 'LAYERS_OVERLAP', layers: [placedLayers[i].id, placedLayers[j].id] });
      }
    }
  }

  const revised = reviseDesignDocument(document, {
    layers: next,
    created_at: at,
    derivation: 'REFINE',
    created_by: LAYER_ORIGIN.ENGINE,
    producer_refs: ['engine:layout-constraint-engine.v1'],
  });
  for (const v of evaluateConstraints(revised)) violations.push({ code: 'CONSTRAINT_NOT_MET', layers: [v.subject, ...(v.target ? [v.target] : [])], constraint: v.kind });
  return deepFreeze({
    status: violations.length === 0 ? 'SOLVED' : 'UNSATISFIED',
    recipe_id: recipe.recipe_id,
    document: revised,
    usable_rect: usable,
    placements,
    unplaced,
    violations,
  });
}
