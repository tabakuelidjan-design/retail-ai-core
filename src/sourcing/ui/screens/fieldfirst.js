// FIELD MODE, CONVERSATION FIRST: the real screen, built from the validated fidelity portal V2.1 (docs/fidelity-portal). It is a PROJECTION of the existing engines (P5, topics, context engine,
// suggestion presenter, understanding, provenance): it owns no business rule. The screen is rebuilt from the case at every render; nothing that matters lives only in the DOM.
//   First screen:  the product (photo, name)  ->  "Photographier le produit"  ->  "Démarrer la conversation" (the main action).
//   Conversation: a messaging thread, ONE contextual suggestion at a calm moment (ASK NEXT, English first, French discreet), a banner only for a contradiction, a dock, three entries at the bottom.
//   Everything else is a sheet opened on demand: the end of the conversation, the purchase EVALUATION (flat panel), the grouped confirmation (on demand only), the alerts, writing, adding.
// Provenance is never touched here: ✓ means confirmed BY THE USER (never "verified"), ◌ means the supplier says it (or a machine proposed it) and nobody confirmed it. Documents have their own states.
// VOICE BOUNDARY (nothing is wired): `ENTRY` says which input channels exist. The dock and the thread already have a place for a live audio source (state 'listening') and for derived transcriptions
// and translations (item.derived), so a future audio entry replaces or completes the text entry without rebuilding this screen. No microphone, model or provider is used here.
import { esc, VERDICT_TEXT, coverageBanner } from '../dom.js';
import { S } from '../state.js';
import { caseFacts } from '/core/case-facts.js';
import { currentTextOf } from '/core/provenance.js';
import { getBlob, ls } from '../storage.js';
import { suggestCategories } from '/core/case.js';
import { CATEGORIES } from '/core/taxonomy.js';
import { planContext } from '/core/context-engine.js';
import { isTurnOpen, segmentsOf } from '/core/turns.js';
import { buildSearchInput, outgoingFields } from '/core/market-search.js';
import { buildProductHypothesis } from '/core/product-hypothesis.js';
import { presentSuggestion, normalizeTiming } from '/core/suggestion-presenter.js';
import { groupUnderstanding } from '/core/understanding.js';
import { describeCandidate, describeFact } from '/core/candidate-view.js';
import { existingValue } from '/core/conflicts.js';
import { documentStatusOf } from '/core/provenance.js';

export const ENTRY = Object.freeze({ text: true, voice: true }); // voice = the PRIMARY entry in the field (English only for now); text stays the fallback (« Écrire »)
const I = (d, w = 24, extra = '') => `<svg viewBox="0 0 24 24" width="${w}" height="${w}" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" ${extra}>${d}</svg>`;
const ICON = {
  chat: I('<path d="M4 5h16v11H9l-5 4z"/><path d="M8 9h8M8 12h5"/>'), camera: I('<path d="M4 8h3l2-3h6l2 3h3v11H4z"/><circle cx="12" cy="13" r="3.5"/>'), pencil: I('<path d="M4 20l1-4L16 5l3 3L8 19z"/><path d="M14 7l3 3"/>'),
  bell: I('<path d="M6 17h12l-1.5-2V11a4.5 4.5 0 10-9 0v4L6 17z"/><path d="M10 20a2 2 0 004 0"/>', 26), dots: I('<path d="M5 12h.01M12 12h.01M19 12h.01"/>', 26), bulb: I('<path d="M9 18h6M10 21h4M12 3a6 6 0 00-3.5 10.9c.6.5 1 1.2 1 2v.1h5v-.1c0-.8.4-1.5 1-2A6 6 0 0012 3z"/>', 14),
  chev: I('<path d="M9 6l6 6-6 6"/>', 20), warn: I('<path d="M12 4l9 16H3z"/><path d="M12 10v4M12 17h.01"/>', 22), x: I('<path d="M6 6l12 12M18 6L6 18"/>', 20), stop: '<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="2.5"/></svg>',
  msg: I('<path d="M4 5h16v11H9l-5 4z"/>', 22), tag: I('<path d="M3 12V4h8l9 9-8 8z"/><path d="M7.5 7.5h.01"/>', 17), box: I('<path d="M4 8l8-4 8 4v8l-8 4-8-4z"/><path d="M4 8l8 4 8-4M12 12v8"/>', 17), clock: I('<circle cx="12" cy="12" r="8.5"/><path d="M12 7v5l3 2"/>', 17),
  shield: I('<path d="M12 3l7 3v6c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6z"/><path d="M9 12l2 2 4-4"/>', 17), ship: I('<path d="M3 17l2 3h14l2-3M5 17V9l7-3 7 3v8M12 6V3"/>', 17), cash: I('<rect x="3" y="7" width="18" height="10" rx="2"/><circle cx="12" cy="12" r="2.5"/>', 17), palette: I('<circle cx="12" cy="12" r="8.5"/><path d="M8 11h.01M12 8h.01M16 11h.01"/>', 17), hash: I('<path d="M5 9h14M5 15h14M10 4L8 20M16 4l-2 16"/>', 17),
  check: I('<path d="M5 12.5l4.5 4.5L19 7.5"/>', 12),
  mic: I('<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M6 11a6 6 0 0012 0M12 17v4"/>', 22), pause: I('<path d="M8 6v12M16 6v12"/>', 20),
};
const OK = `<span class="fm-gl ok" title="confirmé par vous">${ICON.check}</span>`; const CL = '<span class="fm-gl cl" title="annoncé par le fournisseur, pas confirmé par vous"></span>';
const person = (bg, fg) => `<svg viewBox="0 0 44 44" width="100%" height="100%" aria-hidden="true"><rect width="44" height="44" fill="${bg}"/><circle cx="22" cy="17" r="7.5" fill="${fg}"/><path d="M7 44c1-10 7-15 15-15s14 5 15 15z" fill="${fg}"/></svg>`;
const AV_SUP = person('#cbd7cf', '#456352'); const AV_ME = person('#d5d2e2', '#4e4a6b'); const AV_UNK = person('#e1ddd8', '#8d8680');
/** The words of an item: the typed original, or the machine TRANSCRIPTION of a spoken one. */
const textOf = (e) => currentTextOf(e); // the owner's correction when there is one (the raw words stay in the case)
const isSpeech = (e) => e.modality === 'SPEECH';
const heardTag = (e) => (isSpeech(e) ? '<span class="fm-d">dicté · transcription automatique</span>' : '');
const EMPTY_PHOTO = `<div class="fm-ph-empty">${I('<path d="M4 8h3l2-3h6l2 3h3v11H4z"/><circle cx="12" cy="13" r="3.5"/>', 34)}<span>Pas de photo</span></div>`;
const NAV = [['talk', 'Conversation', 'chat'], ['add', 'Scanner / Ajouter', 'camera'], ['write', 'Écrire', 'pencil']];
const btn = (label, act, key, cls = 'fm-btn', extra = '') => `<button type="button" class="${cls}" data-act="${act}" ${key !== undefined ? `data-key="${esc(key)}"` : ''} ${extra}>${label}</button>`;
const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);
const showV = (v) => (typeof v === 'object' && v !== null ? JSON.stringify(v) : String(v));
const hhmm = (at) => { const d = new Date(at); return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString('fr-BE', { hour: '2-digit', minute: '2-digit' }); };
const dayLabel = (at) => { const d = new Date(at); if (Number.isNaN(d.getTime())) return ''; const t = new Date(); const same = d.toDateString() === t.toDateString(); return `${same ? "Aujourd'hui" : d.toLocaleDateString('fr-BE', { day: '2-digit', month: '2-digit' })} ${hhmm(at)}`; };

