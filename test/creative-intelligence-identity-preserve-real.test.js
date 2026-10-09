import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { Resvg } from '@resvg/resvg-js';

import * as P from '../src/creative-intelligence/production.js';

// IDENTITY_PRESERVE on the REAL HABB asset (`// IR-N` markers). The annotations are committed data; the photograph is private and only present on a trusted local
// machine: the tests that need it run only there (a clean clone checks the annotations and skips the rest). The candidates are built from the real pixels
// themselves (the real case cut out and placed on another background), never from a provider.

const root = new URL('../', import.meta.url);
const config = JSON.parse(await readFile(new URL('benchmarks/creative-intelligence/habb-creative-benchmark-001.json', root), 'utf8'));
const payload = config.private_payloads[0];
const HERE = existsSync(new URL(payload.path, root));
const ann = config.asset_evidence.identity_annotations;

test('The identity annotations of the real asset are committed as coordinates only', () => {
  // IR-1 outline, module, three lenses, artwork, printed text; normalized; provisional until the owner confirms; no pixels
  assert.equal(ann.status, 'PROVISIONAL_ANNOTATION_NOT_OWNER_CONFIRMED');
  assert.equal(ann.lenses.length, 3);
  assert.equal(ann.visible_lens_openings, 3);
  assert.ok(ann.outline.length >= 8 && ann.outline.every(([x, y]) => x >= 0 && x <= 1 && y >= 0 && y <= 1));
  assert.deepEqual(ann.text_regions.map((r) => r.region_id), ['printed-text']);
  assert.doesNotMatch(JSON.stringify(ann), /base64|data:image/);
  assert.equal(ann.source_size_px.width, config.owned_records.find((r) => r.ref === payload.ref).metadata.width_px);
});

test('The real case: a new background, scale and relighting PASS; stretch, a removed lens, faded printed text and a hue change FAIL', { skip: !HERE && 'the private asset payload is not available here' }, async () => {
  const bytes = new Uint8Array(await readFile(new URL(payload.path, root)));
  const sha = (b) => createHash('sha256').update(b).digest('hex');
  assert.equal(sha(bytes), payload.sha256);
  const SW = ann.source_size_px.width; const SH = ann.source_size_px.height;
  const outlinePx = ann.outline.map(([x, y]) => [x * SW, y * SH]);
  const bx = Math.min(...outlinePx.map((p) => p[0])); const by = Math.min(...outlinePx.map((p) => p[1]));
  const points = outlinePx.map((p) => p.join(',')).join(' ');
  const uri = `data:image/jpeg;base64,${Buffer.from(bytes).toString('base64')}`;
  const render = ({ s = 0.9, X = 190, Y = 140, bg = '#ffffff', sy = null, extra = '', filter = '' }) => new Uint8Array(new Resvg(
    `<svg xmlns="http://www.w3.org/2000/svg" width="1080" height="1350" viewBox="0 0 1080 1350"><defs>${filter ? `<filter id="f">${filter}</filter>` : ''}<clipPath id="c"><polygon points="${points}"/></clipPath></defs>`
    + `<rect width="1080" height="1350" fill="${bg}"/><g${filter ? ' filter="url(#f)"' : ''}><g transform="translate(${X - s * bx},${Y - (sy ?? s) * by}) scale(${s},${sy ?? s})">`
    + `<image width="${SW}" height="${SH}" clip-path="url(#c)" href="${uri}"/>${extra}</g></g></svg>`,
  ).render().asPng());
  const measure = (png) => P.measureProductFidelity({
    source: { bytes, sha256: sha(bytes), origin: 'MERCHANT_PROVIDED', width_px: SW, height_px: SH },
    derivation: {
      source_asset_ref: config.bindings.asset.ref, source_sha256: sha(bytes), derived_asset_ref: 'asset://local/identity-control', derived_sha256: sha(png),
      producer: { provider_id: 'local-control', model: 'none', region: 'none', request_id: 'control' },
    },
    candidate: { png_bytes: png },
    canvas: { width: 1080, height: 1350 },
    product_layers: [{ preservation_mode: 'IDENTITY_PRESERVE' }],
    render_log: { resolutions: [{ ref: 'asset://local/identity-control', sha256: sha(png) }], image_draws: 1 },
    expected: { source_asset_ref: config.bindings.asset.ref, pinned_sha256: sha(bytes), derived_asset_ref: 'asset://local/identity-control', piece_count: 1 },
    annotations: ann,
  });
  const failing = (observations) => observations.flatMap((o) => o.evidence.sub_observations.filter((s) => s.outcome === 'FAIL').map((s) => s.id));
  const R = (g) => `<feColorMatrix type="matrix" values="${g} 0 0 0 0  0 ${g} 0 0 0  0 0 ${g} 0 0  0 0 0 1 0"/>`;

  // IR-2 positives: what a provider edit may change
  for (const [name, spec] of Object.entries({
    'the original framing on white': {},
    'a studio background at another scale and place': { bg: '#c9d1d9', s: 0.7, X: 300, Y: 250 },
    'a dark background': { bg: '#1a1d21', s: 0.8, X: 120, Y: 200 },
    'relighting +10 %': { filter: R(1.1) },
    'relighting -20 %': { filter: R(0.8) },
  })) {
    const observations = measure(render(spec));
    assert.ok(observations.every((o) => o.outcome === 'PASS'), `${name}: ${failing(observations)} ${JSON.stringify(observations.map((o) => o.outcome))}`);
  }
  // IR-3 negatives: what a provider edit may not change
  const stretch = measure(render({ sy: 0.9 * 1.12 }));
  assert.ok(failing(stretch).includes('ANISOTROPY'));
  const noLens = measure(render({ extra: '<circle cx="411" cy="277" r="48" fill="#3a3d42"/>' }));
  assert.ok(failing(noLens).includes('LENS_COUNT'));
  const fadedText = measure(render({ extra: '<rect x="280" y="995" width="360" height="295" fill="#e8d9cc" opacity="0.9"/>' }));
  assert.ok(failing(fadedText).includes('PRINTED_TEXT_REGION:printed-text'));
  const hue = measure(render({ filter: '<feColorMatrix type="hueRotate" values="90"/>' }));
  assert.ok(failing(hue).includes('LOCAL_CHROMA_SHIFT'));
  const swapped = measure(render({ extra: '<rect x="250" y="440" width="700" height="860" fill="#4a7a6a"/>' }));
  assert.ok(failing(swapped).includes('ARTWORK'));
});
