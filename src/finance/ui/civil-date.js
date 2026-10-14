'use strict';
// The merchant's CIVIL date in the browser. DOM-free. The zone is the one the server reports (MERCHANT_TIMEZONE, in the settings payload);
// it is never the browser's own zone. Same rule as the server (src/finance/civil-date.js, which this mirrors with the same Intl call);
// test/finance-civil-date.test.js proves both give the same date across winter / summer / DST / the 00:00-02:00 window.

/** The merchant's calendar date (YYYY-MM-DD) for an instant. */
function civilDateIn(instant, timeZone) {
  const d = instant instanceof Date ? instant : new Date(instant);
  if (Number.isNaN(d.getTime())) throw new RangeError('civilDateIn: invalid instant');
  if (!timeZone) throw new TypeError('civilDateIn: a time zone is required');
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}

/** Today in the merchant's zone (the form defaults and the period presets use this, never the browser's UTC or local day). */
function civilToday(timeZone) { return civilDateIn(new Date(), timeZone); }