/** The bottom bar (three entries), rendered by app.js into #tabs. */
export const fmNav = () => NAV.map(([k, l, ic]) => `<button type="button" class="fm-nav" data-act="fm-nav" data-key="${k}" aria-current="${(k === 'talk' ? !S.sheet : S.sheet === k) ? 'true' : 'false'}">${ICON[ic].replace(/width="24" height="24"/, 'width="22" height="22"')}<span>${l}</span></button>`).join('');

/** What to show now: the contextual plan + the presenter's decision. The caller keeps `state` between renders (it is not part of the case) and wakes up at `hold.until` / `wake`. */
export function fmCompute(A, c, now = Date.now()) {
  const ctx = planContext(c, A); const prev = S.fmPrev?.caseId === c.id ? S.fmPrev.state : null;
  const composing = S.sheet === 'write'; const explicit = !!S.askNow; S.askNow = false;
  const lastSpeech = ctx.plan.timeline.filter((e) => e.turn && e.segments?.length).map((e) => Date.parse(e.turn.lastSegmentAt ?? e.at)).filter((x) => Number.isFinite(x)).sort((a, b) => a - b).at(-1) ?? null; // speech streams in: the quiet moment is counted from the last segment
  const r = presentSuggestion(prev, ctx, { composing, lastUtteranceAt: S.voice?.state === 'listening' ? lastSpeech : null, explicit }, now, normalizeTiming(ls.get('nordla.sourcing.timing', null)));
  return { ctx, show: r.show, hold: r.hold, wake: r.wake, alerts: r.alerts, state: r.state, explicit };
}

// ---- pieces ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
const convOpen = (c) => (c.conversations ?? []).some((x) => x.status === 'OPEN');
const refPhoto = (c) => { const n = c.identity.photos?.length ?? 0; return n ? getBlob(`photo:${c.id}.${n - 1}`) : null; };
const categoryLabel = (A) => (A.identity.category ? (CATEGORIES[A.identity.category]?.label ?? String(A.identity.category).replace(/_/g, ' ')) : '');

