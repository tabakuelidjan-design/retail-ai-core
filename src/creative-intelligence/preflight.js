// Creative Preflight V1: deterministic, explainable quality gates for a DesignDocument. No LLM, no beauty score.
//
// Outcome per check and overall: PASS / REVIEW_REQUIRED / FAIL / NOT_MEASURABLE. Overall precedence: FAIL > REVIEW_REQUIRED >
// NOT_MEASURABLE > PASS - a check that could not be measured is never reported as a pass. The report is a pure function of
// (document, explicit context): it is re-derivable, so a stored report is never an authority (the selector recomputes it).
//
// Context (all explicit): fonts (registry), assets ({ asset_ref: { width_px, height_px } } catalogue), approved_claim_refs, approved_texts
// ({ claim_ref: digest of the approved wording }). Whatever the context does not provide stays NOT_MEASURABLE.

import {
  ASPECT_TOLERANCE, CI_ERROR as E, CI_VERSION, CONTRAST_MIN, CONTRAST_MIN_LARGE, EFFECT_KIND, GEOMETRY_EPSILON, LARGE_TEXT_PX, LAYER_TYPE,
  PREFLIGHT_CHECK as C, PREFLIGHT_STATUS as S, TEXT_KIND, VISIBILITY,
} from './constants.js';
import { normalizeDesignDocument, layerAssetRefs } from './design-document.js';
import { evaluateConstraints } from './layout-engine.js';
import { layerBounds } from './layers.js';
import { layoutText, positionLines, scriptsOf } from './typography.js';
import {
  closedObject, contains, deepFreeze, deriveId, fail, hexColor, intersects, number, refList,
} from './validation.js';

const STATUS_RANK = { PASS: 0, NOT_MEASURABLE: 1, REVIEW_REQUIRED: 2, FAIL: 3 };
const worst = (statuses) => statuses.reduce((a, b) => (STATUS_RANK[b] > STATUS_RANK[a] ? b : a), S.PASS);
const sortedUnique = (a) => [...new Set(a)].sort();

