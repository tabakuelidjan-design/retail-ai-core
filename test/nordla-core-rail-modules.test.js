// The Core menu's module entries: labels and paths from the static registry, access from the server (/api/core/modules).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import vm from 'node:vm';
import { MODULE_REGISTRY } from '../src/shared/module-registry.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const railSource = readFileSync(path.join(root, 'src/shared/nordla-core-rail.js'), 'utf8');

// Loads the rail in a sandbox (no DOM needed: autoMount finds no placeholder and does nothing).
function loadRail() {
  const win = { location: { origin: 'https://staging.nordla.app' } };
  const document = { readyState: 'complete', querySelector: () => null, addEventListener() {} };
  vm.runInNewContext(railSource, { window: win, document, location: win.location, DOMParser: function () {}, URL, Promise, console });
  return win.NordlaCoreRail;
}
const rail = loadRail();
const registry = { modules: MODULE_REGISTRY.map((m) => ({ key: m.key, title: m.title, prefix: m.prefix, embed: m.embed, tabs: m.tabs })) };
const serverAll = (state) => ({ modules: MODULE_REGISTRY.map((m) => ({ key: m.key, state })) });

const json = (body, ok = true) => Promise.resolve({ ok, json: () => Promise.resolve(body) });
const fetchWith = (reg, mods) => (url) => (url === '/nordla-module-registry.json' ? json(reg) : json(mods));

test('the registry order is kept, and Growth appears when the server authorises it', async () => {
  const out = await rail.loadModuleEntries(fetchWith(registry, serverAll('DISPONIBLE')));
  assert.deepEqual(out.map((e) => e.key), ['finance', 'analytics', 'growth']);
  const growth = out.find((e) => e.key === 'growth');
  assert.equal(growth.label, 'Croissance');
  assert.equal(growth.path, '/?ouvrir=growth'); // same tab, through the Core ticket
});

test('a module the server refuses is hidden; an unknown state is hidden too', async () => {
  const mods = { modules: [{ key: 'finance', state: 'DISPONIBLE' }, { key: 'analytics', state: 'NON ACTIVÉ' }, { key: 'growth', state: 'SUSPENDU' }] };
  const out = await rail.loadModuleEntries(fetchWith(registry, mods));
  assert.deepEqual(out.map((e) => e.key), ['finance']);
});

test('the Finance click keeps its existing action on Core, and every path stays on the Nordla home', async () => {
  const out = await rail.loadModuleEntries(fetchWith(registry, serverAll('LECTURE SEULE')));
  assert.equal(out.find((e) => e.key === 'finance').path, '/?ouvrir=finance');
  assert.equal(out.find((e) => e.key === 'analytics').path, '/?ouvrir=analyses');
  assert.equal(out.find((e) => e.key === 'growth').path, '/?ouvrir=growth'); // Croissance opens in the same tab through its Core ticket
  for (const e of out) {
    assert.match(e.path, /^\//, `${e.key} is a relative path`);
    assert.doesNotMatch(e.path, /^\/\/|https?:/, `${e.key} stays on the Nordla origin`);
  }
});

test('a registry or server failure gives no module entries and never rejects (Core keeps working)', async () => {
  // length check: the rail runs in its own vm realm, so its arrays are not reference-equal to this file's
  for (const f of [() => Promise.reject(new Error('network')), fetchWith(null, serverAll('DISPONIBLE')), fetchWith(registry, null), () => json({}, false)]) {
    assert.equal((await rail.loadModuleEntries(f)).length, 0);
  }
});

test('a module absent from the registry is never shown, even if the server lists it', async () => {
  const reg = { modules: registry.modules.filter((m) => m.key !== 'growth') };
  const out = await rail.loadModuleEntries(fetchWith(reg, serverAll('DISPONIBLE')));
  assert.deepEqual(out.map((e) => e.key), ['finance', 'analytics']);
});

test('the registry JSON route serves presentation only (no secret, no access decision)', async () => {
  const src = readFileSync(path.join(root, 'src/sourcing/server/app.js'), 'utf8');
  assert.match(src, /url\.pathname === '\/nordla-module-registry\.json'/);
  const route = src.slice(src.indexOf("'/nordla-module-registry.json'"), src.indexOf("'/nordla-module-registry.json'") + 400);
  assert.doesNotMatch(route, /secret|token|state|canOpen|allowed/i);
});