function header(fm) {
  const bad = fm.alerts.length > 0;
  return `<header class="fm-hd"><div class="fm-brand">Nordla<small>China Sourcing</small></div><div class="fm-hd-r">${S.online ? '' : '<span class="fm-off">Hors ligne</span>'}${btn(ICON.dots, 'fm-menu', undefined, 'fm-ic', 'aria-label="Réglages, dossiers, mode expert"')}<button type="button" class="fm-ic fm-bell" data-act="fm-sheet" data-key="alerts" aria-label="Alertes">${ICON.bell}${bad ? '<i></i>' : ''}</button></div></header>`;
}
function productCard(c, A, o) {
  const photo = refPhoto(c); const name = c.identity.workingName || A.identity.category && categoryLabel(A) || ''; const started = (c.conversations ?? []).length > 0;
  const pill = convOpen(c) ? `<span class="fm-pill st">${ICON.check}En discussion</span>` : started ? '<span class="fm-pill">Conversation terminée</span>' : '<span class="fm-pill new">Nouveau</span>';
  const ph = `<div class="fm-ph ${photo ? '' : 'nophoto'}">${photo ? `<img src="${esc(photo)}" alt="Photo de référence du produit">` : EMPTY_PHOTO}${o.hero && photo ? '<i class="fm-ref">Référence</i>' : ''}</div>`;
  const title = c.identity.workingName ? `<h1 class="fm-pt">${esc(c.identity.workingName)}</h1>` : (o.hero ? `<form data-form="fh-product" class="fm-nameform"><input name="name" autocomplete="off" enterkeyhint="done" placeholder="Nommer le produit" aria-label="Nom du produit"><button class="fm-ok" aria-label="Valider le nom">OK</button></form>` : '<h1 class="fm-pt">Produit à nommer</h1>');
  const sub = categoryLabel(A) ? `<p class="fm-ps">${esc(categoryLabel(A))}</p>` : '';
  const inner = `${ph}<div class="fm-pbody">${title}${sub}${pill}</div>${o.tap ? ICON.chev : ''}`;
  return o.tap ? `<div class="fm-prod ${o.mini ? 'mini' : ''} ${o.hero ? 'hero' : ''}" data-act="fm-sheet" data-key="summary" role="button" tabindex="0" aria-label="Ouvrir l'évaluation d'achat">${inner}</div>` : `<div class="fm-prod ${o.mini ? 'mini' : ''} ${o.hero ? 'hero' : ''}">${inner}</div>`;
}
function categoryHint(c, A) {
  if (A.identity.category || !c.identity.workingName) return ''; const sugg = suggestCategories(c.identity.workingName); if (!sugg.length) return '';
  return `<div class="fm-hint">Probablement : <b>${esc(sugg[0].label)}</b> ${btn('Oui', 'cat', sugg[0].id, 'fm-btn fm-small')}</div>`;
}
function bubble(e) {
  const t = hhmm(e.at);
  if (e.kind === 'SUPPLIER') {
    const tr = (e.derived ?? []).filter((d) => d.kind === 'TRANSLATION'); const zh = e.lang === 'zh';
    const derived = tr.length ? tr.map((d) => `<span class="fm-d">${esc((d.lang ?? '').toUpperCase())} · ${esc(d.text)}<em>${d.review === 'MACHINE' ? 'traduction automatique' : esc(d.review ?? '')}</em></span>`).join('') : (zh ? '<span class="fm-d">Pas de traduction disponible</span>' : '');
    return `<div class="fm-row sup"><div class="fm-av">${AV_SUP}</div><div class="fm-stack"><div class="fm-b ${zh ? 'zh' : ''}"><span lang="${zh ? 'zh-Hans' : esc(e.lang ?? 'en')}" class="fm-orig">${esc(textOf(e))}</span>${heardTag(e)}${derived}</div><div class="fm-meta">${t}${isSpeech(e) ? ' · locuteur : le fournisseur (vous l’avez indiqué)' : ''}</div></div></div>`;
  }
  if (e.kind === 'HEARD') { const open = isTurnOpen({ turn: e.turn }, Date.now(), ls.get('nordla.sourcing.turns', null)); const n = segmentsOf({ ...e, id: e.id, modality: 'SPEECH' }).length; return `<div class="fm-row sup heard${open ? ' open' : ''}"><div class="fm-av">${AV_UNK}</div><div class="fm-stack"><div class="fm-b"><span lang="${esc(e.lang ?? 'en')}" class="fm-orig">${esc(textOf(e))}${open ? ' …' : ''}</span><span class="fm-d">${open ? 'en cours · ' : ''}entendu au micro · transcription automatique · locuteur inconnu${n > 1 ? ` · ${n} segments` : ''}</span>${open ? '' : btn('Qui parlait ?', 'attr-open', e.id, 'fm-link')}</div><div class="fm-meta">${t}</div></div></div>`; }
  if (e.kind === 'ME') return `<div class="fm-row me"><div class="fm-stack"><div class="fm-b"><span lang="${esc(e.lang === 'zh' ? 'zh-Hans' : e.lang ?? 'fr')}" class="fm-orig">${esc(textOf(e))}</span>${heardTag(e)}</div><div class="fm-meta">${isSpeech(e) ? 'Moi (vous l’avez indiqué)' : 'Ma note'} · ${t}</div></div><div class="fm-av">${AV_ME}</div></div>`;
  if (e.kind === 'ASKED') { const en = e.texts?.en ?? e.texts?.fr ?? ''; return `<div class="fm-row me"><div class="fm-stack"><div class="fm-b"><span lang="en" class="fm-orig">${esc(en)}</span>${e.texts?.fr && e.texts?.en ? `<span class="fm-d">FR · ${esc(e.texts.fr)}</span>` : ''}</div><div class="fm-meta">Question montrée · ${t}</div></div><div class="fm-av">${AV_ME}</div></div>`; }
  return '';
}
function thread(ctx) {
  const listening = S.voice?.state === 'listening'; const live = listening ? `<div class="fm-partial" aria-live="polite" ${S.voicePartial ? '' : 'hidden'}>${esc(S.voicePartial ?? '')}</div>` : '';
  const tl = ctx.plan.timeline.filter((e) => ['SUPPLIER', 'HEARD', 'ME', 'ASKED'].includes(e.kind)); if (!tl.length) return `<p class="fm-empty">${listening ? 'Nordla écoute. Parlez normalement ; vous pouvez aussi toucher « Écrire ».' : 'Touchez « Écouter », ou « Écrire » pour noter ce que dit le fournisseur.'}</p>${live}`;
  const old = tl.slice(0, Math.max(0, tl.length - 14)); const recent = tl.slice(-14);
  return `<div class="fm-date">${esc(dayLabel(tl[0].at))}</div>${old.length ? `<details class="fm-old"><summary>${old.length} message${old.length > 1 ? 's' : ''} plus ancien${old.length > 1 ? 's' : ''}</summary>${old.map(bubble).join('')}</details>` : ''}${recent.map(bubble).join('')}${live}`;
}
function suggestion(q) {
  const en = q.text.en ?? q.text.fr;
  return `<button type="button" class="fm-sug" data-act="fm-ask" data-key="${esc(q.id)}" data-qid="${esc(q.id)}" data-audience="${esc(q.audience)}" aria-live="polite"><div class="fm-sg"><div class="fm-k">${ICON.bulb}ASK NEXT</div><p class="fm-en" lang="en">${esc(en).replace(/\n/g, '<br>')}</p>${q.text.en ? `<p class="fm-fr">FR — ${esc(q.text.fr.split('\n')[0])}</p>` : ''}${q.repeat ? '<p class="fm-fr">Pas de réponse claire jusqu\'ici : la reposer ?</p>' : ''}</div>${ICON.chev}</button>`;
}
const COST_FR = { originCharges: 'frais au départ', insurance: 'assurance', brokerage: 'courtier / dédouanement', inspection: 'inspection', testing: 'tests', labelling: 'étiquetage', epr: 'REP / emballages', inboundLogistics: 'transport local à l’arrivée' };
/** « N éléments à confirmer » : the facts Nordla detected and the owner has not confirmed yet (what the evaluation does NOT use). One tap opens where they are confirmed. */
function confirmRow(c) {
  const n = proposedCands(c).length; if (!n) return ''; const g = groupUnderstanding(c); const key = g.hasGroup || g.claims.length ? 'understood' : clarifyBlocks(c).length ? 'conflict' : 'summary';
  return `<button type="button" class="fm-conf" data-act="fm-sheet" data-key="${key}"><span class="fm-conf-i">${ICON.clock}</span><span class="fm-conf-t"><b>${n} élément${n > 1 ? 's' : ''} à confirmer</b><small>annoncés, pas encore confirmés par vous</small></span>${ICON.chev}</button>`;
}
function contradictionBar(c) {
  const n = clarifyBlocks(c).length; if (!n) return '';
  return `<button type="button" class="fm-alert" data-act="fm-sheet" data-key="conflict">${ICON.warn}<div class="fm-at"><span>${n > 1 ? `${n} valeurs se contredisent` : 'Une valeur se contredit'}</span><small>Contradiction à clarifier</small></div>${ICON.chev}</button>`;
}
function alertBar(alerts, c) {
  if (!alerts.length) return contradictionBar(c); const a = alerts[0];
  return `<button type="button" class="fm-alert" data-act="fm-sheet" data-key="${a.kind === 'CONFLICT' ? 'conflict' : 'alerts'}">${ICON.warn}<div class="fm-at"><span>${esc(a.text.fr)}</span><small>${a.kind === 'CONFLICT' ? 'Contradiction à clarifier' : a.kind === 'SAFETY' ? 'Alerte de sécurité' : 'Point critique'}${alerts.length > 1 ? ` · +${alerts.length - 1}` : ''}</small></div>${ICON.chev}</button>`;
}
function dock(c, ctx) {
  if (convOpen(c)) { // the dock tells the TRUTH about the microphone: it says « Écoute en cours » only once audio really reaches the engine (voice.js)
    const v = S.voice?.state ?? 'idle'; const msg = esc(S.voice?.message ?? ''); const stop = btn(ICON.stop, 'fm-end', undefined, 'fm-dk stop', 'aria-label="Terminer la conversation"');
    const dk = (variant, icon, title, small, ...buttons) => `<div class="fm-dock" data-variant="${variant}"><span class="fm-dk-ic ${variant === 'listening' ? 'fm-mic' : ''}">${icon}</span><div class="fm-dk-t"><b>${title}</b><small>${small}</small></div>${buttons.join('')}</div>`;
    if (v === 'listening') return dk('listening', ICON.mic, 'Écoute en cours', 'Micro actif · anglais', btn(ICON.pause, 'vc-pause', undefined, 'fm-dk', 'aria-label="Mettre l’écoute en pause"'), stop);
    if (v === 'preparing') return dk('preparing', ICON.mic, 'Préparation…', msg || 'Préparation de la voix…', btn('Annuler', 'vc-pause', undefined, 'fm-dk txt'));
    if (v === 'paused') return dk('paused', ICON.mic, 'Écoute en pause', 'Le micro est coupé', btn('Reprendre', 'vc-resume', undefined, 'fm-dk txt go'), stop);
    if (v === 'denied') return dk('denied', ICON.mic, 'Micro refusé', 'Autorisez-le pour ce site dans le navigateur, ou touchez « Écrire »', btn('Réessayer', 'vc-resume', undefined, 'fm-dk txt go'), stop);
    if (v === 'error') return dk('error', ICON.mic, 'Voix indisponible', msg || 'Touchez « Écrire »', btn('Réessayer', 'vc-resume', undefined, 'fm-dk txt go'), stop);
    return dk('text', ICON.chat, 'Conversation en cours', 'Micro coupé · touchez « Écrire »', btn('Écouter', 'vc-start', undefined, 'fm-dk txt go'), stop);
  }
  if (ctx.plan.timeline.some((e) => ['SUPPLIER', 'HEARD', 'ME'].includes(e.kind))) return `<div class="fm-dock" data-variant="ended"><span class="fm-dk-ic">${ICON.chat}</span><div class="fm-dk-t"><b>Conversation terminée</b><small>Reprendre quand vous voulez</small></div>${btn('Résumé', 'fm-sheet', 'end', 'fm-dk txt')}${btn('Reprendre', 'fm-start', undefined, 'fm-dk txt go')}</div>`;
  return '';
}

