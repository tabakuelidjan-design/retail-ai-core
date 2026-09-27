'use strict';
// Period selector for Explorer, Produits and Clients. The period is only a PARAMETER sent to the server (?period=<preset>|custom&from=&to=): every
// figure, series, ranking and comparison is recomputed there by the same deterministic engine, never in the browser.
// The chosen period, and the filters / sort / search of the workspaces, are kept in sessionStorage so opening a product or customer and coming
// back (or reloading the tab) does not lose them; "Réinitialiser" puts everything back on purpose.

const UI_STATE_KEY = 'nordla.analytics.ui';
const PERIOD_PRESETS = ['last_7_days', 'last_30_days', 'last_90_days', 'this_week', 'this_month', 'previous_month', 'this_year'];
const DEFAULT_PERIOD = { key: 'last_30_days', from: null, to: null };
const periodState = { ...DEFAULT_PERIOD };

const isIsoDate = (d) => /^\d{4}-\d{2}-\d{2}$/.test(d || '') && !Number.isNaN(Date.parse(`${d}T00:00:00Z`)) && new Date(`${d}T00:00:00Z`).toISOString().slice(0, 10) === d;

/** Query string for the server. Custom needs both dates; anything else falls back to the default period rather than sending garbage. */
function periodQueryOf(p) {
  if (p && p.key === 'custom' && isIsoDate(p.from) && isIsoDate(p.to)) return `period=custom&from=${p.from}&to=${p.to}`;
  return `period=${p && PERIOD_PRESETS.includes(p.key) ? p.key : DEFAULT_PERIOD.key}`;
}
const periodQuery = () => periodQueryOf(periodState);

/** Client-side check of the custom range (the server validates again and is the authority). Returns an error key or null. */
function customRangeError(from, to) {
  if (!isIsoDate(from) || !isIsoDate(to)) return 'period.err.INVALID_DATE';
  if (from > to) return 'period.err.PERIOD_ORDER';
  return null;
}

function uiStateSave() {
  try {
    sessionStorage.setItem(UI_STATE_KEY, JSON.stringify({
      period: { ...periodState },
      pr: { query: prState.query, filter: prState.filter, sort: prState.sort },
      cl: { query: clState.query, filter: clState.filter, recency: clState.recency, sort: clState.sort },
      ex: { granularity: exGranularity, channelMetric: exChannelMetric },
    }));
  } catch (e) { /* storage unavailable: the state simply lives in memory */ }
}
function uiStateRestore() {
  try {
    const s = JSON.parse(sessionStorage.getItem(UI_STATE_KEY) || 'null'); if (!s) return;
    if (s.period && (PERIOD_PRESETS.includes(s.period.key) || (s.period.key === 'custom' && !customRangeError(s.period.from, s.period.to)))) Object.assign(periodState, { key: s.period.key, from: s.period.from || null, to: s.period.to || null });
    const pick = (obj, src, keys) => { if (src) for (const k of keys) if (typeof src[k] === 'string') obj[k] = src[k]; };
    pick(prState, s.pr, ['query', 'filter', 'sort']); pick(clState, s.cl, ['query', 'filter', 'recency', 'sort']);
    if (s.ex && typeof s.ex.granularity === 'string') exGranularity = s.ex.granularity;
    if (s.ex && typeof s.ex.channelMetric === 'string') exChannelMetric = s.ex.channelMetric;
  } catch (e) { /* a corrupt entry is ignored */ }
}

/** Period data belongs to the period it was computed for: drop every cached payload and open detail. Filters, sort and search are kept. */
function periodInvalidate() {
  cachedExplorer = null; cachedProducts = null; cachedCustomers = null;
  prDetails.clear(); clDetails.clear(); prState.selected = null; clState.selected = null;
}
function setPeriod(p) {
  Object.assign(periodState, { key: p.key, from: p.from || null, to: p.to || null });
  periodInvalidate(); uiStateSave();
}
function resetUiState() {
  Object.assign(periodState, DEFAULT_PERIOD);
  Object.assign(prState, { query: '', filter: 'all', sort: 'revenue', selected: null }); Object.assign(clState, { query: '', filter: 'all', recency: 'all', sort: 'recent', selected: null });
  exGranularity = 'day'; exChannelMetric = 'revenue';
  periodInvalidate(); uiStateSave();
}

