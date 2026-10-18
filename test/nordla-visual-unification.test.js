// Nordla visual unification (2026-10-17): ONE Design System for every module. The tokens are defined once (src/shared/nordla-ds.css),
// the legacy variable names are mapped onto them once (src/shared/nordla-tokens.css), every module page loads both before its own
// stylesheet, and no module stylesheet holds a colour of its own, a dark theme, a gradient or a copy of the Design System.
// The offline shells (China Sourcing field app, Stock & Achats) precache the shared files so the look survives with no connection.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { readNordlaShared } from '../src/shared/nordla-static.js';
import { createSourcingApp } from '../src/sourcing/server/app.js';
import { createMemoryStore } from '../src/sourcing/store/file-store.js';
import { createProcurement, createMemoryProcurementStore } from '../src/procurement/index.js';
import { createProcurementApp, listen } from '../src/procurement/server/app.js';

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const walk = (dir) => readdirSync(new URL(`../${dir}/`, import.meta.url), { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(`${dir}/${e.name}`) : [`${dir}/${e.name}`]));

// Every module stylesheet (the shared Design System files excepted).
const MODULE_CSS = walk('src').filter((f) => f.endsWith('.css') && !f.startsWith('src/shared/'));
// Every module page and the stylesheets it must load first.
const PAGES = {
  'src/finance/ui/index.html': ['/nordla-ds.css', '/nordla-tokens.css', '/style.css'],
  'src/analytics-premium/ui/index.html': ['/nordla-ds.css', '/nordla-tokens.css', '/style.css'],
  'src/growth/ui/index.html': ['/nordla-ds.css', '/nordla-tokens.css', '/style.css'],
  'src/procurement/ui/index.html': ['nordla-ds.css', 'nordla-tokens.css', 'app.css'],
  'src/social/ui/index.html': ['/nordla-ds.css', '/nordla-tokens.css', '/app.css'],
  'src/sourcing/ui/index.html': ['/nordla-ds.css', '/nordla-tokens.css', '/app.css'],
  'src/sourcing/nordla-ui/nordla.html': ['/nordla-ds.css'],
};
const COLOUR = /#[0-9a-f]{3,8}\b|\b(?:rgba?|hsla?)\(/i;

test('the Design System tokens are defined in ONE file only', () => {
  const definers = walk('src').filter((f) => f.endsWith('.css') && /--nd-[a-z0-9-]+\s*:/.test(read(f)));
  assert.deepEqual(definers, ['src/shared/nordla-ds.css']);
  for (const f of walk('src')) assert.ok(!/(^|\/)nordla-(ds|tokens)\.css$/.test(f) || f.startsWith('src/shared/'), `${f}: a copy of the Design System outside src/shared`);
});

