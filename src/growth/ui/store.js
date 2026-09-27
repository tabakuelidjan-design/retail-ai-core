'use strict';
// Nordla Growth - Croissance magasin page. Loaded BEFORE app.js (same pattern as the other Growth pages): nothing runs at load
// time; the functions below use app.js helpers (h, t, money, num, chip, cardHead, gi, kpi, arrow, icoBubble, dayFmt, tag,
// render, PAGES) only when app.js renders the page. Every figure comes from the payload (/api/growth/store, the merchant's
// synced sales, src/growth/store/store.js). SALES ONLY: no visitor, conversion or footfall figure exists anywhere on this page.

let stMetric = 'sales';

const stPct = (v) => `${Math.round(v * 100)} %`;
const stNA = (text) => h('span', { class: 'gr-pp-na' }, text);
const stDay = (d) => { const s = new Date(Date.UTC(2024, 0, 1 + d)).toLocaleDateString(tag(), { weekday: 'long', timeZone: 'UTC' }); return s.charAt(0).toUpperCase() + s.slice(1); };
const stDayIn = (d) => new Date(Date.UTC(2024, 0, 1 + d)).toLocaleDateString(tag(), { weekday: 'long', timeZone: 'UTC' }); // in a sentence: the language's own casing
const stDayShort = (d) => new Date(Date.UTC(2024, 0, 1 + d)).toLocaleDateString(tag(), { weekday: 'short', timeZone: 'UTC' }).replace('.', '');

/** KPI comparison: a real previous value -> Analytics' delta; none -> an explicit note, never a fake 0. */
function stDelta(value, previous, kind) {
  if (value == null) return h('div', { class: 'ex-kpi-note' }, t('gr.st.kpi.notComputable'));
  if (previous == null) return h('div', { class: 'ex-kpi-note' }, t('gr.st.kpi.noPrevious'));
  if (kind === 'share') {
    const pts = Math.round((value - previous) * 1000) / 10; const up = pts >= 0;
    return h('div', { class: `ex-delta ${pts === 0 ? '' : up ? 'up' : 'down'}` }, pts === 0 ? null : arrow(up ? 'up' : 'down'), h('strong', null, t('gr.au.pts', `${up ? '+' : '−'}${new Intl.NumberFormat(tag(), { maximumFractionDigits: 1 }).format(Math.abs(pts))}`)), h('span', null, t('gr.st.vsPrevious')));
  }
  if (previous === 0) return h('div', { class: 'ex-kpi-note' }, t('gr.st.kpi.fromZero'));
  const pct = (value - previous) / previous;
  if (pct === 0) return h('div', { class: 'ex-delta' }, h('strong', null, '0 %'), h('span', null, t('gr.st.vsPrevious')));
  return h('div', { class: `ex-delta ${pct > 0 ? 'up' : 'down'}` }, arrow(pct > 0 ? 'up' : 'down'), h('strong', null, signedPct(pct)), h('span', null, t('gr.st.vsPrevious')));
}

function stKpiRow(d) {
  const k = d.kpis;
  const locNote = k.locations.unknownLocationOrders ? t('gr.st.kpi.locationsUnknown', num(k.locations.unknownLocationOrders)) : t('gr.st.kpi.locationsNote', num(k.locations.total));
  return h('div', { class: 'ex-kpi-row gr-kpi-row gr-ct-kpis' },
    kpi('chiffreAffaires', t('gr.st.kpi.storeNet'), money(k.storeNet.value), stDelta(k.storeNet.value, k.storeNet.previous)),
    kpi('commandes', t('gr.st.kpi.storeOrders'), num(k.storeOrders.value), stDelta(k.storeOrders.value, k.storeOrders.previous)),
    kpi('panierMoyen', t('gr.st.kpi.storeAov'), k.storeAov.value == null ? t('gr.dash') : money(k.storeAov.value), stDelta(k.storeAov.value, k.storeAov.previous)),
    kpi('pack:local', t('gr.st.kpi.storeShare'), k.storeShare.value == null ? t('gr.dash') : stPct(k.storeShare.value), stDelta(k.storeShare.value, k.storeShare.previous, 'share')),
    kpi('storeGrowth', t('gr.st.kpi.locations'), num(k.locations.value), h('div', { class: 'ex-kpi-note' }, locNote)));
}

