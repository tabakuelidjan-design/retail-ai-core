// Nordla - Sourcing terrain (field mode V0). The decision engines run HERE, in the browser (same files as the server and the tests), so the phone works offline.
// The server is optional: it keeps cases on disk, holds the Safety Gate cache and reads PDFs. Failure of any optional call never stops the case.
import { newCase, dispatch, assess, whatIf, recordDecision, suggestCategories, safetyFacts, safetyKey } from '/core/case.js';
import { CATEGORIES } from '/core/taxonomy.js';
import { effective } from '/core/identity.js';
import { fmt } from '/core/money.js';
import { INCOTERMS } from '/core/landed.js';
import { MARKETPLACES } from '/core/amazon.js';
import { DOC_TYPES } from '/core/docinspect.js';
import { capabilityMatrix } from '/core/capabilities.js';
import { headerStatus } from '/core/status.js';
import { ls, initStorage, getBlob, putBlob, storageEstimate } from './storage.js'; import { backupSection, createBackup, fetchCasePhotos } from './backup.js'; import { csrfToken, detectAuth, installSignIn, loginScreen } from './session.js'; import { createCorePanel } from './core-panel.js'; import { createModulesPanel } from './modules-panel.js';
import { $, esc, chip, money, list, field, selectOf, seg, quoteOf, VERDICT_TEXT } from './dom.js';
import { S, cur, LEGACY_UI } from './state.js';
import { formKey, captureDrafts, restoreDrafts } from './draft.js';
import { numbersInner } from './numbers.js';
import { num, quoteFormEvent, quickQuoteEvent } from '/core/form-events.js';
import { decisionScreen } from './screens/decision.js';
import { quickScreen } from './screens/quick.js';
import { caseScreen } from './screens/case.js';
import { askScreen } from './screens/ask.js';
import { docsScreen } from './screens/docs.js';
import { rulesScreen } from './screens/rules.js';
import { marketScreen } from './screens/market.js';
import { detectBarcode, prepareForUpload } from './barcode-local.js';
import { moneyScreen } from './screens/money.js';
import { fieldScreen } from './screens/field.js';
import { createSalon } from './screens/salon.js';
import { validateCorrection } from '/core/candidate-view.js';
import { fieldFirst, fmCompute, fmNav, fieldMissing } from './screens/fieldfirst.js';
import { fieldSummaryText } from '/core/field-summary.js';
import { createVoice } from './voice.js';
import { validateCase, parseImportText, buildExport, exportSummary, planRecovery, applyRecovery, photoKeysFor, MAX_IMPORT_BYTES } from '/core/recovery.js';
import { recoverySection, recoveryError } from './recover.js';
import { createSyncHelpers } from './sync-state.js';
import { createEmbedded, settingsHtml } from './embedded.js';
import { activeMenuCase, applyLegacyReanalysis } from './menu-case.js';
import { buildSearchInput, outgoingFields, searchMarket } from '/core/market-search.js';
import { buildProductHypothesis } from '/core/product-hypothesis.js';
import { turnClosesAt } from '/core/turns.js';
import { planContext } from '/core/context-engine.js';
import { planConversation, answerEvents } from '/core/conversation-engine.js';
import { groupUnderstanding } from '/core/understanding.js';
import { userQuestionView } from '/core/conversation.js';

const TABS = [['field', 'Guided'], ['quick', 'Quick'], ['decision', 'Verdict'], ['case', 'Case'], ['ask', 'Ask'], ['docs', 'Docs'], ['compliance', 'Rules'], ['market', 'Market'], ['money', 'Money']];

/** What the phone holds. */
function safetyCopy() { const c = getBlob('safety'); return c?.alerts ? { present: true, fetchedAt: Date.parse(c.phoneFetchedAt ?? 0) || 0, serverMode: c.source?.mode } : { present: false }; }
/** The ONE place that decides what may be called verified / live (core/status.js): an authenticated check that succeeded recently, and a live copy under 24 h old. */
const status = () => headerStatus({ hasToken: !!S.token, offlineChoice: S.offlineChoice, authFailed: S.authFailed, lockedOut: S.lockedOut, verifiedAt: S.verifiedAt, copy: safetyCopy(), now: Date.now() });
/** The Safety Gate copy kept ON THE PHONE (matched locally, offline). Its mode is LIVE only when status() says so; otherwise CACHED. */
function externals() {
  const c = getBlob('safety'); if (!c || !c.alerts) return {};
  return { safety: { alerts: c.alerts, source: { ...c.source, mode: status().safety.state === 'LIVE' ? 'LIVE_VERIFIED' : 'CACHED' } } };
}
const run = (state, extra = {}) => assess(state, { now: new Date(), externals: externals(), ...extra });

function persist() { if (!ls.set('nordla.sourcing.cases', S.cases)) S.flash = 'Local storage is full: export the case (menu) before adding more photos.'; ls.set('nordla.sourcing.current', S.currentId); }
function ensureCase() { if (!cur()) { const c = newCase({}); S.cases[c.id] = c; S.currentId = c.id; persist(); } migrateObservation(); }
/** A case named before the product observer existed has no name observation: replaying its NAME gives it one (same event, same result everywhere). */
function migrateObservation() { const c = cur(); if (c && c.identity?.workingName && !(c.productObservations ?? []).some((o) => o.observer === 'name-cues')) { try { S.cases[S.currentId] = dispatch(c, { type: 'NAME', name: c.identity.workingName }, new Date()); persist(); } catch (e) { console.error(e); } } }

/** Every change goes through here: event -> new state -> saved locally -> synced when a server is reachable. */
function commit(event) {
  S.cases[S.currentId] = dispatch(cur(), event, new Date()); S.whatIf = null;
  try { const a = run(cur()); S.cases[S.currentId] = recordDecision(cur(), a, new Date()); } catch { /* shown by render */ }
  markDirty(S.currentId); // an explicit change: marked at once and kept on the phone (token or not), so closing the app before the sync runs, or editing offline, never loses it
  persist(); if (S.quiet) paintLive(); else render(); queueSync();
}
/** Autosave while typing numbers: the results strip updates in place (no re-render, so the keyboard and the focus stay where they are). */
function paintLive() {
  try { S.A = run(cur()); } catch { return; }
  const el = $('#money-live'); if (el) el.innerHTML = numbersInner(S.A, cur());
  paintHeader();
}

// ---- optional server -------------------------------------------------------------------------------------------------------------------------------------------------------
const api = async (path, opts = {}) => { const r = await fetch(path, { ...opts, credentials: 'same-origin', headers: { ...(S.authMode === 'session' ? { 'x-nordla-csrf': csrfToken() } : { 'x-sourcing-token': S.token }), 'content-type': 'application/json', ...(opts.headers ?? {}) } }); /* hosted: session cookie + CSRF (session.js) */ const body = await r.json().catch(() => ({})); if (!r.ok) throw Object.assign(new Error(body.error ?? r.status), { status: r.status, body }); return body; };
/** After a failed connection the sync is retried with a growing delay (1.5 s ... 30 s) while changes are waiting, so a reset connection right after the network returns does not leave them stuck. */
let retryMs = 0; let retryTimer = null;
function scheduleRetry() { clearTimeout(retryTimer); retryMs = Math.min(retryMs ? retryMs * 2 : 1500, 30000); retryTimer = setTimeout(() => ping(), retryMs); }
async function ping() {
  if (!S.token) { S.online = false; S.verifiedAt = 0; return; }
  const was = S.online;
  try { await api('/api/health'); S.online = true; S.verifiedAt = Date.now(); S.authFailed = false; S.lockedOut = false; retryMs = 0; }
  catch (e) {
    S.online = false; S.verifiedAt = 0; S.authFailed = e.status === 401; S.lockedOut = e.status === 429;
    if (e.status === 429) S.flash = 'Too many wrong attempts: wait a minute.';
    if (!S.authFailed && !S.lockedOut && dirty.size) scheduleRetry();
  }
  paintHeader(); if (S.authFailed || was !== S.online) render();
  if (S.online) { refreshAi(); if (dirty.size) sync(); else backup.run(); autoSafety(); try { const sa = salon(); sa.loadProfile(); sa.syncWs(); } catch { /* the salon keeps working from the phone */ } }
}
/** Once the server is verified, the phone fetches the Safety Gate copy by itself when it has none (or only an old one): the owner should not have to find a button. */
function autoSafety() {
  const c = safetyCopy(); const old = c.present && Date.now() - c.fetchedAt > 20 * 3600e3;
  if ((c.present && !old) || S.busy === 'safety' || Date.now() - (S.safetyAutoAt ?? 0) < 5 * 60e3) return;
  S.safetyAutoAt = Date.now(); checkSafety({ quiet: true });
}
async function refreshAi() { try { S.ai = await api('/api/ai/status'); } catch { S.ai = null; } }
let syncTimer = null;
function queueSync() { clearTimeout(syncTimer); syncTimer = setTimeout(sync, 800); }
const dirty = new Set(ls.get('nordla.sourcing.dirty', []));
const markDirty = (id) => { dirty.add(id); ls.set('nordla.sourcing.dirty', [...dirty]); };
/** Pushes every case the owner changed (marked by commit(), kept across restarts) and nothing else: never the case that is merely open. Edits made while a request is in flight are kept (the case is marked changed again); a case changed
 *  elsewhere is NEVER overwritten: it is reported and the owner chooses (take the server copy, or keep both). */
