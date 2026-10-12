import test from 'node:test';
import assert from 'node:assert/strict';

import { Resvg } from '@resvg/resvg-js';

import { decodePng } from '../src/creative-intelligence/png-pixels.js';
import { MATTE_POLICY, alphaBounds, matteProp, resizePng } from '../src/creative-production/index.js';
import {
  emptyGround, propOnBusyGround, propOnGround, propTouchingFrame, propTwoObjects,
} from './creative-layered-runtime-world.js';

const png = (svg) => new Uint8Array(new Resvg(svg).render().asPng());

// THE PLAIN-GROUND MATTE and the raster operations (`// LM-N`): a generated prop is cut out of its plain ground or refused with the measurement that failed.

test('LM-1 a single object on a plain ground is cut out: trimmed to its bounds, ground transparent, object pixels kept', () => {
  const m = matteProp({ png: propOnGround() });
  assert.equal(m.ok, true, JSON.stringify(m.reasons)); assert.deepEqual(m.reasons, []);
  const img = decodePng(m.cutout_png);
  assert.equal(img.width, m.width); assert.equal(img.height, m.height);
  assert.ok(m.width < 1024 && m.height < 1024 && m.width > 100 && m.height > 100);
  const at = (x, y) => [...img.pixels.slice((y * img.width + x) * 4, (y * img.width + x) * 4 + 4)];
  assert.deepEqual(at(Math.floor(img.width / 2), Math.floor(img.height / 2)), [122, 75, 42, 255], 'the object keeps its pixels');
  assert.equal(at(0, 0)[3], 0, 'the ground corner is transparent');
  assert.equal(m.measured.objects, 1); assert.ok(m.measured.ring_plain_share >= MATTE_POLICY.ring_min_share); assert.deepEqual(m.measured.ground, [232, 228, 220]);
});

test('LM-2 every way a prop can fail is refused with its own reason, and nothing is relaxed to pass', () => {
  const cases = [
    ['a ground that is not plain', propOnBusyGround(), 'THE_GROUND_IS_NOT_PLAIN'],
    ['two objects', propTwoObjects(), 'MORE_THAN_ONE_OBJECT'],
    ['an object off the frame', propTouchingFrame(), 'THE_OBJECT_TOUCHES_THE_FRAME'],
    ['nothing on the ground', emptyGround(), 'NO_OBJECT_ON_THE_GROUND'],
    ['not a png', new Uint8Array([1, 2, 3]), 'THE_PROP_IS_NOT_A_DECODABLE_PNG'],
  ];
  for (const [name, png, reason] of cases) {
    const m = matteProp({ png });
    assert.equal(m.ok, false, name); assert.ok(m.reasons.includes(reason), `${name}: ${m.reasons}`); assert.equal(m.cutout_png, null);
  }
  // an object that runs off the frame on any one side
  const off = (x, y) => png(`<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024"><rect width="1024" height="1024" fill="#e8e4dc"/><ellipse cx="${x}" cy="${y}" rx="200" ry="200" fill="#7a4b2a"/></svg>`);
  for (const [side, x, y] of [['left', 150, 512], ['right', 880, 512], ['top', 512, 150], ['bottom', 512, 880]]) {
    const m = matteProp({ png: off(x, y) });
    assert.ok(m.reasons.includes('THE_OBJECT_TOUCHES_THE_FRAME'), `${side}: ${m.reasons}`);
  }
  assert.equal(matteProp({ png: off(512, 512) }).ok, true);
  // the size of the object is judged against the declared bounds
  assert.ok(matteProp({ png: propOnGround(), policy: { ...MATTE_POLICY, max_area_share: 0.05 } }).reasons.includes('THE_OBJECT_IS_TOO_LARGE'));
  assert.ok(matteProp({ png: propOnGround(), policy: { ...MATTE_POLICY, min_area_share: 0.5, max_area_share: 0.9 } }).reasons.includes('THE_OBJECT_IS_TOO_SMALL'));
  assert.ok(matteProp({ png: propOnGround(), policy: { ...MATTE_POLICY, ring_tolerance: -1 } }).reasons.includes('THE_GROUND_IS_NOT_PLAIN'));
});

