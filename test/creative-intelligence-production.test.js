import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import * as CI from '../src/creative-intelligence/index.js';
import * as P from '../src/creative-intelligence/production.js';
import * as R from '../src/resources/index.js';
import {
  FONT, FONT_AR, LATER, PAYLOAD, backgroundLayer, code, demoDocument, documentParts, fonts as declaredFonts, intakeInput, outputContext, preflightContext, resolveAllMedia,
  solved, textLayer,
} from './creative-intelligence-fixtures.js';

// `// PC2-N text` markers are rows of the PRE-C2 coverage matrix (docs/architecture/creative-pre-c2-foundation.md).

const read = async (file) => new Uint8Array(await readFile(new URL(`./fixtures/fonts/${file}`, import.meta.url)));
const dejavuBytes = await read('DejaVuSans.ttf');
const naskhBytes = await read('NotoNaskhArabic_400Regular.ttf');
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const meta = (bytes, family, over = {}) => ({
  family, style: 'normal', weight: 400, version: '1.0', format: 'ttf', content_hash: sha(bytes), license_ref: 'license://fixture-font', ...over,
});
const dejavu = P.createRealFont({ font_ref: FONT, bytes: dejavuBytes, metadata: meta(dejavuBytes, 'DejaVu Sans') });
const naskh = P.createRealFont({ font_ref: FONT_AR, bytes: naskhBytes, metadata: meta(naskhBytes, 'Noto Naskh Arabic') });
const realFonts = () => P.createRealFontRegistry([dejavu, naskh]);
const roundTrip = (v) => JSON.parse(JSON.stringify(v));
const isDeepFrozen = (v) => v == null || typeof v !== 'object' || (Object.isFrozen(v) && Object.values(v).every(isDeepFrozen));
const widthOf = (font, text, size = 40, opts = {}) => font.engine.layout(text, { fontSize: size, maxWidth: 100000, direction: 'LTR', ...opts }).lines[0].width;

// ------------------------------------------------------------------ real fonts, shaping, bidi (29-43)

