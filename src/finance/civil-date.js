// The ONE way Finance turns an instant into a calendar date.
//
// A business date in Finance (today, due date, overdue, days remaining, a refund's day, a contact's last activity...) is the merchant's CIVIL
// date: the calendar day in the merchant's time zone (MERCHANT_TIMEZONE, e.g. Europe/Brussels). It is never the UTC day of an instant:
// between 00:00 and 01:00/02:00 in Brussels the two differ. Technical timestamps (created_at, audit events, cache expiry, session expiry)
// stay UTC instants and never go through here.
//
// The time zone is always a parameter; nothing here reads the server zone or a fixed zone. test/finance-civil-date.test.js forbids
// any other instant -> "YYYY-MM-DD" conversion in src/finance (see its allow-list for the calendar arithmetic that stays).

import { localDateString } from '../metrics/windows.js';

/**
 * The merchant's civil date (YYYY-MM-DD) for an instant.
 * @param {Date|string|number} instant @param {string} timeZone IANA name, e.g. the merchant's configured zone
 */
export function civilDateIn(instant, timeZone) {
  const d = instant instanceof Date ? instant : new Date(instant);
  if (Number.isNaN(d.getTime())) throw new RangeError('civilDateIn: invalid instant');
  if (!timeZone || typeof timeZone !== 'string') throw new TypeError('civilDateIn: a time zone is required');
  return localDateString(d, timeZone);
}

/**
 * The clock every Finance service receives: `now()` is an ISO instant (UTC), `today()` the merchant's civil date at that same instant.
 * Both derive from the same `now`, so they can never disagree.
 * @param {{now?: () => string, timeZone: string}} o
 */
export function createMerchantClock({ now = () => new Date().toISOString(), timeZone }) {
  if (!timeZone || typeof timeZone !== 'string') throw new TypeError('createMerchantClock: a time zone is required');
  return { now, timeZone, today: () => civilDateIn(new Date(now()), timeZone) };
}

/** A service that needs "today" must be given a clock; there is no silent UTC default. */
export function requireClock(clock, who) {
  if (!clock || typeof clock.now !== 'function' || typeof clock.today !== 'function') {
    throw new TypeError(`${who}: a clock { now, today } is required (use createMerchantClock({ timeZone }))`);
  }
  return clock;
}
