import test from 'node:test';
import assert from 'node:assert/strict';

import { deflateSync } from 'node:zlib';

import * as P from '../src/creative-intelligence/production.js';
import { evaluateHardFidelityGate, requiredChecksFromInvariants } from '../src/creative-fidelity/fidelity-gates.js';
import {
  ASSET, CANVAS, OTHER_SOURCE, SOURCE, SRC, TEXT_REGION, buildDocument, measurementInput, outcomes, productLayer, backgroundLayer, renderCandidate, sha,
} from './fidelity-measurement-world.js';

// Deterministic Creative Fidelity measurements on the DELIVERED PNG (`// FM-N` markers). A synthetic photograph stands for the merchant asset: the measurements are
// generic, so they are proven here (and in CI) without any private file. Every mutation models a real regression and must fail the check that owns it.

const REQUIRED = requiredChecksFromInvariants(['PRESERVE_PRODUCT_GEOMETRY', 'PRESERVE_PIECE_COUNT', 'PRESERVE_PRODUCT_COLOR', 'PRESERVE_TEXT_EXACTLY']);
const measure = (candidate, over) => P.measureProductFidelity(measurementInput(candidate, over));
const gate = (observations) => evaluateHardFidelityGate({ observations, requiredChecks: REQUIRED });
const IMG = /<image\b[^>]*\/>/;

test('The five required checks are exactly the existing Creative Fidelity vocabulary', () => {
  // FM-1 the required set is PRODUCT_IDENTITY, PRODUCT_GEOMETRY, PIECE_COUNT, PRODUCT_COLOR, TEXT (no new fidelity model)
  assert.deepEqual([...REQUIRED].sort(), ['PIECE_COUNT', 'PRODUCT_COLOR', 'PRODUCT_GEOMETRY', 'PRODUCT_IDENTITY', 'TEXT']);
  // the tolerances are the approved technical ones
  assert.deepEqual({ ...P.FIDELITY_TOLERANCES }, { rectangle_px: 1, aspect_ratio_error: 0.005, color_mean_abs_diff: 0.5, color_mean_signed_shift: 1, text_region_max_diff: 2 });
});

test('A clean composite passes all five checks, and the comparison is not a tautology', () => {
  const clean = renderCandidate();
  const observations = measure(clean);
  // FM-2 all five clean measurements PASS, in a fixed order, with machine-readable evidence
  assert.deepEqual(observations.map((o) => o.code), ['PRODUCT_IDENTITY', 'PRODUCT_GEOMETRY', 'PIECE_COUNT', 'PRODUCT_COLOR', 'TEXT']);
  assert.ok(observations.every((o) => o.outcome === 'PASS'), JSON.stringify(outcomes(observations)));
  assert.ok(observations.every((o) => o.source === P.FIDELITY_MEASUREMENT_SOURCE && typeof o.evidence === 'object'));
  assert.equal(gate(observations).outcome, 'PASS');
  const color = observations.find((o) => o.code === 'PRODUCT_COLOR').evidence;
  assert.ok(color.pixels > 100000 && color.mean_abs_diff <= 0.5);
  // FM-3 non-tautology: the reference is a different rendering (blank canvas + the verified source) from the candidate (the document renderer); an actual candidate
  // mutation produces different pixels and a measured difference, and the same measurement on the clean candidate stays within tolerance
  const mutated = renderCandidate({ mutateSvg: (svg) => svg.replace(IMG, (m) => m.replace('<image', '<image opacity="0.9"')) });
  assert.notDeepEqual(P.decodePng(mutated.png).pixels, P.decodePng(clean.png).pixels);
  assert.ok(measure(mutated).find((o) => o.code === 'PRODUCT_COLOR').evidence.mean_abs_diff > 0.5);
  const box = { x: 190, y: 300, width: 700, height: 800 };
  const rect = P.containFit(box, SRC.width, SRC.height);
  assert.deepEqual([rect.x, rect.y, rect.width, rect.height], [190 + 50, 300, 600, 800]);
  const reference = P.renderReference({ sourceBytes: SOURCE, canvas: CANVAS, rect });
  assert.notEqual(sha(reference.pixels), sha(P.decodePng(mutated.png).pixels));
});

const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc32 = (buf) => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
function encodePng({ width, height, pixels }) {
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type), data]);
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 6;
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y += 1) Buffer.from(pixels.buffer, pixels.byteOffset + y * width * 4, width * 4).copy(raw, y * (width * 4 + 1) + 1);
  return new Uint8Array(Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]));
}

