'use strict';
// Nordla Growth - « Où les visiteurs abandonnent ». Loaded BEFORE app.js (same pattern as the other Growth pages): nothing runs at load time; the functions use app.js helpers
// (h, t, num, chip, cardHead, gi, dayFmt, tag, render, PAGES) only when app.js renders the page. Every figure comes from /api/growth/dropoff (src/growth/dropoff/dropoff.js).
// A figure that is not measured shows « Données indisponibles » and names the event to add - never 0, never an estimate. Aggregates only: no visitor, no photo, no file name.

let doScope = 'personalizable';
const DO_STEP_ORDER = ['session', 'product_view', 'personalizer_open', 'photo_upload', 'personalization_done', 'add_to_cart', 'checkout_start', 'shipping', 'payment', 'purchase'];
const doPct = (v) => (Number.isFinite(v) ? `${new Intl.NumberFormat(tag(), { maximumFractionDigits: 1 }).format(v * 100)} %` : null);
const doSourceLabel = (s) => (s ? t(`gr.do.source.${s}`) : null);
const doWindow = (d) => `${dayFmt(d.window.start, true)} → ${dayFmt(doLastDay(d.window.end), true)}`;
const doLastDay = (endExclusive) => new Date(Date.parse(`${endExclusive}T00:00:00Z`) - 86400000).toISOString().slice(0, 10);
const doNA = (event) => h('span', { class: 'gr-pp-na' }, t('gr.do.unavailable'), event ? h('span', { class: 'gr-do-event' }, ` · ${t('gr.do.eventToAdd')} `, h('code', null, event.event)) : null);

function doFunnelFor(d, scope, device) { return d.funnels.find((f) => f.scope === scope && f.device === device) || null; }

/** One funnel cell: visitors + pass-through rate + source/period (the title carries the full provenance). */
function doCell(step, d, label) {
  if (!step) return h('td', { class: 'gr-do-c', 'data-label': label }, h('span', { class: 'gr-pp-na' }, t('gr.do.noRow')));
  if (step.status === 'NOT_APPLICABLE') return h('td', { class: 'gr-do-c', 'data-label': label }, h('span', { class: 'gr-muted' }, t('gr.do.notApplicable')));
  if (step.status === 'UNAVAILABLE') return h('td', { class: 'gr-do-c', 'data-label': label }, doNA(step.event));
  const rate = doPct(step.rate);
  const skipped = step.skipped && step.skipped.length ? h('div', { class: 'gr-muted gr-do-skip' }, t('gr.do.skipped', step.skipped.map((k) => t(`gr.do.step.${k}`)).join(', '))) : null;
  return h('td', { class: 'gr-do-c', 'data-label': label, title: t('gr.do.figureTitle', doSourceLabel(step.source) || '', doWindow(d)) }, h('strong', null, num(step.value)), rate ? h('span', { class: 'gr-do-rate' }, ` · ${rate} ${t('gr.do.ofPrevious')}`) : null, skipped);
}

function doFunnelCard(d) {
  const tabs = h('div', { class: 'gr-do-tabs', role: 'group', 'aria-label': t('gr.do.scope') },
    ...['personalizable', 'shop'].map((s) => h('button', { type: 'button', class: `gr-do-tab${doScope === s ? ' active' : ''}`, 'aria-pressed': doScope === s ? 'true' : 'false', on: { click: () => { doScope = s; render(); } } }, t(`gr.do.scope.${s}`))));
  const m = doFunnelFor(d, doScope, 'mobile'); const dk = doFunnelFor(d, doScope, 'desktop');
  const scopeBasis = (m || dk || {}).basis;
  const rows = DO_STEP_ORDER.map((key) => {
    const sm = m && m.steps.find((s) => s.key === key); const sd = dk && dk.steps.find((s) => s.key === key);
    const na = (sm || sd) && [sm, sd].every((s) => !s || s.status === 'NOT_APPLICABLE'); if (na && doScope === 'shop') return null;
    return h('tr', null, h('th', { scope: 'row', class: 'gr-do-step' }, t(`gr.do.step.${key}`)), doCell(sm, d, t('gr.do.device.mobile')), doCell(sd, d, t('gr.do.device.desktop')));
  });
  return h('section', { class: 'ex-card gr-do-card' }, cardHead('opportunities', t('gr.do.funnel.title'), chip(doWindow(d), 'gr-muted')), tabs,
    scopeBasis ? h('p', { class: 'gr-muted gr-do-basis' }, t(`gr.do.basis.${scopeBasis}`)) : null,
    h('div', { class: 'ex-table-wrap' }, h('table', { class: 'ex-table gr-table gr-do-table gr-do-funnel' }, h('thead', null, h('tr', null, h('th', null, t('gr.do.col.step')), h('th', null, t('gr.do.device.mobile')), h('th', null, t('gr.do.device.desktop')))), h('tbody', null, rows))),
    h('p', { class: 'gr-muted gr-do-src' }, t('gr.do.sourceLine', d.source === 'shopify_analytics' ? t('gr.do.source.shopify_analytics') : d.source, doWindow(d), d.retrievedAt ? dayFmt(d.retrievedAt.slice(0, 10), true) : t('gr.do.unavailable'), d.timeZone)));
}

