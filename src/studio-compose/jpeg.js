// Baseline JPEG encoder (JFIF, 4:4:4, one quantization table and the standard luminance Huffman tables for all three components).
// Why it exists: Instagram's publishing API accepts JPEG only (chantier E asks D for JPEG), the pipeline's renderer only emits PNG, and the
// repository has no image dependency. Pure and deterministic: the same pixels and quality give the same bytes. Alpha is flattened over white.

const ZIGZAG = [0, 1, 8, 16, 9, 2, 3, 10, 17, 24, 32, 25, 18, 11, 4, 5, 12, 19, 26, 33, 40, 48, 41, 34, 27, 20, 13, 6, 7, 14, 21, 28, 35, 42, 49, 56, 57, 50, 43, 36, 29, 22, 15, 23, 30, 37, 44, 51, 58, 59, 52, 45, 38, 31, 39, 46, 53, 60, 61, 54, 47, 55, 62, 63];
const QUANT_BASE = [16, 11, 10, 16, 24, 40, 51, 61, 12, 12, 14, 19, 26, 58, 60, 55, 14, 13, 16, 24, 40, 57, 69, 56, 14, 17, 22, 29, 51, 87, 80, 62, 18, 22, 37, 56, 68, 109, 103, 77, 24, 35, 55, 64, 81, 104, 113, 92, 49, 64, 78, 87, 103, 121, 120, 101, 72, 92, 95, 98, 112, 100, 103, 99];
const DC_COUNTS = [0, 1, 5, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0];
const DC_VALUES = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
const AC_COUNTS = [0, 2, 1, 3, 3, 2, 4, 3, 5, 5, 4, 4, 0, 0, 1, 0x7d];
const AC_VALUES = [
  0x01, 0x02, 0x03, 0x00, 0x04, 0x11, 0x05, 0x12, 0x21, 0x31, 0x41, 0x06, 0x13, 0x51, 0x61, 0x07, 0x22, 0x71, 0x14, 0x32, 0x81, 0x91, 0xa1, 0x08, 0x23, 0x42, 0xb1, 0xc1, 0x15, 0x52, 0xd1, 0xf0,
  0x24, 0x33, 0x62, 0x72, 0x82, 0x09, 0x0a, 0x16, 0x17, 0x18, 0x19, 0x1a, 0x25, 0x26, 0x27, 0x28, 0x29, 0x2a, 0x34, 0x35, 0x36, 0x37, 0x38, 0x39, 0x3a, 0x43, 0x44, 0x45, 0x46, 0x47, 0x48, 0x49,
  0x4a, 0x53, 0x54, 0x55, 0x56, 0x57, 0x58, 0x59, 0x5a, 0x63, 0x64, 0x65, 0x66, 0x67, 0x68, 0x69, 0x6a, 0x73, 0x74, 0x75, 0x76, 0x77, 0x78, 0x79, 0x7a, 0x83, 0x84, 0x85, 0x86, 0x87, 0x88, 0x89,
  0x8a, 0x92, 0x93, 0x94, 0x95, 0x96, 0x97, 0x98, 0x99, 0x9a, 0xa2, 0xa3, 0xa4, 0xa5, 0xa6, 0xa7, 0xa8, 0xa9, 0xaa, 0xb2, 0xb3, 0xb4, 0xb5, 0xb6, 0xb7, 0xb8, 0xb9, 0xba, 0xc2, 0xc3, 0xc4, 0xc5,
  0xc6, 0xc7, 0xc8, 0xc9, 0xca, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7, 0xd8, 0xd9, 0xda, 0xe1, 0xe2, 0xe3, 0xe4, 0xe5, 0xe6, 0xe7, 0xe8, 0xe9, 0xea, 0xf1, 0xf2, 0xf3, 0xf4, 0xf5, 0xf6, 0xf7, 0xf8,
  0xf9, 0xfa,
];

function huffmanTable(counts, values) {
  const codes = new Map();
  let code = 0;
  let k = 0;
  for (let len = 1; len <= 16; len += 1) {
    for (let i = 0; i < counts[len - 1]; i += 1) { codes.set(values[k], { code, len }); code += 1; k += 1; }
    code <<= 1;
  }
  return codes;
}
const DC = huffmanTable(DC_COUNTS, DC_VALUES);
const AC = huffmanTable(AC_COUNTS, AC_VALUES);

const COS = (() => {
  const t = new Float64Array(64);
  for (let u = 0; u < 8; u += 1) for (let x = 0; x < 8; x += 1) t[u * 8 + x] = (u === 0 ? Math.SQRT1_2 : 1) * Math.cos(((2 * x + 1) * u * Math.PI) / 16) / 2;
  return t;
})();

function quantTable(quality) {
  const q = Math.min(100, Math.max(1, Math.round(quality)));
  const scale = q < 50 ? 5000 / q : 200 - 2 * q;
  return QUANT_BASE.map((v) => Math.min(255, Math.max(1, Math.floor((v * scale + 50) / 100))));
}