test('Real typography: real font bytes, real shaping, real bidi - measured after shaping, never guessed', async () => {
  // PC2-29 real font bytes are parsed into real metrics (units per em, ascent, descent, coverage)
  assert.equal(dejavu.units_per_em, 2048);
  assert.equal(dejavu.ascent, 1901);
  assert.equal(dejavu.descent, 483);
  assert.ok(dejavu.scripts.includes('LATIN') && dejavu.scripts.includes('ARABIC'));
  assert.deepEqual(naskh.scripts, ['ARABIC', 'LATIN']);
  assert.equal(dejavu.shaping, 'EXACT');
  assert.equal(code(() => P.createRealFont({ font_ref: FONT, bytes: Uint8Array.from(Array(200).fill(7)), metadata: meta(Uint8Array.from(Array(200).fill(7)), 'Broken') })), CI.CI_ERROR.FONT_INVALID);
  assert.equal(code(() => P.createRealFont({ font_ref: FONT, bytes: dejavuBytes, metadata: meta(dejavuBytes, 'x', { content_hash: 'a'.repeat(64) }) })), CI.CI_ERROR.FONT_INVALID);
  assert.ok(isDeepFrozen(dejavu));
  // PC2-30 a stable hash / version identify the exact font file that measured and drew the text (and it loads through the common resolver)
  assert.equal(dejavu.content_hash, sha(dejavuBytes));
  assert.equal(dejavu.version, '1.0');
  assert.equal(dejavu.license_ref, 'license://fixture-font');
  const M1 = '11111111-1111-4111-8111-111111111111';
  const resolver = R.createCommonResourceResolver({
    adapters: [R.createStaticResourceAdapter({
      adapter_id: 'fonts', records: [{ ref: 'font://dejavu', kind: 'FONT', merchant_id: null, version: 1, status: 'ACTIVE', evidence_ref: 'evidence://font-store', metadata: meta(dejavuBytes, 'DejaVu Sans') }], payloads: { 'font://dejavu': dejavuBytes },
    })],
  });
  const loaded = await P.loadRealFont({ resolver, font_ref: 'font://dejavu', tenant: { merchantId: M1 } });
  assert.equal(loaded.content_hash, dejavu.content_hash);
  assert.equal(loaded.engine.layout('Hello', { fontSize: 20, maxWidth: 999, direction: 'LTR' }).lines[0].width, dejavu.engine.layout('Hello', { fontSize: 20, maxWidth: 999, direction: 'LTR' }).lines[0].width);
  const swapped = R.createCommonResourceResolver({ adapters: [R.createStaticResourceAdapter({ adapter_id: 'fonts', records: [{ ref: 'font://dejavu', kind: 'FONT', merchant_id: null, version: 1, status: 'ACTIVE', evidence_ref: 'evidence://x', metadata: meta(dejavuBytes, 'DejaVu Sans') }], payloads: { 'font://dejavu': naskhBytes } })] });
  assert.equal(await swapped.loadPayload('font://dejavu', { merchantId: M1 }).catch((e) => e.code), R.RES_ERROR.PAYLOAD_HASH_MISMATCH);
  // PC2-31 Latin shaping applies the font's kerning (GPOS): "AV" is narrower than "A" + "V"
  assert.ok(widthOf(dejavu, 'AV') < widthOf(dejavu, 'A') + widthOf(dejavu, 'V') - 0.5);
  // PC2-32 Arabic shaping substitutes contextual forms (GSUB): the shaped glyphs are not the nominal glyphs of the characters
  const word = naskh.engine.layout('مرحبا', { fontSize: 40, maxWidth: 9999, direction: 'RTL' }).lines[0].runs[0];
  const nominal = new Set([...'مرحبا'].map((c) => naskh.engine.glyphFor(c.codePointAt(0))));
  assert.ok(word.glyphs.some((g) => !nominal.has(g.gid)));
  assert.ok(word.glyphs.length >= 4);
  // PC2-33 Arabic joining is correct on the fixture: the same letter takes a different glyph initial / medial / final / isolated
  // (a base letter has an advance; its dots are zero-advance marks positioned by GPOS)
  const beh = (text) => naskh.engine.layout(text, { fontSize: 40, maxWidth: 9999, direction: 'RTL' }).lines[0].runs[0].glyphs.filter((g) => g.advance > 0).map((g) => g.gid);
  const joined = beh('ببب');
  const isolated = beh('ب');
  assert.equal(joined.length, 3);
  assert.equal(new Set(joined).size, 3); // final, medial and initial forms are three different glyphs
  assert.equal(isolated.length, 1);
  assert.ok(!joined.includes(isolated[0])); // and none of them is the isolated form
  // PC2-34 bidi reordering follows the Unicode algorithm: an RTL paragraph is laid out right to left, run by run (never a string reversal)
  const arabicWords = dejavu.engine.layout('مرحبا بكم متجر', { fontSize: 30, maxWidth: 9999, direction: 'RTL' }).lines[0];
  assert.deepEqual(arabicWords.runs.map((r) => r.text), ['متجر', ' ', 'بكم', ' ', 'مرحبا']); // first logical word = rightmost
  assert.equal(arabicWords.text, 'مرحبا بكم متجر'); // the logical text is untouched
  // Latin words inside an RTL paragraph form ONE left-to-right run (embedding level 2): a naive reversal would fail here
  const latinInRtl = dejavu.engine.layout('abc def ghi', { fontSize: 30, maxWidth: 9999, direction: 'RTL' }).lines[0];
  assert.deepEqual(latinInRtl.runs.map((r) => r.text), ['abc', ' ', 'def', ' ', 'ghi']);
  assert.ok(latinInRtl.runs.every((r) => r.level === 2 && !r.rtl));
  const ltr = dejavu.engine.layout('abc مرحبا def', { fontSize: 30, maxWidth: 9999, direction: 'LTR' }).lines[0];
  assert.deepEqual(ltr.runs.map((r) => r.text), ['abc', ' ', 'مرحبا', ' ', 'def']);
  assert.deepEqual(ltr.runs.map((r) => r.rtl), [false, false, true, false, false]);
  // PC2-35 mixed Arabic + European digits: the digits keep their left-to-right order inside the right-to-left line
  const digits = dejavu.engine.layout('السعر 25 دينار', { fontSize: 30, maxWidth: 9999, direction: 'RTL' }).lines[0];
  const order = digits.runs.filter((r) => r.text.trim()).map((r) => r.text);
  assert.deepEqual(order, ['دينار', '25', 'السعر']);
  const twoFive = digits.runs.find((r) => r.text === '25');
  assert.equal(twoFive.level, 2);
  assert.deepEqual(twoFive.glyphs.map((g) => g.gid), [...'25'].map((c) => dejavu.engine.glyphFor(c.codePointAt(0))));
  assert.ok(twoFive.glyphs[1].x > twoFive.glyphs[0].x);
  // PC2-36 mixed Arabic + Latin words
  const latin = dejavu.engine.layout('متجر iPhone الجديد', { fontSize: 30, maxWidth: 9999, direction: 'RTL' }).lines[0];
  assert.deepEqual(latin.runs.filter((r) => r.text.trim()).map((r) => r.text), ['الجديد', 'iPhone', 'متجر']);
  assert.equal(latin.runs.find((r) => r.text === 'iPhone').rtl, false);
  // PC2-37 mirrored punctuation: in a right-to-left run the brackets take the mirrored glyphs
  const bracket = dejavu.engine.layout('(نص)', { fontSize: 30, maxWidth: 9999, direction: 'RTL' }).lines[0].runs[0];
  const open = dejavu.engine.glyphFor(0x28);
  const close = dejavu.engine.glyphFor(0x29);
  assert.equal(bracket.rtl, true);
  assert.equal(bracket.glyphs[0].gid, open); // visually first (left) = the mirrored closing bracket, drawn as "("
  assert.equal(bracket.glyphs[bracket.glyphs.length - 1].gid, close);
  const logicalLtr = dejavu.engine.layout('(ab)', { fontSize: 30, maxWidth: 9999, direction: 'LTR' }).lines[0].runs[0];
  assert.equal(logicalLtr.glyphs[0].gid, open);
  // PC2-38 logical START / END resolve against the direction: under RTL, START is the right edge and END the left edge
  const box = { x: 100, y: 100, width: 800, height: 200, rotation_deg: 0 };
  const arabicLayer = (alignment) => CI.normalizeLayer(textLayer('ar', 'HEADLINE', 'مرحبا بكم', { geometry: box, font_size: 50, extra: { font_ref: FONT_AR, direction: 'RTL', locale: 'ar-MA', alignment } }));
  const edges = (alignment) => {
    const layer = arabicLayer(alignment);
    const line = CI.positionLines(layer, naskh, CI.layoutText(layer, naskh)).lines[0];
    return { left: line.x, right: line.x + line.width };
  };
  assert.ok(Math.abs(edges('START').right - 900) < 1e-6);
  assert.ok(Math.abs(edges('END').left - 100) < 1e-6);
  assert.ok(Math.abs((edges('CENTER').left + edges('CENTER').right) / 2 - 500) < 1e-6);
  const latinLayer = CI.normalizeLayer(textLayer('en', 'HEADLINE', 'Hello', { geometry: box, font_size: 50 }));
  assert.ok(Math.abs(CI.positionLines(latinLayer, dejavu, CI.layoutText(latinLayer, dejavu)).lines[0].x - 100) < 1e-6); // LTR START = left
  // PC2-39 the SHAPED advances decide whether a line fits: one hundredth of a pixel either side of the measured width changes the breaking
  const exact = widthOf(dejavu, 'Hello world', 40);
  assert.equal(dejavu.engine.layout('Hello world', { fontSize: 40, maxWidth: exact + 0.01, direction: 'LTR' }).lines.length, 1);
  assert.equal(dejavu.engine.layout('Hello world', { fontSize: 40, maxWidth: exact - 0.01, direction: 'LTR' }).lines.length, 2);
  // PC2-40 there is no average-character width: proportional glyphs, no advance table, no default advance, and no such code
  assert.ok(widthOf(dejavu, 'WWWWWWWWWW') > 2 * widthOf(dejavu, 'iiiiiiiiii'));
  assert.ok(!('advances' in dejavu) && !('default_advance' in dejavu));
  const typographySource = await readFile(new URL('../src/creative-intelligence/production-typography.js', import.meta.url), 'utf8');
  assert.doesNotMatch(typographySource, /averageChar|avgChar|xAvgCharWidth|default_advance|\.advances\b/);
  // PC2-41 there is no system-font fallback: a character the font lacks is reported (never substituted), blocks the render and fails the preflight
  assert.deepEqual(dejavu.engine.missingChars('Hello 日本'), ['日', '本']);
  const cjkLayer = CI.normalizeLayer(textLayer('cjk', 'HEADLINE', '日本', { geometry: box, font_size: 50 }));
  assert.deepEqual(CI.layoutText(cjkLayer, dejavu).missing_glyphs, ['日', '本']);
  const cjkDoc = CI.buildDesignDocument(documentParts({ layers: [backgroundLayer(), cjkLayer], asset_refs: [], claim_refs: [] }));
  assert.equal(code(() => CI.renderDesignDocument({ document: cjkDoc, fonts: realFonts() })), CI.CI_ERROR.RENDER_INPUT_INVALID);
  const cjkReport = CI.runCreativePreflight(cjkDoc, { fonts: realFonts() });
  assert.equal(cjkReport.checks.find((c) => c.code === 'FONT_SCRIPT_UNSUPPORTED').status, 'FAIL');
  assert.equal(code(() => CI.renderDesignDocument({ document: solved().document, fonts: P.createRealFontRegistry([naskh]) })), CI.CI_ERROR.FONT_MISSING);
  const rasterSource = await readFile(new URL('../src/creative-intelligence/production-render.js', import.meta.url), 'utf8');
  assert.match(rasterSource, /loadSystemFonts: false/);
  assert.doesNotMatch(rasterSource, /loadSystemFonts: true/);
  // PC2-42 the minimum font size is never crossed: fitting a long text stops at the minimum and reports the overflow
  const tight = CI.normalizeLayer(textLayer('t', 'HEADLINE', 'Une très longue accroche qui ne tiendra jamais dans cette petite boite', { geometry: { x: 0, y: 0, width: 200, height: 60, rotation_deg: 0 }, font_size: 60, min_font_size: 30, max_lines: 1 }));
  const fit = CI.fitText(tight, dejavu);
  assert.equal(fit.fits, false);
  assert.equal(fit.font_size, 30);
  assert.ok(fit.reasons.includes('TOO_MANY_LINES') || fit.reasons.includes('WORD_TOO_WIDE'));
  // PC2-43 the critical text is exact: the glyph projection carries the approved characters and their digest back to the text layer
  const priceDoc = CI.buildDesignDocument(documentParts({
    layers: [backgroundLayer(), textLayer('price', 'PRICE', '19,90 €', { claim_ref: 'claim://demo-price', geometry: { x: 50, y: 50, width: 600, height: 150, rotation_deg: 0 }, font_size: 70, max_lines: 1 })],
    asset_refs: [], claim_refs: ['claim://demo-price'],
  }));
  const rendered = CI.renderDesignDocument({ document: priceDoc, fonts: realFonts() });
  const priceLayer = priceDoc.layers.find((l) => l.id === 'price');
  assert.ok(rendered.svg.includes('aria-label="19,90 €"'));
  assert.ok(rendered.svg.includes(`data-text-digest="${priceLayer.approved_digest}"`));
  assert.ok(rendered.svg.includes(`data-font-hash="${dejavu.content_hash}"`));
  assert.deepEqual(rendered.text_runs[0].lines, ['19,90 €']);
  assert.equal(rendered.typography_mode, 'REAL');
  assert.doesNotMatch(rendered.svg, /<text[\s>]/);
});

