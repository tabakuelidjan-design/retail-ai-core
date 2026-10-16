// HABB templates (client-zero configuration of the generic composer), version 2 (v1 is in git history and in the review dossier).
// Brand rules applied here, never in compose.js: palette navy / terracotta / cream / sand + white; Playfair Display (headlines) and Montserrat (text, figures) only;
// no decoration (no hearts, leaves, gold, glow, gradients, shadows); the product is placed whole (contain), never cropped, never covered by text;
// safe zones keep the content clear of the Instagram interface. Each builder returns a spec for composeCreative(); the copy arrives already approved,
// line breaks are the caller's choice, and every line is locked.
// v2 (after the audit): body text 34 px minimum (was 30), heavier Montserrat strokes, one vertical rhythm per template, the price set in Montserrat
// (Playfair's old-style figures made "25" look uneven), "exemple de rendu" moved under the product instead of inside the text column.

export const TEMPLATE_VERSION = 2;
export const HABB_PALETTE = Object.freeze(['#0f2a52', '#183247', '#c0392b', '#c56e54', '#fbf8f3', '#efe9e1', '#ffffff']);
const NAVY = '#0f2a52'; const WHITE = '#ffffff'; const CREAM = '#fbf8f3'; const TERRA = '#c0392b'; const NAVY2 = '#183247';

const text = (id, lines, x, y, size, lineHeight, { family = 'Playfair Display', weight = 400, fill = NAVY, spacing = 0, anchor = 'start' } = {}) => ({ type: 'text', id, lines, x, y, size, lineHeight, family, weight, fill, spacing, anchor });
const joined = (layers) => layers.filter((l) => l.type === 'text').map((l) => l.lines.join(' '));

export const FORMAT_SAFE = Object.freeze({
  feed: { width: 1080, height: 1350, safe: { top: 90, right: 90, bottom: 90, left: 90 } },
  story: { width: 1080, height: 1920, safe: { top: 250, right: 90, bottom: 250, left: 90 } },
});
const MIN_TEXT = 34;

/** Feed post: dark page, product alone on a white panel on the right, left column of text. copy: { headline[], price[], note[], example[], cta[], address[] } */
export function productPost({ id, copy, productKey, wordmarkKey }) {
  const f = FORMAT_SAFE.feed;
  const layers = [
    { type: 'rect', id: 'panel', x: 590, y: 0, width: 490, height: 1350, fill: WHITE },
    { type: 'image', id: 'brand', key: wordmarkKey, crop: 'ink', box: { x: 90, y: 100, width: 220, height: 60 } },
    { type: 'image', id: 'product', key: productKey, box: { x: 630, y: 110, width: 410, height: 1080 } },
    text('headline', copy.headline, 90, 450, 86, 100, { fill: CREAM }),
    text('price', copy.price, 90, 700, 104, 104, { family: 'Montserrat', weight: 600, fill: CREAM }),
    text('note', copy.note, 90, 790, MIN_TEXT, 50, { family: 'Montserrat', weight: 500, fill: CREAM }),
    text('example', copy.example, 630, 1232, MIN_TEXT, 44, { family: 'Montserrat', weight: 500, fill: NAVY2 }),
    text('cta', copy.cta, 90, 1040, 42, 56, { family: 'Montserrat', weight: 600, fill: CREAM }),
    text('address', copy.address, 90, 1180, MIN_TEXT, 46, { family: 'Montserrat', weight: 500, fill: CREAM, spacing: 1.5 }),
  ];
  return { id, template_version: TEMPLATE_VERSION, canvas: { width: f.width, height: f.height, background: NAVY2 }, safe: f.safe, min_text_px: MIN_TEXT, locked_copy: joined(layers), layers };
}

/** Story: white page, two lines of headline, the product large, one price line, a two-line caveat, one invitation. copy: { headline[], product_line[], caveat[], cta[] } */
export function storyPromo({ id, copy, productKey, wordmarkKey }) {
  const f = FORMAT_SAFE.story;
  const layers = [
    { type: 'image', id: 'brand', key: wordmarkKey, crop: 'ink', box: { x: 90, y: 260, width: 220, height: 60 } },
    text('headline', copy.headline, 90, 480, 100, 110),
    { type: 'image', id: 'product', key: productKey, box: { x: 90, y: 630, width: 900, height: 760 } },
    text('product_line', copy.product_line, 540, 1470, 48, 60, { family: 'Montserrat', weight: 600, anchor: 'middle' }),
    text('caveat', copy.caveat, 540, 1530, MIN_TEXT, 46, { family: 'Montserrat', weight: 500, anchor: 'middle' }),
    text('cta', copy.cta, 540, 1650, 44, 56, { fill: TERRA, family: 'Montserrat', weight: 600, anchor: 'middle' }),
  ];
  return { id, template_version: TEMPLATE_VERSION, canvas: { width: f.width, height: f.height, background: WHITE }, safe: f.safe, min_text_px: MIN_TEXT, locked_copy: joined(layers), layers };
}

/** Feed know-how piece: headline, three real products side by side each with its own label, one closing line. copy: { headline[], labels[3], closing[] } */
export function knowHowTriptych({ id, copy, productKeys, wordmarkKey }) {
  const f = FORMAT_SAFE.feed;
  const xs = [90, 410, 730];
  const layers = [
    { type: 'image', id: 'brand', key: wordmarkKey, crop: 'ink', box: { x: 90, y: 100, width: 220, height: 60 } },
    text('headline', copy.headline, 90, 290, 78, 92),
    ...productKeys.map((key, i) => ({ type: 'image', id: `product_${i + 1}`, key, box: { x: xs[i], y: 410, width: 260, height: 570 } })),
    ...copy.labels.map((label, i) => text(`label_${i + 1}`, [label], xs[i] + 130, 1040, MIN_TEXT, 46, { family: 'Montserrat', weight: 600, anchor: 'middle' })),
    { type: 'rect', id: 'rule', x: 90, y: 1085, width: 96, height: 4, fill: TERRA },
    text('closing', copy.closing, 90, 1150, 40, 54, { family: 'Montserrat', weight: 600 }),
  ];
  return { id, template_version: TEMPLATE_VERSION, canvas: { width: f.width, height: f.height, background: WHITE }, safe: f.safe, min_text_px: MIN_TEXT, locked_copy: joined(layers), layers };
}
