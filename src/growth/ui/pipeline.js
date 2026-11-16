'use strict';
// Nordla Growth - Développement des ventes > Demandes > SUITE COMMERCIALE (lot _11): from a qualified request to the quote sent, the booking confirmed, the sale closed (or closed without follow-up).
// Plain scripts share one global scope: the helpers of opportunities.js (h, t, num, dayFmt, opToday, opMeasure...) are used only when these functions are CALLED.
//
// THE REQUEST has a stable identity inside the merchant's scope: req:<test id>:<conversation id> for a qualified conversation (granularity of the source kept: ONE request per qualified conversation),
// req:<test id>:m<n> for a request the merchant states by hand (no messaging, no CRM, no shop needed). A total of forms sent by a site NEVER creates a request.
// THE EVENTS are dated, append-only and the merchant's own (nothing is received from a CRM yet): quote_sent (a STEP), booking_confirmed and sale_closed (RESULTS), closed_lost (no follow-up). A correction
// adds an event that supersedes the previous one (kept in the history, never counted again); a withdrawal is an event too. Counting is by DISTINCT request: a request that got a quote then a sale is one
// request in each stage it reached and one only in the partition by last state. An amount not given stays unknown; a declared sale is not a payment received.
// PERSISTENCE (first version): this browser only, per merchant scope (key nordla.growth.pipeline.v1:<scope>). Said on screen. Not shared, not backed up; a CRM or a server store can replace it later.

const PIPE_TYPES = ['quote_sent', 'booking_confirmed', 'sale_closed', 'closed_lost'];
const PIPE_RESULTS = ['booking_confirmed', 'sale_closed'];
const pipeKey = (scope) => `nordla.growth.pipeline.v1:${scope}`;
const pipeUi = {}; // per test: which form is open (survives a re-render of the row)
const pipeEmpty = () => ({ v: 1, requests: {}, events: [] });
function pipeRead(scope) {
  if (!scope) return pipeEmpty();
  try { const v = JSON.parse(localStorage.getItem(pipeKey(scope)) ?? 'null'); return v && v.v === 1 && v.requests && Array.isArray(v.events) ? v : pipeEmpty(); } catch (e) { return pipeEmpty(); }
}
function pipeWrite(scope, st) { localStorage.setItem(pipeKey(scope), JSON.stringify(st)); }
const pipeDay = (iso) => String(iso || '').slice(0, 10);
const isIsoDay = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);

/** The events that count: not withdrawn (void) and not superseded by a correction. */
function pipeActive(events) { const dead = new Set(events.filter((e) => e.supersedes).map((e) => e.supersedes)); return events.filter((e) => e.type !== 'void' && !dead.has(e.id)); }
const pipeLast = (evs) => evs.slice().sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.at < b.at ? -1 : 1)).at(-1) ?? null;
const PIPE_STATE_OF = { quote_sent: 'quote', booking_confirmed: 'booking', sale_closed: 'sale', closed_lost: 'lost' };

/**
 * One group of requests (same list, same period): distinct requests per stage reached, the partition by last state, the rates (denominator = the qualified requests of the SAME group, > 0), the amounts.
 * @param {Array<{id: string}>} requests  @param {object[]} active  the active events (all requests)
 */
