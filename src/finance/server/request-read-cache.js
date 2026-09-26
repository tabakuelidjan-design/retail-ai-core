// Request-scoped read cache for the Finance store: within ONE HTTP request, the same store read (same method, same arguments) hits
// Supabase once. Several helpers of a single endpoint re-read the same tables (e.g. /api/treasury read fin_bank_balances twice,
// a document page fin_documents four times) - each re-read was a full round trip to the database.
//
//   * scope: one request only (AsyncLocalStorage) - nothing is shared between requests or users, so no cross-request staleness;
//   * reads = methods named get*/list*/find*/latest*/peek*; concurrent identical reads share one promise;
//   * any other method (a write) empties the request's cache before AND after it runs, so a read after a write sees the write;
//   * every caller gets its own deep copy (callers may mutate what they read); a failed read is not cached;
//   * outside a request (scripts, tests calling the store directly) the store behaves exactly as before.

import { AsyncLocalStorage } from 'node:async_hooks';

const READ = /^(get|list|find|latest|peek)[A-Z]/;
const PASS_THROUGH = new Set(['newId']); // synchronous helpers that neither read nor write

const copy = (v) => (v === null || typeof v !== 'object' ? v : structuredClone(v));

export function createRequestReadCache() {
  const als = new AsyncLocalStorage();

  /** The store seen by the app: same methods, reads memoised per request. */
  function wrap(store) {
    return new Proxy(store, {
      get(target, prop, receiver) {
        const value = Reflect.get(target, prop, receiver);
        if (typeof value !== 'function' || typeof prop !== 'string' || PASS_THROUGH.has(prop)) return value;
        if (READ.test(prop)) {
          return (...args) => {
            const cache = als.getStore();
            if (!cache) return value.apply(target, args);
            const key = `${prop}:${JSON.stringify(args)}`;
            let pending = cache.get(key);
            if (!pending) {
              pending = Promise.resolve().then(() => value.apply(target, args));
              cache.set(key, pending);
              pending.catch(() => { if (cache.get(key) === pending) cache.delete(key); });
            }
            return pending.then(copy);
          };
        }
        return (...args) => {
          const cache = als.getStore();
          if (!cache) return value.apply(target, args);
          cache.clear();
          const out = value.apply(target, args);
          return out && typeof out.then === 'function' ? out.finally(() => cache.clear()) : out;
        };
      },
    });
  }

  /** Runs fn with a fresh, empty cache for this request. */
  const run = (fn) => als.run(new Map(), fn);
  return { wrap, run };
}