let syncing = false; // also read by the backup (backup.js): it never runs during a sync
async function sync() {
  if (!S.token || syncing || !dirty.size) return; // ONLY cases the owner changed are sent: opening, recovering, importing, switching or restarting never marks a case
  syncing = true; let conflicted = false;
  try {
    for (const id of [...dirty]) {
      const c = S.cases[id]; if (!c) { dirty.delete(id); continue; }
      const sentAt = c.updatedAt;
      try {
        const saved = await api(`/api/cases/${id}`, { method: 'PUT', body: JSON.stringify(c) });
        const now = S.cases[id]; S.online = true; S.verifiedAt = Date.now(); /* an authenticated PUT that succeeded is a live verification too */
        if (now && now.updatedAt !== sentAt) { S.cases[id] = { ...now, rev: saved.rev }; /* edited meanwhile: keep my newer content, send it again */ }
        else S.cases[id] = { ...saved };
        dirty.delete(id); if (S.cases[id].updatedAt !== sentAt) markDirty(id);
      } catch (e) {
        if (e.status === 409) { (S.conflicts ??= {})[id] = e.body?.server ?? null; if (S.mode !== 'salon') S.flash = 'Un dossier a été modifié sur un autre appareil. Rien n\'a été écrasé : ouvrez le menu pour voir les différences et choisir.'; /* in Nordla the red banner says it */ dirty.delete(id); conflicted = true; }
        else { S.online = false; scheduleRetry(); break; }
      }
    }
  } finally { syncing = false; }
  ls.set('nordla.sourcing.dirty', [...dirty]); persist(); paintHeader();
  if (conflicted) render(); // a conflict found in the background must be SEEN at once (banner), never discovered by chance on the next tap
  if (dirty.size && S.online) queueSync(); else if (S.online) backup.run();
}
async function checkSafety({ quiet = false } = {}) {
  if (!quiet) { S.busy = 'safety'; render(); }
  try {
    try { await api('/api/safety/refresh', { method: 'POST' }); } catch { /* the server could not reach the EU source: its copy stays what it was (and says so) */ }
    const r = await api('/api/safety/alerts');
    if (!r.alerts) { if (!quiet) S.flash = 'The server has no Safety Gate data yet. Still OFFLINE - VERIFICATION REQUIRED.'; }
    else { const ok = await putBlob('safety', { alerts: r.alerts, source: r.source, phoneFetchedAt: new Date().toISOString() }); S.flash = ok ? '' : 'The Safety Gate copy could not be stored on this phone (storage full?).'; }
  } catch (e) { if (!quiet) S.flash = e.status === 401 ? 'Wrong or missing access token (menu).' : 'The Safety Gate could not be reached: the result stays what it was (CACHED or OFFLINE - VERIFICATION REQUIRED). This is not a clean result.'; }
  S.busy = ''; render();
}
async function fetchFx() {
  const q = quoteOf(cur()); if (!q.currency) { S.flash = 'Confirm the currency of the price first: the rate depends on it.'; return render(); } if (!S.token) { S.flash = 'Add the access token (menu) to fetch the ECB rate, or type the rate.'; return render(); }
  try { const fx = await api(`/api/fx?currency=${encodeURIComponent(q.currency)}`); commit({ type: 'COSTS', costs: { fx: { rate: String(fx.rate), date: fx.date, source: fx.source }, costs: cur().costs.costs, importVat: cur().costs.importVat } }); }
  catch { S.flash = 'The rate could not be fetched: type it by hand.'; render(); }
}

const SCREENS = { field: fieldScreen, quick: quickScreen, decision: decisionScreen, case: caseScreen, ask: askScreen, docs: docsScreen, compliance: rulesScreen, market: marketScreen, money: moneyScreen };

// ---- shell ------------------------------------------------------------------------------------------------------------------------------------------------------------------
function paintHeader() {
  const c = cur(); if (!c) return;
  $('#case-name').textContent = c.identity.workingName || 'New case'; $('#case-sub').textContent = [c.supplier.name, c.identity.identifiers.model].filter(Boolean).join(' - ');
  const st = status(); const el = $('#mode');
  el.className = `badge ${st.server.tone === 'ok' ? 'b-live' : st.server.tone === 'warn' ? 'b-cached' : 'b-off'}`; el.textContent = st.server.label;
  el.title = st.server.state === 'VERIFIED' ? 'an authenticated check of your server just succeeded' : st.server.state === 'UNREACHABLE' ? 'your server did not answer: the case works on this phone' : st.server.label;
  const bar = $('#statusbar'); if (!bar) return;
  bar.innerHTML = `<span class="badge ${st.safety.tone === 'ok' ? 'b-live' : st.safety.tone === 'warn' ? 'b-cached' : 'b-off'}">${esc(st.safety.label)}</span>${st.safety.action === 'DOWNLOAD' ? ' <button type="button" class="linkbtn" data-act="safety">Download now</button>' : ''}${st.safety.action === 'NEEDS_SERVER' ? ' <span class="muted small">needs your server</span>' : ''}${S.busy === 'safety' ? ' <span class="muted small">downloading...</span>' : ''}`;
}
function gate() {
  return `<div class="card"><h2>SIGN IN</h2><p class="small muted">Enter the access token of your Nordla server to keep cases on it and use the Safety Gate cache. Or work on this phone only: everything except live checks works offline.</p>${S.authFailed ? '<p class="warn">The token was refused.</p>' : ''}<label>Access token<input id="gate-tok" type="password" autocomplete="off"></label><button class="btn" data-act="gate-save" style="margin-top:10px">Sign in</button><button class="btn sec" data-act="gate-offline" style="margin-top:8px">Work on this phone only</button></div>`;
}
/** Whatever the owner has typed but not yet submitted must survive ANY re-render (a connection blip, the status check, the Safety Gate download all re-render by themselves).
 *  Only fields that differ from what was rendered are kept; they are put back into the same form of the same case and tab. */
let lastRenderKey = null; let discardDrafts = false;
function render() {
  ensureCase(); const c = cur();
  if ((!S.token && !S.offlineChoice) || S.authFailed) { $('#tabs').innerHTML = ''; $('#screen').innerHTML = S.authMode === 'session' ? loginScreen(S) : gate(); $('#case-name').textContent = 'Nordla - Sourcing'; return; }
  const fm = S.mode === 'field'; const sl = S.mode === 'salon';
  document.body.classList.toggle('fm-mode', fm); document.body.classList.toggle('sl-mode', sl);
  if (sl) { // Field V1 salon: its own screens and bottom bar; the drafts the owner typed survive a re-render exactly like everywhere else
    $('#tabs').innerHTML = salon().nav(); try { paintHeader(); } catch { /* ignore */ }
    const main = $('#screen'); const key = `salon|${salon().state().view.name}|${salon().state().view.caseId ?? ''}|${salon().state().view.offerId ?? ''}`; const keep = !discardDrafts && lastRenderKey === key; discardDrafts = false; lastRenderKey = key;
    const drafts = keep ? captureDrafts(main) : {}; const ae = document.activeElement; const focus = keep && ae?.form && main.contains(ae) && ae.name ? { form: formKey(ae.form), name: ae.name, pos: ae.selectionStart ?? null } : null;
    main.innerHTML = salon().render(); salon().paint(); if (keep) restoreDrafts(main, drafts, focus); return;
  }
  $('#tabs').innerHTML = fm ? fmNav() : TABS.map(([k, l]) => `<button data-act="tab" data-key="${k}" aria-current="${S.tab === k}">${l}</button>`).join('');
  try { S.A = run(c); S.error = null; } catch (e) { S.error = e; console.error(e); }
  let fmv = null; clearTimeout(S.fmTimer); clearTimeout(S.turnTimer); S.fmStatus = status();
  { const cfgT = ls.get('nordla.sourcing.turns', null); const t = Date.now(); const next = (c.conversations ?? []).flatMap((v) => v.items).map((i) => turnClosesAt(i, cfgT)).filter((x) => x !== null && x > t).sort((a, b) => a - b)[0]; if (next) S.turnTimer = setTimeout(render, next - t + 30); } // an open turn stops looking open after the silence
  if (fm && !S.error) { try { fmv = fmCompute(S.A, c); S.fmPrev = { caseId: c.id, state: fmv.state }; if (fmv.explicit && !fmv.show) S.flash = "Rien d'important à demander pour l'instant."; const wake = fmv.hold?.until ?? fmv.wake; if (wake) S.fmTimer = setTimeout(render, Math.max(50, wake - Date.now() + 30)); } catch (e) { S.error = e; console.error(e); } }
  paintHeader();
  const main = $('#screen'); const key = `${S.currentId}|${fm ? `field:${S.sheet ?? 'talk'}` : S.tab}`;
  const keep = !discardDrafts && lastRenderKey === key; discardDrafts = false; lastRenderKey = key;
  const drafts = keep ? captureDrafts(main) : {}; const ae = document.activeElement; const focus = keep && ae?.form && main.contains(ae) && ae.name ? { form: formKey(ae.form), name: ae.name, pos: ae.selectionStart ?? null } : null;
  main.innerHTML = `${S.flash && !fm ? `<div class="warn">${esc(S.flash)}</div>` : ''}${S.error ? `<div class="warn"><b>This screen could not be computed.</b> Your case is saved. ${esc(String(S.error.message ?? S.error))}</div>` : (fm ? (a, k) => fieldFirst(a, k, fmv) : SCREENS[S.tab])(S.A, c)}`;
  if (!fm && S.returnMode === 'field') main.insertAdjacentHTML('afterbegin', '<div class="card"><button type="button" class="btn" data-act="mode-field">← Retour au mode terrain</button></div>');
  if (keep) restoreDrafts(main, drafts, focus);
}

