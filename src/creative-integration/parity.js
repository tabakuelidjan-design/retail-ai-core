import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { STATE, SEG_REASON } from './constants.js';
import { checkIdentity } from './identity.js';
import { validatePlacement } from './placement.js';
import { boundViolations, relightProduct } from './relight.js';
import { segmentProduct } from './segmentation.js';
import { shadowRequestProblems } from './shadow.js';
import { placeCutout } from './compose.js';

// THE PARITY AUDIT OF THE INTEGRATION. No model is in this module, so there is no instruction to compare to a validator: the audit is a MECHANICAL PROBE. It checks that the nine explicit states exist and are the
// only ones, that each rule refuses what it must (a tiny drawn product, a broken request, a changed byte), and that the module's own sources reach for no network, no process, no environment and no provider:
// the integration cannot call a generator because it has no way to.

const DIR = path.dirname(fileURLToPath(import.meta.url));
const REQUIRED_STATES = ['SEGMENTATION_FAILED', 'SEGMENTATION_LOW_CONFIDENCE', 'MATTE_INVALID', 'PRODUCT_IDENTITY_RISK', 'PLACEMENT_INVALID', 'SHADOW_INVALID', 'RELIGHT_OUT_OF_BOUNDS', 'INTEGRATION_ARTIFACT', 'READY_FOR_COMPOSITE'];
const FORBIDDEN = [/\bfetch\s*\(/, /node:https?['"]/, /node:net['"]/, /node:child_process['"]/, /node:dgram['"]/, /process\.env/, /\bWebSocket\b/, /\bXMLHttpRequest\b/];

function tiny(width, height, box, fg = [30, 40, 90], bg = [235, 232, 226]) {
  const pixels = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
    const inside = x >= box.x0 && x <= box.x1 && y >= box.y0 && y <= box.y1; const c = inside ? fg : bg; const i = (y * width + x) * 4;
    pixels[i] = c[0]; pixels[i + 1] = c[1]; pixels[i + 2] = c[2]; pixels[i + 3] = 255;
  }
  return { width, height, pixels };
}

/** @returns {{ ready: boolean, failures: string[], checks: string[] }} */
export function auditIntegrationParity() {
  const failures = []; const checks = [];
  const expect = (name, ok) => { checks.push(name); if (!ok) failures.push(name); };

  expect('STATES_ARE_EXACTLY_THE_NINE', JSON.stringify(Object.keys(STATE).sort()) === JSON.stringify([...REQUIRED_STATES].sort()) && Object.keys(STATE).every((k) => STATE[k] === k));
  expect('STATES_ARE_FROZEN', Object.isFrozen(STATE));

  // segmentation: a drawn product is cut, an empty photograph and a port that breaks the contract are refused
  const photo = tiny(120, 120, { x0: 30, y0: 30, x1: 89, y1: 89 });
  const seg = segmentProduct({ rgba: photo });
  expect('SEGMENTS_A_DRAWN_PRODUCT', seg.status === 'OK' && seg.accepted === true && seg.alpha[60 * 120 + 60] === 255 && seg.alpha[5 * 120 + 5] === 0);
  expect('REFUSES_AN_EMPTY_PHOTOGRAPH', segmentProduct({ rgba: tiny(100, 100, { x0: 1000, y0: 0, x1: 1001, y1: 0 }) }).failure_reason === SEG_REASON.NO_FOREGROUND);
  expect('REFUSES_A_PORT_CONTRACT_VIOLATION', segmentProduct({ rgba: photo, port: { id: 'p', segment: () => ({ status: 'OK', alpha: new Uint8Array(3), confidence: 1, bounds: { x0: 0, y0: 0, x1: 1, y1: 1 }, edge_quality: {} }) } }).failure_reason === SEG_REASON.PORT_CONTRACT_VIOLATION);
  expect('A_PORT_BELOW_THE_MINIMUM_CONFIDENCE_IS_NOT_ACCEPTED', segmentProduct({ rgba: photo, port: { id: 'p', segment: () => ({ ...seg, confidence: 0.2 }) } }).accepted === false);

  // relight bounds, shadow request, placement, identity
  expect('REFUSES_A_RELIGHT_BEYOND_THE_BOUNDS', boundViolations({ exposure_ev: 9 }).length === 1 && boundViolations({ gloss: 1 }).length === 1 && boundViolations({}).length === 0);
  const cut = { width: 40, height: 40, pixels: (() => { const p = new Uint8Array(40 * 40 * 4); for (let i = 0; i < 1600; i += 1) { const x = i % 40; p[i * 4] = 40 + x * 4; p[i * 4 + 1] = 60 + ((i / 40) | 0) * 3; p[i * 4 + 2] = 90; p[i * 4 + 3] = 255; } return p; })() };
  expect('AN_UNCHANGED_COPY_IS_IDENTICAL', checkIdentity({ source: cut, result: { ...cut, pixels: Uint8Array.from(cut.pixels) }, strict: true }).valid === true);
  const touched = { ...cut, pixels: Uint8Array.from(cut.pixels) }; touched.pixels[(20 * 40 + 20) * 4] ^= 1;
  expect('ONE_CHANGED_BYTE_IS_DETECTED_WHEN_NOTHING_WAS_REQUESTED', checkIdentity({ source: cut, result: touched, strict: true }).valid === false);
  const alphaChanged = { ...cut, pixels: Uint8Array.from(cut.pixels) }; alphaChanged.pixels[3] = 0;
  expect('A_CHANGED_SILHOUETTE_IS_DETECTED', checkIdentity({ source: cut, result: alphaChanged }).findings.some((f) => f.code === 'ALPHA_UNCHANGED' && !f.ok));
  expect('A_RELIGHT_OF_NOTHING_IS_THE_IDENTITY', relightProduct({ cutout: cut, request: {} }).identity_transform === true);
  expect('REFUSES_AN_UNKNOWN_SHADOW_KIND_AND_LIGHT', shadowRequestProblems({ kind: 'BLOB', light: { angle_deg: 0, elevation_deg: 40, softness: 0.5 } }).includes('KIND_UNKNOWN') && shadowRequestProblems({ kind: 'SOFT', light: { angle_deg: 0, elevation_deg: 0, softness: 0.5 } }).length === 1);
  const scene = { width: 400, height: 400, horizon_y: 100, support: { kind: 'HORIZONTAL_PLANE' } };
  const place = (placement) => validatePlacement({ scene, placed: placeCutout(cut, placement), placement });
  expect('ACCEPTS_A_SOUND_PLACEMENT', place({ x: 200, y: 300, scale: 2 }).state === STATE.READY_FOR_COMPOSITE);
  expect('REFUSES_A_ROTATED_A_SKY_AND_A_NEGATIVE_SCALE_PLACEMENT', place({ x: 200, y: 300, scale: 2, rotation_deg: 3 }).state === STATE.PLACEMENT_INVALID && place({ x: 200, y: 60, scale: 2 }).reasons.includes('CONTACT_ABOVE_THE_HORIZON') && place({ x: 200, y: 300, scale: -1 }).reasons.includes('SCALE_INVALID'));

  // the sources of this module reach for nothing outside itself
  const sources = readdirSync(DIR).filter((f) => f.endsWith('.js') && f !== 'parity.js');
  for (const f of sources) {
    const text = readFileSync(path.join(DIR, f), 'utf8');
    for (const re of FORBIDDEN) expect(`NO_${re.source}_IN_${f}`, !re.test(text));
  }
  return { ready: failures.length === 0, failures, checks, stages: [...new Set(checks.map((c) => c.split('_')[0]))], rows: checks };
}
