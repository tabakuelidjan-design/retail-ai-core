// Calendar / Seasonality producer (M1.5): a time-bounded phenomenon relevant to Marketing (a local event, a season, a
// commercial occasion), represented as an EXTERNAL_SIGNAL - context from the outside world, never a fact about the merchant.
//
// It consumes a record already supplied by a future adapter. It downloads no calendar, hardcodes no holiday, calls no
// event/calendar/weather API and generates no marketing text or recommendation.
//
// The four times are distinct (M1 contract):
//   observed_at      when the signal was observed
//   detected_at      when Nordla received/detected it
//   expires_at       until when the EVIDENCE stays valid (freshness)
//   effective_window when the PHENOMENON takes place - required here, may lie in the future, never affects freshness

import { SIGNAL_CLASS } from './understand-constants.js';
import { PRODUCER_ERROR as P, produceMarketSignal, requireField } from './signal-producer.js';
import { fail } from './understand-validation.js';

export const CALENDAR_KIND = Object.freeze({
  LOCAL_EVENT: 'LOCAL_EVENT',
  SEASONAL_WINDOW: 'SEASONAL_WINDOW',
  COMMERCIAL_OCCASION: 'COMMERCIAL_OCCASION',
});

export const CALENDAR_SIGNAL_TYPE = Object.freeze({
  LOCAL_EVENT: 'CALENDAR_LOCAL_EVENT',
  SEASONAL_WINDOW: 'CALENDAR_SEASONAL_WINDOW',
  COMMERCIAL_OCCASION: 'CALENDAR_COMMERCIAL_OCCASION',
});

/**
 * Input (closed): kind, subject_refs[>=1], source_ref, evidence_refs[>=1], detected_at, observed_at?, expires_at,
 * effective_window {start,end} (required), locale?, market?, limitations[], provenance.
 */
export function produceCalendarSignal({ tenant, brand = null, ...input } = {}) {
  return produceMarketSignal({
    tenant,
    brand,
    input,
    label: 'calendar',
    extraKeys: ['kind'],
    signalClass: SIGNAL_CLASS.EXTERNAL_SIGNAL,
    resolve(i) {
      if (typeof i.kind !== 'string' || !Object.hasOwn(CALENDAR_KIND, i.kind)) {
        fail(P.CALENDAR_INVALID_KIND, 'calendar.kind is not a supported calendar signal kind');
      }
      requireField(i.subject_refs, P.CALENDAR_SUBJECT_REQUIRED, 'a calendar signal needs at least one subject_ref');
      requireField(i.evidence_refs, P.CALENDAR_EVIDENCE_REQUIRED, 'a calendar signal needs at least one evidence_ref');
      if (i.effective_window == null) fail(P.CALENDAR_EFFECTIVE_WINDOW_REQUIRED, 'a calendar signal needs an effective_window');
      return { signalType: CALENDAR_SIGNAL_TYPE[i.kind] };
    },
  });
}