function doComparisonCard(d) {
  const c = d.comparison.find((x) => x.scope === doScope);
  let body;
  if (!c || c.state === 'UNAVAILABLE') body = h('p', { class: 'gr-pp-na' }, t('gr.do.unavailable'));
  else body = h('div', null,
    h('div', { class: 'gr-do-cmp' }, h('div', null, h('span', { class: 'gr-muted' }, t('gr.do.device.mobile')), h('strong', null, doPct(c.mobile.rate) ?? t('gr.do.unavailable')), h('span', { class: 'gr-muted' }, t('gr.do.cmpCount', num(c.mobile.carts ?? 0), num(c.mobile.sessions)))),
      h('div', null, h('span', { class: 'gr-muted' }, t('gr.do.device.desktop')), h('strong', null, doPct(c.desktop.rate) ?? t('gr.do.unavailable')), h('span', { class: 'gr-muted' }, t('gr.do.cmpCount', num(c.desktop.carts ?? 0), num(c.desktop.sessions))))),
    c.gapPoints !== null ? h('p', null, t('gr.do.cmpGap', `${c.gapPoints > 0 ? '+' : '−'}${new Intl.NumberFormat(tag(), { maximumFractionDigits: 1 }).format(Math.abs(c.gapPoints))}`)) : null,
    c.state === 'LOW_VOLUME' ? h('p', { class: 'gr-muted' }, t('gr.do.cmpLow')) : null);
  return h('section', { class: 'ex-card gr-do-card' }, cardHead('audience', t('gr.do.cmp.title')), h('p', { class: 'gr-muted' }, t('gr.do.cmp.def')), body);
}

function doUploadCard(d) {
  const f = doFunnelFor(d, 'personalizable', 'mobile'); const g = doFunnelFor(d, 'personalizable', 'desktop');
  const line = (label, fn) => { const u = fn && fn.upload; return h('li', null, h('strong', null, label), ' ', u && u.ok !== null && u.failed !== null ? t('gr.do.upload.line', num(u.ok), num(u.failed)) : doNA({ event: 'habb_photo_upload_status' })); };
  return h('section', { class: 'ex-card gr-do-card' }, cardHead('content', t('gr.do.upload.title')), h('p', { class: 'gr-muted' }, t('gr.do.upload.def')), h('ul', { class: 'gr-do-list' }, line(t('gr.do.device.mobile'), f), line(t('gr.do.device.desktop'), g)));
}

function doFindingText(f) {
  const c = f.constat;
  if (f.code === 'UPLOAD_FAILURES') return { constat: t('gr.do.f.upload.constat', num(c.failed), num(c.attempts), doPct(c.rate)), next: t('gr.do.f.upload.next'), action: t('gr.do.f.upload.action') };
  if (f.code === 'UPLOAD_LOW_VOLUME') return { constat: t('gr.do.f.uploadLow.constat', num(c.attempts)), next: t('gr.do.f.uploadLow.next'), action: t('gr.do.f.uploadLow.action') };
  if (f.code === 'LOW_VOLUME') return { constat: t('gr.do.f.low.constat', num(c.sessions), num(c.min)), next: t('gr.do.f.low.next'), action: t('gr.do.f.low.action') };
  if (f.code === 'BIG_DROP') return { constat: t('gr.do.f.drop.constat', t(`gr.do.step.${c.from}`), t(`gr.do.step.${c.to}`), num(c.lost), doPct(c.rate)), next: c.skipped.length ? t('gr.do.f.drop.nextSkipped', c.skipped.map((k) => t(`gr.do.step.${k}`)).join(', ')) : t('gr.do.f.drop.next'), action: c.skipped.length ? t('gr.do.f.drop.actionSkipped') : t('gr.do.f.drop.action') };
  if (f.code === 'STEPS_NOT_MEASURED') return { constat: t('gr.do.f.missing.constat', c.steps.map((k) => t(`gr.do.step.${k}`)).join(', ')), next: t('gr.do.f.missing.next'), action: t('gr.do.f.missing.action') };
  if (f.code === 'PHONE_MODEL_HARD_TO_FIND') return { constat: t('gr.do.f.model.constat', doPct(c.rate), c.reference == null ? '' : doPct(c.reference)), next: t('gr.do.f.model.next'), action: t('gr.do.f.model.action') };
  return { constat: f.code, next: '', action: '' };
}