// ------------------------------------------------------------------ rasterizer and the real PNG path (44-52)

const productionDoc = () => CI.solveLayout({
  document: demoDocument(), recipe_id: 'PRODUCT_HERO', fonts: realFonts(), assets: { 'asset://demo/product-cutout': { width_px: 800, height_px: 1000 }, 'asset://demo/logo': { width_px: 600, height_px: 200 } }, created_at: LATER,
}).document;
const productionRender = (document = productionDoc(), resolver = resolveAllMedia) => CI.renderDesignDocument({ document, fonts: realFonts(), assetResolver: resolver });

test('Deterministic rasterizer and the real PNG path', async () => {
  const document = productionDoc();
  // PC2-44 a STRUCTURAL render (unresolved media) is never rasterized
  const structural = productionRender(document, null);
  assert.equal(structural.render_mode, 'STRUCTURAL');
  assert.equal(code(() => P.renderProductionPng(structural)), CI.CI_ERROR.RENDER_NOT_RESOLVED);
  // PC2-45 a RESOLVED render with real typography rasterizes to a PNG
  const resolved = productionRender(document);
  assert.equal(resolved.render_mode, 'RESOLVED');
  assert.equal(resolved.typography_mode, 'REAL');
  const png = P.renderProductionPng(resolved);
  assert.deepEqual([...png.bytes.slice(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  assert.equal(png.svg_digest, resolved.digest);
  assert.equal(png.engine.name, 'resvg-js');
  // PC2-46 only explicitly resolved media: a symbolic answer, a partial answer or a non-image payload cannot make a production image
  assert.equal(code(() => P.renderProductionPng(productionRender(document, (r) => `ref:${r}`))), CI.CI_ERROR.RENDER_NOT_RESOLVED);
  assert.equal(code(() => P.renderProductionPng(productionRender(document, (r) => (r === 'asset://demo/logo' ? null : PAYLOAD)))), CI.CI_ERROR.RENDER_NOT_RESOLVED);
  assert.equal(code(() => productionRender(document, () => 'data:text/html;base64,AAAA')), CI.CI_ERROR.RENDER_INPUT_INVALID);
  assert.equal(code(() => productionRender(document, () => 'https://cdn.example.com/a.png')), CI.CI_ERROR.RENDER_INPUT_INVALID);
  // PC2-47 only explicitly resolved fonts: declared-metrics typography is inspection only, and a missing font stops the render
  const declared = CI.renderDesignDocument({ document: solved().document, fonts: declaredFonts(), assetResolver: resolveAllMedia });
  assert.equal(declared.typography_mode, 'DECLARED_METRICS');
  assert.equal(code(() => P.renderProductionPng(declared)), CI.CI_ERROR.RENDER_NOT_RESOLVED);
  assert.equal(code(() => CI.renderDesignDocument({ document, fonts: P.createRealFontRegistry([naskh]), assetResolver: resolveAllMedia })), CI.CI_ERROR.FONT_MISSING);
  assert.doesNotMatch(resolved.svg, /<text[\s>]|font-family/);
  // PC2-48 the same inputs give the same SVG bytes
  assert.equal(productionRender(document).svg, resolved.svg);
  assert.equal(productionRender(document).digest, resolved.digest);
  // PC2-49 the PNG hash is deterministic across repeated renders (and nothing that can vary survives in the file)
  const hashes = new Set();
  for (let i = 0; i < 6; i += 1) {
    hashes.add(P.renderProductionPng(productionRender(document)).sha256);
    await new Promise((resolve) => { setTimeout(resolve, 3); });
  }
  assert.equal(hashes.size, 1);
  assert.ok(P.pngChunkTypes(png.bytes).every((t) => ['IHDR', 'cHRM', 'gAMA', 'sRGB', 'PLTE', 'tRNS', 'IDAT', 'IEND'].includes(t)));
  // a PNG carrying a timestamp / text chunk is normalized to the same bytes
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type, 'latin1'), Buffer.from(data)]);
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    return Buffer.concat([len, body, Buffer.alloc(4)]); // the CRC is not checked by the stripper: the chunk is dropped
  };
  const infoStart = 8 + 12 + 13;
  const polluted = Uint8Array.from(Buffer.concat([Buffer.from(png.bytes.slice(0, infoStart)), chunk('tIME', [7, 234, 10, 9, 12, 0, 0]), chunk('tEXt', Buffer.from('Software\0clock')), Buffer.from(png.bytes.slice(infoStart))]));
  assert.ok(P.pngChunkTypes(polluted).includes('tIME'));
  assert.deepEqual([...P.stripPngMetadata(polluted)], [...png.bytes]);
  // PC2-50 the PNG dimensions are exactly the canvas
  assert.deepEqual(P.pngDimensions(png.bytes), { width: 1080, height: 1350 });
  assert.equal(png.width, 1080);
  assert.equal(png.height, 1350);
  // PC2-51 no payload ever persists into the DesignDocument (font bytes, image bytes, the PNG)
  const serialized = JSON.stringify(document);
  assert.ok(!serialized.includes('base64') && !serialized.includes(dejavu.content_hash));
  assert.equal(CI.normalizeDesignDocument(document).document_id, document.document_id);
  assert.equal(code(() => CI.buildDesignDocument(documentParts({ asset_refs: [PAYLOAD] }))), CI.CI_ERROR.INVALID_REFERENCE);
  // PC2-52 no network access is needed: the whole path runs with fetch and every socket module unavailable
  const realFetch = globalThis.fetch;
  globalThis.fetch = () => { throw new Error('network is not allowed'); };
  try {
    assert.equal(P.renderProductionPng(productionRender(document)).sha256, png.sha256);
  } finally {
    globalThis.fetch = realFetch;
  }
  for (const file of ['production-typography.js', 'production-render.js', 'production.js']) {
    const text = await readFile(new URL(`../src/creative-intelligence/${file}`, import.meta.url), 'utf8');
    assert.doesNotMatch(text, /\bfetch\(|node:http|node:https|node:net|node:dgram|XMLHttpRequest|process\.env|Date\.now|Math\.random/, file);
  }
});

