import { DENSITY_CLASS, DENSITY_ORDER, LOW_DENSITY_MAX_CHARS } from './constants.js';

// DENSITY CLASSES. How much text an asset carries is a design class, decided by measurement:
//   LOW        text that fits the headline and the subheadline (a hook, a call to action)
//   MEDIUM     a short supporting paragraph beside a strong image
//   HIGH       a paragraph that shares the slide with the image
//   TEXT_LED   the text is the slide
// The class boundaries of the body classes are the slide capacities of the format resource, measured against the text-led layout spec. Nothing here truncates text: a class only describes it.

export const densityRank = (cls) => DENSITY_ORDER.indexOf(cls);
export const maxDensity = (a, b) => (densityRank(a) >= densityRank(b) ? a : b);

/** The text of an asset in characters: its slots, joined by one space (the caption is not on the asset). */
export const assetChars = (asset) => asset.slots.reduce((n, s) => n + s.chars, 0) + Math.max(0, asset.slots.length - 1);

/** @returns {{ density_class, chars, over_ceiling }} */
export function classifyDensity(chars, resource) {
  const caps = resource.slide_capacity;
  let cls = DENSITY_CLASS.TEXT_LED;
  if (chars <= LOW_DENSITY_MAX_CHARS) cls = DENSITY_CLASS.LOW;
  else if (chars <= caps.MEDIUM.chars) cls = DENSITY_CLASS.MEDIUM;
  else if (chars <= caps.HIGH.chars) cls = DENSITY_CLASS.HIGH;
  return { density_class: cls, chars, over_ceiling: chars > caps.TEXT_LED.chars };
}
