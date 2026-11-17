// Stock / Achats -> the person's PERSONAL preferences (Paramètres > Préférences): regional format and saved views of the Produits screen.
// OPTIONAL and isolated: it only exists on the Nordla server (HOSTED) and only when the Préférences module answers. Every call returns { status, json } and never throws; the callers treat
// any failure as "no preference" and the screens keep their own defaults, so a problem here can never block Stock / Achats.
import { HOSTED, csrf } from './api.js';

const call = async (method, path, body) => {
  if (!HOSTED) return { status: 0, json: null };
  const ctrl = new AbortController(); const timer = setTimeout(() => ctrl.abort(), 8000);
  try {
    const res = await fetch(path, { method, signal: ctrl.signal, cache: 'no-store', credentials: 'same-origin', headers: { accept: 'application/json', ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(method !== 'GET' ? { 'x-nordla-csrf': csrf() } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
    let json = null; try { json = await res.json(); } catch { /* empty or non-JSON body */ }
    return { status: res.status, json };
  } catch { return { status: 0, json: null }; } finally { clearTimeout(timer); }
};

export const VIEW_MODULE = 'procurement_items';
export const effective = () => call('GET', '/api/preferences/effective');
export const defaultView = () => call('GET', `/api/preferences/views/default?module=${VIEW_MODULE}`);
export const listViews = () => call('GET', `/api/preferences/views?module=${VIEW_MODULE}`);
export const createView = ({ name, filters, makeDefault }) => call('POST', '/api/preferences/views', { module: VIEW_MODULE, name, filters, makeDefault: makeDefault === true });

/** Loads the regional formatter from the Préférences module. null on any failure (the screens then keep their own format). */
export async function loadFormatter() {
  if (!HOSTED) return null;
  try {
    const [eff, lib] = await Promise.all([effective(), import('/preferences-assets/format.js')]);
    if (eff.status !== 200 || !eff.json) return null;
    return lib.createFormatter({ region: eff.json.region, timeZone: eff.json.merchant?.timezone ?? null, currency: eff.json.merchant?.currency ?? null });
  } catch { return null; }
}
