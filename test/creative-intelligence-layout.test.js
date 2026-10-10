import test from 'node:test';
import assert from 'node:assert/strict';

import * as CI from '../src/creative-intelligence/index.js';
import {
  ASSET_LOGO, ASSET_PHOTO, ASSET_PRODUCT, CLAIM_PRICE, FONT, FONT_AR_EXACT, LATER, assetDims, backgroundLayer, clone, code, demoDocument, demoLayers, documentParts,
  fonts, isDeepFrozen, logoLayer, outputContext, productLayer, solved, textLayer,
} from './creative-intelligence-fixtures.js';

// `// N text` markers are rows of the coverage matrix (docs/architecture/creative-intelligence-v1.md).

const ctx = (over) => CI.normalizeOutputContext(outputContext(over));
const rect = (r) => [r.x, r.y, r.width, r.height];
const overlaps = (a, b) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

// ------------------------------------------------------------------ safe zones, forbidden zones, constraints (116-130)

test('Usable area: margins, safe zones, forbidden zones and negative space - all deterministic', () => {
  // 116 with no zone the usable area is the canvas minus the margin
  assert.deepEqual(rect(CI.computeUsableRect(ctx({ safe_zones: [] }), { marginRatio: 0.1 })), [108, 108, 864, 1134]);
  // 117 a safe zone restricts the usable area (the largest safe zone, intersected with the margins)
  assert.deepEqual(rect(CI.computeUsableRect(ctx({ safe_zones: [{ zone_id: 'small', x: 0, y: 0, width: 100, height: 100 }, { zone_id: 'big', x: 200, y: 200, width: 600, height: 800 }] }), { marginRatio: 0.05 })), [200, 200, 600, 800]);
  // 118 a forbidden zone is carved out of the usable area (the biggest remaining rectangle)
  const carved = CI.computeUsableRect(ctx({ safe_zones: [], forbidden_zones: [{ zone_id: 'ui-bar', x: 0, y: 1100, width: 1080, height: 250 }] }), { marginRatio: 0 });
  assert.deepEqual(rect(carved), [0, 0, 1080, 1100]);
  // 119 forbidden zones that leave nothing make the layout unsatisfiable
  assert.equal(code(() => CI.computeUsableRect(ctx({ safe_zones: [], forbidden_zones: [{ zone_id: 'all', x: 0, y: 0, width: 1080, height: 1350 }] }), { marginRatio: 0 })), CI.CI_ERROR.LAYOUT_UNSATISFIABLE);
  // 120 margins that push the usable area out of the only safe zone make it unsatisfiable
  assert.equal(code(() => CI.computeUsableRect(ctx({ safe_zones: [{ zone_id: 'corner', x: 0, y: 0, width: 20, height: 20 }] }), { marginRatio: 0.2 })), CI.CI_ERROR.LAYOUT_UNSATISFIABLE);
  // 121 negative space TOP is reserved at the top
  const plain = CI.computeUsableRect(ctx({ safe_zones: [] }), { marginRatio: 0 });
  const top = CI.computeUsableRect(ctx({ safe_zones: [] }), { marginRatio: 0, negativeSpace: 'TOP' });
  assert.ok(top.y > plain.y && top.height < plain.height);
  // 122 negative space START / END follow the reading direction (START is the right edge in RTL)
  const ltr = CI.computeUsableRect(ctx({ safe_zones: [] }), { marginRatio: 0, negativeSpace: 'START' });
  const rtl = CI.computeUsableRect(ctx({ safe_zones: [], locale: 'ar-SA', direction: 'RTL' }), { marginRatio: 0, negativeSpace: 'START' });
  assert.ok(ltr.x > 0);
  assert.equal(rtl.x, 0);
  assert.ok(rtl.width < 1080);
  // 123 SURROUNDING negative space shrinks every side
  const around = CI.computeUsableRect(ctx({ safe_zones: [] }), { marginRatio: 0, negativeSpace: 'SURROUNDING' });
  assert.ok(around.x > 0 && around.y > 0 && around.width < 1080 && around.height < 1350);
  // 124 a MIN_MARGIN constraint raises the margin the solver uses
  const doc = demoDocument();
  const layers = clone(doc.layers).map((l) => (l.id === 'price' ? { ...l, constraints: [{ kind: 'MIN_MARGIN', subject: null, target: null, value: 200 }] } : l));
  const wide = CI.solveLayout({ document: CI.reviseDesignDocument(doc, { layers, created_at: LATER }), recipe_id: 'PRODUCT_HERO', fonts: fonts(), assets: assetDims(), created_at: LATER });
  assert.ok(wide.usable_rect.x >= 200);
  // 125 NO_OVERLAP is evaluated
  const L = (id, x, y, constraints = []) => CI.normalizeLayer({ ...logoLayer({ id, geometry: { x, y, width: 100, height: 100, rotation_deg: 0 } }), constraints });
  const evalC = (layerList, constraints = []) => CI.evaluateConstraints({ layers: layerList, constraints, output_context: ctx() });
  assert.equal(evalC([L('a', 0, 0, [{ kind: 'NO_OVERLAP', target: 'b' }]), L('b', 50, 50)]).length, 1);
  assert.equal(evalC([L('a', 0, 0, [{ kind: 'NO_OVERLAP', target: 'b' }]), L('b', 300, 300)]).length, 0);
  // 126 ABOVE / BELOW are evaluated
  assert.equal(evalC([L('a', 0, 0, [{ kind: 'ABOVE', target: 'b' }]), L('b', 0, 200)]).length, 0);
  assert.equal(evalC([L('a', 0, 300, [{ kind: 'ABOVE', target: 'b' }]), L('b', 0, 200)]).length, 1);
  assert.equal(evalC([L('a', 0, 300, [{ kind: 'BELOW', target: 'b' }]), L('b', 0, 100)]).length, 0);
  assert.equal(evalC([L('a', 0, 100, [{ kind: 'BELOW', target: 'b' }]), L('b', 0, 100)]).length, 1);
  // 127 ALIGN_CENTER_X is evaluated
  assert.equal(evalC([L('a', 0, 0, [{ kind: 'ALIGN_CENTER_X', target: 'b' }]), L('b', 0, 300)]).length, 0);
  assert.equal(evalC([L('a', 0, 0, [{ kind: 'ALIGN_CENTER_X', target: 'b' }]), L('b', 40, 300)]).length, 1);
  // 128 WITHIN_SAFE_ZONE is evaluated against the output context
  assert.equal(evalC([L('a', 100, 200, [{ kind: 'WITHIN_SAFE_ZONE' }])]).length, 0);
  assert.equal(evalC([L('a', 0, 0, [{ kind: 'WITHIN_SAFE_ZONE' }])]).length, 1);
  // 129 a constraint whose target does not exist is reported, not ignored
  assert.equal(evalC([L('a', 0, 0, [{ kind: 'NO_OVERLAP', target: 'ghost' }])])[0].reason, 'TARGET_MISSING');
  assert.equal(evalC([], [{ kind: 'WITHIN_SAFE_ZONE', subject: 'ghost', target: null, value: null }])[0].reason, 'SUBJECT_MISSING');
  // 130 a hidden layer is not constrained
  const hidden = CI.normalizeLayer({ ...logoLayer({ id: 'h', geometry: { x: 0, y: 0, width: 100, height: 100, rotation_deg: 0 }, visibility: 'HIDDEN' }), constraints: [{ kind: 'WITHIN_SAFE_ZONE', subject: null, target: null, value: null }] });
  assert.equal(evalC([hidden]).length, 0);
});

