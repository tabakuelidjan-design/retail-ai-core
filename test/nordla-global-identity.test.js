// Nordla global identity (2026-10-18): ONE graphic identity in every module, one pictogram per function. These tests keep the icon inventory honest (it describes the real files), keep the
// registry the only way a screen gets an icon, keep unvalidated candidates out of the screens, and keep Social Publishing on the shared Design System.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodePng } from '../src/creative-intelligence/png-pixels.js';
import { createSocialApp } from '../src/social/server/app.js';
import { createSocialService } from '../src/social/service.js';
import { createMemoryStore } from '../src/social/store.js';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const p = (...a) => join(ROOT, ...a);
const read = (f) => readFileSync(p(f), 'utf8');
const walk = (dir) => readdirSync(p(dir), { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(`${dir}/${e.name}`) : [`${dir}/${e.name}`]));
const inv = JSON.parse(read('docs/design/icons/INVENTORY.json'));
const cat = JSON.parse(read('src/shared/assets/nordla/library/catalog.json'));
const registry = (name) => { const m = new RegExp(`const ${name} = \\{([\\s\\S]*?)\\n  \\};`).exec(read('src/shared/nordla-icon.js')); return Object.fromEntries([...m[1].matchAll(/(\w+):\s*'([^']+)'/g)].map((x) => [x[1], x[2]])); };
const ICONS = registry('ICONS'); const DEFECTIVE = registry('DEFECTIVE');
const sha16 = (f) => { let b = readFileSync(p(f)); if (f.endsWith('.svg')) b = Buffer.from(b.toString('latin1').split(String.fromCharCode(13, 10)).join(String.fromCharCode(10)), 'latin1'); return createHash('sha256').update(b).digest('hex').slice(0, 16); }; // SVG: LF-normalised (Windows checkouts are CRLF)
const IMAGE = /\.(png|webp|svg|jpg|ico)$/i;

test('GI-1 the inventory describes the REAL files: every listed file exists with its fingerprint, and no icon file of the known sets is missing from it', () => {
  assert.ok(inv.files.length >= 317);
  for (const r of inv.files) { assert.ok(existsSync(p(r.path)), `${r.path} listed but absent`); assert.equal(sha16(r.path), r.sha256_16, `${r.path}: fingerprint changed (regenerate: python tools/nordla-icon-tools.py inventory)`); }
  const listed = new Set(inv.files.map((r) => r.path));
  for (const dir of ['src/shared/assets/nordla/official-icons', 'src/shared/assets/nordla/library', 'src/growth/ui/assets/icons', 'docs/design/nordla-icon-library-v2/reference']) {
    for (const f of walk(dir).filter((x) => IMAGE.test(x))) assert.ok(listed.has(f), `${f} exists but is not in the inventory`);
  }
  const by = inv.counts_by_status;
  assert.equal(by.VALIDATED_V1, Object.keys(ICONS).length, 'validated V1 = the registry');
  assert.equal(by.V1_DEFECTIVE, Object.keys(DEFECTIVE).length, 'defective V1 = the DEFECTIVE list');
  assert.equal(by.V2_CONFORME_PENDING_VALIDATION, new Set(cat.functions.filter((f) => f.file).map((f) => f.file)).size);
  assert.equal(inv.missing_functions.length, cat.functions.filter((f) => !f.file && !f.v1_official.length).length);
});

test('GI-2 the registry is the ONLY way a screen gets an icon: every key resolves to a real validated file, none is shared by two functions, none is defective, and every use in a module is a known key', () => {
  const files = Object.values(ICONS);
  assert.equal(new Set(files).size, files.length, 'one file per function: two keys never share a pictogram');
  for (const [k, f] of Object.entries(ICONS)) assert.ok(existsSync(p('src/shared/assets/nordla/official-icons', f)), `${k}: ${f} missing`);
  for (const k of Object.keys(DEFECTIVE)) assert.ok(!(k in ICONS), `${k} is both validated and defective`);
  const uses = [];
  for (const f of walk('src').filter((x) => /\.(js|html)$/.test(x) && !x.endsWith('src/shared/nordla-icon.js'))) for (const m of read(f).matchAll(/NordlaIcon\.semantic\(\s*'([A-Za-z]+)'/g)) uses.push([f, m[1]]);
  assert.ok(uses.length >= 25);
  for (const [f, k] of uses) { assert.ok(k in ICONS, `${f}: "${k}" is not a validated icon`); assert.ok(!(k in DEFECTIVE), `${f}: "${k}" is defective`); }
  // the Core screen keeps its own file table (ES module): it must say exactly what the registry says
  const view = read('src/sourcing/nordla-ui/nordla-view.js'); const table = /ICON_FILES = Object\.freeze\(\{([\s\S]*?)\}\);/.exec(view)[1];
  for (const m of table.matchAll(/(\w+):\s*'([^']+)'/g)) assert.equal(ICONS[m[1]], m[2], `nordla-view ICON_FILES.${m[1]} differs from the registry`);
  // no module hard-codes a pictogram path outside the registry and the Core view
  for (const f of walk('src').filter((x) => /\.(js|html|css)$/.test(x) && !/nordla-icon\.js$|nordla-view\.js$|nordla-static\.js$/.test(x))) assert.doesNotMatch(read(f), /official-icons\/\d/, `${f}: a hard-coded official icon path`);
});

test('GI-3 nothing unvalidated reaches a screen: no source file refers to a V2 library file, a reference file or a technical candidate', () => {
  for (const f of walk('src').filter((x) => /\.(js|html|css|json)$/.test(x) && !x.startsWith('src/shared/assets/'))) {
    assert.doesNotMatch(read(f), /assets\/nordla\/library\/|nordla-icon-library-v2\/reference|candidates-technical/, `${f}: refers to an unvalidated icon file`);
  }
  assert.doesNotMatch(read('src/shared/nordla-icon.js'), /library\/|candidates/, 'the production registry knows only the V1 pack');
});

test('GI-4 technical candidates are what the manifest says: transparent corners, official margin, native resolution kept, drawing unchanged, flagged "to validate"', () => {
  const man = JSON.parse(read('docs/design/icons/candidates-technical/manifest.json'));
  assert.equal(man.count, man.files.length); assert.ok(man.count >= 75);
  for (const e of man.files) {
    assert.equal(e.status, 'CANDIDATE_TECHNICAL_TO_VALIDATE', e.candidate); assert.ok(existsSync(p(e.candidate)), e.candidate);
    const img = decodePng(new Uint8Array(readFileSync(p(e.candidate))));
    assert.deepEqual([img.width, img.height], e.canvas_after, e.candidate);
    for (const [x, y] of [[0, 0], [img.width - 1, 0], [0, img.height - 1], [img.width - 1, img.height - 1]]) assert.equal(img.pixels[(y * img.width + x) * 4 + 3], 0, `${e.candidate}: opaque corner`);
    assert.ok(Math.min(...Object.values(e.margins_after_px)) >= 0.08 * Math.min(img.width, img.height) - 1, `${e.candidate}: margin below the official one`);
    if (e.drawing_mean_abs_diff_on_white !== null) assert.ok(e.drawing_mean_abs_diff_on_white < 2, `${e.candidate}: the drawing changed (${e.drawing_mean_abs_diff_on_white})`);
    // padding only: the canvas grows by the margin, the pixels are never scaled
    const maxSide = Math.ceil(Math.max(...e.native_before) / (1 - 2 * man.margin_ratio_used)) + 2;
    assert.ok(Math.max(...e.canvas_after) <= maxSide, `${e.candidate}: canvas ${e.canvas_after} larger than native ${e.native_before} + margin: enlarged?`);
  }
  assert.match(man.note, /Nothing is redrawn, recoloured or enlarged/);
});

test('GI-5 no icon is presented as vector when it is not: the sharpness report says every pictogram is a bitmap and flags what is soft above its native size', () => {
  const sh = JSON.parse(read('docs/design/icons/SHARPNESS.json'));
  assert.deepEqual(sh.sizes_px, [16, 24, 32, 48, 64, 128, 256]);
  assert.ok(sh.files.every((r) => r.vector === false));
  const man = JSON.parse(read('docs/design/icons/candidates-technical/manifest.json')); const cls = Object.fromEntries(man.files.map((e) => [e.candidate, e.fix_class]));
  const low = sh.files.filter((r) => r.status === 'CANDIDATE' && cls[r.path] === 'FIX_BACKGROUND_LOWRES');
  assert.ok(low.length >= 68 && low.every((r) => r.crisp_up_to_px <= 128), 'a candidate made from a small file is never reported crisp at 256 px');
  assert.ok(sh.files.filter((r) => r.status === 'VALIDATED_V1').every((r) => r.crisp_up_to_px === 256));
});

test('GI-6 Social Publishing is on the shared Design System: its page loads the shared stylesheets, the server serves them (and the Montserrat font) without a token, and no copy exists', async () => {
  const html = read('src/social/ui/index.html'); const at = ['/nordla-ds.css', '/nordla-tokens.css', '/app.css'].map((h) => html.indexOf(`href="${h}"`));
  assert.ok(at.every((i) => i >= 0) && at[0] < at[1] && at[1] < at[2]);
  const css = read('src/social/ui/app.css').replace(/\/\*[\s\S]*?\*\//g, '');
  assert.doesNotMatch(css, /#[0-9a-f]{3,8}\b|rgba?\(|prefers-color-scheme|gradient\(/i);
  const app = createSocialApp({ token: 't'.repeat(40), service: createSocialService({ store: createMemoryStore() }), assets: null, uiDir: p('src', 'social', 'ui') });
  const srv = http.createServer(app.handler); await new Promise((r) => { srv.listen(0, '127.0.0.1', r); });
  const get = (path) => new Promise((res, rej) => { http.get({ host: '127.0.0.1', port: srv.address().port, path }, (r) => { const c = []; r.on('data', (d) => c.push(d)); r.on('end', () => res({ status: r.statusCode, type: r.headers['content-type'], body: Buffer.concat(c) })); }).on('error', rej); });
  try {
    for (const [path, type] of [['/nordla-ds.css', /css/], ['/nordla-tokens.css', /css/], ['/nordla-assets/fonts/montserrat-latin.woff2', /woff2/]]) { const r = await get(path); assert.equal(r.status, 200, path); assert.match(r.type, type, path); assert.ok(r.body.length > 100); }
    assert.equal((await get('/nordla-assets/../../package.json')).status === 200, false, 'no traversal through the shared route');
    assert.equal((await get('/api/state')).status, 401, 'the API still needs the token');
  } finally { await new Promise((r) => { srv.close(r); }); }
});
