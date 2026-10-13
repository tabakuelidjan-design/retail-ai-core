// SALON: the field loop as ONE flow on the phone - capture -> review -> compare -> ask -> negotiate -> update -> what changed -> save -> resume. This module is the controller; the numbers come from the
// core (core/field/*, the same files run in the tests and on the server) and the HTML from salon-views.js. Everything here works OFFLINE: cases and the workspace live on the phone, the server only
// keeps a copy (and a merge) when it is reachable. No provider is ever called from this screen.
import { newCase, dispatch, assess, recordDecision } from '/core/case.js';
import { createFieldEngine } from '/core/field/engine.js';
import { offerDraft, attributeNameEvents } from '/core/field/offer-import.js';
import { classifyCandidates } from '/core/understanding.js';
import { describeConflict, validateCorrection } from '/core/candidate-view.js';
import { newWorkspace, mergeWorkspaces, listComparisons, removeComparison, setAskState } from '/core/field/workspace.js';
import { sampleState } from '/core/field/external-evidence.js';
import { MIN_CANDIDATES, MAX_CANDIDATES } from '/core/comparison.js';
import { getBlob, putBlob } from '../storage.js';
import * as V from './salon-views.js';

const VIEW_KEY = 'nordla.sourcing.salon.view'; const PROFILE_KEY = 'nordla.sourcing.merchantProfile'; const WS_BLOB = 'field-workspace'; const WS_DIRTY = 'nordla.sourcing.wsDirty';
const num = (v) => (v === '' || v === undefined || v === null ? null : String(v).replace(',', '.').trim());
const FRIENDLY = [[/who spoke/, 'Dites d\'abord qui a écrit cette ligne (fournisseur ou vous).'], [/needs a correction/, 'Ce chiffre est ambigu : corrigez-le avant de le confirmer.'], [/planned quantity/, 'La quantité doit être un nombre entier supérieur à zéro.'], [/at least one value or some text/, 'Collez un texte ou saisissez au moins une valeur.'], [/text is required|needs some text/, 'Collez un texte.']];
const friendly = (e) => (FRIENDLY.find(([rx]) => rx.test(String(e?.message ?? e))) ?? [null, `Impossible (${e?.message ?? e}).`])[1];

