// One identity per real object (requirement 3). A cross-module reference is `nordla:<kind>:<id>`, tenant-scoped by the registry that holds it.
// The registry maps every module-local id to ONE canonical id; two canonical ids for the same real object, or one local id bound to two canonicals, is a BLOCK.
import { ID_KIND, ERR, fail, IntegrationError } from './constants.js';

const KINDS = new Set(Object.values(ID_KIND));
export const ref = (kind, id) => {
  if (!KINDS.has(kind)) fail(ERR.IDENTITY_UNKNOWN, `unknown id kind ${kind}`);
  if (typeof id !== 'string' || !id) fail(ERR.IDENTITY_UNKNOWN, 'an id is required');
  return `nordla:${kind}:${id}`;
};
export function parseRef(r) {
  const m = /^nordla:([a-z_]+):(.+)$/.exec(String(r));
  return m && KINDS.has(m[1]) ? { kind: m[1], id: m[2] } : null;
}

const SUFFIX = /\b(co|ltd|limited|llc|inc|gmbh|sprl|srl|bv|bvba|sa|nv|corp|company)\b/g;
/** Strong keys of a real party: normalised legal name and VAT/tax number. Two records sharing a key are the same real object. */
export function identityKeys({ name, vat_number } = {}) {
  const keys = [];
  if (name) {
    const n = String(name).toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').replace(SUFFIX, ' ').replace(/\s+/g, ' ').trim();
    if (n) keys.push(`name:${n}`);
  }
  if (vat_number) keys.push(`vat:${String(vat_number).toUpperCase().replace(/[^A-Z0-9]/g, '')}`);
  return keys;
}

export function createIdentityRegistry({ tenant_id }) {
  if (typeof tenant_id !== 'string' || !tenant_id) fail(ERR.TENANT_MISMATCH, 'a tenant (merchant) id is required');
  const canon = new Map(); // `${kind}|${canonical_id}` -> { kind, canonical_id, keys:Set, links:Map(module -> Set(local)), display }
  const byLocal = new Map(); // `${kind}|${module}|${local}` -> canonical key
  const byKey = new Map(); // `${kind}|${strongKey}` -> canonical key

  const recOut = (r) => ({ ref: ref(r.kind, r.canonical_id), kind: r.kind, canonical_id: r.canonical_id, display: r.display, links: Object.fromEntries([...r.links].map(([m, s]) => [m, [...s]])) });

  function link({ kind, canonical_id, module, local_id, name, vat_number }) {
    if (!KINDS.has(kind)) fail(ERR.IDENTITY_UNKNOWN, `unknown id kind ${kind}`);
    const ck = `${kind}|${canonical_id}`;
    const lk = `${kind}|${module}|${local_id}`;
    if (byLocal.has(lk) && byLocal.get(lk) !== ck) fail(ERR.IDENTITY_CONFLICT, `${module} id ${local_id} is already bound to another ${kind}`, { local: lk, bound_to: byLocal.get(lk), requested: ck });
    const keys = identityKeys({ name, vat_number });
    for (const k of keys) {
      const owner = byKey.get(`${kind}|${k}`);
      if (owner && owner !== ck) fail(ERR.IDENTITY_CONFLICT, `${k} already identifies ${owner}: the same real ${kind} cannot have two canonical ids`, { key: k, existing: owner, requested: ck });
    }
    let rec = canon.get(ck);
    if (!rec) { rec = { kind, canonical_id, keys: new Set(), links: new Map(), display: name ?? canonical_id }; canon.set(ck, rec); }
    for (const k of keys) { rec.keys.add(k); byKey.set(`${kind}|${k}`, ck); }
    if (!rec.links.has(module)) rec.links.set(module, new Set());
    rec.links.get(module).add(String(local_id));
    byLocal.set(lk, ck);
    return ref(kind, canonical_id);
  }

  /** Resolve a mention. Never guesses: the caller gets every match and decides (0 => unknown, >1 => ask). */
  function resolve({ kind, module, local_id, name, vat_number }) {
    if (module && local_id) { const c = byLocal.get(`${kind}|${module}|${local_id}`); return c ? [recOut(canon.get(c))] : []; }
    const hits = new Set();
    for (const k of identityKeys({ name, vat_number })) { const o = byKey.get(`${kind}|${k}`); if (o) hits.add(o); }
    if (!hits.size && name) {
      const n = identityKeys({ name })[0]?.slice(5);
      if (n) for (const [ck, rec] of canon) if (rec.kind === kind && [...rec.keys].some((k) => k.startsWith('name:') && k.includes(n))) hits.add(ck);
    }
    return [...hits].map((c) => recOut(canon.get(c)));
  }
  function resolveOne(q) {
    const hits = resolve(q);
    if (hits.length === 1) return hits[0];
    throw new IntegrationError(hits.length ? ERR.IDENTITY_AMBIGUOUS : ERR.IDENTITY_UNKNOWN, hits.length ? 'several real objects match: ask, never guess' : 'no such object', { candidates: hits.map((h) => h.ref) });
  }
  const all = (kind) => [...canon.values()].filter((r) => r.kind === kind).map(recOut);
  return Object.freeze({ tenant_id, link, resolve, resolveOne, all });
}