// ---- what Nordla understands of the product, and the market (optional) --------------------------------------------------------------------------------------------------------------------
const TRAIT_FR = { 'battery.present': ['contient une batterie', 'sans batterie'], 'radio.present': ['a une fonction radio (Bluetooth, Wi-Fi...)', 'sans radio'], 'electrical.present': ['est un produit électrique', 'n’est pas électrique'], 'electrical.mainsConnected': ['branché sur le secteur', 'pas branché sur le secteur'], foodContact: ['au contact des aliments', 'pas de contact alimentaire'], childrenUse: ['destiné aux enfants', 'pas destiné aux enfants'], 'compatibility.required': ['doit être compatible avec un appareil précis', 'pas de compatibilité à préciser'], 'capacity.relevant': ['une capacité compte', 'la capacité ne compte pas'], customisable: ['personnalisable', 'non personnalisable'], textile: ['textile', 'pas textile'], cosmetic: ['cosmétique', 'pas cosmétique'], ppe: ['équipement de protection', 'pas un équipement de protection'], medical: ['revendication médicale', 'pas de revendication médicale'], chemicalMixture: ['mélange chimique', 'pas un mélange chimique'] };
const STATUS_FR = { PROBABLE: 'probable, d’après le nom', SUGGESTED: 'suggéré par la photo (non confirmé)', SUPPLIER_CLAIMED: 'dit par le fournisseur', CONFIRMED: 'confirmé' };
const SRC_FR = { PRODUCT_NAME: 'nom', IMAGE_OBSERVATION: 'photo', OWNER: 'vous', SUPPLIER_SPEECH: 'fournisseur', DOCUMENT: 'document' };
function productBlock(A) {
  const h = A.productHypothesis; if (!h) return '<p class="fm-empty">Pas encore d’information sur le produit.</p>';
  const cat = h.category.status === 'CONFIRMED' ? `Catégorie : <b>${esc(h.category.label)}</b> (confirmée)` : h.category.status === 'HYPOTHESIS' ? `Catégorie probable : <b>${esc(h.category.best.label)}</b> (non confirmée)` : 'Catégorie : <b>inconnue</b> (Nordla ne force pas un produit dans une catégorie)';
  const known = Object.entries(h.traits).filter(([, t]) => t.known).map(([k, t]) => `<div class="fm-li"><i class="fm-dot ok"></i><span>${esc(cap((TRAIT_FR[k]?.[t.value === false ? 1 : 0]) ?? `${k} = ${t.value}`))} <small>${esc(STATUS_FR[t.status] ?? t.status)}${(() => { const who = [...new Set(t.sources.map((x) => SRC_FR[x.source] ?? x.source))]; return t.status === 'PROBABLE' && who.length === 1 && who[0] === 'nom' ? '' : ` · ${esc(who.join(', '))}`; })()}</small></span></div>`);
  const image = h.sources.find((x) => x.observer === 'image'); const name = h.sources.find((x) => x.observer === 'name-cues');
  const src = `<p class="fm-note">Nom : ${name ? 'analysé' : 'pas encore'} · Photo : ${image ? (image.status === 'PROVIDER_NOT_CONFIGURED' ? 'gardée, <b>non interprétée</b> (aucun service d’analyse d’image n’est configuré ; rien n’est envoyé)' : esc(image.status)) : 'aucune'}.</p>`;
  return `<p class="fm-note">${cat}</p>${known.length ? known.join('') : '<p class="fm-empty">Aucune caractéristique déduite pour l’instant : Nordla posera les questions de base.</p>'}<p class="fm-note">${h.summary.unknown} caractéristique${h.summary.unknown > 1 ? 's' : ''} encore inconnue${h.summary.unknown > 1 ? 's' : ''} : ce n’est pas la même chose que « non applicable ».</p>${src}`;
}
const money2 = (r) => `${r.min === r.max ? r.min.toFixed(2) : `${r.min.toFixed(2)} – ${r.max.toFixed(2)}`} ${r.currency}${r.vatIncluded === null ? ' (TVA ?)' : r.vatIncluded ? ' TTC' : ' HT'}`;
function regionLine(label, b) {
  if (!b.total) return `<p class="fm-note"><b>${label}</b> : aucune annonce observée dans les recherches faites.</p>`;
  const parts = [b.exact ? `${b.exact} correspondance${b.exact > 1 ? 's' : ''} exacte${b.exact > 1 ? 's' : ''}` : 'aucune correspondance exacte vérifiée', b.probable ? `${b.probable} probable${b.probable > 1 ? 's' : ''}` : null, b.similar ? `${b.similar} produit${b.similar > 1 ? 's' : ''} comparable${b.similar > 1 ? 's' : ''}` : null].filter(Boolean);
  return `<p class="fm-note"><b>${label}</b> : ${parts.join(' · ')}.${b.priceRanges.length ? ` Prix observés : ${b.priceRanges.map(money2).join(' ; ')}.` : ''}${b.countries.length > 1 ? ` Pays : ${b.countries.join(', ')}.` : ''}</p>`;
}
function marketBlock(A, withButton = true) {
  const m = A.marketPresence; const body = m?.searched ? `${regionLine('Belgique', m.belgium)}${regionLine('Europe', m.eu)}${m.noMatchFound ? '<p class="fm-note">Aucune correspondance fiable trouvée par cette recherche : cela ne veut <b>pas</b> dire que le produit n’est pas vendu en Europe.</p>' : ''}` : '<p class="fm-empty">Aucune recherche faite. C’est facultatif et jamais automatique.</p>';
  return `${body}${withButton ? `<div class="fm-btns">${btn('Rechercher sur le marché', 'fm-sheet', 'market', 'fm-btn')}</div>` : ''}<p class="fm-note">Signaux observés, pas une couverture complète du marché. Une annonce n’est ni une preuve de conformité UE, ni de préparation Amazon, ni de l’identité du produit.</p>`;
}
function whyBlock(q) {
  const n = q?.need; if (!n?.parts?.length) return '';
  return `<details class="fm-why"><summary>Pourquoi cette question maintenant ?</summary><p class="fm-note">${esc(n.why?.fr ?? '')}</p>${n.parts.map((p) => `<div class="fm-li"><span class="fm-g">${p.pts > 0 ? '+' : '−'}${Math.abs(p.pts)}</span><span>${esc(p.fr)}</span></div>`).join('')}<p class="fm-note">Total : ${n.score} · ${esc(n.dimension)}</p></details>`;
}

// ---- sheets ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
const section = (title, body, first = false) => `<div class="fm-k2 ${first ? 'first' : ''}">${esc(title)}</div>${body}`;
const li = (g, text) => `<div class="fm-li"><span class="fm-g">${g}</span><span>${text}</span></div>`;