const embeddedHtml = createEmbedded({ S, ls, cur, run, status, render: () => render(), SCREENS, fmNav, fieldFirst, fmCompute, turnClosesAt, esc });

// SALON (Field V1): the whole field loop on the phone. Created on first use, after the local storage has been read.
let salonInstance = null;
const salon = () => (salonInstance ??= createSalon({ S, ls, render: () => render(), persist, markDirty, queueSync, externals, setMode: (m) => setMode(m), openMenu: () => openMenu(), embedded: embeddedHtml, expertSections: () => TABS, syncInfo, conflictVersions, keepBoth, takeServer, syncNow, exportCase, voice: () => voice, capabilities: () => showCapabilities() }));

const backup = createBackup({ S, ls, api, getBlob, photoKeysFor, dirty, isSyncing: () => syncing, persist, paintHeader, refresh: () => openMenu() }); const corePanel = createCorePanel({ S, api, refresh: () => openMenu() }); const nxPanel = createModulesPanel({ S, api, refresh: () => openMenu() }); const { syncInfo, conflictVersions, keepBoth, takeServer, syncNow, exportCase } = createSyncHelpers({ S, dirty, status, persist, markDirty, queueSync, ping, sync, getBlob, putBlob, buildExport, exportSummary });

const menuCase = () => activeMenuCase(S, cur(), S.mode === 'salon' ? salon().state().view : null);
const readForm = (f) => Object.fromEntries(new FormData(f).entries());
const lineSpec = (v) => (num(v) === null ? undefined : { total: num(v), status: 'ESTIMATED' });

// what was typed is submitted into the case: the next screen shows the case, not the old draft
async function onSubmit(ev) {
  const f = ev.target.closest('form[data-form]'); if (!f) return; ev.preventDefault(); const d = readForm(f); if (!S.quiet) discardDrafts = true; const name = f.dataset.form; const c = cur();
  if (name.startsWith('sl-')) { discardDrafts = ['sl-note', 'sl-answer', 'sl-own-q'].includes(name); /* what was typed is kept in its own draft (storage) until it is saved: an error never loses it */ try { return salon().submit(f, d); } finally { discardDrafts = false; } }
  if (name === 'compose') { // FIELD MODE: one box; the conversation starts by itself
    const text = String(d.text ?? ''); if (!text.trim()) { S.flash = 'Écrivez ou collez ce que dit le fournisseur.'; discardDrafts = false; return render(); }
    const prev = S.captureDraft?.[c.id] ?? ''; (S.captureDraft ??= {})[c.id] = ''; ls.set('nordla.sourcing.capdraft', S.captureDraft);
    S.sheet = null; try { if (!(cur().conversations ?? []).some((x) => x.status === 'OPEN')) commit({ type: 'CONVERSATION_START', supplierRef: cur().supplier?.name ?? null, lang: 'auto' }); const conv = cur().conversations.find((x) => x.status === 'OPEN'); return commit({ type: 'CONVERSATION_ITEM', convId: conv.id, speaker: d.speaker === 'me' ? 'me' : 'supplier', lang: 'auto', text }); }
    catch (e) { S.captureDraft[c.id] = prev; ls.set('nordla.sourcing.capdraft', S.captureDraft); throw e; }
  }
  if (name === 'fh-product') { if (!String(d.name ?? '').trim()) { S.flash = 'Dites ce qu\'est le produit, même en quelques mots.'; discardDrafts = false; return render(); } return commit({ type: 'NAME', name: d.name.trim() }); }
  if (name === 'uanswer') {
    const q = planConversation(cur(), S.A).questions.find((x) => x.id === f.dataset.id); if (!q) return render();
    try { const evs = answerEvents(cur(), q, d.value); for (const e of evs) commit(e); return undefined; } catch (e) { S.flash = e.message; discardDrafts = false; return render(); }
  }
  if (name === 'capture') { // the supplier's words: stored as the ORIGINAL; facts are only PROPOSED (nothing reaches the case until the owner confirms)
    const conv = (c.conversations ?? []).find((x) => x.status === 'OPEN'); const text = String(d.text ?? '');
    if (!conv) { S.flash = 'Start a conversation first.'; discardDrafts = false; return render(); }
    if (!text.trim()) { S.flash = 'Type or paste what the supplier said first.'; discardDrafts = false; return render(); }
    const prev = S.captureDraft?.[c.id] ?? ''; (S.captureDraft ??= {})[c.id] = ''; ls.set('nordla.sourcing.capdraft', S.captureDraft);
    try { return commit({ type: 'CONVERSATION_ITEM', convId: conv.id, speaker: d.speaker === 'me' ? 'me' : 'supplier', lang: d.lang || 'auto', text }); }
    catch (e) { S.captureDraft[c.id] = prev; ls.set('nordla.sourcing.capdraft', S.captureDraft); throw e; }
  }
  if (name === 'free-question') {
    if (!String(d.text ?? '').trim()) { S.flash = 'Type your question first.'; discardDrafts = false; return render(); }
    return commit({ type: 'QUESTION_ADD', text: d.text, lang: d.lang || 'en' });
  }
  if (name === 'fact-correct') { try { S.correctingFact = null; return commit({ type: 'FACT_CORRECT', factType: f.dataset.id, value: d.value, mode: 'terrain' }); } catch (e) { S.correctingFact = f.dataset.id; S.flash = e.message; discardDrafts = false; return render(); } }
  if (name === 'cand-correct') {
    const cand = (c.candidates ?? []).find((x) => x.id === f.dataset.id); if (!cand) return render();
    const v = validateCorrection(cand.key, d.value, S.mode === 'field' ? 'fr' : 'en'); if (!v.ok) { S.flash = v.error; discardDrafts = false; return render(); }
    S.correcting = null; return commit({ type: 'CANDIDATE_CORRECT', id: cand.id, value: v.value });
  }
  if (name === 'product') {
    const e = (event) => { S.cases[S.currentId] = dispatch(cur(), event, new Date()); };
    if (d.name !== c.identity.workingName) e({ type: 'NAME', name: d.name });
    for (const k of ['model', 'brand', 'manufacturer', 'gtin']) if (d[k] && d[k] !== (cur().identity.identifiers[k] ?? '')) e({ type: 'IDENTIFIER', origin: 'expert', name: k, value: d[k].trim() });
    if (d.category) e({ type: 'CATEGORY', category: d.category });
    persist(); return commit({ type: 'NOTE', text: 'product updated' });
  }
  if (name === 'electrics') {
    const e = (event) => { S.cases[S.currentId] = dispatch(cur(), event, new Date()); };
    if (num(d.vac) !== null) e({ type: 'TRAIT', trait: 'electrical.maxVoltageAc', value: Number(num(d.vac)) });
    if (num(d.vdc) !== null) e({ type: 'TRAIT', trait: 'electrical.maxVoltageDc', value: Number(num(d.vdc)) });
    if (d.chem) e({ type: 'TRAIT', trait: 'battery.chemistry', value: d.chem });
    return commit({ type: 'NOTE', text: 'ratings updated' });
  }
  if (name === 'supplier') return commit({ type: 'SUPPLIER', supplier: d });
  if (name === 'quote') return commit(quoteFormEvent(d));
  if (name === 'costs') {
    const costs = {}; for (const k of ['freight', 'insurance', 'originCharges', 'brokerage', 'testing', 'inspection', 'labelling', 'epr', 'inboundLogistics']) { const s = lineSpec(d[k]); if (s) costs[k] = s; }
    return commit({ type: 'COSTS', costs: { fx: num(d.fxRate) ? { rate: num(d.fxRate), date: d.fxDate || new Date().toISOString().slice(0, 10), source: 'USER_ENTERED' } : undefined, costs, importVat: num(d.importVat) ? { ratePct: num(d.importVat), recoverable: d.vatRecoverable === 'on' } : undefined } });
  }
  if (name === 'sale') return commit({ type: 'SALE', sale: { sellingPriceGross: num(d.price), vatRatePct: num(d.vat), targetContributionPct: num(d.target), priceBasis: d.basis || 'TARGET' } });
  if (name === 'amazon-sale') { const lines = []; if (num(d.referral)) lines.push({ key: 'referral', kind: 'pct_of_gross', value: num(d.referral), status: 'KNOWN', source: 'Seller Central (entered)' }); else lines.push({ key: 'referral', kind: 'pct_of_gross', status: 'UNKNOWN' }); if (num(d.fulfilment)) lines.push({ key: 'fulfilment', kind: 'per_unit', value: num(d.fulfilment), status: 'KNOWN', source: 'Seller Central (entered)' }); else lines.push({ key: 'fulfilment', kind: 'per_unit', status: 'UNKNOWN' }); return commit({ type: 'SALE_AMAZON', sale: { sellingPriceGross: num(d.aprice), vatRatePct: num(d.avat), lines } }); }
  if (name === 'quick') {
    const e = (event) => { S.cases[S.currentId] = dispatch(cur(), event, new Date()); };
    if (d.name !== cur().identity.workingName) e({ type: 'NAME', name: d.name });
    if (d.category) e({ type: 'CATEGORY', category: d.category });
    const qe = quickQuoteEvent(d); if (qe) e(qe);
    const costs = {}; if (num(d.freight) !== null) costs.freight = { total: num(d.freight), status: 'ESTIMATED' };
    if (num(d.fxRate) !== null) ls.set('nordla.sourcing.lastFx', num(d.fxRate));
    e({ type: 'COSTS', costs: { fx: num(d.fxRate) ? { rate: num(d.fxRate), date: new Date().toISOString().slice(0, 10), source: 'USER_ENTERED' } : cur().costs.fx, costs: { ...(cur().costs.costs ?? {}), ...costs }, importVat: cur().costs.importVat ?? { ratePct: '21', recoverable: true } } });
    if (num(d.duty) !== null) e({ type: 'CUSTOMS', customs: { duty: { ratePct: num(d.duty), kind: 'USER_ENTERED', source: 'entered by the owner', origin: 'CN' } } });
    if (num(d.price) !== null) e({ type: 'SALE', sale: { sellingPriceGross: num(d.price), vatRatePct: cur().sale?.vatRatePct ?? '21', targetContributionPct: num(d.target), priceBasis: cur().sale?.priceBasis ?? 'TARGET' } });
    e({ type: 'CONTEXT', context: { channels: d.dest === 'amazon' ? ['amazon'] : d.dest === 'both' ? ['own_site', 'amazon'] : ['own_site'] } });
    S.tab = 'quick'; return commit({ type: 'NOTE', text: 'quick answer' });
  }
  if (name === 'customs') return commit({ type: 'CUSTOMS', customs: { chosenCode: d.code || null, duty: num(d.rate) ? { ratePct: num(d.rate), kind: 'USER_ENTERED', source: d.source || 'entered by the owner', origin: d.origin || 'CN', notes: d.notes || null } : cur().customs?.duty } });
  if (name === 'obs') return commit({ type: 'AMAZON_OBS', observation: { marketplace: d.marketplace, price: num(d.price), packQty: num(d.packQty), asin: d.asin, reviews: num(d.reviews), rating: num(d.rating), title: d.title, notes: d.notes, source: 'MANUAL' } });
  if (name === 'whatif') { if (num(d.unitPrice) === null) return; try { S.whatIf = whatIf(cur(), { unitPrice: num(d.unitPrice), currency: quoteOf(cur()).currency ?? null }, { now: new Date(), externals: externals() }); } catch (e) { S.flash = `Could not compute: ${e.message}`; } return render(); }
  if (name === 'doc') return addDocument(f, d);
  if (name === 'doc-correct') return commit({ type: 'DOCUMENT_CORRECT', id: f.dataset.id, text: d.text ?? '' });
  if (name === 'doc-typed') {
    const lines = [{ EU_DOC: 'EU DECLARATION OF CONFORMITY', TEST_REPORT: 'TEST REPORT', CERTIFICATE: 'CERTIFICATE', SDS: 'SAFETY DATA SHEET', UN383: 'UN 38.3 test summary', FCM_DOC: 'Declaration of Compliance - food contact', MANUAL: 'USER MANUAL' }[d.docType] ?? 'DOCUMENT', d.manufacturer && `Manufacturer: ${d.manufacturer}`, d.model && `Model: ${d.model}`, d.directives && `Union legislation: ${d.directives}`, d.standards && `Standards: ${d.standards}`, d.lab && `Testing laboratory: ${d.lab}`, d.date && `Date of issue: ${d.date}`, d.pages && `Page ${d.pages.replace(/\s*of\s*/i, ' of ')}`].filter(Boolean);
    return commit({ type: 'DOCUMENT', fileName: 'typed from the paper', text: lines.join('\n'), textSource: 'TRANSCRIBED', docType: d.docType, summary: 'document typed from the paper' });
  }
}

