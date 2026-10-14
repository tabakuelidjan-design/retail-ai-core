// NORDLA TERRAIN: the field loop as ONE flow on the phone, with ONE navigation (bottom bar: Accueil, Fournisseurs, Noter, Visites, Plus). This module is the controller; the numbers come from the core (core/field/*, the same
// files run in the tests and on the server), the HTML from nx.js (the five validated screens) and salon-views.js (the detailed panes it reuses). Everything here works OFFLINE: cases and the workspace live on the phone,
// the server only keeps a copy (and a merge) when it is reachable. No provider is ever called from this screen.
// Rule of this file: a question's state, an answer and a fact's state each live in the CASE (append-only events), never in a second place. The workspace keeps views, comparisons and snapshots only.
import { newCase, dispatch, assess, recordDecision } from '/core/case.js';
import { createFieldEngine } from '/core/field/engine.js';
import { offerDraft, attributeNameEvents } from '/core/field/offer-import.js';
import { classifyCandidates } from '/core/understanding.js';
import { describeConflict, validateCorrection } from '/core/candidate-view.js';
import { planConversation } from '/core/conversation-engine.js';
import { newWorkspace, mergeWorkspaces, listComparisons, removeComparison, setAskState } from '/core/field/workspace.js';
import { sampleState } from '/core/field/external-evidence.js';
import { caseFacts, auditCase, observationsOf, factStatusBoard } from '/core/case-facts.js';
import { MIN_CANDIDATES, MAX_CANDIDATES } from '/core/comparison.js';
import { getBlob, putBlob } from '../storage.js';
import * as V from './salon-views.js';
import * as N from './nx.js';
import { fr } from './salon-fr.js';

const VIEW_KEY = 'nordla.sourcing.salon.view'; const PROFILE_KEY = 'nordla.sourcing.merchantProfile'; const WS_BLOB = 'field-workspace'; const WS_DIRTY = 'nordla.sourcing.wsDirty'; const DRAFT_KEY = 'nordla.sourcing.nxdraft';
const num = (v) => (v === '' || v === undefined || v === null ? null : String(v).replace(',', '.').trim());
const FRIENDLY = [[/who spoke/, 'Dites d\'abord qui a écrit cette ligne (fournisseur ou vous).'], [/needs a correction/, 'Ce chiffre est ambigu : corrigez-le avant de le confirmer.'], [/planned quantity/, 'La quantité doit être un nombre entier supérieur à zéro.'], [/at least one value or some text/, 'Collez un texte ou saisissez au moins une valeur.'], [/text is required|needs some text/, 'Collez un texte.'], [/already rejected/, 'Cette information a déjà été rejetée.'], [/conflict/, 'Cette information contredit quelque chose du dossier : levez d\'abord la contradiction.'], [/finished/, 'Cette conversation est terminée : commencez-en une nouvelle.']];
const friendly = (e) => (/^(Tapez|Utilisez|Valeurs possibles)/.test(String(e?.message ?? '')) ? e.message : (FRIENDLY.find(([rx]) => rx.test(String(e?.message ?? e))) ?? [null, `Impossible (${e?.message ?? e}).`])[1]);
const MAIN_NAV = { home: 'home', new: 'home', suppliers: 'suppliers', case: 'suppliers', review: 'suppliers', capture: 'suppliers', compare: 'suppliers', ask: 'suppliers', negotiate: 'suppliers', changed: 'suppliers', note: 'note', visits: 'visits', more: 'more', sync: 'more' };
const NAV_ITEMS = [['home', 'Accueil', 'home'], ['suppliers', 'Fournisseurs', 'suppliers'], ['note', 'Noter', 'note'], ['visits', 'Visites', 'visits'], ['more', 'Plus', 'more']];
const CONFLICT_FR = { OLD: (l) => l.replace(/^Keep the earlier value/, 'Garder la valeur précédente'), NEW: (l) => l.replace(/^Use the new value/, 'Utiliser la nouvelle valeur') };
const HELP_FR = { MODEL_MISMATCH: 'Vérifiez le modèle exact sur le produit ou sur le papier. Les modèles sont comparés caractère par caractère.', OTHER: 'L\'une des deux valeurs peut concerner un autre cas (par exemple avec votre logo). Demandez au fournisseur si vous hésitez.' };

