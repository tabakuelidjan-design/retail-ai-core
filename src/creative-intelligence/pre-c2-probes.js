// PRE-C2 verifications. Each one RUNS a real check and, only if every check passes, issues the evidence that closes its dependency in
// assessCreativeC2Readiness. A failing check throws (CI_PROBE_FAILED) naming the checks; nothing is claimed from the existence of code.
//
// These are capability probes over synthetic, generic inputs (and over the fonts / documents the caller supplies): they prove the
// capability works, not that any merchant's data is ready. A merchant's readiness is the benchmark's job (benchmark.js).

import { createHash } from 'node:crypto';
import { isExpressionNonEmpty } from '../branding/expression-system.js';
import { createCommonResourceResolver, createStaticResourceAdapter, normalizeFormatMetadata, RES_ERROR, sha256 as hashBytes } from '../resources/index.js';
import { CI_ERROR as E, PRE_C2_DEPENDENCY as D } from './constants.js';
import { renderDesignDocument } from './renderer.js';
import { lineAnchor, layoutText, positionLines } from './typography.js';
import { createResvgRasterizer, pngChunkTypes, pngDimensions, renderProductionPng, RASTERIZER_ENGINE } from './production-render.js';
import { registerEvidence } from './readiness.js';
import { deepFreeze, fail } from './validation.js';

const digest16 = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 16);

function issue(dependency, details) {
  return registerEvidence(deepFreeze({
    dependency,
    status: 'VERIFIED',
    verified_by: 'pre-c2-probe',
    evidence_ref: `probe://${dependency.toLowerCase().replace(/_/g, '-')}/${digest16(details)}`,
    details,
  }));
}

/** Runs named checks; throws if any fails, otherwise returns the names (the evidence says exactly what was verified). */
async function runChecks(dependency, checks) {
  const failed = [];
  const passed = [];
  for (const [name, check] of Object.entries(checks)) {
    let ok = false;
    try { ok = (await check()) === true; } catch { ok = false; }
    (ok ? passed : failed).push(name);
  }
  if (failed.length) fail(E.PROBE_FAILED, `${dependency}: verification failed`, { dependency, failed });
  return passed;
}

const refusesWith = async (code, fn) => { try { await fn(); return false; } catch (error) { return error.code === code; } };

// ---------------------------------------------------------------- 1. common resource resolver
export async function verifyResourceResolver() {
  const A = '11111111-1111-4111-8111-111111111111';
  const B = '22222222-2222-4222-8222-222222222222';
  const tenant = { merchantId: A };
  const font = Uint8Array.from(Array.from({ length: 128 }, (_, i) => (i * 7) % 251));
  const record = (ref, kind, over = {}) => ({
    ref, kind, merchant_id: A, version: 1, status: 'ACTIVE', metadata: null, evidence_ref: 'evidence://probe', ...over,
  });
  const format = { canvas: { width: 100, height: 200, unit: 'px' }, medium: 'DIGITAL', safe_zones: [], forbidden_zones: [], production_constraints: [] };
  const owner = createStaticResourceAdapter({
    adapter_id: 'probe-owner',
    records: [
      record('probe://item', 'PRODUCT'),
      record('probe://looks-like-a-product', 'CATEGORY'),
      record('probe://format', 'FORMAT', { merchant_id: null, metadata: format }),
      record('probe://font', 'FONT', { merchant_id: null, metadata: { family: 'Probe', style: 'normal', weight: 400, version: '1', format: 'ttf', content_hash: hashBytes(font), license_ref: null } }),
      record('probe://foreign', 'PRODUCT', { merchant_id: B }),
      record('probe://revoked', 'PRODUCT', { status: 'REVOKED' }),
    ],
    payloads: { 'probe://font': font },
  });
  const twin = createStaticResourceAdapter({ adapter_id: 'probe-twin', records: [record('probe://item', 'PRODUCT')] });
  const resolver = createCommonResourceResolver({ adapters: [owner] });
  const names = await runChecks(D.RESOURCE_RESOLVER, {
    exact_active_resolution_with_provenance: async () => {
      const r = await resolver.resolve('probe://item', tenant);
      return r.status === 'ACTIVE' && r.kind === 'PRODUCT' && r.provenance.adapter_id === 'probe-owner' && Boolean(r.provenance.evidence_ref);
    },
    unknown_reference_is_unresolved: async () => (await resolver.resolve('probe://nobody', tenant)).status === 'UNRESOLVED',
    kind_comes_from_the_owner: async () => (await resolver.resolve('probe://looks-like-a-product', tenant)).kind === 'CATEGORY',
    cross_merchant_refused: () => refusesWith(RES_ERROR.CROSS_MERCHANT, () => resolver.resolve('probe://foreign', tenant)),
    two_owners_conflict: () => refusesWith(RES_ERROR.CONFLICT, () => createCommonResourceResolver({ adapters: [owner, twin] }).resolve('probe://item', tenant)),
    non_active_never_usable: () => refusesWith(RES_ERROR.NOT_ACTIVE, () => resolver.require('probe://revoked', 'PRODUCT', tenant)),
    format_resolves_through_the_same_resolver: async () => {
      const r = await resolver.require('probe://format', 'FORMAT', tenant);
      return Object.keys(r.metadata).sort().join() === 'canvas,forbidden_zones,medium,production_constraints,safe_zones';
    },
    format_refuses_channel_placement_aspect_ratio: async () => {
      for (const key of ['channel', 'placement', 'aspect_ratio']) {
        if (!(await refusesWith(RES_ERROR.METADATA_INVALID, () => normalizeFormatMetadata({ ...format, [key]: 'X' })))) return false;
      }
      return true;
    },
    font_payload_is_hash_checked: async () => (await resolver.loadPayload('probe://font', tenant)).bytes.length === font.length,
    raw_url_is_not_an_identity: () => refusesWith(RES_ERROR.INVALID_REFERENCE, () => resolver.resolve('https://cdn.example.com/a.png', tenant)),
  });
  return issue(D.RESOURCE_RESOLVER, { checks: names });
}