const downscale = async (file, max, q) => { const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' }); const k = Math.min(1, max / Math.max(bmp.width, bmp.height)); const cv = document.createElement('canvas'); cv.width = Math.round(bmp.width * k); cv.height = Math.round(bmp.height * k); cv.getContext('2d').drawImage(bmp, 0, 0, cv.width, cv.height); return cv.toDataURL('image/jpeg', q); };
async function addDocument(form, d) {
  const file = form.elements.file.files[0]; let text = d.text ?? ''; let pages = null; let note = ''; let textSource = 'PASTED'; let photoRef = null; let ocrProvider = null; const id = `doc-${cur().documents.length + 1}`;
  S.busy = 'doc'; render();
  try {
    if (file && !text) {
      if (file.type.startsWith('image/')) {
        const url = await downscale(file, 1600, 0.8); photoRef = `docphoto-${id}`; if (!(await putBlob(`docphoto:${cur().id}.${id}`, url))) S.flash = 'The photo could not be stored on this phone (storage full?).';
        textSource = 'PHOTO_ONLY'; note = 'The photo is kept as evidence but could not be read: type what the paper says (below, in the document card).';
        if (S.token && S.online && S.ai?.enabled) {
          if (window.confirm(`Send this image of the document to ${S.ai.provider} (${S.ai.region}) to be read? Supplier documents are confidential. Choose Cancel to keep the photo only.`)) {
            try { const r = await api('/api/documents/extract', { method: 'POST', body: JSON.stringify({ fileName: file.name, mime: 'image/jpeg', dataBase64: url.split(',')[1], consent: true }) }); text = r.text ?? ''; textSource = 'OCR'; ocrProvider = r.provider ?? null; note = r.note ?? ''; }
            catch (e) { note = `The reader failed (${e.message}). The photo is kept: type what the paper says.`; }
          } else note = 'Photo kept, not sent. Type what the paper says.';
        }
      } else if (/\.txt$/i.test(file.name) || file.type.startsWith('text/')) { text = await file.text(); }
      else if (S.token) { const buf = new Uint8Array(await file.arrayBuffer()); let bin = ''; for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000)); const r = await api('/api/documents/extract', { method: 'POST', body: JSON.stringify({ fileName: file.name, mime: file.type, dataBase64: btoa(bin) }) }); text = r.text ?? ''; pages = r.pages ?? null; note = r.note ?? ''; textSource = r.textSource ?? 'PHOTO_ONLY'; }
      else note = 'Reading a PDF needs the server (add the access token, menu). Paste or type the text instead.';
    }
    S.flash = note;
    commit({ type: 'DOCUMENT', id, fileName: file?.name ?? 'pasted text', text, pages, claimedType: d.claimed || null, textSource: text ? textSource : (textSource === 'OCR' ? 'OCR' : textSource), photoRef, ocrProvider, summary: 'document added' });
  } catch (e) { S.flash = `The document could not be read (${e.message}). Paste or type its text instead.`; }
  S.busy = ''; render();
}

