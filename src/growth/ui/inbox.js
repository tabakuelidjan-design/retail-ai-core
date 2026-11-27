'use strict';
// Nordla Growth - Développement des ventes > Demandes (lot _10): "Générer des demandes qualifiées". Loaded BEFORE opportunities.js (plain scripts share one global scope: the helpers below use the
// helpers of opportunities.js - h, t, num, dayFmt, opFollowUp... - only when they are CALLED, after every script has loaded).
// What it shows: the account's conversations (source figures, per provenance), the test (invitation keyword + a first-reply draft the merchant sends HIMSELF), the conversations of the
// publication's period for the merchant to qualify, and the comparison. Nothing here sends a message: Nordla has no messaging adapter, and the reply is the merchant's, in his own tool.

const INQ_WAIT = ['QUALIFICATION_INCOMPLETE', 'LOW_VOLUME', 'NO_BASELINE', 'NOT_DISTINCT', 'ZERO_CONVERSATIONS'];
const INQ_TYPES = ['quote', 'booking', 'other'];
const INQ_KEYWORD = { quote: 'DEVIS', booking: 'RESERVER', other: 'INFO' };
const INQ_DRAFT = { quote: 'quoteFirstReply', booking: 'bookingFirstReply', other: 'otherFirstReply' };
const inqAddDays = (day, n) => new Date(Date.parse(`${day}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
const inqNet = (n) => (n === 'tiktok' ? 'TikTok' : 'Instagram');
const inqNum = (v) => (Number.isFinite(v) ? num(v) : t('gr.inbox.na'));
const inqPct = (v) => (Number.isFinite(v) ? `${new Intl.NumberFormat(tag(), { maximumFractionDigits: 1 }).format(v)} %` : t('gr.inbox.na'));
/** The text of the action for a type of request (the keyword is the merchant's to reword: it is a proposal). */
const inqAction = (type, days) => t('gr.follow.action.inquiryTest', INQ_KEYWORD[type] ?? INQ_KEYWORD.quote, num(days));

/** The merchant's own confirmations, from the follow-up events: the latest decision per conversation, for the declared publication. */
function inqQualification(events, postId) {
  const q = new Set(); const nq = new Set(); const dec = new Set();
  for (const e of events || []) {
    if (!e || e.postId !== postId) continue;
    if (e.type === 'qualify') { q.delete(e.id); nq.delete(e.id); if (e.state === 'qualified') q.add(e.id); else if (e.state === 'not_qualified') nq.add(e.id); }
    if (e.type === 'attribute') { if (e.on) dec.add(e.id); else dec.delete(e.id); }
  }
  return { qualified: [...q], notQualified: [...nq], declared: [...dec] };
}
const inqQuery = (qual) => `&qualified=${encodeURIComponent(qual.qualified.join(','))}&notQualified=${encodeURIComponent(qual.notQualified.join(','))}&declared=${encodeURIComponent(qual.declared.join(','))}`;

// ---------- the test: invitation + first-reply draft (copyable), for the chosen type of request ----------
function opInquiryBlock(type) {
  const ty = INQ_TYPES.includes(type) ? type : 'quote'; const status = h('span', { class: 'gr-muted', role: 'status' });
  const text = t(`gr.inbox.draft.${INQ_DRAFT[ty]}`);
  const box = h('details', { class: 'gv-brief gv-inquiry' }, h('summary', null, t('gr.inbox.draft.title')),
    h('p', null, t('gr.inbox.keyword', INQ_KEYWORD[ty])), h('pre', { class: 'gv-brief-text' }, text), h('p', { class: 'gr-muted' }, t('gr.inbox.noSend')),
    h('p', null, h('button', { type: 'button', class: 'gv-link', on: { click: () => { Promise.resolve().then(() => navigator.clipboard.writeText(text)).then(() => status.replaceChildren(t('gr.inbox.copied')), () => status.replaceChildren(t('gr.mail.copyFailed'))); } } }, t('gr.inbox.copy')), ' ', status));
  return box;
}

// ---------- the fold in Opportunités ----------
function opInboxCard(d) {
  const a = d.inbox; if (!a) return null;
  const items = Array.isArray(a.items) ? a.items : []; const dayBefore = (iso) => inqAddDays(iso, -1);
  const ok = (a.accounts || []).filter((x) => x.state === 'OK');
  const target = typeof hashParam === 'function' ? hashParam('open') : null; // deep link from « Suivi commercial »: #/opportunities?open=<id>
  const linked = Boolean(target) && items.some((i) => i.id === target);
  const signal = items.length ? t('gr.inbox.signal', num(items.length)) : t('gr.inbox.state.NOT_CONNECTED');
  const body = [];
  for (const acc of a.accounts || []) {
    const net = inqNet(acc.network);
    if (acc.state !== 'OK') { body.push(h('p', { class: 'ex-sub gr-pr-intro' }, t(`gr.inbox.note.${acc.state}`, net))); continue; }
    const dg = acc.diagnosis; const r = dg.reading;
    const lines = [t('gr.inbox.account', net, acc.handle || acc.accountId, dayFmt(acc.window.start, true), dayFmt(dayBefore(acc.window.end), true), acc.source, t(`gr.inbox.grain.${r.grain || 'none'}`)),
      r.grain === 'threads' ? t('gr.inbox.counts', num(r.conversations), num(r.attributed), num(r.unknownOrigin)) : r.grain === 'aggregate' ? t('gr.inbox.countsAggregate', inqNum(r.attributed)) : r.grain === 'totals' ? t('gr.inbox.countsTotals', inqNum(r.conversations)) : t('gr.inbox.na'),
      r.grain === 'threads' ? t('gr.inbox.bySource', num(r.qualifiedBySource), num(r.unreviewedBySource)) : null,
      r.requests === null || r.requests === undefined ? t('gr.inbox.requestsNA') : t('gr.inbox.requests', num(r.requests)),
      r.duplicatesDropped ? t('gr.inbox.dups', num(r.duplicatesDropped), num(r.originConflicts || 0)) : null, r.multiMessage ? t('gr.inbox.multi', num(r.multiMessage)) : null,
      t(`gr.inbox.status.${dg.status}`)].filter(Boolean);
    body.push(h('div', { class: 'gv-social-account' }, ...lines.map((x, i) => h('p', { class: i ? 'ex-sub gr-muted' : 'ex-sub gr-pr-intro' }, x))));
  }
  if (items.length) body.push(h('div', { class: 'ex-movers gv-priorities' }, items.map((i) => {
    const acc = (a.accounts || []).find((x) => x.network === i.evidence.network); const threads = acc && acc.threads ? acc.threads : [];
    return opFollowUp(d.historyScope, opSnapshot(i), { priorityId: i.id, rowClass: true, open: i.id === target, publication: i.publication ?? null, inbox: { threads }, onChange: () => render() });
  })));
  if (target && !linked) body.push(h('p', { class: 'ex-sub gr-muted', role: 'status' }, t('gr.inbox.linkMissing')));
  return h('details', { class: 'ex-card gr-pr-card gv-fold gv-watch gv-inbox', ...(linked ? { open: '' } : {}) }, h('summary', null, h('span', { class: 'gv-fold-title' }, t('gr.inbox.title')), h('span', { class: 'gv-fold-signal' }, signal)), ...body);
}

// ---------- the conversations of the publication's period, to qualify (inside the test's row, on demand) ----------
/** What the row knows about the conversations of the publication's period: the window, the provenance of each conversation, the merchant's decision per conversation. Null until a publication is linked. */
function inqContext({ inbox, evidence, events, applied }) {
  if (!applied || !applied.post) return null;
  const threads = (inbox && inbox.threads) || []; const postId = applied.post.id; const days = evidence.observationDays || 7; const from = applied.date; const to = inqAddDays(from, days);
  const qual = inqQualification(events, postId); const Q = new Set(qual.qualified); const NQ = new Set(qual.notQualified); const DEC = new Set(qual.declared);
  const provOf = (c) => (c.origin && c.origin.postId === postId ? c.origin.attribution : !c.origin && DEC.has(c.id) ? 'declared' : c.origin ? 'other' : 'unknown');
  const stateOf = (c) => (Q.has(c.id) ? 'qualified' : NQ.has(c.id) ? 'not_qualified' : c.source || 'unreviewed');
  return { threads, postId, days, from, to, provOf, stateOf, inWin: threads.filter((c) => c.startedAt && c.startedAt >= from && c.startedAt < to) };
}
function opInboxPanel({ inbox, evidence, events, plan, applied, save, rerender }) {
  const threads = (inbox && inbox.threads) || [];
  const head = h('summary', null, `${t('gr.inbox.conv.title')}${threads.length ? ` (${num(threads.length)})` : ''}`);
  if (!plan) return h('details', { class: 'gv-inbox-panel' }, head, h('p', { class: 'gr-muted' }, t('gr.inbox.conv.needPlan')));
  const cx = inqContext({ inbox, evidence, events, applied });
  if (!cx) return h('details', { class: 'gv-inbox-panel' }, head, h('p', { class: 'gr-muted' }, t('gr.inbox.conv.needPost')));
  const { postId, from, to, inWin, provOf: prov, stateOf } = cx;
  const mine = inWin.filter((c) => prov(c) === 'connection' || prov(c) === 'declared');
  const rec = (type, id, extra) => save({ type, at: new Date().toISOString(), planAt: plan.at, postId, id, ...extra }, plan.at);
  const todo = mine.filter((c) => stateOf(c) === 'unreviewed');
  const btn = (label, cls, fn) => h('button', { type: 'button', class: `gv-link ${cls}`, on: { click: fn } }, label);
  const rows = inWin.filter((c) => prov(c) !== 'other').slice(0, 60).map((c) => {
    const p = prov(c); const st = stateOf(c);
    return h('li', { class: 'gv-conv', 'data-conv': c.id, 'data-prov': p },
      h('span', null, `${c.id} · ${dayFmt(c.startedAt, false)} · ${t('gr.inbox.conv.messages', num(c.messages ?? 1))} · ${t(`gr.inbox.prov.${p}`)} · `), h('strong', { class: 'gv-conv-state' }, t(`gr.inbox.state.${st}`)), ' ',
      ...[p === 'unknown' ? btn(t('gr.inbox.conv.attach'), 'gv-attach', () => rec('attribute', c.id, { on: true })) : p === 'declared' && !c.origin ? btn(t('gr.inbox.conv.detach'), 'gv-detach', () => rec('attribute', c.id, { on: false })) : null,
        btn(t('gr.inbox.conv.qualify'), 'gv-q', () => rec('qualify', c.id, { state: 'qualified' })), btn(t('gr.inbox.conv.reject'), 'gv-nq', () => rec('qualify', c.id, { state: 'not_qualified' })), st === 'unreviewed' ? null : btn(t('gr.inbox.conv.reset'), 'gv-rq', () => rec('qualify', c.id, { state: 'unreviewed' }))].filter(Boolean).flatMap((x) => [x, ' ']));
  });
  return h('details', { class: 'gv-inbox-panel' }, head,
    h('p', { class: 'gr-muted' }, t('gr.inbox.conv.period', dayFmt(from, true), dayFmt(inqAddDays(to, -1), true), t('gr.inbox.conv.postRef', postId))),
    h('p', { class: 'gr-muted' }, t('gr.inbox.conv.definition')),
    rows.length ? h('ul', { class: 'gv-convs' }, rows) : h('p', { class: 'gr-muted' }, t('gr.inbox.conv.none')),
    todo.length ? h('p', null, btn(t('gr.inbox.conv.bulk', num(todo.length)), 'gv-bulk', () => { for (const c of todo) rec('qualify', c.id, { state: 'not_qualified' }); })) : null,
    h('p', { class: 'gr-muted' }, t('gr.inbox.conv.provNote')));
}

// ---------- the comparison (review) ----------
function opInboxBody(c, baseline, stored) {
  const kids = [h('strong', null, t('gr.review.title.compare'))]; const k = c.counts;
  if (c.state === 'ZERO') kids.push(h('p', { class: 'gv-compare-line' }, t('gr.inbox.review.zero')));
  else if (k && Number.isFinite(c.rate)) {
    kids.push(h('p', { class: 'gv-compare-line' }, c.incomplete ? t('gr.inbox.review.provisional', opInboxLine(c)) : c.state === 'COMPARABLE' ? h('strong', null, opInboxLine(c)) : opInboxLine(c)));
    kids.push(h('p', { class: 'gr-muted' }, t('gr.inbox.review.scope')));
    kids.push(h('p', { class: 'gr-muted' }, t('gr.inbox.review.prov', num(k.byProvenance.connection), num(k.byProvenance.declared))));
    kids.push(h('p', { class: 'gr-muted' }, k.requests === null || k.requests === undefined ? t('gr.inbox.requestsNA') : t('gr.inbox.requests', num(k.requests))));
    if (k.multiMessage) kids.push(h('p', { class: 'gr-muted' }, t('gr.inbox.multi', num(k.multiMessage))));
    if (c.baseline) kids.push(h('p', { class: 'gr-muted' }, t('gr.inbox.review.baseline', num(c.baseline.n), num(c.baseline.unique), num(c.baseline.qualified), inqPct(c.baseline.rate))));
    if (Number.isFinite(baseline)) kids.push(h('p', { class: 'gr-muted gv-manual-baseline' }, t('gr.review.manualBaseline', opMeasure(baseline))));
  } else kids.push(h('p', null, t('gr.review.limited')), h('p', { class: 'gr-muted' }, t('gr.review.manual')));
  if (c.incomplete) kids.push(h('p', null, t('gr.inbox.review.unreviewed', num(k.unreviewed))));
  if (c.lowVolume) kids.push(h('p', { class: 'gr-muted' }, t('gr.inbox.review.low', num(k.unique))));
  for (const l of (c.limits || [])) kids.push(h('p', { class: 'gr-muted' }, t(`gr.inbox.limit.${l}`)));
  if (c.limits && c.limits.includes('ATTRIBUTION_UNAVAILABLE')) kids.push(h('p', { class: 'gr-muted' }, t('gr.inbox.review.noPost')));
  const al = c.accountLevel;
  if (al) kids.push(h('p', { class: 'gr-muted gv-account-level' }, Number.isFinite(al.unknownOrigin) ? t('gr.inbox.review.account', inqNum(al.conversations), num(al.unknownOrigin)) : t('gr.inbox.review.accountTotals', inqNum(al.conversations), inqNum(al.qualified), Number.isFinite(al.requests) ? num(al.requests) : t('gr.inbox.na'))));
  if (c.accountLevel && c.accountLevel.duplicatesDropped) kids.push(h('p', { class: 'gr-muted' }, t('gr.inbox.dups', num(c.accountLevel.duplicatesDropped), num(c.accountLevel.originConflicts || 0))));
  if (c.next) kids.push(h('p', { class: 'gv-next' }, c.next.code === 'wait' ? t(INQ_WAIT.includes(c.next.reason) ? `gr.inbox.review.wait.${c.next.reason}` : 'gr.inbox.review.wait.limit') : t(`gr.inbox.review.next.${c.next.code}`)));
  if (c.source) kids.push(h('p', { class: 'gr-muted' }, t('gr.inbox.review.source', c.source, dayFmt(c.sourceWindow.start, true), dayFmt(inqAddDays(c.sourceWindow.end, -1), true), t(`gr.inbox.grain.${c.grain || 'none'}`))));
  kids.push(h('p', { class: 'gr-muted' }, t('gr.review.calculatedAt', opFollowDate(c.calculatedAt)), stored ? ` ${t('gr.review.frozen')}` : ''));
  return h('div', { class: 'gv-compare', 'data-compare': c.state, ...(stored ? { 'data-stored': 'true' } : {}) }, ...kids);
}
function opInboxLine(c) {
  const k = c.counts; const base = t('gr.inbox.review.line', inqPct(c.rate), num(k.qualified), num(k.unique));
  return c.baseline && c.difference ? `${base} · ${t('gr.inbox.review.vs', inqPct(c.baseline.rate), `${c.difference.points > 0 ? '+' : ''}${new Intl.NumberFormat(tag(), { maximumFractionDigits: 1 }).format(c.difference.points)}`)}` : base;
}