function pipeCount(requests, active) {
  const ids = new Set(requests.map((r) => r.id)); const by = new Map(); for (const e of active) if (ids.has(e.requestId)) (by.get(e.requestId) ?? by.set(e.requestId, []).get(e.requestId)).push(e);
  const reached = { quote: 0, booking: 0, sale: 0, lost: 0 }; const last = { none: 0, quote: 0, booking: 0, sale: 0, lost: 0 }; const money = {}; let unknownAmount = 0; let sales = 0;
  for (const r of requests) {
    const evs = by.get(r.id) ?? []; const types = new Set(evs.map((e) => e.type));
    for (const k of types) reached[PIPE_STATE_OF[k]] += 1;
    const l = pipeLast(evs); last[l ? PIPE_STATE_OF[l.type] : 'none'] += 1;
    const sale = evs.filter((e) => e.type === 'sale_closed'); if (sale.length) { sales += 1; const withAmt = sale.filter((e) => Number.isFinite(e.amount)); if (!withAmt.length) unknownAmount += 1; else { const e = pipeLast(withAmt); money[e.currency || 'EUR'] = (money[e.currency || 'EUR'] ?? 0) + e.amount; } }
  }
  const q = requests.length; const rate = (n) => (q > 0 ? Math.round((n / q) * 1000) / 10 : null);
  return { qualified: q, reached, last, rates: { quote: rate(reached.quote), booking: rate(reached.booking), sale: rate(reached.sale) }, money, unknownAmount, salesWithoutAmount: unknownAmount, sales };
}
/** The three groups the screen shows: attributed to the test's publication (source or declared by the merchant), unknown origin (kept at the merchant's level), all. */
function pipelineSummary({ requests, events, from = null, to = null }) {
  const active = pipeActive(events); const isAttr = (r) => (r.provenance === 'connection' || r.provenance === 'declared') && r.kind !== 'site'; const isSite = (r) => r.kind === 'site' && r.provenance === 'declared';
  const attributed = requests.filter(isAttr); const site = requests.filter(isSite); const unknown = requests.filter((r) => !isAttr(r) && !isSite(r));
  return { period: { from, to }, all: pipeCount(requests, active), attributed: pipeCount(attributed, active), site: pipeCount(site, active), unknown: pipeCount(unknown, active) };
}

// ---------- writes: append-only, idempotent ----------
let pipeSeq = 0;
function pipeNextId(st) { const last = st.events.reduce((m, e) => (e.at > m ? e.at : m), ''); let ms = Date.now(); if (last && Date.parse(last) >= ms) ms = Date.parse(last) + 1; pipeSeq += 1; return { at: new Date(ms).toISOString(), id: `ev_${ms}_${pipeSeq}` }; }
const pipeSame = (a, b) => a.requestId === b.requestId && a.type === b.type && a.date === b.date && (a.ref ?? '') === (b.ref ?? '') && (a.note ?? '') === (b.note ?? '') && (a.amount ?? null) === (b.amount ?? null) && (a.currency ?? null) === (b.currency ?? null);
/** @returns {{ ok: true, event?: object, duplicate?: boolean } | { ok: false, error: string }} */
function pipeRecord(scope, request, input, { supersedes = null, void: isVoid = false } = {}) {
  if (!scope) return { ok: false, error: 'noScope' };
  const st = pipeRead(scope); const active = pipeActive(st.events).filter((e) => e.requestId === request.id);
  if (supersedes && !st.events.some((e) => e.id === supersedes && e.requestId === request.id)) return { ok: false, error: 'unknownEvent' };
  let ev;
  if (isVoid) ev = { type: 'void', requestId: request.id, supersedes, date: opToday() };
  else {
    if (!PIPE_TYPES.includes(input.type) || !isIsoDay(input.date)) return { ok: false, error: 'invalid' };
    if (input.date > opToday()) return { ok: false, error: 'future' };
    if (request.start && input.date < request.start) return { ok: false, error: 'beforeRequest' };
    // A quote is OPTIONAL (a request may end directly in a booking or a sale). When there is one, the dates must agree: a result is not before the first quote, a quote is not after the first result.
    const others = active.filter((e) => e.id !== supersedes); const first = (types) => others.filter((e) => types.includes(e.type)).sort((x, y) => (x.date < y.date ? -1 : x.date > y.date ? 1 : 0))[0] ?? null;
    const firstQuote = first(['quote_sent']); const firstResult = first(PIPE_RESULTS);
    if (PIPE_RESULTS.includes(input.type) && firstQuote && input.date < firstQuote.date) return { ok: false, error: 'beforeQuote' };
    if (input.type === 'quote_sent' && firstResult && input.date > firstResult.date) return { ok: false, error: 'afterResult' };
    const amount = input.amount === '' || input.amount == null ? null : Number(input.amount);
    if (amount !== null && (!Number.isFinite(amount) || amount < 0 || input.type !== 'sale_closed')) return { ok: false, error: 'amount' };
    const currency = amount === null ? null : String(input.currency || 'EUR').toUpperCase(); if (currency !== null && !/^[A-Z]{3}$/.test(currency)) return { ok: false, error: 'amount' };
    ev = { type: input.type, requestId: request.id, date: input.date, ref: String(input.ref || '').trim().slice(0, 80) || null, note: String(input.note || '').trim().slice(0, 300) || null, amount, currency, source: 'merchant', ...(supersedes ? { supersedes } : {}) };
    if (!supersedes && active.some((e) => pipeSame(e, ev))) return { ok: true, duplicate: true };
    if (supersedes && st.events.filter((e) => e.supersedes === supersedes).some((e) => pipeSame(e, ev))) return { ok: true, duplicate: true };
  }
  Object.assign(ev, pipeNextId(st));
  if (!st.requests[request.id]) st.requests[request.id] = { id: request.id, testId: request.testId ?? null, kind: request.kind, conversationId: request.conversationId ?? null, start: request.start ?? null, qualifiedOn: request.qualifiedOn ?? null, provenance: request.provenance, postId: request.postId ?? null, network: request.network ?? null, accountId: request.accountId ?? null, pagePath: request.pagePath ?? null, label: request.label ?? null };
  st.events.push(ev); pipeWrite(scope, st); return { ok: true, event: ev };
}
/** A request the merchant states by hand: stable id, origin and provenance declared by him (publication of the test / page of the site / unknown). */
function pipeAddManual(scope, testId, origin) {
  if (!scope) return { ok: false, error: 'noScope' };
  if (!isIsoDay(origin.start) || origin.start > opToday()) return { ok: false, error: 'invalid' };
  if (origin.kind === 'publication' && !origin.postId) return { ok: false, error: 'needPost' };
  if (origin.kind === 'site' && !String(origin.pagePath || '').trim()) return { ok: false, error: 'needPage' };
  const st = pipeRead(scope); const n = Object.keys(st.requests).filter((k) => k.startsWith(`req:${testId}:m`)).length + 1; const id = `req:${testId}:m${n}`;
  const provenance = origin.kind === 'unknown' ? 'unknown' : 'declared';
  st.requests[id] = { id, testId, kind: origin.kind === 'site' ? 'site' : 'manual', conversationId: null, start: origin.start, qualifiedOn: origin.start, provenance, postId: origin.kind === 'publication' ? origin.postId : null, network: origin.network ?? null, accountId: origin.accountId ?? null, pagePath: origin.kind === 'site' ? String(origin.pagePath).trim().slice(0, 200) : null, label: String(origin.label || '').trim().slice(0, 80) || null, manual: true };
  pipeWrite(scope, st); return { ok: true, id };
}