function supplierText(A) { return A.supplierSheet.items.map((i) => `${i.n}. ${i.en}\n   ${i.zh}`).join('\n\n'); }
// ---- market radar: search from the case, or from a PHOTO of the case. A local barcode read sends no photo; a photo goes to Google Cloud Vision ONLY after an explicit consent card for THAT photo (server checks the consent is bound to its sha-256).
let marketPending = null; // { i, up }: the downscaled photo held in memory while the owner decides; never stored in the case
const marketStatusOnce = async () => { if (S.marketStatus) return S.marketStatus; try { S.marketStatus = await api('/api/market/status'); } catch { S.marketStatus = { enabled: false, photoIdentification: { enabled: false } }; } return S.marketStatus; };
async function marketSearch({ identification = null, photo = null }) { // paid search through the server (credentials stay there); one at a time; a failure never touches the case
  if (S.marketBusy) return; const c = cur(); const input = buildSearchInput(c, buildProductHypothesis(c)); const q = c.quotes?.at(-1); const sp = q && q.unitPrice !== undefined && q.unitPrice !== '' ? Number(String(q.unitPrice).replace(',', '.')) : NaN;
  S.marketBusy = true; S.flash = ''; render();
  try {
    const r = await api('/api/market/search', { method: 'POST', body: JSON.stringify({ input: { name: input.name, brand: input.brand, model: input.model, manufacturerRef: input.manufacturerRef, gtin: input.gtin, traits: input.traits, category: input.category }, identification, supplier: Number.isFinite(sp) ? { price: sp, currency: q.currency ?? null } : null, country: 'BE' }) });
    commit({ type: 'MARKET_SEARCH', status: 'DONE', provider: r.provider, input, outgoing: outgoingFields(input), consent: true, evidence: r.stored, note: null, radar: { market: r.market, queries: r.queries, summary: r.summary, reference: r.reference, comparison: r.comparison, marketplaces: r.marketplaces, observedAt: r.observedAt, cached: r.cached, partial: r.partial, cost: r.cost, notes: r.notes, identification: r.identification ? { ...r.identification, photo } : null } });
    S.flash = r.cached ? 'Résultat déjà obtenu récemment : aucune nouvelle recherche n’a été payée.' : '';
  } catch (e) { S.flash = e.body?.message ?? (e.status ? `La recherche a échoué (${e.status}). Rien n’a été modifié.` : 'Pas de connexion au serveur : la recherche n’a pas eu lieu et rien n’a été perdu. Réessayez avec du réseau.'); }
  finally { S.marketBusy = false; render(); }
}
async function marketPhotoStart(i) {
  const c = cur(); const url = getBlob(`photo:${c.id}.${i}`); if (!url) { S.flash = 'Cette photo est introuvable sur ce téléphone.'; return render(); }
  S.flash = ''; marketPending = null; S.marketPhoto = { i, stage: 'scanning' }; render();
  const bc = await detectBarcode(url); // on the phone: no network, no photo sent
  if (bc) { const identification = { source: 'LOCAL_BARCODE', eans: [bc.gtin], engine: bc.engine, format: bc.format }; S.marketPhoto = { i, stage: 'searching', ident: identification }; render(); await marketSearch({ identification, photo: { index: i, sentToProvider: false } }); S.marketPhoto = { i, stage: 'done' }; return render(); }
  const st = await marketStatusOnce();
  if (!st.photoIdentification?.enabled) { S.marketPhoto = { i, stage: 'no-code', reason: st.photoIdentification?.reason ?? null }; return render(); }
  try { const up = await prepareForUpload(url); marketPending = { i, up }; S.marketPhoto = { i, stage: 'consent', sha256: up.sha256, bytes: up.bytes, width: up.width, height: up.height, estimate: st.photoIdentification.estimatedCostPerPhotoUsd }; }
  catch { S.marketPhoto = { i, stage: 'error', msg: 'Cette photo n’a pas pu être préparée. Rien n’a été envoyé.' }; }
  render();
}
async function marketPhotoSend() {
  const m = S.marketPhoto; if (!marketPending || m?.stage !== 'consent') return; const { i, up } = marketPending; S.marketPhoto = { ...m, stage: 'sending' }; render();
  try {
    const res = await api('/api/market/identify', { method: 'POST', body: JSON.stringify({ imageBase64: up.imageBase64, mime: up.mime, consent: { accepted: true, sha256: up.sha256 } }) }); marketPending = null; // the bytes are dropped as soon as the answer is in
    const ident = res.identification; const photo = { index: i, sentToProvider: true, consentAt: res.consent?.at ?? null, sha256: res.consent?.sha256 ?? up.sha256, provider: res.consent?.provider ?? 'google-cloud-vision' };
    if (ident.confidence === 'HIGH' || ident.confidence === 'MEDIUM') { S.marketPhoto = { i, stage: 'searching', ident, photo }; render(); await marketSearch({ identification: ident, photo }); S.marketPhoto = { i, stage: 'done' }; }
    else if (ident.confidence === 'LOW') S.marketPhoto = { i, stage: 'confirm', ident, photo };
    else S.marketPhoto = { i, stage: 'none' };
  } catch (e) { marketPending = null; S.marketPhoto = { i, stage: 'error', msg: e.body?.message ?? (e.status ? `L’analyse a échoué (${e.status}).` : 'Pas de connexion au serveur : la photo n’a pas été envoyée.') }; }
  render();
}
async function marketPhotoGo() { const m = S.marketPhoto; if (m?.stage !== 'confirm') return; S.marketPhoto = { i: m.i, stage: 'searching', ident: m.ident }; render(); await marketSearch({ identification: m.ident, photo: m.photo }); S.marketPhoto = { i: m.i, stage: 'done' }; render(); }