test('SVG / PNG parity: the pixels land where the layout says, within a documented tolerance', () => {
  // PC2-75 the rasterized ink of each text agrees with the analytic ink of its shaped glyphs (PARITY_TOLERANCE_PX), in LTR and RTL
  assert.equal(P.PARITY_TOLERANCE_PX, 1.5);
  const cases = [
    { id: 'latin', font: dejavu, ref: FONT, text: 'Votre objet, votre style', direction: 'LTR', locale: 'fr-BE', alignment: 'START' },
    { id: 'arabic', font: naskh, ref: FONT_AR, text: 'مرحبا بكم في متجرنا', direction: 'RTL', locale: 'ar-MA', alignment: 'START' },
    { id: 'center', font: dejavu, ref: FONT, text: 'Centered text', direction: 'LTR', locale: 'en', alignment: 'CENTER' },
  ];
  for (const c of cases) {
    const geometry = { x: 120, y: 200, width: 840, height: 220, rotation_deg: 0 };
    const document = CI.buildDesignDocument(documentParts({
      output_context: outputContext({ locale: c.direction === 'RTL' ? 'ar-SA' : 'fr-BE', direction: c.direction }),
      layers: [backgroundLayer({ fill: '#FFFFFF' }), textLayer(c.id, 'HEADLINE', c.text, { geometry, font_size: 56, extra: { font_ref: c.ref, direction: c.direction, locale: c.locale, alignment: c.alignment, color: '#000000' } })],
      canvas: { width: 1080, height: 1350, background_color: '#FFFFFF' },
      asset_refs: [], claim_refs: [],
    }));
    const rendered = CI.renderDesignDocument({ document, fonts: realFonts() });
    const layer = document.layers.find((l) => l.id === c.id);
    const laid = CI.layoutText(layer, c.font);
    const placed = CI.positionLines(layer, c.font, laid);
    // analytic ink: union of every glyph's extents, from the shaped positions
    const bounds = placed.lines.map((line) => P.lineInkBounds(c.font, line, { originX: line.x, baseline: line.y, fontSize: laid.font_size })).filter(Boolean);
    const expected = {
      left: Math.min(...bounds.map((b) => b.x)), top: Math.min(...bounds.map((b) => b.y)),
      right: Math.max(...bounds.map((b) => b.x + b.width)), bottom: Math.max(...bounds.map((b) => b.y + b.height)),
    };
    const raster = P.rasterizeToPixels(rendered.svg);
    assert.deepEqual([raster.width, raster.height], [1080, 1350]);
    const ink = P.inkBoundsOfPixels(raster, [255, 255, 255], { x: 0, y: 150, width: 1080, height: 320 });
    const tol = P.PARITY_TOLERANCE_PX;
    assert.ok(Math.abs(ink.x - expected.left) <= tol, `${c.id}: left ${ink.x} vs ${expected.left}`);
    assert.ok(Math.abs(ink.x + ink.width - expected.right) <= tol, `${c.id}: right`);
    assert.ok(Math.abs(ink.y - expected.top) <= tol, `${c.id}: top ${ink.y} vs ${expected.top}`);
    assert.ok(Math.abs(ink.y + ink.height - expected.bottom) <= tol, `${c.id}: bottom`);
    // and it stays inside the layer box (no silent layout drift)
    assert.ok(ink.x >= geometry.x - tol && ink.x + ink.width <= geometry.x + geometry.width + tol, `${c.id}: inside the box`);
  }
});

test('The full production path on the demo: layout, preflight, glyph render, PNG - measurable and green', () => {
  // PC2-76 with real fonts the demo is laid out, preflight is measurable (no NOT_MEASURABLE for text) and passes, and the PNG renders
  const document = productionDoc();
  const report = CI.runCreativePreflight(document, { ...preflightContext(), fonts: realFonts() });
  assert.equal(report.checks.find((c) => c.code === 'TEXT_OVERFLOW').status, 'PASS');
  assert.equal(report.status, 'PASS');
  const png = P.renderProductionPng(productionRender(document));
  assert.equal(png.width, 1080);
  assert.ok(intakeInput && png.sha256.length === 64);
});