// ---- contrast (WCAG 2.x relative luminance)
const channel = (v) => { const c = v / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
export function relativeLuminance(hex) {
  const n = parseInt(hex.slice(1), 16);
  return 0.2126 * channel((n >> 16) & 255) + 0.7152 * channel((n >> 8) & 255) + 0.0722 * channel(n & 255);
}
export function contrastRatio(a, b) {
  const [hi, lo] = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

function normalizeContext(context) {
  closedObject(context ?? {}, ['fonts', 'assets', 'approved_claim_refs', 'approved_texts', 'measured_backdrops'], 'preflight_context', E.LAYOUT_INPUT_INVALID);
  const c = context ?? {};
  if (c.fonts != null && typeof c.fonts.get !== 'function') fail(E.LAYOUT_INPUT_INVALID, 'preflight_context.fonts must be a font registry', { field: 'fonts' });
  let assets = null;
  if (c.assets != null) {
    assets = {};
    for (const [key, dims] of Object.entries(c.assets)) {
      assets[key] = {
        width_px: number(dims?.width_px, `assets.${key}.width_px`, { min: 1, code: E.LAYOUT_INPUT_INVALID }),
        height_px: number(dims?.height_px, `assets.${key}.height_px`, { min: 1, code: E.LAYOUT_INPUT_INVALID }),
      };
    }
  }
  const approvedTexts = c.approved_texts == null ? null : { ...c.approved_texts };
  // measured_backdrops: { [text layer id]: [#RRGGBB, ...] } - colours MEASURED from the pixels behind a text (e.g. quantiles of an image background); the contrast check takes the worst of them
  const measuredBackdrops = {};
  for (const [id, colors] of Object.entries(c.measured_backdrops ?? {})) {
    if (!Array.isArray(colors) || colors.length === 0 || colors.length > 16) fail(E.LAYOUT_INPUT_INVALID, `measured_backdrops.${id} must list 1..16 colours`, { field: 'measured_backdrops' });
    measuredBackdrops[id] = colors.map((hex, i) => hexColor(hex, `measured_backdrops.${id}[${i}]`));
  }
  return {
    measuredBackdrops,
    fonts: c.fonts ?? null,
    assets,
    approvedClaims: c.approved_claim_refs == null ? null : refList(c.approved_claim_refs, 'approved_claim_refs'),
    approvedTexts,
  };
}

/** The rectangle a layer really occupies: the measured ink of a text, the box of anything else (or of a text that cannot be measured). */
function occupied(layer, fonts) {
  if (layer.type !== LAYER_TYPE.TEXT) return { rect: layerBounds(layer), measured: true };
  const font = fonts?.get(layer.font_ref);
  if (!font) return { rect: layerBounds(layer), measured: false };
  const laid = layoutText(layer, font, layer.font_size);
  if (!laid.measurable || laid.lines.length === 0) return { rect: layerBounds(layer), measured: false };
  return { rect: positionLines(layer, font, laid).ink, measured: true };
}

function result(code, failed, { review = [], unmeasurable = [], reasons = [], remediation = {} } = {}) {
  const status = failed.length ? S.FAIL : review.length ? S.REVIEW_REQUIRED : unmeasurable.length ? S.NOT_MEASURABLE : S.PASS;
  return {
    code,
    status,
    layer_refs: sortedUnique([...failed, ...review, ...unmeasurable]),
    reason_codes: status === S.PASS ? ['OK'] : sortedUnique(reasons.length ? reasons : [status]),
    remediation: Object.fromEntries(Object.entries(remediation).sort(([a], [b]) => (a < b ? -1 : 1))),
  };
}
const notApplicable = (code) => ({ code, status: S.PASS, layer_refs: [], reason_codes: ['NOT_APPLICABLE'], remediation: {} });

/** Runs every check. Returns a deep-frozen PreflightReport; never throws for a creative problem (it reports it). */
export function runCreativePreflight(documentInput, contextInput = {}) {
  const doc = normalizeDesignDocument(documentInput);
  const ctx = normalizeContext(contextInput);
  const { fonts } = ctx;
  const hidden = new Set(doc.layers.filter((l) => l.visibility === VISIBILITY.HIDDEN).map((l) => l.id));
  for (const g of doc.layers.filter((l) => l.type === LAYER_TYPE.GROUP && l.visibility === VISIBILITY.HIDDEN)) g.members.forEach((m) => hidden.add(m));
  const visible = doc.layers.filter((l) => !hidden.has(l.id) && l.type !== LAYER_TYPE.GROUP);
  const texts = visible.filter((l) => l.type === LAYER_TYPE.TEXT);
  const products = visible.filter((l) => l.type === LAYER_TYPE.PRODUCT);
  const logos = visible.filter((l) => l.type === LAYER_TYPE.LOGO);
  const { safe_zones: safeZones, forbidden_zones: forbiddenZones } = doc.output_context;
  const checks = [];

  // 1 TEXT_OVERFLOW (the text as written, at its own size: nothing is shrunk, truncated or rewritten here)
  {
    const failed = []; const unmeasurable = []; const remediation = {}; const reasons = [];
    for (const t of texts) {
      const font = fonts?.get(t.font_ref);
      if (!font) { unmeasurable.push(t.id); reasons.push('FONT_NOT_AVAILABLE'); continue; }
      const laid = layoutText(t, font, t.font_size);
      if (!laid.measurable) { unmeasurable.push(t.id); reasons.push('SHAPING_NOT_MEASURABLE'); continue; }
      if (!laid.fits) { failed.push(t.id); remediation[t.id] = t.overflow_policy; reasons.push(...laid.reasons); }
    }
    checks.push(texts.length ? result(C.TEXT_OVERFLOW, failed, { unmeasurable, reasons, remediation }) : notApplicable(C.TEXT_OVERFLOW));
  }
  // 2 TEXT_BELOW_MIN_SIZE
  {
    const failed = texts.filter((t) => t.font_size < t.min_font_size - 1e-9).map((t) => t.id);
    checks.push(texts.length ? result(C.TEXT_BELOW_MIN_SIZE, failed, { reasons: failed.length ? ['FONT_SIZE_BELOW_MINIMUM'] : [] }) : notApplicable(C.TEXT_BELOW_MIN_SIZE));
  }
  // 3 LAYER_OUT_OF_BOUNDS (a background may bleed)
  {
    const canvas = { x: 0, y: 0, width: doc.canvas.width, height: doc.canvas.height };
    const failed = visible.filter((l) => l.type !== LAYER_TYPE.BACKGROUND && !contains(canvas, layerBounds(l), GEOMETRY_EPSILON)).map((l) => l.id);
    checks.push(result(C.LAYER_OUT_OF_BOUNDS, failed, { reasons: failed.length ? ['OUTSIDE_CANVAS'] : [] }));
  }
  // 4 SAFE_ZONE_VIOLATION / 5 FORBIDDEN_ZONE_OVERLAP (what must stay visible: text, logo, product)
  const critical = [...texts, ...logos, ...products];
  const rects = new Map(critical.map((l) => [l.id, occupied(l, fonts)]));
  if (safeZones.length === 0) checks.push(notApplicable(C.SAFE_ZONE_VIOLATION));
  else {
    const failed = critical.filter((l) => !safeZones.some((z) => contains(z, rects.get(l.id).rect, GEOMETRY_EPSILON))).map((l) => l.id);
    const boxOnly = critical.filter((l) => !rects.get(l.id).measured && !failed.includes(l.id)).map((l) => l.id);
    checks.push(result(C.SAFE_ZONE_VIOLATION, failed, { review: boxOnly, reasons: [...(failed.length ? ['OUTSIDE_SAFE_ZONE'] : []), ...(boxOnly.length ? ['TEXT_NOT_MEASURED_BOX_USED'] : [])] }));
  }
  if (forbiddenZones.length === 0) checks.push(notApplicable(C.FORBIDDEN_ZONE_OVERLAP));
  else {
    const failed = critical.filter((l) => forbiddenZones.some((z) => intersects(z, rects.get(l.id).rect, GEOMETRY_EPSILON))).map((l) => l.id);
    checks.push(result(C.FORBIDDEN_ZONE_OVERLAP, failed, { reasons: failed.length ? ['OVERLAPS_FORBIDDEN_ZONE'] : [] }));
  }
  // 6 PRODUCT_TEXT_COLLISION
  {
    const failed = []; const review = [];
    for (const p of products) {
      for (const t of texts) {
        const { rect, measured } = rects.get(t.id);
        if (intersects(layerBounds(p), rect, GEOMETRY_EPSILON)) (measured ? failed : review).push(p.id, t.id);
      }
    }
    checks.push(products.length && texts.length ? result(C.PRODUCT_TEXT_COLLISION, failed, { review, reasons: [...(failed.length ? ['PRODUCT_OVERLAPS_TEXT'] : []), ...(review.length ? ['TEXT_NOT_MEASURED_BOX_USED'] : [])] }) : notApplicable(C.PRODUCT_TEXT_COLLISION));
  }
  // 7 MISSING_ASSET_REF
  {
    const declared = new Set(doc.asset_refs);
    const failed = []; const reasons = [];
    for (const l of visible) {
      for (const a of layerAssetRefs(l)) {
        if (!declared.has(a)) { failed.push(l.id); reasons.push('ASSET_NOT_DECLARED'); }
        else if (ctx.assets && !ctx.assets[a]) { failed.push(l.id); reasons.push('ASSET_NOT_IN_CATALOGUE'); }
      }
    }
    checks.push(result(C.MISSING_ASSET_REF, failed, { reasons }));
  }
  // 8 MISSING_FONT_REF (no registry at all = not measurable, a missing entry = fail)
  {
    if (!texts.length) checks.push(notApplicable(C.MISSING_FONT_REF));
    else if (!fonts) checks.push(result(C.MISSING_FONT_REF, [], { unmeasurable: texts.map((t) => t.id), reasons: ['NO_FONT_REGISTRY'] }));
    else checks.push(result(C.MISSING_FONT_REF, texts.filter((t) => !fonts.has(t.font_ref)).map((t) => t.id), { reasons: ['FONT_NOT_REGISTERED'] }));
  }
  // 9 MISSING_CLAIM_REF (without the approved set the claims can only be checked against the document itself: NOT_MEASURABLE, never PASS)
  {
    const bearing = texts.filter((t) => t.text_kind === TEXT_KIND.CLAIM_BEARING);
    if (!bearing.length) checks.push(notApplicable(C.MISSING_CLAIM_REF));
    else {
      const declared = new Set(doc.claim_refs);
      const approved = ctx.approvedClaims ? new Set(ctx.approvedClaims) : null;
      const failed = []; const reasons = [];
      for (const t of bearing) {
        if (!declared.has(t.claim_ref)) { failed.push(t.id); reasons.push('CLAIM_NOT_DECLARED'); }
        else if (approved && !approved.has(t.claim_ref)) { failed.push(t.id); reasons.push('CLAIM_NOT_APPROVED'); }
      }
      if (approved && doc.claim_refs.some((c) => !approved.has(c))) { failed.push(...bearing.map((t) => t.id)); reasons.push('DECLARED_CLAIM_NOT_APPROVED'); }
      checks.push(result(C.MISSING_CLAIM_REF, failed, {
        unmeasurable: approved ? [] : bearing.map((t) => t.id),
        reasons: failed.length ? reasons : (approved ? [] : ['APPROVED_CLAIMS_NOT_PROVIDED']),
      }));
    }
  }
  // 10 DUPLICATE_LAYER_ID
  {
    const seen = new Set(); const dup = new Set();
    for (const l of doc.layers) { if (seen.has(l.id)) dup.add(l.id); seen.add(l.id); }
    checks.push(result(C.DUPLICATE_LAYER_ID, [...dup], { reasons: dup.size ? ['LAYER_ID_REPEATED'] : [] }));
  }
  // 11 INVALID_Z_ORDER
  {
    const failed = []; const reasons = [];
    const byZ = new Map();
    for (const l of visible) byZ.set(l.z_index, [...(byZ.get(l.z_index) ?? []), l.id]);
    for (const ids of byZ.values()) if (ids.length > 1) { failed.push(...ids); reasons.push('SHARED_Z_INDEX'); }
    const maxContent = Math.max(-Infinity, ...visible.filter((l) => l.type !== LAYER_TYPE.BACKGROUND).map((l) => l.z_index));
    for (const bg of visible.filter((l) => l.type === LAYER_TYPE.BACKGROUND)) if (bg.z_index > maxContent && maxContent !== -Infinity) { failed.push(bg.id); reasons.push('BACKGROUND_ABOVE_CONTENT'); }
    checks.push(result(C.INVALID_Z_ORDER, failed, { reasons }));
  }
  // 12 INSUFFICIENT_CONTRAST (only where the backdrop is a solid colour)
  {
    const failed = []; const unmeasurable = []; const reasons = [];
    for (const t of texts) {
      const { rect } = rects.get(t.id);
      const under = visible.filter((l) => l.z_index < t.z_index && intersects(layerBounds(l), rect, GEOMETRY_EPSILON));
      const solid = (l) => (l.type === LAYER_TYPE.BACKGROUND ? l.fill : l.type === LAYER_TYPE.SHAPE ? l.fill : null);
      const opaque = (l) => !l.effects.some((e) => e.kind === EFFECT_KIND.OPACITY);
      let backdrop = doc.canvas.background_color;
      let measurable = true;
      if (under.some((l) => !(solid(l) && opaque(l)) && l.type !== LAYER_TYPE.GROUP)) measurable = false;
      else if (under.length) {
        const top = [...under].sort((a, b) => b.z_index - a.z_index)[0];
        if (!contains(layerBounds(top), rect, GEOMETRY_EPSILON) && under.length > 1) measurable = false;
        backdrop = solid(top);
      }
      if (!measurable) {
        // an image backdrop is judged only on colours measured from its pixels (the worst of them); without them it is NOT_MEASURABLE, never assumed
        const sampled = ctx.measuredBackdrops[t.id];
        if (!sampled) { unmeasurable.push(t.id); reasons.push('BACKDROP_NOT_SOLID'); continue; }
        const needSampled = t.font_size >= LARGE_TEXT_PX ? CONTRAST_MIN_LARGE : CONTRAST_MIN;
        if (Math.min(...sampled.map((b) => contrastRatio(t.color, b))) < needSampled) { failed.push(t.id); reasons.push('CONTRAST_BELOW_MINIMUM'); }
        continue;
      }
      const need = t.font_size >= LARGE_TEXT_PX ? CONTRAST_MIN_LARGE : CONTRAST_MIN;
      if (contrastRatio(t.color, backdrop) < need) { failed.push(t.id); reasons.push('CONTRAST_BELOW_MINIMUM'); }
    }
    checks.push(texts.length ? result(C.INSUFFICIENT_CONTRAST, failed, { unmeasurable, reasons }) : notApplicable(C.INSUFFICIENT_CONTRAST));
  }
  // 13 OUTPUT_DIMENSION_MISMATCH
  {
    const o = doc.output_context.canvas;
    const bad = o.width !== doc.canvas.width || o.height !== doc.canvas.height;
    checks.push(result(C.OUTPUT_DIMENSION_MISMATCH, bad ? ['canvas'] : [], { reasons: bad ? ['CANVAS_DIFFERS_FROM_OUTPUT_CONTEXT'] : [] }));
  }
  // ---- additional integrity checks
  {
    const failed = []; const reasons = [];
    for (const t of texts.filter((x) => x.text_kind === TEXT_KIND.CLAIM_BEARING)) {
      const approved = ctx.approvedTexts?.[t.claim_ref];
      if (approved !== undefined && approved !== t.approved_digest) { failed.push(t.id); reasons.push('TEXT_DIFFERS_FROM_APPROVED_WORDING'); }
    }
    checks.push(result(C.TEXT_CONTENT_CHANGED, failed, { reasons }));
  }
  {
    const failed = [];
    for (const t of texts) {
      const font = fonts?.get(t.font_ref);
      if (font && (font.engine ? font.engine.missingChars(t.content).length > 0 : scriptsOf(t.content).some((s) => !font.scripts.includes(s)))) failed.push(t.id);
    }
    checks.push(result(C.FONT_SCRIPT_UNSUPPORTED, failed, { reasons: failed.length ? ['SCRIPT_NOT_COVERED_BY_FONT'] : [] }));
  }
  {
    const review = []; const unmeasurable = [];
    for (const l of [...products, ...logos]) {
      const dims = ctx.assets?.[l.type === LAYER_TYPE.PRODUCT ? l.asset_ref : l.source_ref];
      if (!dims) { unmeasurable.push(l.id); continue; }
      const boxRatio = l.geometry.width / l.geometry.height;
      const assetRatio = dims.width_px / dims.height_px;
      if (Math.abs(boxRatio - assetRatio) / assetRatio > ASPECT_TOLERANCE) review.push(l.id);
    }
    checks.push(products.length + logos.length ? result(C.PRODUCT_ASPECT_MISMATCH, [], { review, unmeasurable, reasons: [...(review.length ? ['BOX_ASPECT_DIFFERS_RENDERER_LETTERBOXES'] : []), ...(unmeasurable.length ? ['ASSET_DIMENSIONS_UNKNOWN'] : [])] }) : notApplicable(C.PRODUCT_ASPECT_MISMATCH));
  }
  {
    const ids = new Set(doc.layers.map((l) => l.id));
    const failed = doc.layers.filter((l) => l.type === LAYER_TYPE.GROUP && l.members.some((m) => !ids.has(m))).map((l) => l.id);
    checks.push(result(C.GROUP_MEMBER_MISSING, failed, { reasons: failed.length ? ['MEMBER_NOT_FOUND'] : [] }));
  }
  {
    const violations = evaluateConstraints({ layers: visible, constraints: doc.constraints, output_context: doc.output_context });
    checks.push(result(C.CONSTRAINT_VIOLATION, sortedUnique(violations.flatMap((v) => [v.subject, ...(v.target ? [v.target] : [])])), { reasons: violations.map((v) => v.kind) }));
  }
  {
    const failed = []; const pairs = [...texts.flatMap((t, i) => texts.slice(i + 1).map((u) => [t, u])), ...logos.flatMap((g) => texts.map((t) => [g, t]))];
    for (const [a, b] of pairs) {
      const ra = occupied(a, fonts); const rb = occupied(b, fonts);
      if (intersects(ra.rect, rb.rect, GEOMETRY_EPSILON)) failed.push(a.id, b.id);
    }
    checks.push(texts.length > 1 || (logos.length && texts.length) ? result(C.TEXT_LAYER_OVERLAP, failed, { reasons: failed.length ? ['TEXT_OR_LOGO_OVERLAP'] : [] }) : notApplicable(C.TEXT_LAYER_OVERLAP));
  }

  const body = {
    schema_version: CI_VERSION,
    document_ref: doc.document_id,
    status: worst(checks.map((c) => c.status)),
    checks,
    context_provided: {
      fonts: ctx.fonts != null, assets: ctx.assets != null, approved_claim_refs: ctx.approvedClaims != null, approved_texts: ctx.approvedTexts != null,
    },
  };
  return deepFreeze({ report_id: deriveId('cpr', body), ...body });
}