export function createSalon(ctx) {
  const { S, ls } = ctx;
  let view = ls.get(VIEW_KEY, { name: 'home' }); let selected = (view.selected ?? []).filter((id) => S.cases[id]); let engine = null; let engineProfile = undefined; let ws = getBlob(WS_BLOB) ?? newWorkspace(); let flash = ''; let pending = { photo: null, pdfText: null, pdfName: null };
  let capMode = 'quote'; let correcting = null; let editingFact = null; let showQ = null; let wsTimer = null; const openSecs = new Map();
  let filter = 'all'; let query = ''; let visitFilter = 'open'; let noteMode = view.noteMode ?? 'text'; let speaker = 'supplier'; let answering = null; let panels = {}; let lastNote = null; let confirmingServer = null; let pickFor = null; let voiceAvail = null; let voiceProbe = false;
  if (!MAIN_NAV[view.name] && !['capture', 'review', 'negotiate'].includes(view.name)) view = { name: 'home' };
  // Salon's persisted view can be showing a case different from the global current case. Keep the active case aligned even after restarting the phone app; selection is not an edit.
  if (view.caseId && S.cases[view.caseId] && S.currentId !== view.caseId) { S.currentId = view.caseId; ctx.persist(); }
  const save = () => { ls.set(VIEW_KEY, { ...view, selected, noteMode }); };
  const profile = () => ls.get(PROFILE_KEY, null);
  const eng = () => { const p = profile(); if (!engine || engineProfile !== p) { engine = createFieldEngine({ profile: p, externals: () => ctx.externals(), now: () => new Date() }); engineProfile = p; } return engine; };
  const meaningful = (c) => Boolean(c.identity?.workingName || c.supplier?.name || c.offers?.length || c.quotes?.length || c.notes?.length || c.conversations?.length);
  const allCases = () => Object.values(S.cases).filter(meaningful).sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  const caseOf = (id) => S.cases[id] ?? null;
  const infoOf = (c) => ({ caseId: c.id, title: c.identity?.workingName || c.id, supplier: c.supplier?.name ?? null, sample: sampleState(c), numbers: { price: c.sale?.sellingPriceGross ?? '', target: c.sale?.targetContributionPct ?? '', freight: c.costs?.costs?.freight?.total ?? '', duty: c.customs?.duty?.ratePct ?? '', fx: c.costs?.fx?.rate ?? '', qty: c.context?.plannedQty ?? '', vat: c.sale?.vatRatePct ?? 21 } });
  const photosOf = (c) => (c.identity?.photos ?? []).map((_, i) => getBlob(`photo:${c.id}.${i}`)).filter(Boolean);
  const drafts = () => ls.get(DRAFT_KEY, {}); const draftOf = (k) => drafts()[k] ?? ''; const setDraft = (k, v) => { const d = drafts(); if (v) d[k] = v; else delete d[k]; ls.set(DRAFT_KEY, d); };

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
    touchCase(id); S.currentId = id; ctx.persist(); ctx.markDirty(id); ctx.queueSync();
    try { ws = eng().record(ws, S.cases[id]).ws; saveWs(ws); } catch (e) { console.error(e); }
  };
  const go = (next) => { view = { ...view, ...next }; if (view.caseId && S.cases[view.caseId] && S.currentId !== view.caseId) { S.currentId = view.caseId; ctx.persist(); } save(); flash = ''; remember(); ctx.render(); window.scrollTo(0, 0); };
  const remember = () => { ws = eng().setView(ws, { lastCaseId: view.caseId ?? null, lastComparisonId: view.cmpId ?? null, lastScreen: view.name }); saveWs(ws); };

  // ---- what a case says about its own follow-ups (cached by case + revision: cheap on every render) ------------------------------------------------------------------------------------------------
  const meta = new Map();
  function metaOf(c) {
    const key = `${c.id}|${c.updatedAt}|${(c.questionLog ?? []).length}|${(c.candidates ?? []).length}`; const hit = meta.get(c.id); if (hit?.key === key) return hit.v;
    let waiting = 0; try { const v = eng().caseView(c, ws, ['askNow']); waiting = planConversation(c, v.assessment).questions.filter((q) => q.audience === 'SUPPLIER' && q.state === 'ASKED').length; } catch { waiting = 0; }
    const v = { waiting, pending: (c.candidates ?? []).filter((x) => x.state === 'PROPOSED').length, conflicts: (c.conflicts ?? []).filter((x) => x.state === 'OPEN').length };
    meta.set(c.id, { key, v }); return v;
  }
  const overviewOf = (cases) => { const base = eng().overview(cases, ws); return base.map((o) => { const c = caseOf(o.caseId); const m = metaOf(c); return { ...o, pending: m.pending, conflicts: m.conflicts, waiting: m.waiting, photo: photosOf(c)[0] ?? null }; }); };
  const countsOf = (ov) => ({ toConfirm: ov.reduce((n, o) => n + o.pending, 0), waiting: ov.reduce((n, o) => n + o.waiting, 0), conflicts: ov.reduce((n, o) => n + o.conflicts, 0), cases: { confirm: ov.filter((o) => o.pending).length, waiting: ov.filter((o) => o.waiting).length, conflict: ov.filter((o) => o.conflicts).length } });
  const matches = (o, q) => { const t = q.trim().toLowerCase(); return !t || `${o.supplier ?? ''} ${o.title}`.toLowerCase().includes(t); };
  const filtered = (ov) => ov.filter((o) => matches(o, query) && (filter === 'all' || (filter === 'confirm' && o.pending) || (filter === 'waiting' && o.waiting) || (filter === 'conflict' && o.conflicts)));
  const sync = (caseId = null) => ctx.syncInfo(caseId);

  // ---- questions: the three groups of a case, from the case alone --------------------------------------------------------------------------------------------------------------------------------
  const kindOf = (i) => (i.verify ? 'imp' : i.kind === 'COMPLIANCE_BLOCKER' || i.kind === 'IDENTITY' || i.kind === 'CERTIFICATION' ? 'conf' : ['CONFLICT_PRICE', 'CONFLICT', 'PRICE', 'MOQ', 'INCOTERM'].includes(i.kind) ? 'calc' : 'imp');
  const toQ = (i) => ({ id: i.id, title: V.askTitle(i.kind, i.id, Boolean(i.verify)), tag: V.askTag(i.kind, Boolean(i.verify)), tagKind: kindOf(i), en: i.en, fr: i.fr, zh: i.zh, zhNote: i.zhNote, state: i.state === 'ASKED_NO_ANSWER' ? 'UNANSWERED' : i.state });
  function questionGroups(c, v) {
    const plan = planConversation(c, v.assessment); const active = new Set(v.askNow.items.map((i) => i.id));
    const waiting = plan.questions.filter((q) => q.audience === 'SUPPLIER' && q.state === 'ASKED' && q.source !== 'USER_FREE' && !active.has(q.id)).map((q) => ({ id: q.id, title: q.short?.fr ? q.short.fr.charAt(0).toUpperCase() + q.short.fr.slice(1) : V.askTitle('OTHER', q.id), tag: null, en: q.text?.en ?? q.supplier?.en ?? null, fr: q.text?.fr, zh: q.supplier?.zh?.text ? { text: q.supplier.zh.text } : null, zhNote: null, state: 'ASKED' }));
    const own = (c.userQuestions ?? []).filter((u) => u.state !== 'ANSWERED').map((u) => ({ id: u.id, title: 'Votre question', tag: null, en: u.lang === 'en' ? u.text : null, fr: u.text, zh: null, zhNote: 'Votre question est montrée telle que vous l\'avez écrite : aucune traduction n\'est inventée.', state: u.state === 'ASKED' ? 'ASKED' : 'OPEN' }));
    const last = new Map(); for (const e of c.questionLog ?? []) if (e.kind === 'ANSWERED') last.set(e.questionId, e);
    const items = c.conversations.flatMap((x) => x.items); const titleOf = (qid) => plan.questions.find((q) => q.id === qid)?.short?.fr;
    const answered = [...last.values()].map((e) => { const it = items.find((x) => x.id === e.itemId); const pend = (c.candidates ?? []).filter((k) => k.itemId === e.itemId && k.state === 'PROPOSED').length; return { qid: e.questionId, title: e.questionText ?? (titleOf(e.questionId) ?? e.questionId), excerpt: String(it?.original ?? '').slice(0, 140), pending: pend, at: e.at }; }).sort((a, b) => String(b.at).localeCompare(String(a.at)));
    return { toAsk: v.askNow.items.map(toQ), waiting, own, answered, message: v.askNow.message, chineseNote: v.askNow.chineseNote };
  }
  const questionOf = (c, qid) => { const v = eng().caseView(c, ws, ['askNow']); const g = questionGroups(c, v); return [...g.toAsk, ...g.waiting, ...g.own].find((q) => q.id === qid) ?? null; };

  // ---- proposals read from one note / answer -----------------------------------------------------------------------------------------------------------------------------------------------------------
  const itemCands = (c, itemId) => (c.candidates ?? []).filter((k) => k.itemId === itemId);
  function conflictsOf(c, ids) {
    return (c.conflicts ?? []).filter((x) => x.state === 'OPEN' && ids.has(x.candidateId)).map((x) => { const d = describeConflict(x); const t = fr(d.title) || d.title; return { ...d, title: t, help: x.type === 'MODEL_MISMATCH' ? HELP_FR.MODEL_MISMATCH : HELP_FR.OTHER, choices: d.choices.map((ch) => ({ ...ch, label: CONFLICT_FR[ch.choice](ch.label) })) }; });
  }
  function panelFor(c, itemId, title = null) {
    const cands = itemCands(c, itemId); const ids = new Set(cands.map((k) => k.id)); const group = classifyCandidates(c).group.filter((k) => ids.has(k.id)).map((k) => k.id);
    const open = cands.filter((k) => k.state === 'PROPOSED' || k.state === 'CONFLICT');
    const head = cands.length ? '' : '<p class="nx-hint">Réponse enregistrée. Aucune information chiffrée n\'a été reconnue dans ce texte : elle reste dans le dossier. Vous pouvez saisir une valeur à la main dans l\'onglet « Infos ».</p>';
    return `${head}${N.proposalsHtml({ cands: cands.filter((k) => k.state !== 'CONFLICT'), conflicts: conflictsOf(c, ids), correcting, groupIds: open.length && group.length >= 2 ? group : [], caseId: c.id, title })}`;
  }

  // ---- notes ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
  const whenOf = (at) => { const d = new Date(at); return Number.isNaN(d.getTime()) ? '' : d.toLocaleString('fr-FR', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }); };
  const textOfItem = (it) => (it.original ?? it.derived?.find((d) => d.kind === 'TRANSCRIPTION')?.text ?? '');
  const notesOf = (c, n = 6) => c.conversations.flatMap((x) => x.items.map((it) => ({ ...it, convId: x.id }))).sort((a, b) => String(b.at).localeCompare(String(a.at))).slice(0, n).map((it) => ({ id: it.id, when: whenOf(it.at), who: it.speaker === 'me' ? 'vous' : it.speaker === 'supplier' ? 'le fournisseur' : 'locuteur à préciser', text: textOfItem(it), answers: it.answersQuestion ? (questionTitle(c, it.answersQuestion)) : null }));
  const questionTitle = (c, qid) => { const e = (c.questionLog ?? []).find((x) => x.kind === 'ANSWERED' && x.questionId === qid && x.questionText); return e?.questionText ?? qid; };
  const openConv = (c) => (c.conversations ?? []).find((x) => x.status === 'OPEN') ?? null;
  /** The ONE way a typed note or answer enters a case: ensure an open conversation, then ONE item (speaker: supplier or owner), linked to the question it answers when there is one. */
  function recordNote(id, { text, who = 'supplier', qid = null, qtitle = null }) {
    const t = String(text ?? '').trim(); if (!t) throw new Error('text is required');
    const c0 = must(id); const evs = [];
    if (qid && /^uq-/.test(qid)) { if ((c0.userQuestions ?? []).find((u) => u.id === qid)?.state === 'OPEN') evs.push({ type: 'QUESTION_STATE', id: qid, state: 'ASKED' }); }
    else if (qid) { const st = questionStateOf(c0, qid); if (st !== 'ASKED') evs.push({ type: 'QUESTION_SHOWN', questionId: qid, via: 'ASKED_ORALLY_AND_ANSWERED' }); }
    if (!openConv(c0)) evs.push({ type: 'CONVERSATION_START', supplierRef: c0.supplier?.name ?? null, lang: 'auto' });
    if (evs.length) commit(id, evs);
    const conv = openConv(S.cases[id]); const before = new Set(conv.items.map((x) => x.id));
    commit(id, [{ type: 'CONVERSATION_ITEM', convId: conv.id, speaker: who === 'me' ? 'me' : 'supplier', lang: 'auto', text: t, ...(qid ? { answersQuestion: qid, questionText: qtitle ?? undefined } : {}) }, ...(qid && /^uq-/.test(qid) ? [{ type: 'QUESTION_STATE', id: qid, state: 'ANSWERED' }] : [])]);
    const item = openConv(S.cases[id]).items.find((x) => !before.has(x.id)); return item;
  }
  const questionStateOf = (c, qid) => { try { const v = eng().caseView(c, ws, ['askNow']); return planConversation(c, v.assessment).questions.find((q) => q.id === qid)?.state ?? 'OPEN'; } catch { return 'OPEN'; } };

  // ---- voice: honest availability, never simulated -----------------------------------------------------------------------------------------------------------------------------------------------------
  function probeVoice() {
    if (voiceProbe || !S.token || !S.online) return; voiceProbe = true;
    fetch('/voice/status', { headers: { 'x-sourcing-token': S.token } }).then((r) => r.json()).then((j) => { voiceAvail = j?.available === true ? { ok: true } : { ok: false, why: 'Le modèle de dictée n\'est pas installé sur votre serveur.' }; ctx.render(); }).catch(() => { voiceAvail = { ok: false, why: 'Le serveur ne répond pas : la dictée a besoin de lui au premier lancement.' }; voiceProbe = false; ctx.render(); });
  }
  function voiceModel(c) {
    const vs = S.voice ?? { state: 'idle', message: '' }; const mic = typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getUserMedia;
    const available = mic && voiceAvail?.ok === true; const msg = !mic ? 'Ce navigateur n\'autorise pas le microphone ici.' : voiceAvail === null ? (S.token && S.online ? 'Vérification du serveur…' : 'La dictée a besoin du serveur au premier lancement (téléchargement du modèle).') : voiceAvail.ok ? '' : voiceAvail.why;
    const items = c.conversations.flatMap((x) => x.items.filter((it) => it.modality === 'SPEECH').map((it) => ({ id: it.id, convId: x.id, when: whenOf(it.at), text: textOfItem(it), speaker: it.speaker, unknown: it.speaker === 'unknown' }))).slice(-6).reverse();
    const title = { idle: 'Prêt à écouter', preparing: 'Préparation du micro…', listening: 'Nordla écoute', paused: 'En pause', denied: 'Micro refusé', error: 'Erreur' }[vs.state] ?? 'Prêt à écouter';
    return { available, state: vs.state, title, message: available ? (vs.message || 'Touchez le micro puis parlez normalement.') : msg, items };
  }

  // ---- rendering ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
  function nav() {
    const cur = MAIN_NAV[view.name] ?? 'home';
    return NAV_ITEMS.map(([k, l, i]) => `<button type="button" data-act="sl-nav" data-key="${k}" aria-current="${cur === k}" class="${k === 'note' ? 'nx-navnote' : ''}">${N.ic(i)}<span>${l}</span></button>`).join('');
  }
  function resumeInfo() {
    const v = ws.views; if (!v?.lastScreen || ['home', 'more', 'sync', 'new'].includes(v.lastScreen) || view.name !== 'home') return null; const c = v.lastCaseId ? caseOf(v.lastCaseId) : null; const label = { compare: 'la comparaison', case: 'la fiche', ask: 'les questions', negotiate: 'la négociation', review: 'la relecture', capture: 'la capture', note: 'la note', suppliers: 'la liste', visits: 'les visites' }[v.lastScreen] ?? 'là où vous étiez';
    return v.lastCaseId && !c && !v.lastComparisonId ? null : { label: `${label}${c?.supplier?.name ? ` de ${c.supplier.name}` : ''}`, view: v };
  }
  const takeFlash = () => { const f = flash || S.flash || ''; flash = ''; S.flash = ''; return f; }; // an error raised by the shell (a failed save, a refused file) must be SEEN here too, never swallowed
  function render() {
    const e = eng(); const cases = allCases();
    try {
      const name = view.name;
      if (name === 'home') { const ov = overviewOf(cases); return N.homeHtml({ overview: ov, resume: resumeInfo(), sync: sync(), counts: countsOf(ov), conflicts: Object.keys(S.conflicts ?? {}).length, flash: takeFlash() }); }
      if (name === 'new') return N.newHtml({ flash: takeFlash() });
      if (name === 'suppliers') { const ov = overviewOf(cases); const list = filtered(ov); return N.suppliersHtml({ overview: list, total: ov.length, selected, filter, query, sync: sync(), conflicts: Object.keys(S.conflicts ?? {}).length, counts: countsOf(ov), flash: takeFlash() }); }
      if (name === 'visits') { const ov = overviewOf(cases); return N.visitsHtml({ items: ov, filter: visitFilter, now: Date.now(), sync: sync(), conflicts: Object.keys(S.conflicts ?? {}).length, flash: takeFlash() }); }
      if (name === 'more') return N.moreHtml({ sync: sync(), comparisons: listComparisons(ws), active: caseOf(view.caseId) ?? allCases()[0] ?? null, conflicts: Object.keys(S.conflicts ?? {}).length, serverSet: Boolean(S.token), flash: takeFlash() });
      if (name === 'sync') return N.syncHtml({ versions: ctx.conflictVersions(), confirmingServer, flash: takeFlash() });
      if (name === 'note') return noteScreen(cases);
      if (name === 'capture') { const info = view.caseId && caseOf(view.caseId) ? infoOf(caseOf(view.caseId)) : null; return V.captureHtml({ caseInfo: info, mode: capMode, flash, online: S.online }); }
      if (name === 'review') { const c = caseOf(view.caseId); const oid = view.offerId ?? c?.offers?.at(-1)?.id; if (!c || !oid) return homeFallback(); const d = offerDraft(c, oid); const groupable = classifyCandidates(c).group.filter((x) => x.offerId === oid).map((x) => x.id);
        const conflicts = c.conflicts.filter((x) => x.state === 'OPEN' && c.candidates.some((k) => k.id === x.candidateId && k.offerId === oid)).map((x) => describeConflict(x)); return V.reviewHtml({ draft: d, caseInfo: infoOf(c), groupableIds: groupable, conflicts, unknownNames: d.unknownSpeakers.filter((n) => n !== '(unnamed)'), correcting, flash }); }
      if (name === 'case' || name === 'changed') return ficheScreen(name === 'changed' ? { ...view, tab: 'more', sub: 'changed' } : view);
      if (name === 'ask') return ficheScreen({ ...view, tab: 'ask' });
      if (name === 'negotiate') return ficheScreen({ ...view, tab: 'more', sub: 'neg' });
      if (name === 'compare') {
        const def = view.cmpId ? ws.comparisons[view.cmpId] : null; const ids = (def ? def.caseIds : selected).filter((id) => caseOf(id));
        if (ids.length < MIN_CANDIDATES) { flash = 'Choisissez au moins deux fournisseurs (+) pour comparer.'; view = { ...view, name: 'suppliers' }; return render(); }
        const r = e.compare(ids.map(caseOf), { id: def?.id ?? undefined, asOf: def?.asOf, ws }); return V.compareHtml({ view: r.view, saved: Boolean(ws.comparisons[r.set.id]), flash }).replace("data-act=\"sl-nav\" data-key=\"home\"", 'data-act="sl-nav" data-key="suppliers"');
      }
    } catch (err) { console.error(err); return `<div class="nx"><p class="nx-flash">Cet écran n'a pas pu être calculé : ${String(err.message ?? err).replace(/[<>&]/g, '')}. Vos données sont enregistrées.</p><button type="button" class="nx-btn pri" data-act="sl-nav" data-key="home">Retour à l'accueil</button></div>`; }
    return homeFallback();
  }
  function homeFallback() { view = { ...view, name: 'home' }; return N.homeHtml({ overview: [], resume: null, sync: sync(), counts: { toConfirm: 0, waiting: 0, conflicts: 0, cases: { confirm: 0, waiting: 0, conflict: 0 } }, flash: takeFlash() }); }

  function ficheScreen(vw) {
    const c = caseOf(vw.caseId); if (!c) { flash = 'Choisissez un fournisseur.'; view = { ...view, name: 'suppliers' }; return render(); }
    const tab = vw.tab ?? 'sum'; const sub = vw.sub ?? null; const info = infoOf(c); 
    const v = eng().caseView(c, ws); const m = metaOf(c); const groups = questionGroups(c, v);
    const panelMap = {}; for (const [qid, p] of Object.entries(panels)) if (p.caseId === c.id) panelMap[qid] = panelFor(c, p.itemId, 'Ce que Nordla a compris de cette réponse');
    const draftMap = {}; for (const q of [...groups.toAsk, ...groups.waiting, ...groups.own]) draftMap[q.id] = draftOf(`ans:${q.id}`);
    const questionsHtml = N.questionsPane({ info, groups, answering, panels: panelMap, drafts: draftMap, ownDraft: draftOf('ownq') });
    const proposedAll = (c.candidates ?? []).filter((k) => k.state === 'PROPOSED'); const ids = new Set((c.candidates ?? []).map((k) => k.id));
    const factsView = { facts: { facts: caseFacts(c), audit: auditCase(c), observations: observationsOf(c), editing: editingFact, caseId: c.id, board: [], correcting }, cands: proposedAll, conflicts: conflictsOf(c, ids), correcting, history: eng().suppliers(allCases(), ws).find((h) => h.cases.some((x) => x.caseId === c.id)) ?? null };
    const sc = sync(c.id);
    return N.ficheHtml({ info, v, tab, sub, flash: takeFlash(), sync: { ...sc, caseKind: sc.caseKind, caseLabel: sc.caseLabel }, conflicts: Object.keys(S.conflicts ?? {}).length, photos: photosOf(c), questionsHtml, factsView, board: [], lastNotes: notesOf(c, 2), counts: { toConfirm: m.pending, waiting: m.waiting, conflicts: m.conflicts }, negotiation: v.negotiation });
  }

  function noteScreen(cases) {
    let id = view.caseId && caseOf(view.caseId) ? view.caseId : lastCaseId();
    if (!id) { flash = 'Créez d\'abord un fournisseur : un nom suffit.'; view = { ...view, name: 'new' }; return render(); }
    const c = caseOf(id); const info = infoOf(c); if (view.caseId !== id) view = { ...view, caseId: id };
    const prop = lastNote && lastNote.caseId === id ? panelFor(c, lastNote.itemId, 'Ce que Nordla a compris de cette note') : '';
    const more = (() => { const others = metaOf(c).pending - (lastNote ? itemCands(c, lastNote.itemId).filter((k) => k.state === 'PROPOSED').length : 0); return others > 0 ? `<p class="nx-hint">${others} autre${others > 1 ? 's' : ''} information${others > 1 ? 's' : ''} proposée${others > 1 ? 's' : ''} sur ce dossier : ${V.btn('Voir dans la fiche', 'sl-open-fact-tab', id, '', 'ghost')}</p>` : ''; })();
    if (noteMode === 'voice') probeVoice();
    return N.noteHtml({ info, mode: noteMode, flash: takeFlash(), speaker, draft: draftOf(`note:${id}`), proposals: `${prop}${more}`, notes: notesOf(c, 4), photos: photosOf(c), voice: voiceModel(c), online: S.online, conflicts: Object.keys(S.conflicts ?? {}).length });
  }
  function paint() { const main = document.querySelector('#screen'); for (const d of main.querySelectorAll('details[data-sec]')) if (openSecs.has(d.dataset.sec)) d.open = openSecs.get(d.dataset.sec); }
  document.addEventListener('toggle', (ev) => { const d = ev.target; if (d?.matches?.('details[data-sec]')) openSecs.set(d.dataset.sec, d.open); }, true);
  // live search: only the list is replaced, so the keyboard and the caret stay where they are; drafts of notes and answers are saved as they are typed (a call, a lock screen or a reload never loses them)
  document.addEventListener('input', (ev) => {
    const t = ev.target; if (!t?.matches) return;
    if (t.matches('input[data-nx-search]')) { query = t.value; const list = document.querySelector('#nx-list'); if (list) list.innerHTML = N.supplierCards(filtered(overviewOf(allCases())), selected); }
    else if (t.matches('textarea[data-nx-draft], input[data-nx-draft]')) setDraft(t.dataset.nxDraft, t.value);
  });

  // ---- actions --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
  const reveal = (sel) => requestAnimationFrame(() => document.querySelector(sel)?.scrollIntoView({ block: 'start' }));
  const must = (id) => { const c = caseOf(id); if (!c) throw new Error('unknown case'); return c; };
  const lastCaseId = () => view.caseId && caseOf(view.caseId) ? view.caseId : (ws.views.lastCaseId && caseOf(ws.views.lastCaseId) ? ws.views.lastCaseId : allCases()[0]?.id ?? null);
  async function click(ev, t) {
    const act = t.dataset.act; const key = t.dataset.key; const val = t.dataset.val !== undefined ? JSON.parse(t.dataset.val) : undefined; const cid = t.dataset.case ?? key;
    try {
      switch (act) {
        case 'sl-nav': {
          if (key === 'home') return go({ name: 'home', caseId: null, offerId: null });
          if (key === 'suppliers') { pickFor = null; return go({ name: 'suppliers' }); }
          if (key === 'new') return go({ name: 'new' });
          if (key === 'visits') return go({ name: 'visits' });
          if (key === 'more') return go({ name: 'more' });
          if (key === 'sync') { confirmingServer = null; return go({ name: 'sync' }); }
          if (key === 'note') { const id = lastCaseId(); if (!id) { flash = 'Créez d\'abord un fournisseur : un nom suffit.'; return go({ name: 'new' }); } noteMode = 'text'; return go({ name: 'note', caseId: id }); }
          if (key === 'capture') { capMode = 'quote'; return go({ name: 'capture', caseId: null }); }
          if (key === 'compare') { const last = ws.views.lastComparisonId && ws.comparisons[ws.views.lastComparisonId] ? ws.views.lastComparisonId : null; if (selected.length >= MIN_CANDIDATES) return go({ name: 'compare', cmpId: null }); if (last) return go({ name: 'compare', cmpId: last }); flash = 'Choisissez au moins deux fournisseurs (+) pour comparer.'; return go({ name: 'suppliers' }); }
          const id = lastCaseId(); if (!id) { flash = 'Capturez d\'abord un fournisseur.'; return go({ name: 'new' }); } return go({ name: 'case', caseId: id, tab: key === 'ask' ? 'ask' : 'more', sub: key === 'neg' ? 'neg' : null });
        }
        case 'sl-nav-filter': filter = key; query = ''; return go({ name: 'suppliers' });
        case 'sl-filter': filter = key; return ctx.render();
        case 'sl-visit-filter': visitFilter = key; return ctx.render();
        case 'sl-resume': { const v = ws.views; const name = v.lastScreen === 'review' ? 'case' : v.lastScreen; return go({ name, caseId: v.lastCaseId, cmpId: v.lastScreen === 'compare' ? v.lastComparisonId : null }); }
        case 'sl-open-case': { editingFact = null; if (pickFor === 'note') { pickFor = null; noteMode = 'text'; return go({ name: 'note', caseId: key }); } return go({ name: 'case', caseId: key, tab: 'sum', sub: null }); }
        case 'sl-open-fact-tab': return go({ name: 'case', caseId: key, tab: 'facts', sub: null });
        case 'sl-open-fact': editingFact = key; return go({ name: 'case', caseId: view.caseId, tab: 'facts', sub: null });
        case 'sl-fact-edit': editingFact = editingFact === key ? null : key; return ctx.render();
        case 'sl-fact-revert': { const c = must(view.caseId); commit(c.id, [{ type: 'FACT_REVERT', ledgerId: key, mode: 'salon', reason: 'correction annulée par le propriétaire' }]); flash = 'Correction annulée : l\'historique est conservé.'; return ctx.render(); }
        case 'sl-obs-accept': { const c = must(view.caseId); commit(c.id, [{ type: 'FACT_ACCEPT', observationId: key, mode: 'salon' }]); return ctx.render(); }
        case 'sl-case-tab': view = { ...view, name: view.name === 'review' ? 'case' : view.name === 'ask' || view.name === 'negotiate' || view.name === 'changed' ? 'case' : view.name, tab: key, sub: null }; save(); remember(); ctx.render(); return window.scrollTo(0, 0);
        case 'sl-more-open': view = { ...view, name: 'case', tab: 'more', sub: key || null }; save(); ctx.render(); return window.scrollTo(0, 0);
        case 'sl-sel': { selected = selected.includes(key) ? selected.filter((x) => x !== key) : [...selected, key].slice(-MAX_CANDIDATES); save(); return ctx.render(); }
        case 'sl-compare': { const def = key ? ws.comparisons[key] : null; if (def) { selected = def.caseIds.slice(); return go({ name: 'compare', cmpId: key }); } return go({ name: 'compare', cmpId: null }); }
        case 'sl-save-cmp': { const ids = (view.cmpId ? ws.comparisons[view.cmpId]?.caseIds : selected) ?? []; const r = eng().compare(ids.map(caseOf), { ws }); saveWs(eng().saveComparison(ws, r.set, r.view)); view = { ...view, cmpId: r.set.id }; save(); flash = 'Comparaison enregistrée sur ce téléphone.'; return ctx.render(); }
        case 'sl-del-cmp': saveWs(removeComparison(ws, key, new Date())); return ctx.render();
        case 'sl-ask': { const id = key || lastCaseId(); if (!id) { flash = 'Créez d\'abord un fournisseur : un nom suffit.'; return go({ name: 'new' }); } return go({ name: 'case', caseId: id, tab: 'ask', sub: null }); }
        case 'sl-neg': return go({ name: 'case', caseId: cid, tab: 'more', sub: 'neg' });
        case 'sl-review': return go({ name: 'review', caseId: key, offerId: must(key).offers.at(-1)?.id ?? null });
        case 'sl-update-offer': capMode = 'quote'; return go({ name: 'capture', caseId: key });
        case 'sl-cap-mode': capMode = key; return ctx.render();
        case 'sl-confirm': { const c = must(view.caseId); commit(c.id, [{ type: 'CANDIDATE_CONFIRM', id: key }]); correcting = null; return ctx.render(); }
        case 'sl-reject': commit(view.caseId, [{ type: 'CANDIDATE_REJECT', id: key }]); return ctx.render();
        case 'sl-correct-open': correcting = correcting === key ? null : key; return ctx.render();
        case 'sl-confirm-all': { const c = must(view.caseId); const ids = classifyCandidates(c).group.filter((x) => x.offerId === key).map((x) => x.id); if (ids.length) commit(c.id, [{ type: 'CANDIDATES_CONFIRM_BATCH', ids, via: 'GROUP', shown: ids.map((id) => ({ id })) }]); return ctx.render(); }
        case 'sl-confirm-note': { const c = must(key); const ok = new Set(classifyCandidates(c).group.map((x) => x.id)); const ids = (val ?? []).filter((id) => ok.has(id)); if (ids.length) commit(c.id, [{ type: 'CANDIDATES_CONFIRM_BATCH', ids, via: 'GROUP', shown: ids.map((id) => ({ id })) }]); return ctx.render(); }
        case 'sl-resolve': commit(view.caseId, [{ type: 'CONFLICT_RESOLVE', id: key, choice: val }]); return ctx.render();
        case 'sl-attr': { const c = must(view.caseId); const evs = attributeNameEvents(c, view.offerId ?? c.offers.at(-1).id, key, val); if (evs.length) commit(c.id, evs); return ctx.render(); }
        case 'sl-attr-item': { const c = must(view.caseId); const conv = c.conversations.find((x) => x.items.some((i) => i.id === key)); if (conv) commit(c.id, [{ type: 'CONVERSATION_ATTRIBUTE', convId: conv.id, itemId: key, speaker: val }]); return ctx.render(); }
        // QUESTIONS: show -> answer right there. "Posée" is a fact of the case (QUESTION_SHOWN), never a button state in a second place.
        case 'sl-show': showQ = { id: key, caseId: cid }; return ctx.render();
        case 'sl-show-close': showQ = null; return ctx.render();
        case 'sl-asked-answer': { const c = must(cid); const q = questionOf(c, key); if (q && q.state === 'OPEN') commit(c.id, [/^uq-/.test(key) ? { type: 'QUESTION_STATE', id: key, state: 'ASKED' } : { type: 'QUESTION_SHOWN', questionId: key, via: 'SHOWN_TO_SUPPLIER', texts: { en: q.en ?? null, fr: q.fr ?? null, zh: q.zh?.text ?? null } }]); showQ = null; answering = key; return go({ name: 'case', caseId: cid, tab: 'ask', sub: null }); }
        case 'sl-answer-open': answering = key; return ctx.render();
        case 'sl-answer-close': answering = null; return ctx.render();
        case 'sl-q-skip': { const c = must(cid); if (/^uq-/.test(key)) commit(c.id, [{ type: 'QUESTION_STATE', id: key, state: 'ANSWERED' }]); else commit(c.id, [{ type: 'QUESTION_SKIP', questionId: key }]); return ctx.render(); }
        case 'sl-ask-state': { const c = must(cid); ws = setAskState(ws, c.id, key, val, new Date()); if (val === 'ASKED') commit(c.id, [{ type: 'QUESTION_SHOWN', questionId: key, via: 'SHOWN_TO_SUPPLIER' }]); else if (val === 'SKIPPED') commit(c.id, [{ type: 'QUESTION_SKIP', questionId: key }]); saveWs(ws); return ctx.render(); }
        case 'sl-copy': { const it = eng().caseView(must(cid), ws, ['askNow']).askNow.items.find((i) => i.id === key); if (!it) return undefined; let ok = false; try { await navigator.clipboard.writeText(V.askCopyText(it)); ok = true; } catch { /* clipboard refused or unavailable */ } flash = ok ? 'Copié : anglais et chinois.' : 'Copie impossible ici : utilisez « Montrer » pour faire lire le fournisseur.'; return ctx.render(); }
        // NOTES
        case 'sl-note-open': { const id = key || lastCaseId(); if (!id) { flash = 'Créez d\'abord un fournisseur : un nom suffit.'; return go({ name: 'new' }); } noteMode = 'text'; lastNote = null; return go({ name: 'note', caseId: id }); }
        case 'sl-note-change': pickFor = 'note'; flash = 'Choisissez le fournisseur concerné par la note.'; return go({ name: 'suppliers' });
        case 'sl-note-close': return go({ name: caseOf(key) ? 'case' : 'home', caseId: caseOf(key) ? key : null, tab: 'sum', sub: null });
        case 'sl-note-mode': noteMode = key; save(); return ctx.render();
        case 'sl-note-speaker': speaker = key; return ctx.render();
        case 'sl-voice-start': { const v = ctx.voice(); const c = must(view.caseId); if (!openConv(c)) commit(c.id, [{ type: 'CONVERSATION_START', supplierRef: c.supplier?.name ?? null, lang: 'auto' }]); await (v.state === 'paused' ? v.resume() : v.start()); return ctx.render(); }
        case 'sl-voice-pause': await ctx.voice().pause(); return ctx.render();
        case 'sl-voice-stop': await ctx.voice().stop(); return ctx.render();
        case 'sl-sample': commit(key, [{ type: 'SAMPLE_RECORD', ...val }]); return ctx.render();
        case 'sl-expert': { S.currentId = key; ctx.persist(); return ctx.setMode(val); }
        case 'sl-mode': return ctx.setMode(key);
        // SYNC, BACKUP
        case 'sl-conf-keep': return ctx.keepBoth(key, () => { flash = 'Les deux versions sont conservées : le dossier du serveur sous son nom, le vôtre sous « (ma copie) ».'; }).then(() => go({ name: Object.keys(S.conflicts ?? {}).length ? 'sync' : 'suppliers' }));
        case 'sl-conf-server': confirmingServer = key || null; return ctx.render();
        case 'sl-conf-server-go': return ctx.takeServer(key, () => { flash = 'Version du serveur reprise. Votre version a été gardée dans « (ma version avant remplacement) ».'; }).then(() => { confirmingServer = null; return go({ name: Object.keys(S.conflicts ?? {}).length ? 'sync' : 'suppliers' }); });
        case 'sl-sync-now': { flash = await ctx.syncNow(); return ctx.render(); }
        case 'sl-export': { flash = ctx.exportCase(key); return ctx.render(); }
        case 'sl-server': return ctx.openMenu();
        case 'sl-recover': return ctx.openMenu();
        case 'sl-capabilities': return ctx.capabilities();
        default: return undefined;
      }
    } catch (e) { flash = friendly(e); ctx.render(); }
    return undefined;
  }

  function submit(form, d) {
    const name = form.dataset.form;
    try {
      if (name === 'sl-search') { query = String(d.q ?? ''); filter = 'all'; return go({ name: 'suppliers' }); }
      if (name === 'sl-new') {
        const supplier = String(d.supplier ?? '').trim(); const product = String(d.product ?? '').trim(); if (!supplier && !product) { flash = 'Dites au moins un nom de fournisseur ou un produit.'; return ctx.render(); }
        const c = newCase({ name: product }); S.cases[c.id] = c; const evs = []; if (product) evs.push({ type: 'NAME', name: product }); if (supplier) evs.push({ type: 'SUPPLIER', supplier: { name: supplier } }); commit(c.id, evs); noteMode = 'text'; lastNote = null; return go({ name: 'note', caseId: c.id });
      }
      if (name === 'sl-note') {
        const id = d.caseId; const text = String(d.text ?? '').trim(); if (!text) { flash = 'Écrivez ou collez ce que dit le fournisseur.'; return ctx.render(); }
        const item = recordNote(id, { text, who: d.speaker }); setDraft(`note:${id}`, ''); lastNote = { caseId: id, itemId: item.id }; const n = itemCands(S.cases[id], item.id).length; flash = n ? `Note enregistrée. ${n} information${n > 1 ? 's' : ''} proposée${n > 1 ? 's' : ''} : rien n'est encore confirmé.` : 'Note enregistrée. Aucune information chiffrée reconnue : le texte est gardé tel quel.'; ctx.render(); return reveal('.nx-props, .nx-flash');
      }
      if (name === 'sl-answer') {
        const id = d.caseId; const text = String(d.text ?? '').trim(); if (!text) { flash = 'Notez la réponse du fournisseur.'; return ctx.render(); }
        const item = recordNote(id, { text, who: 'supplier', qid: d.qid, qtitle: d.qtitle }); setDraft(`ans:${d.qid}`, ''); panels = { ...panels, [d.qid]: { caseId: id, itemId: item.id } }; answering = null;
        const n = itemCands(S.cases[id], item.id).length; flash = n ? `Réponse enregistrée. ${n} information${n > 1 ? 's' : ''} proposée${n > 1 ? 's' : ''} : confirmez, corrigez ou rejetez chacune.` : 'Réponse enregistrée. Aucune information chiffrée reconnue : le texte est gardé tel quel.'; ctx.render(); return reveal('.nx-lead');
      }
      if (name === 'sl-own-q') { const text = String(d.text ?? '').trim(); if (!text) { flash = 'Écrivez votre question.'; return ctx.render(); } commit(d.caseId, [{ type: 'QUESTION_ADD', text, lang: 'auto' }]); setDraft('ownq', ''); flash = 'Question ajoutée.'; return ctx.render(); }
      if (name === 'sl-capture') return capture(d);
      if (name === 'sl-correct') { const c = must(view.caseId); const cand = c.candidates.find((x) => x.id === d.id); const v = validateCorrection(cand.key, d.value, 'fr'); if (!v.ok) { flash = v.error; return ctx.render(); } correcting = null; commit(c.id, [{ type: 'CANDIDATE_CORRECT', id: d.id, value: v.value }]); return ctx.render(); }
      if (name === 'sl-fact') { const c = must(d.caseId); commit(c.id, [{ type: 'FACT_CORRECT', factType: d.factType, value: d.value, mode: 'salon' }]); editingFact = null; flash = 'Valeur enregistrée : l\'ancienne reste dans l\'historique.'; return ctx.render(); }
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
    const t = ev.target.closest?.('input[data-act="sl-photo"], input[data-act="sl-pdf"], input[data-act="sl-note-photo"]'); if (!t || !t.files?.[0]) return; const file = t.files[0];
    try {
      if (t.dataset.act === 'sl-note-photo') { // the photo is attached to THIS supplier's case at once: the reference is kept (original name + position), on the phone
        const id = view.caseId; const c = must(id); const n = (c.identity?.photos ?? []).length; const url = await downscale(file, 640, 0.7);
        if (!(await putBlob(`photo:${id}.${n}`, url))) { flash = 'La photo n\'a pas pu être gardée sur ce téléphone (stockage plein ?). Exportez le dossier, puis libérez de la place.'; return ctx.render(); }
        commit(id, [{ type: 'PHOTO', ref: `photo-${n}`, note: file.name }]); t.value = ''; flash = `Photo ${n + 1} enregistrée dans le dossier de ${c.supplier?.name ?? c.identity?.workingName ?? 'ce fournisseur'}.`; return ctx.render();
      }
      if (t.dataset.act === 'sl-photo') { pending.photo = { url: await downscale(file, 640, 0.7), name: file.name }; flash = 'Photo prête : elle sera gardée sur ce téléphone comme référence.'; return ctx.render(); }
      let text = ''; if (/\.txt$/i.test(file.name) || file.type.startsWith('text/')) text = await file.text();
      else if (S.token && S.online) { const buf = new Uint8Array(await file.arrayBuffer()); let bin = ''; for (const b of buf) bin += String.fromCharCode(b); const r = await fetch('/api/documents/extract', { method: 'POST', headers: { 'x-sourcing-token': S.token, 'content-type': 'application/json' }, body: JSON.stringify({ fileName: file.name, mime: file.type, dataBase64: btoa(bin) }) }); const j = await r.json(); text = j.text ?? ''; if (!text) { flash = j.note ?? 'Aucun texte lisible dans ce PDF. Collez le texte ou saisissez à la main.'; return ctx.render(); } }
      else { flash = 'Hors ligne : un PDF ne peut pas être lu ici. Collez le texte, ou saisissez à la main.'; return ctx.render(); }
      pending.pdfText = text.trim(); pending.pdfName = file.name; const ta = document.querySelector('textarea[name="text"]'); if (ta) ta.value = pending.pdfText; flash = `Texte lu dans ${file.name} (${pending.pdfText.length} caractères). Vérifiez-le puis importez.`; ctx.render(); const ta2 = document.querySelector('textarea[name="text"]'); if (ta2) ta2.value = pending.pdfText;
    } catch { flash = 'Ce fichier n\'a pas pu être lu.'; ctx.render(); }
  }
  document.addEventListener('change', onFile);

  /** The full-screen question the owner shows to the supplier (overlay on top of the Questions tab). */
  const overlayHtml = () => { if (!showQ) return ''; const c = caseOf(showQ.caseId); if (!c) return ''; const q = questionOf(c, showQ.id); return q ? N.showHtml({ item: { id: q.id, caseId: c.id, en: q.en, fr: q.fr, zh: q.zh } }) : ''; };
  const renderWithOverlay = () => `${render()}${overlayHtml()}`;

  return { render: renderWithOverlay, nav, click, submit, paint, syncWs, loadProfile, remember, openCase: (id) => { if (S.cases[id]) go({ name: 'case', caseId: id, tab: 'sum' }); }, state: () => ({ view, selected, wsRev: ws.rev }), workspace: () => ws, engine: eng };
}