const periodDate = (iso) => { try { return new Intl.DateTimeFormat(NORDLA_I18N.getLang() === 'nl' ? 'nl-BE' : NORDLA_I18N.getLang() === 'en' ? 'en-GB' : 'fr-BE', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${iso}T00:00:00Z`)); } catch (e) { return iso; } };
const periodLabel = () => (periodState.key === 'custom' ? t('period.customRange', periodDate(periodState.from), periodDate(periodState.to)) : t(`period.p.${periodState.key}`));

/** "Du .. au .. (N jours) · comparée à du .. au .." or the factual insufficient-history wording. */
function periodRangeLine(d) {
  const p = d && (d.period_info || (d.period && d.period.days ? d.period : null)); if (!p || !p.start) return null;
  const cov = p.coverage;
  return h('div', { class: 'period-range', role: 'note' },
    h('span', null, t('period.range', periodDate(p.start), periodDate(p.end), p.days), p.includesToday ? ` · ${t('period.todayIncluded')}` : ''),
    ' · ',
    p.previous ? h('span', null, t('period.vsPrev', periodDate(p.previous.start), periodDate(p.previous.end))) : h('strong', null, cov && !cov.sufficient ? t('cmp.insufficientHistory') : t('period.noPrevious')));
}

/** The period pill turned into a real selector (same pill style; a small popover below it). */
function periodPicker(onChange) {
  const btn = h('button', { type: 'button', class: 'period-pill period-btn', 'aria-haspopup': 'true', 'aria-expanded': 'false' }, NordlaIcon.semantic('calendrier', 'sm'), h('span', { class: 'period-label' }, periodLabel()), icon('chevronDown', 13));
  const wrap = h('div', { class: 'period-wrap' }, btn);
  let menu = null;
  const close = () => { if (menu) { menu.remove(); menu = null; btn.setAttribute('aria-expanded', 'false'); document.removeEventListener('pointerdown', outside, true); document.removeEventListener('keydown', esc, true); } };
  const outside = (e) => { if (menu && !wrap.contains(e.target)) close(); };
  const esc = (e) => { if (e.key === 'Escape') { close(); btn.focus(); } };
  const choose = (p) => { close(); setPeriod(p); onChange(); };
  const open = () => {
    const from = h('input', { type: 'date', class: 'period-date', 'aria-label': t('period.from'), value: periodState.from || '' });
    const to = h('input', { type: 'date', class: 'period-date', 'aria-label': t('period.to'), value: periodState.to || '' });
    const err = h('div', { class: 'period-err', role: 'alert', style: 'display:none' });
    const apply = () => { const e = customRangeError(from.value, to.value); if (e) { err.textContent = t(e); err.style.display = ''; return; } choose({ key: 'custom', from: from.value, to: to.value }); };
    menu = h('div', { class: 'period-menu', role: 'menu' },
      PERIOD_PRESETS.map((k) => h('button', { type: 'button', role: 'menuitemradio', 'aria-checked': String(periodState.key === k), class: `period-item${periodState.key === k ? ' on' : ''}`, on: { click: () => choose({ key: k }) } }, t(`period.p.${k}`))),
      h('div', { class: `period-custom${periodState.key === 'custom' ? ' on' : ''}` },
        h('div', { class: 'period-custom-title' }, t('period.p.custom')),
        h('label', null, t('period.from'), from), h('label', null, t('period.to'), to), err,
        h('button', { type: 'button', class: 'period-apply', on: { click: apply } }, t('period.apply'))),
      h('button', { type: 'button', class: 'period-reset', on: { click: () => { close(); resetUiState(); onChange(); } } }, t('period.reset')));
    wrap.appendChild(menu); btn.setAttribute('aria-expanded', 'true');
    document.addEventListener('pointerdown', outside, true); document.addEventListener('keydown', esc, true);
  };
  btn.addEventListener('click', () => (menu ? close() : open()));
  return wrap;
}

window.addEventListener('pagehide', uiStateSave);
window.addEventListener('hashchange', uiStateSave);

/** Server period error code -> message key (fixed set; unknown codes fall back to a generic message, never blank). */
function periodErrorKey(code) {
  return ['INVALID_DATE', 'PERIOD_ORDER', 'PERIOD_IN_FUTURE', 'PERIOD_TOO_LONG', 'INVALID_PERIOD', 'DATASET_UNAVAILABLE'].includes(code) ? `period.err.${code}` : 'period.err.GENERIC';
}