function writer() {
  const out = [];
  let acc = 0;
  let bits = 0;
  return {
    bytes: out,
    put(code, len) {
      acc = (acc << len) | code;
      bits += len;
      while (bits >= 8) {
        const b = (acc >> (bits - 8)) & 0xff;
        out.push(b);
        if (b === 0xff) out.push(0);
        bits -= 8;
      }
      acc &= (1 << bits) - 1;
    },
    flush() { if (bits > 0) this.put((1 << (8 - bits)) - 1, 8 - bits); },
  };
}

const category = (v) => { let a = Math.abs(v); let n = 0; while (a) { n += 1; a >>= 1; } return n; };

function encodeBlock(w, block, quant, prevDc) {
  const tmp = new Float64Array(64);
  const co = new Float64Array(64);
  for (let u = 0; u < 8; u += 1) for (let y = 0; y < 8; y += 1) { let s = 0; for (let x = 0; x < 8; x += 1) s += block[y * 8 + x] * COS[u * 8 + x]; tmp[y * 8 + u] = s; }
  for (let v = 0; v < 8; v += 1) for (let u = 0; u < 8; u += 1) { let s = 0; for (let y = 0; y < 8; y += 1) s += tmp[y * 8 + u] * COS[v * 8 + y]; co[v * 8 + u] = s; }
  const q = new Int32Array(64);
  for (let i = 0; i < 64; i += 1) q[i] = Math.round(co[ZIGZAG[i]] / quant[i]);
  const diff = q[0] - prevDc;
  const dc = category(diff);
  w.put(DC.get(dc).code, DC.get(dc).len);
  if (dc) w.put(diff < 0 ? diff + (1 << dc) - 1 : diff, dc);
  let run = 0;
  for (let i = 1; i < 64; i += 1) {
    if (q[i] === 0) { run += 1; continue; }
    while (run > 15) { w.put(AC.get(0xf0).code, AC.get(0xf0).len); run -= 16; }
    const s = category(q[i]);
    const h = AC.get((run << 4) | s);
    w.put(h.code, h.len);
    w.put(q[i] < 0 ? q[i] + (1 << s) - 1 : q[i], s);
    run = 0;
  }
  if (run > 0) w.put(AC.get(0).code, AC.get(0).len);
  return q[0];
}

const u16 = (n) => [(n >> 8) & 0xff, n & 0xff];
const segment = (marker, body) => [0xff, marker, ...u16(body.length + 2), ...body];

/** @param {{ width: number, height: number, pixels: Uint8Array }} image RGBA row-major @returns {Uint8Array} JPEG bytes */
export function encodeJpeg({ width, height, pixels }, { quality = 92 } = {}) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width > 16383 || height > 16383) throw new RangeError('invalid image size');
  if (!(pixels instanceof Uint8Array) || pixels.length !== width * height * 4) throw new TypeError('pixels must be RGBA, width*height*4 bytes');
  const quant = quantTable(quality);
  const head = [0xff, 0xd8,
    ...segment(0xe0, [0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0]),
    ...segment(0xdb, [0, ...ZIGZAG.map((_, i) => quant[i])]),
    ...segment(0xc0, [8, ...u16(height), ...u16(width), 3, 1, 0x11, 0, 2, 0x11, 0, 3, 0x11, 0]),
    ...segment(0xc4, [0x00, ...DC_COUNTS, ...DC_VALUES]),
    ...segment(0xc4, [0x10, ...AC_COUNTS, ...AC_VALUES]),
    ...segment(0xda, [3, 1, 0x00, 2, 0x00, 3, 0x00, 0, 63, 0])];
  const w = writer();
  const prev = [0, 0, 0];
  const planes = [new Float64Array(64), new Float64Array(64), new Float64Array(64)];
  for (let by = 0; by < height; by += 8) {
    for (let bx = 0; bx < width; bx += 8) {
      for (let y = 0; y < 8; y += 1) {
        for (let x = 0; x < 8; x += 1) {
          const px = Math.min(width - 1, bx + x); const py = Math.min(height - 1, by + y);
          const o = (py * width + px) * 4;
          const a = pixels[o + 3] / 255;
          const r = pixels[o] * a + 255 * (1 - a); const g = pixels[o + 1] * a + 255 * (1 - a); const b = pixels[o + 2] * a + 255 * (1 - a);
          const i = y * 8 + x;
          planes[0][i] = 0.299 * r + 0.587 * g + 0.114 * b - 128;
          planes[1][i] = -0.168736 * r - 0.331264 * g + 0.5 * b;
          planes[2][i] = 0.5 * r - 0.418688 * g - 0.081312 * b;
        }
      }
      for (let c = 0; c < 3; c += 1) prev[c] = encodeBlock(w, planes[c], quant, prev[c]);
    }
  }
  w.flush();
  return Uint8Array.from([...head, ...w.bytes, 0xff, 0xd9]);
}
