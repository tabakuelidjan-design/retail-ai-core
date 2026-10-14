// Test helper: loads the browser-side Salon views in Node. The browser resolves '/core/...' against the server root; a resolve hook maps that prefix to src/sourcing/core. The views are not copied or changed.
// They are pure HTML builders: no DOM is needed.
import { register } from 'node:module';

const root = new URL('../src/sourcing/', import.meta.url);
let hooked = false;
export async function loadSalonViews() {
  if (!hooked) {
    const core = new URL('core/', root).href; // already a file: URL (no .pathname round trip: on Windows that gives C:\C:\)
    register(`data:text/javascript,${encodeURIComponent(`export async function resolve(s, c, next) { return s.startsWith('/core/') ? next(${JSON.stringify(core)} + s.slice(6), c) : next(s, c); }`)}`);
    hooked = true;
  }
  return import(new URL('ui/screens/salon-views.js', root).href);
}
