// Brand Memory V1.1 - the optional sixth category: expression_system.
//
// The semantic VISUAL expression of a brand, written by humans and approved like the rest of Brand Memory. Exactly these domains:
//   photography, product_presentation, composition, layout_principles, illustration, iconography, motion, locale_overrides
// (no sound identity, no 3D, no channel-specific social template yet).
//
// Each non-locale domain is a small bounded guideline set: { principles, do, dont, reference_asset_refs }.
// - It is NOT a hard-rule store: a required logo, an exact colour or a mandatory claim belong to hard rules / claims / references, and
//   the guard below refuses a hex colour or a claim:// / external-policy:// reference inside a guideline text.
// - It carries no URL, no provider prompt, no model name, no seed and no score (unknown keys are refused; generation-parameter text is
//   refused); assets are opaque references that are never a location.
// - locale_overrides is a PARTIAL map keyed by a canonical locale, overriding only the domains above: global expression first, locale
//   override second. The whole Memory is never duplicated per locale.
// A legacy Memory (no expression_system) stays valid; Creative C2 additionally requires an approved NON-EMPTY expression system.

export const EXPRESSION_DOMAINS = Object.freeze([
  'photography', 'product_presentation', 'composition', 'layout_principles', 'illustration', 'iconography', 'motion',
]);
export const EXPRESSION_KEYS = Object.freeze([...EXPRESSION_DOMAINS, 'locale_overrides']);
const GUIDELINE_KEYS = ['principles', 'do', 'dont', 'reference_asset_refs'];
export const EXPRESSION_LIMITS = Object.freeze({
  max_items: 20, max_text: 300, max_locales: 20,
});

const LOCALE = /^[a-z]{2,3}(-[A-Z][a-z]{3})?(-([A-Z]{2}|[0-9]{3}))?$/;
const HEX_COLOR = /#[0-9A-Fa-f]{3,8}\b/;
const OTHER_GOVERNED_REF = /\b(claim|external-policy|brand-core|decision|approved-asset):\/\//i;
const LOCATION_IN_TEXT = /\b(?:https?|ftps?|file|data|blob|wss?):\/?\/?[^\s"']*/i;
// Generation-parameter text (a prompt flag, a seed, a sampler) is adapter data, never brand expression.
const GENERATION_PARAMETER = /(?:^|\s)--[a-z]{1,12}\b|\bseed\s*[:=]\s*\d|\bnegative prompt\b|\bcfg\s*[:=]|\bsampler\b|\bstable[- ]diffusion\b|\bmidjourney\b/i;
const ASSET_LOCATION = /^(https?|ftps?|sftp|ssh|file|data|blob|wss?|javascript|mailto|tel|s3|gs|gcs|drive):/i;
const HOST_PATH = /^(www\.|[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}\/)/;

const isObject = (v) => v != null && typeof v === 'object' && !Array.isArray(v);

function exactKeys(value, allowed, field) {
  if (!isObject(value)) throw new TypeError(`${field} must be an object`);
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw new TypeError(`${field}.${key} is not part of Brand Memory V1.1 expression_system`);
  }
}

function guidelineText(value, field) {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError(`${field} must be a non-empty string`);
  const text = value.normalize('NFC').trim();
  if (text.length > EXPRESSION_LIMITS.max_text) throw new RangeError(`${field} is too long`);
  if (LOCATION_IN_TEXT.test(text)) throw new TypeError(`${field} must not contain a URL or a location`);
  if (GENERATION_PARAMETER.test(text)) throw new TypeError(`${field} must not contain a provider prompt, a model name or a generation parameter`);
  if (HEX_COLOR.test(text)) throw new TypeError(`${field} must not state an exact colour: that is a hard rule / design token`);
  if (OTHER_GOVERNED_REF.test(text)) throw new TypeError(`${field} must not restate a claim, a policy or a decision reference: that is a hard rule`);
  return text;
}

