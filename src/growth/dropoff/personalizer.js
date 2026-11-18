// Growth > Où les visiteurs abandonnent: the personalizer's TECHNICAL events (photo chosen, send, design ready, cart attempt, cart confirmed) received from the shop.
// Pure and deterministic. No photo, no file name, no text typed by the visitor, no contact detail, no visitor id: the only identifier is a random per-attempt token.
//
// THE ATTEMPT TOKEN (attempt_id): 16-32 hex characters made by the browser for ONE visit of a personalizable product page (crypto.getRandomValues), kept in the tab's
// sessionStorage only while the cart add is pending (so the cart page can confirm it). It is NOT a cookie, NOT stored beyond the tab, and links nothing to a person. It has two uses:
//   1. to link the steps of the SAME attempt (so "a refusal, then a photo, then the cart" is ONE attempt, not three abandons);
//   2. to deduplicate: the same (attempt, step, n) received twice is stored once (n = the occurrence number of that step in the attempt).
//
// WHAT IS COUNTED (distinct attempts, never raw events):
//   - cart_submit      = an ATTEMPT to add (the button was pressed and the design was sent to Shopify): NOT a confirmed add.
//   - cart_confirmed   = Shopify's own cart (/cart.js on the cart page) holds the personalised line: the only "confirmed add".
//   - submit_blocked_no_photo = an OBSTACLE met (refusal without a photo), not an abandon.
//   - ABANDON IS NOT MEASURED: without a session-end signal a visitor whose last event is a refusal may come back. Those attempts are shown as "last event observed", never as abandons.

export const PZ_STEPS = Object.freeze({
  submit_blocked_no_photo: ['no_photo'],
  photo_chosen: ['ok', 'load_error'],
  send_clicked: ['ok'],
  design_ready: ['ok'],
  cart_submit: ['ok'],
  export_failed: ['export_error'],
  cart_confirmed: ['ok'],
  cart_not_found: ['not_found'],
});
/** The ONLY keys an event may carry. Anything else (a file name, a URL, a text, an e-mail...) makes the whole event refused, not trimmed. */
export const PZ_ALLOWED_KEYS = Object.freeze(['v', 'attempt', 'step', 'status', 'device', 'product', 'n', 'consent', 'ch']);
export const PZ_PROVENANCES = Object.freeze(['test', 'live', 'unknown']);
// PROVENANCE is decided by the SERVER, never by what the browser says it is. The browser only presents an opaque collection-channel key (`ch`); the server compares it with ITS OWN
// configuration (collectChannels in server/collect-personalizer.js): the test channel key -> 'test', the live channel key (only when live collection is enabled) -> 'live',
// anything else or nothing -> 'unknown'. A field named provenance/source/live/test in an event is refused by the strict schema.
export const PZ_MAX_N = 20;
export const PZ_RETENTION_DAYS = 90;

const ATTEMPT = /^[a-f0-9]{16,32}$/;
const HANDLE = /^[a-z0-9][a-z0-9-]{0,119}$/;

/** @returns {{ ok: true, row: object } | { ok: false, reason: string }} */
export function validatePersonalizerEvent(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, reason: 'NOT_AN_OBJECT' };
  for (const k of Object.keys(raw)) if (!PZ_ALLOWED_KEYS.includes(k)) return { ok: false, reason: 'FIELD_NOT_ALLOWED' };
  if (raw.v !== 1) return { ok: false, reason: 'VERSION' };
  if (raw.consent !== 'analytics') return { ok: false, reason: 'NO_CONSENT' }; // the browser only sends after the visitor's analytics consent
  if (typeof raw.attempt !== 'string' || !ATTEMPT.test(raw.attempt)) return { ok: false, reason: 'ATTEMPT' };
  if (typeof raw.step !== 'string' || !Object.hasOwn(PZ_STEPS, raw.step)) return { ok: false, reason: 'STEP' };
  if (!PZ_STEPS[raw.step].includes(raw.status)) return { ok: false, reason: 'STATUS' };
  if (raw.device !== 'mobile' && raw.device !== 'desktop') return { ok: false, reason: 'DEVICE' };
  if (raw.product !== null && raw.product !== undefined && (typeof raw.product !== 'string' || !HANDLE.test(raw.product))) return { ok: false, reason: 'PRODUCT' };
  if (!Number.isInteger(raw.n) || raw.n < 1 || raw.n > PZ_MAX_N) return { ok: false, reason: 'N' };
  if (raw.ch !== undefined && (typeof raw.ch !== 'string' || !/^[A-Za-z0-9_-]{16,64}$/.test(raw.ch))) return { ok: false, reason: 'CHANNEL' };
  return { ok: true, row: { attempt_id: raw.attempt, step: raw.step, status: raw.status, device: raw.device, product: raw.product ?? null, n: raw.n }, channel: raw.ch ?? null }; // `channel` is used once to decide the provenance and is NOT stored
}