// ---------------------------------------------------------------- 2-4. real typography
export async function verifyFontMetrics(font) {
  const names = await runChecks(D.REAL_FONT_METRICS, {
    is_a_real_font: () => font?.kind === 'REAL' && font.shaping === 'EXACT',
    metrics_come_from_the_file: () => font.units_per_em >= 16 && font.ascent > 0 && font.descent > 0,
    identified_by_content_hash: () => /^[0-9a-f]{64}$/.test(font.content_hash),
    proportional_advances: () => {
      const wide = font.engine.layout('WWWW', { fontSize: 100, maxWidth: 1e6, direction: 'LTR' }).lines[0].width;
      const narrow = font.engine.layout('iiii', { fontSize: 100, maxWidth: 1e6, direction: 'LTR' }).lines[0].width;
      return wide > 1.5 * narrow;
    },
    declares_script_coverage: () => font.scripts.length > 0,
  });
  return issue(D.REAL_FONT_METRICS, { checks: names, font_hash: font.content_hash, units_per_em: font.units_per_em });
}

export async function verifyShaping({ latinFont, arabicFont }) {
  const width = (font, text, direction) => font.engine.layout(text, { fontSize: 100, maxWidth: 1e6, direction }).lines[0].width;
  const bases = (font, text) => font.engine.layout(text, { fontSize: 100, maxWidth: 1e6, direction: 'RTL' }).lines[0].runs[0].glyphs.filter((g) => g.advance > 0).map((g) => g.gid);
  const names = await runChecks(D.COMPLEX_SCRIPT_SHAPING, {
    latin_kerning_applies: () => width(latinFont, 'AV', 'LTR') < width(latinFont, 'A', 'LTR') + width(latinFont, 'V', 'LTR') - 0.5,
    arabic_contextual_forms: () => {
      const joined = bases(arabicFont, 'ببب');
      const isolated = bases(arabicFont, 'ب');
      return joined.length === 3 && new Set(joined).size === 3 && isolated.length === 1 && !joined.includes(isolated[0]);
    },
    arabic_marks_are_positioned: () => arabicFont.engine.layout('مرحبا', { fontSize: 100, maxWidth: 1e6, direction: 'RTL' }).lines[0].runs[0].glyphs.some((g) => g.advance === 0),
    shaping_is_deterministic: () => width(arabicFont, 'مرحبا بكم', 'RTL') === width(arabicFont, 'مرحبا بكم', 'RTL'),
  });
  return issue(D.COMPLEX_SCRIPT_SHAPING, { checks: names, latin_font: latinFont.content_hash, arabic_font: arabicFont.content_hash });
}

export async function verifyArabicBidi({ font }) {
  const line = (text, direction) => font.engine.layout(text, { fontSize: 40, maxWidth: 1e6, direction }).lines[0];
  const names = await runChecks(D.ARABIC_BIDI_RTL_VERIFICATION, {
    rtl_word_order: () => line('مرحبا بكم متجر', 'RTL').runs.map((r) => r.text).join('|') === 'متجر| |بكم| |مرحبا',
    latin_inside_rtl_stays_ltr: () => line('abc def', 'RTL').runs.map((r) => r.text).join('|') === 'abc| |def',
    european_digits_keep_their_order: () => {
      const runs = line('السعر 25 دينار', 'RTL').runs.filter((r) => r.text.trim()).map((r) => r.text);
      return runs.join('|') === 'دينار|25|السعر';
    },
    mixed_arabic_and_latin: () => line('متجر iPhone الجديد', 'RTL').runs.filter((r) => r.text.trim()).map((r) => r.text).join('|') === 'الجديد|iPhone|متجر',
    brackets_are_mirrored: () => {
      const run = line('(نص)', 'RTL').runs[0];
      return run.rtl && run.glyphs[0].gid === font.engine.glyphFor(0x28) && run.glyphs[run.glyphs.length - 1].gid === font.engine.glyphFor(0x29);
    },
    logical_alignment_resolves_against_direction: () => {
      const layer = (alignment) => ({
        content: 'مرحبا', alignment, direction: 'RTL', locale: 'ar', tracking: 0, line_height: 1.2, font_size: 40, max_lines: 3,
        box: { padding: 0, vertical_align: 'TOP' }, geometry: { x: 100, y: 100, width: 800, height: 200, rotation_deg: 0 },
      });
      const edge = (alignment) => { const l = layer(alignment); return positionLines(l, font, layoutText(l, font)).lines[0]; };
      const start = edge('START'); const end = edge('END');
      return lineAnchor(layer('START')).side === 'RIGHT' && Math.abs(start.x + start.width - 900) < 1e-6 && Math.abs(end.x - 100) < 1e-6;
    },
    the_text_is_never_reversed_as_a_string: () => line('مرحبا بكم', 'RTL').text === 'مرحبا بكم',
  });
  return issue(D.ARABIC_BIDI_RTL_VERIFICATION, { checks: names, font: font.content_hash });
}

