// Production rasterization: a RESOLVED render with REAL typography -> a deterministic PNG. Offline, no system font, no network.
//
// Rasterizer: resvg (@resvg/resvg-js, the Rust resvg engine through N-API). The production SVG contains no <text>: text is drawn from the
// glyph outlines of the real font files and the pictures are inline data URIs, so the rasterizer needs no font and fetches nothing.
// Determinism: fixed dimensions (fitTo original), system fonts disabled, no remote resource, and every ancillary PNG chunk (timestamp,
// text, physical size, colour-space hints) is stripped, so the same inputs give the same bytes. A STRUCTURAL render is never rasterized.

import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { Resvg } from '@resvg/resvg-js';
import { CI_ERROR as E, RENDER_MODE } from './constants.js';
import { fail } from './validation.js';

const require = createRequire(import.meta.url);
export const RASTERIZER_ENGINE = Object.freeze({ name: 'resvg-js', version: require('@resvg/resvg-js/package.json').version });

const PNG_SIGNATURE = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
// only the chunks needed to decode the image survive: header, palette, transparency, data, end
const KEPT_CHUNKS = new Set(['IHDR', 'PLTE', 'tRNS', 'IDAT', 'IEND']);

/** The size a PNG declares in its header, or null when the bytes are not a PNG. */
export function pngDimensions(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length < 33) return null;
  for (let i = 0; i < 8; i += 1) if (bytes[i] !== PNG_SIGNATURE[i]) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

/** Removes every non-essential chunk (tIME, tEXt, zTXt, iTXt, pHYs, gAMA, sRGB, eXIf...): the output holds nothing that can vary between runs. */
export function stripPngMetadata(bytes) {
  if (!pngDimensions(bytes)) fail(E.RASTER_UNSUPPORTED, 'not a PNG');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const parts = [PNG_SIGNATURE];
  let offset = 8;
  while (offset + 12 <= bytes.length) {
    const length = view.getUint32(offset);
    const type = String.fromCharCode(bytes[offset + 4], bytes[offset + 5], bytes[offset + 6], bytes[offset + 7]);
    const end = offset + 12 + length;
    if (end > bytes.length) fail(E.RASTER_UNSUPPORTED, 'truncated PNG');
    if (KEPT_CHUNKS.has(type)) parts.push(bytes.subarray(offset, end));
    offset = end;
  }
  return Uint8Array.from(Buffer.concat(parts));
}

/** The chunk types of a PNG, in order (used by tests and by the audit of what the rasterizer embeds). */
export function pngChunkTypes(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const types = [];
  let offset = 8;
  while (offset + 12 <= bytes.length) {
    types.push(String.fromCharCode(bytes[offset + 4], bytes[offset + 5], bytes[offset + 6], bytes[offset + 7]));
    offset += 12 + view.getUint32(offset);
  }
  return types;
}

const resvgOptions = () => ({
  fitTo: { mode: 'original' },
  // no system fonts, no font files: nothing in a production SVG is text, and nothing may be looked up on this machine
  font: { loadSystemFonts: false, fontFiles: [], fontDirs: [] },
  shapeRendering: 2, // geometricPrecision
  imageRendering: 0, // optimizeQuality
});

/** A rasterizer in the shape `renderPng` expects: (svg, { width, height }) -> PNG bytes with the metadata stripped. */
export function createResvgRasterizer() {
  return (svg, { width, height } = {}) => {
    const rendered = new Resvg(svg, resvgOptions()).render();
    if ((width && rendered.width !== width) || (height && rendered.height !== height)) {
      fail(E.RASTER_UNSUPPORTED, 'the rasterized size differs from the canvas', { expected: { width, height }, got: { width: rendered.width, height: rendered.height } });
    }
    return stripPngMetadata(rendered.asPng());
  };
}

/** Raw RGBA pixels of an SVG (used to prove that the pixels and the layout agree). */
export function rasterizeToPixels(svg) {
  const rendered = new Resvg(svg, resvgOptions()).render();
  return Object.freeze({ width: rendered.width, height: rendered.height, pixels: Uint8Array.from(rendered.pixels) });
}

/** The bounding box of the pixels that differ from the background colour, or null. `box` limits the search; `tolerance` is the channel distance. */
export function inkBoundsOfPixels({ width, height, pixels }, background, box = null, tolerance = 40) {
  const x0 = Math.max(0, Math.floor(box?.x ?? 0));
  const y0 = Math.max(0, Math.floor(box?.y ?? 0));
  const x1 = Math.min(width, Math.ceil((box?.x ?? 0) + (box?.width ?? width)));
  const y1 = Math.min(height, Math.ceil((box?.y ?? 0) + (box?.height ?? height)));
  let minX = Infinity; let minY = Infinity; let maxX = -Infinity; let maxY = -Infinity;
  for (let y = y0; y < y1; y += 1) {
    for (let x = x0; x < x1; x += 1) {
      const p = (y * width + x) * 4;
      const diff = Math.abs(pixels[p] - background[0]) + Math.abs(pixels[p + 1] - background[1]) + Math.abs(pixels[p + 2] - background[2]);
      if (diff > tolerance) {
        minX = Math.min(minX, x); maxX = Math.max(maxX, x + 1); minY = Math.min(minY, y); maxY = Math.max(maxY, y + 1);
      }
    }
  }
  return minX === Infinity ? null : { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

/**
 * The production PNG of a render. Refuses a STRUCTURAL render (unresolved media) and any render whose text is not drawn from real font
 * outlines. Returns the bytes (metadata-free), their sha-256 and the digest of the SVG they come from.
 */
export function renderProductionPng(rendered) {
  if (rendered?.render_mode !== RENDER_MODE.RESOLVED) fail(E.RENDER_NOT_RESOLVED, 'only a RESOLVED render can become a production image', { unresolved: rendered?.unresolved_asset_refs ?? null });
  if (rendered.typography_mode !== 'REAL' && rendered.typography_mode !== 'NONE') {
    fail(E.RENDER_NOT_RESOLVED, `production typography requires real fonts (this render uses ${rendered.typography_mode})`, { typography_mode: rendered.typography_mode });
  }
  const bytes = createResvgRasterizer()(rendered.svg, { width: rendered.width, height: rendered.height });
  const size = pngDimensions(bytes);
  if (size.width !== rendered.width || size.height !== rendered.height) fail(E.RASTER_UNSUPPORTED, 'the PNG size differs from the canvas');
  return Object.freeze({
    bytes,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    width: size.width,
    height: size.height,
    svg_digest: rendered.digest,
    engine: RASTERIZER_ENGINE,
  });
}