// ------------------------------------------------------------------ layout recipes and solver (131-150)

test('Layout recipes are declarative; the solver places layers deterministically and honestly', () => {
  // 131 five generic recipes exist (closed set)
  assert.deepEqual([...CI.LAYOUT_RECIPE_IDS].sort(), ['EDITORIAL_SPLIT', 'PRODUCT_AND_PRICE', 'PRODUCT_DOMINANT', 'PRODUCT_HERO', 'TEXT_LED']);
  assert.equal(CI.getLayoutRecipe('SOMETHING_ELSE'), null);
  // 132 every slot is a fraction of the usable area (0..1) and carries no merchant, font or colour
  for (const id of CI.LAYOUT_RECIPE_IDS) {
    const recipe = CI.getLayoutRecipe(id);
    assert.deepEqual(Object.keys(recipe).sort(), ['description', 'margin_ratio', 'mirror_on_rtl', 'recipe_id', 'slots']);
    for (const s of recipe.slots) {
      const media = s.role === 'PRODUCT' || s.role === 'LOGO';
      assert.deepEqual(Object.keys(s).sort(), media ? ['align', 'h', 'role', 'w', 'x', 'y'] : ['h', 'role', 'w', 'x', 'y']);
      if (media) assert.ok(['START', 'CENTER', 'END'].includes(s.align), `${id}/${s.role}: the picture alignment is explicit recipe data`);
      assert.ok(s.x >= 0 && s.y >= 0 && s.x + s.w <= 1.0001 && s.y + s.h <= 1.0001, `${id}/${s.role}`);
    }
  }
  // 133 the slots of a recipe never overlap (collisions are excluded by construction)
  for (const id of CI.LAYOUT_RECIPE_IDS) {
    const slots = CI.getLayoutRecipe(id).slots.map((s) => ({ x: s.x, y: s.y, width: s.w, height: s.h, role: s.role }));
    for (let i = 0; i < slots.length; i += 1) for (let j = i + 1; j < slots.length; j += 1) assert.ok(!overlaps(slots[i], slots[j]), `${id}: ${slots[i].role}/${slots[j].role}`);
  }
  // 134 same input -> same output (document id included)
  assert.equal(solved().document.document_id, solved().document.document_id);
  assert.equal(JSON.stringify(solved()), JSON.stringify(solved()));
  // 135 the demo layout is solved with no violation
  const out = solved();
  assert.equal(out.status, 'SOLVED');
  assert.deepEqual(out.violations, []);
  assert.ok(isDeepFrozen(out));
  // 136 the product keeps its real aspect ratio (800 x 1000 -> 0.8)
  const product = out.document.layers.find((l) => l.id === 'product');
  assert.ok(Math.abs(product.geometry.width / product.geometry.height - 0.8) < 0.002);
  // 137 the logo keeps its aspect ratio (600 x 200 -> 3) and sits on the start edge
  const logo = out.document.layers.find((l) => l.id === 'logo');
  assert.ok(Math.abs(logo.geometry.width / logo.geometry.height - 3) < 0.02);
  assert.equal(logo.geometry.x, out.usable_rect.x);
  // 138 every text is inside its slot and never below its minimum size
  for (const t of out.document.layers.filter((l) => l.type === 'TEXT')) assert.ok(t.font_size >= t.min_font_size, t.id);
  // 139 a text that is too big is shrunk to fit - and only down to its minimum
  const crowded = CI.reviseDesignDocument(demoDocument(), {
    layers: clone(demoDocument().layers).map((l) => (l.id === 'headline' ? { ...l, content: 'Un objet personnalisé avec vos plus belles photos', font_size: 120, min_font_size: 40, max_lines: 3 } : l)),
    created_at: LATER,
  });
  // the digest of a NON_CLAIM text is null, so changing its content is legitimate
  const shrunk = CI.solveLayout({ document: crowded, recipe_id: 'PRODUCT_HERO', fonts: fonts(), assets: assetDims(), created_at: LATER });
  const headline = shrunk.document.layers.find((l) => l.id === 'headline');
  assert.ok(headline.font_size < 120 && headline.font_size >= 40);
  // 140 a text that cannot fit even at its minimum is reported with its overflow policy and stays at the minimum
  const impossible = CI.reviseDesignDocument(demoDocument(), {
    layers: clone(demoDocument().layers).map((l) => (l.id === 'headline' ? { ...l, content: 'Un objet personnalisé avec vos plus belles photos de vacances en famille', font_size: 140, min_font_size: 120, max_lines: 1, overflow_policy: 'REWRITE_REQUIRED' } : l)),
    created_at: LATER,
  });
  const failed = CI.solveLayout({ document: impossible, recipe_id: 'PRODUCT_HERO', fonts: fonts(), assets: assetDims(), created_at: LATER });
  assert.equal(failed.status, 'UNSATISFIED');
  const v = failed.violations.find((x) => x.code === 'TEXT_DOES_NOT_FIT');
  assert.equal(v.overflow_policy, 'REWRITE_REQUIRED');
  assert.equal(failed.document.layers.find((l) => l.id === 'headline').font_size, 120);
  assert.equal(failed.document.layers.find((l) => l.id === 'headline').content, 'Un objet personnalisé avec vos plus belles photos de vacances en famille');
  // 141 a locked layer is never moved
  const lockedLayers = clone(demoDocument().layers).map((l) => (l.id === 'logo' ? { ...l, locked: true } : l));
  const lockedDoc = CI.reviseDesignDocument(demoDocument(), { layers: lockedLayers, created_at: LATER });
  const keep = CI.solveLayout({ document: lockedDoc, recipe_id: 'PRODUCT_HERO', fonts: fonts(), assets: assetDims(), created_at: LATER });
  assert.deepEqual(keep.document.layers.find((l) => l.id === 'logo').geometry, lockedDoc.layers.find((l) => l.id === 'logo').geometry);
  assert.deepEqual(keep.unplaced.find((u) => u.layer_id === 'logo'), { layer_id: 'logo', reason: 'LOCKED' });
  // 142 a hidden layer is skipped
  const hiddenLayers = clone(demoDocument().layers).map((l) => (l.id === 'cta' ? { ...l, visibility: 'HIDDEN' } : l));
  const skip = CI.solveLayout({ document: CI.reviseDesignDocument(demoDocument(), { layers: hiddenLayers, created_at: LATER }), recipe_id: 'PRODUCT_HERO', fonts: fonts(), assets: assetDims(), created_at: LATER });
  assert.deepEqual(skip.unplaced.find((u) => u.layer_id === 'cta'), { layer_id: 'cta', reason: 'HIDDEN' });
  // 143 a second layer for the same role is not placed (reported, not silently stacked)
  const twice = CI.buildDesignDocument(documentParts({ layers: [...demoLayers(), textLayer('headline2', 'HEADLINE', 'Encore une accroche', { z_index: 30 })] }));
  const second = CI.solveLayout({ document: twice, recipe_id: 'PRODUCT_HERO', fonts: fonts(), assets: assetDims(), created_at: LATER });
  assert.ok(second.unplaced.some((u) => u.reason === 'SLOT_ALREADY_USED'));
  // 144 an unknown recipe is refused
  assert.equal(code(() => CI.solveLayout({ document: demoDocument(), recipe_id: 'FREESTYLE', fonts: fonts(), created_at: LATER })), CI.CI_ERROR.LAYOUT_RECIPE_UNKNOWN);
  // 145 a missing font is reported as a violation
  const noFont = CI.solveLayout({ document: demoDocument(), recipe_id: 'PRODUCT_HERO', fonts: CI.createFontRegistry([]), assets: assetDims(), created_at: LATER });
  assert.ok(noFont.violations.some((x) => x.code === 'FONT_MISSING'));
  assert.equal(noFont.status, 'UNSATISFIED');
  // 146 EDITORIAL_SPLIT is mirrored for a right-to-left output
  const split = (c) => CI.solveLayout({ document: CI.buildDesignDocument(documentParts(c)), recipe_id: 'EDITORIAL_SPLIT', fonts: fonts(), assets: assetDims(), created_at: LATER });
  const ltrSplit = split({});
  const rtlLayers = demoLayers().map((l) => (l.type === 'TEXT' ? { ...l, direction: 'RTL', locale: 'fr-BE' } : l));
  const rtlSplit = split({ output_context: outputContext({ locale: 'ar-SA', direction: 'RTL' }), layers: rtlLayers });
  const px = (o) => o.document.layers.find((l) => l.id === 'product').geometry.x;
  assert.ok(px(ltrSplit) < 540, 'LTR: product on the start (left) side');
  assert.ok(px(rtlSplit) > 540, 'RTL: product on the start (right) side');
  // 147 the solver returns a NEW revision (version + 1, chained, produced by the engine)
  assert.equal(out.document.version, 2);
  assert.equal(out.document.provenance.parent_document_ref, demoDocument().document_id);
  assert.equal(out.document.provenance.created_by, 'ENGINE');
  assert.deepEqual(out.document.provenance.producer_refs, ['engine:layout-constraint-engine.v1']);
  // 148 the input document is not mutated
  const input = demoDocument();
  const before = JSON.stringify(input);
  CI.solveLayout({ document: input, recipe_id: 'PRODUCT_HERO', fonts: fonts(), assets: assetDims(), created_at: LATER });
  assert.equal(JSON.stringify(input), before);
  // 149 EDITORIAL_SPLIT puts the product and the text in opposite halves with no collision
  const halves = ltrSplit.document.layers;
  const prod = halves.find((l) => l.id === 'product').geometry;
  for (const t of halves.filter((l) => l.type === 'TEXT')) assert.ok(!overlaps(prod, t.geometry), t.id);
  assert.equal(ltrSplit.status, 'SOLVED');
  // 150 an asset whose size is unknown is placed in its box with an ASPECT_UNKNOWN note
  const unknown = CI.solveLayout({ document: demoDocument(), recipe_id: 'PRODUCT_HERO', fonts: fonts(), assets: {}, created_at: LATER });
  assert.ok(unknown.placements.find((p) => p.layer_id === 'product').notes.includes('ASPECT_UNKNOWN'));
});