test('PRODUCT_COLOR: the mean-absolute component detects what the signed shift cannot', () => {
  // FM-C1 a checkerboard of +1 / -1 levels on every channel of the product region: signed changes cancel, absolute changes do not
  const clean = renderCandidate();
  const img = P.decodePng(clean.png);
  const pixels = new Uint8Array(img.pixels);
  const rect = P.containFit({ x: 190, y: 300, width: 700, height: 800 }, SRC.width, SRC.height);
  for (let y = rect.y + 2; y < rect.y + rect.height - 2; y += 1) {
    for (let x = rect.x + 2; x < rect.x + rect.width - 2; x += 1) {
      const p = (y * img.width + x) * 4;
      const d = (x + y) % 2 === 0 ? 1 : -1;
      if ([0, 1, 2].every((k) => pixels[p + k] + d >= 0 && pixels[p + k] + d <= 255)) for (let k = 0; k < 3; k += 1) pixels[p + k] += d;
    }
  }
  const altered = { ...clean, png: encodePng({ width: img.width, height: img.height, pixels }) };
  const observations = measure(altered);
  const ev = observations.find((o) => o.code === 'PRODUCT_COLOR').evidence;
  // the signed shift stays inside its tolerance on every channel, the mean absolute difference exceeds its own
  assert.ok(ev.mean_signed_shift.every((s) => Math.abs(s) <= ev.tolerance_shift), JSON.stringify(ev.mean_signed_shift));
  assert.ok(ev.mean_abs_diff > ev.tolerance_mean_abs, String(ev.mean_abs_diff));
  assert.equal(outcomes(observations).PRODUCT_COLOR, 'FAIL');
  // nothing else regresses: the other four checks still PASS
  for (const code of ['PRODUCT_IDENTITY', 'PRODUCT_GEOMETRY', 'PIECE_COUNT', 'TEXT']) assert.equal(outcomes(observations)[code], 'PASS', code);
  // and the unaltered candidate passes
  assert.equal(outcomes(measure(clean)).PRODUCT_COLOR, 'PASS');
});

test('Mutations: every real regression fails the check that owns it', () => {
  const only = (observations, ...failing) => {
    const o = outcomes(observations);
    for (const code of failing) assert.equal(o[code], 'FAIL', `${code}: ${JSON.stringify(o)}`);
    return o;
  };
  // FM-4 a WRONG ASSET (another photograph of the same size is handed to the renderer): PRODUCT_IDENTITY fails on the consumed hash
  const wrong = renderCandidate({ bytes: OTHER_SOURCE });
  const wrongObs = measure(wrong);
  only(wrongObs, 'PRODUCT_IDENTITY');
  assert.equal(wrongObs[0].evidence.conditions.consumed_hash_equals_pinned, false);
  assert.equal(gate(wrongObs).outcome, 'FAIL');
  // FM-5 a CROP (the image is filled to the box and clipped): PRODUCT_GEOMETRY fails (the measured rectangle is not the contain-fit one)
  only(measure(renderCandidate({ mutateSvg: (svg) => svg.replace('xMidYMid meet', 'xMidYMid slice') })), 'PRODUCT_GEOMETRY');
  // FM-6 a STRETCH (aspect ratio not preserved): PRODUCT_GEOMETRY fails on the aspect error
  const stretched = measure(renderCandidate({ mutateSvg: (svg) => svg.replace('xMidYMid meet', 'none') }));
  only(stretched, 'PRODUCT_GEOMETRY');
  assert.ok(stretched.find((o) => o.code === 'PRODUCT_GEOMETRY').evidence.aspect_error > 0.005);
  // FM-7 a SHIFT beyond the tolerance (5 px): PRODUCT_GEOMETRY fails; a shift within ±1 px is within the rounding tolerance
  only(measure(renderCandidate({ mutateSvg: (svg) => svg.replace(IMG, (m) => m.replace(/ x="([\d.]+)"/, (_, x) => ` x="${Number(x) + 5}"`)) })), 'PRODUCT_GEOMETRY');
  // FM-8 a DUPLICATE product instance: PIECE_COUNT fails
  const dup = renderCandidate({ mutateSvg: (svg) => svg.replace(IMG, (m) => `${m}\n${m}`) });
  only(measure(dup), 'PIECE_COUNT');
  assert.equal(dup.log.image_draws, 2);
  // FM-9 an OPACITY alteration and a tint (relight): PRODUCT_COLOR fails
  only(measure(renderCandidate({ mutateSvg: (svg) => svg.replace(IMG, (m) => m.replace('<image', '<image opacity="0.97"')) })), 'PRODUCT_COLOR');
  const tinted = renderCandidate({ mutateSvg: (svg) => svg.replace('</svg>', '<rect x="0" y="0" width="1080" height="1350" fill="#000000" fill-opacity="0.03"/></svg>') });
  only(measure(tinted), 'PRODUCT_COLOR');
  // FM-10 a local OVERWRITE inside the protected text region: TEXT fails while the global colour check (a mean) still passes: the two checks are independent
  const overwritten = renderCandidate({ mutateSvg: (svg) => svg.replace('</svg>', '<rect x="500" y="850" width="8" height="8" fill="#808080"/></svg>') });
  const o = only(measure(overwritten), 'TEXT');
  assert.equal(o.PRODUCT_COLOR, 'PASS');
  assert.ok(measure(overwritten).find((x) => x.code === 'TEXT').evidence.regions[0].max_channel_diff > 2);
  // a SMALL sub-tolerance perturbation is not a failure (the tolerance is a rounding tolerance, not a free pass)
  assert.equal(outcomes(measure(renderCandidate({ mutateSvg: (svg) => svg.replace(IMG, (m) => m.replace(/ y="([\d.]+)"/, (_, y) => ` y="${Number(y) + 0.4}"`)) }))).PRODUCT_GEOMETRY, 'PASS');
});

