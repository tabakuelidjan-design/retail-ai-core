// THE MEMORY OF CREATOR'S "NONE" (2026-11-15). When Creator answers NONE for a product ("no convincing idea: nothing visible shows a need"), asking again the next day with the SAME facts and the SAME brief would pay for the same answer. This file
// remembers the NONE with two fingerprints, one of the FACTS the product sheet gives (the claims, and the variants' titles and prices; never the stock, which moves every day) and one of the BRIEF (objective, audience, occasion, offer, permissions).
// While both are identical the product is not asked again; as soon as one changes the product is eligible again, and the answer says which one changed. Nothing here calls a provider.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const sha = (v) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
const t = (x, n) => (typeof x === 'string' && x.trim() ? x.trim().slice(0, n).trim() : null); // trimmed again after the cut: the app cuts at n characters and may keep a trailing space

/** The facts a product sheet gives Creator: the claims and the variants (id, title, price), not the stock. */
export const factsFingerprint = ({ claims = [], variants = [] }) => sha({ claims: claims.map(String), variants: variants.map((v) => ({ id: v.id, title: v.title, price: v.price })).sort((a, b) => String(a.id).localeCompare(String(b.id))) });
/** The brief Creator receives, normalised the way the Creator app stores it (objective 500 characters, the others 400). */
export const briefFingerprint = ({ objective, audience, occasion, offer, permissions = [] }) => sha({ objective: t(objective, 500), audience: t(audience, 400), occasion: t(occasion, 400), offer: t(offer, 400), permissions: [...permissions].map(String).sort() });

/** The claims and variants of a product of the advertisement registry (the sheet and its Shopify snapshot). */
export function factsOfRegisteredProduct(entry) {
  const claims = (entry.definition.facts ?? []).map((f) => f.claim); const snap = entry.snapshots[entry.definition.facts?.[0]?.source?.snapshot ?? ''];
  return { claims, variants: snap?.product?.variants?.nodes ?? [] };
}

export const readNoneMemory = (file) => { try { return existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')).entries ?? []) : []; } catch { return []; } };
export function recordNone(file, entry) {
  const entries = readNoneMemory(file); if (entries.some((e) => e.run_id === entry.run_id)) return { status: 'ALREADY_RECORDED' };
  // the same NONE (same variant, same facts, same brief) is ONE memory, even when it comes from another run (a replay of an archived answer, a repeated question): the first date and reason stay
  const same = entries.find((e) => e.product_id === entry.product_id && e.variant_id === entry.variant_id && e.facts_sha === entry.facts_sha && e.brief_sha === entry.brief_sha); if (same) return { status: 'ALREADY_REMEMBERED', entry: same };
  mkdirSync(dirname(file), { recursive: true }); const tmp = `${file}.tmp`; writeFileSync(tmp, JSON.stringify({ entries: [...entries, entry] }, null, 1)); renameSync(tmp, file); return { status: 'RECORDED' };
}

/** Does a remembered NONE still apply to this product, with these facts and this brief? The LATEST NONE of the product counts. */
export function noneStatus(entries, { product_id, variant_id, facts_sha, brief_sha }) {
  const mine = entries.filter((e) => e.product_id === product_id && e.variant_id === variant_id).sort((a, b) => String(b.recorded_at).localeCompare(String(a.recorded_at)));
  const e = mine[0]; if (!e) return { applies: false, entry: null, changed: [] };
  const changed = [...(e.facts_sha !== facts_sha ? ['faits'] : []), ...(e.brief_sha !== brief_sha ? ['brief'] : [])];
  return { applies: changed.length === 0, entry: e, changed };
}

/** The port of the Creator app: records a NONE (the run that ends with AD_NO_CONVINCING_IDEA) with the fingerprints of what Creator was given. */
export function createNoneMemory({ file, adProducts }) {
  return Object.freeze({
    file,
    record: (c) => {
      const reg = adProducts?.find?.(c.product?.product_id); if (!reg) return { status: 'NOT_AN_AD_PRODUCT' };
      const f = factsOfRegisteredProduct(reg); const p = c.campaign ?? {};
      return recordNone(file, { run_id: c.id, product_id: c.product.product_id, variant_id: c.variant.variant_id, variant_title: c.variant.title ?? null, recorded_at: new Date().toISOString(), kind: 'NONE', none_reason: String(c.error?.reason ?? '').replace(/^AD_NO_CONVINCING_IDEA:\s*/, '').slice(0, 300),
        facts_sha: factsFingerprint(f), brief_sha: briefFingerprint({ objective: c.objective, audience: p.audience, occasion: p.occasion, offer: p.offer, permissions: p.permissions ?? [] }) });
    },
    entries: () => readNoneMemory(file),
  });
}
