'use strict';
// Développement des ventes - Opportunités page. Loaded BEFORE app.js (same pattern as Analytics' explorer.js): nothing runs at load
// time; the functions below use app.js helpers (h, t, money, num, chip, cardHead, icoBubble, gi, kpi) only when app.js renders the
// page. Every item comes from /api/growth/opportunities = the priorities aggregated from the four real engines (Produits
// Potentiels, Audience, Croissance magasin, Contenu), recomputed on every request. Three sections (owner decision 2026-09-28):
//   À corriger maintenant       reliable data problems, grouped by problem;
//   Opportunités commerciales   only what an engine validated with its existing thresholds (may be empty: stated honestly);
//   À surveiller                signals too weak, or blocked by a guard, to become a recommendation.
// Follow-up is recorded locally in the browser and does not modify connected services.

const OP_PAGE_HASH = { potential: '#/potential', audience: '#/audience', storeGrowth: '#/storeGrowth', content: '#/content' };
const opPct = (v) => new Intl.NumberFormat(tag(), { style: 'percent', maximumFractionDigits: 0 }).format(v);
const opDay = (d) => new Date(Date.UTC(2024, 0, 1 + d)).toLocaleDateString(tag(), { weekday: 'long', timeZone: 'UTC' });
// Decorative three dots of the clickable rows of Produits Potentiels / Audience (they open the row's detail panel).
function opDots() {
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  s.setAttribute('viewBox', '0 0 16 4'); s.setAttribute('width', '16'); s.setAttribute('height', '4');
  for (const cx of [2, 8, 14]) { const c = document.createElementNS(s.namespaceURI, 'circle'); c.setAttribute('cx', cx); c.setAttribute('cy', '2'); c.setAttribute('r', '1.6'); c.setAttribute('fill', 'currentColor'); s.appendChild(c); }
  return s;
}
// Largest-remainder rounding to 1 decimal, so a donut legend adds up to exactly 100 % (used by Contenu's priority donut).
function opPctRound(values) {
  const total = values.reduce((a, b) => a + b, 0) || 1;
  const raw = values.map((v) => (v / total) * 1000); const out = raw.map(Math.floor);
  let left = 1000 - out.reduce((a, b) => a + b, 0);
  raw.map((v, i) => [v - Math.floor(v), i]).sort((a, b) => b[0] - a[0]).forEach(([, i]) => { if (left > 0) { out[i] += 1; left -= 1; } });
  return out.map((v) => v / 10);
}
/** A real link to the page where the items can be examined (navigation only). */
const opLink = (page) => h('a', { class: 'gr-op-link', href: OP_PAGE_HASH[page] }, t(`gr.op.link.${page}`));

// Nothing could be read (all four engines unavailable): no figure was computed, so no 0 and no "nothing to do" message (same rule as the overview).
const opAllDown = (d) => { const v = Object.values(d.sources || {}); return v.length > 0 && v.every((x) => x !== 'ok'); };

// ---------- À corriger maintenant: one row per problem, never one per product ----------
function opFixTitle(g) {
  return g.kind === 'purchaseCost' ? t('gr.op.fix.purchaseCost.title', num(g.evidence.count)) : t(`gr.op.fix.content.${g.problem}.title`, num(g.evidence.count));
}
function opFixRow(g) {
  const cost = g.kind === 'purchaseCost';
  const facts = cost
    ? [chip(t('gr.op.fix.purchaseCost.detail', num(g.evidence.unverified), num(g.evidence.missing)), 'mute'), g.evidence.blockedRecommendations ? chip(t('gr.op.fix.purchaseCost.blocked', num(g.evidence.blockedRecommendations)), 'gr-warn') : null]
    : [g.evidence.soldAffected ? chip(t('gr.op.fix.soldAffected', num(g.evidence.soldAffected)), 'mute') : null];
  return h('div', { class: 'ex-mover gr-row gr-pr-row', 'data-priority-id': g.id },
    icoBubble(cost ? 'srcCost' : 'content'),
    h('div', { class: 'ex-mover-main' },
      h('div', { class: 'ex-mover-name' }, opFixTitle(g)),
      h('div', { class: 'ex-mover-sub gr-wrap' }, t(cost ? 'gr.op.fix.purchaseCost.why' : `gr.op.fix.content.${g.problem}.why`)),
      cost ? h('div', { class: 'ex-mover-sub gr-wrap' }, t('gr.op.fix.purchaseCost.pending')) : null,
      g.examples.length ? h('div', { class: 'gr-pr-examples' }, h('span', { class: 'gr-muted' }, t('gr.op.fix.examples')), g.examples.map((e) => chip(e.title, 'mute'))) : null,
      h('div', { class: 'gr-att-meta' }, facts, opLink(g.sourcePage), h('a', { class: 'gr-op-link gr-op-export', href: opDossierHref(cost ? 'purchaseCost' : g.problem), download: '', 'data-export': cost ? 'purchaseCost' : g.problem }, t('gr.op.fix.dossier.one')))));
}
// The correction file: a plain download link to the server (read only). No script, no merchant parameter.
const opDossierHref = (category) => `/api/growth/corrections?category=${encodeURIComponent(category)}`;
function opFixCard(d) {
  const groups = d.sections.fix; const n = groups.length; const corr = d.counts.fixCorrections;
  const plural = (k, count) => t(`gr.op.fix.${k}.${count === 1 ? 'one' : 'other'}`, num(count));
  return h('details', { class: 'ex-card gr-pr-card gr-pr-fix gv-fold gv-watch' },
    h('summary', null, h('span', { class: 'gv-fold-title' }, t('gr.op.fix.title')),
      groups.length ? h('span', { class: 'gv-fold-signal' }, `${plural('categories', n)} · ${t('gr.op.kpi.fixNote', num(corr))}`) : null),
    h('p', { class: 'ex-sub gr-pr-intro' }, t('gr.op.fix.intro')),
    groups.length ? h('p', { class: 'ex-sub gr-pr-intro' }, t('gr.kpi.fixHint')) : null,
    groups.length ? h('p', { class: 'gr-op-dossier' }, h('a', { class: 'gv-primary gr-op-dossier-btn', href: opDossierHref('all'), download: '', 'data-export': 'all' }, t('gr.op.fix.dossier.all')), h('span', { class: 'gr-muted' }, t('gr.op.fix.dossier.hint'))) : null,
    groups.length ? h('div', { class: 'ex-movers' }, groups.map(opFixRow)) : h('div', { class: 'gr-pp-empty', 'data-fix-state': d.fixState || 'CHECKED' }, t(d.fixState === 'NO_DATA' ? 'gr.op.fix.emptyNoData' : d.fixState === 'PARTIAL' ? 'gr.op.fix.emptyPartial' : 'gr.op.fix.empty')));
}