// ---------------------------------------------------------------- 5-6. rasterizer and real PNG path
const PROBE_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="120" height="80" viewBox="0 0 120 80"><rect width="120" height="80" fill="rgb(255,255,255)"/><circle cx="40" cy="40" r="25" fill="rgb(17,34,51)"/><path d="M70 10 L110 40 L70 70 Z" fill="rgb(170,51,34)"/></svg>`;

export async function verifyRasterizer() {
  const rasterize = createResvgRasterizer();
  const first = rasterize(PROBE_SVG, { width: 120, height: 80 });
  const names = await runChecks(D.DETERMINISTIC_RASTERIZER, {
    exact_dimensions: () => { const d = pngDimensions(first); return d.width === 120 && d.height === 80; },
    identical_bytes_on_repeat: async () => {
      for (let i = 0; i < 4; i += 1) {
        const again = rasterize(PROBE_SVG, { width: 120, height: 80 });
        if (Buffer.compare(Buffer.from(first), Buffer.from(again)) !== 0) return false;
      }
      return true;
    },
    no_variable_metadata: () => pngChunkTypes(first).every((t) => ['IHDR', 'cHRM', 'gAMA', 'sRGB', 'PLTE', 'tRNS', 'IDAT', 'IEND'].includes(t)),
    explicit_srgb_signalling: () => ['cHRM', 'gAMA', 'sRGB'].every((t) => pngChunkTypes(first).includes(t)),
    size_mismatch_refused: () => refusesWith(E.RASTER_UNSUPPORTED, () => rasterize(PROBE_SVG, { width: 999, height: 80 })),
  });
  return issue(D.DETERMINISTIC_RASTERIZER, { checks: names, sha256: createHash('sha256').update(first).digest('hex'), engine: RASTERIZER_ENGINE });
}

/** Runs the REAL production path on a document: resolved render, real typography, PNG - three times, byte for byte the same. */
export async function verifyPngPath({ document, fonts, assetResolver }) {
  const png = () => renderProductionPng(renderDesignDocument({ document, fonts, assetResolver }));
  const first = png();
  const names = await runChecks(D.REAL_PNG_RENDER_PATH, {
    resolved_render_with_real_typography: () => first.width === document.canvas.width && first.height === document.canvas.height,
    repeated_renders_are_identical: async () => {
      for (let i = 0; i < 3; i += 1) {
        if (png().sha256 !== first.sha256) return false;
      }
      return true;
    },
    structural_render_is_refused: () => refusesWith(E.RENDER_NOT_RESOLVED, () => renderProductionPng(renderDesignDocument({ document, fonts, assetResolver: null }))),
  });
  return issue(D.REAL_PNG_RENDER_PATH, {
    checks: names, document_ref: document.document_id, png_sha256: first.sha256, svg_digest: first.svg_digest, width: first.width, height: first.height,
  });
}

// ---------------------------------------------------------------- 7. brand expression
/** `ready` only for an approved, NON-EMPTY expression system exposed by the Creative brand interface. A legacy Memory (null) or {} is not. */
export function assessExpressionReadiness(creativeInterface) {
  const expression = creativeInterface?.expression_system;
  if (expression == null) return deepFreeze({ ready: false, reason: 'EXPRESSION_SYSTEM_ABSENT', evidence: null });
  if (!isExpressionNonEmpty(expression)) return deepFreeze({ ready: false, reason: 'EXPRESSION_SYSTEM_EMPTY', evidence: null });
  if (!creativeInterface.memory_ref || !creativeInterface.core_ref) return deepFreeze({ ready: false, reason: 'NOT_AN_APPROVED_CREATIVE_INTERFACE', evidence: null });
  const evidence = issue(D.BRAND_EXPRESSION_SYSTEM, { memory_ref: creativeInterface.memory_ref, core_ref: creativeInterface.core_ref, brand_id: creativeInterface.brand?.brand_id ?? null });
  return Object.freeze({ ready: true, reason: 'EXPRESSION_SYSTEM_APPROVED_AND_NON_EMPTY', evidence });
}
