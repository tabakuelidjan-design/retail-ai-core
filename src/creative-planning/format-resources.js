import { FORMAT_KIND, LIMITS, TEXT_ROLE } from './constants.js';

// STANDARD FORMAT RESOURCES: deterministic configuration (a canvas, a medium and what text a canvas can hold), never a generated visual. They are used AFTER a format has been decided, to give each
// planned asset its canvas. The shape of a resource follows the FORMAT resource the Socle resolver already serves (canvas, medium, safe_zones, forbidden_zones, production_constraints).
//
// TEXT CAPACITY is declared in CHARACTERS (a measure that does not depend on the script) for each text role of one asset, with its BASIS:
//   MEASURED_AGAINST_THE_LAYOUT_ENGINE   the longest filler text that the real layout (fonts, type rules, recipes) places in one slot, with a 20% safety margin; a test re-measures it on every run
//   MEASURED_AGAINST_THE_TEXT_LED_LAYOUT_SPEC   the same measurement, with the real typography engine, for the body text of a slide in the text-led layout spec (text-led-spec.js), per density class; BODY has no
//                                         layout recipe yet, so an asset that uses it is PLANNED, not executable, but the capacity is a measurement, no longer a declared ceiling
// Capacity is a property of the format, not of a brand or a product. The slide capacities were measured with the widest fixture font and carry a 20% safety factor; a test re-measures them on every run.

export const CAPACITY_BASIS = Object.freeze({ MEASURED: 'MEASURED_AGAINST_THE_LAYOUT_ENGINE', MEASURED_LED: 'MEASURED_AGAINST_THE_TEXT_LED_LAYOUT_SPEC' });

const measured = (chars) => Object.freeze({ chars, basis: CAPACITY_BASIS.MEASURED });
const led = (chars) => Object.freeze({ chars, basis: CAPACITY_BASIS.MEASURED_LED });

// body = the capacity of a text shared with an image on a single canvas (HIGH); slide = the capacity of a slide of a sequence per density class
const capacity = (slide) => Object.freeze({
  [TEXT_ROLE.HEADLINE]: measured(100),
  [TEXT_ROLE.SUBHEADLINE]: measured(50),
  [TEXT_ROLE.PRICE]: measured(28),
  [TEXT_ROLE.CTA]: measured(24),
  [TEXT_ROLE.BODY]: led(slide.HIGH),
});

const resource = (format_ref, width, height, medium, aspect_ratio, kinds, slide) => Object.freeze({
  format_ref,
  canvas: Object.freeze({ width, height, unit: 'px' }),
  medium,
  aspect_ratio,
  safe_zones: Object.freeze([]),
  forbidden_zones: Object.freeze([]),
  production_constraints: Object.freeze([]),
  kinds: Object.freeze(kinds),
  text_capacity: capacity(slide),
  slide_capacity: Object.freeze({ MEDIUM: led(slide.MEDIUM), HIGH: led(slide.HIGH), TEXT_LED: led(slide.TEXT_LED) }),
  within_current_production_limit: width * height <= LIMITS.max_production_pixels,
});

export const FORMAT_RESOURCES = Object.freeze([
  resource('format://nordla/standard/feed-portrait-1080x1350', 1080, 1350, 'DIGITAL', '4:5', [FORMAT_KIND.SINGLE_IMAGE, FORMAT_KIND.CAROUSEL, FORMAT_KIND.MULTI_VISUAL_SERIES], { MEDIUM: 268, HIGH: 462, TEXT_LED: 614 }),
  resource('format://nordla/standard/feed-square-1080x1080', 1080, 1080, 'DIGITAL', '1:1', [FORMAT_KIND.SINGLE_IMAGE, FORMAT_KIND.CAROUSEL, FORMAT_KIND.MULTI_VISUAL_SERIES], { MEDIUM: 232, HIGH: 347, TEXT_LED: 499 }),
  resource('format://nordla/standard/story-vertical-1080x1920', 1080, 1920, 'DIGITAL', '9:16', [FORMAT_KIND.SINGLE_IMAGE, FORMAT_KIND.STORY_SEQUENCE], { MEDIUM: 384, HIGH: 653, TEXT_LED: 923 }),
  resource('format://nordla/standard/poster-portrait-1448x2048', 1448, 2048, 'PHYSICAL', '181:256', [FORMAT_KIND.POSTER, FORMAT_KIND.MULTI_VISUAL_SERIES], { MEDIUM: 308, HIGH: 499, TEXT_LED: 729 }),
  resource('format://nordla/standard/flyer-portrait-1240x1748', 1240, 1748, 'PHYSICAL', '310:437', [FORMAT_KIND.FLYER, FORMAT_KIND.MULTI_VISUAL_SERIES], { MEDIUM: 308, HIGH: 539, TEXT_LED: 729 }),
]);

/** The standard resource that serves a kind for a channel profile (the first, in this order, that lists the kind). */
const PREFERRED_RESOURCE = Object.freeze({
  SOCIAL_FEED: 'feed-portrait', GENERIC_DIGITAL: 'feed-portrait', SOCIAL_STORY: 'story-vertical', VIDEO_FEED: 'story-vertical', STORE_WINDOW: 'poster-portrait', PRINT: 'flyer-portrait',
});

export function standardResourceFor(kind, profileName) {
  const preferred = FORMAT_RESOURCES.find((r) => r.format_ref.includes(`/${PREFERRED_RESOURCE[profileName] ?? 'feed-portrait'}-`) && r.kinds.includes(kind));
  return preferred ?? FORMAT_RESOURCES.find((r) => r.kinds.includes(kind)) ?? null;
}

/** A resource supplied by the CALLER (for example the canvas a brief already states): it is used as it is, and its text capacity is the standard one of the closest standard canvas. */
export function callerResource(canvasFacts) {
  const { format_ref: formatRef, canvas, medium, aspect_ratio: aspect, safe_zones: safe = [], forbidden_zones: forbidden = [], production_constraints: constraints = [] } = canvasFacts;
  const closest = [...FORMAT_RESOURCES].sort((a, b) => Math.abs(a.canvas.width / a.canvas.height - canvas.width / canvas.height) - Math.abs(b.canvas.width / b.canvas.height - canvas.width / canvas.height))[0];
  return Object.freeze({
    format_ref: formatRef,
    canvas: Object.freeze({ width: canvas.width, height: canvas.height, unit: canvas.unit ?? 'px' }),
    medium,
    aspect_ratio: aspect,
    safe_zones: Object.freeze([...safe]),
    forbidden_zones: Object.freeze([...forbidden]),
    production_constraints: Object.freeze([...constraints]),
    kinds: closest.kinds,
    text_capacity: closest.text_capacity,
    slide_capacity: closest.slide_capacity,
    within_current_production_limit: canvas.width * canvas.height <= LIMITS.max_production_pixels,
  });
}
