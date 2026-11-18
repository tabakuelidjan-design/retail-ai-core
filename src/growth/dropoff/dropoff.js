// Développement des ventes > « Où les visiteurs abandonnent » (rule growth-dropoff.1). Pure and deterministic: the funnel facts a shop-analytics source provides
// (import contract, see docs/growth/DROPOFF_EVENTS.md) in, a funnel per scope and device + the findings out. It reads nothing, writes nothing, changes no shop.
//
// STEPS (in the order a visitor lives them). Each figure is { value, source, period } or UNAVAILABLE (null: never 0, never estimated):
//   session -> product_view -> personalizer_open -> photo_upload -> personalization_done -> add_to_cart -> checkout_start -> shipping -> payment -> purchase
//   - session, add_to_cart, checkout_start, purchase come from Shopify Analytics (sessions that did the step: a session counts once);
//   - product_view, personalizer_open, photo_upload, personalization_done come from the theme / web pixel events listed in EVENTS (not measured today = UNAVAILABLE + the event to add);
//   - shipping, payment come from the Shopify checkout events (only when the pixel is installed).
//   - the personalizer steps exist only for scopes that OFFER personalization (scope.personalizable); for the others they are NOT_APPLICABLE, not "missing".
// A rate is only computed between two MEASURED steps with the SAME unit; when steps in between are not measured the rate says so (skipped steps are named).
// Photo upload: technical statuses only (UPLOAD_OK / UPLOAD_FAILED + a reason code). Never the photo, never its file name.
//
// FINDINGS: kind 'recorded' (an observed figure: an upload failure count, a measured drop) or 'hypothesis' (a plausible cause that no data confirms yet). Each has
// constat (finding), nextCheck and action. The optional question to visitors is a SECOND step, proposed only when the data cannot explain a large drop.

export const DROPOFF_RULE = 'growth-dropoff.1';
export const STEPS = Object.freeze(['session', 'product_view', 'personalizer_open', 'photo_upload', 'personalization_done', 'add_to_cart', 'checkout_start', 'shipping', 'payment', 'purchase']);
export const PERSONALIZER_STEPS = Object.freeze(['personalizer_open', 'photo_upload', 'personalization_done']);
/** The event that measures each step that Shopify Analytics does not give (named in the screen when missing). */
export const EVENTS = Object.freeze({
  product_view: { event: 'product_viewed', where: 'Shopify Customer Events (standard)', standard: true },
  personalizer_open: { event: 'habb_personalizer_opened', where: 'theme (Shopify.analytics.publish) + custom pixel', standard: false },
  photo_upload: { event: 'habb_photo_upload_status', where: 'theme (Shopify.analytics.publish) + custom pixel', standard: false },
  personalization_done: { event: 'habb_personalization_completed', where: 'theme (Shopify.analytics.publish) + custom pixel', standard: false },
  shipping: { event: 'checkout_shipping_info_submitted', where: 'Shopify Customer Events (standard)', standard: true },
  payment: { event: 'payment_info_submitted', where: 'Shopify Customer Events (standard)', standard: true },
});
export const DROPOFF_CONFIG = Object.freeze({ minSessions: 100, minProductSessions: 10, significance: 0.10, minUploadAttempts: 5, minCoverage: 0.95, bigDropShare: 0.5 });
export const UPLOAD_STATUSES = Object.freeze(['UPLOAD_OK', 'UPLOAD_FAILED']);
export const DEVICES = Object.freeze(['mobile', 'desktop', 'tablet', 'other']);

const isDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
const nn = (x) => (typeof x === 'number' && Number.isFinite(x) && x >= 0 && Number.isInteger(x) ? x : null);
const round4 = (x) => Math.round(x * 10000) / 10000;
const dayDiff = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000);

