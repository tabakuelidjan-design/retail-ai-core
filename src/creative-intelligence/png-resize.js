// Resampling of a PNG to an exact size (shared raster utility of the creative foundation).
// Moved here from the layered production raster operations so that consumers outside the layered production (studio-compose)
// do not import the production module (architecture guard LG-2). the production module re-exports it unchanged.
import { encodePng } from './png-encode.js';
import { decodePng } from './png-pixels.js';
import { rasterizeToPixels } from './production-render.js';

export function resizePng({ png, width, height }) {
  const w = Math.max(1, Math.round(width)); const h = Math.max(1, Math.round(height));
  const source = decodePng(png);
  if (source.width === w && source.height === h) return { png, width: w, height: h };
  const uri = `data:image/png;base64,${Buffer.from(png).toString('base64')}`;
  const out = rasterizeToPixels(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><image width="${w}" height="${h}" preserveAspectRatio="none" href="${uri}"/></svg>`);
  return { png: encodePng({ width: w, height: h, pixels: out.pixels }), width: w, height: h };
}