/** Rows -> { live, test, unknown } by their STORED (server-assigned) provenance; a row without one counts as unknown. */
export function splitByProvenance(rows) {
  const out = { live: [], test: [], unknown: [] };
  for (const r of Array.isArray(rows) ? rows : []) (out[r.provenance === 'live' ? 'live' : r.provenance === 'test' ? 'test' : 'unknown']).push(r);
  return out;
}

const PROBE_STEPS = ['submit_blocked_no_photo', 'photo_chosen', 'send_clicked', 'design_ready', 'cart_submit', 'cart_confirmed'];
const zero = () => ({ total: 0, mobile: 0, desktop: 0 });

/**
 * @param {Array<{attempt_id, step, status, device, product, n, received_at}>} events  already limited to the reading window
 * @returns the counts of DISTINCT attempts per step and per outcome; `abandon` is always NOT_OBSERVABLE.
 */
export function summarizePersonalizer(events, { since = null, until = null, product = null } = {}) {
  const rows = (Array.isArray(events) ? events : []).filter((e) => !product || e.product === product);
  if (rows.length === 0) return { status: 'NO_DATA', since, until, attempts: 0, events: 0, steps: Object.fromEntries(PROBE_STEPS.map((s) => [s, zero()])), photoLoad: { ok: zero(), error: zero() }, outcomes: {}, abandon: { status: 'NOT_OBSERVABLE' } };
  const byAttempt = new Map();
  for (const e of rows) {
    if (!byAttempt.has(e.attempt_id)) byAttempt.set(e.attempt_id, { device: e.device, steps: new Set(), photoError: false, photoOk: false, order: [] });
    const a = byAttempt.get(e.attempt_id);
    a.steps.add(e.step); if (e.step === 'photo_chosen' && e.status === 'load_error') a.photoError = true; if (e.step === 'photo_chosen' && e.status === 'ok') a.photoOk = true;
    a.order.push([e.received_at ?? '', e.step]);
  }
  const steps = Object.fromEntries(PROBE_STEPS.map((s) => [s, zero()]));
  const photoLoad = { ok: zero(), error: zero() }; // photo_chosen is SENT with a RESULT: 'ok' = the image was read and decoded (loading succeeded), 'load_error' = it could not be read. Selected = either.
  const outcomes = {}; const bump = (k) => { outcomes[k] = (outcomes[k] ?? 0) + 1; };
  let obstacleThenContinued = 0;
  for (const a of byAttempt.values()) {
    for (const s of PROBE_STEPS) if (a.steps.has(s)) { steps[s].total++; steps[s][a.device]++; }
    if (a.photoOk) { photoLoad.ok.total++; photoLoad.ok[a.device]++; } if (a.photoError) { photoLoad.error.total++; photoLoad.error[a.device]++; }
    const has = (s) => a.steps.has(s);
    const last = a.order.sort((x, y) => (x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : 0)).at(-1)?.[1];
    if (has('submit_blocked_no_photo') && a.photoOk) obstacleThenContinued++;
    if (has('cart_confirmed')) bump('CONFIRMED');
    else if (has('cart_not_found')) bump('SUBMITTED_NOT_FOUND');
    else if (has('cart_submit')) bump('SUBMITTED_UNCONFIRMED');
    else if (has('export_failed')) bump('EXPORT_FAILED');
    else if (has('send_clicked')) bump('SENT_NOT_SUBMITTED');
    else if (a.photoOk) bump('PHOTO_ADDED_NOT_SENT');
    else if (has('photo_chosen')) bump('PHOTO_LOAD_FAILED');
    else if (last === 'submit_blocked_no_photo') bump('LAST_EVENT_OBSTACLE');
    else bump('OTHER');
  }
  return {
    status: 'OK', since, until, attempts: byAttempt.size, events: rows.length, steps, photoLoad,
    obstacles: { met: steps.submit_blocked_no_photo.total, thenContinued: obstacleThenContinued },
    outcomes,
    abandon: { status: 'NOT_OBSERVABLE' }, // no session-end signal: a "last event" is not a confirmed abandon
    retentionDays: PZ_RETENTION_DAYS,
  };
}