function setMode(m) { if (!LEGACY_UI) { closeOverlay(); S.flash = ''; if (m === 'field') return salon().openEmbedded('live'); if (m === 'expert') return salon().openEmbedded('decision'); return salon().goHome(); } S.mode = m; S.returnMode = null; S.attach = false; S.sheet = null; ls.set('nordla.sourcing.mode', m); closeOverlay(); S.flash = ''; render(); window.scrollTo(0, 0); }
/** The supplier-facing screen for a question: the supplier's language BIG (never invented: when there is none the owner is told), the owner's French small. What was shown is remembered. */
function showQuestion(id, lang = 'en') {
  const cx = planContext(cur(), S.A); const q = cx.all.find((x) => x.id === id) ?? cx.plan.questions.find((x) => x.id === id); if (!q || q.audience !== 'SUPPLIER') return; const zh = q.supplier.zh; const o = $('#overlay'); o.hidden = false; o.className = 'show show-sup';
  const en = q.text.en ?? q.supplier.en ?? q.text.fr; const REV = { NATIVE_REVIEWED: '中文 : relue par un locuteur natif', TECHNICAL_ONLY: '中文 : relecture par un locuteur natif à faire', UNREVIEWED: '中文 : non relue par un locuteur natif', MACHINE: '中文 : traduction automatique', UNAVAILABLE: '' };
  const main = lang === 'zh' && zh.text ? `<p class="zh" lang="zh-Hans" style="white-space:pre-wrap">${esc(zh.text)}</p><p class="small muted">${esc(REV[zh.review] ?? '')}</p>` : `<p lang="en" style="white-space:pre-wrap">${esc(en)}</p>`;
  o.innerHTML = `<button class="btn sec" data-act="close-overlay">Fermer</button><div class="show-sup" style="margin-top:16px">${main}</div><p class="small muted" style="margin-top:12px">Pour vous : ${esc(q.text.fr).replace(/\n/g, '<br>')}</p>`;
  commit({ type: 'QUESTION_SHOWN', questionId: id, via: 'SHOWN_TO_SUPPLIER', texts: { en, fr: q.text.fr, zh: zh.text ?? null, zhReview: zh.review, shownAs: lang === 'zh' && zh.text ? 'zh' : 'en' } });
}
const FRIENDLY = [[/needs a correction/i, 'This one needs a correction first: use "Correct".'], [/already rejected/i, 'This one was already rejected.'], [/conflict/i, 'This one contradicts something already in the case: clarify it first.'], [/finished/i, 'This conversation is finished: start a new one.']];
/** Business rules in the engine speak in sentences; the phone shows them as a plain message and keeps everything the owner typed. */
// ---- FIELD VOICE: microphone -> on-device engine -> SPEECH items (speaker UNKNOWN, machine transcription) through the same pipeline as typed text. Audio is never stored or sent (see voice.js). ----
S.voice = { state: 'idle', message: '' }; S.voicePartial = '';
const openConversation = () => (cur()?.conversations ?? []).find((x) => x.status === 'OPEN') ?? null;
const voice = createVoice({
  onChange: ({ state, message }) => { S.voice = { state, message }; if ((state === 'paused' || state === 'idle') && openConversation()) { try { commit({ type: 'TURN_CLOSE', convId: openConversation().id, by: state === 'paused' ? 'PAUSE' : 'STOP' }); return; } catch (e) { console.error(e); } } if (S.mode === 'field' || S.mode === 'salon') render(); },
  onPartial: (t) => { S.voicePartial = t; const e = document.querySelector('.fm-partial'); if (e) { e.textContent = t; e.hidden = !t; } },
  onLevel: (v) => document.querySelector('.fm-mic')?.classList.toggle('on', v),
  onFinal: (x) => { const conv = openConversation(); if (!conv) return; try { commit({ type: 'SPEECH_SEGMENT', convId: conv.id, text: x.text, lang: x.lang, provider: x.provider, version: x.version, segment: x.segment, capture: { sessionId: x.capture.sessionId }, turnConfig: ls.get('nordla.sourcing.turns', null) }); } catch (e) { console.error(e); } },
});
window.nordlaVoice = voice; // diagnostics / tests only (state, pause, resume, stop)
function guarded(fn) { try { return fn(); } catch (e) { S.flash = (FRIENDLY.find(([rx]) => rx.test(e.message)) ?? [null, `This could not be done (${e.message}).`])[1]; return render(); } }
function showUserQuestion(id) {
  const q = (cur().userQuestions ?? []).find((x) => x.id === id); if (!q) return; const v = userQuestionView(q); const o = $('#overlay'); o.hidden = false; o.className = 'show show-sup';
  o.innerHTML = `<button class="btn sec" data-act="close-overlay">Close</button><div class="show-sup" style="margin-top:16px"><p lang="${esc(q.lang === 'zh' ? 'zh-Hans' : q.lang)}">${esc(v.original)}</p>${v.zh && q.lang !== 'zh' ? `<p class="zh" lang="zh-Hans">${esc(v.zh)}</p>` : ''}</div>${v.zh ? '' : `<p class="small muted">${esc(v.zhNote)}</p>`}`;
}
async function onClick(ev) {
  const t = ev.target.closest('[data-act]'); if (!t) return; const act = t.dataset.act; const key = t.dataset.key; const val = t.dataset.val !== undefined ? JSON.parse(t.dataset.val) : undefined;
  if (act.startsWith('sl-')) { if (act === 'sl-menu') return openMenu(); return salon().click(ev, t); }
  if (act === 'mode-salon') return setMode('salon');
  if (!LEGACY_UI && act === 'review-expert') { S.fstep = 'capture'; return salon().openEmbedded('field'); }
  if (!LEGACY_UI && act === 'attach-doc') { S.attach = false; S.flash = ''; return salon().openEmbedded('docs'); }
  if (act === 'ftab') { if (key === 'expert') return setMode('expert'); S.fview = key; S.sheet = null; S.flash = ''; render(); window.scrollTo(0, 0); return; }
  if (act === 'fm-nav') { S.sheet = key === 'talk' ? null : (S.sheet === key ? null : key); S.flash = ''; render(); if (key === 'talk') window.scrollTo(0, document.body.scrollHeight); return; }
  if (act === 'fm-sheet') { S.sheet = key; S.flash = ''; render(); return; }
  if (act === 'fm-sheet-close') { S.sheet = null; render(); return; }
  if (act === 'market-run') return void marketSearch({});
  if (act === 'market-photo') return void marketPhotoStart(Number(key));
  if (act === 'market-photo-send') return void marketPhotoSend();
  if (act === 'market-photo-go') return void marketPhotoGo();
  if (act === 'market-photo-cancel') { marketPending = null; S.marketPhoto = null; S.flash = ''; return render(); }
  if (act === 'vc-start') return void voice.start();
  if (act === 'vc-pause') return void voice.pause();
  if (act === 'vc-resume') return void voice.resume();
  if (act === 'attr-open') { S.attrItem = key; S.sheet = 'speaker'; S.flash = ''; return render(); }
  if (act === 'attr') return guarded(() => { const conv = (cur().conversations ?? []).find((x) => x.items.some((i) => i.id === S.attrItem)); if (conv) commit({ type: 'CONVERSATION_ATTRIBUTE', convId: conv.id, itemId: S.attrItem, speaker: key }); S.sheet = null; S.attrItem = null; render(); });
  if (act === 'fm-start') { S.flash = ''; const startVoice = () => { if (openConversation()) void voice.start(); }; guarded(() => { const typed = document.querySelector('form[data-form="fh-product"] input[name="name"]')?.value?.trim(); if (typed && !cur().identity.workingName) commit({ type: 'NAME', name: typed }); if (!(cur().conversations ?? []).some((x) => x.status === 'OPEN')) commit({ type: 'CONVERSATION_START', supplierRef: cur().supplier?.name ?? null, lang: 'auto' }); else render(); }); startVoice(); return; }
  if (act === 'ask-now') { S.askNow = true; S.flash = ''; return render(); }
  if (act === 'notes-reanalyze-preview') { S.reanalysisTargetId = menuCase()?.id ?? null; S.reanalysisPrompt = true; S.reanalysisMessage = ''; return openMenu(); }
  if (act === 'notes-reanalyze-cancel') { S.reanalysisPrompt = false; S.reanalysisTargetId = null; return openMenu(); }
  if (act === 'notes-reanalyze-apply') return applyLegacyReanalysis({ S, menuCase, persist, commit, openMenu });
  if (act === 'fm-menu') return openMenu();
  if (act === 'fm-ask') { S.askId = key; S.sheet = 'ask'; S.flash = ''; return render(); }
  if (act === 'fm-end') { await voice.stop(); return guarded(() => { const conv = (cur().conversations ?? []).find((x) => x.status === 'OPEN'); S.sheet = 'end'; S.flash = ''; if (conv) commit({ type: 'CONVERSATION_FINISH', convId: conv.id }); else render(); }); }
  if (act === 'show-q-zh') return showQuestion(key, 'zh');
  if (act === 'mode-expert') return setMode('expert'); if (act === 'mode-field') return setMode('field');
  if (act === 'review-expert') { S.mode = 'expert'; S.tab = 'field'; S.fstep = 'capture'; S.returnMode = 'field'; render(); window.scrollTo(0, 0); return; }
  if (act === 'attach-toggle') { S.attach = !S.attach; return render(); }
  if (act === 'attach-doc') { S.mode = 'expert'; S.tab = 'docs'; S.returnMode = 'field'; S.attach = false; S.flash = 'Ajoutez le document ici. La lecture automatique des offres n\'existe pas encore : la photo est gardée comme preuve, tapez l\'essentiel dans la conversation.'; render(); window.scrollTo(0, 0); return; }
  if (act === 'group-edit') { S.groupEdit = !S.groupEdit; return render(); }
  if (act === 'group-confirm' || act === 'claims-confirm') {
    const g = groupUnderstanding(cur(), { locale: 'fr' }); const claims = act === 'claims-confirm'; const list = claims ? g.claims : g.group; if (!list.length) return render();
    return guarded(() => commit({ type: 'CANDIDATES_CONFIRM_BATCH', ids: list.map((x) => x.id), via: claims ? 'CLAIMS' : 'GROUP', shown: (claims ? g.claimRows : g.rows).map((r) => ({ id: r.id, label: r.label, valueText: r.valueText })) }));
  }
  if (act === 'pre-old') return guarded(() => commit({ type: 'CANDIDATE_REJECT', id: key }));
  if (act === 'pre-new' || act === 'pre-ask') return guarded(() => {
    commit({ type: 'CANDIDATE_CONFIRM', id: key }); const cf = (cur().conflicts ?? []).find((x) => x.candidateId === key && x.state === 'OPEN'); if (!cf) return;
    if (act === 'pre-new') commit({ type: 'CONFLICT_RESOLVE', id: cf.id, choice: 'NEW' }); else showQuestion(`conflict:${cf.id}`);
  });
  if (act === 'show-q') return showQuestion(key);
  if (act === 'conflict-ask') return showQuestion(`conflict:${key}`);
  if (act === 'q-skip') { if (S.sheet === 'ask') S.sheet = null; return commit({ type: 'QUESTION_SKIP', questionId: key }); }
  if (act === 'uanswer') { const q = planConversation(cur(), S.A).questions.find((x) => x.id === key); if (!q) return render(); return guarded(() => { for (const e of answerEvents(cur(), q, val)) commit(e); }); }
  if (act === 'fstep') { S.fstep = key; S.flash = ''; render(); window.scrollTo(0, 0); return; }
  if (act === 'conv-start') return commit({ type: 'CONVERSATION_START', supplierRef: cur().supplier?.name ?? null, lang: 'auto' });
  if (act === 'conv-finish') return commit({ type: 'CONVERSATION_FINISH', convId: key });
  if (act === 'fact-correct-open') { S.correctingFact = S.correctingFact === key ? null : key; return render(); }
  if (act === 'cand-correct-open') { S.correcting = S.correcting === key ? null : key; return render(); }
  if (act === 'cand-confirm') return guarded(() => commit({ type: 'CANDIDATE_CONFIRM', id: key }));
  if (act === 'cand-reject') return guarded(() => commit({ type: 'CANDIDATE_REJECT', id: key }));
  if (act === 'conflict-resolve') return guarded(() => commit({ type: 'CONFLICT_RESOLVE', id: key, choice: val }));
  if (act === 'uq-state') return commit({ type: 'QUESTION_STATE', id: key, state: val });
  if (act === 'show-uq') return showUserQuestion(key);
  if (act === 'tab') { S.tab = key; S.flash = ''; render(); $('#screen').focus({ preventScroll: true }); window.scrollTo(0, 0); return; }
  if (act === 'trait') return commit({ type: 'TRAIT', trait: key, value: val });
  if (act === 'place') return commit({ type: 'PLACING', placing: { [key]: val } });
  if (act === 'chan') { const set = new Set(cur().context.channels); if (val) set.add(key); else set.delete(key); if (set.size === 0) { S.flash = 'Pick at least one sales channel.'; return render(); } return commit({ type: 'CONTEXT', context: { channels: [...set] } }); }
  if (act === 'amz') return commit({ type: 'AMAZON', amazon: { restricted: val } });
  if (act === 'cat') return commit({ type: 'CATEGORY', category: key });
  if (act === 'safety') return checkSafety();
  if (act === 'useprice') return commit({ type: 'SALE', sale: { sellingPriceGross: String(Number(key) / 100), vatRatePct: cur().sale?.vatRatePct ?? '21', priceBasis: 'OBSERVED' } });
  if (act === 'show-sup') { supIdx = 0; supAll = false; return showSupplier(); }
  if (act === 'sup-next') { supIdx += 1; return showSupplier(); }
  if (act === 'sup-prev') { supIdx = Math.max(0, supIdx - 1); return showSupplier(); }
  if (act === 'sup-all') { supAll = !supAll; return showSupplier(); }
  if (act === 'what-works') return showCapabilities();
  if (act === 'copy-summary') { try { await navigator.clipboard.writeText(fieldSummaryText(cur(), S.A, { missing: fieldMissing(cur(), planContext(cur(), S.A)) })); S.flash = 'Résumé copié.'; } catch { S.flash = "Copie impossible sur ce navigateur (presse-papiers refusé)."; } return render(); }
  if (act === 'copy-sup') { try { await navigator.clipboard.writeText(supplierText(S.A)); S.flash = 'Copied.'; } catch { S.flash = 'Copy is not available here: use "Show to supplier".'; } return render(); }
  if (act === 'close-overlay') { $('#overlay').hidden = true; $('#overlay').className = ''; return; }
  if (act === 'newcase') { discardDrafts = true; const c = newCase({}); S.cases[c.id] = c; S.currentId = c.id; S.tab = 'case'; persist(); closeOverlay(); return render(); }
  if (act === 'opencase') { if (!S.cases[key]) return; discardDrafts = true; S.currentId = key; S.tab = 'decision'; persist(); closeOverlay(); if (S.mode === 'salon') return salon().openCase(key); return render(); }
  if (act === 'server-copy') return takeServer(key, () => { S.flash = 'Version du serveur reprise. Votre version a été gardée dans « (ma version avant remplacement) ».'; closeOverlay(); render(); });
  if (act === 'keep-both') return keepBoth(key, () => { S.flash = 'Les deux versions sont conservées : le dossier du serveur sous son nom, le vôtre sous « (ma copie) ».'; closeOverlay(); render(); });
  if (act === 'rec-list') return recList();
  if (act === 'rec-toggle') { const r = (S.rec ??= {}); (r.selected ??= {})[key] = t.checked; return openMenu(); }
  if (act === 'rec-go') return recGo();
  if (act === 'rec-keep' || act === 'rec-skip') return recDecide(key, act === 'rec-keep');
  if (act === 'export') { const c = menuCase(); if (!c) return; S.reanalysisMessage = exportCase(c.id); return openMenu(); } // same export as the Salon; its photo count is shown at the top of this screen
  if (act === 'gate-save') { S.token = $('#gate-tok').value.trim(); ls.set('nordla.sourcing.token', S.token); S.authFailed = false; await ping(); if (!S.authFailed) { await checkSafety(); queueSync(); } return render(); }
  if (act === 'gate-offline') { S.offlineChoice = true; ls.set('nordla.sourcing.offlineChoice', true); return render(); }
  if (act === 'fx') return fetchFx();
  if (act === 'cat-confirm') { S.suggestions = []; return commit({ type: 'CATEGORY', category: key }); }
  if (act === 'cat-guess') { S.suggestions = []; return commit({ type: 'CATEGORY', category: key, level: 'AI_SUGGESTED' }); }
  if (act === 'doc-confirm') return commit({ type: 'DOCUMENT_CONFIRM', id: key });
  if (act === 'obs-remove') return commit({ type: 'AMAZON_OBS_REMOVE', index: Number(key) });
  if (act === 'savetoken') { S.token = $('#tok').value.trim(); ls.set('nordla.sourcing.token', S.token); await ping(); closeOverlay(); queueSync(); return render(); }
}
const closeOverlay = () => { const o = $('#overlay'); o.hidden = true; o.className = ''; };
let supIdx = 0; let supAll = false;
function showSupplier() {
  const o = $('#overlay'); o.hidden = false; o.className = 'show show-sup'; const items = S.A.supplierSheet.items; if (supIdx >= items.length) supIdx = 0;
  const one = (i) => `<div class="q-item"><b>${i.n}/${items.length}</b> <span class="pri ${esc(i.priority)}">${esc(i.priority)}</span><div>${esc(i.en)}</div><div class="zh" lang="zh-Hans">${esc(i.zh)}</div></div>`;
  o.innerHTML = `<button class="btn" data-act="close-overlay">Back to Nordla</button> <button class="btn sec" data-act="sup-all">${supAll ? 'One at a time' : 'Show all'}</button><p class="small muted">${esc(S.A.supplierSheet.note.zh)}</p>
  ${supAll ? items.map(one).join('') : (items.length ? one(items[supIdx]) : '<p>No question left: nothing is missing right now.</p>')}
  ${supAll || !items.length ? '' : `<div class="row" style="margin-top:12px"><button class="btn sec" data-act="sup-prev" ${supIdx === 0 ? 'disabled' : ''}>Previous</button><button class="btn" data-act="sup-next" ${supIdx >= items.length - 1 ? 'disabled' : ''}>Next question</button></div>`}
  <p class="small muted">Model numbers, standards, regulation names and units are copied exactly. The Chinese is a fixed phrasebook, not a legal translation.</p>`;
}
function showCapabilities() {
  const sg = getBlob('safety'); const ageDays = sg ? Math.floor((Date.now() - Date.parse(sg.phoneFetchedAt ?? 0)) / 86400000) : null;
  const m = capabilityMatrix({ serverReachable: status().server.state === 'VERIFIED', appCached: S.sw === 'registered' || !!navigator.serviceWorker?.controller, safetyCache: { present: !!sg?.alerts, ageDays }, aiConfigured: S.ai?.enabled === true, aiRegion: S.ai?.region });
  const o = $('#overlay'); o.hidden = false; o.className = 'show';
  o.innerHTML = `<button class="btn sec" data-act="close-overlay">Close</button><h2>What works right now</h2><p class="small muted">${S.online ? 'Your server is reachable.' : 'Your server is NOT reachable: everything marked "works now" still works on this phone.'} Cached data is never shown as LIVE.</p>
  <table>${m.map((f) => `<tr><td>${esc(f.label)}<br><span class="muted small">${esc(f.note)}</span></td><td class="n"><span class="chip t-${f.availableNow ? 'GREEN' : 'RED'}">${f.availableNow ? 'works now' : 'not now'}</span><br><span class="muted small">${esc(f.class.replace(/_/g, ' '))}</span></td></tr>`).join('')}</table>`;
}
// ---- case recovery (explicit, selective, never overwrites) ---------------------------------------------------------------------------------------------------------------------
// Reading is GET only. Nothing recovered is marked as changed, so the automatic sync never pushes it; a later edit is sent with the case's own revision, and the server answers 409 (never overwrites) if that moved on.
async function storePhotos(photos) { for (const [k, v] of Object.entries(photos ?? {})) await putBlob(k, v); }
async function recList() {
  const r = (S.rec = { selected: {}, results: [], pending: [] });
  try { r.list = (await api('/api/cases')).cases ?? []; } catch (e) { r.error = e.status === 401 ? 'Jeton refusé par le serveur.' : 'Le serveur ne répond pas : rien n’a été modifié.'; }
  openMenu();
}
/** Adds what is new, reports what is already here, and queues anything that differs for the owner to decide. */
async function recIngest(items, source) {
  const r = (S.rec ??= {}); r.results ??= []; r.pending ??= [];
  for (const { incoming, photos } of items) {
    const [plan] = planRecovery(S.cases, [incoming]); const name = incoming.identity?.workingName || incoming.id;
    if (plan.status === 'NEW') { const out = applyRecovery(S.cases, incoming, { source }); S.cases = out.cases; await storePhotos(photos); r.results.push(`« ${name} » récupéré.`); }
    else if (plan.status === 'ALREADY_HERE') r.results.push(`« ${name} » est déjà sur ce téléphone, identique : rien à faire.`);
    else if (plan.status === 'ALREADY_KEPT') r.results.push(`« ${name} » : cette copie est déjà gardée sous « ${S.cases[plan.keptAs]?.identity?.workingName ?? plan.keptAs} ».`);
    else { r.pending = r.pending.filter((p) => p.id !== incoming.id); r.pending.push({ id: incoming.id, relation: plan.relation, incoming: plan.incoming, local: plan.local, raw: incoming, photos, source }); }
  }
  persist();
}
async function recGo() {
  const r = S.rec; const ids = Object.keys(r.selected ?? {}).filter((k) => r.selected[k]); r.error = ''; r.results = []; const items = [];
  for (const id of ids) {
    try { const v = validateCase(await api(`/api/cases/${encodeURIComponent(id)}`)); if (!v.ok) { r.results.push(`« ${id} » refusé : ${recoveryError(v.error)}`); continue; } const { photos, note } = await fetchCasePhotos(api, id); items.push({ incoming: v.case, photos }); if (note) r.results.push(`« ${id} » : ${note}`); } // photos: GET only (backup.js)
    catch { r.results.push(`« ${id} » n’a pas pu être lu sur le serveur : rien n’a été modifié.`); }
  }
  await recIngest(items, 'server'); r.selected = {}; openMenu();
}
async function recFile(file) {
  const r = (S.rec ??= { results: [], pending: [] }); r.error = ''; r.results = [];
  if (file.size > MAX_IMPORT_BYTES) { r.error = recoveryError('TOO_BIG'); return openMenu(); }
  const p = parseImportText(await file.text());
  if (!p.ok) r.error = recoveryError(p.error); else await recIngest([{ incoming: p.case, photos: p.photos }], 'file');
  openMenu();
}
async function recDecide(id, keep) {
  const r = S.rec; const p = (r.pending ?? []).find((x) => x.id === id); if (!p) return;
  if (keep) {
    const out = applyRecovery(S.cases, p.raw, { choice: 'keep-both', source: p.source }); S.cases = out.cases;
    const mapped = Object.fromEntries(Object.entries(p.photos ?? {}).map(([k, v]) => [k.replace(`:${p.id}.`, `:${out.id}.`), v])); await storePhotos(mapped);
    r.results.push(`« ${p.incoming.name || id} » : les deux copies sont gardées. Votre copie n’a pas été modifiée.`);
  } else r.results.push(`« ${p.incoming.name || id} » : ignoré, rien n’a changé.`);
  r.pending = r.pending.filter((x) => x.id !== id); persist(); openMenu();
}
/** Réglages et sauvegarde: the one sheet behind "Plus" (see embedded.js). */
function openSettings() { const o = $('#overlay'); o.hidden = false; o.className = 'show'; o.innerHTML = settingsHtml({ S, active: menuCase(), esc }); o.insertAdjacentHTML('beforeend', recoverySection(S.rec, { online: S.online, hasToken: !!S.token, local: S.cases }) + backupSection({ backup: S.backup, online: S.online, hasToken: !!S.token, busy: S.backupBusy, esc }) + corePanel.section(menuCase())); o.firstElementChild?.insertAdjacentHTML('afterend', nxPanel.section()) /* the single Nordla entry, first */; if (S.reanalysisMessage) o.scrollTop = 0; }
function openMenu() {
  if (!LEGACY_UI) return openSettings();
  const o = $('#overlay'); o.hidden = false; o.className = 'show';
  const active = menuCase();
  o.innerHTML = `<button class="btn sec" data-act="close-overlay">Close</button>${active ? `<p class="small"><b>Dossier actif : ${esc(active.identity.workingName || active.id)}</b> — ${esc(active.supplier?.name || 'Fournisseur non renseigné')}</p>` : ''}${S.reanalysisMessage ? `<p class="warn" role="status">${esc(S.reanalysisMessage)}</p>` : ''}<h2>Mode</h2><div class="row"><button class="btn ${S.mode === 'salon' ? '' : 'sec'}" data-act="mode-salon">Nordla (écran principal)</button><button class="btn ${S.mode === 'field' ? '' : 'sec'}" data-act="mode-field">Mode guidé</button><button class="btn ${S.mode === 'expert' ? '' : 'sec'}" data-act="mode-expert">Mode expert</button></div><p class="small muted">Nordla est l'écran principal. Le mode guidé montre seulement la conversation ; le mode expert garde tous les écrans du moteur.</p><h2>Cases</h2><button class="btn" data-act="newcase">New product case</button>${Object.values(S.cases).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).map((c) => `<div class="card"><b>${esc(c.identity.workingName || 'Untitled')}</b> <span class="muted small">${esc(c.supplier.name ?? '')} - ${esc(c.updatedAt.slice(0, 16).replace('T', ' '))} - ${esc(c.decisions.at(-1)?.verdict?.replace(/_/g, ' ') ?? 'no decision yet')}</span><br><button class="btn sec" data-act="opencase" data-key="${esc(c.id)}" style="margin-top:6px">Open</button></div>`).join('')}
  <h2>Server (optional)</h2><p class="small muted">Without it everything works offline on this device. With it: cases are kept on your server, the Safety Gate cache and PDF reading are available.</p><label>Access token<input id="tok" type="password" autocomplete="off" value="${esc(S.token)}"></label><button class="btn" data-act="savetoken" style="margin-top:8px">Save token</button>${Object.keys(S.conflicts ?? {}).map((id) => `<div class="warn"><b>Conflit :</b> ${esc(S.cases[id]?.identity.workingName ?? id)} a été modifié sur un autre appareil. Rien n'a été écrasé.<br><button class="btn" data-act="keep-both" data-key="${esc(id)}" style="margin-top:6px">Garder les deux versions</button> <button class="btn danger" data-act="server-copy" data-key="${esc(id)}" style="margin-top:6px">Prendre la version du serveur (la mienne est gardée en copie)</button></div>`).join('')}<h2>This phone</h2><button class="btn sec" data-act="what-works">What works right now (offline matrix)</button><h2>This case</h2><button class="btn sec" data-act="export">Export as JSON</button><p class="small muted">Pour retrouver les informations oubliées dans des notes créées avant la correction : exportez d'abord ce dossier. La réanalyse n'ajoute que des propositions à confirmer, sans modifier les faits déjà acceptés ou rejetés.</p>${S.reanalysisPrompt ? `<p class="warn">Relire les notes originales du fournisseur dans cette fiche ? Aucun fait ne sera confirmé automatiquement.</p><button class="btn" data-act="notes-reanalyze-apply">Oui, ajouter les propositions</button> <button class="btn sec" data-act="notes-reanalyze-cancel">Annuler</button>` : '<button class="btn sec" data-act="notes-reanalyze-preview">Réanalyser les anciennes notes</button>'}`;
  o.insertAdjacentHTML('beforeend', recoverySection(S.rec, { online: S.online, hasToken: !!S.token, local: S.cases }) + backupSection({ backup: S.backup, online: S.online, hasToken: !!S.token, busy: S.backupBusy, esc }) + corePanel.section(menuCase())); o.firstElementChild?.insertAdjacentHTML('afterend', nxPanel.section()) /* the single Nordla entry, first */;
  if (S.reanalysisMessage) o.scrollTop = 0; // never hide the result below a long case list
}