function proposedCands(c) { return c.candidates.filter((x) => x.state === 'PROPOSED'); }
export function factRows(c) {
  // Terrain reads the same CaseFacts as Expert and Salon (a value typed in Quick or corrected in the Salon shows here at once); the ledger is only the fallback for keys that are not facts of their own (price tiers)
  const facts = caseFacts(c); const led = (k) => { const f = facts.find((x) => k.includes(x.key)); return f ? { key: f.key, value: f.value, status: f.source_type, factType: f.fact_type } : [...(c.ledger ?? [])].reverse().find((e) => k.includes(e.key) && e.context === 'product'); };
  const prop = (k) => [...proposedCands(c)].reverse().find((x) => k.includes(x.key));
  const SPEC = [['Prix indicatif', ['quote.tiers', 'quote.unitPrice'], 'tag'], ['MOQ', ['quote.moq'], 'box'], ['Délai de production', ['quote.leadTime'], 'clock'], ['Incoterm', ['quote.incoterm'], 'ship'], ['Paiement', ['payment.depositPct'], 'cash'], ['Couleurs', ['variant.colours'], 'palette'], ['Référence', ['identifier.model'], 'hash'], ['Puissance', ['spec.power'], 'hash'], ['Capacité', ['spec.capacity'], 'hash'], ['Sorties', ['spec.outputCount'], 'hash'], ['Stock', ['offer.stockStatus'], 'box']];
  const rows = []; const attn = new Set(groupUnderstanding(c).attention.filter((a) => ['CONFLICT', 'AMBIGUOUS', 'DUPLICATE'].includes(a.reason)).map((a) => a.candidate.id));
  const cur = facts.find((x) => x.key === 'quote.currency')?.value; const withCur = (k, t) => (/^quote.(tiers|unitPrice)/.test(k) ? (typeof cur === 'string' && cur ? `${t} ${cur}` : `${t} — devise à confirmer`) : t); // only a CONFIRMED currency is written next to a price; "$" is never read as USD here
  for (const [label, keys, ic] of SPEC) {
    const l = led(keys); const p = prop(keys);
    if (l) rows.push(`<div class="fm-kv"><span class="fm-kic">${ICON[ic]}</span><span class="fm-l">${label}</span><span class="fm-v"><b>${esc(withCur(l.key, describeFact({ key: l.key, value: l.value, context: 'product' }, 'fr').valueText))}</b>${OK}${l.status === 'SUPPLIER_CLAIM' ? '<small>dit par le fournisseur, confirmé par vous</small>' : l.status === 'USER_PROVIDED' ? '<small>saisi ou corrigé par vous</small>' : l.status === 'IMAGE_OBSERVED' ? '<small>lu sur la photo, accepté par vous</small>' : l.status === 'DOCUMENT_OBSERVED' ? '<small>lu dans un document, accepté par vous</small>' : ''}${l.factType ? btn('Corriger', 'fact-correct-open', l.factType, 'fm-cf') : ''}${l.factType && S.correctingFact === l.factType ? `<form data-form="fact-correct" data-id="${l.factType}" style="display:flex;gap:6px;margin-top:6px"><input name="value" autocomplete="off" placeholder="Valeur exacte" autofocus style="flex:1;min-width:0;font-size:16px"><button class="fm-btn" type="submit">OK</button></form>` : ''}</span></div>`);
    else if (p) { const d = describeCandidate(p, 'fr'); const unk = p.speaker === 'unknown'; const machine = (p.flags ?? []).includes('MACHINE_DERIVED'); const flagged = attn.has(p.id) || p.needsCorrection || p.confidence === 'LOW' || (p.flags ?? []).some((f) => ['AMBIGUOUS_NUMBER', 'DUPLICATE_THRESHOLD'].includes(f)); const who = unk ? 'entendu au micro, locuteur inconnu' : p.speaker === 'me' ? `dit par vous${machine ? ', transcription automatique' : ''}` : `annoncé par le fournisseur${machine ? ', transcription automatique' : ''}`; rows.push(`<div class="fm-kv"><span class="fm-kic">${ICON[ic]}</span><span class="fm-l">${label}</span><span class="fm-v"><b>${esc(withCur(p.key, d.valueText))}</b>${CL}<small>${who}${flagged && !unk ? ' : à vérifier' : ''}</small>${unk ? btn('Qui parlait ?', 'attr-open', p.itemId, 'fm-cf') : flagged ? btn('À vérifier', 'fm-sheet', 'conflict', 'fm-cf') : btn('Confirmer', 'cand-confirm', p.id, 'fm-cf')}</span></div>`); }
  }
  // document statements: their own states, never ✓
  const claims = new Map(); for (const d of c.documentLedger ?? []) claims.set(d.claim, d); for (const x of proposedCands(c)) if (x.key.startsWith('docClaim.') && x.value !== 'NOT_AVAILABLE') claims.set(x.key.slice(9), claims.get(x.key.slice(9)) ?? { claim: x.key.slice(9), status: 'CLAIMED' });
  if (claims.size) { const NAME = { CE: 'CE', ROHS: 'RoHS', UN383: 'UN 38.3', REACH: 'REACH', SDS: 'FDS', IEC62133: 'IEC 62133', TEST_REPORT: 'rapport d\'essai' }; const st = [...claims.keys()].map((k) => documentStatusOf(c, k).status);
    const txt = st.some((x) => x === 'DOCUMENT_MATCHED') ? 'reçu, correspond au modèle : pas encore accepté comme preuve' : st.some((x) => x === 'DOCUMENT_RECEIVED' || x === 'MISMATCH') ? 'reçu, pas accepté comme preuve' : 'annoncées, non reçues';
    rows.push(`<div class="fm-kv"><span class="fm-kic">${ICON.shield}</span><span class="fm-l">Certifications</span><span class="fm-v"><b>${esc([...claims.keys()].map((k) => NAME[k] ?? k).join(', '))}</b>${CL}<small>${txt}</small></span></div>`); }
  return rows;
}
function missingList(c, ctx) {
  const qs = ctx.plan.questions.filter((q) => q.priority === 'P1' && q.source !== 'CONFLICT' && ['OPEN', 'UNANSWERED', 'SKIPPED', 'ASKED'].includes(q.state)).slice(0, 4).map((q) => cap(q.short?.fr ?? q.text.fr));
  if (S.fmStatus?.safety?.state === 'NONE') qs.push('Vérification Safety Gate (copie absente de ce téléphone)'); return qs;
}
/** The missing items exactly as the evaluation sheet shows them (used by the copied summary). */
export const fieldMissing = (c, ctx) => missingList(c, ctx);
function clarifyBlocks(c) {
  const g = groupUnderstanding(c); const out = [];
  for (const a of g.attention) {
    const cd = a.candidate; const d = describeCandidate(cd, 'fr');
    if (a.reason === 'CONFLICT') { const old = showV(existingValue(c, cd.key, cd.context)); const now = showV(cd.correctedValue ?? cd.value); out.push(`<div class="fm-crit"><div class="fm-ct">${ICON.warn.replace('22', '20')}<span>${esc(d.label)} : <b>${esc(old)}</b> puis <b>${esc(now)}</b></span></div><div class="fm-cb">${btn(`Garder ${esc(old)}`, 'pre-old', cd.id)}${btn(`Prendre ${esc(now)}`, 'pre-new', cd.id)}</div><div class="fm-cb2">${btn('Demander au fournisseur', 'pre-ask', cd.id, 'fm-link')}</div></div>`); }
    else if (['AMBIGUOUS', 'DUPLICATE'].includes(a.reason)) { const open = S.correcting === cd.id; out.push(`<div class="fm-crit soft"><div class="fm-ct"><span>${esc(d.label)} : <b>${esc(d.valueText)}</b> <small>${a.reason === 'DUPLICATE' ? 'deux valeurs différentes' : 'valeur ambiguë'}</small></span></div><div class="fm-cb">${btn(open ? 'Annuler' : 'Corriger', 'cand-correct-open', cd.id)}${btn('Rejeter', 'cand-reject', cd.id)}</div>${open ? `<form data-form="cand-correct" data-id="${esc(cd.id)}" class="fm-corr"><input name="value" value="${esc(d.suggestion ?? (typeof cd.value !== 'object' ? cd.value : ''))}" autocomplete="off" aria-label="La bonne valeur"><button class="fm-btn fm-primary fm-small">Enregistrer</button></form>` : ''}</div>`); }
  }
  for (const x of (c.conflicts ?? []).filter((y) => y.state === 'OPEN')) { const [o, n] = x.entries.map((e) => showV(e.value)); out.push(`<div class="fm-crit"><div class="fm-ct">${ICON.warn.replace('22', '20')}<span>Contradiction : <b>${esc(o)}</b> puis <b>${esc(n)}</b></span></div><div class="fm-cb">${btn(esc(o), 'conflict-resolve', x.id, 'fm-btn', 'data-val="&quot;OLD&quot;"')}${btn(esc(n), 'conflict-resolve', x.id, 'fm-btn', 'data-val="&quot;NEW&quot;"')}</div><div class="fm-cb2">${btn('Demander au fournisseur', 'conflict-ask', x.id, 'fm-link')}</div></div>`); }
  return out;
}
const ownerCard = (q) => {
  const a = q.answer; const head = `<div class="fm-oc"><p class="fm-oq">${esc(q.text.fr)}</p><p class="fm-fr">${esc(q.reason.fr)}</p>`;
  if (a.kind === 'YESNO') return `${head}<div class="fm-cb">${btn('Oui', 'uanswer', q.id, 'fm-btn', 'data-val="true"')}${btn('Non', 'uanswer', q.id, 'fm-btn', 'data-val="false"')}${btn('Plus tard', 'q-skip', q.id, 'fm-btn fm-ghost')}</div></div>`;
  return `${head}<form data-form="uanswer" data-id="${esc(q.id)}" class="fm-corr"><input name="value" inputmode="decimal" autocomplete="off" placeholder="${esc(a.unit)}" aria-label="${esc(a.unit)}"><button class="fm-btn fm-primary fm-small">OK</button>${btn('Plus tard', 'q-skip', q.id, 'fm-btn fm-ghost fm-small')}</form></div>`;
};

