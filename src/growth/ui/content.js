'use strict';
// Nordla Growth - Contenu page. Loaded BEFORE app.js (same pattern as potential.js / audience.js): nothing runs at load time;
// the functions below use app.js helpers (h, t, money, num, chip, cardHead, gi, kpi, render, PAGES) only when app.js renders
// the page. Every product, problem, status and filter comes from the payload (/api/growth/content = the merchant's synced
// catalog, src/growth/content/content.js); the UI only words and lays them out. No editor, no publication, no AI generation.
// List + detail panel reuse Produits Potentiels' components (.gr-pp-*).

const CT_TONE = { priority: 'gr-bad', improve: 'gr-warn', insufficient: 'gr-info', correct: 'mute' };
const CT_PROBLEM_TONE = { noImage: 'gr-bad' };
const CT_DONUT_CLS = { priority: 'c2', improve: 'c1', insufficient: 'c4', correct: 'c5' };
let ctState = { q: '', status: 'all', problem: 'all', cat: 'all', sel: null };

const ctNorm = (s) => String(s || '').toLocaleLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
const ctStatus = (s) => chip(t(`gr.ct.status.${s}`), CT_TONE[s]);
const ctProblem = (code) => chip(t(`gr.ct.problem.${code}`), CT_PROBLEM_TONE[code] || 'gr-warn');
const ctKpiValue = (v) => (v == null ? t('gr.dash') : num(v));

function ctThumb(r, size) {
  const cls = `gr-pp-thumb${size ? ` ${size}` : ''}`;
  if (!r.imageUrl) return h('span', { class: cls, title: t('gr.pp.noImage') }, NordlaIcon.semantic('produits', 'sm'));
  const img = h('img', { class: cls, src: r.imageUrl, alt: '', loading: 'lazy', referrerpolicy: 'no-referrer' });
  img.addEventListener('error', () => img.replaceWith(h('span', { class: cls }, NordlaIcon.semantic('produits', 'sm'))));
  return img;
}

// ---------- KPI row: the checks that really run; an unverifiable one shows "—" and says why (never 0) ----------
// No icon on the four check tiles: the dedicated content icons are not in the Growth pack yet (never substituted).
function ctKpiRow(d) {
  const k = d.kpis;
  const note = (v, key) => h('div', { class: 'ex-kpi-note' }, v == null ? t('gr.ct.kpi.unavailable') : t(key));
  return h('div', { class: 'ex-kpi-row gr-kpi-row gr-ct-kpis' },
    kpi('needsAttention', t('gr.ct.kpi.toImprove'), num(k.toImprove), h('div', { class: 'ex-kpi-note' }, t('gr.ct.kpi.toImproveNote', num(d.scope.analysed)))),
    kpi(null, t('gr.ct.kpi.noImage'), ctKpiValue(k.noImage), note(k.noImage, 'gr.ct.kpi.noImageNote')),
    kpi(null, t('gr.ct.kpi.noAltText'), ctKpiValue(k.noAltText), note(k.noAltText, 'gr.ct.kpi.noAltTextNote')),
    kpi(null, t('gr.ct.kpi.noType'), ctKpiValue(k.noType), note(k.noType, 'gr.ct.kpi.noTypeNote')),
    kpi(null, t('gr.ct.kpi.missingSku'), ctKpiValue(k.missingSku), note(k.missingSku, 'gr.ct.kpi.missingSkuNote')));
}

