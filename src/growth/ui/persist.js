'use strict';
// Where the Growth follow-up lives (plans, applied actions, review results, requests and commercial follow-up).
// ONE small interface with the shape of localStorage - getItem / setItem / key / length - used by opportunities.js and pipeline.js instead of localStorage itself.
//   - Local preview server (no sign-in): this browser, i.e. localStorage, exactly as before.
//   - Hosted server: session.js sets growthPersist.server after sign-in; the entries then live on the server, per merchant, and this
//     interface reads a copy loaded at sign-in and writes through to the server (session.js).
// The local branch reads the global `localStorage` at CALL time, so nothing here changes how the browser store behaves.

var growthPersist = { server: null };

var growthStorage = {
  getItem(key) {
    const s = growthPersist.server;
    if (s) return s.entries.has(key) ? s.entries.get(key).raw : null;
    return localStorage.getItem(key);
  },
  setItem(key, value) {
    const s = growthPersist.server;
    if (s) { s.write(key, String(value)); return; }
    localStorage.setItem(key, value);
  },
  key(index) {
    const s = growthPersist.server;
    if (s) return [...s.entries.keys()][index] ?? null;
    return localStorage.key(index);
  },
  get length() {
    const s = growthPersist.server;
    return s ? s.entries.size : localStorage.length;
  },
};