/** @returns {{ funnel: object|null, errors: string[] }} Aggregates only: no visitor, no session id, no file name. */
export function normalizeDropoff(raw) {
  const errors = [];
  if (!raw || typeof raw !== 'object') return { funnel: null, errors: ['funnel must be a JSON object'] };
  for (const k of ['source_system', 'time_zone']) if (!raw[k]) errors.push(`${k}: required`);
  const w = raw.window; if (!w || !isDate(w.start) || !isDate(w.end) || dayDiff(w.start, w.end) <= 0) errors.push('window: { start, end } as YYYY-MM-DD, end exclusive');
  const rows = []; const seen = new Set();
  for (const [i, r] of (Array.isArray(raw.rows) ? raw.rows : []).entries()) {
    if (!r || typeof r !== 'object') { errors.push(`rows[${i}]: object required`); continue; }
    const device = r.device ?? 'all'; const scope = r.scope;
    if (!['all', ...DEVICES].includes(device)) { errors.push(`rows[${i}]: unknown device ${device}`); continue; }
    if (!['shop', 'personalizable', 'product'].includes(scope)) { errors.push(`rows[${i}]: scope must be shop|personalizable|product`); continue; }
    if (scope === 'product' && !r.product) { errors.push(`rows[${i}]: product scope needs a product (handle)`); continue; }
    const key = `${scope}|${r.product ?? ''}|${device}`; if (seen.has(key)) { errors.push(`rows[${i}]: duplicate ${key}`); continue; } seen.add(key);
    const counts = {}; const sources = {};
    for (const s of STEPS) { const c = r.counts?.[s]; counts[s] = c === undefined || c === null ? null : nn(c); if (c !== undefined && c !== null && counts[s] === null) errors.push(`rows[${i}].counts.${s}: must be a non-negative integer`); sources[s] = counts[s] === null ? null : String(r.sources?.[s] ?? raw.source_system); }
    if (counts.session !== null) for (const s of STEPS.slice(1)) if (counts[s] !== null && counts[s] > counts.session) errors.push(`rows[${i}].counts.${s}: larger than sessions (${counts[s]} > ${counts.session})`);
    const upload = r.photo_upload ? { ok: nn(r.photo_upload.ok), failed: nn(r.photo_upload.failed), reasons: Object.fromEntries(Object.entries(r.photo_upload.reasons ?? {}).filter(([k, v]) => /^[a-z_]{1,40}$/.test(k) && nn(v) !== null)) } : null;
    rows.push({ scope, product: r.product ?? null, title: r.title ?? r.product ?? null, device, personalizable: r.personalizable === true || scope === 'personalizable', basis: r.basis ?? null, counts, sources, upload });
  }
  if (!rows.length && !errors.length) errors.push('rows: at least one row is required');
  if (errors.length) return { funnel: null, errors };
  return { funnel: { source: raw.source_system, method: raw.method ?? null, siteUrl: raw.site_url ?? null, timeZone: raw.time_zone, retrievedAt: raw.retrieved_at ?? null, window: { start: w.start, end: w.end }, notes: Array.isArray(raw.notes) ? raw.notes.map(String).slice(0, 10) : [], events: Array.isArray(raw.events) ? raw.events.filter((e) => e && STEPS.includes(e.step)).map((e) => ({ step: e.step, configured: e.configured === true, event: e.event ?? EVENTS[e.step]?.event ?? null })) : [], rows }, errors };
}

/** P(X <= k) for X ~ Binomial(n, p): is a low count of carts just chance? */
export function binomialCdf(k, n, p) {
  if (!(n > 0) || !(p >= 0 && p <= 1)) return null; if (k >= n) return 1; let term = (1 - p) ** n; let sum = term;
  for (let i = 0; i < k; i++) { term *= ((n - i) / (i + 1)) * (p / (1 - p || 1e-12)); sum += term; }
  return Math.min(1, sum);
}

function stepsOf(row, cfg) {
  const out = [];
  for (const key of STEPS) {
    const notApplicable = PERSONALIZER_STEPS.includes(key) && !row.personalizable;
    const value = row.counts[key];
    out.push({ key, status: notApplicable ? 'NOT_APPLICABLE' : value === null ? 'UNAVAILABLE' : 'MEASURED', value: notApplicable ? null : value, source: row.sources[key], event: value === null && !notApplicable ? EVENTS[key] ?? null : null });
  }
  // rate vs the previous MEASURED applicable step (skipped steps are named, never bridged silently)
  let prev = null; const skipped = [];
  for (const s of out) {
    if (s.status === 'NOT_APPLICABLE') continue;
    if (s.status === 'UNAVAILABLE') { skipped.push(s.key); continue; }
    s.rate = prev && prev.value > 0 ? round4(s.value / prev.value) : null; s.from = prev ? prev.key : null; s.skipped = prev ? skipped.slice() : [];
    s.lost = prev ? Math.max(0, prev.value - s.value) : null;
    prev = s; skipped.length = 0;
  }
  return out;
}