export function createSalon(ctx) {
  const { S, ls } = ctx;
  let view = ls.get(VIEW_KEY, { name: 'home' }); let selected = (view.selected ?? []).filter((id) => S.cases[id]); let engine = null; let engineProfile = undefined; let ws = getBlob(WS_BLOB) ?? newWorkspace(); let flash = ''; let pending = { photo: null, pdfText: null, pdfName: null };
  let capMode = 'quote'; let correcting = null; let showQ = null; let wsTimer = null; const openSecs = new Map();
  const save = () => { ls.set(VIEW_KEY, { ...view, selected }); };
  const profile = () => ls.get(PROFILE_KEY, null);
  const eng = () => { const p = profile(); if (!engine || engineProfile !== p) { engine = createFieldEngine({ profile: p, externals: () => ctx.externals(), now: () => new Date() }); engineProfile = p; } return engine; };
  const meaningful = (c) => Boolean(c.identity?.workingName || c.supplier?.name || c.offers?.length || c.quotes?.length || c.notes?.length || c.conversations?.length);
  const allCases = () => Object.values(S.cases).filter(meaningful).sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  const caseOf = (id) => S.cases[id] ?? null;
  const infoOf = (c) => ({ caseId: c.id, title: c.identity?.workingName || c.id, supplier: c.supplier?.name ?? null, sample: sampleState(c), numbers: { price: c.sale?.sellingPriceGross ?? '', target: c.sale?.targetContributionPct ?? '', freight: c.costs?.costs?.freight?.total ?? '', duty: c.customs?.duty?.ratePct ?? '', fx: c.costs?.fx?.rate ?? '', qty: c.context?.plannedQty ?? '', vat: c.sale?.vatRatePct ?? 21 } });

  // ---- workspace: local first (IndexedDB), the server keeps a merged copy when it can ----------------------------------------------------------------------------------------------------
  const saveWs = (next) => { ws = next; putBlob(WS_BLOB, ws); ls.set(WS_DIRTY, true); clearTimeout(wsTimer); wsTimer = setTimeout(() => { syncWs(); }, 1500); };
  async function syncWs() {
    if (!S.token || !S.online) return false;
    try {
      const r = await fetch('/api/field/workspace', { headers: { 'x-sourcing-token': S.token } }); if (r.ok) { ws = mergeWorkspaces(ws, await r.json()); }
      const w = await fetch('/api/field/workspace', { method: 'PUT', headers: { 'x-sourcing-token': S.token, 'content-type': 'application/json' }, body: JSON.stringify(ws) });
      if (w.ok) { ws = mergeWorkspaces(ws, await w.json()); putBlob(WS_BLOB, ws); ls.set(WS_DIRTY, false); return true; }
    } catch { /* offline or server down: the local copy is the truth until the next attempt */ }
    return false;
  }
  async function loadProfile() {
    if (profile() || !S.token || !S.online) return;
    try { const r = await fetch('/api/field/merchant-profile', { headers: { 'x-sourcing-token': S.token } }); if (r.ok) { ls.set(PROFILE_KEY, await r.json()); ctx.render(); } } catch { /* the fit says the profile is not loaded */ }
  }
  const touchCase = (id) => { try { const a = assess(S.cases[id], { now: new Date(), externals: ctx.externals() }); S.cases[id] = recordDecision(S.cases[id], a, new Date()); } catch { /* the screen shows what it can */ } };
  const commit = (id, events) => {
    for (const e of events) S.cases[id] = dispatch(S.cases[id], e, new Date());
    touchCase(id); S.currentId = id; ctx.persist(); if (S.token) ctx.markDirty(id); ctx.queueSync();
    try { ws = eng().record(ws, S.cases[id]).ws; saveWs(ws); } catch (e) { console.error(e); }
  };
  const go = (next) => { view = { ...view, ...next }; save(); flash = ''; remember(); ctx.render(); window.scrollTo(0, 0); };
  const remember = () => { ws = eng().setView(ws, { lastCaseId: view.caseId ?? null, lastComparisonId: view.cmpId ?? null, lastScreen: view.name }); saveWs(ws); };

  // ---- rendering ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
  function nav() {
    const items = [['home', 'Fournisseurs'], ['capture', 'Capturer'], ['compare', 'Comparer'], ['ask', 'Demander'], ['neg', 'Négocier']];
    const cur = view.name === 'review' || view.name === 'case' ? 'home' : view.name === 'changed' ? 'case' : view.name;
    return items.map(([k, l]) => `<button type="button" data-act="sl-nav" data-key="${k}" aria-current="${cur === k || (k === 'neg' && view.name === 'negotiate')}">${l}</button>`).join('');
  }
  function resumeInfo() {
    const v = ws.views; if (!v?.lastScreen || v.lastScreen === 'home' || view.name !== 'home') return null; const c = v.lastCaseId ? caseOf(v.lastCaseId) : null; const label = { compare: 'la comparaison', case: 'la fiche', ask: 'les questions', negotiate: 'la négociation', review: 'la relecture', capture: 'la capture' }[v.lastScreen] ?? 'là où vous étiez';
    return v.lastCaseId && !c && !v.lastComparisonId ? null : { label: `${label}${c?.supplier?.name ? ` de ${c.supplier.name}` : ''}`, view: v };
  }
  function render() {
    const e = eng(); const cases = allCases();
    try {
      if (view.name === 'capture') { const info = view.caseId && caseOf(view.caseId) ? infoOf(caseOf(view.caseId)) : null; return V.captureHtml({ caseInfo: info, mode: capMode, flash, online: S.online }); }
      if (view.name === 'review') { const c = caseOf(view.caseId); const oid = view.offerId ?? c?.offers?.at(-1)?.id; if (!c || !oid) return home(cases, e); const d = offerDraft(c, oid); const groupable = classifyCandidates(c).group.filter((x) => x.offerId === oid).map((x) => x.id);
        const conflicts = c.conflicts.filter((x) => x.state === 'OPEN' && c.candidates.some((k) => k.id === x.candidateId && k.offerId === oid)).map((x) => describeConflict(x)); return V.reviewHtml({ draft: d, caseInfo: infoOf(c), groupableIds: groupable, conflicts, unknownNames: d.unknownSpeakers.filter((n) => n !== '(unnamed)'), correcting, flash }); }
      if (view.name === 'case' || view.name === 'changed') { const c = caseOf(view.caseId); if (!c) return home(cases, e); const r = e.caseView(c, ws); const sup = e.suppliers(allCases(), ws).find((h) => h.cases.some((x) => x.caseId === c.id)) ?? null; return V.caseHtml({ info: infoOf(c), tab: view.tab ?? 'sum', v: r, history: sup, flash }); }
      if (view.name === 'ask') { const c = caseOf(view.caseId); if (!c) return home(cases, e, 'Choisissez un fournisseur pour préparer ses questions.'); const r = e.caseView(c, ws, ['askNow']); const html = V.askHtml({ info: infoOf(c), ask: r.askNow }); return showQ ? html + V.showHtml({ item: r.askNow.items.find((i) => i.id === showQ) ?? r.askNow.items[0] }) : html; }
      if (view.name === 'negotiate') { const c = caseOf(view.caseId); if (!c) return home(cases, e, 'Choisissez un fournisseur pour préparer la négociation.'); const r = e.caseView(c, ws, ['negotiation']); return V.negotiateHtml({ info: infoOf(c), plan: r.negotiation }); }
      if (view.name === 'compare') {
        const def = view.cmpId ? ws.comparisons[view.cmpId] : null; const ids = (def ? def.caseIds : selected).filter((id) => caseOf(id));
        if (ids.length < MIN_CANDIDATES) return home(cases, e, 'Choisissez au moins deux fournisseurs (+) pour comparer.');
        const r = e.compare(ids.map(caseOf), { id: def?.id ?? undefined, asOf: def?.asOf, ws }); return V.compareHtml({ view: r.view, saved: Boolean(ws.comparisons[r.set.id]), flash });
      }
    } catch (err) { console.error(err); return `<div class="sl"><p class="sl-flash">Cet écran n'a pas pu être calculé : ${String(err.message ?? err)}. Vos données sont enregistrées.</p><button type="button" class="sl-btn pri" data-act="sl-nav" data-key="home">Retour</button></div>`; }
    return home(cases, e);
  }
  function home(cases, e, msg = '') {
    if (msg) flash = msg; const ov = e.overview(cases, ws); const f = flash; flash = '';
    const html = V.homeHtml({ overview: ov, comparisons: listComparisons(ws), selected, resume: resumeInfo(), online: S.online, ws });
    return f ? html.replace('<section>', `<p class="sl-flash">${f.replace(/[<>&]/g, '')}</p><section>`) : html;
  }
  function paint() { const main = document.querySelector('#screen'); for (const d of main.querySelectorAll('details[data-sec]')) if (openSecs.has(d.dataset.sec)) d.open = openSecs.get(d.dataset.sec); }
  document.addEventListener('toggle', (ev) => { const d = ev.target; if (d?.matches?.('details[data-sec]')) openSecs.set(d.dataset.sec, d.open); }, true);

  // ---- actions --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
  const must = (id) => { const c = caseOf(id); if (!c) throw new Error('unknown case'); return c; };
  const lastCaseId = () => view.caseId && caseOf(view.caseId) ? view.caseId : (ws.views.lastCaseId && caseOf(ws.views.lastCaseId) ? ws.views.lastCaseId : allCases()[0]?.id ?? null);
  async function click(ev, t) {
    const act = t.dataset.act; const key = t.dataset.key; const val = t.dataset.val !== undefined ? JSON.parse(t.dataset.val) : undefined; const cid = t.dataset.case ?? key;
    try {
      switch (act) {
        case 'sl-nav': {
          if (key === 'home') return go({ name: 'home', caseId: null, offerId: null });
          if (key === 'capture') { capMode = 'quote'; return go({ name: 'capture', caseId: null }); }
          if (key === 'compare') { const last = ws.views.lastComparisonId && ws.comparisons[ws.views.lastComparisonId] ? ws.views.lastComparisonId : null; if (selected.length >= MIN_CANDIDATES) return go({ name: 'compare', cmpId: null }); if (last) return go({ name: 'compare', cmpId: last }); flash = 'Choisissez au moins deux fournisseurs (+) pour comparer.'; return go({ name: 'home' }); }
          const id = lastCaseId(); if (!id) { flash = 'Capturez d\'abord un fournisseur.'; return go({ name: 'home' }); } return go({ name: key === 'ask' ? 'ask' : 'negotiate', caseId: id });
        }
        case 'sl-resume': { const v = ws.views; return go({ name: v.lastScreen === 'review' ? 'case' : v.lastScreen, caseId: v.lastCaseId, cmpId: v.lastScreen === 'compare' ? v.lastComparisonId : null }); }
        case 'sl-open-case': return go({ name: 'case', caseId: key, tab: 'sum' });
        case 'sl-case-tab': view = { ...view, tab: key }; save(); return ctx.render();
        case 'sl-sel': { selected = selected.includes(key) ? selected.filter((x) => x !== key) : [...selected, key].slice(-MAX_CANDIDATES); save(); return ctx.render(); }
        case 'sl-compare': { const def = key ? ws.comparisons[key] : null; if (def) { selected = def.caseIds.slice(); return go({ name: 'compare', cmpId: key }); } return go({ name: 'compare', cmpId: null }); }
        case 'sl-save-cmp': { const ids = (view.cmpId ? ws.comparisons[view.cmpId]?.caseIds : selected) ?? []; const r = eng().compare(ids.map(caseOf), { ws }); saveWs(eng().saveComparison(ws, r.set, r.view)); view = { ...view, cmpId: r.set.id }; save(); flash = 'Comparaison enregistrée sur ce téléphone.'; return ctx.render(); }
        case 'sl-del-cmp': saveWs(removeComparison(ws, key, new Date())); return ctx.render();
        case 'sl-ask': return go({ name: 'ask', caseId: cid }); case 'sl-neg': return go({ name: 'negotiate', caseId: cid });
        case 'sl-review': return go({ name: 'review', caseId: key, offerId: must(key).offers.at(-1)?.id ?? null });
        case 'sl-update-offer': capMode = 'quote'; return go({ name: 'capture', caseId: key });
        case 'sl-cap-mode': capMode = key; return ctx.render();
        case 'sl-confirm': { const c = must(view.caseId); commit(c.id, [{ type: 'CANDIDATE_CONFIRM', id: key }]); return ctx.render(); }
        case 'sl-reject': commit(view.caseId, [{ type: 'CANDIDATE_REJECT', id: key }]); return ctx.render();
        case 'sl-correct-open': correcting = correcting === key ? null : key; return ctx.render();
        case 'sl-confirm-all': { const c = must(view.caseId); const ids = classifyCandidates(c).group.filter((x) => x.offerId === key).map((x) => x.id); if (ids.length) commit(c.id, [{ type: 'CANDIDATES_CONFIRM_BATCH', ids, via: 'GROUP', shown: ids.map((id) => ({ id })) }]); return ctx.render(); }
        case 'sl-resolve': commit(view.caseId, [{ type: 'CONFLICT_RESOLVE', id: key, choice: val }]); return ctx.render();
        case 'sl-attr': { const c = must(view.caseId); const evs = attributeNameEvents(c, view.offerId ?? c.offers.at(-1).id, key, val); if (evs.length) commit(c.id, evs); return ctx.render(); }
        case 'sl-ask-state': { const c = must(cid); ws = setAskState(ws, c.id, key, val, new Date()); if (val === 'ASKED') commit(c.id, [{ type: 'QUESTION_SHOWN', questionId: key, via: 'SHOWN_TO_SUPPLIER' }]); else if (val === 'SKIPPED') commit(c.id, [{ type: 'QUESTION_SKIP', questionId: key }]); saveWs(ws); return ctx.render(); }
        case 'sl-show': showQ = key; return ctx.render(); case 'sl-show-close': showQ = null; return ctx.render();
        case 'sl-sample': commit(key, [{ type: 'SAMPLE_RECORD', ...val }]); return ctx.render();
        case 'sl-expert': { S.currentId = key; ctx.persist(); return ctx.setMode(val); }
        default: return undefined;
      }
    } catch (e) { flash = friendly(e); ctx.render(); }
    return undefined;
  }

  function submit(form, d) {
    const name = form.dataset.form;
    try {
      if (name === 'sl-capture') return capture(d);
      if (name === 'sl-correct') { const c = must(view.caseId); const cand = c.candidates.find((x) => x.id === d.id); const v = validateCorrection(cand.key, d.value, 'fr'); if (!v.ok) { flash = v.error; return ctx.render(); } correcting = null; commit(c.id, [{ type: 'CANDIDATE_CORRECT', id: d.id, value: v.value }]); return ctx.render(); }
      if (name === 'sl-numbers') return numbers(d);
    } catch (e) { flash = friendly(e); ctx.render(); }
    return undefined;
  }
  function capture(d) {
    const text = String(d.text ?? '').trim(); const mode = d.mode ?? capMode; const manual = mode === 'manual' ? { currency: d.m_currency, unitPrice: num(d.m_unitPrice) ?? '', moq: num(d.m_moq) ?? '', incoterm: d.m_incoterm, port: d.m_port, leadTimeDays: num(d.m_leadTimeDays) ?? '', material: d.m_material, depositPct: num(d.m_depositPct) ?? '' } : null;
    const hasManual = manual && Object.values(manual).some((v) => String(v ?? '').trim()); const supplier = String(d.supplier ?? '').trim(); const product = String(d.product ?? '').trim();
    if (!text && !hasManual && !supplier && !product && !d.note && !pending.photo) { flash = 'Dites au moins un nom, un produit, ou collez un texte.'; return ctx.render(); }
    let id = d.caseId; const events = [];
    if (!id) { const c = newCase({ name: product }); S.cases[c.id] = c; id = c.id; if (product) events.push({ type: 'NAME', name: product }); if (supplier) events.push({ type: 'SUPPLIER', supplier: { name: supplier } }); }
    if (d.note && String(d.note).trim()) events.push({ type: 'NOTE', text: String(d.note).trim() });
    const qty = num(d.qty); if (qty) { if (!/^\d+$/.test(qty) || Number(qty) <= 0) { flash = 'La quantité doit être un nombre entier.'; return ctx.render(); } events.push({ type: 'PLAN_QTY', qty: Number(qty) }); }
    if (pending.photo) { const n = (S.cases[id].identity?.photos ?? []).length; putBlob(`photo:${id}.${n}`, pending.photo.url); events.push({ type: 'PHOTO', ref: `photo-${n}`, note: pending.photo.name }); }
    const existing = Boolean(d.caseId); const source = pending.pdfText && text === pending.pdfText ? 'PDF_TEXT' : mode === 'chat' ? 'CHAT' : mode === 'manual' ? 'MANUAL' : 'PASTED_QUOTE';
    if (text || hasManual) events.push({ type: 'OFFER_IMPORT', source, ...(source === 'MANUAL' ? { manual } : { text }), supplier: supplier || undefined, revision: existing && S.cases[id].offers.length > 0 ? true : undefined, meNames: ['Moi', 'Me'] });
    commit(id, events); pending = { photo: null, pdfText: null, pdfName: null }; capMode = 'quote';
    const c = S.cases[id]; return go(c.offers.length ? { name: 'review', caseId: id, offerId: c.offers.at(-1).id } : { name: 'case', caseId: id, tab: 'sum' });
  }
  function numbers(d) {
    const c = must(d.caseId); const ev = []; const price = num(d.price); const target = num(d.target); const vat = num(d.vat) ?? c.sale?.vatRatePct ?? 21;
    if (price) ev.push({ type: 'SALE', sale: { ...(c.sale ?? {}), sellingPriceGross: price, vatRatePct: vat, ...(target !== null ? { targetContributionPct: target } : {}), priceBasis: c.sale?.priceBasis ?? 'TARGET' } });
    else if (target !== null) ev.push({ type: 'SALE', sale: { ...(c.sale ?? {}), targetContributionPct: target } });
    const freight = num(d.freight); const fx = num(d.fx);
    if (freight !== null || fx !== null) ev.push({ type: 'COSTS', costs: { ...(c.costs ?? {}), ...(fx !== null ? { fx: { rate: fx, date: new Date().toISOString().slice(0, 10), source: 'USER_ENTERED' } } : {}), costs: { ...(c.costs?.costs ?? {}), ...(freight !== null ? { freight: { total: freight, status: 'ESTIMATED' } } : {}) } } });
    const duty = num(d.duty); if (duty !== null) ev.push({ type: 'CUSTOMS', customs: { duty: { ratePct: duty, kind: 'USER_ENTERED', source: 'owner' } } });
    const qty = num(d.qty); if (qty) ev.push({ type: 'PLAN_QTY', qty: Number(qty) });
    if (ev.length) commit(c.id, ev); flash = ev.length ? 'Chiffres enregistrés.' : 'Rien à enregistrer.'; return ctx.render();
  }

  // ---- file inputs (photo reference, PDF text layer / text file) -------------------------------------------------------------------------------------------------------------
  const downscale = async (file, max, q) => { const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' }); const k = Math.min(1, max / Math.max(bmp.width, bmp.height)); const cv = document.createElement('canvas'); cv.width = Math.round(bmp.width * k); cv.height = Math.round(bmp.height * k); cv.getContext('2d').drawImage(bmp, 0, 0, cv.width, cv.height); return cv.toDataURL('image/jpeg', q); };
  async function onFile(ev) {
    const t = ev.target.closest?.('input[data-act="sl-photo"], input[data-act="sl-pdf"]'); if (!t || !t.files?.[0]) return; const file = t.files[0];
    try {
      if (t.dataset.act === 'sl-photo') { pending.photo = { url: await downscale(file, 640, 0.7), name: file.name }; flash = 'Photo prête : elle sera gardée sur ce téléphone comme référence.'; return ctx.render(); }
      let text = ''; if (/\.txt$/i.test(file.name) || file.type.startsWith('text/')) text = await file.text();
      else if (S.token && S.online) { const buf = new Uint8Array(await file.arrayBuffer()); let bin = ''; for (const b of buf) bin += String.fromCharCode(b); const r = await fetch('/api/documents/extract', { method: 'POST', headers: { 'x-sourcing-token': S.token, 'content-type': 'application/json' }, body: JSON.stringify({ fileName: file.name, mime: file.type, dataBase64: btoa(bin) }) }); const j = await r.json(); text = j.text ?? ''; if (!text) { flash = j.note ?? 'Aucun texte lisible dans ce PDF. Collez le texte ou saisissez à la main.'; return ctx.render(); } }
      else { flash = 'Hors ligne : un PDF ne peut pas être lu ici. Collez le texte, ou saisissez à la main.'; return ctx.render(); }
      pending.pdfText = text.trim(); pending.pdfName = file.name; const ta = document.querySelector('textarea[name="text"]'); if (ta) ta.value = pending.pdfText; flash = `Texte lu dans ${file.name} (${pending.pdfText.length} caractères). Vérifiez-le puis importez.`; ctx.render(); const ta2 = document.querySelector('textarea[name="text"]'); if (ta2) ta2.value = pending.pdfText;
    } catch { flash = 'Ce fichier n\'a pas pu être lu.'; ctx.render(); }
  }
  document.addEventListener('change', onFile);

  return { render, nav, click, submit, paint, syncWs, loadProfile, remember, state: () => ({ view, selected, wsRev: ws.rev }), workspace: () => ws, engine: eng };
}
