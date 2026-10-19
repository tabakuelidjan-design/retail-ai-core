// GTIN -> product name, brand and quantity, from the OPEN Facts databases (Open Food Facts, Open Products Facts, Open Beauty Facts: free, no key, open data). SERVER SIDE. Only the barcode NUMBER is sent (to these public services),
// never a photo and never anything from the case. A hit is a PROPOSAL with its source and link: it tells what the barcode is REGISTERED as, not what the photographed item is (a barcode can be stuck on something else). Most non-food
// consumer goods are NOT in these databases: "not found" is normal and is reported as such, never filled in.
import { validGtin } from './market-vision.js';

export const OPEN_FACTS_HOSTS = Object.freeze(['world.openfoodfacts.org', 'world.openproductsfacts.org', 'world.openbeautyfacts.org']);
const UA = 'NordlaSourcing/0.1 (barcode lookup for sourcing; no personal data)';
const clean = (s, n = 100) => String(s ?? '').replace(/[\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n);

/** @returns {Promise<{found: boolean, name?: string, brand?: string, quantity?: string, source?: string, url?: string, note?: string}>} never throws: a failure is "not found" with a note. */
export async function lookupGtin(gtin, { fetchImpl = fetch, timeoutMs = 8000 } = {}) {
  const code = String(gtin ?? '').replace(/\D/g, ''); if (!validGtin(code)) return { found: false, note: 'invalid GTIN' };
  const one = async (host) => {
    const ctl = new AbortController(); const timer = setTimeout(() => ctl.abort(), timeoutMs);
    try { const r = await fetchImpl(`https://${host}/api/v2/product/${code}.json?fields=code,product_name,brands,quantity`, { headers: { 'user-agent': UA, accept: 'application/json' }, signal: ctl.signal }); if (!r.ok) return null; const j = await r.json(); if (j?.status !== 1 || !j.product) return null;
      const name = clean(j.product.product_name); if (!name) return null; const brand = clean(String(j.product.brands ?? '').split(',')[0], 60); const quantity = clean(String(j.product.quantity ?? '').replace(/\s+e$/i, ''), 30);
      return { found: true, name, brand: brand || null, quantity: quantity || null, source: host, url: `https://${host}/product/${code}` }; }
    catch { return null; } finally { clearTimeout(timer); }
  };
  const all = await Promise.all(OPEN_FACTS_HOSTS.map(one)); const hit = all.find(Boolean);
  return hit ?? { found: false, note: 'barcode not in the Open Facts databases (common for non-food goods)' };
}
