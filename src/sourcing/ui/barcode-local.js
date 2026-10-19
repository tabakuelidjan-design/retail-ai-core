// LOCAL barcode reading (runs ON THE PHONE: no photo leaves the device, no network, no dependency). Two engines:
//   1. the browser's own BarcodeDetector (Chrome / Android Chrome use Google Play services: the most robust on real photos), when it exists;
//   2. a small EAN-13 / UPC-A scanline decoder in plain JS, used when BarcodeDetector is missing (Firefox, desktop Chrome) or finds nothing.
// A result is accepted ONLY with a valid GTIN check digit: a misread digit is rejected, never "corrected". Limits (stated, not hidden): EAN-13 / UPC-A only in the JS engine (no EAN-8 / QR / DataMatrix), a sharp, roughly straight, well-lit
// photo; a blurred, curved or very small barcode may not be read (then the owner is told, nothing is invented).
const L = ['0001101', '0011001', '0010011', '0111101', '0100011', '0110001', '0101111', '0111011', '0110111', '0001011'];
const G = ['0100111', '0110011', '0011011', '0100001', '0011101', '0111001', '0000101', '0010001', '0001001', '0010111'];
const R = ['1110010', '1100110', '1101100', '1000010', '1011100', '1001110', '1010000', '1000100', '1001000', '1110100'];
const PARITY = ['LLLLLL', 'LLGLGG', 'LLGGLG', 'LLGGGL', 'LGLLGG', 'LGGLLG', 'LGGGLL', 'LGLGLG', 'LGLGGL', 'LGGLGL'];
const runsOf = (pat) => { const out = []; let c = pat[0]; let n = 0; for (const ch of pat) { if (ch === c) n++; else { out.push(n); c = ch; n = 1; } } out.push(n); return out; };
const TABLE = [...L.map((p, d) => ({ d, set: 'L', runs: runsOf(p) })), ...G.map((p, d) => ({ d, set: 'G', runs: runsOf(p) })), ...R.map((p, d) => ({ d, set: 'R', runs: runsOf(p) }))];

