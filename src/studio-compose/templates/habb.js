// HABB templates (client-zero configuration of the generic composer). Brand rules applied here, never in compose.js:
// palette navy / terracotta / cream / sand + white; Playfair Display (headlines) and Montserrat (text) only; no decoration (no hearts, leaves, gold, glow, gradients, shadows);
// the product is placed whole (contain), never cropped, never covered by text; safe zones keep the content clear of the Instagram interface.
// Each builder returns a spec for composeCreative(); the copy arrives already approved, line breaks are the caller's choice, and every line is locked.

export const HABB_PALETTE = Object.freeze(['#0f2a52', '#183247', '#c0392b', '#c56e54', '#fbf8f3', '#efe9e1', '#ffffff']);
const NAVY = '#0f2a52'; const WHITE = '#ffffff'; const CREAM = '#fbf8f3'; const TERRA = '#c0392b';

const text = (id, lines, x, y, size, lineHeight, { family = 'Playfair Display', weight = 400, fill = NAVY, spacing = 0, anchor = 'start' } = {}) => ({ type: 'text', id, lines, x, y, size, lineHeight, family, weight, fill, spacing, anchor });
const joined = (layers) => layers.filter((l) => l.type === 'text').map((l) => l.lines.join(' '));

export const FORMAT_SAFE = Object.freeze({
  feed: { width: 1080, height: 1350, safe: { top: 90, right: 90, bottom: 90, left: 90 } },
  story: { width: 1080, height: 1920, safe: { top: 250, right: 90, bottom: 250, left: 90 } },
});

/** Feed post: navy page, product alone on a white panel on the right, left column of text. copy: { headline[], price[], note[], example[], cta[], address[] } */
export function productPost({ id, copy, productKey, wordmarkKey }) {
  const f = FORMAT_SAFE.feed;
  const layers = [
    { type: 'rect', id: 'panel', x: 590, y: 0, width: 490, height: 1350, fill: WHITE },
    { type: 'image', id: 'brand', key: wordmarkKey, crop: 'ink', box: { x: 90, y: 100, width: 220, height: 60 } },
    { type: 'image', id: 'product', key: productKey, box: { x: 630, y: 120, width: 410, height: 1110 } },
    text('headline', copy.headline, 90, 470, 84, 98, { fill: CREAM }),
    text('price', copy.price, 90, 730, 118, 118, { fill: CREAM }),
    text('note', copy.note, 90, 810, 30, 46, { family: 'Montserrat', weight: 500, fill: CREAM }),
    text('example', copy.example, 90, 996, 30, 42, { family: 'Montserrat', weight: 500, fill: CREAM }),
    text('cta', copy.cta, 90, 1060, 40, 54, { family: 'Montserrat', weight: 600, fill: CREAM }),
    text('address', copy.address, 90, 1190, 30, 42, { family: 'Montserrat', weight: 500, fill: CREAM, spacing: 1.5 }),
  ];
  return { id, canvas: { width: f.width, height: f.height, background: '#183247' }, safe: f.safe, min_text_px: 30, locked_copy: joined(layers), layers };
}

/** Story: white page, two lines of headline, the product large, one price line, a two-line caveat, one invitation. copy: { headline[], product_line[], caveat[], cta[] } */
export function storyPromo({ id, copy, productKey, wordmarkKey }) {
  const f = FORMAT_SAFE.story;
  const layers = [
    { type: 'image', id: 'brand', key: wordmarkKey, crop: 'ink', box: { x: 90, y: 260, width: 200, height: 54 } },
    text('headline', copy.headline, 90, 470, 92, 102),
    { type: 'image', id: 'product', key: productKey, box: { x: 90, y: 600, width: 900, height: 840 } },
    text('product_line', copy.product_line, 540, 1500, 46, 58, { family: 'Montserrat', weight: 600, anchor: 'middle' }),
    text('caveat', copy.caveat, 540, 1556, 32, 44, { family: 'Montserrat', weight: 500, anchor: 'middle' }),
    text('cta', copy.cta, 540, 1650, 40, 52, { fill: TERRA, family: 'Montserrat', weight: 600, anchor: 'middle' }),
  ];
  return { id, canvas: { width: f.width, height: f.height, background: WHITE }, safe: f.safe, min_text_px: 30, locked_copy: joined(layers), layers };
}

/** Feed know-how piece: headline, three real products side by side each with its own label, one closing line. copy: { headline[], labels[3], closing[] } */
export function knowHowTriptych({ id, copy, productKeys, wordmarkKey }) {
  const f = FORMAT_SAFE.feed;
  const xs = [90, 410, 730];
  const layers = [
    { type: 'image', id: 'brand', key: wordmarkKey, crop: 'ink', box: { x: 90, y: 100, width: 220, height: 60 } },
    text('headline', copy.headline, 90, 290, 76, 90),
    ...productKeys.map((key, i) => ({ type: 'image', id: `product_${i + 1}`, key, box: { x: xs[i], y: 420, width: 260, height: 570 } })),
    ...copy.labels.map((label, i) => text(`label_${i + 1}`, [label], xs[i] + 130, 1050, 32, 44, { family: 'Montserrat', weight: 600, anchor: 'middle' })),
    { type: 'rect', id: 'rule', x: 90, y: 1090, width: 96, height: 4, fill: TERRA },
    text('closing', copy.closing, 90, 1160, 38, 52, { family: 'Montserrat', weight: 600 }),
  ];
  return { id, canvas: { width: f.width, height: f.height, background: WHITE }, safe: f.safe, min_text_px: 30, locked_copy: joined(layers), layers };
}
