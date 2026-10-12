import test from 'node:test';
import assert from 'node:assert/strict';

import { BrainError } from '../src/creative-brain/validation.js';
import {
  ANALYSIS_STATUS, buildInventory, createContentFormatPlanner, normalizeObservation, normalizeRequest, ratioOf, SOURCE_KIND, sourceBytesOf, understandInputs,
} from '../src/creative-planning/index.js';

// THE REQUEST AND THE INPUT UNDERSTANDING (`// RU-N` markers): one closed request contract; one normalized observation for every kind of input; ports are optional and isolated.

const base = (over = {}) => ({ request_ref: 'req:1', copy: [{ copy_ref: 'copy://a', mode: 'COPY_LOCKED', role: 'HEADLINE', text: 'Bonjour Namur' }], ...over });
const rejects = (raw, fragment) => assert.throws(() => normalizeRequest(raw), (e) => e instanceof BrainError && (fragment ? (e.field ?? '').includes(fragment) || e.message.includes(fragment) : true));

test('RU-1 a request is closed: unknown keys, missing text, wrong modes and duplicates are refused', () => {
  const ok = normalizeRequest(base());
  assert.equal(ok.locale, 'en'); assert.equal(ok.objective, 'UNKNOWN'); assert.equal(ok.audience, 'UNKNOWN'); assert.deepEqual(ok.channels, []);
  assert.ok(Object.isFrozen(ok) && Object.isFrozen(ok.copy[0]));
  rejects(base({ surprise: 1 }), 'surprise');
  rejects({ copy: [] }, 'request_ref');
  rejects(base({ copy: [{ copy_ref: 'c', mode: 'COPY_LOCKED' }] }), 'text');
  rejects(base({ copy: [{ copy_ref: 'c', mode: 'COPY_GENERATABLE', purpose: 'HEADLINE', text: 'x' }] }), 'text');
  rejects(base({ copy: [{ copy_ref: 'c', mode: 'COPY_GENERATABLE' }] }), 'purpose');
  rejects(base({ copy: [{ copy_ref: 'c', mode: 'COPY_REWRITE_FREELY', text: 'x' }] }), 'mode');
  rejects(base({ copy: [{ copy_ref: 'c', mode: 'COPY_LOCKED', text: 'a' }, { copy_ref: 'c', mode: 'COPY_LOCKED', text: 'b' }] }), 'copy');
  rejects(base({ copy: [{ copy_ref: 'c', mode: 'COPY_ADAPTABLE', text: 'a', fact_refs: ['missing'] }] }), 'copy');
  rejects(base({ locale: 'not a tag' }), 'locale');
  rejects(base({ requested_format: 'BILLBOARD' }), 'requested_format');
});

test('RU-2 constraints: MAX_ASSETS needs a whole number, the others take none, no repeats', () => {
  assert.equal(normalizeRequest(base({ constraints: [{ kind: 'MAX_ASSETS', value: 3 }, { kind: 'ALL_TEXT_ON_ASSET' }] })).constraints.length, 2);
  rejects(base({ constraints: [{ kind: 'MAX_ASSETS' }] }), 'value');
  rejects(base({ constraints: [{ kind: 'MAX_ASSETS', value: 2.5 }] }), 'value');
  rejects(base({ constraints: [{ kind: 'ALL_TEXT_ON_ASSET', value: 1 }] }), 'value');
  rejects(base({ constraints: [{ kind: 'ALL_TEXT_ON_ASSET' }, { kind: 'ALL_TEXT_ON_ASSET' }] }), 'constraints');
  rejects(base({ requested_asset_count: 0 }), 'requested_asset_count');
});

test('RU-3 a caller canvas must state a reduced aspect ratio that follows from its dimensions', () => {
  const canvas = { format_ref: 'format://x/1', canvas: { width: 1080, height: 1350, unit: 'px' }, medium: 'DIGITAL', aspect_ratio: '4:5' };
  assert.equal(normalizeRequest(base({ canvas })).canvas.aspect_ratio, '4:5');
  assert.equal(normalizeRequest(base({ canvas: { ...canvas, aspect_ratio: undefined } })).canvas.aspect_ratio, '4:5');
  rejects(base({ canvas: { ...canvas, aspect_ratio: '1:1' } }), 'aspect_ratio');
  rejects(base({ canvas: { ...canvas, canvas: { width: 10, height: 10, unit: 'px' } } }), 'width');
  assert.equal(ratioOf(1448, 2048), '181:256');
});