export function gtinOk(s) {
  const d = String(s ?? '').replace(/\D/g, ''); if (![8, 12, 13, 14].includes(d.length)) return false;
  const digits = [...d].map(Number); const check = digits.pop(); let sum = 0; digits.reverse().forEach((v, i) => { sum += v * (i % 2 === 0 ? 3 : 1); }); return (10 - (sum % 10)) % 10 === check;
}
function matchDigit(widths, sets) {
  const total = widths.reduce((a, b) => a + b, 0); if (total <= 0) return null; const k = 7 / total; let best = null; let second = Infinity;
  for (const t of TABLE) { if (!sets.includes(t.set)) continue; let e = 0; for (let i = 0; i < 4; i++) e += Math.abs(widths[i] * k - t.runs[i]); if (!best || e < best.e) { if (best) second = Math.min(second, best.e); best = { d: t.d, set: t.set, e }; } else second = Math.min(second, e); }
  return best && best.e < 1.5 && best.e < second * 0.85 ? best : null;
}
/** One row of runs (alternating, starting with a BAR) -> 13 digits or null. Tries every bar as a possible start guard. */
function decodeRuns(runs) {
  for (let i = 0; i + 59 <= runs.length; i += 2) {
    const seg = runs.slice(i, i + 59); const unit = seg.reduce((a, b) => a + b, 0) / 95; if (unit < 1) continue;
    const g = (a) => Math.abs(a / unit - 1) < 0.65; if (!(g(seg[0]) && g(seg[1]) && g(seg[2]) && g(seg[27]) && g(seg[28]) && g(seg[29]) && g(seg[30]) && g(seg[31]) && g(seg[56]) && g(seg[57]) && g(seg[58]))) continue;
    const left = []; const right = []; let okAll = true;
    for (let k = 0; k < 6 && okAll; k++) { const m = matchDigit(seg.slice(3 + k * 4, 7 + k * 4), ['L', 'G']); if (m) left.push(m); else okAll = false; }
    for (let k = 0; k < 6 && okAll; k++) { const m = matchDigit(seg.slice(32 + k * 4, 36 + k * 4), ['R']); if (m) right.push(m); else okAll = false; }
    if (!okAll) continue;
    const parity = left.map((m) => m.set).join(''); const first = PARITY.indexOf(parity); if (first < 0) continue;
    const digits = `${first}${left.map((m) => m.d).join('')}${right.map((m) => m.d).join('')}`; if (gtinOk(digits)) return digits;
  }
  return null;
}
function rowRuns(gray, w, y, x0 = 0, x1 = w) {
  const base = y * w; let mn = 255; let mx = 0; for (let x = x0; x < x1; x++) { const v = gray[base + x]; if (v < mn) mn = v; if (v > mx) mx = v; }
  if (mx - mn < 40) return null; const thr = (mn + mx) / 2; const runs = []; let cur = gray[base + x0] < thr; let n = 0; const startsBlack = cur;
  for (let x = x0; x < x1; x++) { const dark = gray[base + x] < thr; if (dark === cur) n++; else { runs.push(n); cur = dark; n = 1; } } runs.push(n);
  if (!startsBlack) runs.shift(); // a row must start with a bar: drop the leading quiet zone
  return runs;
}
/** @param {{data: Uint8ClampedArray, width: number, height: number}} img RGBA pixels (an ImageData). Reads the barcode in any of 4 orientations (0, 180, 90, 270). */
export function decodeEan13(img) {
  const { data, width: w, height: h } = img; const gray = new Uint8ClampedArray(w * h);
  for (let i = 0, j = 0; i < data.length; i += 4, j++) gray[j] = (data[i] * 299 + data[i + 1] * 587 + data[i + 2] * 114) / 1000;
  const scan = (g, gw, gh) => { const step = Math.max(1, Math.floor(gh / 48)); for (let y = Math.floor(gh * 0.1); y < gh * 0.9; y += step) { const r = rowRuns(g, gw, y); if (!r) continue; const a = decodeRuns(r); if (a) return a; const rr = [...r]; if (rr.length % 2 === 0) rr.pop(); /* drop the trailing quiet zone: a reversed row must start with a bar */ const b = decodeRuns(rr.reverse()); if (b) return b; } return null; };
  const hit = scan(gray, w, h); if (hit) return hit;
  const t = new Uint8ClampedArray(w * h); for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) t[x * h + y] = gray[y * w + x]; // 90 degrees: a vertical barcode
  return scan(t, h, w);
}
/** data: URL -> Blob WITHOUT fetch(): the page's Content-Security-Policy (connect-src 'self') forbids fetching data: URLs. */
export function dataUrlToBlob(dataUrl, win = globalThis) {
  const m = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(String(dataUrl)); if (!m) throw new Error('not a data URL');
  const bin = m[2] ? win.atob(m[3]) : decodeURIComponent(m[3]); const bytes = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i); return new win.Blob([bytes], { type: m[1] || 'application/octet-stream' });
}
/** Photo (data URL) -> { gtin, format, engine } or null. Never throws: a failure means "not read". */
export async function detectBarcode(dataUrl, { forceJs = false, win = globalThis } = {}) {
  try {
    const bmp = await win.createImageBitmap(dataUrlToBlob(dataUrl, win));
    if (!forceJs && win.BarcodeDetector) { try { const det = new win.BarcodeDetector({ formats: ['ean_13', 'upc_a', 'ean_8', 'upc_e'] }); const found = await det.detect(bmp); const f = found.find((x) => gtinOk(x.rawValue)); if (f) return { gtin: String(f.rawValue).replace(/\D/g, ''), format: f.format, engine: 'BarcodeDetector' }; } catch { /* fall through to the JS engine */ } }
    for (const maxSide of [1600, 1024]) { const k = Math.min(1, maxSide / Math.max(bmp.width, bmp.height)); const c = win.document.createElement('canvas'); c.width = Math.max(1, Math.round(bmp.width * k)); c.height = Math.max(1, Math.round(bmp.height * k));
      const ctx = c.getContext('2d', { willReadFrequently: true }); ctx.drawImage(bmp, 0, 0, c.width, c.height); const gtin = decodeEan13(ctx.getImageData(0, 0, c.width, c.height)); if (gtin) return { gtin: gtin.length === 13 && gtin[0] === '0' ? gtin : gtin, format: gtin[0] === '0' ? 'upc_a' : 'ean_13', engine: 'local-js' }; }
  } catch { /* unreadable image: nothing is invented */ }
  return null;
}
/** Photo (data URL) -> the bytes to send IF the owner consents: downscaled JPEG, its base64 and sha-256 (the consent is bound to exactly these bytes). */
export async function prepareForUpload(dataUrl, { maxSide = 1024, quality = 0.8, win = globalThis } = {}) {
  const bmp = await win.createImageBitmap(dataUrlToBlob(dataUrl, win)); const k = Math.min(1, maxSide / Math.max(bmp.width, bmp.height));
  const c = win.document.createElement('canvas'); c.width = Math.max(1, Math.round(bmp.width * k)); c.height = Math.max(1, Math.round(bmp.height * k)); c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
  const out = await new Promise((res) => c.toBlob(res, 'image/jpeg', quality)); const buf = new Uint8Array(await out.arrayBuffer()); const hash = new Uint8Array(await win.crypto.subtle.digest('SHA-256', buf));
  let bin = ''; for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
  return { imageBase64: win.btoa(bin), mime: 'image/jpeg', sha256: [...hash].map((b) => b.toString(16).padStart(2, '0')).join(''), bytes: buf.length, width: c.width, height: c.height };
}
