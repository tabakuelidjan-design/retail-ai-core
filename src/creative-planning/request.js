import { UNKNOWN } from '../creative-brain/problem-frame.js';
import {
  BRAIN_ERROR, deepFreeze, enumOf, fail, isPlain, listOf, oneLine,
} from '../creative-brain/validation.js';
import {
  COPY_MODE, CONSTRAINT, FACT_KIND, FACT_STATUS, FORMAT_KIND, GENERATION_PURPOSE, LIMITS, REFERENCE_ROLE, SCHEMA, SLIDE_DENSITY, SOURCE_KIND, TEXT_ROLE,
} from './constants.js';

// THE CONTENT REQUEST: what a person (or the Marketing handoff) asks Nordla to make, before any format or canvas is chosen. It is plain data validated here, closed (exact keys, no unknown key) and
// normalized. It holds NO pixel: a source carries references, deterministic measurements and, optionally, text and facts; an image's bytes may be passed to a connected understanding port, never stored.
//
// Numbers: this contract holds only deterministically MEASURED or REQUESTED figures (a requested asset count, a maximum number of assets, the dimensions of a canvas the caller supplies). Nothing a language
// model wrote is ever a figure in it.

const REF_MAX = LIMITS.ref_chars;
const LOCALE = /^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/;
// eslint-disable-next-line no-control-regex
const CONTROL_EXCEPT_NEWLINE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

/** Plain text that may hold line breaks (a paragraph, a list): NFC, line breaks normalized, no other control character, bounded. */
export function longText(value, where, { max = LIMITS.request_text_chars } = {}) {
  if (typeof value !== 'string') fail(BRAIN_ERROR.TEXT_INVALID, `${where} must be text`, where);
  const text = value.normalize('NFC').replace(/\r\n?/g, '\n').replace(CONTROL_EXCEPT_NEWLINE, '').replace(/[^\S\n]+/gu, ' ').replace(/ ?\n ?/g, '\n').trim();
  if (text.length < 1 || text.length > max) fail(BRAIN_ERROR.TEXT_INVALID, `${where} must hold 1..${max} characters`, where, { length: text.length, limit: max });
  return text;
}

export function wholeNumber(value, where, { min = 0, max = 1_000_000 } = {}) {
  if (!Number.isInteger(value) || value < min || value > max) fail(BRAIN_ERROR.RULE_VIOLATION, `${where} must be a whole number from ${min} to ${max}`, where);
  return value;
}
const ref = (value, where) => oneLine(value, where, { max: REF_MAX });
const exact = (value, allowed, where, required = []) => {
  if (!isPlain(value)) fail(BRAIN_ERROR.MALFORMED, `${where} must be a plain object`, where);
  for (const key of Object.keys(value)) if (!allowed.includes(key)) fail(BRAIN_ERROR.UNKNOWN_KEY, `${where}.${key} is not part of this contract`, `${where}.${key}`);
  for (const key of required) if (!(key in value)) fail(BRAIN_ERROR.MISSING_KEY, `${where}.${key} is missing`, `${where}.${key}`);
  return value;
};
const unique = (items, pick, where) => {
  const seen = new Set();
  for (const item of items) { const key = pick(item); if (seen.has(key)) fail(BRAIN_ERROR.RULE_VIOLATION, `${where} repeats ${key}`, where); seen.add(key); }
  return items;
};
const gcd = (a, b) => (b ? gcd(b, a % b) : a);
export const ratioOf = (width, height) => { const g = gcd(width, height); return `${width / g}:${height / g}`; };

export function normalizeFact(raw, where = 'fact') {
  exact(raw, ['fact_ref', 'kind', 'status', 'statement'], where, ['fact_ref', 'kind', 'status', 'statement']);
  return { fact_ref: ref(raw.fact_ref, `${where}.fact_ref`), kind: enumOf(raw.kind, FACT_KIND, `${where}.kind`), status: enumOf(raw.status, FACT_STATUS, `${where}.status`), statement: longText(raw.statement, `${where}.statement`, { max: 600 }) };
}

const CARRIER = Object.freeze({ APPROVED_COPY: 'APPROVED_COPY', CLAIM: 'CLAIM' });
export { CARRIER };