// ---------- Produits par priorité (Analytics' donut) + principaux problèmes (Explorer bars) ----------
function ctPriorityCard(d) {
  const parts = d.byStatus.filter((s) => s.count > 0);
  const total = parts.reduce((a, s) => a + s.count, 0);
  const pcts = opPctRound(parts.map((s) => s.count));
  return h('div', { class: 'ex-card gr-op-sources ex-cats gr-ct-prio' }, cardHead('pipelineStatus', t('gr.ct.prio.title')),
    total ? NordlaCharts.donut(parts.map((s, i) => ({ name: t(`gr.ct.status.${s.status}`), pct: pcts[i], value: num(s.count), cls: CT_DONUT_CLS[s.status] })), { totalValue: num(total), totalLabel: t('gr.ct.prio.total'), size: 150 })
      : h('div', { class: 'gr-pp-empty' }, t('gr.ct.empty.noProducts')),
    h('div', { class: 'ex-foot' }, t('gr.ct.prio.foot', num(d.scope.analysed))));
}
function ctProblemsCard(d) {
  const max = Math.max(...d.problems.map((p) => p.count), 1);
  const off = [...d.checks.filter((c) => !c.available).map((c) => t(`gr.ct.problem.${c.code}`)), ...d.notAvailable.map((x) => t(`gr.ct.na.${x}`))];
  return h('div', { class: 'ex-card gr-ct-problems' }, cardHead('needsAttention', t('gr.ct.problems.title')),
    d.problems.length
      ? h('div', { class: 'ex-conc' }, d.problems.map((p, i) => h('div', { class: 'ex-conc-row wide gr-ct-prow' },
        h('span', null, t(`gr.ct.problem.${p.code}`)),
        h('div', { class: 'ex-bar' }, h('i', { class: i === 0 ? 'first' : '', style: `width:${Math.max(4, Math.round((p.count / max) * 100))}%` })),
        h('strong', null, num(p.count)))))
      : h('div', { class: 'gr-pp-empty' }, t('gr.ct.problems.none')),
    h('div', { class: 'ex-foot' }, t('gr.ct.problems.notChecked', off.join(', '))));
}

// ---------- product list: search + status / problem / category, rows (cards below 1024px) ----------
function ctRows(d) {
  const q = ctNorm(ctState.q);
  return d.rows.filter((r) => (ctState.status === 'all' || r.status === ctState.status)
    && (ctState.problem === 'all' || r.problems.includes(ctState.problem))
    && (ctState.cat === 'all' || (ctState.cat === '' ? r.category == null : r.category === ctState.cat))
    && (!q || ctNorm(`${r.title} ${r.skus.join(' ')} ${r.category || ''}`).includes(q)));
}
function ctSearch() {
  const input = h('input', { class: 'gr-pp-search-input', type: 'search', placeholder: t('gr.ct.search'), 'aria-label': t('gr.ct.search'), value: ctState.q, autocomplete: 'off' });
  input.addEventListener('input', (e) => {
    ctState.q = e.target.value; const pos = e.target.selectionStart; render();
    const again = document.querySelector('.gr-pp-search-input');
    if (again && again.focus) { again.focus(); try { again.setSelectionRange(pos, pos); } catch (err) { /* type=search may refuse */ } }
  });
  return h('label', { class: 'gr-pp-search' }, NordlaIcon.semantic('recherche', 'sm'), input);
}
function ctSelect(label, value, options, onChange) {
  return h('select', { class: 'ex-select', 'aria-label': label, on: { change: (e) => onChange(e.target.value) } },
    options.map(([v, text]) => h('option', { value: v, ...(v === value ? { selected: 'selected' } : {}) }, text)));
}
function ctToolbar(d) {
  const f = d.filters;
  return h('div', { class: 'gr-ct-toolbar' }, ctSearch(),
    h('div', { class: 'gr-ct-selects' },
      ctSelect(t('gr.ct.f.status'), ctState.status, [['all', t('gr.ct.f.allStatuses')], ...f.statuses.map((s) => [s, `${t(`gr.ct.status.${s}`)} (${num(d.byStatus.find((x) => x.status === s).count)})`])], (v) => { ctState.status = v; render(); }),
      ctSelect(t('gr.ct.f.problem'), ctState.problem, [['all', t('gr.ct.f.allProblems')], ...f.problems.map((p) => [p, `${t(`gr.ct.problem.${p}`)} (${num(d.problems.find((x) => x.code === p)?.count ?? 0)})`])], (v) => { ctState.problem = v; render(); }),
      ctSelect(t('gr.ct.f.category'), ctState.cat, [['all', t('gr.ct.f.allCategories')], ...f.categories.map((c) => [c, c]), ...(f.uncategorised ? [['', t('gr.pp.noCategory')]] : [])], (v) => { ctState.cat = v; render(); })));
}
// Detail panel: focus handled by the shell (dialogOpened / dialogClosed + data-focus-id on every trigger).
function ctOpen(id, trigger) { dialogOpened(trigger); ctState.sel = id; render(); }
function ctClose() { ctState.sel = null; dialogClosed(); render(); }
function ctRow(r, weeks) {
  const cell = (cls, k, ...c) => h('div', { class: `gr-pp-c ${cls}`, ...(k ? { 'data-k': k } : {}) }, ...c);
  return h('button', { type: 'button', class: `gr-pp-row gr-ct-row${ctState.sel === r.id ? ' sel' : ''}`, 'aria-label': t('gr.pp.openDetail', r.title), 'data-focus-id': `ct-row:${r.id}`, on: { click: (e) => ctOpen(r.id, e && e.currentTarget) } },
    cell('gr-pp-c-name', null, ctThumb(r), h('span', { class: 'gr-pp-name-wrap' }, h('span', { class: 'gr-pp-name' }, r.title), h('span', { class: 'gr-pp-sub' }, r.skus.length ? r.skus.join(' · ') : t('gr.ct.noSku')))),
    cell('gr-pp-c-cat gr-ct-cat', t('gr.ct.col.category'), r.category ? h('span', null, r.category) : h('span', { class: 'gr-pp-na' }, t('gr.pp.noCategory'))),
    cell('gr-ct-c-problems', null, r.problems.length ? r.problems.map(ctProblem) : h('span', { class: 'gr-pp-na' }, t(r.status === 'insufficient' ? 'gr.ct.noProblemYet' : 'gr.ct.noProblem'))),
    cell('gr-ct-c-status', null, ctStatus(r.status)),
    cell('gr-pp-c-num', t('gr.ct.col.sales', weeks), h('strong', null, num(r.units))),
    cell('gr-ct-c-act', null, h('span', { class: 'btn-outline gr-ct-act', 'aria-hidden': 'true' }, t(r.problems.length ? 'gr.ct.seeReco' : 'gr.ct.seeDetail'))),
    cell('gr-pp-c-more', null, h('span', { class: 'gr-pp-dots gr-ct-chev', 'aria-hidden': 'true' }, '›')));
}
function ctListCard(d) {
  const head = cardHead('produits', t('gr.ct.list.title'));
  if (!d.rows.length) return h('div', { class: 'ex-card gr-ct-list' }, head, h('div', { class: 'gr-pp-empty' }, t('gr.ct.empty.noProducts')));
  const rows = ctRows(d);
  const cols = ['product', 'category', 'problems', 'status', 'sales', 'action'];
  return h('div', { class: 'ex-card gr-ct-list' }, head, ctToolbar(d),
    h('div', { class: 'gr-pp-table', role: 'list' },
      h('div', { class: 'gr-pp-thead gr-ct-thead', 'aria-hidden': 'true' }, cols.map((c) => h('span', { class: c === 'sales' ? 'num' : null }, t(`gr.ct.col.${c}`, d.window.weeks))), h('span', null)),
      rows.length ? rows.map((r) => ctRow(r, d.window.weeks)) : h('div', { class: 'gr-pp-empty' }, t('gr.pp.noMatch'))),
    h('div', { class: 'ex-foot' }, t('gr.ct.list.foot', num(rows.length), num(d.rows.length), num(d.scope.catalog))));
}

