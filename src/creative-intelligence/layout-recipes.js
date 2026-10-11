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
    description: 'the product and a dominant price; a short headline and a subheadline between them',
    margin_ratio: 0.06,
    mirror_on_rtl: false,
    slots: [
      media('LOGO', 0, 0, 0.25, 0.07, 'START'),
      media('PRODUCT', 0.05, 0.1, 0.9, 0.55, 'CENTER'),
      slot('HEADLINE', 0, 0.67, 1, 0.085),
      slot('SUBHEADLINE', 0, 0.76, 1, 0.055),
      slot('PRICE', 0, 0.825, 0.58, 0.14),
      slot('CTA', 0.62, 0.825, 0.38, 0.14),
    ],
  },
});

export const LAYOUT_RECIPE_IDS = Object.freeze(Object.keys(LAYOUT_RECIPES));

/**
 * A recipe that is not one of the presets (for example synthesized from a relational composition plan) must satisfy the same invariants the presets satisfy: slots as fractions of the usable area, inside
 * it, with a positive size, one slot per role, never overlapping, media slots stating their alignment. Returns the recipe; throws a plain Error naming the first defect.
 */
export function assertValidLayoutRecipe(recipe) {
  const bad = (message) => { throw Object.assign(new Error(`invalid layout recipe: ${message}`), { code: 'LAYOUT_RECIPE_INVALID' }); };
  if (!recipe || typeof recipe.recipe_id !== 'string' || !recipe.recipe_id) bad('a recipe has an id');
  if (!(recipe.margin_ratio >= 0 && recipe.margin_ratio <= 0.2)) bad('margin_ratio is a small fraction');
  if (!Array.isArray(recipe.slots) || recipe.slots.length < 1) bad('a recipe has slots');
  const EPS = 1e-9;
  const seen = new Set();
  for (const s of recipe.slots) {
    if (typeof s.role !== 'string' || seen.has(s.role)) bad('one slot per role');
    seen.add(s.role);
    for (const k of ['x', 'y', 'w', 'h']) if (typeof s[k] !== 'number' || !Number.isFinite(s[k])) bad(`slot ${s.role} has a numeric ${k}`);
    if (s.w <= 0 || s.h <= 0) bad(`slot ${s.role} has a positive size`);
    if (s.x < -EPS || s.y < -EPS || s.x + s.w > 1 + EPS || s.y + s.h > 1 + EPS) bad(`slot ${s.role} lies inside the usable area`);
    if (['PRODUCT', 'LOGO'].includes(s.role) && !['START', 'CENTER', 'END'].includes(s.align)) bad(`media slot ${s.role} states its alignment`);
  }
  for (let i = 0; i < recipe.slots.length; i += 1) {
    for (let j = i + 1; j < recipe.slots.length; j += 1) {
      const a = recipe.slots[i]; const b = recipe.slots[j];
      if (a.x < b.x + b.w - EPS && b.x < a.x + a.w - EPS && a.y < b.y + b.h - EPS && b.y < a.y + a.h - EPS) bad(`slots ${a.role} and ${b.role} overlap`);
    }
  }
  return recipe;
}
export const getLayoutRecipe = (id) => LAYOUT_RECIPES[id] ?? null;