export function normalizeCopyItem(raw, where = 'copy') {
  exact(raw, ['copy_ref', 'mode', 'role', 'carrier', 'text', 'purpose', 'fact_refs'], where, ['copy_ref', 'mode']);
  const mode = enumOf(raw.mode, COPY_MODE, `${where}.mode`);
  const role = raw.role == null ? null : enumOf(raw.role, TEXT_ROLE, `${where}.role`);
  const carrier = raw.carrier == null ? CARRIER.APPROVED_COPY : enumOf(raw.carrier, CARRIER, `${where}.carrier`);
  const hasText = raw.text != null;
  if (mode === COPY_MODE.COPY_GENERATABLE) {
    if (hasText) fail(BRAIN_ERROR.RULE_VIOLATION, `${where}.text must be absent: generated copy has no text yet`, `${where}.text`);
    if (raw.purpose == null) fail(BRAIN_ERROR.MISSING_KEY, `${where}.purpose is missing: generated copy says what it is for`, `${where}.purpose`);
  } else if (!hasText) fail(BRAIN_ERROR.MISSING_KEY, `${where}.text is missing`, `${where}.text`);
  return {
    copy_ref: ref(raw.copy_ref, `${where}.copy_ref`),
    mode,
    role,
    carrier,
    text: hasText ? longText(raw.text, `${where}.text`) : null,
    purpose: raw.purpose == null ? null : enumOf(raw.purpose, GENERATION_PURPOSE, `${where}.purpose`),
    fact_refs: listOf(raw.fact_refs ?? [], `${where}.fact_refs`, { max: 20 }, (v, w) => ref(v, w)),
  };
}

export function normalizeConstraint(raw, where = 'constraint') {
  exact(raw, ['kind', 'value'], where, ['kind']);
  const kind = enumOf(raw.kind, CONSTRAINT, `${where}.kind`);
  if (kind === CONSTRAINT.MAX_ASSETS) return { kind, value: wholeNumber(raw.value, `${where}.value`, { min: 1, max: 20 }) };
  if (raw.value != null) fail(BRAIN_ERROR.RULE_VIOLATION, `${where}.value is only for MAX_ASSETS`, `${where}.value`);
  return { kind, value: null };
}

export function normalizeSource(raw, where = 'source') {
  exact(raw, ['source_kind', 'ref', 'role', 'origin', 'text', 'facts', 'media_type', 'width_px', 'height_px', 'bytes_length', 'sha256', 'bytes'], where, ['source_kind', 'ref']);
  const kind = enumOf(raw.source_kind, SOURCE_KIND, `${where}.source_kind`);
  const defaultRole = { PRODUCT_IMAGE: REFERENCE_ROLE.PRODUCT, REFERENCE_IMAGE: REFERENCE_ROLE.STYLE }[kind] ?? REFERENCE_ROLE.CONTENT;
  if (kind === SOURCE_KIND.TEXT && raw.text == null) fail(BRAIN_ERROR.MISSING_KEY, `${where}.text is missing`, `${where}.text`);
  if (kind === SOURCE_KIND.STRUCTURED_FACTS && !Array.isArray(raw.facts)) fail(BRAIN_ERROR.MISSING_KEY, `${where}.facts is missing`, `${where}.facts`);
  const measuredNumber = (v, name, max) => (v == null ? null : wholeNumber(v, `${where}.${name}`, { min: 0, max }));
  return {
    source_kind: kind,
    ref: ref(raw.ref, `${where}.ref`),
    role: raw.role == null ? defaultRole : enumOf(raw.role, REFERENCE_ROLE, `${where}.role`),
    origin: raw.origin == null ? null : oneLine(raw.origin, `${where}.origin`, { max: 60 }),
    text: raw.text == null ? null : longText(raw.text, `${where}.text`),
    facts: listOf(raw.facts ?? [], `${where}.facts`, { max: LIMITS.facts }, (f, w) => normalizeFact(f, w)),
    media_type: raw.media_type == null ? null : oneLine(raw.media_type, `${where}.media_type`, { max: 100 }),
    width_px: measuredNumber(raw.width_px, 'width_px', 100_000),
    height_px: measuredNumber(raw.height_px, 'height_px', 100_000),
    bytes_length: measuredNumber(raw.bytes_length, 'bytes_length', 2_000_000_000),
    sha256: raw.sha256 == null ? null : oneLine(raw.sha256, `${where}.sha256`, { max: 100 }),
  };
}

