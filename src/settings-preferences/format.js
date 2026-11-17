// The ONE regional formatter, used by the Préférences preview AND by every screen that follows the regional format (Stock / Achats today).
// Plain ES module with no dependency: it runs in the browser and in Node (tests).
//
// WHAT IT DOES: presentation only (separators, month names, 24 h / 12 h, currency symbol position).
// WHAT IT NEVER DOES: convert an amount, change a currency, change the commercial day. The currency is the one of the amount (or the merchant's, from Général);
// instants are shown in the MERCHANT's time zone (Général), so two people with different regional formats see the same day and the same amounts.
export const SUPPORTED_REGIONS = Object.freeze(['fr-BE', 'nl-BE', 'en-GB']);
export const DEFAULT_REGION = 'fr-BE';
export const FALLBACK_TIMEZONE = 'Europe/Brussels'; // used ONLY when Général holds no time zone yet (reported by `timezoneSource`, never silent)

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const safe = (fn, d = '') => { try { return fn(); } catch { return d; } };

/** @param {{ region?: string|null, timeZone?: string|null, currency?: string|null }} o */
export function createFormatter({ region = null, timeZone = null, currency = null } = {}) {
  const locale = SUPPORTED_REGIONS.includes(region) ? region : DEFAULT_REGION;
  const tz = timeZone || FALLBACK_TIMEZONE;
  const cur = currency || 'EUR';
  const asDate = (v) => (v instanceof Date ? v : new Date(v));
  // A calendar date without a time (2026-11-18) is a DAY, not an instant: it is never shifted by a time zone.
  const dayOpts = (v) => (typeof v === 'string' && DATE_ONLY.test(v) ? { timeZone: 'UTC' } : { timeZone: tz });
  const valid = (d) => !Number.isNaN(d.getTime());
  const api = {
    locale, timeZone: tz, timezoneSource: timeZone ? 'general' : 'fallback', currency: cur,
    /** 18/11/2026 (fr-BE), 18/11/2026 (nl-BE), 18/11/2026 (en-GB) - numeric form. */
    date(v, opts = {}) { const d = asDate(v); return valid(d) ? safe(() => d.toLocaleDateString(locale, { day: 'numeric', month: 'short', year: 'numeric', ...dayOpts(v), ...opts })) : ''; },
    time(v, opts = {}) { const d = asDate(v); return valid(d) ? safe(() => d.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit', timeZone: tz, ...opts })) : ''; },
    dateTime(v, opts = {}) { const d = asDate(v); return valid(d) ? safe(() => d.toLocaleString(locale, { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: tz, ...opts })) : ''; },
    number(n, { min = 0, max = 2 } = {}) { return Number.isFinite(Number(n)) ? safe(() => new Intl.NumberFormat(locale, { minimumFractionDigits: min, maximumFractionDigits: max }).format(Number(n))) : ''; },
    /** `minor` = the amount in minor units (cents), as Stock / Achats stores it. The currency stays the amount's own. */
    money(minor, currencyOf = cur, opts = {}) { const n = Number(minor); return Number.isFinite(n) ? safe(() => new Intl.NumberFormat(locale, { style: 'currency', currency: currencyOf || cur, ...opts }).format(n / 100)) : ''; },
    /** Same, for an amount already in major units (12.5 = 12,50 €). */
    moneyMajor(major, currencyOf = cur, opts = {}) { const n = Number(major); return Number.isFinite(n) ? safe(() => new Intl.NumberFormat(locale, { style: 'currency', currency: currencyOf || cur, ...opts }).format(n)) : ''; },
    /** The live preview: ONE fixed sample, formatted by the SAME functions the screens use. */
    preview(now = new Date(Date.UTC(2026, 10, 18, 14, 5, 0))) { return { date: api.date(now), time: api.time(now), dateTime: api.dateTime(now), number: api.number(1234567.891, { max: 3 }), money: api.moneyMajor(1234.5), moneySmall: api.moneyMajor(0.5) }; },
  };
  return Object.freeze(api);
}
