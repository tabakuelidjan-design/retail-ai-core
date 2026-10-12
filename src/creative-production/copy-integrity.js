import { createHash } from 'node:crypto';

import { layoutText } from '../creative-intelligence/typography.js';
import { stripSpace, TEXT_LED_SPEC, verifyVerbatim } from '../creative-planning/index.js';
import { deriveId } from '../creative-brain/validation.js';
import { LAYER_KIND, LAYER_SOURCE, LAYER_Z } from './constants.js';

// TEXT INTEGRITY. The text of a layer is the text of the plan, byte for byte. The visual layer never truncates, rewrites, compresses or rearranges copy to make an image fit: when the composition cannot carry the
// planned copy, the answer is a block that asks for replanning.
//   textLayersOf        the TEXT layers of an asset, each holding the exact text, its digest, and the pieces (unit, origin, offsets) it was made of
//   checkTextFeasibility whether the composition can carry the text: measured capacity of the density class, and, when a real font is given, the real typography engine on the REAL text
//   recoverLockedCopy   the locked sources reassembled from the layers and the caption alone, compared with the sources

export const sha256Text = (text) => createHash('sha256').update(String(text), 'utf8').digest('hex');

/** @returns {object[]} the TEXT layers (unsorted by z within the band: slot order) of a content-plan asset. */
export function textLayersOf({ contentAsset, scenePrefix, placementText }) {
  return contentAsset.slots.map((slot, i) => {
    const pieces = slot.pieces.map((p) => ({
      piece_id: p.piece_id, unit_ref: p.unit_ref, origin: p.origin, start: p.start, end: p.end, text_sha256: sha256Text(p.text),
    }));
    const body = {
      kind: LAYER_KIND.TEXT, z: LAYER_Z[LAYER_KIND.TEXT] + i, source: LAYER_SOURCE.DETERMINISTIC_TEXT, role: slot.role, text: slot.text, text_sha256: sha256Text(slot.text), chars: slot.chars, placement: placementText, pieces, scene: scenePrefix,
    };
    return { layer_id: deriveId('lyr', body), ...body };
  });
}

/**
 * Can the composition carry this text as it is? Never changes the text.
 * @param {object} input { slots, density (class), resource, font? }
 * @returns {{ fits, basis, reasons: string[] }}
 */
export function checkTextFeasibility({
  slots, density, resource, font = null, locale = 'en',
}) {
  const reasons = [];
  const caps = resource.text_capacity;
  for (const slot of slots) {
    if (slot.role !== 'BODY') { if (slot.chars > (caps[slot.role]?.chars ?? 0)) reasons.push(`${slot.role}_OVER_ITS_MEASURED_CAPACITY`); continue; }
    const cap = resource.slide_capacity[density === 'LOW' ? 'MEDIUM' : density]?.chars ?? 0;
    if (slot.chars > resource.slide_capacity.TEXT_LED.chars) reasons.push('BODY_OVER_THE_TEXT_LED_CAPACITY');
    else if (slot.chars > cap) reasons.push('BODY_OVER_ITS_DENSITY_CLASS');
    if (font) {
      // the real text, in the real font, in the text region of its class
      const share = TEXT_LED_SPEC.region_height_share[density === 'LOW' ? 'MEDIUM' : density];
      const layer = {
        content: slot.text, geometry: { x: 0, y: 0, width: resource.canvas.width * (1 - 2 * TEXT_LED_SPEC.margin_x_of_width), height: resource.canvas.height * share, rotation_deg: 0 }, box: { padding: 0 },
        line_height: TEXT_LED_SPEC.line_height, tracking: TEXT_LED_SPEC.tracking, direction: 'LTR', locale, max_lines: 100000,
      };
      const laid = layoutText(layer, font, Math.round(resource.canvas.width * TEXT_LED_SPEC.font_size_of_width));
      if (!laid.fits) reasons.push(`BODY_DOES_NOT_FIT_THE_REGION_IN_THE_REAL_FONT:${laid.reasons.join('+')}`);
      if (laid.missing_glyphs?.length) reasons.push('BODY_HAS_A_GLYPH_THE_FONT_DOES_NOT_HAVE');
    }
  }
  return { fits: reasons.length === 0, basis: font ? 'REAL_TYPOGRAPHY_ON_THE_REAL_TEXT' : 'MEASURED_CAPACITY_ONLY', reasons };
}

/** The sources a campaign was made from, rebuilt from the layers and the caption: for each source the pieces in order, with the exact whitespace the source had between them. */
export function reassemble(source, pieces) {
  const ordered = [...pieces].sort((a, b) => a.start - b.start);
  let out = ''; let cursor = null;
  for (const p of ordered) {
    out += cursor === null ? '' : source.slice(cursor, p.start);
    out += source.slice(p.start, p.end);
    cursor = p.end;
  }
  return out;
}

/**
 * Locked copy must be recoverable: every LOCKED piece in the text layers and the caption is the exact slice of its source, the slices of a source are disjoint, ordered and complete, and the source is rebuilt
 * identically from them.
 * @param {object} input { scenes (the text layers), caption (pieces or null), sources: Map<unit_ref, text> }
 * @returns {{ ok, problems: string[], recovered: Map }}
 */
export function recoverLockedCopy({ layers, captionPieces = [], sources }) {
  const problems = [];
  const byUnit = new Map();
  for (const l of layers) for (const p of l.pieces) if (p.origin === 'LOCKED') { if (!byUnit.has(p.unit_ref)) byUnit.set(p.unit_ref, []); byUnit.get(p.unit_ref).push({ ...p, text: null }); }
  for (const p of captionPieces) if (p.origin === 'LOCKED') { if (!byUnit.has(p.unit_ref)) byUnit.set(p.unit_ref, []); byUnit.get(p.unit_ref).push({ piece_id: p.piece_id, unit_ref: p.unit_ref, origin: p.origin, start: p.start, end: p.end, text_sha256: p.text_sha256 ?? sha256Text(p.text), text: p.text }); }
  const recovered = new Map();
  for (const [ref, pieces] of byUnit) {
    const source = sources.get(ref);
    if (source == null) { problems.push(`NO_SOURCE:${ref}`); continue; }
    const slices = pieces.map((p) => ({ start: p.start, end: p.end })).sort((a, b) => a.start - b.start);
    if (!verifyVerbatim(source, slices)) problems.push(`NOT_VERBATIM:${ref}`);
    for (const p of pieces) if (sha256Text(source.slice(p.start, p.end).trim()) !== p.text_sha256) problems.push(`PIECE_DIFFERS_FROM_ITS_SOURCE:${p.piece_id}`);
    const rebuilt = reassemble(source, pieces);
    recovered.set(ref, rebuilt);
    if (stripSpace(rebuilt) !== stripSpace(source)) problems.push(`NOT_COMPLETE:${ref}`);
  }
  return { ok: problems.length === 0, problems, recovered };
}

/** Does the text of a layer follow from its pieces (and the pieces from the plan)? The text of a layer is never anything but the pieces joined. */
export function layerTextFollowsFromPlan(layer, contentSlot) {
  return layer.text === contentSlot.text && layer.text_sha256 === sha256Text(contentSlot.text) && layer.pieces.length === contentSlot.pieces.length
    && layer.pieces.every((p, i) => p.piece_id === contentSlot.pieces[i].piece_id && p.text_sha256 === sha256Text(contentSlot.pieces[i].text));
}
