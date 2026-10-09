// Deterministic SVG renderer V1. A pure projection of a DesignDocument: same document + same font registry + same asset resolver
// -> the same bytes. No clock, no randomness, no network, no environment lookup, no third-party design-tool dependency.
//
// It places existing pixels (a product is never re-drawn, re-lit or re-coloured) and writes critical text as real SVG <text> from
// the document, line by line, with the line breaks the typography engine computed - text is never baked into a raster.
//
// Not covered by C1 (stated, not hidden): fonts are NAMED, not embedded (the family must exist where the SVG is viewed or
// rasterized); a PNG needs a rasterizer, which is injected (none ships in this runtime - see renderPng).

import { createHash } from 'node:crypto';
import {
  CI_ERROR as E, EFFECT_KIND, IMAGE_FIT, LAYER_TYPE, RENDERABLE_PRESERVATION_MODES, RENDER_MODE, SHAPE_KIND, VISIBILITY,
} from './constants.js';
import { layerBounds } from './layers.js';
import { layoutText, positionLines } from './typography.js';
import { deepFreeze, fail } from './validation.js';
import { normalizeDesignDocument } from './design-document.js';

const num = (n) => {
  const v = Math.round(n * 1000) / 1000;
  return Object.is(v, -0) ? '0' : String(v);
};
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
const xmlId = (i, id) => `l${i}-${id.replace(/[^A-Za-z0-9_-]/g, '_')}`;
// An <image> may only point at an inline raster / svg data URI or at a symbolic asset reference. Never http(s), file or script.
const SAFE_HREF = /^(data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/=]+|ref:[A-Za-z0-9:_./#-]+)$/;

const SYMBOLIC = /^ref:/;

// A reference the trusted resolver did not turn into a payload (no resolver, no answer, or a symbolic answer) stays an UNRESOLVED
// placeholder: the render is then STRUCTURAL.
function href(resolver, assetRef, unresolved) {
  const resolved = resolver ? resolver(assetRef) : null;
  const value = typeof resolved === 'string' ? resolved : resolved?.href;
  if (value == null) {
    unresolved.add(assetRef);
    return `ref:${assetRef}`;
  }
  if (typeof value !== 'string' || !SAFE_HREF.test(value)) fail(E.RENDER_INPUT_INVALID, 'an asset resolver returned a location that is not an inline image or a symbolic reference', { field: 'assetResolver' });
  if (SYMBOLIC.test(value)) unresolved.add(assetRef);
  return value;
}

const num6 = (n) => {
  const v = Math.round(n * 1e6) / 1e6;
  return Object.is(v, -0) ? '0' : String(v);
};
const textDigestOf = (content) => createHash('sha256').update(content.normalize('NFC')).digest('hex');

const transformOf = (g) => (g.rotation_deg ? ` transform="rotate(${num(g.rotation_deg)} ${num(g.x + g.width / 2)} ${num(g.y + g.height / 2)})"` : '');

function effectAttrs(layer, defs, fid) {
  let attrs = '';
  for (const e of layer.effects) {
    if (e.kind === EFFECT_KIND.OPACITY) attrs += ` opacity="${num(e.value)}"`;
    else if (e.kind === EFFECT_KIND.SHADOW) {
      defs.push(`<filter id="${fid}" x="-30%" y="-30%" width="160%" height="160%"><feDropShadow dx="${num(e.dx)}" dy="${num(e.dy)}" stdDeviation="${num(e.blur / 2)}" flood-color="${e.color}" flood-opacity="${num(e.opacity)}"/></filter>`);
      attrs += ` filter="url(#${fid})"`;
    }
  }
  return attrs;
}

/**
 * Renders a DesignDocument to SVG. `fonts` is the explicit font registry. CANONICAL REF != RESOLVED PAYLOAD: the document holds only
 * opaque refs; `assetResolver(asset_ref)` is a TRUSTED, injected function that may hand the renderer an EPHEMERAL payload (an inline
 * image data URI) for this one render. That payload ends up in the SVG projection only: it is never written back into the document,
 * the candidate or any reference. Without a resolver an image points at the symbolic `ref:<canonical ref>`.
 * Returns { svg, digest, render_mode, unresolved_asset_refs, structure, text_runs }. render_mode is STRUCTURAL while any needed media
 * reference is unresolved (inspection only, labelled `data-render-mode` in the SVG) and RESOLVED only when every one was resolved.
 */
export function renderDesignDocument({ document, fonts, assetResolver = null } = {}) {
  const doc = normalizeDesignDocument(document);
  if (!fonts || typeof fonts.get !== 'function') fail(E.RENDER_INPUT_INVALID, 'a font registry is required', { field: 'fonts' });
  const hidden = new Set(doc.layers.filter((l) => l.visibility === VISIBILITY.HIDDEN).map((l) => l.id));
  for (const g of doc.layers.filter((l) => l.type === LAYER_TYPE.GROUP && l.visibility === VISIBILITY.HIDDEN)) g.members.forEach((m) => hidden.add(m));

  const unresolved = new Set();
  const defs = [];
  const body = [];
  const typographyModes = new Set();
  const glyphDefs = new Set();
  const fontIndex = new Map();
  const structure = [];
  const textRuns = [];
  doc.layers.forEach((layer, i) => {
    if (hidden.has(layer.id) || layer.type === LAYER_TYPE.GROUP) return;
    const g = layer.geometry;
    const box = `x="${num(g.x)}" y="${num(g.y)}" width="${num(g.width)}" height="${num(g.height)}"`;
    const common = `data-layer="${esc(layer.id)}" data-type="${layer.type}"`;
    const fid = `fx${i}`;
    const fx = effectAttrs(layer, defs, fid);
    const tf = transformOf(g);
    structure.push({ layer_id: layer.id, type: layer.type, bounds: layerBounds(layer) });
    switch (layer.type) {
      case LAYER_TYPE.BACKGROUND:
        body.push(layer.fill
          ? `<rect id="${xmlId(i, layer.id)}" ${common} ${box} fill="${layer.fill}"${fx}${tf}/>`
          : `<image id="${xmlId(i, layer.id)}" ${common} ${box} href="${esc(href(assetResolver, layer.source_ref, unresolved))}" preserveAspectRatio="xMidYMid slice"${fx}${tf}/>`);
        break;
      case LAYER_TYPE.PRODUCT:
        if (!RENDERABLE_PRESERVATION_MODES.includes(layer.preservation_mode)) {
          fail(E.RENDER_INPUT_INVALID, `the C1 renderer only places existing pixels: ${layer.preservation_mode} is not renderable`, { layer: layer.id });
        }
        // "meet": the pixels are scaled uniformly and never stretched, whatever the box says.
        body.push(`<image id="${xmlId(i, layer.id)}" ${common} ${box} href="${esc(href(assetResolver, layer.asset_ref, unresolved))}" preserveAspectRatio="xMidYMid meet"${fx}${tf}/>`);
        break;
      case LAYER_TYPE.IMAGE: {
        const slice = layer.fit === IMAGE_FIT.COVER;
        if (slice) defs.push(`<clipPath id="cp${i}"><rect ${box}/></clipPath>`);
        body.push(`<image id="${xmlId(i, layer.id)}" ${common} ${box} href="${esc(href(assetResolver, layer.source_ref, unresolved))}" preserveAspectRatio="xMidYMid ${slice ? 'slice' : 'meet'}"${slice ? ` clip-path="url(#cp${i})"` : ''}${fx}${tf}/>`);
        break;
      }
      case LAYER_TYPE.LOGO:
        body.push(`<image id="${xmlId(i, layer.id)}" ${common} ${box} href="${esc(href(assetResolver, layer.source_ref, unresolved))}" preserveAspectRatio="xMidYMid meet"${fx}${tf}/>`);
        break;
      case LAYER_TYPE.SHAPE: {
        const paint = `fill="${layer.fill ?? 'none'}"${layer.stroke ? ` stroke="${layer.stroke}" stroke-width="${num(layer.stroke_width)}"` : ''}`;
        if (layer.shape_kind === SHAPE_KIND.RECT) body.push(`<rect id="${xmlId(i, layer.id)}" ${common} ${box} rx="${num(layer.corner_radius)}" ${paint}${fx}${tf}/>`);
        else if (layer.shape_kind === SHAPE_KIND.ELLIPSE) body.push(`<ellipse id="${xmlId(i, layer.id)}" ${common} cx="${num(g.x + g.width / 2)}" cy="${num(g.y + g.height / 2)}" rx="${num(g.width / 2)}" ry="${num(g.height / 2)}" ${paint}${fx}${tf}/>`);
        else body.push(`<line id="${xmlId(i, layer.id)}" ${common} x1="${num(g.x)}" y1="${num(g.y + g.height / 2)}" x2="${num(g.x + g.width)}" y2="${num(g.y + g.height / 2)}" ${paint}${fx}${tf}/>`);
        break;
      }
      case LAYER_TYPE.TEXT: {
        const font = fonts.get(layer.font_ref);
        if (!font) fail(E.FONT_MISSING, 'a text layer references a font that is not in the registry', { layer: layer.id });
        const laid = layoutText(layer, font, layer.font_size);
        const placed = positionLines(layer, font, laid);
        // defence in depth: the rendered characters ARE the approved characters (only the line breaks are decided here)
        if (placed.lines.map((l) => l.text).join(' ') !== layer.content.replace(/\n/g, ' ')) {
          fail(E.RENDER_INPUT_INVALID, 'the text would not be rendered exactly as written', { layer: layer.id });
        }
        if (font.engine) {
          // PRODUCTION projection: the glyph outlines of the REAL font file, positioned by the real shaping. No <text>, no font lookup, no
          // rasterizer text engine: the layout and the pixels cannot drift. The canonical text stays in the DesignDocument; the group
          // carries it back (aria-label), with the digest of its exact wording and the hash of the font bytes that drew it.
          if (laid.missing_glyphs.length) fail(E.RENDER_INPUT_INVALID, 'the font has no glyph for part of the text and there is no fallback font', { layer: layer.id });
          typographyModes.add('REAL');
          if (!fontIndex.has(layer.font_ref)) fontIndex.set(layer.font_ref, fontIndex.size);
          const fi = fontIndex.get(layer.font_ref);
          const scale = laid.font_size / font.units_per_em;
          const uses = [];
          for (const line of placed.lines) {
            for (const run of line.runs) {
              for (const g of run.glyphs) {
                const d = font.engine.glyphPath(g.gid);
                if (!d) continue;
                const gid = `gl${fi}-${g.gid}`;
                if (!glyphDefs.has(gid)) { glyphDefs.add(gid); defs.push(`<path id="${gid}" d="${d}"/>`); }
                uses.push(`<use href="#${gid}" transform="translate(${num(line.x + run.x + g.x + g.ox)} ${num(line.y - g.y)}) scale(${num6(scale)} ${num6(-scale)})"/>`);
              }
            }
          }
          body.push(`<g id="${xmlId(i, layer.id)}" ${common} data-projection="GLYPH_PATH" data-font-ref="${esc(layer.font_ref)}" data-font-hash="${font.content_hash}" data-text-digest="${textDigestOf(layer.content)}" role="img" aria-label="${esc(layer.content)}" fill="${layer.color}"${fx}${tf}>${uses.join('')}</g>`);
          textRuns.push({ layer_id: layer.id, font_size: laid.font_size, lines: placed.lines.map((l) => l.text), fits: laid.fits });
          break;
        }
        typographyModes.add('DECLARED_METRICS');
        const spans = placed.lines.map((line) => `<tspan x="${num(line.x)}" y="${num(line.y)}" text-anchor="${line.anchor}">${esc(line.text)}</tspan>`).join('');
        body.push(`<text id="${xmlId(i, layer.id)}" ${common} font-family="${esc(font.family)}, ${font.generic}" font-size="${num(laid.font_size)}" fill="${layer.color}" direction="${layer.direction.toLowerCase()}" letter-spacing="${num(layer.tracking * laid.font_size)}" xml:lang="${esc(layer.locale)}"${fx}${tf}>${spans}</text>`);
        textRuns.push({ layer_id: layer.id, font_size: laid.font_size, lines: placed.lines.map((l) => l.text), fits: laid.fits });
        break;
      }
      default:
        fail(E.RENDER_INPUT_INVALID, 'unsupported layer type', { layer: layer.id });
    }
  });

  const { width, height, background_color: bg } = doc.canvas;
  const renderMode = unresolved.size === 0 ? RENDER_MODE.RESOLVED : RENDER_MODE.STRUCTURAL;
  const svg = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" data-document="${esc(doc.document_id)}" data-render-mode="${renderMode}">`,
    defs.length ? `<defs>${defs.join('')}</defs>` : '',
    `<rect width="${width}" height="${height}" fill="${bg}"/>`,
    ...body,
    '</svg>',
  ].filter(Boolean).join('\n');
  return deepFreeze({
    svg,
    digest: createHash('sha256').update(svg).digest('hex'),
    render_mode: renderMode,
    unresolved_asset_refs: [...unresolved].sort(),
    // REAL: every text is drawn from real font outlines (production). DECLARED_METRICS: inspection only. NONE: no text.
    typography_mode: typographyModes.size === 0 ? 'NONE' : typographyModes.size === 2 ? 'MIXED' : [...typographyModes][0],
    width,
    height,
    structure,
    text_runs: textRuns,
  });
}

/**
 * PNG projection. A rasterizer is INJECTED: `rasterizer(svg, { width, height }) -> Uint8Array`. No rasterizer ships in this runtime,
 * so without one the answer is an explicit { supported: false } - never a fake image.
 */
export function renderPng(rendered, { rasterizer = null } = {}) {
  if (typeof rasterizer !== 'function') return deepFreeze({ supported: false, reason: 'NO_RASTERIZER_IN_RUNTIME', code: E.RASTER_UNSUPPORTED });
  if (rendered.render_mode !== RENDER_MODE.RESOLVED) fail(E.RENDER_NOT_RESOLVED, 'a structural render (unresolved media references) is never rasterized into a production image', { unresolved: rendered.unresolved_asset_refs });
  const bytes = rasterizer(rendered.svg, { width: rendered.width, height: rendered.height });
  if (!(bytes instanceof Uint8Array) || bytes.length < 8 || bytes[0] !== 0x89 || bytes[1] !== 0x50) {
    fail(E.RASTER_UNSUPPORTED, 'the rasterizer did not return a PNG');
  }
  return Object.freeze({ supported: true, bytes, digest: createHash('sha256').update(bytes).digest('hex') });
}