async function onPhoto(ev) {
  const t = ev.target.closest('input[data-act="photo"]'); if (!t || !t.files[0]) return; const file = t.files[0]; const c = cur();
  try {
    const url = await downscale(file, 640, 0.7); const n = c.identity.photos.length; if (!(await putBlob(`photo:${c.id}.${n}`, url))) S.flash = 'Photo too large for the storage left on this phone: it was not saved.';
    commit({ type: 'PHOTO', ref: `photo-${n}`, note: file.name });
    S.flash = S.mode === 'field' ? 'Photo enregistrée sur ce téléphone comme photo de référence du dossier. Nordla ne reconnaît pas le produit : dites-lui ce que c’est.' : 'Photo saved as EVIDENCE. Nordla does not recognise products by itself: choose what it is below (or in the category list) to confirm it.';
    if (S.token && S.online && S.ai?.enabled) {
      if (window.confirm(`Send this photo to ${S.ai.provider} (${S.ai.region}) to get a category SUGGESTION? Only the photo is sent. Cancel keeps it on this phone.`)) {
        try { const r = await api('/api/ai/describe', { method: 'POST', body: JSON.stringify({ imageBase64: url.split(',')[1], imageMime: 'image/jpeg', consent: true }) }); S.suggestions = r.suggestions ?? []; S.flash = S.suggestions.length ? 'AI SUGGESTED categories below: not a fact until you confirm.' : 'The reader could not tell what it is: choose the category yourself.'; } catch { S.flash = 'The reader could not be reached: choose the category yourself.'; }
      }
    }
    render();
  } catch { S.flash = 'This photo could not be read.'; render(); }
}

