// Layout recipes V1: DECLARATIVE constraints, not finished designs. A recipe says which slot (a fraction of the usable area) each
// role of a creative occupies; it knows nothing about a merchant, a font, a colour or a platform. Slots of a recipe never overlap
// (a property the tests check), which is what keeps the product and the text from colliding by construction.
//
// Coordinates are fractions (0..1) of the USABLE rectangle (the canvas minus margins, safe zones and forbidden zones - computed by
// the layout engine). With `mirror_on_rtl` the recipe is mirrored horizontally for a right-to-left output.

import { deepFreeze } from './validation.js';

const slot = (role, x, y, w, h) => ({ role, x, y, w, h });
// A media slot (product, logo) states how the picture sits in its slot: START | CENTER | END (logical: START is the right edge for RTL). Nothing
// is centred by default - the alignment is data of the recipe the caller chose.
const media = (role, x, y, w, h, align) => ({ role, x, y, w, h, align });

export const LAYOUT_RECIPES = deepFreeze({
  PRODUCT_HERO: {
    recipe_id: 'PRODUCT_HERO',
    description: 'headline on top, the product as the hero, price and call to action underneath',
    margin_ratio: 0.06,
    mirror_on_rtl: false,
    slots: [
      media('LOGO', 0, 0, 0.24, 0.06, 'START'),
      slot('HEADLINE', 0, 0.08, 1, 0.16),
      slot('SUBHEADLINE', 0, 0.25, 1, 0.08),
      media('PRODUCT', 0.05, 0.35, 0.9, 0.4, 'CENTER'),
      slot('PRICE', 0, 0.78, 0.5, 0.1),
      slot('CTA', 0.55, 0.78, 0.45, 0.1),
    ],
  },
  EDITORIAL_SPLIT: {
    recipe_id: 'EDITORIAL_SPLIT',
    description: 'the product on the start side, a column of text on the end side',
    margin_ratio: 0.06,
    mirror_on_rtl: true,
    slots: [
      media('PRODUCT', 0, 0.05, 0.46, 0.9, 'START'),
      media('LOGO', 0.54, 0, 0.3, 0.08, 'START'),
      slot('HEADLINE', 0.54, 0.14, 0.46, 0.3),
      slot('SUBHEADLINE', 0.54, 0.46, 0.46, 0.14),
      slot('PRICE', 0.54, 0.64, 0.46, 0.12),
      slot('CTA', 0.54, 0.8, 0.46, 0.12),
    ],
  },
  PRODUCT_DOMINANT: {
    recipe_id: 'PRODUCT_DOMINANT',
    description: 'a short headline and a subheadline above, the product dominant (over half of the height), price and call to action underneath',
    margin_ratio: 0.05,
    mirror_on_rtl: false,
    slots: [
      media('LOGO', 0, 0, 0.24, 0.05, 'START'),
      slot('HEADLINE', 0, 0.06, 1, 0.12),
      slot('SUBHEADLINE', 0, 0.185, 1, 0.05),
      media('PRODUCT', 0.05, 0.25, 0.9, 0.56, 'CENTER'),
      slot('PRICE', 0, 0.835, 0.55, 0.1),
      slot('CTA', 0.58, 0.835, 0.42, 0.1),
    ],
  },
  TEXT_LED: {
    recipe_id: 'TEXT_LED',
    description: 'a large headline carries the message, the product is secondary',
    margin_ratio: 0.07,
    mirror_on_rtl: false,
    slots: [
      media('LOGO', 0, 0, 0.25, 0.06, 'START'),
      slot('HEADLINE', 0, 0.12, 1, 0.34),
      slot('SUBHEADLINE', 0, 0.48, 1, 0.12),
      media('PRODUCT', 0.25, 0.62, 0.5, 0.24, 'CENTER'),
      slot('PRICE', 0, 0.88, 0.5, 0.1),
      slot('CTA', 0.5, 0.88, 0.5, 0.1),
    ],
  },
  PRODUCT_AND_PRICE: {
    recipe_id: 'PRODUCT_AND_PRICE',
    description: 'the product and a dominant price; a short headline between them',
    margin_ratio: 0.06,
    mirror_on_rtl: false,
    slots: [
      media('LOGO', 0, 0, 0.25, 0.07, 'START'),
      media('PRODUCT', 0.05, 0.1, 0.9, 0.55, 'CENTER'),
      slot('HEADLINE', 0, 0.67, 1, 0.1),
      slot('PRICE', 0, 0.78, 0.58, 0.18),
      slot('CTA', 0.62, 0.8, 0.38, 0.14),
    ],
  },
});

export const LAYOUT_RECIPE_IDS = Object.freeze(Object.keys(LAYOUT_RECIPES));
export const getLayoutRecipe = (id) => LAYOUT_RECIPES[id] ?? null;
