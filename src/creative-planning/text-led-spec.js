import { layoutText } from '../creative-intelligence/typography.js';
import { TYPE_SCALE } from '../creative-runtime/layout-plan.js';

// THE TEXT-LED SLIDE SPEC. A slide whose message is its text needs a layout the single-image recipes do not have: a text region sized to the slide's density class. This is that layout as DATA: where the text
// goes (a margin, a share of the canvas height) and at what size (the BODY size of the type scale). It is deterministic and has no recipe yet (Phase 3 builds the layered production), but it is measured with
// the REAL typography engine, so a capacity stated from it is a measurement and not a guess.
//
//   MEDIUM     a short supporting paragraph beside a strong image
//   HIGH       a paragraph that shares the slide with the image
//   TEXT_LED   the text is the slide
// LOW is not a body class: a slide that deliberately says little uses the headline and subheadline roles, whose capacity is measured by the layout recipes themselves.

export const TEXT_LED_SPEC = Object.freeze({
  margin_x_of_width: 0.08,
  line_height: 1.3,
  tracking: 0,
  region_height_share: Object.freeze({ MEDIUM: 0.28, HIGH: 0.45, TEXT_LED: 0.62 }),
  font_size_of_width: TYPE_SCALE.initial_size_of_canvas_width.BODY,
  /** a capacity is stated with this margin below the measured maximum, so a font with wider letters or a longer word does not tip a slide over */
  safety_factor: 0.8,
});
const FILLER_WORDS = ['alpha', 'bravo', 'delta', 'ecole', 'fruit', 'glace'];
const filler = (chars) => { let t = ''; let i = 0; while (t.length < chars) { t += (t ? ' ' : '') + FILLER_WORDS[i % FILLER_WORDS.length]; i += 1; } return t.slice(0, chars).trim(); };

/** Does a text of this many characters (typical words of five letters) fit the text region of a density class on a canvas, in this real font? */
export function fitsSlide({ font, canvas, density, chars }) {
  const spec = TEXT_LED_SPEC;
  const width = canvas.width * (1 - 2 * spec.margin_x_of_width);
  const height = canvas.height * spec.region_height_share[density];
  const layer = {
    content: filler(chars), geometry: { x: 0, y: 0, width, height, rotation_deg: 0 }, box: { padding: 0 }, line_height: spec.line_height, tracking: spec.tracking, direction: 'LTR', locale: 'en', max_lines: 100000,
  };
  return layoutText(layer, font, Math.round(canvas.width * spec.font_size_of_width)).fits;
}

/** The largest number of characters that fits (measured, before the safety factor). */
export function measureSlideCapacity({ font, canvas, density }) {
  let low = 0; let high = 8192;
  while (low < high) { const mid = Math.ceil((low + high) / 2); if (fitsSlide({ font, canvas, density, chars: mid })) low = mid; else high = mid - 1; }
  return low;
}