test('RU-4 sources: each kind has its contract; bytes are never kept in the request', () => {
  const raw = base({
    sources: [
      { source_kind: 'PRODUCT_IMAGE', ref: 'asset://p', width_px: 600, height_px: 800, bytes: new Uint8Array([1, 2, 3]), media_type: 'image/png' },
      { source_kind: 'REFERENCE_IMAGE', ref: 'asset://style', role: 'STYLE' },
      { source_kind: 'UPLOADED_FILE', ref: 'file://brochure', media_type: 'application/pdf', bytes_length: 1000 },
      { source_kind: 'TEXT', ref: 'text://long', text: 'Un long texte.' },
      { source_kind: 'STRUCTURED_FACTS', ref: 'facts://f', facts: [{ fact_ref: 'fact://price', kind: 'PRICE', status: 'VERIFIED', statement: '25 € la coque' }] },
    ],
  });
  const req = normalizeRequest(raw);
  assert.equal(req.sources.length, 5);
  assert.equal(req.sources[0].role, 'PRODUCT'); assert.equal(req.sources[1].role, 'STYLE'); assert.equal(req.sources[3].role, 'CONTENT');
  assert.ok(!JSON.stringify(req).includes('"bytes"'), 'the request keeps no bytes');
  assert.equal(sourceBytesOf(raw).get('asset://p').length, 3);
  rejects(base({ sources: [{ source_kind: 'TEXT', ref: 't' }] }), 'text');
  rejects(base({ sources: [{ source_kind: 'STRUCTURED_FACTS', ref: 'f' }] }), 'facts');
  rejects(base({ sources: [{ source_kind: 'VIDEO_CLIP', ref: 'v' }] }), 'source_kind');
  rejects(base({ sources: [{ source_kind: 'PRODUCT_IMAGE', ref: 'p', width_px: -1 }] }), 'width_px');
});

test('RU-5 without a port every input has a deterministic observation, with its honest analysis status', async () => {
  const req = normalizeRequest(base({
    locale: 'fr-BE',
    sources: [
      { source_kind: 'PRODUCT_IMAGE', ref: 'asset://p', width_px: 600, height_px: 800 },
      { source_kind: 'REFERENCE_IMAGE', ref: 'asset://style' },
      { source_kind: 'TEXT', ref: 'text://t', text: 'Notre atelier est à Namur. Venez nous voir.' },
      { source_kind: 'STRUCTURED_FACTS', ref: 'facts://f', facts: [{ fact_ref: 'fact://a', kind: 'DESCRIPTIVE', status: 'VERIFIED', statement: 'Atelier à Namur' }] },
    ],
  }));
  const obs = await understandInputs({ sources: req.sources, locale: 'fr-BE' });
  assert.deepEqual(obs.map((o) => o.analysis.status), [ANALYSIS_STATUS.METADATA_ONLY, ANALYSIS_STATUS.NOT_ANALYZED, ANALYSIS_STATUS.ANALYZED, ANALYSIS_STATUS.ANALYZED]);
  assert.equal(obs[0].measured.width_px, 600); assert.equal(obs[2].measured.words, 8); assert.equal(obs[3].facts.length, 1);
  assert.ok(obs.every((o) => o.analysis.analyzer === 'DETERMINISTIC' && o.descriptors.length === 0));
  for (const o of obs) assert.deepEqual(normalizeObservation(JSON.parse(JSON.stringify(o))), o);
});

