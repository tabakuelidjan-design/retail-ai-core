// Audio helpers of the ASR physical benchmark (LAB, isomorphic enough for Node). Everything here is DETERMINISTIC: the same canonical recording always yields the same derived file (same SHA-256), so every
// provider gets audio derived from the SAME sample, and the transformation is written down.
import { createHash } from 'node:crypto';

export const sha256Hex = (buf) => createHash('sha256').update(buf).digest('hex');

/** Minimal RIFF/WAVE reader: PCM 16-bit or float32, any channel count. @returns {{ sampleRate:number, channels:number, bitsPerSample:number, format:'pcm16'|'float32', frames:number, data:Float32Array[] }} data = one Float32Array per channel in [-1,1] */
export function parseWav(buf) {
  const b = Buffer.from(buf); if (b.toString('ascii', 0, 4) !== 'RIFF' || b.toString('ascii', 8, 12) !== 'WAVE') throw new Error('not a RIFF/WAVE file');
  let o = 12; let fmt = null; let dataOff = -1; let dataLen = 0;
  while (o + 8 <= b.length) { const id = b.toString('ascii', o, o + 4); const sz = b.readUInt32LE(o + 4); if (id === 'fmt ') fmt = { tag: b.readUInt16LE(o + 8), channels: b.readUInt16LE(o + 10), sampleRate: b.readUInt32LE(o + 12), bits: b.readUInt16LE(o + 22) }; else if (id === 'data') { dataOff = o + 8; dataLen = Math.min(sz, b.length - dataOff); break; } o += 8 + sz + (sz % 2); }
  if (!fmt || dataOff < 0) throw new Error('WAVE without fmt/data'); const isFloat = fmt.tag === 3; if (!(fmt.tag === 1 && fmt.bits === 16) && !(isFloat && fmt.bits === 32)) throw new Error(`unsupported WAVE format tag=${fmt.tag} bits=${fmt.bits}`);
  const bytes = fmt.bits / 8; const frames = Math.floor(dataLen / (bytes * fmt.channels)); const data = Array.from({ length: fmt.channels }, () => new Float32Array(frames));
  for (let i = 0; i < frames; i++) for (let c = 0; c < fmt.channels; c++) { const p = dataOff + (i * fmt.channels + c) * bytes; data[c][i] = isFloat ? b.readFloatLE(p) : b.readInt16LE(p) / 32768; }
  return { sampleRate: fmt.sampleRate, channels: fmt.channels, bitsPerSample: fmt.bits, format: isFloat ? 'float32' : 'pcm16', frames, data };
}
/** 16-bit PCM WAVE writer. @param {Float32Array[]|Int16Array[]} channels */
export function writeWav16(channels, sampleRate) {
  const n = channels[0].length; const ch = channels.length; const out = Buffer.alloc(44 + n * ch * 2);
  out.write('RIFF', 0, 'ascii'); out.writeUInt32LE(36 + n * ch * 2, 4); out.write('WAVE', 8, 'ascii'); out.write('fmt ', 12, 'ascii'); out.writeUInt32LE(16, 16); out.writeUInt16LE(1, 20); out.writeUInt16LE(ch, 22); out.writeUInt32LE(sampleRate, 24); out.writeUInt32LE(sampleRate * ch * 2, 28); out.writeUInt16LE(ch * 2, 32); out.writeUInt16LE(16, 34); out.write('data', 36, 'ascii'); out.writeUInt32LE(n * ch * 2, 40);
  for (let i = 0; i < n; i++) for (let c = 0; c < ch; c++) { const s = channels[c][i]; out.writeInt16LE(channels[c] instanceof Int16Array ? s : Math.max(-32768, Math.min(32767, Math.round(Math.max(-1, Math.min(1, s)) * 32767))), 44 + (i * ch + c) * 2); }
  return out;
}
export const toMono = (data) => (data.length === 1 ? data[0] : data[0].map((_, i) => { let s = 0; for (const ch of data) s += ch[i]; return s / data.length; }));
/** Linear-interpolation resampler (deterministic, no dependency). The same method as the one used in the app's capture glue. */
export function resampleLinear(x, from, to) {
  if (from === to) return Float32Array.from(x); const r = from / to; const n = Math.floor(x.length / r); const y = new Float32Array(n);
  for (let i = 0; i < n; i++) { const p = i * r; const k = Math.floor(p); const f = p - k; y[i] = x[k] + ((x[k + 1] ?? x[k]) - x[k]) * f; }
  return y;
}
export const floatToPcm16 = (x) => { const o = new Int16Array(x.length); for (let i = 0; i < x.length; i++) o[i] = Math.max(-32768, Math.min(32767, Math.round(Math.max(-1, Math.min(1, x[i])) * 32767))); return o; };

/**
 * The reproducible derivation every provider uses: mono (average of channels) -> linear resample -> 16-bit PCM. The record says exactly what was done.
 * @returns {{ pcm16: Int16Array, sampleRate: number, wav: Buffer, sha256: string, transformation: object }}
 */
export function deriveForProvider(canonicalWav, { sampleRate = 16000 } = {}) {
  const inSha = sha256Hex(canonicalWav); const w = parseWav(canonicalWav); const mono = toMono(w.data); const rs = resampleLinear(mono, w.sampleRate, sampleRate); const pcm16 = floatToPcm16(rs); const wav = writeWav16([pcm16], sampleRate);
  return { pcm16, sampleRate, wav, sha256: sha256Hex(wav), transformation: { from: { sampleRate: w.sampleRate, channels: w.channels, format: w.format, sha256: inSha }, steps: [w.channels > 1 ? 'mono = average of channels' : 'already mono', w.sampleRate !== sampleRate ? `linear resample ${w.sampleRate} -> ${sampleRate} Hz` : 'no resampling', 'float -> 16-bit PCM (round to nearest)'], to: { sampleRate, channels: 1, format: 'pcm16', sha256: sha256Hex(wav) }, deterministic: true } };
}
/** Fixed-duration chunks of an Int16Array (the last one may be shorter). */
export function* chunksOf(pcm16, sampleRate, chunkMs) { const n = Math.max(1, Math.round((sampleRate * chunkMs) / 1000)); for (let o = 0; o < pcm16.length; o += n) yield pcm16.subarray(o, Math.min(pcm16.length, o + n)); }
export const durationSec = (pcm16, sampleRate) => pcm16.length / sampleRate;
export const rmsOf = (x, a = 0, b = x.length) => { let s = 0; for (let i = a; i < b; i++) s += x[i] * x[i]; return Math.sqrt(s / Math.max(1, b - a)); };
