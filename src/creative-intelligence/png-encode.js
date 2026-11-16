// A minimal, deterministic PNG encoder (8-bit RGBA, no interlace, filter 0): the counterpart of png-pixels.js. Pure: no I/O, no clock, no randomness.

import { deflateSync } from 'node:zlib';
import { CI_ERROR as E } from './constants.js';
import { fail } from './validation.js';

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes) {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const length = Buffer.alloc(4); length.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

/** RGBA pixels -> PNG bytes. */
export function encodePng({ width, height, pixels }) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) fail(E.RASTER_UNSUPPORTED, 'a PNG needs positive integer dimensions', { field: 'size' });
  if (!pixels || pixels.length !== width * height * 4) fail(E.RASTER_UNSUPPORTED, 'the pixel buffer does not match the dimensions', { field: 'pixels' });
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4);
  header[8] = 8; header[9] = 6; // 8-bit RGBA
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) Buffer.from(pixels.buffer, pixels.byteOffset + y * stride, stride).copy(raw, y * (stride + 1) + 1);
  return new Uint8Array(Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
  ]));
}