function sheet(kind, A, c, fm) {
  const ctx = fm.ctx; let title = ''; let sub = ''; let body = '';
  if (kind === 'write') { const draft = (S.captureDraft ??= {})[c.id] ?? ''; title = 'Écrire';
    body = `<form data-form="compose"><label class="fm-label">Ce que dit le fournisseur (tapez ou collez ; anglais ou 中文)<textarea name="text" data-draft="capture" rows="5" placeholder="Ex. : For 300 pcs we can do USD 6.80, FOB Shenzhen...">${esc(draft)}</textarea></label><div class="fm-row2"><label class="fm-label fm-grow">De qui<select name="speaker"><option value="supplier">Fournisseur</option><option value="me">Ma note</option></select></label><button class="fm-btn fm-primary">Envoyer</button></div></form>`; }
  else if (kind === 'add') { title = 'Scanner / Ajouter';
    body = `<label class="fm-btn fm-file">Photographier le produit<input type="file" accept="image/*" capture="environment" data-act="photo"></label>${btn('Photo ou fichier d\'un document', 'attach-doc', undefined, 'fm-btn fm-ghost')}${btn('Coller du texte', 'fm-nav', 'write', 'fm-btn fm-ghost')}<p class="fm-note">La lecture automatique des offres n'existe pas encore : la photo est gardée comme pièce, tapez l'essentiel dans « Écrire ».</p>`; }
  else if (kind === 'ask') {
    const q = ctx.all.find((x) => x.id === S.askId) ?? ctx.plan.questions.find((x) => x.id === S.askId); title = 'À demander';
    if (q) { const zh = q.supplier?.zh;
      body = `<p class="fm-en big" lang="en">${esc(q.text.en ?? q.text.fr).replace(/\n/g, '<br>')}</p>${q.text.en ? `<p class="fm-fr">FR — ${esc(q.text.fr.split('\n')[0])}</p>` : ''}<p class="fm-note">${esc(q.reason.fr)}</p>
      ${whyBlock(q)}<div class="fm-btns">${btn('Montrer au fournisseur', 'show-q', q.id, 'fm-btn fm-primary')}${zh?.text ? btn('Montrer en 中文', 'show-q-zh', q.id, 'fm-btn') : ''}${btn('Pas maintenant', 'q-skip', q.id, 'fm-btn fm-ghost')}</div>${zh?.text ? `<p class="fm-note">${zh.review === 'NATIVE_REVIEWED' ? '中文 : relue' : '中文 : non relue par un locuteur natif'}</p>` : ''}`;
    } else body = '<p class="fm-empty">Cette suggestion n\'est plus d\'actualité.</p>'; }
  else if (kind === 'end') { title = 'Conversation terminée'; const n = ctx.plan.timeline.filter((e) => ['SUPPLIER', 'HEARD', 'ME'].includes(e.kind)).length; sub = `${n} note${n > 1 ? 's' : ''} · gardées sur ce téléphone`;
    const g = groupUnderstanding(c); const understood = []; for (const e of c.ledger ?? []) { if (e.context !== 'product' || e.key.startsWith('docClaim.')) continue; understood.push([OK, describeFact({ key: e.key, value: e.value, context: e.context }, 'fr')]); }
    const seen = new Set(understood.map(([, d]) => d.key)); for (const l of g.lines) understood.push([CL, { valueText: l, key: l }]);
    for (const p of proposedCands(c).filter((x) => (x.flags ?? []).includes('MACHINE_DERIVED') && !x.key.startsWith('docClaim.'))) { const d = describeCandidate(p, 'fr'); understood.push([CL, { label: d.label, valueText: `${d.valueText} (entendu${p.speaker === 'unknown' ? ', locuteur inconnu' : ''})`, key: p.key }]); }
    const known = understood.slice(0, 8).map(([gl, d]) => li(gl, d.label ? `${esc(d.label)} <b>${esc(d.valueText)}</b>` : esc(d.valueText))).join(''); void seen;
    const miss = missingList(c, ctx).slice(0, 3); const clar = clarifyBlocks(c); const next = ctx.suggestion ?? ctx.all[0];
    body = `${section('Ce que Nordla a compris', known || '<p class="fm-empty">Rien de précis pour l\'instant.</p>', true)}${section('Ce qui manque réellement', miss.length ? miss.map((m) => `<div class="fm-li"><i class="fm-dot"></i><span>${esc(m)}</span></div>`).join('') : '<p class="fm-empty">Rien d\'important ne manque.</p>')}${clar.length ? section('À clarifier', clar.join('')) : ''}${section('Prochaine étape', next ? `<div class="fm-next"><span class="fm-nic">${ICON.msg}</span><span>Demander : <b lang="en">${esc((next.text.en ?? next.text.fr).split('\n')[0])}</b>${next.text.en ? `<br><small>FR — ${esc(next.text.fr.split('\n')[0])}</small>` : ''}</span></div>` : '<p class="fm-empty">Rien à demander pour l\'instant.</p>')}${btn(`Ouvrir l'évaluation d'achat ${ICON.chev}`, 'fm-sheet', 'summary', 'fm-lnk')}`; }
  else if (kind === 'understood') { title = 'Faits annoncés par le fournisseur'; const g = groupUnderstanding(c);
    body = `${g.hasGroup ? `<p class="fm-note">Rien n'est appliqué au dossier avant votre « Oui ». Ce sont des affirmations du fournisseur, pas des preuves.</p><div>${g.lines.map((l) => li(CL, esc(l))).join('')}</div><div class="fm-btns">${btn('Oui, c\'est ça', 'group-confirm', undefined, 'fm-btn fm-primary')}</div>` : '<p class="fm-empty">Aucun fait propre à confirmer.</p>'}${g.claims.length ? `<div class="fm-k2">Documents annoncés</div><p class="fm-note">${esc(g.claimsLine ?? '')} ${esc(g.noLine ?? '')} Cela n'enregistre aucun document reçu et aucune preuve.</p><div class="fm-btns">${btn('Noter comme annoncés', 'claims-confirm', undefined, 'fm-btn')}</div>` : ''}${clarifyBlocks(c).length ? `<div class="fm-k2">À clarifier</div>${clarifyBlocks(c).join('')}` : ''}`; }
  else if (kind === 'market') { title = 'Rechercher sur le marché'; const h = buildProductHypothesis(c); const inp = buildSearchInput(c, h); const out = outgoingFields(inp); const last = (c.marketSearches ?? []).at(-1);
    const used = [['Nom', inp.name], ['Marque', inp.brand], ['Modèle / référence', inp.model], ['Fabricant', inp.manufacturerRef], ['Code-barres (GTIN)', inp.gtin]].filter(([, v]) => v).map(([k, v]) => `<div class="fm-li"><i class="fm-dot ok"></i><span>${k} : <b>${esc(v)}</b></span></div>`).join('');
    body = `<p class="fm-note">Savoir si ce produit, ou un produit vraiment comparable, est déjà vendu en Europe, d’abord en Belgique. C’est une action facultative : elle ne s’exécute que si vous la lancez, et elle n’interrompt pas la conversation.</p>
      <div class="fm-k2">Ce qui serait utilisé</div>${used || '<p class="fm-empty">Rien encore : donnez au moins un nom.</p>'}<p class="fm-note">Identification : <b>${inp.strength === 'MODEL' || inp.strength === 'GTIN' ? 'référence connue' : inp.strength === 'BRAND_NAME' ? 'marque et nom' : 'nom seulement'}</b>${inp.strength === 'NAME_ONLY' || inp.strength === 'BRAND_NAME' ? ' : le numéro de modèle exact améliorerait beaucoup la recherche (et Nordla peut vous le faire demander).' : '.'}</p>
      <div class="fm-k2">Ce qui serait envoyé</div><p class="fm-note">Texte seulement (${out.text.map((k) => ({ name: 'nom', brand: 'marque', model: 'modèle', manufacturerRef: 'fabricant', gtin: 'code-barres' }[k] ?? k)).join(', ') || 'rien'}). La photo n’est jamais envoyée sans votre accord explicite.</p>
      <div class="fm-k2">Service de recherche</div><p class="fm-note">Aucun service de recherche (ni de recherche par image) n’est configuré dans cette version : <b>rien n’est cherché ni envoyé</b>. L’interface et le modèle de preuves sont prêts pour un service approuvé.</p>
      <div class="fm-btns">${btn('Noter la demande de recherche', 'market-run', undefined, 'fm-btn fm-primary')}</div>${last ? `<p class="fm-note">Dernière demande : ${esc(last.status === 'PROVIDER_NOT_CONFIGURED' ? 'impossible, aucun service configuré' : last.status)}.</p>` : ''}
      ${marketBlock({ marketPresence: A.marketPresence }, false)}
      <p class="fm-note"><b>Aucune correspondance trouvée ≠ non vendu en Europe.</b> La présence sur le marché n’est pas la conformité UE, ni la préparation Amazon, ni l’identité du produit.</p>`; }
  else if (kind === 'speaker') { title = 'Qui parlait ?'; const it = (c.conversations ?? []).flatMap((v) => v.items).find((i) => i.id === S.attrItem);
    body = it ? `<p class="fm-note">Entendu au micro. Nordla ne devine pas qui parle : c’est vous qui le dites.</p><div class="fm-b"><span class="fm-orig" lang="${esc(it.lang ?? 'en')}">${esc(textOf(it))}</span><span class="fm-d">transcription automatique</span></div><div class="fm-btns">${btn('Le fournisseur', 'attr', 'supplier', 'fm-btn fm-primary')}${btn('Moi', 'attr', 'me', 'fm-btn')}</div><p class="fm-note">Cela ne confirme aucun fait : vous confirmerez chaque information ensuite, une par une.</p>` : '<p class="fm-empty">Cette phrase est introuvable.</p>'; }
  else if (kind === 'conflict') { title = 'À clarifier'; const b = clarifyBlocks(c); body = b.length ? b.join('') : '<p class="fm-empty">Rien à clarifier.</p>'; }
  else if (kind === 'alerts') { title = 'Alertes'; const st = S.fmStatus; const items = [...fm.alerts.map((a) => li('⚠', esc(a.text.fr)))];
    if (st) items.push(li('•', `Serveur : ${esc(st.server.label.toLowerCase())}`), li('•', `Safety Gate : ${esc(st.safety.label.toLowerCase())}`));
    body = `${items.join('')}<div class="fm-btns">${btn('Réglages, dossiers, mode expert', 'fm-menu', undefined, 'fm-btn')}</div>`; }
  else if (kind === 'summary') {
    const g = groupUnderstanding(c); const rows = factRows(c); const miss = missingList(c, ctx); const nProp = proposedCands(c).length; const d = A.decision; const mp = A.maxPurchasePrice; const stage = ctx.plan.summary.stage; const evaluable = stage === 'EVALUABLE' || stage === 'ALMOST'; const owner = ctx.ownerCards ?? [];
    const manu = [...proposedCands(c)].reverse().find((x) => x.key === 'identifier.manufacturer'); const supName = c.supplier?.name || c.identity.identifiers?.manufacturer || (manu ? String(manu.value) : '');
    title = "Évaluation d'achat"; sub = [c.identity.workingName, supName].filter(Boolean).join(' · ');
    const lb = A.landed?.isLowerBound === true; const sg = A.safety ?? {}; const SG = { NO_MATCH_FOUND: 'aucune correspondance trouvée (cela ne prouve pas que le produit est sûr)', NOT_CHECKED: 'non consulté (hors ligne) : vérification requise', EXACT_MATCH: 'correspondance exacte avec une alerte', PROBABLE_MATCH: 'correspondance probable avec une alerte', SIMILAR_PRODUCT_RISK: 'produits similaires notifiés' };
    const econ = lb ? `<p class="fm-warnline"><b>Coûts d'import non saisis</b> (${esc(A.landed.unknownCostComponents.map((u) => COST_FR[u.replace(/^costs\./, '')] ?? u.replace(/^costs\./, '')).join(', '))}) : le coût de revient est une <b>borne basse</b>, le prix maximum une <b>borne haute</b>. Pas d'acompte sur cette base.</p>` : '';
    const reg = `<p class="fm-evl">Safety Gate : <b>${esc(SG[sg.status] ?? String(sg.status ?? 'inconnu'))}</b>${sg.stale ? ' <span class="fm-stale">périmé' + (sg.ageDays != null ? ` (${sg.ageDays} j)` : '') + '</span>' : ''}</p>`;
    const ev = evaluable ? `<p class="fm-evv v-${esc(d.verdict)}"><b>${esc(VERDICT_TEXT[d.verdict][1])}</b></p>${mp?.maxUnitPriceMinor !== null && mp?.maxUnitPriceMinor !== undefined ? `<p class="fm-evl">Prix maximum à payer : <b>${esc(mp.display ?? '')}</b>${mp.upperBound ? ' <span class="fm-ub">borne haute</span>' : ''}</p>` : ''}${A.negotiation?.targetUnitPrice?.display ? `<p class="fm-evl">Cible de négociation : <b>${esc(A.negotiation.targetUnitPrice.display)}</b></p>` : ''}` : '<p class="fm-empty">Pas encore assez d\'informations pour une première évaluation.</p>';
    body = `<div class="fm-btns fm-copyrow">${btn('Copier le résumé', 'copy-summary', undefined, 'fm-btn')}</div>${nProp ? `<div class="fm-bar">${ICON.clock.replace('17', '22')}<span>${nProp} élément${nProp > 1 ? 's' : ''} à confirmer</span></div>` : ''}
      ${section('Statut', `<div class="fm-steps"><div class="on"><i></i>Discussion</div><div><i></i>Échantillons</div><div><i></i>Validation</div><div><i></i>Commande</div></div>`, !nProp)}
      ${supName || manu ? section('Fournisseur', `<div class="fm-sup2"><div class="fm-sav">${esc((supName || 'F').slice(0, 2).toUpperCase())}</div><div><b>${esc(supName || 'Fournisseur')}</b>${manu ? `<span class="fm-tag">Fabricant · déclaré ${CL}</span>` : ''}</div></div>`) : ''}
      ${section('Ce que Nordla comprend du produit', productBlock(A))}
      ${section('Informations clés', rows.length ? rows.join('') : '<p class="fm-empty">Rien de précis pour l\'instant.</p>')}
      ${section('Informations manquantes', miss.length ? miss.map((m) => `<div class="fm-li"><i class="fm-dot"></i><span>${esc(m)}</span></div>`).join('') : '<p class="fm-empty">Rien d\'important ne manque.</p>')}
      ${section('Marché (Belgique · Europe)', marketBlock(A))}
      ${section('Évaluation', `${ev}${econ}${reg}<p class="fm-note">Décision d'entreprise : pas encore disponible (elle relève du socle commun de Nordla, non raccordé).</p>`)}
      ${(g.hasGroup || g.claims.length) ? `<div class="fm-btns">${btn(`Confirmer les faits annoncés${g.hasGroup ? ` (${g.group.length})` : ''}`, 'fm-sheet', 'understood', 'fm-btn')}</div>` : ''}
      ${section('Prochaine étape', ctx.suggestion ?? ctx.all[0] ? `<div class="fm-next"><span class="fm-nic">${ICON.msg}</span><span>Demander : <b lang="en">${esc(((ctx.suggestion ?? ctx.all[0]).text.en ?? (ctx.suggestion ?? ctx.all[0]).text.fr).split('\n')[0])}</b></span></div>` : '<p class="fm-empty">Rien à demander pour l\'instant.</p>')}
      ${owner.length ? section('À renseigner par vous', `<p class="fm-note">Ce sont des hypothèses de ce dossier : elles ne sont pas des règles de votre entreprise.</p>${owner.map(ownerCard).join('')}`) : ''}
      <p class="fm-legend"><b>${OK}</b> confirmé par vous · <b>${CL}</b> annoncé par le fournisseur, pas encore confirmé. Les documents ont leurs propres états : annoncé, reçu, jamais « confirmé ».</p>
      ${btn('Détails (mode expert)', 'mode-expert', undefined, 'fm-lnk')}`; }
  if (kind === 'summary') body = `${coverageBanner(A)}${body}`;
  return `<div class="fm-backdrop" data-act="fm-sheet-close"></div><section class="fm-sheet ${kind === 'summary' ? 'tall' : ''}" role="dialog" aria-label="${esc(title)}"><div class="fm-grab"></div><div class="fm-sh"><div><h2>${esc(title)}</h2>${sub ? `<p>${esc(sub)}</p>` : ''}</div>${btn(ICON.x, 'fm-sheet-close', undefined, 'fm-x', 'aria-label="Fermer"')}</div><div class="fm-sbody">${body}</div></section>`;
}

/** @param {object} A the assessment @param {object} c the case @param {ReturnType<typeof fmCompute>} fm */
export function fieldFirst(A, c, fm) {
  const ctx = fm.ctx; const started = (c.conversations ?? []).length > 0 || ctx.plan.timeline.some((e) => ['SUPPLIER', 'HEARD', 'ME'].includes(e.kind));
  const toast = S.flash ? `<div class="fm-toast" role="status">${esc(S.flash)}</div>` : '';
  let main;
  if (!started) {
    const photo = refPhoto(c);
    main = `${productCard(c, A, { hero: true })}${photo ? '<p class="fm-refnote">Cette photo sera la photo de référence du dossier.</p>' : ''}${categoryHint(c, A)}
      <section class="fm-start"><p class="fm-hlp">${photo ? 'Photo enregistrée sur ce téléphone.' : 'Photographiez le produit, puis touchez Démarrer.'}<br>Nordla active le micro, écoute la conversation (anglais) et ne vous interrompt pas.</p>
      <label class="fm-cam">${ICON.camera}${photo ? 'Reprendre la photo' : 'Photographier le produit'}<input type="file" accept="image/*" capture="environment" data-act="photo"></label>
      <button type="button" class="fm-go" data-act="fm-start"><span class="fm-gic">${ICON.chat.replace(/width="24" height="24"/, 'width="26" height="26"')}</span>Démarrer la conversation</button></section>`;
  } else {
    const ask = fm.show && fm.show.audience === 'SUPPLIER' ? suggestion(fm.show) : (convOpen(c) ? `<div class="fm-askrow">${btn('Que demander maintenant ?', 'ask-now', undefined, 'fm-link')}</div>` : '');
    main = `${productCard(c, A, { mini: true, tap: true })}${alertBar(fm.alerts, c)}${thread(ctx)}<div class="fm-tray">${ask}${confirmRow(c)}${dock(c, ctx)}</div>`;
  }
  return `<div class="fm ${started ? 'started' : 'home'}">${header(fm)}${toast}${main}</div>${S.sheet ? sheet(S.sheet, A, c, fm) : ''}`;
}
