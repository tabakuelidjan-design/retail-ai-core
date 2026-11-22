// The Finance embed shim (src/finance/ui/embed/shim.js): the Finance UI must never change the Core address, must keep its own
// hash routes internal, must render inside the given root, and must keep window values local. Runs the real shim source in a sandbox.
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

const SHIM = await readFile(new URL('../src/finance/ui/embed/shim.js', import.meta.url), 'utf8');

function stubRoot() {
  const byId = new Map(); const listeners = new Map(); const children = [];
  return {
    byId, listeners, children, activeElement: null,
    getElementById(id) { return byId.get(id) ?? null; },
    appendChild(el) { children.push(el); if (el.id) byId.set(el.id, el); return el; },
    querySelector() { return null; }, querySelectorAll() { return []; },
    addEventListener(t, f) { if (!listeners.has(t)) listeners.set(t, []); listeners.get(t).push(f); },
    removeEventListener() {},
  };
}

function harness({ css = '.x{}' } = {}) {
  const realListeners = new Map(); const assigned = [];
  const realWindow = {
    origin: 'https://core.example',
    location: { origin: 'https://core.example', assign: (u) => assigned.push(u), replace: (u) => assigned.push(u) },
    addEventListener(t, f) { if (!realListeners.has(t)) realListeners.set(t, []); realListeners.get(t).push(f); },
    removeEventListener() {},
    innerWidth: 1200,
  };
  const realDocument = { createElement: (tag) => { const el = { tag, id: '', className: '', textContent: '', children: [], appendChild(c) { el.children.push(c); return c; } }; return el; }, createTextNode: (t) => ({ t }), readyState: 'complete' };
  const sandbox = { document: realDocument, window: realWindow, console };
  vm.createContext(sandbox);
  vm.runInContext(`${SHIM}\nthis.createFinanceEnv = createFinanceEnv;`, sandbox);
  const root = stubRoot();
  const env = sandbox.createFinanceEnv(root, { apiBase: '/finance/', css });
  return { env, root, realWindow, assigned, realListeners };
}

test('the Finance root gets its own styles and the #app element the Finance app renders into', () => {
  const { root } = harness({ css: ':host { --x: 1; }' });
  assert.ok(root.getElementById('fin-embed-style'), 'style element');
  assert.equal(root.getElementById('fin-embed-style').textContent, ':host { --x: 1; }');
  assert.ok(root.getElementById('fin-body'), 'the body wrapper exists');
  const app = root.getElementById('fin-body').children.find((c) => c.id === 'app');
  assert.ok(app, '#app is created inside the body wrapper, where the Finance app renders');
});

test('a hash route changes only the internal Finance route: the real Core address is never assigned', () => {
  const { env, realWindow, assigned } = harness();
  const seen = [];
  env.window.addEventListener('hashchange', (e) => seen.push(e.newURL));
  env.location.hash = '#/purchases';
  assert.equal(env.location.hash, '#/purchases');
  assert.equal(seen.length, 1, 'the Finance route listener is called');
  assert.match(seen[0], /#\/purchases$/);
  assert.deepEqual(assigned, [], 'no navigation');
  assert.equal(realWindow.location.origin, 'https://core.example');
});

test('setting the same hash twice does not repeat the route (no loop)', () => {
  const { env } = harness();
  let n = 0; env.window.addEventListener('hashchange', () => { n += 1; });
  env.location.hash = '#/todo'; env.location.hash = '#/todo';
  assert.equal(n, 1);
});

test('history.replaceState and pushState update the internal hash only, without an event', () => {
  const { env } = harness();
  let n = 0; env.window.addEventListener('hashchange', () => { n += 1; });
  env.history.replaceState(null, '', '/#/bank');
  assert.equal(env.location.hash, '#/bank');
  env.history.pushState(null, '', '/x#/contacts');
  assert.equal(env.location.hash, '#/contacts');
  assert.equal(n, 0);
});

test('window values set by the Finance scripts stay local to the module (NordlaIcon is not a Core global)', () => {
  const { env, realWindow } = harness();
  env.window.NordlaIcon = { semantic() {} };
  assert.equal(typeof env.window.NordlaIcon.semantic, 'function');
  assert.equal(realWindow.NordlaIcon, undefined);
});

test('the window keeps the real API for everything else (innerWidth, origin)', () => {
  const { env } = harness();
  assert.equal(env.window.innerWidth, 1200);
  assert.equal(env.window.location, env.location); // the module location shim
});

test('document lookups go to the Finance root, never to the Core document', () => {
  const { env, root } = harness();
  root.byId.set('probe', { id: 'probe' });
  assert.equal(env.document.getElementById('probe'), root.byId.get('probe'));
  assert.equal(env.document.body.id, 'fin-body');
});

test('a click on a "#…" anchor inside the Finance root is internal: default prevented, hash set, no navigation', () => {
  const { env, root, assigned } = harness();
  const clicks = root.listeners.get('click') ?? [];
  assert.equal(clicks.length, 1);
  let prevented = false;
  const anchor = { getAttribute: (n) => (n === 'href' ? '#/treasury' : null) };
  const event = { target: { closest: (sel) => (sel.includes('a[href^="#"]') ? anchor : null) }, preventDefault() { prevented = true; } };
  clicks[0](event);
  assert.equal(prevented, true);
  assert.equal(env.location.hash, '#/treasury');
  assert.deepEqual(assigned, []);
});