test('NOT_MEASURABLE: nothing is invented when evidence is missing', () => {
  const clean = renderCandidate();
  // FM-11 no render log: identity and piece count cannot be judged
  const noLog = outcomes(measure(clean, { render_log: null }));
  assert.equal(noLog.PRODUCT_IDENTITY, 'NOT_MEASURABLE');
  assert.equal(noLog.PIECE_COUNT, 'NOT_MEASURABLE');
  // no protected text region: TEXT cannot be judged (the others are unaffected)
  const noRegion = outcomes(measure(clean, { text_regions: [] }));
  assert.equal(noRegion.TEXT, 'NOT_MEASURABLE');
  assert.equal(noRegion.PRODUCT_COLOR, 'PASS');
  // an undecodable candidate: every pixel check refuses
  const garbage = outcomes(measure(clean, { candidate: { png_bytes: new Uint8Array([1, 2, 3]) } }));
  for (const code of ['PRODUCT_GEOMETRY', 'PRODUCT_COLOR', 'TEXT']) assert.equal(garbage[code], 'NOT_MEASURABLE', code);
  // the measurement is defined for PIXEL_PRESERVE only
  const composite = renderCandidate({ document: buildDocument({ layers: [backgroundLayer(), productLayer({ preservation_mode: 'COMPOSITE' })] }) });
  for (const code of ['PRODUCT_GEOMETRY', 'PRODUCT_COLOR', 'TEXT']) assert.equal(outcomes(measure(composite))[code], 'NOT_MEASURABLE', code);
  // a source with alpha and no alpha bounding box: the rectangle method does not apply
  const alpha = outcomes(measure(clean, { source: { ...measurementInput(clean).source, has_alpha: true } }));
  assert.equal(alpha.PRODUCT_GEOMETRY, 'NOT_MEASURABLE');
  // a source whose bytes do not match their declared hash is never used
  const forged = outcomes(measure(clean, { source: { ...measurementInput(clean).source, sha256: 'f'.repeat(64) } }));
  assert.equal(forged.PRODUCT_COLOR, 'NOT_MEASURABLE');
  assert.equal(forged.PRODUCT_IDENTITY, 'FAIL'); // and the identity chain fails: the declared hash is not the pinned one
  // a canvas size that differs from the PNG
  assert.equal(outcomes(measure(clean, { canvas: { ...CANVAS, width: 1000 } })).PRODUCT_COLOR, 'NOT_MEASURABLE');
  // two product layers: the pixel checks are defined for exactly one
  assert.equal(outcomes(measure(clean, { product_layers: [...measurementInput(clean).product_layers, ...measurementInput(clean).product_layers] })).PRODUCT_GEOMETRY, 'NOT_MEASURABLE');
});

test('Aggregation preserves the existing semantics: FAIL dominates, then missing, then PASS', () => {
  const clean = measure(renderCandidate());
  // FM-12 a FAIL wins even when other checks are missing; a missing / NOT_MEASURABLE required check gives NOT_MEASURABLE; all PASS gives PASS
  const failed = clean.map((o) => (o.code === 'PRODUCT_COLOR' ? { ...o, outcome: 'FAIL' } : o));
  assert.equal(gate(failed).outcome, 'FAIL');
  assert.equal(gate(failed.filter((o) => o.code !== 'TEXT')).outcome, 'FAIL');
  assert.equal(gate(clean.filter((o) => o.code !== 'TEXT')).outcome, 'NOT_MEASURABLE');
  assert.equal(gate(clean.map((o) => (o.code === 'TEXT' ? { ...o, outcome: 'NOT_MEASURABLE' } : o))).outcome, 'NOT_MEASURABLE');
  assert.equal(gate([]).outcome, 'NOT_MEASURABLE');
  assert.equal(gate(clean).outcome, 'PASS');
  // an unknown observation code is refused, never ignored
  assert.throws(() => gate([...clean, { code: 'LOOKS_NICE', outcome: 'PASS' }]));
});

test('The PNG decoder reads what the rasterizer delivers and refuses what it cannot measure', () => {
  const clean = renderCandidate();
  const image = P.decodePng(clean.png);
  assert.deepEqual([image.width, image.height, image.pixels.length], [1080, 1350, 1080 * 1350 * 4]);
  assert.deepEqual([...image.pixels.slice(0, 4)], [255, 255, 255, 255]); // the white canvas
  assert.throws(() => P.decodePng(new Uint8Array([1, 2, 3, 4])), /not a PNG/);
  assert.ok(ASSET && TEXT_REGION.width > 0);
});
