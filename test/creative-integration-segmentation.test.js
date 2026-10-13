import test from 'node:test';
import assert from 'node:assert/strict';

import * as W from './creative-integration-world.js';
import { iou, segmented } from './creative-integration-shared.js';
import {
  SEG_REASON, checkMatte, createSegmentationCache, segmentProduct, validateSegmentation,
} from '../src/creative-integration/index.js';

// General segmentation (`// SG-N` markers): the provider-independent contract, the local plain-ground segmenter on drawn products, the selection rules, the failure reasons, the port validation and the mask cache.

test('Seven drawn products are cut out accurately: single objects, holes, thin parts, soft edges, printed graphics, mirror finish', () => {
  for (const name of Object.keys(W.ALL)) {
    const { seg, truth, rgba } = segmented(name);
    // SG-1 accepted, confident, and a valid contract value
    assert.equal(seg.status, 'OK', name); assert.equal(seg.accepted, true, name); assert.ok(seg.confidence >= 0.6, name);
    assert.deepEqual(validateSegmentation(seg, rgba), { ok: true, problems: [] }, name);
    // SG-2 against the exact drawn coverage
    assert.ok(iou(seg.alpha, truth.alpha) >= 0.99, `${name} IoU ${iou(seg.alpha, truth.alpha)}`);
    // SG-3 the local segmenter says where it ran: no provider
    assert.deepEqual(seg.source, { kind: 'LOCAL', id: 'LOCAL:plain-ground@1' });
  }
});

test('Holes are kept, printed ground-coloured graphics are not holes, thin protrusions survive', () => {
  // SG-4 the tumbler handle is a real opening: ground shows through it
  const t = segmented('tumbler'); assert.equal(t.seg.holes.length, 1);
  assert.equal(t.seg.alpha[240 * t.rgba.width + 212], 0);
  // SG-5 the phone case's cream logo bar is print (colour close to the ground), not a hole
  const c = segmented('phoneCase'); assert.equal(c.seg.holes.length, 0); assert.equal(c.seg.alpha[140 * c.rgba.width + 150], 255);
  // SG-6 the framed print's mat (ground-coloured, with the picture inside) is the interior of ONE product
  const f = segmented('framedPrint'); assert.equal(f.seg.components.length, 1); assert.equal(f.seg.alpha[200 * f.rgba.width + 160], 255);
  // SG-7 the gift box's bow (a thin protrusion above the box) is inside the matte
  const g = segmented('giftBox'); assert.equal(g.seg.alpha[70 * g.rgba.width + 180] >= 128, true);
  // SG-8 a mirror-finish bottle: a highlight that crosses the ground colour does not slice the product
  assert.equal(segmented('metallic').seg.components.length, 1);
});

test('Soft boundaries are unmixed, not thresholded: the edge pixel keeps its real coverage', () => {
  // SG-9 the phone case has anti-aliased rounded corners: partial alpha exists on the boundary
  const { seg, truth } = segmented('phoneCase');
  assert.ok(seg.edge_quality.partial_share > 0.1, String(seg.edge_quality.partial_share));
  // SG-10 and it is exact enough: the mean error against the drawn coverage on the boundary is small
  let err = 0; let n = 0;
  for (let i = 0; i < truth.alpha.length; i += 1) if (truth.alpha[i] > 0 && truth.alpha[i] < 255) { err += Math.abs(seg.alpha[i] - truth.alpha[i]); n += 1; }
  assert.ok(err / n < 40, `mean boundary alpha error ${err / n}`);
});