test('LM-3 the matte is deterministic, and a few stray pixels are dropped while a real second object is not', () => {
  assert.deepEqual([...matteProp({ png: propOnGround() }).cutout_png], [...matteProp({ png: propOnGround() }).cutout_png]);
  const speckled = png(`<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024"><rect width="1024" height="1024" fill="#e8e4dc"/><ellipse cx="512" cy="512" rx="225" ry="307" fill="#7a4b2a"/><rect x="80" y="80" width="6" height="6" fill="#202020"/></svg>`);
  const dropped = matteProp({ png: speckled });
  assert.equal(dropped.ok, true, JSON.stringify(dropped.reasons)); assert.equal(dropped.measured.objects, 2); assert.ok(dropped.measured.stray_share > 0 && dropped.measured.stray_share <= MATTE_POLICY.max_stray_share);
  const img = decodePng(dropped.cutout_png);
  assert.ok(dropped.width < 500, 'the speck is not part of the cut-out: it is trimmed to the object'); assert.equal(img.width, dropped.width);
  assert.equal(matteProp({ png: speckled, policy: { ...MATTE_POLICY, max_stray_share: 0 } }).ok, false, 'the stray share is a declared limit');
  assert.equal(matteProp({ png: propTwoObjects() }).ok, false);
});

test('LM-4 resizePng resamples to exactly the requested size and alphaBounds reads the opaque bounds', () => {
  const m = matteProp({ png: propOnGround() });
  const r = resizePng({ png: m.cutout_png, width: 40, height: 60 });
  const img = decodePng(r.png);
  assert.deepEqual([img.width, img.height, r.width, r.height], [40, 60, 40, 60]);
  assert.equal(resizePng({ png: m.cutout_png, width: m.width, height: m.height }).png, m.cutout_png, 'the same size is returned as it is');
  const bounds = alphaBounds(img);
  assert.ok(bounds.x0 >= 0 && bounds.x1 <= 40 && bounds.y1 <= 60 && bounds.x1 > bounds.x0);
  assert.equal(alphaBounds({ width: 2, height: 2, pixels: new Uint8Array(16) }), null);
  assert.deepEqual(alphaBounds({ width: 3, height: 2, pixels: new Uint8Array([0, 0, 0, 0, 5, 5, 5, 255, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]) }), { x0: 1, y0: 0, x1: 2, y1: 1 });
});

test('LM-5 a ground with a slight gradient is plain, the edge of the object is soft, a large object is refused, and a size is rounded', () => {
  const gradient = png(`<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024"><defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#e8e4dc"/><stop offset="1" stop-color="#dcd8d0"/></linearGradient></defs><rect width="1024" height="1024" fill="url(#g)"/><ellipse cx="512" cy="512" rx="225" ry="307" fill="#7a4b2a"/></svg>`);
  const m = matteProp({ png: gradient });
  assert.equal(m.ok, true, JSON.stringify(m.reasons)); assert.ok(m.measured.area_share < 0.3, 'the ground is not part of the object');
  const img = decodePng(m.cutout_png);
  const alphas = new Set(); for (let i = 3; i < img.pixels.length; i += 4) alphas.add(img.pixels[i]);
  assert.ok(alphas.has(0) && alphas.has(255) && [...alphas].some((a) => a > 0 && a < 255), 'the cut-out has a transparent ground, an opaque object and a soft edge');
  const big = png(`<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024"><rect width="1024" height="1024" fill="#e8e4dc"/><ellipse cx="512" cy="512" rx="480" ry="480" fill="#7a4b2a"/></svg>`);
  assert.ok(matteProp({ png: big }).reasons.includes('THE_OBJECT_IS_TOO_LARGE'));
  const r = resizePng({ png: m.cutout_png, width: 40.6, height: 59.4 });
  assert.deepEqual([r.width, r.height], [41, 59]);
});