test('the module bridge holds no colour value of its own: every token points at a --nd-* token', () => {
  const css = read('src/shared/nordla-tokens.css').replace(/\/\*[\s\S]*?\*\//g, '');
  assert.doesNotMatch(css, COLOUR);
  for (const m of css.matchAll(/(--(?:chart|nordla-menu)-[a-z-]+)\s*:\s*([^;]+);/g)) assert.match(m[2], /^var\(--nd-[a-z0-9-]+\)$|^transparent$/, `${m[1]}: ${m[2]}`);
  assert.match(css, /--font-display:\s*var\(--nd-font\)/, 'one typeface (Montserrat) for titles too');
});

test('no module stylesheet keeps a palette, a dark theme or a gradient of its own', () => {
  assert.ok(MODULE_CSS.length >= 10, `module stylesheets found: ${MODULE_CSS.length}`);
  for (const f of MODULE_CSS) {
    const css = read(f).replace(/\/\*[\s\S]*?\*\//g, '');
    const hit = css.split('\n').map((l, i) => [i + 1, l]).find(([, l]) => COLOUR.test(l));
    assert.equal(hit, undefined, `${f}:${hit?.[0]} colour literal: ${hit?.[1]?.trim().slice(0, 120)}`);
    assert.doesNotMatch(css, /prefers-color-scheme\s*:\s*dark/i, `${f}: dark theme`);
    assert.doesNotMatch(css, /gradient\(/i, `${f}: gradient`);
    assert.doesNotMatch(css, /font-family\s*:(?!\s*(?:var\(|inherit))/i, `${f}: a typeface other than the Design System's`);
  }
});

test('every module page loads the Design System, then the bridge, before its own stylesheet', () => {
  for (const [page, order] of Object.entries(PAGES)) {
    const html = read(page); const at = order.map((href) => html.indexOf(`href="${href}"`));
    assert.ok(at.every((i) => i >= 0), `${page}: missing ${order[at.findIndex((i) => i < 0)]}`);
    assert.deepEqual([...at].sort((a, b) => a - b), at, `${page}: load order ${order.join(' -> ')}`);
    assert.doesNotMatch(html, /fonts\.googleapis|nordla-fonts\.css/, `${page}: fonts come from the Design System (self-hosted Montserrat)`);
    const theme = /<meta name="theme-color" content="([^"]+)"/.exec(html);
    if (theme) assert.equal(theme[1].toUpperCase(), '#F5F6F8', `${page}: browser bar = Design System page background`);
    assert.doesNotMatch(html, /color-scheme" content="[^"]*dark/, `${page}: light only`);
  }
});

test('the shared reader serves the Design System and its bridge to every module server', async () => {
  for (const p of ['/nordla-ds.css', '/nordla-tokens.css']) {
    const a = await readNordlaShared(p); assert.equal(a.type, 'text/css; charset=utf-8'); assert.equal(a.body.toString('utf8'), read(`src/shared${p}`));
  }
  assert.equal(await readNordlaShared('/../nordla-ds.css'), null);
  for (const f of ['src/finance/server/app.js', 'src/analytics-premium/server/app.js', 'src/growth/server/app.js']) assert.doesNotMatch(read(f), /'\/nordla-tokens\.css'\s*:/, `${f}: no module copy route`);
});

const get = (port, path, headers = {}) => new Promise((resolve, reject) => {
  http.get({ host: '127.0.0.1', port, path, headers }, (res) => { let t = ''; res.on('data', (c) => { t += c; }); res.on('end', () => resolve({ status: res.statusCode, type: res.headers['content-type'], body: t })); }).on('error', reject);
});

test('China Sourcing field app: the shared stylesheets and the Montserrat files are served and precached in the offline shell', async () => {
  const app = createSourcingApp({ token: 't'.repeat(32), store: createMemoryStore(), uiDir: new URL('../src/sourcing/ui/', import.meta.url).pathname, coreDir: new URL('../src/sourcing/core/', import.meta.url).pathname });
  const s = http.createServer(app.handler); await new Promise((r) => s.listen(0, '127.0.0.1', r)); const { port } = s.address();
  try {
    const shell = JSON.parse((await get(port, '/shell-manifest.json')).body).files;
    for (const f of ['/nordla-ds.css', '/nordla-tokens.css', '/app.css', '/nordla-assets/fonts/montserrat-latin.woff2', '/nordla-assets/fonts/montserrat-latin-ext.woff2']) {
      assert.ok(shell.includes(f), `${f} is in the offline shell`);
      const r = await get(port, f); assert.equal(r.status, 200, f);
    }
    assert.equal((await get(port, '/nordla-ds.css')).body, read('src/shared/nordla-ds.css'));
    assert.match(read('src/sourcing/ui/sw.js'), /nordla-sourcing-terrain-v2-2/, 'the installed phone re-precaches the shell once');
  } finally { s.close(); }
});

test('Stock & Achats: the shared stylesheets are served (standalone and mounted paths) and precached by its service worker', async () => {
  const procurement = createProcurement({ store: createMemoryProcurementStore(), merchantId: randomUUID(), now: () => '2026-10-20T09:00:00.000Z' });
  const handler = createProcurementApp({ procurement, users: [{ id: 'o', name: 'O', role: 'OWNER', canApprove: true, approverRole: 'OWNER', token: 'o'.repeat(32) }], uploadsDir: '/nonexistent' });
  const { server, port } = await listen(handler);
  try {
    for (const p of ['/nordla-ds.css', '/nordla-tokens.css']) { const r = await get(port, p); assert.equal(r.status, 200, p); assert.equal(r.body, read(`src/shared${p}`)); }
    assert.equal((await get(port, '/nordla-assets/fonts/montserrat-latin.woff2')).status, 200);
    assert.equal((await get(port, '/nordla-assets/brand/nordla-monogram.svg')).status, 404, 'only the fonts are served by the standalone phone server');
  } finally { server.close(); }
  const sw = read('src/procurement/ui/sw.js');
  for (const f of ['nordla-ds.css', 'nordla-tokens.css', 'montserrat-latin.woff2']) assert.match(sw, new RegExp(f.replace('.', '\\.')));
  assert.match(sw, /nordla-achats-shell-v3/);
  assert.ok(!existsSync(new URL('../src/procurement/ui/nordla-ds.css', import.meta.url)));
});
