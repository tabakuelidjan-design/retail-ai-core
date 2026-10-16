// Dependency-free header reader: media type and pixel size of PNG / JPEG / WebP. Returns null for anything else (never throws on bad bytes).

export function readImageInfo(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length < 12) return null;
  const b = bytes;
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 && b.length >= 24) {
    const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
    const colorType = b[25];
    return { media_type: 'image/png', width_px: dv.getUint32(16), height_px: dv.getUint32(20), has_alpha: colorType === 4 || colorType === 6 || hasChunk(b, 'tRNS') };
  }
  if (b[0] === 0xff && b[1] === 0xd8) return jpegInfo(b);
  if (ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 4) === 'WEBP') return webpInfo(b);
  return null;
}

const ascii = (b, at, n) => String.fromCharCode(...b.subarray(at, at + n));

function hasChunk(b, name) {
  let at = 8;
  while (at + 8 <= b.length) {
    const len = (b[at] << 24 | b[at + 1] << 16 | b[at + 2] << 8 | b[at + 3]) >>> 0;
    const type = ascii(b, at + 4, 4);
    if (type === name) return true;
    if (type === 'IDAT') return false;
    at += 12 + len;
  }
  return false;
}

function jpegInfo(b) {
  let at = 2;
  while (at + 9 < b.length) {
    if (b[at] !== 0xff) { at += 1; continue; }
    const marker = b[at + 1];
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) { at += 2; continue; }
    const len = b[at + 2] << 8 | b[at + 3];
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { media_type: 'image/jpeg', height_px: b[at + 5] << 8 | b[at + 6], width_px: b[at + 7] << 8 | b[at + 8], has_alpha: false };
    }
    at += 2 + len;
  }
  return null;
}

function webpInfo(b) {
  const kind = ascii(b, 12, 4);
  const u24 = (i) => b[i] | b[i + 1] << 8 | b[i + 2] << 16;
  if (kind === 'VP8X' && b.length >= 30) return { media_type: 'image/webp', width_px: u24(24) + 1, height_px: u24(27) + 1, has_alpha: (b[20] & 0x10) !== 0 };
  if (kind === 'VP8 ' && b.length >= 30) return { media_type: 'image/webp', width_px: (b[26] | b[27] << 8) & 0x3fff, height_px: (b[28] | b[29] << 8) & 0x3fff, has_alpha: false };
  if (kind === 'VP8L' && b.length >= 25) {
    const bits = b[21] | b[22] << 8 | b[23] << 16 | b[24] << 24;
    return { media_type: 'image/webp', width_px: (bits & 0x3fff) + 1, height_px: ((bits >>> 14) & 0x3fff) + 1, has_alpha: ((bits >>> 28) & 1) === 1 };
  }
  return null;
}