export function normalizeCanvasResource(raw, where = 'canvas') {
  exact(raw, ['format_ref', 'canvas', 'medium', 'aspect_ratio', 'safe_zones', 'forbidden_zones', 'production_constraints'], where, ['format_ref', 'canvas', 'medium']);
  exact(raw.canvas, ['width', 'height', 'unit'], `${where}.canvas`, ['width', 'height']);
  const width = wholeNumber(raw.canvas.width, `${where}.canvas.width`, { min: 64, max: 16384 });
  const height = wholeNumber(raw.canvas.height, `${where}.canvas.height`, { min: 64, max: 16384 });
  const unit = raw.canvas.unit ?? 'px';
  if (unit !== 'px') fail(BRAIN_ERROR.RULE_VIOLATION, `${where}.canvas.unit must be px`, `${where}.canvas.unit`);
  const aspect = raw.aspect_ratio ?? ratioOf(width, height);
  if (aspect !== ratioOf(width, height)) fail(BRAIN_ERROR.RULE_VIOLATION, `${where}.aspect_ratio does not follow from the canvas (reduced W:H)`, `${where}.aspect_ratio`);
  const medium = oneLine(raw.medium, `${where}.medium`, { max: 20 });
  return {
    format_ref: ref(raw.format_ref, `${where}.format_ref`), canvas: { width, height, unit }, medium, aspect_ratio: aspect,
    safe_zones: structuredClone(raw.safe_zones ?? []), forbidden_zones: structuredClone(raw.forbidden_zones ?? []), production_constraints: structuredClone(raw.production_constraints ?? []),
  };
}

const optionalLine = (value, where, max) => (value == null || (typeof value === 'string' && !value.trim()) ? UNKNOWN : oneLine(value, where, { max }));

/** The bytes of the sources that carry some (by source ref): handed only to a connected understanding port, never stored in the normalized request. */
export const sourceBytesOf = (raw) => new Map((Array.isArray(raw?.sources) ? raw.sources : []).filter((s) => s && s.bytes != null && typeof s.ref === 'string').map((s) => [s.ref, s.bytes]));

/** A request, validated and normalized. Throws a BrainError naming the field. */
export function normalizeRequest(raw) {
  exact(raw, ['request_ref', 'locale', 'objective', 'audience', 'channel', 'channels', 'requested_format', 'requested_asset_count', 'slide_density', 'constraints', 'copy', 'facts', 'sources', 'canvas'], 'request', ['request_ref']);
  const locale = raw.locale == null ? 'en' : oneLine(raw.locale, 'request.locale', { max: 35 });
  if (!LOCALE.test(locale)) fail(BRAIN_ERROR.RULE_VIOLATION, 'request.locale is not a language tag', 'request.locale');
  const channelList = listOf(raw.channels ?? (raw.channel ? [raw.channel] : []), 'request.channels', { max: LIMITS.channels }, (v, w) => oneLine(v, w, { max: 60 }));
  const copy = listOf(raw.copy ?? [], 'request.copy', { max: LIMITS.copy_items }, (c, w) => normalizeCopyItem(c, w));
  const facts = listOf(raw.facts ?? [], 'request.facts', { max: LIMITS.facts }, (f, w) => normalizeFact(f, w));
  const sources = listOf(raw.sources ?? [], 'request.sources', { max: LIMITS.sources }, (s, w) => normalizeSource(s, w));
  const constraints = listOf(raw.constraints ?? [], 'request.constraints', { max: LIMITS.constraints }, (c, w) => normalizeConstraint(c, w));
  unique(copy, (c) => c.copy_ref, 'request.copy'); unique(facts, (f) => f.fact_ref, 'request.facts'); unique(sources, (s) => s.ref, 'request.sources'); unique(constraints, (c) => c.kind, 'request.constraints');
  const factRefs = new Set(facts.map((f) => f.fact_ref));
  for (const c of copy) for (const r of c.fact_refs) if (!factRefs.has(r)) fail(BRAIN_ERROR.RULE_VIOLATION, `request.copy ${c.copy_ref} cites a fact that does not exist`, 'request.copy');
  return deepFreeze({
    schema: SCHEMA.request,
    request_ref: ref(raw.request_ref, 'request.request_ref'),
    locale,
    objective: optionalLine(raw.objective, 'request.objective', 300),
    audience: optionalLine(raw.audience, 'request.audience', 300),
    channels: channelList,
    requested_format: raw.requested_format == null ? null : enumOf(raw.requested_format, FORMAT_KIND, 'request.requested_format'),
    requested_asset_count: raw.requested_asset_count == null ? null : wholeNumber(raw.requested_asset_count, 'request.requested_asset_count', { min: 1, max: 20 }),
    slide_density: raw.slide_density == null ? null : enumOf(raw.slide_density, SLIDE_DENSITY, 'request.slide_density'),
    constraints,
    copy,
    facts,
    sources,
    canvas: raw.canvas == null ? null : normalizeCanvasResource(raw.canvas),
  });
}