// ------------------------------------------------------------------ renderer determinism (151-165)

const render = (document = solved().document, extra = {}) => CI.renderDesignDocument({ document, fonts: fonts(), ...extra });

test('Renderer: a pure, deterministic projection of the document', () => {
  const rendered = render();
  // 151 the same document renders to the same bytes
  assert.equal(render().svg, rendered.svg);
  assert.equal(render().digest, rendered.digest);
  assert.match(rendered.digest, /^[0-9a-f]{64}$/);
  // 152 critical text is rendered exactly as written (the price included)
  assert.ok(rendered.svg.includes('>19,90 €</tspan>'));
  assert.deepEqual(rendered.text_runs.find((t) => t.layer_id === 'price').lines, ['19,90 €']);
  // 153 XML special characters in a text are escaped, never interpreted
  const risky = CI.buildDesignDocument(documentParts({ layers: [backgroundLayer(), textLayer('h', 'HEADLINE', 'Fish & <Chips> "now"', { geometry: { x: 10, y: 10, width: 900, height: 200, rotation_deg: 0 }, font_size: 40 })] }));
  const riskySvg = render(risky).svg;
  assert.ok(riskySvg.includes('Fish &amp; &lt;Chips&gt; &quot;now&quot;'));
  assert.doesNotMatch(riskySvg, /<Chips>/);
  // 154 the output has no script, no foreignObject and no event handler
  assert.doesNotMatch(rendered.svg, /<script|foreignObject|\son[a-z]+=|javascript:/i);
  // 155 an asset resolver cannot point an image at a remote or script location
  for (const href of ['https://evil.example/a.png', 'javascript:alert(1)', 'file:///etc/passwd', 'data:text/html;base64,AAAA']) {
    assert.equal(code(() => render(undefined, { assetResolver: () => href })), CI.CI_ERROR.RENDER_INPUT_INVALID, href);
  }
  assert.ok(render(undefined, { assetResolver: () => 'data:image/png;base64,iVBORw0KGgo=' }).svg.includes('data:image/png;base64,iVBORw0KGgo='));
  // 156 by default an image points at the symbolic canonical reference (the renderer never parses it)
  assert.match(rendered.svg, /href="ref:asset:\/\/demo\/product-cutout"/);
  // 157 a hidden layer - and the members of a hidden group - are not rendered
  const hid = clone(solved().document.layers).map((l) => (l.id === 'cta' ? { ...l, visibility: 'HIDDEN' } : l));
  assert.doesNotMatch(render(CI.reviseDesignDocument(solved().document, { layers: hid, created_at: LATER })).svg, /data-layer="cta"/);
  const group = { id: 'grp', type: 'GROUP', z_index: 90, geometry: { x: 0, y: 0, width: 10, height: 10, rotation_deg: 0 }, visibility: 'HIDDEN', locked: false, source_ref: null, constraints: [], effects: [], provenance: { origin: 'ENGINE', producer_ref: null, evidence_refs: [] }, members: ['price'] };
  const grouped = CI.reviseDesignDocument(solved().document, { layers: [...clone(solved().document.layers), group], created_at: LATER });
  assert.doesNotMatch(render(grouped).svg, /data-layer="price"/);
  assert.match(render(grouped).svg, /data-layer="headline"/);
  // 158 layers are drawn in z order
  const order = [...rendered.svg.matchAll(/data-layer="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(order, ['bg', 'product', 'logo', 'headline', 'subheadline', 'price', 'cta']);
  // 159 numbers are formatted stably (no -0, at most three decimals)
  assert.doesNotMatch(rendered.svg, /-0[" ,]|\d\.\d{4,}/);
  // 160 right-to-left text carries its direction and a logical anchor
  const arabic = CI.buildDesignDocument(documentParts({
    output_context: outputContext({ locale: 'ar-SA', direction: 'RTL' }),
    layers: [backgroundLayer(), textLayer('ar', 'HEADLINE', 'مرحبا بكم', { geometry: { x: 100, y: 100, width: 800, height: 200, rotation_deg: 0 }, font_size: 50, extra: { font_ref: FONT_AR_EXACT, direction: 'RTL', locale: 'ar-SA' } })],
  }));
  const arSvg = render(arabic).svg;
  assert.match(arSvg, /direction="rtl"/);
  assert.match(arSvg, /text-anchor="start"/);
  assert.match(arSvg, /<tspan x="900"/);
  // 161 a text whose font is not registered cannot be rendered
  assert.equal(code(() => CI.renderDesignDocument({ document: solved().document, fonts: CI.createFontRegistry([]) })), CI.CI_ERROR.FONT_MISSING);
  assert.equal(code(() => CI.renderDesignDocument({ document: solved().document })), CI.CI_ERROR.RENDER_INPUT_INVALID);
  // 162 without a rasterizer a PNG is honestly unsupported - never a fake image
  const png = CI.renderPng(rendered);
  assert.equal(png.supported, false);
  assert.equal(png.reason, 'NO_RASTERIZER_IN_RUNTIME');
  // 163 an injected rasterizer's output must really be a PNG
  const pngBytes = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]);
  const resolvedRender = render(undefined, { assetResolver: () => 'data:image/png;base64,iVBORw0KGgo=' });
  assert.equal(CI.renderPng(resolvedRender, { rasterizer: () => pngBytes }).supported, true);
  assert.equal(code(() => CI.renderPng(resolvedRender, { rasterizer: () => Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8, 9]) })), CI.CI_ERROR.RASTER_UNSUPPORTED);
  assert.equal(code(() => CI.renderPng(rendered, { rasterizer: () => pngBytes })), CI.CI_ERROR.RENDER_NOT_RESOLVED); // a structural render is never rasterized
  // 164 the render reports its structure and its text runs
  assert.deepEqual(rendered.structure.map((s) => s.layer_id), order);
  assert.ok(rendered.text_runs.every((t) => t.fits));
  assert.ok(isDeepFrozen(rendered));
  // 165 a background image fills the canvas (slice) and an image can contain or cover its box
  const photo = CI.buildDesignDocument(documentParts({
    asset_refs: [ASSET_PHOTO, ASSET_LOGO],
    layers: [
      backgroundLayer({ id: 'photo', fill: undefined, source_ref: ASSET_PHOTO }),
      { ...logoLayer({ id: 'img', source_ref: ASSET_LOGO }), type: 'IMAGE', fit: 'CONTAIN', z_index: 5 },
    ],
  }));
  const photoSvg = render(photo).svg;
  assert.match(photoSvg, /data-type="BACKGROUND"[^>]*preserveAspectRatio="xMidYMid slice"/);
  assert.match(photoSvg, /data-type="IMAGE"[^>]*preserveAspectRatio="xMidYMid meet"/);
  assert.ok(CLAIM_PRICE && FONT && ASSET_PRODUCT);
});