test('Several objects: an ambiguous selection is refused, an explicit one is cut, touching objects are separated, nothing else enters the matte', () => {
  const m = W.multiObject();
  // SG-11 AUTO with several significant objects is refused, the components are listed
  const auto = segmentProduct({ rgba: m.rgba });
  assert.equal(auto.status, 'FAILED'); assert.equal(auto.failure_reason, SEG_REASON.AMBIGUOUS_SELECTION); assert.equal(auto.components.length, 3);
  // SG-12 the touching red box and green disc are two objects (a seeded split), not one
  assert.equal(segmentProduct({ rgba: m.rgba, selection: { mode: 'GROUP' } }).split_touching, true);
  // SG-13 an explicit single object: its matte contains no pixel of the neighbours
  const one = segmentProduct({ rgba: m.rgba, selection: { mode: 'IDS', ids: ['o1'] } });
  assert.equal(one.status, 'OK');
  assert.equal(one.alpha[200 * m.rgba.width + 290], 0); assert.equal(one.alpha[200 * m.rgba.width + 398], 0);
  assert.equal(one.alpha[180 * m.rgba.width + 90], 255);
  // SG-14 a POINT selection picks the object under it
  assert.deepEqual(segmentProduct({ rgba: m.rgba, selection: { mode: 'POINT', point: [90, 180] } }).bounds, one.bounds);
  // SG-15 a selection that names nothing is refused
  assert.equal(segmentProduct({ rgba: m.rgba, selection: { mode: 'IDS', ids: ['o9'] } }).failure_reason, SEG_REASON.SELECTION_NOT_FOUND);
  assert.equal(segmentProduct({ rgba: m.rgba, selection: { mode: 'POINT', point: [5, 5] } }).failure_reason, SEG_REASON.SELECTION_NOT_FOUND);
  assert.equal(segmentProduct({ rgba: m.rgba, selection: { mode: 'NOPE' } }).failure_reason, SEG_REASON.INVALID_INPUT);
  // SG-16 a GROUP is explicit: every object is selected
  const group = segmentProduct({ rgba: m.rgba, selection: { mode: 'GROUP' } }); assert.ok(group.components.every((c) => c.selected));
});

test('A hand or a table fused with the product is never taken silently', () => {
  const h = W.handHoldingProduct();
  // SG-17 touching the image border lowers the confidence: LOW_CONFIDENCE, not accepted
  const auto = segmentProduct({ rgba: h.rgba }); assert.equal(auto.status, 'LOW_CONFIDENCE'); assert.equal(auto.accepted, false);
  // SG-18 a box that cuts through the foreground is refused (the hand continues across its edge) ...
  const box = { x0: 90, y0: 40, x1: 270, y1: 300 };
  assert.equal(segmentProduct({ rgba: h.rgba, selection: { mode: 'BOX', box } }).failure_reason, SEG_REASON.SELECTION_TOUCHES_OTHER_OBJECT);
  // SG-19 ... unless the operator accepts the cut explicitly
  assert.equal(segmentProduct({ rgba: h.rgba, selection: { mode: 'BOX', box, allow_cut: true } }).status, 'OK');
});

test('Low confidence is never silently accepted; a ground that is not plain, a product that is the ground colour, and mirror highlights equal to the ground all stop', () => {
  // SG-20 a cluttered ground
  assert.equal(segmentProduct({ rgba: W.clutteredGround().rgba }).failure_reason, SEG_REASON.BACKGROUND_NOT_PLAIN);
  // SG-21 an empty photograph
  assert.equal(segmentProduct({ rgba: W.blank(200, 200) }).failure_reason, SEG_REASON.NO_FOREGROUND);
  // SG-22 a white product on a near-white ground: the segmenter may or may not accept it, but the two layers together never deliver it (low confidence, or a matte that fails its checks)
  const lowRgba = W.lowContrast().rgba; const low = segmentProduct({ rgba: lowRgba });
  assert.ok(low.accepted === false || checkMatte({ rgba: lowRgba, alpha: low.alpha, ground: low.ground }).valid === false);
  // SG-23 a bottle whose highlights are the ground colour falls apart into several objects: refused, not cut wrongly
  assert.equal(segmentProduct({ rgba: W.metallicOnLightGround().rgba }).accepted, false);
  // SG-24 a failed result has no mask, a reason, and zero confidence
  const failed = segmentProduct({ rgba: W.clutteredGround().rgba }); assert.equal(failed.alpha, null); assert.equal(failed.confidence, 0);
  // SG-25 garbage input never throws
  for (const bad of [null, {}, { width: 2, height: 2, pixels: new Uint8Array(3) }]) assert.equal(segmentProduct({ rgba: bad }).failure_reason, SEG_REASON.INVALID_INPUT);
});