test('RU-6 a connected port enriches an observation; the bytes go to the port and nowhere else', async () => {
  const seen = [];
  const ports = { [SOURCE_KIND.REFERENCE_IMAGE]: { async understand({ source, bytes }) { seen.push([source.ref, bytes?.length ?? null]); return { descriptors: ['a portrait photograph on a plain background'], facts: [] }; } } };
  const raw = base({ sources: [{ source_kind: 'REFERENCE_IMAGE', ref: 'asset://style', bytes: new Uint8Array(7) }] });
  const req = normalizeRequest(raw);
  const [o] = await understandInputs({ sources: req.sources, bytes: sourceBytesOf(raw), ports });
  assert.deepEqual(seen, [['asset://style', 7]]);
  assert.equal(o.analysis.analyzer, 'PORT'); assert.equal(o.analysis.status, ANALYSIS_STATUS.ANALYZED); assert.deepEqual(o.descriptors, ['a portrait photograph on a plain background']);
  assert.ok(!JSON.stringify(o).includes('"bytes"'));
});

test('RU-7 a failing or invalid port never stops the plan: the observation is NOT_ANALYZED with safe diagnostics only', async () => {
  const req = normalizeRequest(base({ sources: [{ source_kind: 'PRODUCT_IMAGE', ref: 'asset://p' }, { source_kind: 'REFERENCE_IMAGE', ref: 'asset://r' }] }));
  const ports = {
    PRODUCT_IMAGE: { async understand() { throw Object.assign(new Error('secret key sk-123 leaked in the message'), { code: 'UPSTREAM_DOWN' }); } },
    REFERENCE_IMAGE: { async understand() { return { descriptors: ['x'.repeat(500)] }; } },
  };
  const obs = await understandInputs({ sources: req.sources, ports });
  assert.deepEqual(obs.map((o) => o.analysis.status), ['NOT_ANALYZED', 'NOT_ANALYZED']);
  assert.equal(obs[0].analysis.failure_code, 'UPSTREAM_DOWN');
  assert.equal(obs[1].analysis.failure_code, 'BRAIN_TEXT_INVALID');
  assert.ok(!JSON.stringify(obs).includes('sk-123'), 'no message of a failure is kept');
  const planner = createContentFormatPlanner({ understanding: ports });
  const plan = await planner.plan(base({ sources: [{ source_kind: 'PRODUCT_IMAGE', ref: 'asset://p' }] }));
  assert.equal(plan.status, 'PLANNED');
});

test('RU-8 a stored observation is re-validated: tampering with its content breaks its id', async () => {
  const req = normalizeRequest(base({ sources: [{ source_kind: 'TEXT', ref: 'text://t', text: 'Bonjour' }] }));
  const [o] = await understandInputs({ sources: req.sources });
  const copy = JSON.parse(JSON.stringify(o));
  copy.text = 'Bonjour tout le monde';
  assert.throws(() => normalizeObservation(copy), /does not follow/);
  const extra = { ...JSON.parse(JSON.stringify(o)), extra: 1 };
  assert.throws(() => normalizeObservation(extra), BrainError);
});

test('RU-9 the planner consumes observations: a text source becomes a LOCKED unit, structured facts join the inventory, the product image is measured', async () => {
  const req = normalizeRequest(base({
    copy: [],
    sources: [
      { source_kind: 'TEXT', ref: 'text://desc', text: 'Une description longue à garder telle quelle.' },
      { source_kind: 'PRODUCT_IMAGE', ref: 'asset://p', width_px: 600, height_px: 800 },
      { source_kind: 'REFERENCE_IMAGE', ref: 'asset://r', role: 'LAYOUT' },
      { source_kind: 'STRUCTURED_FACTS', ref: 'facts://f', facts: [{ fact_ref: 'fact://price', kind: 'PRICE', status: 'VERIFIED', statement: '25 €' }] },
    ],
  }));
  const obs = await understandInputs({ sources: req.sources });
  const inv = buildInventory({ request: req, observations: obs });
  assert.equal(inv.units.length, 1); assert.equal(inv.units[0].mode, 'COPY_LOCKED'); assert.equal(inv.units[0].origin, 'OBSERVATION');
  assert.equal(inv.facts.length, 1); assert.deepEqual(inv.product_image.width_px, 600); assert.deepEqual(inv.reference_roles, ['LAYOUT']);
  assert.match(inv.inventory_id, /^cin_/);
  assert.equal(buildInventory({ request: req, observations: obs }).inventory_id, inv.inventory_id, 'deterministic');
});
