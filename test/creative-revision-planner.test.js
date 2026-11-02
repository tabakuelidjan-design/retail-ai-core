// Precision revisions: understood exactly, least disruptive method, priced before anything runs, refused before running when a rule forbids it,
// and verified afterwards (an identical image is never reported as a successful revision). No provider call in these tests.
import test from 'node:test';
import assert from 'node:assert/strict';
import { deflateSync } from 'node:zlib';
import { understandRevision, planRevision, compareImages, REVISION_METHOD } from '../src/creative-autonomy/revision-planner.js';
import { normalizeStage } from '../src/creative-autonomy/stage-contract.js';
import { resolveBrandProfile } from '../src/creative-autonomy/brand-profile.js';
import { normalizeConceptSet } from '../src/creative-brain/concept.js';
import { CONCEPTS } from './creative-brain-world.js';

const [concept] = normalizeConceptSet(CONCEPTS);
const profile = resolveBrandProfile({ merchant_name: 'Boutique test' });
const stage = normalizeStage({ backdrop: 'WALL_AND_FLOOR', backdrop_tone: 'CHARCOAL', floor_finish: 'MIRROR', key_light: { kind: 'STRIP', side: 'LEFT', intensity: 'MEDIUM', temperature: 'COOL', purpose: 'sculpt the object' },
  accent_lights: [], camera: { height: 'PRODUCT_CENTER', framing: 'MEDIUM', product_position: 'LEFT_THIRD' }, props: [], headline: 'Le noir, sans détour', text_placement: 'RIGHT_COLUMN', show_price: 'YES',
  rationale: 'A quiet set that lets the real object carry the idea of the concept.' }, { concept, personalisation_offered: false, profile });
const previous = { stage, concept, ceiling_eur: 0.5, trace_cost: { text_call_eur: 0.0037, image_call_eur: 0.1059, run_settled_eur: 0.1282 } };
const facts = { product_title: 'TEST — Gourde démo 500 ml', variant: 'Noir', description: 'Gourde de démonstration.', personalisation_offered: false };
const plan = (note) => planRevision({ note, previous, profile, facts });

test('understanding: the kind of change, the exact change when it can be pinned down, and what stays unresolved', () => {
  assert.deepEqual(understandRevision('Remplace le titre par « Noir de nuit »').change, { headline: 'Noir de nuit' });
  assert.equal(understandRevision('Remplace le titre par « Noir de nuit »').kind, 'TEXT');
  assert.deepEqual(understandRevision('Mets le texte en haut à droite').change, { text_placement: 'TOP_RIGHT' });
  assert.deepEqual(understandRevision('Enlève le prix').change, { show_price: 'NO' });
  assert.equal(understandRevision('Un fond plus clair').kind, 'SCENE');
  assert.equal(understandRevision('Change the lighting, warmer').kind, 'SCENE');
  assert.equal(understandRevision('Une autre idée, complètement différente').kind, 'NEW_DIRECTION');
  assert.equal(understandRevision('Titre à gauche et fond plus sombre').kind, 'SCENE', 'a mixed request takes the method the hardest part needs');
  assert.deepEqual(understandRevision('Le titre est trop banal').unresolved, ['TEXT_WITHOUT_EXACT_WORDING']);
  assert.equal(understandRevision('hmm, pas convaincu').recognised, false);
});

test('plan: least disruptive valid method, priced BEFORE execution', () => {
  const t = plan('Remplace le titre par « Noir de nuit »');
  assert.equal(t.method, REVISION_METHOD.LOCAL_RECOMPOSE); assert.equal(t.executable, true); assert.equal(t.estimated_cost_eur, 0); assert.deepEqual(t.provider_calls, { text: 0, image: 0 });
  assert.ok(t.preserves.includes('the generated scene (same pixels)') && t.preserves.includes('the text position'));
  const l = plan('Mets le texte en haut à droite'); assert.equal(l.method, 'LOCAL_RECOMPOSE'); assert.equal(l.executable, true); assert.ok(l.preserves.includes('the headline'));
  const s = plan('Un fond plus clair, lumière plus chaude');
  assert.equal(s.method, REVISION_METHOD.NEW_SCENE_GENERATION); assert.equal(s.needs_confirmation, true); assert.equal(s.estimated_cost_eur, 0.1133); assert.equal(s.worst_case_eur, 0.5);
  const n = plan('Une autre idée, complètement différente'); assert.equal(n.method, REVISION_METHOD.NEW_CREATIVE_RUN); assert.equal(n.needs_confirmation, true); assert.equal(n.estimated_cost_eur, 0.1282);
  const v = plan('Le titre est trop banal'); assert.equal(v.method, REVISION_METHOD.NEEDS_EXACT_INSTRUCTION); assert.equal(v.estimated_cost_eur, 0); assert.equal(v.ask, 'EXACT_HEADLINE_WORDING');
  const u = plan('hmm, pas convaincu'); assert.equal(u.method, REVISION_METHOD.NEW_SCENE_GENERATION); assert.deepEqual(u.reason_not_local, ['REQUEST_NOT_RECOGNISED_EXACTLY']); assert.equal(u.needs_confirmation, true, 'never run blind: priced and confirmed');
});

test('plan: a local edit the rules forbid is refused BEFORE anything runs (text over the product, placeholder, claim, figure)', () => {
  for (const [note, re] of [['Mets le texte à gauche', /sit on the product/], ['Remplace le titre par « Titre de test »', /placeholder/], ['Remplace le titre par « La meilleure gourde »', /claim/], ['Remplace le titre par « Fraîche 24h »', /figure/]]) {
    const p = plan(note); assert.equal(p.method, 'LOCAL_RECOMPOSE'); assert.equal(p.executable, false, note); assert.match(p.refusals[0].reason, re, note);
  }
});

// ---- change detection on real PNG bytes
const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc = (b) => { let c = 0xffffffff; for (const x of b) c = crcTable[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const chunk = (type, data) => { const l = Buffer.alloc(4); l.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([l, td, c]); };
function png(w, h, paint) {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y += 1) for (let x = 0; x < w; x += 1) { const [r, g, b] = paint(x, y); const o = y * (w * 3 + 1) + 1 + x * 3; raw[o] = r; raw[o + 1] = g; raw[o + 2] = b; }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

test('verification: identical bytes are UNCHANGED, a change is located; tiny encoder noise (<=2 levels) is not a change', () => {
  const a = png(40, 30, () => [50, 60, 70]);
  assert.deepEqual(compareImages(a, Buffer.from(a)), { identical: true, changed_share: 0, changed_box: null });
  const b = png(40, 30, (x, y) => (x >= 30 && y < 10 ? [250, 250, 250] : [50, 60, 70]));
  const d = compareImages(a, b); assert.equal(d.identical, false); assert.deepEqual(d.changed_box, { x: 30, y: 0, width: 10, height: 10 }); assert.equal(d.changed_share, 0.0833);
  const noise = png(40, 30, () => [51, 61, 72]); assert.equal(compareImages(a, noise).identical, true);
  assert.equal(compareImages(a, png(20, 30, () => [50, 60, 70])).size_changed, true);
});
