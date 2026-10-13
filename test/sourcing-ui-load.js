// Test helper: loads the browser-side screens (Terrain, Expert, Salon) in Node so a test can read what each mode SHOWS for the same case. The screens are pure string builders over the case; the only
// browser things they touch at import time are localStorage (stubbed here, in memory) and the '/core/...' URLs (a resolve hook maps them to src/sourcing/core). Nothing in the screens is copied or changed.
import { register } from 'node:module';
import { pathToFileURL } from 'node:url';

const root = new URL('../src/sourcing/', import.meta.url);
let ready = false;
export function installBrowserStubs() {
  if (ready) return; ready = true;
  const mem = new Map(); globalThis.localStorage ??= { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => { mem.set(k, String(v)); }, removeItem: (k) => { mem.delete(k); }, get length() { return mem.size; }, key: (i) => [...mem.keys()][i] ?? null, clear: () => mem.clear() };
  const core = pathToFileURL(new URL('core/', root).pathname).href;
  register(`data:text/javascript,${encodeURIComponent(`export async function resolve(s, c, next) { return s.startsWith('/core/') ? next(${JSON.stringify(core)} + s.slice(6), c) : next(s, c); }`)}`);
}
export async function loadUi(rel) { installBrowserStubs(); return import(new URL(`ui/${rel}`, root).href); }