// ---------- Performance magasin: weekly bars (current vs previous 8 weeks) or store vs online lines ----------
function stPerfCard(d) {
  const labels = d.weekly.map((w) => dayFmt(w.start));
  const options = ['sales', 'orders', ...(d.online.orders > 0 ? ['channels'] : [])];
  if (!options.includes(stMetric)) stMetric = 'sales';
  const sel = h('select', { class: 'ex-select', 'aria-label': t('gr.st.perf.metric'), on: { change: (e) => { stMetric = e.target.value; render(); } } },
    options.map((v) => h('option', { value: v, ...(v === stMetric ? { selected: 'selected' } : {}) }, t(`gr.st.perf.${v}`))));
  let chart;
  if (stMetric === 'channels') {
    chart = NordlaCharts.trendLines([{ name: t('gr.st.perf.store'), cls: 'c1', values: d.weekly.map((w) => w.storeNet) }, { name: t('gr.st.perf.online'), cls: 'c2', values: d.weekly.map((w) => w.onlineNet) }], labels, { format: compactMoney, height: 230, label: t('gr.st.perf.channels') });
  } else {
    const key = stMetric === 'orders' ? ['storeOrders', 'prevStoreOrders'] : ['storeNet', 'prevStoreNet'];
    const fmt = stMetric === 'orders' ? (v) => num(Math.round(v)) : compactMoney;
    const groups = d.weekly.map((w, i) => ({ label: labels[i], a: w[key[1]] ?? 0, b: w[key[0]] }));
    chart = d.window.previousComparable
      ? NordlaCharts.comparison(groups, [{ name: t('gr.st.perf.previous'), cls: 'prev' }, { name: t('gr.st.perf.current'), cls: 'cur' }], { format: fmt, height: 230, label: t(`gr.st.perf.${stMetric}`) })
      : NordlaCharts.trendLine(d.weekly.map((w, i) => ({ label: labels[i], value: w[key[0]] })), { format: fmt, height: 230, label: t(`gr.st.perf.${stMetric}`) });
  }
  return h('div', { class: 'ex-card gr-st-perf' }, cardHead('croissance', t('gr.st.perf.title'), sel), chart,
    h('div', { class: 'ex-foot' }, t(d.window.previousComparable ? 'gr.st.perf.foot' : 'gr.st.perf.footNoPrev', d.window.weeks)));
}

// ---------- Activité des ventes par jour (sales, never footfall; hours are not used) ----------
function stWeekdayCard(d) {
  const max = Math.max(...d.weekdays.map((w) => w.net), 1);
  const top = [...d.weekdays].sort((a, b) => b.net - a.net || a.day - b.day)[0];
  return h('div', { class: 'ex-card gr-st-days' }, cardHead('calendrier', t('gr.st.days.title')),
    d.store.orders ? h('div', { class: 'ex-conc' }, d.weekdays.map((w) => h('div', { class: 'ex-conc-row wide gr-st-dayrow' },
      h('span', null, stDay(w.day)),
      h('div', { class: 'ex-bar' }, h('i', { class: w.day === top.day && w.net > 0 ? 'first' : '', style: `width:${w.net > 0 ? Math.max(4, Math.round((w.net / max) * 100)) : 0}%` })),
      h('span', { class: 'gr-status-val' }, h('strong', null, money(w.net)), h('span', { class: 'gr-muted' }, t('gr.st.days.orders', num(w.orders)))))))
      : h('div', { class: 'gr-pp-empty' }, t('gr.st.empty.window', d.window.weeks)),
    h('div', { class: 'ex-foot' }, t('gr.st.days.foot', num(d.store.orders), d.thresholds.minOrders)));
}

