'use strict';
// Nordla Growth - Opportunités > « Guide des fonctions »: ONE closed line at the top of the page that lists every function of lots _01 to _11 under a plain name, where it opens, what its state is FOR THIS
// MERCHANT (read from the data the page already has: available, nothing to do today, not connected, unavailable, not wired) and what connection is still missing. It reads, it opens, it invents nothing.
// Loaded BEFORE opportunities.js (plain scripts share one global scope; the helpers h, t, num... are used only when these functions are CALLED).

var GUIDE_FUNCTIONS = [
  { id: 'prepare', lots: '_01 · _03', sel: '.gr-pr-commercial', state: (d) => guideCount([...((d.sections && d.sections.commercial) || []), ...guideWeekly(d)].filter((x, i, a) => a.findIndex((y) => y.id === x.id) === i)) },
  { id: 'priorities', lots: '_02', sel: '.gr-pr-commercial', state: (d) => guideCount(guideWeekly(d)) },
  { id: 'review', lots: '_04', sel: 'details.gv-reviews', state: () => ({ kind: 'onDate' }) },
  { id: 'email', lots: '_05', sel: '.gr-pr-commercial', state: (d) => guideCount(((d.sections && d.sections.commercial) || []).filter((i) => i.kind === 'segment')) },
  { id: 'ads', lots: '_06', sel: 'details.gv-ads', state: (d) => guideBlock(d.ads) },
  { id: 'site', lots: '_07', sel: 'details.gv-site', state: (d) => guideBlock(d.site) },
  { id: 'social', lots: '_08', sel: 'details.gv-social', state: (d) => guideBlock(d.social) },
  { id: 'creator', lots: '_08', sel: 'details.gv-social', state: (d) => guideBlock(d.social) },
  { id: 'calendar', lots: '_09', sel: 'details.gv-social', state: (d) => guideBlock(d.social) },
  { id: 'inquiry', lots: '_10', sel: 'details.gv-inbox', state: (d) => guideBlock(d.inbox) },
  { id: 'pipeline', lots: '_11', sel: 'details.gv-inbox', state: (d) => guideBlock(d.inbox) },
  { id: 'corrections', lots: 'dossier', sel: '.gr-pr-fix', state: (d) => (d.counts && Number.isFinite(d.counts.fixCorrections) ? (d.counts.fixCorrections > 0 ? { kind: 'count', n: d.counts.fixCorrections } : { kind: 'none' }) : { kind: 'absent' }) },
];
const guideWeekly = (d) => (Array.isArray(d.weekly) ? d.weekly : (d.weekly && d.weekly.items) || []);
function guideCount(items) { const n = (items || []).length; return n > 0 ? { kind: 'count', n } : { kind: 'none' }; }
/** The state of an optional block (ads, site, social, inbox): absent when the source is not wired on this page, else its own state. */
function guideBlock(b) {
  if (!b) return { kind: 'absent' };
  if (b.state === 'NOT_CONNECTED' && !(b.items && b.items.length)) return { kind: 'NOT_CONNECTED' };
  if (b.state === 'UNAVAILABLE') return { kind: 'UNAVAILABLE' };
  const n = (b.items || []).length; return n > 0 ? { kind: 'count', n } : { kind: 'none' };
}
const guideStateText = (s) => (s.kind === 'count' ? t('gr.guide.st.count', num(s.n)) : t(`gr.guide.st.${s.kind}`));
const guideOk = (s) => s.kind === 'count';

/** Opens the fold or the section the function lives in and brings it into view. Says so when there is nothing to open (instead of doing nothing). */
function guideGo(sel, note) {
  const el = typeof document.querySelector === 'function' ? document.querySelector(sel) : null;
  if (!el) { note.replaceChildren(t('gr.guide.nothing')); return; }
  note.replaceChildren();
  if (el.tagName === 'DETAILS') el.open = true;
  if (typeof el.scrollIntoView === 'function') el.scrollIntoView({ block: 'start' });
}

function opGuideCard(d) {
  const preview = d.guide && d.guide.isPreview === true; const previewUrl = d.guide && typeof d.guide.previewUrl === 'string' && /^https?:\/\//.test(d.guide.previewUrl) ? d.guide.previewUrl : null;
  const note = h('p', { class: 'gr-muted', role: 'status' });
  const rows = GUIDE_FUNCTIONS.map((f) => {
    const s = f.state(d); const need = t(`gr.guide.f.${f.id}.need`);
    return h('li', { class: 'gv-guide-row', 'data-guide': f.id },
      h('strong', null, t(`gr.guide.f.${f.id}.name`)), h('span', { class: 'gr-muted' }, f.lots.startsWith('_') ? ` · ${t('gr.guide.lot', f.lots)}` : ''), ' ',
      h('span', { class: `gv-guide-state${guideOk(s) ? ' ok' : ''}` }, guideStateText(s)),
      h('p', { class: 'gr-muted' }, t(`gr.guide.f.${f.id}.how`)),
      need ? h('p', { class: 'gr-muted gv-guide-need' }, need) : null,
      h('button', { type: 'button', class: 'gv-link gv-guide-go', on: { click: () => guideGo(f.sel, note) } }, t('gr.guide.go')));
  });
  return h('details', { class: 'ex-card gr-pr-card gv-fold gv-watch gv-guide' }, h('summary', null, h('span', { class: 'gv-fold-title' }, t('gr.guide.title')), h('span', { class: 'gv-fold-signal' }, preview ? t('gr.guide.signalPreview') : t('gr.guide.signal', num(GUIDE_FUNCTIONS.length)))),
    h('p', { class: 'ex-sub gr-pr-intro' }, t('gr.guide.intro')),
    preview ? h('p', { class: 'gv-guide-preview', role: 'note' }, h('strong', null, t('gr.guide.previewBanner'))) : null,
    !preview && previewUrl ? h('p', null, h('a', { class: 'gr-op-link', href: previewUrl, target: '_blank', rel: 'noopener noreferrer', 'data-guide-preview': 'link' }, t('gr.guide.previewLink')), ' ', h('span', { class: 'gr-muted' }, t('gr.guide.previewNote'))) : null,
    h('ul', { class: 'gv-guide-list' }, rows), note);
}