function doFindingsCard(d) {
  const order = { UPLOAD_FAILURES: 0, BIG_DROP: 1, PHONE_MODEL_HARD_TO_FIND: 2, UPLOAD_LOW_VOLUME: 3, LOW_VOLUME: 3, STEPS_NOT_MEASURED: 4 };
  const raw = d.funnels.flatMap((f) => f.findings).filter((f) => f.row.startsWith(`${doScope}:`));
  const merged = new Map(); // same finding on several devices is shown once, with its devices
  for (const f of raw) { const k = `${f.code}|${JSON.stringify(f.constat)}`; const m = merged.get(k); if (m) m.devices.push(f.device); else merged.set(k, { ...f, devices: [f.device] }); }
  const list = [...merged.values()].sort((a, b) => (order[a.code] ?? 9) - (order[b.code] ?? 9));
  const items = list.map((f) => { const x = doFindingText(f); return h('li', { class: `gr-do-finding gr-do-${f.kind}` },
    h('div', { class: 'gr-do-fhead' }, chip(t(f.kind === 'recorded' ? 'gr.do.kind.recorded' : 'gr.do.kind.hypothesis'), f.kind === 'recorded' ? 'gr-good' : 'gr-muted'), h('span', { class: 'gr-muted' }, f.devices.map((x) => t(`gr.do.device.${x}`)).join(' · '))),
    h('dl', { class: 'gr-do-dl' }, h('dt', null, t('gr.do.finding')), h('dd', null, x.constat), h('dt', null, t('gr.do.nextCheck')), h('dd', null, x.next), h('dt', null, t('gr.do.action')), h('dd', null, x.action))); });
  return h('section', { class: 'ex-card gr-do-card gr-do-wide' }, cardHead('needsAttention', t('gr.do.findings.title')), items.length ? h('ul', { class: 'gr-do-flist' }, items) : h('p', { class: 'gr-pp-na' }, t('gr.do.findings.none')));
}

function doProductsCard(d) {
  const p = d.products; const list = p.list;
  const rows = list.map((x) => h('tr', null, h('th', { scope: 'row' }, h('span', { class: 'gr-pp-name' }, x.title || x.product), x.personalizable ? h('span', { class: 'gr-muted' }, ` · ${t('gr.do.personalizable')}`) : null), h('td', { class: 'gr-do-c' }, num(x.sessions)), h('td', { class: 'gr-do-c' }, x.carts === null ? doNA() : num(x.carts)), h('td', { class: 'gr-do-c' }, doPct(x.rate) ?? '—'), h('td', null, chip(t(`gr.do.pstatus.${x.status}`), x.status === 'LOW_ADD_TO_CART' ? 'gr-warn' : 'gr-muted'))));
  return h('section', { class: 'ex-card gr-do-card gr-do-wide' }, cardHead('pack:gifts', t('gr.do.products.title')),
    h('p', { class: 'gr-muted' }, t('gr.do.products.def', doPct(p.baselineRate) ?? t('gr.do.unavailable'), num(p.minSessions), doPct(p.significance))),
    list.length ? h('div', { class: 'ex-table-wrap' }, h('table', { class: 'ex-table gr-table gr-do-table' }, h('thead', null, h('tr', null, h('th', null, t('gr.do.col.product')), h('th', null, t('gr.do.col.landings')), h('th', null, t('gr.do.col.carts')), h('th', null, t('gr.do.col.rate')), h('th', null, t('gr.do.col.status')))), h('tbody', null, rows))) : h('p', { class: 'gr-pp-na' }, t('gr.do.unavailable')));
}

function doEventsCard(d) {
  const rows = d.events.map((e) => h('tr', null, h('th', { scope: 'row' }, t(`gr.do.step.${e.step}`)), h('td', null, h('code', null, e.event)), h('td', null, e.measured ? chip(t('gr.do.measured'), 'gr-good') : chip(t('gr.do.notMeasured'), 'gr-warn')), h('td', { class: 'gr-muted' }, e.where)));
  return h('section', { class: 'ex-card gr-do-card gr-do-wide' }, cardHead('dataHealth', t('gr.do.events.title')), h('p', { class: 'gr-muted' }, t('gr.do.events.def')),
    h('div', { class: 'ex-table-wrap' }, h('table', { class: 'ex-table gr-table gr-do-table' }, h('thead', null, h('tr', null, h('th', null, t('gr.do.col.step')), h('th', null, t('gr.do.col.event')), h('th', null, t('gr.do.col.status')), h('th', null, t('gr.do.col.where')))), h('tbody', null, rows))),
    h('p', { class: 'gr-muted' }, t('gr.do.question')));
}