// ---------- Produits moteurs en magasin (max 5), with Produits Potentiels' guard ----------
function stThumb(p) {
  if (!p.imageUrl) return h('span', { class: 'gr-pp-thumb sm' }, NordlaIcon.semantic('produits', 'sm'));
  const img = h('img', { class: 'gr-pp-thumb sm', src: p.imageUrl, alt: '', loading: 'lazy', referrerpolicy: 'no-referrer' });
  img.addEventListener('error', () => img.replaceWith(h('span', { class: 'gr-pp-thumb sm' }, NordlaIcon.semantic('produits', 'sm'))));
  return img;
}
function stProductsCard(d) {
  return h('div', { class: 'ex-card gr-st-products' }, cardHead('meilleurProduit', t('gr.st.products.title')),
    d.topProducts.length ? h('div', { class: 'gr-pp-items' }, d.topProducts.map((p) => h('div', { class: 'gr-pp-item gr-st-item' },
      stThumb(p),
      h('span', { class: 'gr-pp-item-main' }, h('span', { class: 'gr-pp-name' }, p.title ?? t('gr.st.products.unknown')),
        h('span', { class: 'gr-pp-sub' }, t('gr.st.products.detail', t(p.units === 1 ? 'gr.pp.u1' : 'gr.pp.uN', num(p.units)), p.share == null ? t('gr.dash') : stPct(p.share))),
        p.potentialStatus && !p.highlightAllowed ? h('span', { class: 'gr-st-guard' }, chip(t('gr.st.products.guard', t(`gr.pp.status.${p.potentialStatus}`)), 'mute')) : null),
      h('span', { class: 'gr-pp-item-side' }, h('strong', { class: 'gr-ink' }, money(p.net)),
        p.change == null ? h('span', { class: 'gr-muted' }, t('gr.dash')) : h('span', { class: `gr-pp-evo ${p.change > 0 ? 'up' : p.change < 0 ? 'down' : 'none'}` }, signedPct(p.change))))))
      : h('div', { class: 'gr-pp-empty' }, t('gr.st.empty.window', d.window.weeks)),
    h('div', { class: 'ex-foot' }, t('gr.st.products.foot')));
}

// ---------- Différences magasin / online (facts only, 30+ orders on both sides) ----------
function stDiffCard(d) {
  const x = d.differences;
  return h('div', { class: 'ex-card gr-st-diff' }, cardHead('ventes', t('gr.st.diff.title')),
    x ? h('div', null,
      h('p', { class: 'gr-pp-why' }, t('gr.st.diff.aov', money(x.storeAov), money(x.onlineAov))),
      x.products.length ? h('div', { class: 'ex-movers' }, x.products.map((g) => h('div', { class: 'ex-mover gr-row' },
        h('div', { class: 'ex-mover-main' }, h('div', { class: 'ex-mover-name' }, g.title ?? t('gr.st.products.unknown')), h('div', { class: 'ex-mover-sub' }, t('gr.st.diff.product', stPct(g.storeShare), stPct(g.onlineShare)))))))
        : h('div', { class: 'gr-pp-empty' }, t('gr.st.diff.none')))
      : h('div', { class: 'gr-pp-empty' }, t('gr.st.diff.gated', d.thresholds.minOrders, num(d.store.orders), num(d.online.orders))),
    h('div', { class: 'ex-foot' }, t('gr.st.diff.foot')));
}

// ---------- Tous les magasins (per-location breakdown; never a silent pick of one location) ----------
function stLocationsCard(d) {
  return h('div', { class: 'ex-card gr-st-locations' }, cardHead('storeGrowth', t('gr.st.loc.title', num(d.locations.length))),
    d.locations.length ? h('div', { class: 'ex-table-wrap' }, h('table', { class: 'ex-table gr-table gr-st-loctable' },
      h('thead', null, h('tr', null, h('th', null, t('gr.st.loc.store')), h('th', { class: 'num' }, t('gr.st.loc.orders')), h('th', { class: 'num' }, t('gr.st.loc.net')), h('th', { class: 'num' }, t('gr.st.loc.share')))),
      h('tbody', null, d.locations.map((l) => h('tr', null,
        h('td', null, l.known ? (l.name ?? t('gr.st.loc.unnamed')) : stNA(t('gr.st.loc.unknown'))),
        h('td', { class: 'num' }, num(l.orders)), h('td', { class: 'num' }, h('strong', null, money(l.net))),
        h('td', { class: 'num' }, l.share == null ? t('gr.dash') : stPct(l.share)))))))
      : h('div', { class: 'gr-pp-empty' }, t('gr.st.empty.window', d.window.weeks)),
    h('div', { class: 'ex-foot' }, t('gr.st.loc.foot')));
}