// ---------- empty / insufficient states (never "all good": Nordla may just lack the data to check) ----------
function ctAllClear(d) {
  const insufficient = d.byStatus.find((s) => s.status === 'insufficient').count;
  if (d.kpis.toImprove > 0 || !d.rows.length) return null;
  return h('div', { class: 'ex-card gr-ct-clear' }, h('div', { class: 'gr-pp-empty' },
    h('strong', { class: 'gr-ink' }, t(insufficient ? 'gr.ct.empty.insufficientTitle' : 'gr.ct.empty.clearTitle')),
    h('p', null, t(insufficient ? 'gr.ct.empty.insufficientText' : 'gr.ct.empty.clearText'))));
}

// ---------- detail panel ----------
function ctDrawer(d) {
  const r = d.rows.find((x) => x.id === ctState.sel);
  if (!r) return null;
  const close = () => ctClose();
  const fact = (code) => ({
    noImage: t('gr.ct.fact.noImage'), noAltText: t('gr.ct.fact.noAltText'), noType: t('gr.ct.fact.noType'), noCollection: t('gr.ct.fact.noCollection'),
    missingSku: t('gr.ct.fact.missingSku', num(r.facts.variantsWithoutSku), num(r.facts.variants)), duplicateTitle: t('gr.ct.fact.duplicateTitle', num(r.facts.sameTitle)),
  })[code];
  const unverified = [...r.unverified.map((c) => t(`gr.ct.problem.${c}`)), ...d.notAvailable.map((x) => t(`gr.ct.na.${x}`))];
  return h('div', { class: 'gr-pp-drawer-wrap' },
    h('div', { class: 'gr-pp-backdrop', on: { click: close } }),
    h('aside', { class: 'gr-pp-drawer', role: 'dialog', 'aria-modal': 'true', 'aria-label': r.title },
      h('div', { class: 'gr-pp-drawer-head' }, ctThumb(r, 'lg'),
        h('div', { class: 'gr-pp-drawer-id' }, h('h2', null, r.title),
          h('div', { class: 'gr-pp-drawer-meta' }, ctStatus(r.status), h('span', { class: 'gr-pp-sub' }, [r.skus[0], r.category || t('gr.pp.noCategory')].filter(Boolean).join(' · ')))),
        h('button', { type: 'button', class: 'gr-pp-close', 'aria-label': t('gr.pp.close'), on: { click: close } }, '×')),
      h('div', { class: 'gr-pp-drawer-body' },
        h('section', { class: 'gr-pp-sec' }, h('h3', null, t('gr.ct.d.problems')),
          r.problems.length
            ? h('div', { class: 'gr-ct-issues' }, r.problems.map((code) => h('div', { class: `gr-ct-issue${code === 'noImage' ? ' major' : ''}` },
              h('strong', null, t(`gr.ct.problem.${code}`)), h('span', null, t(`gr.ct.explain.${code}`)), h('span', { class: 'gr-pp-sub' }, fact(code)))))
            : h('p', { class: 'gr-pp-why' }, t(r.status === 'insufficient' ? 'gr.ct.d.noneInsufficient' : 'gr.ct.d.none'))),
        h('section', { class: 'gr-pp-sec' }, h('h3', null, t('gr.ct.d.why')),
          h('p', { class: 'gr-pp-why' }, t(`gr.ct.rule.${r.rule}`, d.thresholds.manyProblems)),
          h('p', { class: 'gr-pp-action-text' }, r.units > 0 ? t('gr.ct.d.sold', num(r.units), d.window.weeks) : t('gr.ct.d.notSold', d.window.weeks))),
        r.problems.length ? h('section', { class: 'gr-pp-sec' }, h('h3', null, t('gr.ct.d.reco')),
          h('ol', { class: 'gr-ct-reco' }, r.problems.map((code) => h('li', null, h('strong', null, t(`gr.ct.reco.${code}`)), h('span', { class: 'gr-pp-sub' }, t(`gr.ct.recoHow.${code}`)))))) : null,
        h('section', { class: 'gr-pp-sec' }, h('h3', null, t('gr.ct.d.unverified')), h('p', { class: 'gr-pp-action-text' }, unverified.join(', '))),
        h('section', { class: 'gr-pp-sec' },
          h('p', { class: 'gr-pp-action-text' }, t('gr.ct.d.method'))))));
}
if (typeof document !== 'undefined' && document.addEventListener) {
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && ctState.sel && currentPage() === 'content') ctClose(); });
}
if (typeof window !== 'undefined' && window.addEventListener) {
  window.addEventListener('hashchange', () => { ctState.sel = null; if (document.body && document.body.classList) document.body.classList.remove('gr-pp-lock'); });
}

function renderContent(main, safe) {
  const d = PAGES.content.get();
  if (ctState.sel && !d.rows.some((r) => r.id === ctState.sel)) ctState.sel = null;
  if (!d.capabilities.image) main.appendChild(h('div', { class: 'gr-au-banner', role: 'note' }, gi('dataHealth', 'md'), h('span', null, t('gr.ct.banner.noImage'))));
  main.appendChild(safe(ctKpiRow));
  main.appendChild(h('div', { class: 'ex-grid-2 even gr-ct-top' }, safe(ctPriorityCard), safe(ctProblemsCard)));
  const clear = safe(ctAllClear);
  if (clear) main.appendChild(clear);
  main.appendChild(safe(ctListCard));
  const drawer = ctState.sel ? safe(ctDrawer) : null;
  if (drawer) main.appendChild(drawer);
  if (document.body && document.body.classList) document.body.classList.toggle('gr-pp-lock', !!drawer);
}