const DO_PZ_STEPS = ['submit_blocked_no_photo', 'photo_chosen', 'send_clicked', 'design_ready', 'cart_submit', 'cart_confirmed'];
const DO_PZ_OUTCOMES = ['CONFIRMED', 'SUBMITTED_UNCONFIRMED', 'SUBMITTED_NOT_FOUND', 'EXPORT_FAILED', 'SENT_NOT_SUBMITTED', 'PHOTO_ADDED_NOT_SENT', 'LAST_EVENT_OBSTACLE', 'OTHER'];
/** The personalizer's own events received from the shop (distinct attempts, never raw events). cart_submit is an ATTEMPT; only cart_confirmed is an add confirmed by Shopify's cart. */
function doPersonalizerCard(d) {
  const p = d.personalizer;
  if (!p) return null;
  if (p.status === 'UNAVAILABLE') return h('section', { class: 'ex-card gr-do-card gr-do-pz' }, cardHead('content', t('gr.do.pz.title')), h('p', { class: 'gr-muted' }, t('gr.do.pz.unavailable')));
  if (p.status === 'NO_DATA') return h('section', { class: 'ex-card gr-do-card gr-do-pz' }, cardHead('content', t('gr.do.pz.title')), h('p', { class: 'gr-muted' }, t('gr.do.pz.noData')));
  const steps = DO_PZ_STEPS.map((s) => { const v = p.steps[s] || { total: 0, mobile: 0, desktop: 0 }; return h('tr', { class: `gr-do-pz-${s}` }, h('th', { scope: 'row', class: 'gr-do-step' }, t(`gr.do.pz.step.${s}`)), h('td', { class: 'gr-do-c' }, h('strong', null, num(v.total))), h('td', { class: 'gr-do-c gr-muted' }, t('gr.do.pz.split', num(v.mobile), num(v.desktop)))); });
  const outcomes = DO_PZ_OUTCOMES.filter((k) => (p.outcomes || {})[k] > 0).map((k) => h('li', { class: `gr-do-pz-outcome gr-do-pz-${k}` }, h('strong', null, num(p.outcomes[k])), ' ', t(`gr.do.pz.outcome.${k}`)));
  return h('section', { class: 'ex-card gr-do-card gr-do-wide gr-do-pz' }, cardHead('content', t('gr.do.pz.title')),
    h('p', { class: 'gr-muted' }, t('gr.do.pz.source', num(p.attempts), num(p.events))),
    h('div', { class: 'ex-table-wrap' }, h('table', { class: 'ex-table gr-table gr-do-table' }, h('thead', null, h('tr', null, h('th', null, t('gr.do.col.step')), h('th', null, t('gr.do.pz.col.attempts')), h('th', null, t('gr.do.pz.col.devices')))), h('tbody', null, ...steps))),
    h('p', { class: 'gr-muted' }, t('gr.do.pz.attemptNote')),
    p.obstacles && p.obstacles.met > 0 ? h('p', null, t('gr.do.pz.obstacle', num(p.obstacles.met), num(p.obstacles.thenContinued))) : null,
    h('h4', null, t('gr.do.pz.outcomes')), h('ul', { class: 'gr-do-list' }, ...outcomes),
    h('p', { class: 'gr-muted' }, t('gr.do.pz.abandon')));
}

function renderDropoff(main, safe) {
  const d = PAGES.dropoff.get();
  if (d.state !== 'OK') { main.appendChild(h('div', { class: 'ex-card gr-st-empty' }, h('div', { class: 'gr-pp-empty' }, h('strong', { class: 'gr-ink' }, t(`gr.do.state.${d.state}.title`)), h('p', null, t(`gr.do.state.${d.state}.text`)), d.errors && d.errors.length ? h('p', { class: 'gr-muted' }, d.errors.slice(0, 5).join(' · ')) : null))); const pz0 = safe(doPersonalizerCard); if (pz0) main.appendChild(pz0); return; }
  if (d.notes && d.notes.length) main.appendChild(h('div', { class: 'gr-au-banner', role: 'note' }, gi('dataHealth', 'md'), h('span', null, d.notes.join(' '))));
  main.appendChild(safe(doFunnelCard));
  main.appendChild(safe(doFindingsCard));
  main.appendChild(h('div', { class: 'gr-grid gr-do-grid' }, safe(doComparisonCard), safe(doUploadCard)));
  const pz = safe(doPersonalizerCard); if (pz) main.appendChild(pz);
  main.appendChild(safe(doProductsCard));
  main.appendChild(safe(doEventsCard));
}
