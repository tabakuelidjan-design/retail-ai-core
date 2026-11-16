// Minimal PNG pixel decoder: 8-bit, non-interlaced, grayscale / RGB / RGBA (what the production rasterizer emits). Used to MEASURE the delivered PNG, not the SVG
// it came from. Anything else is refused (the caller reports NOT_MEASURABLE): there is no guess and no partial decode. Pure, deterministic, no dependency but zlib.

import { inflateSync } from 'node:zlib';
import { CI_ERROR as E } from './constants.js';
import { fail } from './validation.js';

const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const CHANNELS = { 0: 1, 2: 3, 6: 4 };

const paeth = (a, b, c) => {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
};

/** @returns {{ width: number, height: number, pixels: Uint8Array }} RGBA, row-major, 4 bytes per pixel */
export function decodePng(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length < 33 || SIGNATURE.some((v, i) => bytes[i] !== v)) fail(E.RASTER_UNSUPPORTED, 'not a PNG');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 8;
  let header = null;
  const data = [];
  while (offset + 12 <= bytes.length) {
    const length = view.getUint32(offset);
    const type = String.fromCharCode(bytes[offset + 4], bytes[offset + 5], bytes[offset + 6], bytes[offset + 7]);
    const body = bytes.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') header = { width: view.getUint32(offset + 8), height: view.getUint32(offset + 12), depth: body[8], colorType: body[9], interlace: body[12] };
    if (type === 'IDAT') data.push(body);
    if (type === 'IEND') break;
    offset += 12 + length;
  }
  if (!header) fail(E.RASTER_UNSUPPORTED, 'PNG without a header');
  const channels = CHANNELS[header.colorType];
  if (header.depth !== 8 || !channels || header.interlace !== 0) fail(E.RASTER_UNSUPPORTED, 'only 8-bit, non-interlaced grayscale / RGB / RGBA PNG is measurable', { header });
  const raw = inflateSync(Buffer.concat(data));
  const stride = header.width * channels;
  if (raw.length !== (stride + 1) * header.height) fail(E.RASTER_UNSUPPORTED, 'PNG data length does not match its header');
  const out = new Uint8Array(header.width * header.height * 4);
  let prev = new Uint8Array(stride);
  for (let y = 0; y < header.height; y += 1) {
    const filter = raw[y * (stride + 1)];
    const line = Uint8Array.from(raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)));
    for (let i = 0; i < stride; i += 1) {
      const a = i >= channels ? line[i - channels] : 0;
      const b = prev[i];
      const c = i >= channels ? prev[i - channels] : 0;
      let add = 0;
      if (filter === 1) add = a;
      else if (filter === 2) add = b;
      else if (filter === 3) add = (a + b) >> 1;
      else if (filter === 4) add = paeth(a, b, c);
      else if (filter !== 0) fail(E.RASTER_UNSUPPORTED, 'unknown PNG filter');
      line[i] = (line[i] + add) & 0xff;
    }
    for (let x = 0; x < header.width; x += 1) {
      const o = (y * header.width + x) * 4;
      const p = x * channels;
      if (channels === 1) { out[o] = line[p]; out[o + 1] = line[p]; out[o + 2] = line[p]; out[o + 3] = 255; } else {
        out[o] = line[p]; out[o + 1] = line[p + 1]; out[o + 2] = line[p + 2]; out[o + 3] = channels === 4 ? line[p + 3] : 255;
      }
    }
    prev = line;
  }
  return { width: header.width, height: header.height, pixels: out };
}