// ---------- Opportunités commerciales: validated by an engine, or an honest empty state ----------
function opCommercialTitle(i) {
  if (i.kind === 'product') return t(`gr.op.item.product.${i.title.code.split('.')[1]}.title`, i.entity.title);
  if (i.kind === 'storeWeekday') return t('gr.op.item.store.weekday.title', opDay(i.title.params.day));
  if (i.kind === 'segment') return t('gr.op.item.segment.title', t(`gr.au.seg.${i.entity.id}`), num(i.evidence.customers));
  if (i.kind === 'adCampaign') return t(`gr.op.item.ad.${i.evidence.status}.title`, i.entity.title);
  if (i.kind === 'sitePage') return t(`gr.op.item.site.${i.evidence.status}.title`, i.entity.title);
  if (i.kind === 'socialTest') return t(`gr.op.item.social.${i.evidence.status}.title`, opSocialNetwork(i.evidence.network));
  if (i.kind === 'inquiryTest') return t('gr.op.item.inbox.title', opSocialNetwork(i.evidence.network), INQ_KEYWORD[i.evidence.requestType] ?? INQ_KEYWORD.quote);
  return i.id;
}
function opCommercialWhy(i) {
  if (i.kind === 'product') return t(`gr.op.item.product.${i.title.code.split('.')[1]}.why`);
  if (i.kind === 'storeWeekday') return t('gr.op.item.store.weekday.why', opPct(i.evidence.share));
  if (i.kind === 'segment') return t('gr.op.item.segment.commercial.why');
  if (i.kind === 'adCampaign') return t(`gr.op.item.ad.${i.evidence.status}.why`);
  if (i.kind === 'sitePage') return t(`gr.op.item.site.${i.evidence.status}.why`);
  if (i.kind === 'socialTest') return t(`gr.op.item.social.${i.evidence.status}.why`);
  if (i.kind === 'inquiryTest') return t(`gr.op.item.inbox.${i.evidence.status}.why`);
  return '';
}
const OP_ITEM_ICON = { product: 'produits', storeWeekday: 'calendrier', segment: 'segmentClient', adCampaign: 'prix', sitePage: 'content', socialTest: 'audience', inquiryTest: 'audience' };
// ---------- Opportunités commerciales: ONE main action card (mockup 02) and, when there are several actions, a compact list that opens each one ----------
const wk = (key, ...p) => t(`gr.wk.${key}`, ...p);
const safe0 = (f) => { try { return f(); } catch (e) { console.error('growth optional block failed', e); return null; } }; // an optional block never takes the page down
function opWeeklyReasons(w) {
  const r = w.reasons; const lines = [];
  lines.push(wk(`validated.${r.validatedBy}`));
  lines.push(r.gaps.length ? r.gaps.map((g) => wk(`gap.${g}`)).join(' ') : wk('gap.none'));
  lines.push(r.feasibility.code === 'immediate' ? wk('feas.immediate') : wk(`feas.${r.feasibility.prerequisite}`));
  lines.push(r.tie === 'alone' ? wk('tie.alone') : r.tie === 'displayOrder' ? wk('tie.displayOrder') : r.tie === 'equalFigures' ? wk('tie.equalFigures') : r.tie.position === 'between' ? wk('tie.between', wk(`metric.${r.tie.metric}`)) : wk(`tie.magnitude.${r.tie.metric}.${r.tie.position}`));
  return lines;
}
/** Items in display order: the prioritised ones first (their ranking order), then the others in payload order. */
function opOrdered(d) {
  const items = d.sections.commercial; const byId = new Map(items.map((i) => [i.id, i]));
  const ranked = d.weekly && d.weekly.state === 'ok' ? d.weekly.items.filter((w) => byId.has(w.id)) : [];
  const rankedIds = new Set(ranked.map((w) => w.id));
  return { order: [...ranked.map((w) => byId.get(w.id)), ...items.filter((i) => !rankedIds.has(i.id))], weeklyById: new Map(ranked.map((w) => [w.id, w])) };
}
/** The states that are not "a ranked action to show": nothing eligible, a source down, candidates blocked. Said, never hidden. */
function opWeeklyNotes(d) {
  const wkly = d.weekly; if (!wkly) return [];
  const byId = new Map(d.sections.commercial.map((i) => [i.id, i]));
  const out = [];
  if (wkly.state !== 'ok' && !(wkly.state === 'empty' && !d.sections.commercial.length)) {
    out.push(h('div', { class: 'gr-pp-empty gr-pr-empty' }, h('strong', { class: 'gr-ink' }, wk(wkly.state === 'empty' ? 'empty.title' : 'emptyPartial.title')),
      h('span', null, wkly.state === 'unavailable' ? wk('unavailable.text') : wkly.state === 'emptyPartial' ? wk('emptyPartial.text', wkly.unavailableSources.map((k) => t(`gr.nav.${{ products: 'potential', audience: 'audience', store: 'storeGrowth', content: 'content' }[k]}`)).join(', ')) : wk('empty.text'))));
  }
  for (const b of (wkly.blocked || [])) if (byId.has(b.id)) out.push(h('p', { class: 'gr-muted gr-wk-blocked' }, wk('blocked', opCommercialTitle(byId.get(b.id)), wk(`block.${b.reason}`))));
  return out;
}
/** The commercial section: the prioritised actions (up to three) as compact lines, one under the other, then "Autres actions" folded. Each line opens its own form and detail. */
function opCommercialCard(d) {
  const items = d.sections.commercial;
  const notes = safe0(() => opWeeklyNotes(d)) || [];
  if (!items.length) {
    return h('div', { class: 'ex-card gr-pr-card gr-pr-commercial' },
      cardHead('opportunities', t('gr.op.com.title')),
      h('p', { class: 'ex-sub gr-pr-intro' }, t('gr.op.com.intro')),
      h('div', { class: 'gr-pp-empty gr-pr-empty' },
        h('strong', { class: 'gr-ink' }, t('gr.op.com.emptyTitle')),
        h('span', null, t('gr.op.com.emptyText')),
        d.waiting.length ? h('ul', null, d.waiting.map((w) => h('li', null, opWaiting(w)))) : null),
      ...notes);
  }
  const o = opOrdered(d);
  const ranked = o.order.filter((i) => o.weeklyById.has(i.id)); const others = o.order.filter((i) => !o.weeklyById.has(i.id));
  const line = (i) => { const w = o.weeklyById.get(i.id) ?? null; return opFollowUp(d.historyScope, opSnapshot(i), { weekly: w, rank: w ? w.rank : null, priorityId: i.id, rowClass: true, featuredOffer: i.orientation?.featuredOffer ?? null, featuredLabel: i.orientation ? t('gr.op.featured') : null, onChange: () => render() }); };
  return h('div', { class: 'ex-card gr-pr-card gr-pr-commercial gv-work' },
    h('h2', { class: 'gv-head' }, ranked.length ? wk('title') : t('gr.op.com.title')),
    ranked.length ? h('div', { class: 'ex-movers gv-priorities' }, ranked.map(line)) : null,
    ...notes,
    others.length ? h('details', { class: 'gv-fold gv-others' }, h('summary', null, opFollowLabel('otherActions', num(others.length))), h('div', { class: 'ex-movers' }, others.map(line))) : null);
}
// ---------- Campagnes publicitaires (lot _06): the ad source's facts, the diagnosis, the action - one compact fold, the same follow-up as every other action ----------
const opAdMoney = (v, c) => (Number.isFinite(v) ? new Intl.NumberFormat(tag(), { style: 'currency', currency: c || 'EUR', maximumFractionDigits: 2 }).format(v) : '–');
const opAdChannel = (k) => ({ meta_ads: 'Meta Ads', google_ads: 'Google Ads' })[k] || k || '–';
const opAdPeriod = (m) => (m && m.start && m.end ? `${dayFmt(m.start, true)} – ${dayFmt(new Date(Date.parse(`${m.end}T00:00:00Z`) - 86400000).toISOString().slice(0, 10), true)}` : null);
function opAdsCard(d) {
  const a = d.ads; if (!a) return null;
  const items = Array.isArray(a.items) ? a.items : []; const channel = opAdChannel(a.channel);
  const signal = a.state === 'OK' ? (items.length ? t('gr.ads.signal', num(items.length)) : t('gr.ads.signalNone')) : t(`gr.ads.state.${a.state}`);
  const others = (a.campaigns || []).filter((c) => !c.actionable);
  const body = a.state !== 'OK' ? [h('p', { class: 'ex-sub gr-pr-intro' }, t(`gr.ads.note.${a.state}`, channel))] : [
    h('p', { class: 'ex-sub gr-pr-intro' }, t('gr.ads.intro', channel, dayFmt(a.window.start, true), dayFmt(new Date(Date.parse(`${a.window.end}T00:00:00Z`) - 86400000).toISOString().slice(0, 10), true), num(a.lagDays))),
    items.length ? h('div', { class: 'ex-movers gv-priorities' }, items.map((i) => opFollowUp(d.historyScope, opSnapshot(i), { priorityId: i.id, rowClass: true, onChange: () => render() }))) : null,
    others.length ? h('div', { class: 'gv-ads-others' }, h('strong', null, t('gr.ads.others')), h('ul', null, others.map((c) => h('li', null, `${c.campaignName ?? c.campaignId} : ${t(`gr.ads.status.${c.status}`)}`)))) : null];
  return h('details', { class: 'ex-card gr-pr-card gv-fold gv-watch gv-ads' }, h('summary', null, h('span', { class: 'gv-fold-title' }, t('gr.ads.title')), h('span', { class: 'gv-fold-signal' }, signal)), ...body);
}
// ---------- Site indépendant (lot _07): a service page that receives quote requests - GA4 facts, the diagnosis, the action, the same follow-up ----------
function opSiteCard(d) {
  const a = d.site; if (!a) return null;
  const items = Array.isArray(a.items) ? a.items : []; const dayBefore = (iso) => new Date(Date.parse(`${iso}T00:00:00Z`) - 86400000).toISOString().slice(0, 10);
  const signal = a.state === 'OK' ? (items.length ? t('gr.site.signal', num(items.length)) : t('gr.site.signalNone')) : t(`gr.site.state.${a.state}`);
  const others = (a.pages || []).filter((p) => !p.actionable);
  const fresh = a.retrievedAt ? new Date(a.retrievedAt).toLocaleDateString(tag()) : '–';
  const body = a.state !== 'OK' ? [h('p', { class: 'ex-sub gr-pr-intro' }, t(`gr.site.note.${a.state}`))] : [
    h('p', { class: 'ex-sub gr-pr-intro' }, t('gr.site.intro', a.siteUrl, a.propertyId, dayFmt(a.window.start, true), dayFmt(dayBefore(a.window.end), true), a.timeZone, 'GA4', fresh)),
    a.hasSearchConsole ? h('p', { class: 'ex-sub gr-muted' }, t('gr.site.gscNote')) : null,
    items.length ? h('div', { class: 'ex-movers gv-priorities' }, items.map((i) => opFollowUp(d.historyScope, opSnapshot(i), { priorityId: i.id, rowClass: true, onChange: () => render() }))) : null,
    others.length ? h('div', { class: 'gv-ads-others' }, h('strong', null, t('gr.site.others')), h('ul', null, others.map((p) => h('li', null, `${p.path} : ${t(`gr.site.status.${p.status}`)}`)))) : null];
  return h('details', { class: 'ex-card gr-pr-card gv-fold gv-watch gv-site' }, h('summary', null, h('span', { class: 'gv-fold-title' }, t('gr.site.title')), h('span', { class: 'gv-fold-signal' }, signal)), ...body);
}
// ---------- Abonnés (lot _08): "Gagner des abonnés" on Instagram / TikTok - the account's facts, the direction, the Creator brief, the same follow-up ----------
const opRate = (v) => new Intl.NumberFormat(tag(), { maximumFractionDigits: 2 }).format(v);
const opSocialNetwork = (k) => ({ instagram: 'Instagram', tiktok: 'TikTok' })[k] || k || '–';
const opSocialFormat = (f) => { const k = `gr.social.format.${f}`; const v = t(k); return v === k ? (f || '–') : v; };
/** The post the merchant declares: its link must belong to the network of the test; its id comes from the link or from the field. A declared association, checked later against the source. */
function opParsePost(url, id, network) {
  const m = /^https:\/\/([^\/?#\s]+)([^?#\s]*)/i.exec(url || ''); if (!m) return { error: 'gr.social.postMismatch' };
  const host = m[1].replace(/^www\./i, '').toLowerCase(); const wanted = { instagram: 'instagram.com', tiktok: 'tiktok.com' }[network];
  if (!wanted || !(host === wanted || host.endsWith(`.${wanted}`))) return { error: 'gr.social.postMismatch' };
  const idm = /\/(?:reel|reels|p|tv|video)\/([A-Za-z0-9_.-]+)/.exec(m[2]); const pid = id || (idm ? idm[1] : '');
  return pid ? { value: { id: pid, url: `https://${m[1]}${m[2]}` } } : { error: 'gr.social.postNoId' };
}
function opBriefText(b) {
  const shots = b.shots.map((x) => `${x.order}. ${t(`gr.social.shot.${x.code}`)}${x.code === 'transformation' && b.show.length ? ` (${b.show.join(', ')})` : ''}`);
  const ev = b.evidence.map((e) => `- ${e.url} · ${e.date ?? '–'} · ${opSocialFormat(e.format)} · ${Number.isFinite(e.rate) ? opRate(e.rate) : '–'}`);
  return [`${t('gr.social.brief.title', num(b.version))} · ${b.networkName} ${b.account.handle ?? b.account.id}`, `${t('gr.social.brief.format')} : ${opSocialFormat(b.format)}`, `${t('gr.social.brief.hook')} : ${b.hook.text ?? '–'}`, `${t('gr.social.brief.shots')} :`, ...shots,
    `${t('gr.social.brief.tone')} : ${b.tone ?? '–'}`, `${t('gr.social.brief.cta')} : ${t('gr.social.brief.ctaFollow')}`, `${t('gr.social.brief.metric')} : ${t('gr.social.brief.metricText', num(b.successMetric.observationDays), t('gr.social.paid.organic'))}`,
    b.option.trialReels.requested ? (b.option.trialReels.available ? t('gr.social.brief.trial') : t('gr.social.brief.trialUnknown')) : null, `${t('gr.social.brief.evidence')} :`, ...ev, `${b.briefId}`].filter((x) => x != null).join('\n');
}
function opBriefBlock(b) {
  if (!b) return null; const text = opBriefText(b); const status = h('span', { class: 'gr-muted', role: 'status' });
  return h('details', { class: 'gv-brief' }, h('summary', null, t('gr.social.brief.title', num(b.version))), h('pre', { class: 'gv-brief-text' }, text), h('p', { class: 'gr-muted' }, t('gr.social.brief.note')),
    h('p', null, h('button', { type: 'button', class: 'gv-link', on: { click: () => { Promise.resolve().then(() => navigator.clipboard.writeText(text)).then(() => status.replaceChildren(t('gr.social.brief.copied')), () => status.replaceChildren(t('gr.mail.copyFailed'))); } } }, t('gr.social.brief.copy')), ' ',
      h('a', { class: 'gr-op-link', href: `data:application/json;charset=utf-8,${encodeURIComponent(JSON.stringify(b, null, 2))}`, download: `brief-${b.briefId}.json`, 'data-export': 'brief' }, t('gr.social.brief.download')), ' ', status));
}
function opSocialCard(d) {
  const a = d.social; if (!a) return null;
  const items = Array.isArray(a.items) ? a.items : []; const dayBefore = (iso) => new Date(Date.parse(`${iso}T00:00:00Z`) - 86400000).toISOString().slice(0, 10);
  const ok = (a.accounts || []).filter((x) => x.state === 'OK');
  const signal = ok.length ? (items.length ? t('gr.social.signal', num(items.length)) : t('gr.social.signalNone')) : t('gr.social.state.NOT_CONNECTED');
  const body = [];
  for (const acc of a.accounts || []) {
    const net = opSocialNetwork(acc.network);
    if (acc.state !== 'OK') { body.push(h('p', { class: 'ex-sub gr-pr-intro' }, t(`gr.social.note.${acc.state}`, net))); continue; }
    const dg = acc.diagnosis; const ac = dg.account;
    const lines = [t('gr.social.account', net, acc.handle || acc.accountId, dayFmt(acc.window.start, true), dayFmt(dayBefore(acc.window.end), true), acc.source),
      Number.isFinite(ac.netVariation) ? t('gr.social.net', opSigned(ac.netVariation), num(ac.startTotal), num(ac.endTotal)) : t('gr.social.netUnavailable'),
      ac.grossAvailable ? t('gr.social.gross', num(ac.gained), num(ac.lost)) : t('gr.social.grossUnavailable'),
      ac.funnel ? t('gr.social.funnel', Number.isFinite(ac.funnel.reach) ? num(ac.funnel.reach) : '–', Number.isFinite(ac.funnel.profileVisits) ? num(ac.funnel.profileVisits) : '–', Number.isFinite(ac.funnel.follows) ? num(ac.funnel.follows) : '–') : null,
      dg.status === 'ATTRIBUTION_UNAVAILABLE' ? t('gr.social.noAttribution') : null].filter(Boolean);
    body.push(h('div', { class: 'gv-social-account' }, ...lines.map((x, i) => h('p', { class: i ? 'ex-sub gr-muted' : 'ex-sub gr-pr-intro' }, x))));
    if (dg.groups.length) body.push(h('details', { class: 'gv-social-groups' }, h('summary', null, `${t('gr.social.groups')} (${num(dg.groups.reduce((x, g) => x + g.n, 0))})`), h('ul', null, dg.groups.map((g) => h('li', null, t('gr.social.group', opSocialFormat(g.format), net, num(g.ageDays), num(g.n), opRate(g.rate))))),
      dg.otherStatuses ? h('p', { class: 'gr-muted' }, t('gr.social.otherStatuses', num(dg.otherStatuses.sponsored), num(dg.otherStatuses.unknown))) : null));
    if (!['SIGNAL', 'TREND', 'ATTRIBUTION_UNAVAILABLE'].includes(dg.status)) body.push(h('p', { class: 'ex-sub gr-muted' }, t(`gr.social.status.${dg.status}`)));
  }
  if (items.length) body.push(h('div', { class: 'ex-movers gv-priorities' }, items.map((i) => opFollowUp(d.historyScope, opSnapshot(i), { priorityId: i.id, rowClass: true, publication: i.publication ?? null, onChange: () => render() }))));
  return h('details', { class: 'ex-card gr-pr-card gv-fold gv-watch gv-social' }, h('summary', null, h('span', { class: 'gv-fold-title' }, t('gr.social.title')), h('span', { class: 'gv-fold-signal' }, signal)), ...body);
}
function opWaiting(w) {
  const p = w.params || {};
  switch (w.code) {
    case 'productSales': return t('gr.op.wait.productSales', num(p.insufficient), num(p.total), num(p.weeks), num(p.minUnits));
    case 'verifiedCosts': return t('gr.op.wait.verifiedCosts', num(p.count), num(p.total));
    case 'identifiedCustomers': return t('gr.op.wait.identifiedCustomers', num(p.identified), num(p.min));
    case 'storeHistory': return t('gr.op.wait.storeHistory', num(p.weeks));
    case 'onlineOrders': return t('gr.op.wait.onlineOrders', num(p.orders), num(p.min));
    case 'storeOrders': return t('gr.op.wait.storeOrders', num(p.orders), num(p.min));
    default: return w.code;
  }
}

// ---------- À surveiller: one card per product (every engine's findings merged), and segments to watch ----------
function opFinding(f) {
  const p = f.params || {};
  if (f.source === 'products' && f.code.startsWith('potential.')) {
    const out = [chip(t(`gr.op.f.${f.code}`), f.code === 'potential.push' || f.code === 'potential.topSeller' ? 'gr-good' : 'mute')];
    if (p.trend === 'UP') out.push(chip(t('gr.op.f.risingDemand'), 'mute'));
    return out;
  }
  if (f.source === 'store') return chip(t(`gr.op.f.${f.code}`, num(p.rank)), f.code === 'storeTopBlocked' || f.code === 'storeSuggestedNotRecommended' ? 'gr-warn' : 'mute');
  return chip(t(`gr.op.f.${f.code}`), f.code === 'costUnverified' || f.code === 'costMissing' ? 'gr-warn' : 'mute');
}
function opMissing(m) {
  const p = m.params || {};
  return m.code === 'moreWeeks' ? t('gr.op.m.moreWeeks', num(p.weeks), num(p.units)) : t(`gr.op.m.${m.code}`);
}
function opWatchRow(i) {
  if (i.kind === 'segment') {
    return h('div', { class: 'ex-mover gr-row gr-pr-row', 'data-priority-id': i.id },
      icoBubble('segmentClient'),
      h('div', { class: 'ex-mover-main' },
        h('div', { class: 'ex-mover-name' }, t('gr.op.item.segment.title', t(`gr.au.seg.${i.entity.id}`), num(i.evidence.customers))),
        h('div', { class: 'ex-mover-sub gr-wrap' }, t('gr.op.item.segment.watch.why')),
        h('div', { class: 'gr-att-meta' }, chip(t('gr.op.rel.limited'), 'gr-warn'), opLink(i.sourcePage))));
  }
  const e = i.evidence;
  const volume = [e.units != null && e.weeks != null ? t('gr.op.volume', num(e.units), num(e.weeks)) : null, e.storeRank != null && e.storeShare != null ? t('gr.op.volumeStore', num(e.storeRank), opPct(e.storeShare)) : null].filter(Boolean).join(' · ');
  return h('div', { class: 'ex-mover gr-row gr-pr-row', 'data-priority-id': i.id },
    icoBubble('produits'),
    h('div', { class: 'ex-mover-main' },
      h('div', { class: 'ex-mover-name' }, i.entity.title),
      volume ? h('div', { class: 'ex-mover-sub' }, volume) : null,
      h('div', { class: 'gr-pr-findings' }, i.findings.map(opFinding)),
      h('div', { class: 'ex-mover-sub gr-wrap' }, t(`gr.op.why.${i.explanation.code.split('.').pop()}`)),
      i.missing.length ? h('div', { class: 'ex-mover-sub gr-wrap' }, h('strong', { class: 'gr-ink' }, t('gr.op.missing')), ' ', i.missing.map(opMissing).join(' · ')) : null,
      h('div', { class: 'gr-att-meta' }, chip(t('gr.op.rel.limited'), 'gr-warn'), i.relatedPages.map(opLink))));
}
function opWatchCard(d) {
  const items = d.sections.watch;
  return h('details', { class: 'ex-card gr-pr-card gr-pr-watch gv-watch' },
    h('summary', null, h('span', { class: 'gv-fold-title' }, t('gr.op.watch.title')), h('span', { class: 'gv-fold-signal' }, num(items.length))),
    h('p', { class: 'ex-sub gr-pr-intro' }, t('gr.op.watch.intro')),
    items.length ? h('div', { class: 'ex-movers' }, items.map(opWatchRow)) : h('div', { class: 'gr-pp-empty' }, t('gr.op.watch.empty')));
}

/** Sources that could not be read are named, never hidden. */
function opSourcesNote(d) {
  const down = Object.entries(d.sources).filter(([, v]) => v !== 'ok').map(([k]) => t(`gr.nav.${{ products: 'potential', audience: 'audience', store: 'storeGrowth', content: 'content' }[k]}`));
  return down.length ? h('div', { class: 'ex-card gr-pr-card' }, h('div', { class: 'gr-pp-empty' }, t('gr.op.srcUnavailable', down.join(', ')))) : null;
}

function renderOpportunities(main, safe) {
  const note = safe(opSourcesNote);
  if (note) main.appendChild(note);
  if (safe(opAllDown) === true) {
    main.appendChild(h('div', { class: 'ex-card gr-pr-card' }, h('div', { class: 'gr-pp-empty' }, t('gr.ov.prioritiesUnavailable'))));
    const archivedDown = safe(opArchivedFollowUps); if (archivedDown) main.appendChild(archivedDown);
    return;
  }
  const guide = safe(opGuideCard); if (guide) main.appendChild(guide); // the function guide: ONE closed line, every function, its state for this merchant
  main.appendChild(safe(opCommercialCard)); // the main action first (mockup 02): what to do now, before the data corrections
  const reviews = safe(opReviewCard); if (reviews) main.appendChild(reviews);
  const archived = safe(opArchivedFollowUps);
  if (archived) main.appendChild(archived);
  const socialBlock = safe(opSocialCard); if (socialBlock) main.appendChild(socialBlock); // lot _08: shown only when a social source is wired (connected or explicitly not connected)
  const inboxBlock = safe(opInboxCard); if (inboxBlock) main.appendChild(inboxBlock);
  const agentBlock = safe(agentDraftsCard); if (agentBlock) main.appendChild(agentBlock); // A3: the Stratège drafts already produced, with their state // lot _10: conversations and qualified requests, shown only when an inbox source is wired
  const siteBlock = safe(opSiteCard); if (siteBlock) main.appendChild(siteBlock); // lot _07: shown only when a site source is wired (connected or explicitly not connected)
  const adsBlock = safe(opAdsCard); if (adsBlock) main.appendChild(adsBlock); // lot _06: shown only when an ad source is wired (connected or explicitly not connected)
  main.appendChild(h('div', { class: 'gr-pr-sections' }, safe(opFixCard), safe(opWatchCard))); // folded: the signal stays visible in the closed label
  main.appendChild(h('p', { class: 'ex-foot gr-pr-foot' }, t('gr.op.foot')));
}

const opHistoryPrefix = (scope) => `nordla.growth.follow-up.v1:${scope}:`;
const opHistoryKey = (scope, id) => opHistoryPrefix(scope) + encodeURIComponent(id);
const opFollowLabel = (key, ...params) => t(`gr.follow.${key}`, ...params);
const opMeasure = (value) => new Intl.NumberFormat(tag(), { maximumFractionDigits: 6 }).format(value);
const opFollowDate = (value) => new Date(value).toLocaleString(tag());

function opProposal(a) {
  if (!a) return null;
  if (a.code === 'socialTest') {
    const d = a.brief ? a.brief.direction : null;
    return { action: a.change === 'testDirection' ? opFollowLabel('action.socialTest.testDirection', opSocialFormat(a.brief.format), d.value || a.brief.format, num(a.observationDays)) : opFollowLabel('action.socialTest.accountLevel', num(a.observationDays)),
      metric: opFollowLabel('metric.socialTest'), draft: null, campaign: null, brief: a.brief ?? null, facts: [] };
  }
  if (a.code === 'inquiryTest') return { action: inqAction(a.requestType, a.observationDays), metric: opFollowLabel('metric.inquiryTest'), draft: null, campaign: null, brief: null, inquiry: { type: a.requestType, keyword: a.keyword }, facts: [] };
  if (a.code === 'siteForm') return { action: opFollowLabel(`action.siteForm.${a.change === 'reviewForm' ? 'reviewForm' : a.missing}`, a.page.path), metric: opFollowLabel(`metric.siteForm.${a.change === 'reviewForm' ? 'reviewForm' : 'fixMeasure'}`), draft: null, campaign: null, facts: [] };
  if (a.code === 'adCheck') return { action: opFollowLabel(`action.adCheck.${a.check}`, a.campaign.name), metric: opFollowLabel('metric.adCheck'), draft: null, campaign: null, facts: [] };
  const title = a.target?.title;
  const variant = a.variant;
  const args = a.code === 'storeWeekday' ? [opDay(a.day)]
    : a.code === 'segment' ? [t(`gr.au.seg.${a.segment}`)]
    : variant ? [title, variant.title] : [title];
  const facts = [];
  if (variant) facts.push(opFollowLabel('variantEvidence', num(variant.unitsNet), opFollowDate(variant.since),
    opFollowDate(variant.until), num(variant.stockUnits), opFollowDate(variant.stockSnapshotAt)));
  if (variant && Number.isFinite(variant.coverWeeks)) facts.push(opFollowLabel('variantCover', num(variant.coverWeeks), num(variant.minCoverWeeks)));
  const why = a.variantReason;
  if (why) facts.push(opFollowLabel(`noVariant.${why.code}`, why.title ?? '', why.weeks == null ? '' : num(why.weeks), why.minWeeks == null ? '' : num(why.minWeeks)));
  if (Number.isFinite(a.marginPct)) facts.push(opFollowLabel('productMargin', opPct(a.marginPct)));
  const campaign = a.campaign;
  const hasDraft = ['variant', 'product'].includes(a.code);
  return {
    action: opFollowLabel(campaign ? `campaign.${campaign.purpose}.action` : `action.${a.code}`, ...args),
    metric: opFollowLabel(`metric.${a.code}`),
    draft: hasDraft ? opFollowLabel('draft.product', ...args) : null,
    campaign: campaign ? {
      audience: a.segment ? args[0] : null,
      customers: campaign.customers,
      days: campaign.days,
      baselineOrders: campaign.baselineOrders,
      segmentKey: a.segment, purpose: campaign.purpose, reason: campaign.reason ?? null, eligible: campaign.eligible ?? null,
      subject: opFollowLabel(`campaign.${campaign.purpose}.subject`),
      body: opFollowLabel(`campaign.${campaign.purpose}.body`),
      cta: opFollowLabel(`campaign.${campaign.purpose}.cta`),
    } : null,
    facts,
  };
}

/** What the marketer must see before mailing: the exact segment, why it was selected, the analysed period, its size (an analysis, not recipients) and what Growth does NOT know (the eligible send list). */
function opCampaignSummary(campaign, measurement) {
  if (!campaign) return null;
  const r = campaign.reason || {}; const pct = (v) => (v == null ? '' : opPct(v));
  const why = r.rule ? t(`gr.au.rule.${r.rule}`, pct(r.revenueShare), pct(r.activeShare), r.previousCustomers == null ? '' : num(r.previousCustomers)) : null;
  const period = opPeriodText(measurement) ?? (Number.isFinite(campaign.days) ? t('gr.mail.periodDays', num(campaign.days)) : null);
  const el = campaign.eligible;
  return h('div', { class: 'gv-campaign-summary' },
    h('p', null, h('strong', null, t('gr.mail.segment')), ' · ', campaign.audience ?? ''),
    why ? h('p', null, h('strong', null, t('gr.mail.why')), ' · ', why) : null,
    period ? h('p', null, h('strong', null, t('gr.mail.period')), ' · ', period) : null,
    Number.isFinite(campaign.customers) ? h('p', null, h('strong', null, t('gr.mail.customers')), ' · ', num(campaign.customers), h('span', { class: 'gr-muted' }, ` — ${t('gr.mail.notRecipients')}`)) : null,
    el && Number.isFinite(el.count) ? h('p', null, h('strong', null, t('gr.mail.eligible')), ' · ', num(el.count), h('span', { class: 'gr-muted' }, ` — ${t('gr.mail.eligibleSource', el.source ?? '')}`))
      : h('p', { class: 'gr-muted gv-eligibility-unknown' }, t('gr.mail.eligibleUnknown')));
}
function opCampaignPreview(campaign) {
  if (!campaign) return null;
  const { audience, customers, days, baselineOrders, subject, body, cta } = campaign;
  const field = (label, value) => h('label', null, opFollowLabel(label), h('textarea', { readonly: '', rows: label === 'campaign.body' ? 3 : 1 }, value));
  return h('div', { class: 'gr-follow-form gr-campaign-draft' },
    h('strong', null, opFollowLabel('campaign.draft')),
    h('p', null, opFollowLabel('campaign.audience'), ' · ', audience,
      Number.isFinite(customers) ? ' · ' + opFollowLabel('campaign.customers', num(customers)) : ''),
    Number.isFinite(days) && Number.isFinite(baselineOrders)
      ? h('p', null, opFollowLabel('campaign.orders', num(baselineOrders), num(days))) : null,
    field('campaign.subject', subject), field('campaign.body', body), field('campaign.cta', cta),
    h('p', { class: 'gr-muted' }, opFollowLabel('campaign.review')));
}

function opActionPreview(proposal, opts = {}) {
  if (!proposal) return null;
  return h('div', { class: 'gr-proposal' }, h('strong', null, opFollowLabel('proposal')),
    h('p', null, proposal.action), proposal.brief ? opBriefBlock(proposal.brief) : null, proposal.inquiry && !opts.noInquiry ? opInquiryBlock(proposal.inquiry.type) : null,
    ...proposal.facts.map((fact) => h('p', { class: 'gr-muted' }, fact)),
    proposal.draft ? h('p', null, opFollowLabel('draft'), ' · ', proposal.draft) : null,
    proposal.campaign && !opts.editable ? opCampaignSummary(proposal.campaign, opts.measurement) : null, // an editable sheet shows its summary once, above the form
    opts.editable ? null : opCampaignPreview(proposal.campaign)); // an editable draft is a form field of the plan, not a read-only copy
}

// ---------- Snapshot of an action: what the sheet shows, kept with the follow-up so the action stays readable when it leaves the active list ----------
function opSummary(i) {
  const a = i.preparedAction;
  if (i.kind === 'storeWeekday' && a) return t('gr.fiche.summary.storeWeekday', opDay(a.day));
  if (a && a.code === 'segment') return t('gr.fiche.summary.segment');
  if (a && a.code === 'adCheck') return t(`gr.fiche.summary.adCheck.${a.check}`);
  if (a && a.code === 'socialTest') return t(`gr.fiche.summary.socialTest.${a.change}`);
  if (a && a.code === 'inquiryTest') return t('gr.fiche.summary.inquiryTest');
  if (a && a.code === 'siteForm') return t(`gr.fiche.summary.siteForm.${a.change === 'reviewForm' ? 'reviewForm' : a.missing}`);
  if (a && a.code === 'restock') return t('gr.fiche.summary.restock');
  if (a && a.code === 'variant' && a.variant) return t('gr.fiche.summary.variant', a.variant.title);
  if (a && a.code === 'product') return t('gr.fiche.summary.product');
  return opCommercialWhy(i);
}
/** "20 sept. – 14 nov. 2026": the end of the window is excluded, so the last day shown is the one before it. */
function opPeriodText(m) {
  if (!m || !m.start || !m.end) return null;
  const f = (v) => new Date(v).toLocaleDateString(tag(), { day: 'numeric', month: 'short', year: 'numeric' });
  return `${f(m.start)} – ${f(new Date(new Date(m.end).getTime() - 1))}`;
}
/** Up to three figures that justify the action, all read from the engine's own evidence (nothing invented): { label, value, unit }. */
function opProof(i) {
  const e = i.evidence ?? {}; const a = i.preparedAction; const m = i.measurement ?? {}; const out = [];
  const weeks = m.start && m.end ? Math.round((new Date(m.end) - new Date(m.start)) / 604800000) : (Number.isFinite(e.weeks) ? e.weeks : null);
  const days = m.start && m.end ? Math.round((new Date(m.end) - new Date(m.start)) / 86400000) : null;
  const push = (label, value, unit = '') => { if (value != null && value !== '') out.push({ label, value, unit }); };
  if (i.kind === 'inquiryTest') {
    const na = t('gr.inbox.na');
    push(t('gr.fiche.proof.socialNetwork'), opSocialNetwork(e.network)); push(t('gr.fiche.proof.socialAccount'), e.handle || e.accountId); if (e.window) push(t('gr.fiche.proof.socialPeriod'), opAdPeriod(m));
    push(t('gr.fiche.proof.inboxGrain'), e.grain ? t(`gr.inbox.grain.${e.grain}`) : na); push(t('gr.fiche.proof.inboxConversations'), Number.isFinite(e.conversations) ? num(e.conversations) : na);
    if (e.grain === 'threads') { push(t('gr.fiche.proof.inboxAttributed'), num(e.attributed)); push(t('gr.fiche.proof.inboxUnknown'), num(e.unknownOrigin)); }
    push(t('gr.fiche.proof.inboxQualified'), Number.isFinite(e.qualifiedBySource) ? num(e.qualifiedBySource) : na);
    if (e.missing && e.missing.length) push(t('gr.fiche.proof.socialMissing'), e.missing.map((x) => t(`gr.inbox.missing.${x}`)).join(' · '));
    push(t('gr.fiche.proof.socialSource'), e.source);
  }
  if (i.kind === 'socialTest') {
    const na = t('gr.fiche.proof.socialUnavailable'); const d = e.direction; const r = (v) => (Number.isFinite(v) ? opRate(v) : na);
    push(t('gr.fiche.proof.socialNetwork'), opSocialNetwork(e.network)); push(t('gr.fiche.proof.socialAccount'), e.handle || e.accountId); push(t('gr.fiche.proof.socialPeriod'), opAdPeriod(m));
    push(t('gr.fiche.proof.socialNet'), Number.isFinite(e.netVariation) ? opSigned(e.netVariation) : na);
    if (d) { push(t('gr.fiche.proof.socialStatus'), t(`gr.social.kind.${d.kind}`)); push(t('gr.fiche.proof.socialElement'), d.structure || d.format); push(t('gr.fiche.proof.socialRate'), r(d.rate)); push(t('gr.fiche.proof.socialBaseline'), r(d.baselineRate)); push(t('gr.fiche.proof.socialRatio'), Number.isFinite(d.ratio) ? `× ${opRate(d.ratio)}` : na); }
    if (e.missing && e.missing.length) push(t('gr.fiche.proof.socialMissing'), e.missing.map((x) => t(`gr.social.missing.${x}`)).join(' · '));
    push(t('gr.fiche.proof.socialSource'), e.source);
  } else if (i.kind === 'sitePage') {
    const na = t('gr.fiche.proof.siteUnavailable'); const n = (v) => (Number.isFinite(v) ? num(v) : na);
    push(t('gr.fiche.proof.siteUrl'), e.url); push(t('gr.fiche.proof.siteProperty'), e.propertyId); push(t('gr.fiche.proof.sitePeriod'), opAdPeriod(m)); push(t('gr.fiche.proof.siteTz'), e.timeZone);
    push(t('gr.fiche.proof.siteSessions'), n(e.sessions)); push(t('gr.fiche.proof.siteStarts'), n(e.starts)); push(t('gr.fiche.proof.siteSubmits'), n(e.submits));
    if (Number.isFinite(e.rate)) { push(t('gr.fiche.proof.siteConverted'), n(e.converted)); push(t('gr.fiche.proof.siteRate'), opPct(e.rate)); }
    push(t('gr.fiche.proof.siteSource'), [String(e.source || '').toUpperCase(), ...Object.entries(e.filters || {}).map(([k, v]) => `${k} : ${v}`)].filter(Boolean).join(' · '));
    if (e.search) push(t('gr.fiche.proof.siteGsc'), `${n(e.search.impressions)} / ${n(e.search.clicks)}`);
  } else if (i.kind === 'adCampaign') {
    push(t('gr.fiche.proof.adChannel'), opAdChannel(e.channel)); push(t('gr.fiche.proof.adCampaign'), i.entity.title);
    push(t('gr.fiche.proof.adPeriod'), opAdPeriod(m)); push(t('gr.fiche.proof.adSpend'), opAdMoney(e.spend, e.currency)); push(t('gr.fiche.proof.adClicks'), num(e.clicks));
    push(t('gr.fiche.proof.adConversions'), Number.isFinite(e.conversions) ? num(e.conversions) : t('gr.fiche.proof.adUnknown'));
    push(t('gr.fiche.proof.adObjective'), e.objective || t('gr.fiche.proof.adObjectiveUnknown')); push(t('gr.fiche.proof.adLag'), num(e.lagDays), t('gr.fiche.unit.days'));
  } else if (i.kind === 'storeWeekday' && a) {
    push(t('gr.fiche.proof.share', opDay(a.day)), Number.isFinite(e.share) ? num(Math.round(e.share * 100)) : null, '%');
    push(t('gr.fiche.proof.storeOrders'), Number.isFinite(e.storeOrders) ? num(e.storeOrders) : null);
    push(t('gr.fiche.proof.period'), weeks != null ? num(weeks) : null, t('gr.fiche.unit.weeks'));
  } else if (a && a.code === 'variant' && a.variant) {
    const v = a.variant;
    push(t('gr.fiche.proof.variantNet'), num(v.unitsNet), t('gr.fiche.unit.units'));
    push(t('gr.fiche.proof.stock'), num(v.stockUnits), t('gr.fiche.unit.units'));
    push(t('gr.fiche.proof.cover'), Number.isFinite(v.coverWeeks) ? num(v.coverWeeks) : null, t('gr.fiche.unit.weeks'));
  } else if (i.kind === 'product') {
    push(t('gr.fiche.proof.netSales'), Number.isFinite(e.netSales) ? money(e.netSales) : null);
    push(t('gr.fiche.proof.period'), weeks != null ? num(weeks) : null, t('gr.fiche.unit.weeks'));
  } else if (i.kind === 'segment') {
    push(t('gr.fiche.proof.customers'), Number.isFinite(e.customers) ? num(e.customers) : null);
    push(t('gr.fiche.proof.segmentOrders'), Number.isFinite(e.orders) ? num(e.orders) : null);
    push(t('gr.fiche.proof.period'), days != null ? num(days) : null, t('gr.fiche.unit.days'));
  }
  return out;
}
function opSnapshot(i) {
  const e = i.evidence;
  const facts = [];
  if (i.kind === 'product' && Number.isFinite(e.netSales)) facts.push([opFollowLabel('sales'), money(e.netSales)]);
  if (i.kind === 'storeWeekday' && Number.isFinite(e.share)) facts.push([opFollowLabel('share'), opPct(e.share)]);
  if (i.kind === 'segment' && Number.isFinite(e.customers)) facts.push([opFollowLabel('customers'), num(e.customers)]);
  if (i.kind === 'adCampaign' && Number.isFinite(e.spend)) facts.push([opFollowLabel('spend'), opAdMoney(e.spend, e.currency)]);
  if (i.kind === 'sitePage' && Number.isFinite(e.sessions)) facts.push([opFollowLabel('sessions'), num(e.sessions)]);
  return { id: i.id, title: opCommercialTitle(i), why: opCommercialWhy(i), facts, measurement: i.measurement ?? {},
    proposal: opProposal(i.preparedAction), code: i.preparedAction ? i.preparedAction.code : null, target: i.kind === 'adCampaign' ? null : (i.target ?? null), /* an ad campaign is changed in the ad platform: no Growth page to open */ prerequisites: i.prerequisites ?? [],
    network: i.evidence ? i.evidence.network ?? null : null, accountId: i.evidence ? i.evidence.accountId ?? null : null, observationDays: i.preparedAction ? i.preparedAction.observationDays ?? null : null,
    requestType: i.preparedAction ? i.preparedAction.requestType ?? null : null,
    kind: i.kind, sourcePage: i.sourcePage, summary: opSummary(i), proof: opProof(i), lineProof: opLineProof(i), targetRef: opTargetRef(i) };
}
/** What the review can compare: the stable id of the product or of the variant that was applied. E-mail, restock and store actions are reviewed by hand in this first scope. */
function opTargetRef(i) {
  const a = i.preparedAction;
  if (!a) return null;
  if (a.code === 'siteForm' && a.change === 'reviewForm' && a.page && a.page.path) return { type: 'page', id: a.page.path }; // the form-completion rate of the exact page
  if (a.code === 'variant' && a.variant && a.variant.id) return { type: 'variant', id: a.variant.id };
  if (a.code === 'product' && a.target && a.target.id) return { type: 'product', id: a.target.id };
  return null;
}
/** The short proof shown on the closed line (the detailed figures and the exact dates are in the detail). */
function opLineProof(i) {
  const e = i.evidence ?? {}; const a = i.preparedAction; const m = i.measurement ?? {}; const fin = Number.isFinite;
  const weeks = m.start && m.end ? Math.round((new Date(m.end) - new Date(m.start)) / 604800000) : (fin(e.weeks) ? e.weeks : null);
  const days = m.start && m.end ? Math.round((new Date(m.end) - new Date(m.start)) / 86400000) : null;
  const pct = (v) => t('gr.line.pct', num(Math.round(v * 100)));
  if (i.kind === 'inquiryTest') return t('gr.line.inbox', `${opSocialNetwork(e.network)} ${e.handle || ''}`.trim(), Number.isFinite(e.conversations) ? t('gr.line.inboxConv', num(e.conversations), Number.isFinite(e.unknownOrigin) ? num(e.unknownOrigin) : t('gr.inbox.na')) : t('gr.line.inboxManual'));
  if (i.kind === 'socialTest') return t('gr.line.social', `${opSocialNetwork(e.network)} ${e.handle || ''}`.trim(), e.direction ? t('gr.line.socialRate', opRate(e.direction.rate), opRate(e.direction.baselineRate)) : (Number.isFinite(e.netVariation) ? t('gr.line.socialNet', opSigned(e.netVariation)) : t('gr.fiche.proof.socialUnavailable')));
  if (i.kind === 'sitePage') return t('gr.line.site', e.path, Number.isFinite(e.rate) ? t('gr.line.siteRate', num(e.converted), num(e.starts), opPct(e.rate)) : t('gr.line.siteMeasure'));
  if (i.kind === 'adCampaign') return t('gr.line.ad', opAdChannel(e.channel), opAdMoney(e.spend, e.currency), Number.isFinite(e.conversions) ? (e.conversions === 0 ? t('gr.line.adZero') : num(e.conversions)) : t('gr.line.adUnknown'));
  if (i.kind === 'storeWeekday' && a) return [fin(e.share) ? t('gr.line.shareDay', pct(e.share), opDay(a.day)) : null, fin(e.storeOrders) ? t('gr.line.storeOrders', num(e.storeOrders)) : null].filter(Boolean).join(' · ');
  if (a && a.code === 'variant' && a.variant) return t('gr.line.variant', num(a.variant.unitsNet), num(a.variant.stockUnits), fin(a.variant.coverWeeks) ? num(a.variant.coverWeeks) : '–');
  if (i.kind === 'product') return fin(e.netSales) ? t('gr.line.productSales', money(e.netSales), weeks != null ? num(weeks) : '–') : opSummary(i);
  if (i.kind === 'segment') return fin(e.customers) ? (fin(e.orders) && days != null ? t('gr.line.segment', num(e.customers), num(e.orders), num(days)) : t('gr.line.segmentNoOrders', num(e.customers), days != null ? num(days) : '–')) : opSummary(i);
  return opSummary(i);
}

// ---------- Follow-up state: what the merchant has recorded in THIS browser, per merchant and per opportunity (events are appended, never rewritten) ----------
//   plan     a revision of the plan (its `at` is the revision id)
//   prereq   the merchant confirmed ONE external prerequisite for ONE plan revision (planAt)
//   applied  the merchant declares the plan revision `planAt` applied on `date` (a later event for the same revision corrects the date)
//   review   the measured result (quality + observed value)
// Three different things are never mixed: a PROPOSAL ready (Growth), an action DECLARED applied (the merchant, not checked by Growth), a result MEASURED (comparable observed value).
const opToday = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

/** A prerequisite confirmation stays valid for later plan revisions that do not change what it was about (the action text, the metric, the product); a change to those asks for a new confirmation. */
function opPrereqValid(events, code) {
  const plans = events.filter((e) => e.type === 'plan'); const cur = plans.at(-1); if (!cur) return false;
  const conf = events.filter((e) => e.type === 'prereq' && e.code === code).at(-1); if (!conf) return false;
  const base = plans.find((p) => p.at === conf.planAt); if (!base) return false;
  return plans.filter((p) => p.at > base.at).every((p) => p.action === base.action && p.metric === base.metric && (p.product ?? '') === (base.product ?? '')
    && (p.campaign?.url ?? '') === (base.campaign?.url ?? '') && (p.campaign?.segment ?? '') === (base.campaign?.segment ?? ''));
}
function opFollowState(events, prerequisites = []) {
  let planIdx = -1; events.forEach((e, i) => { if (e.type === 'plan') planIdx = i; });
  const plan = planIdx >= 0 ? events[planIdx] : null;
  const review = planIdx >= 0 ? events.filter((e, i) => e.type === 'review' && i > planIdx).at(-1) ?? null : null;
  const applied = events.filter((e) => e.type === 'applied').at(-1) ?? null;
  const confirmed = prerequisites.filter((c) => opPrereqValid(events, c));
  const status = review ? (review.quality === 'comparable' ? 'measured' : 'inconclusive') : applied ? 'applied' : plan ? 'planned' : 'ready';
  return { plan, review, applied, confirmed, allConfirmed: prerequisites.length > 0 && confirmed.length === prerequisites.length, status };
}

// ---------- Review of an applied product / variant action: the OBSERVED change in net units, computed by the server when the review is opened (GET /api/growth/review) ----------
const opSigned = (n) => `${n > 0 ? '+' : ''}${num(n)}`;
const opPctSigned = (v) => `${new Intl.NumberFormat(tag(), { maximumFractionDigits: 1, signDisplay: 'exceptZero' }).format(v * 100)} %`;
const opComputedOf = (d) => (d && d.metric === 'qualificationRate' && d.counts && Number.isFinite(d.rate) ? { metric: 'qualificationRate', state: d.state, rule: d.rule, calculatedAt: d.calculatedAt, limits: d.limits || [], counts: d.counts, rate: d.rate, baseline: d.baseline, difference: d.difference, accountLevel: d.accountLevel, next: d.next, plan: d.plan, window: d.window, source: d.source, sourceWindow: d.sourceWindow, grain: d.grain, incomplete: d.incomplete, lowVolume: d.lowVolume }
  : d && d.metric === 'followsPer1000' && d.post && d.baseline && d.difference ? { metric: 'followsPer1000', state: d.state, rule: d.rule, calculatedAt: d.calculatedAt, limits: d.limits || [], post: d.post, baseline: d.baseline, difference: d.difference, accountNet: d.accountNet, next: d.next, plan: d.plan }
  : d && d.metric === 'rate' && d.before && d.after && d.difference ? { metric: 'rate', state: d.state, rule: d.rule, calculatedAt: d.calculatedAt, days: d.windows ? d.windows.days : null, limits: d.limits || [],
  before: { starts: d.before.starts, converted: d.before.converted, rate: d.before.rate, localStart: d.before.localStart, localEnd: d.before.localEnd }, after: { starts: d.after.starts, converted: d.after.converted, rate: d.after.rate, localStart: d.after.localStart, localEnd: d.after.localEnd }, difference: d.difference }
  : d && d.before && d.after && d.difference ? { state: d.state, rule: d.rule, calculatedAt: d.calculatedAt, days: d.windows ? d.windows.days : null, limits: d.limits || [],
  before: { units: d.before.units, gross: d.before.gross, localStart: d.before.localStart, localEnd: d.before.localEnd }, after: { units: d.after.units, gross: d.after.gross, localStart: d.after.localStart, localEnd: d.after.localEnd }, difference: d.difference } : null);
const opComputedLine = (c) => (c.metric === 'qualificationRate' ? opInboxLine(c) : c.metric === 'followsPer1000' ? t('gr.social.review.line', opRate(c.post.rate), num(c.post.follows), num(c.post.reach), opRate(c.baseline.rate), num(c.baseline.follows), num(c.baseline.reach), `${c.difference.perThousand > 0 ? '+' : ''}${opRate(c.difference.perThousand)}`) : c.metric === 'rate' ? `${t('gr.review.rateLine', num(c.before.converted), num(c.before.starts), num(c.after.converted), num(c.after.starts), opSigned(c.difference.points))} · ${t('gr.review.rateRates', opPct(c.before.rate), opPct(c.after.rate))}` : `${t('gr.review.line', num(c.before.units), num(c.after.units), opSigned(c.difference.units))}${c.difference.pct != null ? ` · ${opPctSigned(c.difference.pct)}` : ''}`);
const opWindowText = (w) => { const f = (v) => new Date(`${v}T12:00:00Z`).toLocaleDateString(tag(), { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }); return `${f(w.localStart)} – ${f(new Date(new Date(`${w.localEnd}T12:00:00Z`).getTime() - 86400000).toISOString().slice(0, 10))}`; };
/** The calculated comparison, from a live server answer or from the calculation STORED with a review (same shape for what is displayed). The manual starting value is always shown apart. */
function opSocialBody(c, baseline, stored) {
  const kids = [h('strong', null, t('gr.review.title.compare'))];
  if (c.baseline && c.difference && c.post) {
    kids.push(h('p', { class: 'gv-compare-line' }, c.state === 'COMPARABLE' ? h('strong', null, opComputedLine(c)) : opComputedLine(c)));
    kids.push(h('p', { class: 'gr-muted' }, t('gr.social.review.group', num(c.baseline.n), opSocialNetwork(c.baseline.group.network), opSocialFormat(c.baseline.group.format), t(`gr.social.paid.${c.baseline.group.paid}`), num(c.baseline.group.ageDays))));
  } else if (c.post && Number.isFinite(c.post.rate)) kids.push(h('p', { class: 'gv-compare-line' }, `${opRate(c.post.rate)} · ${num(c.post.follows)}/${num(c.post.reach)}`));
  if (c.post) kids.push(h('p', { class: 'gr-muted' }, t('gr.social.review.post', c.post.url ?? c.post.id)));
  if (c.state === 'COMPARABLE') { kids.push(h('p', { class: 'gr-muted' }, t('gr.social.review.scope'))); if (Number.isFinite(baseline)) kids.push(h('p', { class: 'gr-muted gv-manual-baseline' }, t('gr.review.manualBaseline', opMeasure(baseline)))); }
  else kids.push(h('p', null, t('gr.review.limited')), h('p', { class: 'gr-muted' }, t('gr.review.manual')));
  for (const l of (c.limits || [])) kids.push(h('p', { class: 'gr-muted' }, t(`gr.review.limit.${l}`)));
  if (c.accountNet) kids.push(h('p', { class: 'gr-muted gv-account-net' }, t('gr.social.review.accountNet', num(c.accountNet.start), num(c.accountNet.end), opSigned(c.accountNet.net)))); // a separate observation, at the account level
  if (c.next) kids.push(h('p', { class: 'gv-next' }, t(`gr.social.review.next.${c.next.code}`)));
  kids.push(h('p', { class: 'gr-muted' }, t('gr.review.calculatedAt', opFollowDate(c.calculatedAt)), stored ? ` ${t('gr.review.frozen')}` : ''));
  return h('div', { class: 'gv-compare', 'data-compare': c.state, ...(stored ? { 'data-stored': 'true' } : {}) }, ...kids);
}
function opCompareBody(c, baseline, stored) {
  if (c.metric === 'qualificationRate') return opInboxBody(c, baseline, stored);
  if (c.metric === 'followsPer1000') return opSocialBody(c, baseline, stored);
  const days = c.windows ? c.windows.days : c.days; const kids = [h('strong', null, t('gr.review.title.compare'))];
  if (c.before && c.after && c.difference) {
    kids.push(h('p', { class: 'gv-compare-line' }, c.state === 'COMPARABLE' ? h('strong', null, opComputedLine(opComputedOf(c) ?? c)) : opComputedLine(opComputedOf(c) ?? c)));
    kids.push(h('p', { class: 'gr-muted' }, t('gr.review.windows', opWindowText(c.before), opWindowText(c.after), num(days))));
  }
  if (c.state === 'COMPARABLE') {
    kids.push(h('p', { class: 'gr-muted' }, t(c.metric === 'rate' ? 'gr.review.scopeRate' : 'gr.review.scope')));
    if (Number.isFinite(baseline)) kids.push(h('p', { class: 'gr-muted gv-manual-baseline' }, t('gr.review.manualBaseline', opMeasure(baseline))));
  } else kids.push(h('p', null, t('gr.review.limited')), h('p', { class: 'gr-muted' }, t('gr.review.manual')));
  for (const l of (c.limits || [])) kids.push(h('p', { class: 'gr-muted' }, t(`gr.review.limit.${l}`)));
  kids.push(h('p', { class: 'gr-muted' }, t('gr.review.calculatedAt', opFollowDate(c.calculatedAt)), stored ? ` ${t('gr.review.frozen')}` : ''));
  return h('div', { class: 'gv-compare', 'data-compare': c.state, ...(stored ? { 'data-stored': 'true' } : {}) }, ...kids);
}
/** The comparison block of the result panel: the calculation stored with the review when there is one (it never changes afterwards), else the live one, or the limit with the manual review left open. */
function opCompareBlock(cmp, evidence, plan, applied, review) {
  if (review && review.computed) return opCompareBody(review.computed, review.baseline, true);
  if (review) return null; // a review entered by hand stays a manual review
  if (!plan || !applied) return null;
  if (!evidence.targetRef && !((evidence.code === 'socialTest' || evidence.code === 'inquiryTest') && applied && applied.post)) return h('p', { class: 'gr-muted gv-compare' }, t('gr.review.manualOnly'));
  if (cmp.status === 'loading' || cmp.status === 'idle') return h('div', { class: 'gv-compare' }, h('strong', null, t('gr.review.title.compare')), h('p', { class: 'gr-muted' }, t('gr.review.loading')));
  if (cmp.status === 'error') return h('div', { class: 'gv-compare' }, h('strong', null, t('gr.review.title.compare')), h('p', null, t('gr.review.error')));
  return opCompareBody(cmp.data, plan.baseline, false);
}

/** A campaign's measures as recorded: the source and the period, then each figure or "unavailable"; the click rate exists only with a known, positive number of delivered e-mails. */
function opCampaignMeasures(rc, review) {
  const v = (x) => (x == null ? t('gr.mail.unavailable') : num(x));
  const rate = rc.clickRate != null ? new Intl.NumberFormat(tag(), { style: 'percent', maximumFractionDigits: 1 }).format(rc.clickRate) : t('gr.mail.rateUnavailable');
  return h('div', { class: 'gv-compare gv-campaign-measures', 'data-campaign-review': 'true' },
    h('strong', null, t('gr.mail.reviewTitle')),
    h('p', null, t('gr.mail.sourceLine', rc.source, rc.periodStart, rc.periodEnd), review && review.planAt ? ` · ${t('gr.mail.sentVersion', opFollowDate(review.planAt))}` : ''),
    h('p', null, `${t('gr.mail.delivered')} : ${v(rc.delivered)} · ${t('gr.mail.clicks')} : ${v(rc.clicks)} · ${t('gr.mail.clickRate')} : ${rate} · ${t('gr.mail.orders')} : ${v(rc.orders)}`),
    h('p', { class: 'gr-muted' }, t('gr.mail.attributedNote')));
}
function opCampaignHistory(e) {
  const c = e.campaign; const v = (x) => (x == null ? t('gr.mail.unavailable') : num(x));
  const rate = c.clickRate != null ? new Intl.NumberFormat(tag(), { style: 'percent', maximumFractionDigits: 1 }).format(c.clickRate) : t('gr.mail.unavailable');
  return `${t('gr.mail.sourceLine', c.source, c.periodStart, c.periodEnd)} · ${t('gr.mail.delivered')} ${v(c.delivered)} · ${t('gr.mail.clicks')} ${v(c.clicks)} · ${t('gr.mail.clickRate')} ${rate} · ${t('gr.mail.orders')} ${v(c.orders)}${e.planAt ? ` · ${t('gr.mail.sentVersion', opFollowDate(e.planAt))}` : ''}`;
}

// ---------- The action card. One primary button, always the NEXT step for the state the merchant is in:
//   no plan            "Préparer la mise en avant" (opens the plan fields)
//   plan, a check open "<the check> vérifié" (records that confirmation, for this plan revision)
//   plan, ready        "Marquer comme appliquée" (records today; the date can be corrected in the follow-up)
//   applied            "Saisir le résultat" (opens the result fields)        measured: "Modifier le résultat"
// Everything else (reasons, the application date, history, local-storage note) is one click away, in the follow-up, when it is needed. ----------
/** Publication sociale, on demand: brief prepared / draft / validated / scheduled / confirmed, the planned date beside the real one, the versions, the review date, and why a plan alone starts nothing. */
function opPublicationPanel(pub, plan, evidence) {
  if (!pub || pub.stage === 'none') return h('details', { class: 'gv-pub' }, h('summary', null, t('gr.pub.title')), h('p', { class: 'gr-muted' }, t('gr.pub.brief')));
  if (pub.stage === 'unavailable') return h('details', { class: 'gv-pub' }, h('summary', null, t('gr.pub.title')), h('p', { class: 'gr-muted' }, t('gr.pub.unavailable')));
  const planV = plan && evidence.proposal && evidence.proposal.brief ? evidence.proposal.brief.version : null;
  const L = pub.links;
  return h('details', { class: 'gv-pub' }, h('summary', null, `${t('gr.pub.title')} · ${t(`gr.pub.stage.${pub.stage}`)}`),
    h('p', null, t('gr.pub.state', t(`gr.pub.stage.${pub.stage}`))),
    pub.plannedDay ? h('p', null, t('gr.pub.planned', dayFmt(pub.plannedDay, true))) : null,
    pub.publishedDay ? h('p', null, t('gr.pub.published', dayFmt(pub.publishedDay, true))) : h('p', { class: 'gr-muted' }, t('gr.pub.notYet')),
    h('p', { class: 'gr-muted' }, t('gr.pub.versions', num(L.briefVersion), num(L.creationVersion))),
    planV != null && planV !== L.briefVersion ? h('p', null, t('gr.pub.briefDiffers', num(planV), num(L.briefVersion))) : null,
    pub.simulated ? h('p', { class: 'gr-muted' }, t('gr.pub.simulated')) : null,
    pub.reviewDueDay ? h('p', null, t('gr.pub.reviewDue', dayFmt(pub.reviewDueDay, true), num(pub.observationDays))) : h('p', { class: 'gr-muted' }, t('gr.pub.noMeasure')),
    pub.openUrl ? h('p', null, h('a', { class: 'gr-op-link', href: pub.openUrl, target: '_blank', rel: 'noopener noreferrer' }, t('gr.pub.open'))) : null);
}

function opFollowUp(scope, snapshot, view = {}) {
  const canSave = !!scope;
  const key = canSave ? opHistoryKey(scope, snapshot.id) : null;
  let openPanel = null; // 'plan' | 'result' | null: a panel opens only when the merchant asks for it (or when the primary step needs it)
  let followOpen = false; let bodyOpen = !!view.open;
  const cmp = { key: null, status: 'idle', data: null }; // the server comparison of this action (product / variant), computed when the review is opened // the body (form, detail, follow-up) is closed until the merchant opens it
  const root = h('article', { class: `gv-action${view.rowClass ? ' gr-pr-row' : ''}`, ...(view.priorityId ? { 'data-priority-id': view.priorityId } : {}), ...(view.rank != null ? { 'data-weekly-rank': String(view.rank) } : {}), ...(view.featuredOffer ? { 'data-featured-offer': view.featuredOffer, 'data-featured-label': view.featuredLabel ?? '' } : {}) }); // a featured offer written in Paramètres > Général (the badge is CSS only: nothing else about the row changes)
  const status = h('p', { class: 'gv-status', role: 'status' });

  function read() { return key ? JSON.parse(growthStorage.getItem(key) ?? 'null') : null; }

  function save(event, expectedPlan) {
    status.replaceChildren();
    try {
      const latest = read();
      // A different tab may have updated this plan while the form was open.
      if ((latest?.events.filter((e) => e.type === 'plan').at(-1)?.at ?? null) !== expectedPlan) {
        render(latest);
        status.append(opFollowLabel('invalid'));
        return;
      }
      const entry = latest ?? { snapshot, events: [] };
      const known = entry.events.filter((e) => e.type === 'applied' && e.planAt === event.planAt).at(-1);
      // No duplicate: the same application date for the same plan revision, or an already valid confirmation, is not recorded twice (double click, reload, second tab).
      if ((event.type === 'applied' && known?.date === event.date && (event.recipients === undefined || (known.recipients ?? null) === (event.recipients ?? null)) && (event.post === undefined || (known.post?.id ?? null) === (event.post?.id ?? null))) || (event.type === 'prereq' && opPrereqValid(entry.events, event.code))) {
        render(entry);
        status.append(opFollowLabel('alreadyRecorded'));
        return;
      }
      // Revision ids are timestamps: strictly increasing per opportunity, so two quick saves never share one.
      const last = entry.events.reduce((m, e) => (e.at > m ? e.at : m), '');
      let ms = Date.now(); if (last && Date.parse(last) >= ms) ms = Date.parse(last) + 1;
      event.at = new Date(ms).toISOString();
      entry.events.push(event);
      growthStorage.setItem(key, JSON.stringify(entry));
      if (event.type === 'plan' || event.type === 'review') openPanel = null;
      render(entry);
      if (event.type === 'review' && view.onChange) setTimeout(() => view.onChange(), 0); // the lists of reviews to do elsewhere on the page are refreshed
      status.append(opFollowLabel(event.type === 'plan' ? 'planSaved' : event.type === 'review' ? 'reviewSaved' : event.type === 'prereq' ? 'prereqSaved' : event.type === 'qualify' || event.type === 'attribute' ? 'qualifySaved' : known ? 'dateCorrected' : 'appliedSaved'));
    } catch {
      status.append(opFollowLabel('storageError'));
    }
  }

  /** Asks the server for the before / after comparison once per (target, application date, review date); the merchant's context is the server's, nothing identifying is sent. */
  function ensureCompare(evidence, plan, applied, events) {
    const ref = evidence.code === 'socialTest' ? (applied && applied.post ? { type: 'post', id: applied.post.id } : null) : evidence.code === 'inquiryTest' ? (applied && applied.post ? { type: 'inbox', id: applied.post.id } : null) : evidence.targetRef; if (!ref || !plan || !applied || typeof fetch !== 'function') return;
    const extra = ref.type === 'inbox' ? `&network=${encodeURIComponent(evidence.network ?? '')}&account=${encodeURIComponent(evidence.accountId ?? '')}&days=${encodeURIComponent(evidence.observationDays ?? 7)}&from=${encodeURIComponent(applied.date)}&requestType=${encodeURIComponent(plan.requestType ?? evidence.requestType ?? 'quote')}${inqQuery(inqQualification(events, applied.post.id))}` : ref.type === 'post' ? `&network=${encodeURIComponent(evidence.network ?? '')}&account=${encodeURIComponent(evidence.accountId ?? '')}&days=${encodeURIComponent(evidence.observationDays ?? 7)}` : '';
    const url = `/api/growth/review?type=${encodeURIComponent(ref.type)}&id=${encodeURIComponent(ref.id)}&applied=${encodeURIComponent(applied.date)}&review=${encodeURIComponent(plan.reviewDate)}${extra}`;
    if (cmp.key === url) return;
    cmp.key = url; cmp.status = 'loading'; cmp.data = null;
    Promise.resolve().then(() => fetch(url)).then((r) => (r && r.ok ? r.json() : Promise.reject(new Error('review unavailable'))))
      .then((data) => { if (cmp.key === url) { cmp.status = 'done'; cmp.data = data; } }, () => { if (cmp.key === url) cmp.status = 'error'; })
      .then(() => { if (cmp.key === url) render(read()); });
  }

  function render(entry) {
    const evidence = entry?.snapshot ?? snapshot;
    const events = entry?.events ?? [];
    const prerequisites = evidence.prerequisites ?? [];
    const code = evidence.code ?? null;
    const st = opFollowState(events, prerequisites);
    const { plan, review, applied } = st;
    const appliedForPlan = plan && applied && applied.planAt === plan.at ? applied : null;
    const isStore = code === 'storeWeekday';
    const pipeCx = code === 'inquiryTest' && view.inbox ? inqContext({ inbox: view.inbox, evidence, events, applied: appliedForPlan ?? applied }) : null; // the commercial follow-up: the qualified conversations of the period (live) + what is stored for this merchant
    const pipeLive = pipeCx ? pipeLiveRequests({ testId: snapshot.id, evidence, threads: pipeCx.threads, applied: appliedForPlan ?? applied, events, stateOf: pipeCx.stateOf, provOf: pipeCx.provOf, from: pipeCx.from, to: pipeCx.to }) : [];
    const pipePeriod = pipeCx ? { from: pipeCx.from, to: pipeCx.to } : { from: null, to: null };
    const pub = (code === 'socialTest' || code === 'inquiryTest') ? (view.publication ?? null) : null;
    const isInq = code === 'inquiryTest';
    const camp = code === 'segment' && evidence.proposal && evidence.proposal.campaign ? evidence.proposal.campaign : null; // a campaign: the draft is editable and the review has its own measures
    const heading = (label) => h('strong', null, opFollowLabel(label));
    const field = (name, type, value = '', extra = {}) => {
      const input = h('input', { type, name, value, required: '', ...extra });
      return { input, label: h('label', null, opFollowLabel(name), input) };
    };

    // ----- plan fields (the order of the store journey: product, starting value, target, review date; then the plan is saved; the action is carried out afterwards) -----
    const product = isStore ? field('product', 'text', plan?.product ?? '', { maxlength: 120 }) : null;
    const baseline = field('baseline', 'number', plan?.baseline, { step: 'any' });
    const target = field('target', 'number', plan?.target, { step: 'any' });
    const reviewDate = field('reviewDate', 'date', plan?.reviewDate);
    const action = field('action', 'text', plan?.action ?? evidence.proposal?.action, { maxlength: 240 });
    const metric = field('metric', 'text', plan?.metric ?? evidence.proposal?.metric, { maxlength: 80 });
    const inqType0 = isInq ? (plan?.requestType ?? evidence.requestType ?? 'quote') : null; // the type of request to follow is the merchant's choice (quote, booking or another explicit request)
    const inqHolder = isInq ? h('div', { class: 'gv-inquiry-holder' }, opInquiryBlock(inqType0)) : null;
    const reqType = isInq ? h('select', { name: 'requestType', on: { change: (ev) => { const v = ev.target.value; inqHolder.replaceChildren(opInquiryBlock(v)); action.input.value = inqAction(v, evidence.observationDays || 7); } } }, INQ_TYPES.map((x) => h('option', { value: x, selected: x === inqType0 ? '' : null }, t(`gr.inbox.type.${x}`)))) : null;
    const cf = camp ? { subject: field('subject', 'text', plan?.campaign?.subject ?? camp.subject, { maxlength: 200 }), cta: field('cta', 'text', plan?.campaign?.cta ?? camp.cta, { maxlength: 80 }),
      url: field('url', 'url', plan?.campaign?.url ?? '', { maxlength: 2000, placeholder: 'https://' }) } : null;
    const bodyDefault = plan?.campaign?.body ?? camp?.body ?? '';
    const bodyArea = camp ? h('textarea', { name: 'body', rows: '5', maxlength: '4000', required: '' }, bodyDefault) : null;
    const copyDraft = camp ? () => {
      const v = (x) => x.input.value ?? x.input.getAttribute('value') ?? '';
      const txt = `${opFollowLabel('subject')}: ${v(cf.subject)}\n\n${bodyArea.value ?? bodyDefault}\n\n${opFollowLabel('cta')}: ${v(cf.cta)}${v(cf.url) ? ` -> ${v(cf.url)}` : ''}`;
      status.replaceChildren();
      Promise.resolve().then(() => navigator.clipboard.writeText(txt)).then(() => status.append(t('gr.mail.copied')), () => status.append(t('gr.mail.copyFailed')));
    } : null;
    const planForm = h('form', { class: 'gr-follow-form gv-form', 'data-form': 'plan', on: { submit: (ev) => {
      ev.preventDefault();
      let campaignDraft = null;
      if (camp) {
        const subject = cf.subject.input.value.trim(); const cta = cf.cta.input.value.trim(); const url = cf.url.input.value.trim(); const body = String(bodyArea.value ?? bodyDefault).trim();
        if (!subject || !cta || !body || !url) { status.replaceChildren(opFollowLabel('invalid')); return; }
        if (!/^https:\/\/[^\s/$.?#][^\s]*$/i.test(url)) { status.replaceChildren(t('gr.mail.invalidUrl')); return; }
        campaignDraft = { segment: camp.segmentKey ?? evidence.target?.id ?? null, subject, body, cta, url };
      }
      const a = action.input.value.trim(), m = metric.input.value.trim();
      const b = baseline.input.valueAsNumber, g = target.input.valueAsNumber;
      const pr = product ? product.input.value.trim() : null;
      if (!a || !m || !Number.isFinite(b) || !Number.isFinite(g) || !reviewDate.input.value || (isStore && !pr)) {
        status.replaceChildren(opFollowLabel('invalid'));
        return;
      }
      if (camp && applied && reviewDate.input.value <= applied.date) { status.replaceChildren(t('gr.mail.reviewBeforeSend', reviewDate.input.value, applied.date)); return; }
      save({ type: 'plan', at: new Date().toISOString(), action: a, metric: m, ...(pr ? { product: pr } : {}), ...(isInq ? { requestType: INQ_TYPES.includes(reqType.value) ? reqType.value : inqType0 } : {}), ...(campaignDraft ? { campaign: campaignDraft } : {}), baseline: b, target: g, reviewDate: reviewDate.input.value }, plan?.at ?? null);
    } } },
    ...(camp ? [h('strong', null, t('gr.mail.draftTitle')), cf.subject.label, h('label', null, t('gr.mail.body'), bodyArea), cf.cta.label, h('label', null, t('gr.mail.url'), cf.url.input), h('p', { class: 'gr-muted' }, t('gr.mail.urlHint')),
      h('button', { type: 'button', class: 'gv-link', on: { click: copyDraft } }, t('gr.mail.copy'))] : []),
    ...(isInq ? [h('label', null, t('gr.inbox.type.label'), reqType)] : []), ...(product ? [product.label] : []), h('div', { class: 'gv-fields' }, baseline.label, target.label, reviewDate.label),
    h('details', { class: 'gv-edit' }, h('summary', null, opFollowLabel('editActionMetric')), action.label, metric.label),
    h('button', { class: 'gv-primary', type: 'submit' }, opFollowLabel('savePlan')));
    const pipeSum = isInq ? pipelineSummary({ requests: pipeRequests(scope, snapshot.id, pipeLive), events: pipeRead(scope).events, from: pipePeriod.from, to: pipePeriod.to }) : null;
    const stepsNode = opTargetSteps(evidence, plan);
    const staticPanel = h('section', { class: 'gv-panel' }, ...(evidence.proposal ? [opActionPreview(evidence.proposal, { measurement: evidence.measurement })] : []), ...stepsNode);
    const planPanel = h('section', { class: 'gv-panel', 'data-panel': 'plan', ...(openPanel === 'plan' ? {} : { hidden: '' }) },
      h('h3', null, opFollowLabel(`cta.prepare.${code ?? 'product'}`)), ...(camp ? [opCampaignSummary(camp, evidence.measurement)] : []), planForm, ...(isInq ? [inqHolder] : []), ...(evidence.proposal ? [opActionPreview(evidence.proposal, { editable: !!camp, measurement: evidence.measurement, noInquiry: isInq })] : []), ...stepsNode);

    // ----- result fields -----
    const rv = review;
    const appliedNow = plan && applied && applied.planAt === plan.at ? applied : null;
    if (openPanel === 'result' && !rv) ensureCompare(evidence, plan, appliedNow, events);
    const cmpData = openPanel === 'result' && !rv && cmp.status === 'done' ? cmp.data : null;
    const prefill = !rv && cmpData && cmpData.state === 'COMPARABLE' && !cmpData.incomplete ? cmpData : null; // only a COMPARABLE calculation prefills the form; the merchant can change every field
    const appliedDate = field('applied', 'date', rv?.applied ?? (appliedForPlan ?? applied)?.date);
    const observed = field('observed', 'number', rv?.observed ?? (prefill ? (prefill.metric === 'qualificationRate' ? prefill.rate : prefill.metric === 'followsPer1000' ? prefill.post.rate : prefill.metric === 'rate' ? Math.round(prefill.after.rate * 10000) / 100 : prefill.after.units) : ''), { step: 'any', required: null });
    const notes = field('notes', 'text', rv?.notes ?? (prefill ? (prefill.metric === 'qualificationRate' ? t('gr.inbox.review.autoNote', inqPct(prefill.rate), num(prefill.counts.qualified), num(prefill.counts.unique)) : prefill.metric === 'followsPer1000' ? t('gr.social.review.autoNote', opRate(prefill.post.rate), opRate(prefill.baseline.rate)) : prefill.metric === 'rate' ? t('gr.review.autoNoteRate', num(prefill.before.converted), num(prefill.before.starts), num(prefill.after.converted), num(prefill.after.starts), num(prefill.windows.days)) : t('gr.review.autoNote', num(prefill.before.units), num(prefill.after.units), num(prefill.windows.days))) : ''), { maxlength: 400 });
    const quality = h('select', { name: 'quality', required: '' }, h('option', { value: '', selected: rv || prefill ? null : '' }, '—'),
      ['comparable', 'insufficient', 'uncertain'].map((q) => h('option', { value: q, selected: (rv?.quality ?? (prefill ? 'comparable' : null)) === q ? '' : null }, opFollowLabel(q))));
    const rc = review && review.campaign ? review.campaign : null;
    const mSource = camp ? field('mSource', 'text', rc?.source ?? '', { maxlength: 80 }) : null;
    const mStart = camp ? field('mStart', 'date', rc?.periodStart ?? '') : null; const mEnd = camp ? field('mEnd', 'date', rc?.periodEnd ?? '', { max: opToday() }) : null;
    const mDelivered = camp ? field('mDelivered', 'number', rc?.delivered ?? '', { step: '1', min: '0', required: null }) : null;
    const mClicks = camp ? field('mClicks', 'number', rc?.clicks ?? '', { step: '1', min: '0', required: null }) : null;
    const mOrders = camp ? field('mOrders', 'number', rc?.orders ?? '', { step: '1', min: '0', required: null }) : null;
    const mNotes = camp ? field('mNotes', 'text', review?.notes ?? '', { maxlength: 400, required: null }) : null;
    const campaignReviewForm = camp && plan ? h('form', { class: 'gr-follow-form gv-form', 'data-form': 'campaign-review', on: { submit: (ev) => {
      ev.preventDefault();
      const n = (x) => { const v = x.input.valueAsNumber; return Number.isFinite(v) ? v : null; };
      const delivered = n(mDelivered); const clicks = n(mClicks); const orders = n(mOrders); const source = mSource.input.value.trim(); const ps = mStart.input.value; const pe = mEnd.input.value;
      const whole = (v) => v == null || (Number.isInteger(v) && v >= 0);
      const sentDate = (appliedForPlan ?? applied)?.date ?? null; // the REAL send date recorded for the version reviewed
      if (!sentDate) { status.replaceChildren(t('gr.mail.sendRequired')); return; }
      if (ps && ps < sentDate) { status.replaceChildren(t('gr.mail.periodBeforeSend', ps, sentDate)); return; } // measures cannot start before the e-mail left
      if (!source || !ps || !pe || ps > pe || pe > opToday() || !whole(delivered) || !whole(clicks) || !whole(orders) || (delivered != null && clicks != null && clicks > delivered)) { status.replaceChildren(t('gr.mail.invalidMeasures')); return; }
      const clickRate = delivered != null && delivered > 0 && clicks != null ? Math.round((clicks / delivered) * 10000) / 10000 : null; // only with a known, positive number of delivered e-mails
      save({ type: 'review', at: new Date().toISOString(), planAt: (appliedForPlan ?? applied)?.planAt ?? plan.at, applied: (appliedForPlan ?? applied)?.date ?? ps, observed: null, quality: delivered != null && delivered > 0 ? 'comparable' : 'insufficient', notes: mNotes.input.value.trim(),
        baseline: plan.baseline, metric: plan.metric, campaign: { source, periodStart: ps, periodEnd: pe, delivered, clicks, orders, clickRate } }, plan.at);
    } } }, ...(rc ? [] : [h('strong', null, t('gr.mail.reviewTitle'))]), h('p', { class: 'gr-muted' }, t('gr.mail.reviewHint')), mSource.label, h('div', { class: 'gv-fields' }, mStart.label, mEnd.label),
    h('div', { class: 'gv-fields' }, mDelivered.label, mClicks.label, mOrders.label), mNotes.label, ...(rc ? [] : [h('p', { class: 'gr-muted' }, t('gr.mail.attributedNote'))]), // once the review is recorded, its title and note are already shown with the recorded measures
    h('button', { class: 'gv-primary', type: 'submit' }, t('gr.mail.saveMeasures'))) : null;
    const resultForm = camp ? campaignReviewForm : plan ? h('form', { class: 'gr-follow-form gv-form', 'data-form': 'review', on: { submit: (ev) => {
      ev.preventDefault();
      const value = observed.input.valueAsNumber;
      const note = notes.input.value.trim();
      if (!appliedDate.input.value || appliedDate.input.value > new Date().toISOString().slice(0, 10) || !note ||
          !['comparable', 'insufficient', 'uncertain'].includes(quality.value) ||
          (quality.value === 'comparable' && !Number.isFinite(value))) {
        status.replaceChildren(opFollowLabel('invalid'));
        return;
      }
      save({ type: 'review', at: new Date().toISOString(), applied: appliedDate.input.value,
        observed: Number.isFinite(value) ? value : null, quality: quality.value, notes: note,
        baseline: plan.baseline, metric: plan.metric, ...(cmpData && cmpData.state === 'COMPARABLE' && !cmpData.incomplete && opComputedOf(cmpData) ? { computed: opComputedOf(cmpData) } : rv && rv.computed ? { computed: rv.computed } : {}) }, plan.at); // only a COMPARABLE calculation is stored with a review: numbers of a limited one are informative, the review is then the merchant's own
    } } }, h('p', { class: 'gr-muted' }, opFollowLabel('comparer')), appliedDate.label, observed.label,
    h('label', null, opFollowLabel('quality'), quality), notes.label,
    h('button', { class: 'gv-primary', type: 'submit' }, opFollowLabel('saveReview'))) : null;
    const resultPanel = h('section', { class: 'gv-panel', 'data-panel': 'result', ...(openPanel === 'result' ? {} : { hidden: '' }) },
      h('h3', null, opFollowLabel('result')),
      opCompareBlock(cmp, evidence, plan, appliedNow, rv),
      isInq && pipeSum.all.qualified ? h('div', { class: 'gv-compare gv-pipe-result' }, ...pipeSummaryBlock(pipeSum)) : null,
      rc ? opCampaignMeasures(rc, review) : null,
      review && !rc ? h('p', { class: 'gv-review-line' }, opFollowLabel(review.quality), review.quality === 'comparable' ? (review.computed ? ` · ${t('gr.review.resultCalculated', opComputedLine(review.computed))}` : ` · ${opFollowLabel('delta')} ${opMeasure(review.observed - review.baseline)} (${review.metric})`) : '') : null,
      ...(resultForm ? [resultForm] : []));

    // ----- the one primary button -----
    const toggle = (name) => { openPanel = openPanel === name ? null : name; if (openPanel) bodyOpen = true; render(read()); };
    const nextPrereq = plan ? prerequisites.find((c) => !opPrereqValid(events, c)) : null;
    let primary = null;
    if (canSave) {
      if (!plan) primary = { label: opFollowLabel('cta.prepareShort'), run: () => toggle('plan'), expanded: openPanel === 'plan' };
      else if (review) primary = { label: opFollowLabel('cta.editResult'), run: () => toggle('result'), expanded: openPanel === 'result' };
      else if (appliedForPlan) primary = { label: opFollowLabel('cta.result'), run: () => toggle('result'), expanded: openPanel === 'result' };
      else if (nextPrereq) primary = { label: opFollowLabel(`prereq.${nextPrereq}.confirm`), run: () => save({ type: 'prereq', at: new Date().toISOString(), planAt: plan.at, code: nextPrereq }, plan.at) };
      else if ((code === 'socialTest' || isInq) && pub && pub.confirmed && pub.publishedDay && pub.networkPostId) primary = { label: opFollowLabel('cta.linkPublication'), run: () => applyOn(pub.publishedDay, undefined, { id: pub.networkPostId, url: pub.permalink ?? null, network: evidence.network, accountId: evidence.accountId, declared: 'calendar', socialPostId: pub.socialPostId, briefVersion: pub.links.briefVersion, creationVersion: pub.links.creationVersion }) };
      else if (code === 'socialTest' || isInq) primary = { label: opFollowLabel('cta.linkPost'), run: () => { followOpen = true; bodyOpen = true; render(read()); } };
      else primary = { label: opFollowLabel(camp ? 'markSent' : 'markApplied'), run: () => applyOn(opToday()) };
    }
    function applyOn(date, recipients, post) {
      if (!plan) return;
      if (!date || date > opToday() || (recipients != null && !(Number.isInteger(recipients) && recipients >= 0))) { status.replaceChildren(opFollowLabel('invalid')); return; }
      if (camp) {
        if (plan.reviewDate && plan.reviewDate <= date) { status.replaceChildren(t('gr.mail.reviewBeforeSend', plan.reviewDate, date)); return; } // the planned review must come after the send
        const rp = review && review.campaign ? review.campaign.periodStart : null;
        if (rp && rp < date) { status.replaceChildren(t('gr.mail.sendConflict', date, rp)); return; } // a recorded review starts before this date: nothing is changed, the history is kept
      }
      save({ type: 'applied', at: new Date().toISOString(), planAt: plan.at, date, ...(camp ? { recipients: recipients ?? null } : {}), ...(post ? { post } : {}),
        prerequisites: prerequisites.length === 0 ? 'none' : st.allConfirmed ? 'confirmed' : 'unconfirmed' }, plan.at);
    }

    // ----- follow-up (reasons, the application date, the checks, history): opened by the merchant when needed -----
    const dateInput = field(camp ? 'sentOn' : 'appliedOn', 'date', appliedForPlan?.date ?? opToday(), { max: opToday() });
    const social = code === 'socialTest' || isInq;
    const mkField = (labelKey, name, type, value, extra) => { const input = h('input', { type, name, value, ...extra }); return { input, label: h('label', null, t(labelKey), input) }; };
    const postUrl = social ? mkField('gr.social.postUrl', 'postUrl', 'url', appliedForPlan?.post?.url ?? '', { maxlength: 500, placeholder: 'https://', required: '' }) : null;
    const postIdInput = social ? mkField('gr.social.postId', 'postId', 'text', appliedForPlan?.post?.id ?? '', { maxlength: 120 }) : null;
    const recipientsInput = camp ? field('recipients', 'number', appliedForPlan?.recipients ?? '', { step: '1', min: '0', required: null }) : null;
    const applyForm = plan ? h('form', { class: 'gr-follow-form gv-form', 'data-form': 'applied', on: { submit: (ev) => { ev.preventDefault();
      if (social) { const post = opParsePost((postUrl.input.value || '').trim(), (postIdInput.input.value || '').trim(), evidence.network); if (post.error) { status.replaceChildren(t(post.error, opSocialNetwork(evidence.network))); return; } applyOn(dateInput.input.value, undefined, { ...post.value, network: evidence.network, accountId: evidence.accountId, declared: 'manual' }); return; }
      const r = recipientsInput ? recipientsInput.input.valueAsNumber : NaN; applyOn(dateInput.input.value, recipientsInput ? (Number.isFinite(r) ? r : null) : undefined); } } },
      ...(social ? [h('p', { class: 'gr-muted' }, t('gr.social.postHint')), postUrl.label, postIdInput.label] : []), dateInput.label, ...(recipientsInput ? [recipientsInput.label, h('p', { class: 'gr-muted' }, opFollowLabel('recipientsHint'))] : []), h('button', { type: 'submit' }, opFollowLabel(appliedForPlan ? (camp ? 'correctSent' : 'correctDate') : (camp ? 'markSent' : 'markApplied')))) : h('p', { class: 'gr-muted' }, opFollowLabel('applyNeedsPlan'));
    const appliedPlan = applied ? events.find((e) => e.type === 'plan' && e.at === applied.planAt) : null;
    const appliedInfo = [];
    if (applied) {
      appliedInfo.push(h('p', null, opFollowLabel(camp ? 'sentOn.recorded' : 'appliedOn.recorded', applied.date, opFollowDate(applied.planAt)), applied.prerequisites === 'unconfirmed' ? ` ${opFollowLabel('appliedUnconfirmed')}` : ''));
      if (applied.post) appliedInfo.push(h('p', null, applied.post.declared === 'calendar' ? t('gr.pub.recorded', applied.post.id, applied.post.url ?? '', applied.date) : t('gr.social.postRecorded', applied.post.id, applied.post.url ?? '')));
      if (camp) appliedInfo.push(h('p', null, applied.recipients == null ? opFollowLabel('recipientsMissing') : opFollowLabel('recipientsRecorded', num(applied.recipients))));
      if (!appliedForPlan) appliedInfo.push(h('p', { class: 'gr-muted' }, opFollowLabel('appliedOlderPlan', opFollowDate(applied.planAt))));
      if (appliedPlan) appliedInfo.push(appliedPlan.reviewDate ? h('p', null, opFollowLabel('afterApplied', appliedPlan.reviewDate)) : h('p', { class: 'gr-muted' }, t('gr.review.none')));
    }
    const prereqBlock = prerequisites.length ? [heading('prereq.title'), ...prerequisites.map((c) => {
      const ok = events.length && opPrereqValid(events, c);
      const had = events.some((e) => e.type === 'prereq' && e.code === c);
      return h('form', { class: 'gr-follow-form', 'data-form': 'prereq', 'data-prereq': c, on: { submit: (ev) => {
        ev.preventDefault();
        if (plan) save({ type: 'prereq', at: new Date().toISOString(), planAt: plan.at, code: c }, plan.at);
      } } }, h('p', null, opFollowLabel(`prereq.${c}.what`)),
      ok ? h('p', { class: 'gr-follow-confirmed' }, opFollowLabel(`prereq.${c}.ok`))
        : [had ? h('p', { class: 'gr-muted' }, opFollowLabel('prereq.again')) : null, plan ? h('button', { type: 'submit' }, opFollowLabel(`prereq.${c}.confirm`)) : h('p', { class: 'gr-muted' }, opFollowLabel('prereq.needsPlan'))]);
    }), h('p', { class: 'gr-muted' }, opFollowLabel(st.allConfirmed ? 'prereq.localConfirmed' : 'prereq.local'))] : [];
    const histLine = (e) => (e.type === 'plan'
      ? `${e.action}${e.product ? ` · ${e.product}` : ''} · ${e.metric} ${opMeasure(e.baseline)} → ${opMeasure(e.target)} · ${e.reviewDate}`
      : e.type === 'review' && e.campaign ? opCampaignHistory(e)
      : e.type === 'prereq' ? `${opFollowLabel(`prereq.${e.code}.ok`)} · ${opFollowDate(e.planAt)}`
        : e.type === 'qualify' ? t('gr.inbox.hist.qualify', e.id, t(`gr.inbox.state.${e.state}`), e.postId) : e.type === 'attribute' ? t(e.on ? 'gr.inbox.hist.attach' : 'gr.inbox.hist.detach', e.id, e.postId)
        : e.type === 'applied' ? opFollowLabel('appliedOn.recorded', e.date, opFollowDate(e.planAt))
          : `${e.applied} · ${opFollowLabel(e.quality)} · ${e.metric}${e.observed == null ? '' : ' ' + opMeasure(e.observed)}${e.computed ? ` · ${t('gr.review.resultCalculated', opComputedLine(e.computed))} · ${t('gr.review.manualBaselineShort', opMeasure(e.baseline))}` : ''} · ${e.notes}`);
    const why = view.weekly ? [heading('wkWhy'), h('ul', null, opWeeklyReasons(view.weekly).map((l) => h('li', null, l)))] : [];
    const followDetails = h('details', { class: 'gv-follow gr-follow', ...(followOpen ? { open: '' } : {}), on: { toggle: (ev) => { followOpen = !!(ev.target && ev.target.open); } } },
      h('summary', null, opFollowLabel('title')),
      h('div', { class: 'gr-follow-body' },
        ...why,
        heading('application'), h('p', { class: 'gr-muted' }, opFollowLabel('state.legend')), ...appliedInfo, applyForm,
        ...prereqBlock,
        h('p', { class: 'gr-muted' }, opFollowLabel('local')),
        ...(events.length ? [heading('history'), h('ul', null, events.slice().reverse().map((e) => h('li', null, opFollowDate(e.at), ' · ', histLine(e))))] : [])));

    // ----- the closed line (title, short proof, ONE button) and the body the merchant opens (summary, target, detailed proof, exact dates, form, steps, follow-up) -----
    const pubStage = pub && pub.stage && pub.stage !== 'none' ? t(`gr.pub.stage.${pub.stage}`) : null;
    const stateText = (pubStage && !applied) ? pubStage : st.status === 'ready' ? null : opFollowLabel(camp && st.status === 'applied' ? 'state.sent' : `state.${st.status}`, applied ? applied.date : '');
    const proof = evidence.proof ?? [];
    const period = opPeriodText(evidence.measurement);
    const rankChip = view.rank != null ? h('span', { class: 'gv-rank' }, wk('rank', num(view.rank))) : null;
    const line = h('div', { class: 'ex-mover gr-row gv-line' },
      icoBubble(OP_ITEM_ICON[evidence.kind] ?? 'produits'),
      h('div', { class: 'ex-mover-main' },
        h('button', { type: 'button', class: 'gv-toggle', 'aria-expanded': String(bodyOpen), on: { click: () => { bodyOpen = !bodyOpen; render(read()); } } },
          h('span', { class: 'gv-chev', 'aria-hidden': 'true' }, '›'), rankChip, h('span', { class: 'ex-mover-name' }, evidence.title)),
        h('div', { class: 'ex-mover-sub gv-proofline' }, evidence.lineProof ?? evidence.summary ?? evidence.why,
          view.reviewMode && plan ? h('span', { class: 'gv-due' }, ` · ${plan.reviewDate ? t('gr.review.due', plan.reviewDate) : t('gr.review.none')}`) : null,
          view.reviewMode && evidence.target ? opTargetLink({ target: evidence.target }) : null,
          stateText ? h('span', { class: 'gv-state gr-follow-state' }, stateText) : h('span', { class: 'gr-follow-state', hidden: '' }, opFollowLabel('state.ready')))),
      primary ? h('div', { class: 'gv-line-action' }, h('button', { type: 'button', class: 'gv-primary', 'aria-expanded': primary.expanded == null ? null : String(!!primary.expanded), on: { click: primary.run } }, primary.label)) : null);
    const body = h('div', { class: 'gv-body', ...(bodyOpen ? {} : { hidden: '' }) },
      h('p', { class: 'gv-summary' }, evidence.summary ?? evidence.why),
      opTargetLine(evidence, plan),
      proof.length ? h('dl', { class: 'gv-proof' }, proof.map((p) => h('div', null, h('dt', null, p.label), h('dd', null, p.value, p.unit ? h('span', null, ` ${p.unit}`) : null)))) : null,
      period ? h('p', { class: 'gv-period' }, proof.some((p) => p.label === t('gr.fiche.proof.period')) ? period : `${t('gr.fiche.proof.period')} · ${period}`) : null, // the label is not repeated when a figure above already carries it
      plan && canSave ? h('p', null, h('button', { type: 'button', class: 'gv-link', on: { click: () => toggle('plan') } }, opFollowLabel('editPlan'))) : null,
      (code === 'socialTest' || (isInq && pub)) && !view.reviewMode ? opPublicationPanel(pub, plan, evidence) : null,
      isInq && !view.reviewMode ? opInboxPanel({ inbox: view.inbox, evidence, events, plan, applied: appliedForPlan ?? applied, save, rerender: () => render(read()) }) : null,
      isInq ? opPipelinePanel({ scope, testId: snapshot.id, live: pipeLive, applied: appliedForPlan ?? applied, evidence, rerender: () => render(read()), period: pipePeriod }) : null,
      ...(canSave ? [planPanel, resultPanel, followDetails] : [staticPanel]));
    root.replaceChildren(...[line, body, status, view.priorityId ? opAgentDraftAction(view.priorityId) : null].filter(Boolean)); // A5: a draft from this priority (the server checks it) // replaceChildren would write the word "null" for a null child
  }

  try { render(read()); } catch { status.append(opFollowLabel('storageError')); root.replaceChildren(status); }
  return root;
}

// ---------- The exact target, the steps and what is left to fill in. A link only when Growth can open the target (its own stable ids); never an external URL: Growth has none that is reliable. ----------
const OP_STEPS = { variant: 4, product: 4, restock: 4, segment: 4, storeWeekday: 4, adCheck: 4, siteForm: 4, socialTest: 4, inquiryTest: 4 };
function opTargetHref(tg) {
  if (!tg || !tg.available) return null;
  const q = (v) => encodeURIComponent(v);
  if (tg.type === 'product' && tg.id) return `#/potential?open=${q(tg.id)}${tg.variantId ? `&variant=${q(tg.variantId)}` : ''}`;
  if (tg.type === 'segment' && tg.id) return `#/audience?open=${q(tg.id)}`;
  return null;
}
const opTargetLabel = (tg) => (tg.type === 'segment' ? opFollowLabel('target.openSegment') : tg.variantId ? opFollowLabel('target.openVariant') : opFollowLabel('target.openProduct'));
function opTargetLink(i) {
  const tg = i.target; const href = opTargetHref(tg);
  return href ? h('a', { class: 'gr-op-link gr-op-target', href, 'data-target': tg.type }, opTargetLabel(tg)) : null;
}
/** One line under the summary: where the action points (a link when Growth can open it; the day and the place for a store action; the manual fallback when it cannot be opened). */
function opTargetLine(evidence, plan) {
  const tg = evidence.target ?? null;
  if (!tg) return null;
  if (tg.type === 'sitePage') return h('p', { class: 'gv-target' }, h('strong', null, opFollowLabel('target.title')), ' · ', tg.id, ' ', tg.url && /^https:\/\//.test(tg.url) ? h('a', { class: 'gr-op-link gr-op-target', href: tg.url, target: '_blank', rel: 'noopener noreferrer', 'data-target': 'sitePage' }, opFollowLabel('target.openPage')) : h('span', { class: 'gr-muted' }, opFollowLabel('target.unavailable')));
  const href = opTargetHref(tg);
  if (tg.type === 'storeWeekday') {
    const where = tg.location && tg.location.mode === 'single' ? tg.location.name : tg.location && tg.location.mode === 'several' ? opFollowLabel('target.locationSeveral', num(tg.location.count)) : opFollowLabel('target.locationUnknown');
    return h('p', { class: 'gv-target' }, h('strong', null, opFollowLabel('target.title')), ' · ', opDay(tg.day), ' · ', where, ' · ', plan && plan.product ? plan.product : opFollowLabel('target.productToChoose'));
  }
  return h('p', { class: 'gv-target' }, h('strong', null, opFollowLabel('target.title')), ' · ', tg.title ?? '', tg.variantId ? ` · ${opFollowLabel('target.variantShown')}` : '', ' ',
    href ? h('a', { class: 'gr-op-link gr-op-target', href, 'data-target': tg.type }, opTargetLabel(tg)) : h('span', { class: 'gr-muted' }, opFollowLabel('target.unavailable')));
}
/** The steps (in the order the merchant does them: plan first, then the action) and what is left to complete. */
function opTargetSteps(evidence, plan) {
  const tg = evidence.target ?? null; const code = evidence.code ?? null;
  if (!code) return [];
  const heading = (label) => h('strong', null, opFollowLabel(label));
  const out = [heading('steps.title'), h('ol', null, [...Array(OP_STEPS[code] ?? 0).keys()].map((n) => h('li', null, opFollowLabel(`steps.${code}.${n + 1}`))))];
  if (!opTargetHref(tg) || code === 'storeWeekday') out.push(heading('missing.title'), h('ul', null, [h('li', null, opFollowLabel(`missing.${code}`)), ...(code === 'storeWeekday' && !(tg && tg.location && tg.location.mode === 'single') ? [h('li', null, opFollowLabel('missing.location'))] : [])]));
  return out;
}

/** Applied actions whose review date has been reached and that still wait for their review (for the plan version that was applied): read from this browser's history, per merchant, whether or not the opportunity is still in the active list. */
function opDueReviews(scope) {
  if (!scope) return [];
  const out = []; const today = opToday(); const prefix = opHistoryPrefix(scope);
  for (let i = 0; i < growthStorage.length; i += 1) {
    const key = growthStorage.key(i); if (!key || !key.startsWith(prefix)) continue;
    let entry; try { entry = JSON.parse(growthStorage.getItem(key)); } catch { continue; }
    if (!entry || !entry.snapshot) continue;
    const st = opFollowState(entry.events ?? [], entry.snapshot.prerequisites ?? []);
    if (!st.plan || !st.applied || st.applied.planAt !== st.plan.at || st.review || !st.plan.reviewDate || st.plan.reviewDate > today) continue; // not applied, applied an older plan version, already reviewed, without a review date, or not yet due
    out.push({ snapshot: entry.snapshot, due: st.plan.reviewDate });
  }
  return out.sort((a, b) => (a.due < b.due ? -1 : a.due > b.due ? 1 : a.snapshot.id < b.snapshot.id ? -1 : 1));
}
function opReviewCard(d) {
  const due = opDueReviews(d.historyScope);
  if (!due.length) return null;
  const first = due[0];
  return h('details', { class: 'ex-card gr-pr-card gv-fold gv-watch gv-reviews' },
    h('summary', null, h('span', { class: 'gv-fold-title' }, t('gr.review.title', num(due.length))), h('span', { class: 'gv-fold-signal' }, `${first.snapshot.title} · ${t('gr.review.due', first.due)}`)),
    h('div', { class: 'ex-movers' }, due.map((x) => opFollowUp(d.historyScope, x.snapshot, { reviewMode: true, onChange: () => render() }))));
}
function opArchivedFollowUps(d) {
  if (!d.historyScope) return null;
  const activeIds = new Set([...d.sections.commercial, ...((d.ads && d.ads.items) || []), ...((d.site && d.site.items) || []), ...((d.social && d.social.items) || []), ...((d.inbox && d.inbox.items) || [])].map((item) => item.id));
  const dueIds = new Set(opDueReviews(d.historyScope).map((x) => x.snapshot.id));
  const prefix = opHistoryPrefix(d.historyScope);
  const rows = [];
  try {
    for (let index = 0; index < growthStorage.length; index += 1) {
      const key = growthStorage.key(index);
      if (!key?.startsWith(prefix)) continue;
      const { snapshot } = JSON.parse(growthStorage.getItem(key));
      if (activeIds.has(snapshot.id) || dueIds.has(snapshot.id)) continue; // the reviews to do are listed once, under "À revoir"
      rows.push(h('div', { class: 'gr-follow-archived' }, h('strong', null, snapshot.title), opFollowUp(d.historyScope, snapshot)));
    }
  } catch {
    return h('p', { role: 'status' }, opFollowLabel('storageError'));
  }
  return rows.length ? h('section', { class: 'ex-card gr-pr-card' }, h('h2', null, opFollowLabel('archived')), rows) : null;
}