function list(value, field, item) {
  if (value == null) return [];
  if (!Array.isArray(value)) throw new TypeError(`${field} must be an array`);
  if (value.length > EXPRESSION_LIMITS.max_items) throw new RangeError(`${field} must contain at most ${EXPRESSION_LIMITS.max_items} items`);
  const out = value.map((entry, i) => item(entry, `${field}[${i}]`));
  if (new Set(out).size !== out.length) throw new TypeError(`${field} contains duplicates`);
  return out;
}

/** An asset reference of an expression guideline: opaque, whitespace-free, and never a location. */
export function expressionAssetRef(value, field) {
  if (typeof value !== 'string' || !/^\S+$/.test(value) || ASSET_LOCATION.test(value) || HOST_PATH.test(value)) {
    throw new TypeError(`${field} must be an opaque reference (no URL, no location)`);
  }
  return value;
}

export function normalizeGuideline(input, field) {
  exactKeys(input, GUIDELINE_KEYS, field);
  return {
    principles: list(input.principles, `${field}.principles`, guidelineText),
    do: list(input.do, `${field}.do`, guidelineText),
    dont: list(input.dont, `${field}.dont`, guidelineText),
    reference_asset_refs: list(input.reference_asset_refs, `${field}.reference_asset_refs`, expressionAssetRef),
  };
}

function canonicalLocale(value, field) {
  let canonical;
  try {
    canonical = Intl.getCanonicalLocales(value)[0];
  } catch {
    throw new TypeError(`${field} must be a canonical locale such as fr-BE`);
  }
  // no silent normalization: fr-be is refused, not rewritten
  if (canonical !== value || !LOCALE.test(value)) throw new TypeError(`${field} must be a canonical locale such as fr-BE (got a non-canonical form)`);
  return value;
}

function normalizeDomains(input, field, { allowLocale }) {
  exactKeys(input, allowLocale ? EXPRESSION_KEYS : EXPRESSION_DOMAINS, field);
  const out = {};
  for (const domain of EXPRESSION_DOMAINS) {
    if (input[domain] != null) out[domain] = normalizeGuideline(input[domain], `${field}.${domain}`);
  }
  return out;
}

export function normalizeExpressionSystem(input, field = 'expression_system') {
  const out = normalizeDomains(input, field, { allowLocale: true });
  if (input.locale_overrides != null) {
    if (!isObject(input.locale_overrides)) throw new TypeError(`${field}.locale_overrides must be an object`);
    const locales = Object.keys(input.locale_overrides);
    if (locales.length > EXPRESSION_LIMITS.max_locales) throw new RangeError(`${field}.locale_overrides has too many locales`);
    const overrides = {};
    for (const locale of [...locales].sort()) {
      canonicalLocale(locale, `${field}.locale_overrides key`);
      const partial = normalizeDomains(input.locale_overrides[locale], `${field}.locale_overrides.${locale}`, { allowLocale: false });
      if (Object.keys(partial).length === 0) throw new TypeError(`${field}.locale_overrides.${locale} overrides nothing`);
      overrides[locale] = partial;
    }
    if (locales.length) out.locale_overrides = overrides;
  }
  return out;
}

const guidelineHasContent = (g) => Boolean(g && (g.principles.length || g.do.length || g.dont.length || g.reference_asset_refs.length));

/** True when the expression system states at least one guideline (global or per locale). An empty object is NOT an expression system. */
export function isExpressionNonEmpty(expression) {
  if (!isObject(expression)) return false;
  if (EXPRESSION_DOMAINS.some((d) => guidelineHasContent(expression[d]))) return true;
  return Object.values(expression.locale_overrides ?? {}).some((partial) => EXPRESSION_DOMAINS.some((d) => guidelineHasContent(partial[d])));
}

/** The locales an expression system overrides (to be checked against the brand's supported locales at the governed boundary). */
export const expressionLocales = (expression) => Object.keys(expression?.locale_overrides ?? {});

export function assertExpressionLocalesSupported(expression, supportedLocales, field = 'expression_system') {
  for (const locale of expressionLocales(expression)) {
    if (!supportedLocales.includes(locale)) throw new Error(`EXPRESSION_LOCALE_NOT_SUPPORTED: ${field} overrides ${locale}, which the brand does not support`);
  }
}