// ---------- Signaux magasin: fact -> comparison -> why it matters ----------
const ST_SIG_ICON = { storeVsOnline: 'croissance', ordersUpAovDown: 'panierMoyen', ordersDownAovUp: 'panierMoyen', strongWeekday: 'calendrier', productGap: 'meilleurProduit', refundsUp: 'afterSales' };
function stSignalText(s, d) {
  switch (s.code) {
    case 'storeVsOnline': return [t(s.store > s.online ? 'gr.st.sig.storeFaster.title' : 'gr.st.sig.onlineFaster.title'), t('gr.st.sig.storeVsOnline.text', signedPct(s.store), signedPct(s.online), d.window.weeks)];
    case 'ordersUpAovDown': return [t('gr.st.sig.ordersUpAovDown.title'), t('gr.st.sig.ordersAov.text', signedPct(s.orders), signedPct(s.aov))];
    case 'ordersDownAovUp': return [t('gr.st.sig.ordersDownAovUp.title'), t('gr.st.sig.ordersAov.text', signedPct(s.orders), signedPct(s.aov))];
    case 'strongWeekday': return [t('gr.st.sig.strongWeekday.title', stDayIn(s.day), stPct(s.share)), t('gr.st.sig.strongWeekday.text', stPct(s.even))];
    case 'productGap': return [t('gr.st.sig.productGap.title', s.title ?? t('gr.st.products.unknown')), t('gr.st.sig.productGap.text', stPct(s.storeShare), stPct(s.onlineShare))];
    default: return [t('gr.st.sig.refundsUp.title'), t('gr.st.sig.refundsUp.text', stPct(s.value), stPct(s.previous))];
  }
}
function stSignalsCard(d) {
  return h('div', { class: 'ex-card gr-st-signals' }, cardHead('pack:storeGrowth', t('gr.st.sig.title')),
    d.signals.length ? h('div', { class: 'ex-movers' }, d.signals.map((s) => { const [ti, tx] = stSignalText(s, d); return h('div', { class: 'ex-mover gr-row' }, icoBubble(ST_SIG_ICON[s.code]), h('div', { class: 'ex-mover-main' }, h('div', { class: 'ex-mover-name' }, ti), h('div', { class: 'ex-mover-sub gr-wrap' }, tx))); }))
      : h('div', { class: 'gr-pp-empty' }, t('gr.st.sig.none', d.thresholds.minOrders, num(d.store.orders))),
    h('div', { class: 'ex-foot' }, t('gr.st.sig.foot')));
}

// ---------- Actions locales recommandées (from the facts above; never from traffic) ----------
const ST_ACT_ICON = { restockFirst: 'stock', highlightProduct: 'meilleurProduit', weekdayHighlight: 'calendrier', checkAov: 'panierMoyen' };
function stActionText(a) {
  switch (a.code) {
    case 'restockFirst': return [t('gr.st.act.restockFirst.title'), t('gr.st.act.restockFirst.text', a.title ?? t('gr.st.products.unknown'))];
    case 'highlightProduct': return [t('gr.st.act.highlightProduct.title'), t('gr.st.act.highlightProduct.text', a.title ?? t('gr.st.products.unknown'), stPct(a.share))];
    case 'weekdayHighlight': return [t('gr.st.act.weekdayHighlight.title', stDayIn(a.day)), t('gr.st.act.weekdayHighlight.text', stPct(a.share))];
    default: return [t('gr.st.act.checkAov.title'), t('gr.st.act.checkAov.text')];
  }
}
function stActionsCard(d) {
  return h('div', { class: 'ex-card gr-st-actions' }, cardHead(null, t('gr.st.act.title', d.actions.length)),
    d.actions.length ? h('div', { class: 'gr-pp-items' }, d.actions.map((a) => { const [ti, tx] = stActionText(a); return h('div', { class: 'gr-pp-item gr-au-item gr-au-static' }, icoBubble(ST_ACT_ICON[a.code]), h('span', { class: 'gr-pp-item-main' }, h('span', { class: 'gr-pp-name' }, ti), h('span', { class: 'gr-pp-sub' }, tx)), h('span', { class: 'gr-pp-item-side' }, chip(t('gr.au.act.toTest'), 'gr-info'))); }))
      : h('div', { class: 'gr-pp-empty' }, t('gr.st.act.none', d.thresholds.minOrders)),
    h('div', { class: 'ex-foot' }, t('gr.st.act.foot')));
}

