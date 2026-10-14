// Optional ECB reference rates (official, daily). The owner can always enter a rate by hand: this adapter only fills it in with its date and source.
import { parseXml, walk } from './xml.js';
export const ECB_URL = 'https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml';
export function parseEcb(xml) {
  const rates = {}; let date = null;
  for (const el of walk(parseXml(xml))) { if (el.attrs.time) date = el.attrs.time; if (el.attrs.currency && el.attrs.rate) rates[el.attrs.currency] = Number(el.attrs.rate); }
  return { date, perEur: rates };
}
/** supplier currency -> EUR conversion rate (EUR per 1 unit of the currency), as the landed-cost input expects. */
export function fxFor(currency, ecb) { const per = ecb.perEur[currency.toUpperCase()]; return per ? { rate: Math.round((1 / per) * 1e6) / 1e6, date: ecb.date, source: 'ECB reference rate' } : null; }
export async function fetchEcb(fetchImpl = fetch) { const r = await fetchImpl(ECB_URL); if (!r.ok) throw new Error(`ECB HTTP ${r.status}`); return parseEcb(await r.text()); }