test('The segmentation contract is provider independent: a port is validated by the same rules, and a violation is a failure', () => {
  const f = segmented('magnet'); const { rgba } = f;
  const good = (over = {}) => ({ id: 'fake', segment: () => ({ ...f.seg, ...over }) });
  // SG-26 a conforming port is accepted and labelled as a port
  const ok = segmentProduct({ rgba, port: good() }); assert.equal(ok.status, 'OK'); assert.equal(ok.source.kind, 'PORT'); assert.equal(ok.source.id, 'PORT:fake');
  // SG-27 a port below the minimum confidence is LOW_CONFIDENCE and not accepted
  const low = segmentProduct({ rgba, port: good({ confidence: 0.4 }) }); assert.equal(low.status, 'LOW_CONFIDENCE'); assert.equal(low.accepted, false);
  // SG-28 contract violations: wrong alpha size, confidence out of range, bounds that do not match the alpha, missing edge quality, unknown status
  const violations = [{ alpha: new Uint8Array(10) }, { confidence: 1.5 }, { bounds: { x0: 0, y0: 0, x1: 5, y1: 5 } }, { edge_quality: null }, { status: 'MAYBE' }, { confidence: Number.NaN }];
  for (const v of violations) { const r = segmentProduct({ rgba, port: good(v) }); assert.equal(r.failure_reason, SEG_REASON.PORT_CONTRACT_VIOLATION, JSON.stringify(Object.keys(v))); assert.equal(r.accepted, false); }
  // SG-29 a port that throws is a failure, not an exception
  assert.equal(segmentProduct({ rgba, port: { id: 'boom', segment: () => { throw new Error('down'); } } }).failure_reason, SEG_REASON.PORT_FAILED);
  // SG-30 a port that reports its own failure keeps its reason
  const own = segmentProduct({ rgba, port: { id: 'x', segment: () => ({ status: 'FAILED', failure_reason: 'NO_PRODUCT_FOUND' }) } }); assert.equal(own.failure_reason, 'NO_PRODUCT_FOUND'); assert.equal(own.accepted, false);
  // SG-31 validateSegmentation: an all-zero alpha has no bounds
  assert.equal(validateSegmentation({ status: 'OK', alpha: new Uint8Array(rgba.width * rgba.height), confidence: 1, bounds: { x0: 0, y0: 0, x1: 1, y1: 1 }, edge_quality: {} }, rgba).ok, false);
});

test('The mask is reused when the source and the selection are unchanged: no second provider call, same bytes', () => {
  const { rgba } = segmented('magnet'); const cache = createSegmentationCache(); let calls = 0;
  const port = { id: 'counting', segment: () => { calls += 1; return segmented('magnet').seg; } };
  // SG-32 a port is called once for the same source + selection
  const a = segmentProduct({ rgba, port, cache }); const b = segmentProduct({ rgba, port, cache });
  assert.equal(calls, 1); assert.equal(a, b); assert.equal(cache.stats.hits, 1);
  // SG-33 a different selection is a different entry
  segmentProduct({ rgba, port, cache, selection: { mode: 'GROUP' } }); assert.equal(calls, 2);
  // SG-34 a changed source is a different entry
  const other = { ...rgba, pixels: Uint8Array.from(rgba.pixels) }; other.pixels[0] ^= 1; segmentProduct({ rgba: other, port, cache }); assert.equal(calls, 3);
  // SG-35 the local analysis is shared between selections of one source
  const m = W.multiObject(); const c2 = createSegmentationCache();
  segmentProduct({ rgba: m.rgba, selection: { mode: 'IDS', ids: ['o1'] }, cache: c2 }); const before = c2.stats.hits;
  segmentProduct({ rgba: m.rgba, selection: { mode: 'IDS', ids: ['o2'] }, cache: c2 }); assert.ok(c2.stats.hits > before);
});

test('The local segmenter is deterministic', () => {
  // SG-36 the same photograph gives the same matte, byte for byte
  const { rgba } = segmented('giftBox'); const again = segmentProduct({ rgba });
  assert.deepEqual(Buffer.from(again.alpha), Buffer.from(segmented('giftBox').seg.alpha));
});
