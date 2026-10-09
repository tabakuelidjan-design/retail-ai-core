import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { Resvg } from '@resvg/resvg-js';

import * as P from '../src/creative-intelligence/production.js';

// `// PC2-N text` markers are rows of the PRE-C2 coverage matrix (docs/architecture/creative-pre-c2-foundation.md).

// Independent bitwise CRC-32 (ISO 3309 / PNG, reflected polynomial 0xEDB88320). Deliberately NOT the implementation under test, and no node:zlib.crc32
// (only available from Node 20.15, while the repository declares node >= 20).
const crc32 = (bytes) => {
  let c = 0xffffffff;
  for (const byte of bytes) {
    c ^= byte;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
  }
  return (c ^ 0xffffffff) >>> 0;
};
const storedCrc = (png, c) => new DataView(png.buffer, png.byteOffset, png.byteLength).getUint32(c.at + 8 + c.data.length);
const computedCrc = (png, c) => crc32(png.subarray(c.at + 4, c.at + 8 + c.data.length));

const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const chunksOf = (bytes) => {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out = [];
  for (let o = 8; o + 12 <= bytes.length; o += 12 + view.getUint32(o)) {
    out.push({ type: String.fromCharCode(...bytes.subarray(o + 4, o + 8)), data: bytes.subarray(o + 8, o + 8 + view.getUint32(o)), at: o });
  }
  return out;
};
const idat = (bytes) => Buffer.concat(chunksOf(bytes).filter((c) => c.type === 'IDAT').map((c) => c.data));
// the exact colours that must survive rasterization (navy, red, cream, sand)
const brand = [[15, 42, 82], [192, 57, 43], [251, 248, 243], [239, 233, 225]];
const hex = (c) => `#${c.map((v) => v.toString(16).padStart(2, '0')).join('')}`;
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="40" height="10">${brand.map((c, i) => `<rect x="${i * 10}" width="10" height="10" fill="${hex(c)}"/>`).join('')}</svg>`;

test('PNG colour semantics: explicit deterministic sRGB, no variable metadata, pixels untouched', () => {
  const raw = new Resvg(svg).render().asPng();
  const rasterize = P.createResvgRasterizer();
  const png = rasterize(svg, { width: 40, height: 10 });
  const chunks = chunksOf(png);
  // PC2-78 explicit sRGB (cHRM + gAMA + sRGB perceptual) before IDAT; no timestamp, text, ICC or physical-size chunk; repeated renders are byte-identical
  assert.deepEqual(chunks.map((c) => c.type), ['IHDR', 'cHRM', 'gAMA', 'sRGB', 'IDAT', 'IEND']);
  assert.deepEqual([...chunks[3].data], [0]);
  assert.equal(Buffer.from(chunks[2].data).readUInt32BE(0), 45455);
  assert.deepEqual(Array.from({ length: 8 }, (_, i) => Buffer.from(chunks[1].data).readUInt32BE(i * 4)), [31270, 32900, 64000, 33000, 30000, 60000, 15000, 6000]);
  for (const forbidden of ['tIME', 'tEXt', 'zTXt', 'iTXt', 'iCCP', 'pHYs', 'eXIf']) assert.ok(!chunks.some((c) => c.type === forbidden), forbidden);
  for (let i = 0; i < 4; i += 1) assert.deepEqual([...rasterize(svg, { width: 40, height: 10 })], [...png]);
  assert.deepEqual([...P.stripPngMetadata(png)], [...png]); // idempotent
  // the generated chunks carry valid CRCs, checked with an independent CRC-32 (known vector first: CRC-32('123456789') = 0xCBF43926)
  assert.equal(crc32(Buffer.from('123456789')), 0xcbf43926);
  for (const type of ['cHRM', 'gAMA', 'sRGB']) {
    const c = chunks.find((x) => x.type === type);
    assert.equal(storedCrc(png, c), computedCrc(png, c), `${type} CRC`);
  }
  for (const c of chunks) assert.equal(storedCrc(png, c), computedCrc(png, c), c.type);
  // a corrupted CRC, or a corrupted data byte, is detected by the same check
  const corrupted = Uint8Array.from(png);
  const srgb = chunks.find((x) => x.type === 'sRGB');
  corrupted[srgb.at + 8 + srgb.data.length] ^= 0xff;
  assert.notEqual(storedCrc(corrupted, srgb), computedCrc(corrupted, srgb));
  const flipped = Uint8Array.from(png);
  const gama = chunks.find((x) => x.type === 'gAMA');
  flipped[gama.at + 8] ^= 0x01;
  assert.notEqual(storedCrc(flipped, gama), computedCrc(flipped, gama));
  // the pixel data is the encoder's own, byte for byte: normalization touches metadata only
  assert.ok(idat(png).equals(idat(raw)));
  assert.deepEqual(chunksOf(raw).map((c) => c.type), ['IHDR', 'IDAT', 'IEND']); // what the encoder itself emits: NO colour signalling
  assert.deepEqual([...chunks[0].data], [...chunksOf(raw)[0].data]);
  // a PNG that arrives with a timestamp, text or a foreign colour chunk converges to the same bytes
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type, 'latin1'), Buffer.from(data)]);
    const out = Buffer.alloc(12 + data.length);
    out.writeUInt32BE(data.length, 0);
    body.copy(out, 4);
    out.writeUInt32BE(crc32(body), 8 + data.length);
    return out;
  };
  const after = 8 + 12 + 13;
  const polluted = Uint8Array.from(Buffer.concat([
    Buffer.from(raw.subarray(0, after)), chunk('tIME', [7, 234, 10, 9, 12, 0, 0]), chunk('tEXt', Buffer.from('Software\0clock')), chunk('gAMA', Buffer.from([0, 0, 0, 1])), chunk('iCCP', Buffer.from('x\0\0')), Buffer.from(raw.subarray(after)),
  ]));
  assert.ok(chunksOf(polluted).some((c) => c.type === 'tIME') && chunksOf(polluted).some((c) => c.type === 'iCCP'));
  assert.deepEqual([...P.stripPngMetadata(polluted)], [...png]);
});

test('Brand colours survive rasterization exactly', () => {
  // PC2-80 opaque brand hex colours come out of the rasterizer unchanged: tolerance 0 per channel
  const { pixels, width } = P.rasterizeToPixels(svg);
  brand.forEach((c, i) => {
    const p = (5 * width + i * 10 + 5) * 4;
    assert.deepEqual([...pixels.slice(p, p + 4)], [...c, 255], hex(c));
  });
});

test('Font fixtures: every committed font file has its source, exact licence, notice and content hash', async () => {
  const dir = new URL('./fixtures/fonts/', import.meta.url);
  const inventory = JSON.parse(await readFile(new URL('FONTS.json', dir), 'utf8'));
  const committed = (await readdir(dir)).filter((f) => /\.(ttf|otf|woff2?)$/i.test(f)).sort();
  // PC2-79 the inventory lists exactly the committed font files; each hash matches; each notice file exists and carries its licence text
  assert.deepEqual(inventory.fonts.map((f) => f.file).sort(), committed);
  for (const font of inventory.fonts) {
    for (const field of ['family', 'version', 'source', 'content_hash']) assert.ok(typeof font[field] === 'string' && font[field], `${font.file}.${field}`);
    for (const field of ['name', 'spdx', 'note', 'notice_file', 'notice_must_contain']) assert.ok(typeof font.license[field] === 'string' && font.license[field], `${font.file}.license.${field}`);
    assert.match(font.source, /^https:\/\//);
    assert.equal(sha(new Uint8Array(await readFile(new URL(font.file, dir)))), font.content_hash, font.file);
    const notice = await readFile(new URL(font.license.notice_file, dir), 'utf8');
    assert.ok(notice.includes(font.license.notice_must_contain), `${font.file}: the notice file carries the licence`);
  }
  // DejaVu is NOT under the SIL OFL; Noto Naskh Arabic is; no inventory, notice or doc says otherwise
  const byFile = Object.fromEntries(inventory.fonts.map((f) => [f.file, f]));
  assert.equal(byFile['DejaVuSans.ttf'].license.spdx, 'Bitstream-Vera');
  assert.doesNotMatch(byFile['DejaVuSans.ttf'].license.name, /Open Font/i);
  assert.equal(byFile['NotoNaskhArabic_400Regular.ttf'].license.spdx, 'OFL-1.1');
  assert.doesNotMatch(await readFile(new URL('LICENSE-DejaVu.txt', dir), 'utf8'), /SIL OPEN FONT LICENSE/i);
  for (const doc of ['../THIRD_PARTY_NOTICES.md', '../docs/architecture/creative-pre-c2-foundation.md']) {
    assert.doesNotMatch(await readFile(new URL(doc, import.meta.url), 'utf8'), /DejaVu[^\n]{0,80}(SIL|OFL|Open Font)/i, doc);
  }
});

test('THIRD_PARTY_NOTICES records the MPL-2.0 obligations of resvg exactly', async () => {
  // PC2-81 exact package, licence, upstream source, source-availability mechanism, notice, modification status
  const text = await readFile(new URL('../THIRD_PARTY_NOTICES.md', import.meta.url), 'utf8');
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(pkg.dependencies['@resvg/resvg-js'], '2.6.2');
  for (const needle of ['@resvg/resvg-js', '2.6.2', 'MPL-2.0', 'https://github.com/yisibl/resvg-js', '3.2', 'file-level', 'Nordla modifies covered files: NO']) assert.ok(text.includes(needle), needle);
  assert.doesNotMatch(text, /no source-disclosure obligation/i);
});