(function pairingLink() { const m = /[#&]t=([A-Za-z0-9_-]{24,})/.exec(location.hash); if (!m) return; S.token = m[1]; ls.set('nordla.sourcing.token', S.token); S.authFailed = false; history.replaceState(null, '', location.pathname + location.search); })();
document.addEventListener('input', (ev) => { const t = ev.target; if (t?.matches?.('textarea[data-draft="capture"]') && cur()) { (S.captureDraft ??= {})[cur().id] = t.value; ls.set('nordla.sourcing.capdraft', S.captureDraft); } });
document.addEventListener('click', onClick); document.addEventListener('submit', (ev) => { onSubmit(ev).catch((e) => { console.error(e); discardDrafts = false; S.flash = `This could not be saved (${e?.message ?? e}). What you typed is still in the form: try again.`; render(); }); }); document.addEventListener('change', onPhoto);
document.addEventListener('change', (ev) => { const fi = ev.target.closest?.('input[data-act="rec-file"]'); if (fi) { const f = fi.files?.[0]; fi.value = ''; if (f) recFile(f).catch(() => { (S.rec ??= {}).error = 'Ce fichier n’a pas pu être lu.'; openMenu(); }); return; } const f = ev.target.closest?.('form[data-form]'); if (!f || !['quote', 'costs', 'sale', 'amazon-sale'].includes(f.dataset.form) || !cur()) return; S.quiet = true; try { f.requestSubmit(); } finally { S.quiet = false; } });
$('#btn-cases').addEventListener('click', openMenu);
window.addEventListener('online', ping); window.addEventListener('offline', () => { S.online = false; S.verifiedAt = 0; render(); });
setInterval(() => { try { paintHeader(); } catch { /* ignore */ } }, 15000); // a verification expires: the header must not keep saying VERIFIED
setInterval(() => { if (S.token) ping(); }, 30000); // notice a lost or recovered connection
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').then(() => { S.sw = 'registered'; }).catch((e) => { S.sw = `not registered (${e.message})`; });
window.nordlaSourcing = { state: () => ({ sw: S.sw, online: S.online, token: !!S.token, server: status().server.state, safety: status().safety.state }) };
initStorage().then(async () => { await detectAuth(S); installSignIn({ S, after: () => { render(); if (S.token) ping(); } }); render(); ping(); });