/** The funnel of one row + its findings. */
export function analyseRow(row, cfg = DROPOFF_CONFIG, ctx = {}) {
  const steps = stepsOf(row, cfg); const findings = []; const sessions = row.counts.session;
  const lowVolume = sessions === null || sessions < (row.scope === 'product' ? cfg.minProductSessions : cfg.minSessions);
  const label = `${row.scope}:${row.product ?? ''}:${row.device}`;
  // 1. RECORDED upload failures (technical status events)
  if (row.personalizable && row.upload && row.upload.ok !== null && row.upload.failed !== null) {
    const attempts = row.upload.ok + row.upload.failed;
    if (attempts >= cfg.minUploadAttempts && row.upload.failed > 0) findings.push({ kind: 'recorded', code: 'UPLOAD_FAILURES', row: label, device: row.device, constat: { failed: row.upload.failed, attempts, rate: round4(row.upload.failed / attempts), reasons: row.upload.reasons }, nextCheck: 'UPLOAD_REASONS', action: 'FIX_UPLOAD' });
    else if (attempts > 0 && attempts < cfg.minUploadAttempts) findings.push({ kind: 'recorded', code: 'UPLOAD_LOW_VOLUME', row: label, device: row.device, constat: { failed: row.upload.failed, attempts }, nextCheck: 'WAIT_VOLUME', action: 'WAIT' });
  }
  if (lowVolume && sessions !== null) findings.push({ kind: 'recorded', code: 'LOW_VOLUME', row: label, device: row.device, constat: { sessions, min: row.scope === 'product' ? cfg.minProductSessions : cfg.minSessions }, nextCheck: 'WAIT_VOLUME', action: 'WAIT' });
  // 2. Largest MEASURED adjacent loss
  const measured = steps.filter((s) => s.status === 'MEASURED' && s.rate !== null && s.lost > 0);
  if (!lowVolume && measured.length) {
    const worst = measured.reduce((a, b) => (b.lost > a.lost ? b : a));
    if (worst.lost / (steps.find((s) => s.key === worst.from).value || 1) >= cfg.bigDropShare) findings.push({ kind: 'recorded', code: 'BIG_DROP', row: label, device: row.device, constat: { from: worst.from, to: worst.key, lost: worst.lost, rate: worst.rate, skipped: worst.skipped }, nextCheck: worst.skipped.length ? 'MEASURE_SKIPPED' : 'CAUSE_UNKNOWN', action: worst.skipped.length ? 'ADD_EVENTS' : 'INSPECT_STEP' });
  }
  // 3. Unmeasured steps that matter for this scope
  const missing = steps.filter((s) => s.status === 'UNAVAILABLE');
  if (missing.length && sessions !== null) findings.push({ kind: 'recorded', code: 'STEPS_NOT_MEASURED', row: label, device: row.device, constat: { steps: missing.map((s) => s.key) }, nextCheck: 'ADD_EVENTS', action: 'ADD_EVENTS' });
  // 4. Hypotheses (never presented as findings): only for a measured big drop on the mobile coque funnel
  if (!lowVolume && row.device === 'mobile' && row.personalizable) {
    const atc = steps.find((s) => s.key === 'add_to_cart');
    const base = steps.find((s) => s.key === (steps.find((x) => x.key === 'product_view' && x.status === 'MEASURED') ? 'product_view' : 'session'));
    if (atc?.status === 'MEASURED' && base?.value > 0 && atc.value / base.value < (ctx.referenceRate ?? 1)) findings.push({ kind: 'hypothesis', code: 'PHONE_MODEL_HARD_TO_FIND', row: label, device: row.device, constat: { rate: round4(atc.value / base.value), reference: ctx.referenceRate ?? null }, nextCheck: 'TEST_MODEL_PICKER', action: 'MEASURE_MODEL_STEP' });
  }
  return { scope: row.scope, product: row.product, title: row.title, device: row.device, personalizable: row.personalizable, basis: row.basis, sessions, lowVolume, steps, upload: row.upload, findings };
}