// ---------- the requests of a test: the qualified conversations (live) + the ones the merchant stated + every request that already holds an event (kept even when the test leaves the list) ----------
function pipeRequests(scope, testId, live) {
  const st = pipeRead(scope); const out = new Map();
  for (const r of Object.values(st.requests)) if (r.testId === testId) out.set(r.id, { ...r });
  for (const r of live || []) out.set(r.id, { ...(out.get(r.id) || {}), ...r }); // the live reading refreshes the origin (the conversation may have been attached since)
  return [...out.values()].sort((a, b) => String(a.start).localeCompare(String(b.start)) || a.id.localeCompare(b.id));
}
const PIPE_TXT = (key, ...p) => t(`gr.pipe.${key}`, ...p);
const pipeMoney = (m) => Object.entries(m).map(([cur, v]) => `${new Intl.NumberFormat(tag(), { maximumFractionDigits: 2 }).format(v)} ${cur}`).join(' + ');
const pipePct = (v) => (v === null ? t('gr.inbox.na') : `${new Intl.NumberFormat(tag(), { maximumFractionDigits: 1 }).format(v)} %`);

/** The counts of one group: the four figures apart, then rates on the same group, then the money. */
function pipeGroupLines(g, label, period) {
  if (!g.qualified) return [h('p', { class: 'gr-muted' }, `${label} : ${PIPE_TXT('noneInGroup')}`)];
  const lines = [h('p', { class: 'gv-pipe-counts' }, `${label} : `, h('strong', null, PIPE_TXT('counts', num(g.qualified), num(g.reached.quote), num(g.reached.booking), num(g.reached.sale))), g.reached.lost ? ` · ${PIPE_TXT('lost', num(g.reached.lost))}` : '')];
  lines.push(h('p', { class: 'gr-muted' }, PIPE_TXT('rates', num(g.qualified), period, pipePct(g.rates.quote), pipePct(g.rates.booking), pipePct(g.rates.sale))));
  if (g.sales) lines.push(h('p', { class: 'gr-muted' }, Object.keys(g.money).length ? PIPE_TXT('amount', pipeMoney(g.money), g.unknownAmount ? PIPE_TXT('amountUnknown', num(g.unknownAmount)) : '') : PIPE_TXT('amountNone', num(g.sales))));
  return lines;
}
function pipeSummaryBlock(sum) {
  const period = sum.period.from && sum.period.to ? PIPE_TXT('period', dayFmt(sum.period.from, true), dayFmt(pipeAddDay(sum.period.to, -1), true)) : PIPE_TXT('periodNone');
  const kids = [h('strong', null, PIPE_TXT('title'))];
  kids.push(...pipeGroupLines(sum.attributed, PIPE_TXT('groupAttributed'), period)); if (sum.site.qualified) kids.push(...pipeGroupLines(sum.site, PIPE_TXT('groupSite'), period)); kids.push(...pipeGroupLines(sum.unknown, PIPE_TXT('groupUnknown'), period));
  if ([sum.attributed, sum.site, sum.unknown].filter((g) => g.qualified).length > 1) kids.push(...pipeGroupLines(sum.all, PIPE_TXT('groupAll'), period));
  kids.push(h('p', { class: 'gr-muted' }, PIPE_TXT('noDouble')), h('p', { class: 'gr-muted' }, PIPE_TXT('saleNote')));
  return kids;
}
const pipeAddDay = (day, n) => new Date(Date.parse(`${day}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
const pipeOrigin = (r) => (r.provenance === 'connection' ? PIPE_TXT('origin.connection') : r.provenance === 'declared' ? (r.kind === 'site' ? PIPE_TXT('origin.site', r.pagePath || '–') : PIPE_TXT('origin.declared')) : PIPE_TXT('origin.unknown'));

/**
 * The compact panel under the conversations: counts, one line per request (last state, date, source), the form to record a step, the history (every event, corrected ones marked).
 * @param {{ scope: string|null, testId: string, live: object[], applied: object|null, evidence: object, rerender: () => void, period: { from: string|null, to: string|null } }} p
 */
function opPipelinePanel({ scope, testId, live, applied, evidence, rerender, period }) {
  const ui = pipeUi[testId] ?? (pipeUi[testId] = {}); const st = pipeRead(scope); const reqs = pipeRequests(scope, testId, live);
  const sum = pipelineSummary({ requests: reqs, events: st.events, from: period.from, to: period.to }); const active = pipeActive(st.events);
  const status = h('p', { class: 'gv-status', role: 'status' });
  if (ui.msg) { status.replaceChildren(ui.msg); ui.msg = null; } // the message of the last action survives the re-render of the row
  const done = (r, msgKey) => { if (!r.ok) { status.replaceChildren(PIPE_TXT(`err.${r.error}`)); return; } ui.form = null; ui.msg = r.duplicate ? PIPE_TXT('duplicate') : PIPE_TXT(msgKey); rerender(); };
  const head = h('summary', null, `${PIPE_TXT('title')}${sum.all.qualified ? ` · ${PIPE_TXT('line', num(sum.all.qualified), num(sum.all.reached.quote), num(sum.all.reached.sale + sum.all.reached.booking))}` : ''}`);
  const kids = [head, h('p', { class: 'gr-muted gv-pipe-storage' }, PIPE_TXT('storage'))];
  if (!scope) kids.push(h('p', { class: 'gr-muted' }, PIPE_TXT('noScope')));
  if (sum.all.qualified) kids.push(...pipeSummaryBlock(sum)); else kids.push(h('p', { class: 'gr-muted' }, PIPE_TXT('none')));
  const stateText = (r) => { const evs = active.filter((e) => e.requestId === r.id); const l = pipeLast(evs); return l ? `${PIPE_TXT(`stage.${l.type}`)} · ${dayFmt(l.date, true)}${l.ref ? ` · ${l.ref}` : ''} · ${PIPE_TXT('bymerchant')}` : PIPE_TXT('stage.none'); };
  const field = (label, name, type, value, extra) => { const input = h('input', { type, name, value: value ?? '', ...extra }); return { input, label: h('label', null, label, input) }; };
  function eventForm(r, correcting) {
    const cur = correcting ? st.events.find((e) => e.id === correcting) : null; const typeSel = h('select', { name: 'type' }, PIPE_TYPES.map((x) => h('option', { value: x, selected: (cur?.type ?? 'quote_sent') === x ? '' : null }, PIPE_TXT(`stage.${x}`))));
    const date = field(PIPE_TXT('f.date'), 'date', 'date', cur?.date ?? opToday(), { max: opToday() }); const ref = field(PIPE_TXT('f.ref'), 'ref', 'text', cur?.ref, { maxlength: 80 }); const note = field(PIPE_TXT('f.note'), 'note', 'text', cur?.note, { maxlength: 300 });
    const amount = field(PIPE_TXT('f.amount'), 'amount', 'number', cur?.amount, { step: 'any', min: '0' }); const cur3 = field(PIPE_TXT('f.currency'), 'currency', 'text', cur?.currency ?? 'EUR', { maxlength: 3 });
    return h('form', { class: 'gr-follow-form gv-form gv-pipe-form', 'data-form': 'pipe-event', 'data-request': r.id, on: { submit: (ev) => { ev.preventDefault();
      const amt = amount.input.value; const res = pipeRecord(scope, r, { type: typeSel.value || cur?.type || 'quote_sent', date: date.input.value, ref: ref.input.value, note: note.input.value, amount: amt === '' || amt == null ? null : (Number.isFinite(amount.input.valueAsNumber) ? amount.input.valueAsNumber : Number(amt)), currency: cur3.input.value }, { supersedes: correcting });
      done(res, correcting ? 'saved.corrected' : 'saved.recorded'); } } },
      h('label', null, PIPE_TXT('f.type'), typeSel), date.label, ref.label, note.label, h('p', { class: 'gr-muted' }, PIPE_TXT('f.amountHint')), h('div', { class: 'gv-fields' }, amount.label, cur3.label),
      h('button', { type: 'submit', class: 'gv-primary' }, PIPE_TXT(correcting ? 'f.saveCorrection' : 'f.save')), ' ', h('button', { type: 'button', class: 'gv-link', on: { click: () => { ui.form = null; rerender(); } } }, PIPE_TXT('f.cancel')));
  }
  const btn = (label, cls, fn) => h('button', { type: 'button', class: `gv-link ${cls}`, on: { click: fn } }, label);
  const rows = reqs.map((r) => {
    const evsAll = st.events.filter((e) => e.requestId === r.id); const dead = new Set(st.events.filter((e) => e.supersedes).map((e) => e.supersedes));
    const hist = evsAll.length ? h('details', { class: 'gv-pipe-hist' }, h('summary', null, PIPE_TXT('history', num(evsAll.length))), h('ul', null, evsAll.map((e) => h('li', { 'data-event': e.id, class: dead.has(e.id) || e.type === 'void' ? 'gv-pipe-old' : '' },
      e.type === 'void' ? PIPE_TXT('hist.void', dayFmt(e.date, true), dayFmt(pipeDay(e.at), true)) : `${PIPE_TXT(`stage.${e.type}`)} · ${dayFmt(e.date, true)}${e.ref ? ` · ${e.ref}` : ''}${e.note ? ` · ${e.note}` : ''}${Number.isFinite(e.amount) ? ` · ${new Intl.NumberFormat(tag(), { maximumFractionDigits: 2 }).format(e.amount)} ${e.currency}` : ''} · ${PIPE_TXT('recordedOn', dayFmt(pipeDay(e.at), true))}${dead.has(e.id) ? ` · ${PIPE_TXT('hist.replaced')}` : ''}`,
      !dead.has(e.id) && e.type !== 'void' ? [' ', btn(PIPE_TXT('f.correct'), 'gv-correct', () => { ui.form = { request: r.id, correcting: e.id }; rerender(); }), ' ', btn(PIPE_TXT('f.withdraw'), 'gv-withdraw', () => done(pipeRecord(scope, r, {}, { supersedes: e.id, void: true }), 'saved.withdrawn'))] : null)))) : null;
    return h('li', { class: 'gv-pipe-req', 'data-request': r.id, 'data-prov': r.provenance },
      h('span', null, `${r.label || r.conversationId || r.id.split(':').at(-1)} · ${pipeOrigin(r)} · ${PIPE_TXT('qualifiedOn', dayFmt(r.start || r.qualifiedOn, true))} · `), h('strong', { class: 'gv-pipe-state' }, stateText(r)), ' ',
      scope ? btn(PIPE_TXT('f.record'), 'gv-record', () => { ui.form = { request: r.id }; rerender(); }) : null, ui.form && ui.form.request === r.id ? eventForm(r, ui.form.correcting || null) : null, hist);
  });
  if (rows.length) kids.push(h('ul', { class: 'gv-pipe-list' }, rows));
  // a request stated by hand: usable without messaging, CRM, shop or site; its origin is declared by the merchant (never deduced from a date)
  if (scope) {
    const manualForm = () => {
      const kind = h('select', { name: 'kind' }, ['publication', 'site', 'unknown'].map((x) => h('option', { value: x }, PIPE_TXT(`manual.kind.${x}`)))); const date = field(PIPE_TXT('manual.date'), 'start', 'date', opToday(), { max: opToday() }); const label = field(PIPE_TXT('manual.label'), 'label', 'text', '', { maxlength: 80 }); const page = field(PIPE_TXT('manual.page'), 'pagePath', 'text', '', { maxlength: 200, placeholder: '/demander-un-devis' });
      return h('form', { class: 'gr-follow-form gv-form gv-pipe-form', 'data-form': 'pipe-manual', on: { submit: (ev) => { ev.preventDefault();
        const r = pipeAddManual(scope, testId, { kind: kind.value || 'publication', start: date.input.value, label: label.input.value, pagePath: page.input.value, postId: applied && applied.post ? applied.post.id : null, network: evidence.network, accountId: evidence.accountId }); if (r.ok) { ui.manual = false; ui.msg = PIPE_TXT('saved.manual'); rerender(); } else status.replaceChildren(PIPE_TXT(`err.${r.error}`)); } } },
        h('p', { class: 'gr-muted' }, PIPE_TXT('manual.hint')), h('label', null, PIPE_TXT('manual.kind.label'), kind), date.label, label.label, page.label, h('button', { type: 'submit', class: 'gv-primary' }, PIPE_TXT('manual.save')), ' ', h('button', { type: 'button', class: 'gv-link', on: { click: () => { ui.manual = false; rerender(); } } }, PIPE_TXT('f.cancel')));
    };
    kids.push(ui.manual ? manualForm() : h('p', null, btn(PIPE_TXT('manual.add'), 'gv-manual', () => { ui.manual = true; rerender(); })));
  }
  kids.push(status);
  return h('details', { class: 'gv-pipeline', ...(ui.open ? { open: '' } : {}), on: { toggle: (ev) => { ui.open = !!(ev.target && ev.target.open); } } }, ...kids);
}
/** Live requests from the qualified conversations of the test (called by the row with what it already computed). */
function pipeLiveRequests({ testId, evidence, threads, applied, events, stateOf, provOf, from, to }) {
  const out = [];
  for (const c of threads) {
    if (!(c.startedAt && c.startedAt >= from && c.startedAt < to)) continue; const p = provOf(c); if (p === 'other' || stateOf(c) !== 'qualified') continue;
    const q = (events || []).filter((e) => e.type === 'qualify' && e.id === c.id && e.state === 'qualified').at(-1);
    const attributed = p === 'connection' || p === 'declared';
    out.push({ id: `req:${testId}:${c.id}`, testId, kind: 'conversation', conversationId: c.id, start: c.startedAt, qualifiedOn: q ? pipeDay(q.at) : c.startedAt, provenance: p, postId: attributed && applied && applied.post ? applied.post.id : null, network: evidence.network, accountId: evidence.accountId });
  }
  return out;
}