// ---------- Pour aller plus loin: what Nordla does not know yet (nothing is connected, nothing simulated) ----------
function stFutureCard(d) {
  const aud = d.audience ?? { identifiable: false, identifiedShare: null };
  return h('div', { class: 'ex-card gr-st-future' }, cardHead('dataHealth', t('gr.st.future.title')),
    h('div', { class: 'gr-pp-items' },
      (d.futureSources ?? []).map((s) => h('div', { class: 'gr-pp-item gr-au-static gr-st-src' },
        h('span', { class: 'gr-pp-item-main' }, h('span', { class: 'gr-pp-name' }, t(`gr.st.future.${s.code}`)),
          h('span', { class: 'gr-pp-sub' }, t('gr.st.future.unlocks', s.unlocks.map((u) => t(`gr.st.future.u.${u}`)).join(', ')))),
        h('span', { class: 'gr-pp-item-side' }, chip(t('gr.st.future.notConnected'), 'mute')))),
      h('div', { class: 'gr-pp-item gr-au-static gr-st-src' },
        h('span', { class: 'gr-pp-item-main' }, h('span', { class: 'gr-pp-name' }, t('gr.st.future.audience')),
          h('span', { class: 'gr-pp-sub' }, aud.identifiable ? t('gr.st.future.audienceShare', stPct(aud.identifiedShare)) : t('gr.st.future.audienceNone'))),
        h('span', { class: 'gr-pp-item-side' }, chip(t(aud.identifiable ? 'gr.st.future.partial' : 'gr.st.future.notIdentifiable'), 'mute')))),
    h('div', { class: 'ex-foot' }, t('gr.st.future.foot')));
}

function renderStore(main, safe) {
  const d = PAGES.storeGrowth.get();
  if (d.mode === 'noStore') {
    main.appendChild(h('div', { class: 'ex-card gr-st-empty' }, h('div', { class: 'gr-pp-empty' }, h('strong', { class: 'gr-ink' }, t('gr.st.empty.noStoreTitle')), h('p', null, t('gr.st.empty.noStoreText')))));
    main.appendChild(h('div', { class: 'ex-grid-2 even gr-st-row' }, safe(stFutureCard)));
    return;
  }
  // Footfall is not connected: stated up front, so no sales figure is read as traffic.
  main.appendChild(h('div', { class: 'gr-au-banner gr-st-banner', role: 'note' }, gi('dataHealth', 'md'), h('span', null, t('gr.st.banner.footfall'))));
  main.appendChild(safe(stKpiRow));
  main.appendChild(h('div', { class: 'gr-grid-pipe gr-grid-st' }, h('div', { class: 'gr-stack' }, safe(stPerfCard), safe(stWeekdayCard)), h('div', { class: 'gr-stack' }, safe(stSignalsCard), safe(stActionsCard))));
  main.appendChild(h('div', { class: 'gr-grid gr-grid-wide gr-st-row' }, safe(stProductsCard), safe(stDiffCard), safe(stLocationsCard)));
  main.appendChild(h('div', { class: 'gr-st-row' }, safe(stFutureCard)));
}