/** The whole screen payload. */
export function buildDropoff({ funnel, now, timeZone, config = DROPOFF_CONFIG }) {
  const cfg = { ...DROPOFF_CONFIG, ...config };
  const base = { rule: DROPOFF_RULE, source: funnel.source, method: funnel.method, window: funnel.window, retrievedAt: funnel.retrievedAt, timeZone: funnel.timeZone, notes: funnel.notes };
  if (funnel.timeZone !== timeZone) return { ...base, state: 'INCOMPLETE_PERIOD', reason: 'TIME_ZONE_DIFFERENT', merchantTimeZone: timeZone };
  const today = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
  if (funnel.window.end > today) return { ...base, state: 'INCOMPLETE_PERIOD', reason: 'WINDOW_NOT_OVER', today };
  const rate = (a, b) => (b > 0 ? a / b : null);
  const shop = (device) => funnel.rows.find((r) => r.scope === 'shop' && r.device === device);
  const pers = (device) => funnel.rows.find((r) => r.scope === 'personalizable' && r.device === device);
  const refRate = (r) => (r && r.counts.session > 0 && r.counts.add_to_cart !== null ? rate(r.counts.add_to_cart, r.counts.session) : null);
  const funnels = funnel.rows.filter((r) => r.scope !== 'product').map((r) => analyseRow(r, cfg, { referenceRate: r.scope === 'personalizable' ? refRate(shop(r.device)) : null }));
  // mobile vs desktop on the same definition (sessions -> add_to_cart), same scope
  const comparison = ['shop', 'personalizable'].map((scope) => {
    const m = funnel.rows.find((r) => r.scope === scope && r.device === 'mobile'); const d = funnel.rows.find((r) => r.scope === scope && r.device === 'desktop');
    if (!m || !d || m.counts.session === null || d.counts.session === null) return { scope, state: 'UNAVAILABLE' };
    const mr = refRate(m); const dr = refRate(d); const low = m.counts.session < cfg.minSessions || d.counts.session < cfg.minSessions;
    return { scope, state: low ? 'LOW_VOLUME' : 'OK', metric: 'session -> add_to_cart', mobile: { sessions: m.counts.session, carts: m.counts.add_to_cart, rate: mr === null ? null : round4(mr) }, desktop: { sessions: d.counts.session, carts: d.counts.add_to_cart, rate: dr === null ? null : round4(dr) }, gapPoints: mr !== null && dr !== null ? Math.round((mr - dr) * 1000) / 10 : null };
  });
  // products that attract sessions but few carts (landing-page sessions, all devices): exact binomial test against the shop-wide rate of the same rows
  const prodRows = funnel.rows.filter((r) => r.scope === 'product' && r.device === 'all' && r.counts.session !== null);
  const tot = prodRows.reduce((a, r) => ({ s: a.s + r.counts.session, c: a.c + (r.counts.add_to_cart ?? 0) }), { s: 0, c: 0 });
  const baseline = tot.s > 0 ? tot.c / tot.s : null;
  const products = prodRows.map((r) => {
    const s = r.counts.session; const c = r.counts.add_to_cart; let status = 'LOW_VOLUME'; let p = null;
    if (c === null) status = 'CARTS_UNAVAILABLE';
    else if (s >= cfg.minProductSessions && baseline !== null) { p = binomialCdf(c, s, baseline); status = p !== null && p < cfg.significance ? 'LOW_ADD_TO_CART' : 'NOT_DISTINCT'; }
    return { product: r.product, title: r.title, personalizable: r.personalizable, sessions: s, carts: c, rate: c === null || s === 0 ? null : round4(c / s), status, chance: p === null ? null : round4(p), basis: r.basis, source: r.sources.session };
  }).sort((a, b) => b.sessions - a.sessions || String(a.product).localeCompare(String(b.product)));
  const events = Object.entries(EVENTS).map(([step, e]) => ({ step, ...e, measured: funnel.rows.some((r) => r.counts[step] !== null) }));
  return { ...base, state: 'OK', siteUrl: funnel.siteUrl, funnels, comparison, products: { baselineRate: baseline === null ? null : round4(baseline), minSessions: cfg.minProductSessions, significance: cfg.significance, list: products }, events, optionalQuestion: { state: 'NOT_ASKED', reason: 'SECOND_STEP_ONLY_IF_DATA_CANNOT_EXPLAIN' } };
}
