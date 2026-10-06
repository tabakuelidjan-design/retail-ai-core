// FIELD MODE (the normal terrain experience): two views over the SAME case and the SAME engines as Expert - nothing is deleted, nothing is duplicated.
//   Conversation: product (only until it is named) -> the talk with the supplier -> what Nordla understood -> the best next question -> a box to type or paste.
//   Summary: where things stand (progress message, known / missing / to confirm), analysis and decision, what is not available yet.
// The owner never launches an analysis: every engine is recomputed from the case at every render. Texts are French (the owner's language); the supplier's words are always shown unchanged.
// RENDERING INVARIANT (also for the future voice recorder and interpreter): this screen is rebuilt from the case on every render; nothing that matters lives only in the DOM. The half-typed message
// is kept in S.captureDraft (and in local storage by app.js), a running capture would live OUTSIDE this screen.
import { esc, chip, list, VERDICT_TEXT } from '../dom.js';
import { S } from '../state.js';
import { suggestCategories } from '/core/case.js';
import { planConversation, REVIEW } from '/core/conversation-engine.js';
import { groupUnderstanding } from '/core/understanding.js';
import { UNAVAILABLE_ENGINES } from '/core/field-progress.js';
import { describeCandidate } from '/core/candidate-view.js';
import { existingValue } from '/core/conflicts.js';

const REVIEW_TEXT = { TECHNICAL_ONLY: '中文 : relecture par un locuteur natif à faire', UNREVIEWED: '中文 : non relue', MACHINE: 'traduction automatique', UNAVAILABLE: 'chinois non disponible', NATIVE_REVIEWED: '中文 : relue' };
const DIM_TEXT = { IDENTITY: 'Identité du produit', COMMERCIAL: 'Offre commerciale', ROLE: 'Votre rôle', REGULATORY: 'Conformité', DOCUMENTS: 'Documents', COST: 'Coûts', DECISION: 'Décision', CONFLICT: 'Contradiction' };
const REASON_TEXT = { MACHINE_DERIVED: "Issu d'une transcription ou traduction automatique : à confirmer un par un", AMBIGUOUS: 'Valeur ambiguë : à corriger', DUPLICATE: 'Deux valeurs différentes : laquelle ?', CONFLICT: 'Contredit ce que Nordla a déjà', CALCULATED: 'Valeur calculée ou convertie : à vérifier', LOW_CONFIDENCE: 'Confiance faible : à vérifier' };
const b = (label, act, key, extra = '', cls = 'btn sec') => `<button type="button" class="${cls}" data-act="${act}" ${key !== undefined ? `data-key="${esc(key)}"` : ''} ${extra} style="min-height:44px;padding:8px 14px">${label}</button>`;
const val = (v) => ` data-val="${esc(JSON.stringify(v))}"`;

function bubble(e) {
  if (e.kind === 'SUPPLIER' || e.kind === 'ME') return `<div class="bub ${e.kind === 'ME' ? 'me' : 'sup'}"><span class="who">${e.kind === 'ME' ? 'Ma note' : 'Fournisseur'}</span><div class="orig" lang="${e.lang === 'zh' ? 'zh-Hans' : esc(e.lang)}">${esc(e.original)}</div>${(e.derived ?? []).map((d) => `<div class="small muted">${d.kind === 'TRANSLATION' ? 'Traduction' : d.kind === 'TRANSCRIPTION' ? 'Transcription' : 'Lecture'} (${esc(d.provider ?? 'inconnu')}, ${d.review === 'MACHINE' ? 'automatique : à vérifier' : esc(d.review)}) : ${esc(d.text)}</div>`).join('')}</div>`;
  if (e.kind === 'ASKED') return `<div class="bub ask"><span class="who">Vous avez demandé</span><div>${esc(e.texts?.fr ?? '')}</div>${e.texts?.zh ? `<div class="zh small" lang="zh-Hans">${esc(e.texts.zh)}</div><div class="small muted">${esc(REVIEW_TEXT[e.texts.zhReview] ?? '')}</div>` : ''}</div>`;
  return `<div class="bub ok small muted">✓ ${e.ids.length} fait${e.ids.length > 1 ? 's' : ''} confirmé${e.ids.length > 1 ? 's' : ''} par vous${e.via === 'CLAIMS' ? ' (déclarations notées)' : ''}</div>`;
}

function understanding(state, g) {
  if (!g.hasGroup) return '';
  const open = !!S.groupEdit;
  return `<div class="card understood"><h2>NORDLA A COMPRIS</h2>${g.lines.map((l) => `<div class="uline">${esc(l)}</div>`).join('')}
    <div class="row" style="margin-top:10px">${b('Oui, c\'est ça', 'group-confirm', undefined, '', 'btn')}${b(open ? 'Fermer' : 'Corriger', 'group-edit')}${b('Revoir en détail', 'review-expert')}</div>
    ${open ? `<div style="margin-top:8px">${g.group.map((c) => { const d = describeCandidate(c, 'fr'); return `<div class="cand"><b>${esc(d.label)}</b> : ${esc(d.valueText)}<div class="small muted" lang="${esc(d.lang)}">« ${esc(d.from)} »</div><div class="row" style="margin-top:4px">${d.canCorrect ? b('Corriger', 'cand-correct-open', c.id) : ''}${b('Rejeter', 'cand-reject', c.id)}</div>${S.correcting === c.id ? correctForm(c, d) : ''}</div>`; }).join('')}</div>` : ''}
    <p class="small muted">Rien n'est appliqué au dossier avant votre « Oui ». Ce sont des affirmations du fournisseur, pas des preuves.</p></div>`;
}
const correctForm = (c, d) => `<form data-form="cand-correct" data-id="${esc(c.id)}"><label>La bonne valeur<input name="value" value="${esc(d.suggestion ?? (c.value !== null && typeof c.value !== 'object' ? c.value : ''))}" autocomplete="off"></label><button class="btn" style="margin-top:6px">Enregistrer</button></form>`;

const LABEL_FR = { 'quote.moq': 'MOQ', 'identifier.model': 'le modèle', 'quote.unitPrice': 'le prix', 'quote.incoterm': "l'Incoterm", 'quote.leadTime': 'le délai', 'payment.depositPct': "l'acompte", 'quote.port': 'le port', 'quote.currency': 'la devise' };
const showV = (v) => (typeof v === 'object' && v !== null ? JSON.stringify(v) : String(v));
function attentionCard(a, state) {
  const c = a.candidate;
  if (a.reason === 'CONFLICT') { // the contradiction is shown at once, with the two honest choices and a way to ask the supplier
    const old = showV(existingValue(state, c.key, c.context)); const now = showV(c.correctedValue ?? c.value); const d0 = describeCandidate(c, 'fr');
    return `<div class="card conflict"><div>⚠ <b>Avant :</b> ${esc(c.key.startsWith('docClaim.') ? d0.label : LABEL_FR[c.key] ?? d0.label)} ${esc(old)}. <b>Maintenant :</b> ${esc(c.key.startsWith('docClaim.') ? d0.valueText : now)}.</div><div class="small muted" lang="${esc(c.lang)}">« ${esc(c.rawText)} »</div><div class="row" style="margin-top:8px">${b(esc(old), 'pre-old', c.id)}${b(esc(c.key.startsWith('docClaim.') ? 'Prendre le nouveau' : now), 'pre-new', c.id)}${b('Demander', 'pre-ask', c.id, '', 'btn')}</div></div>`;
  } const d = describeCandidate(c, 'fr'); const open = S.correcting === c.id;
  return `<div class="card attn"><div class="small warnline">${esc(REASON_TEXT[a.reason] ?? '')}</div><div><b>${esc(d.label)}</b> : ${esc(d.valueText)}</div><div class="small muted" lang="${esc(d.lang)}">« ${esc(d.from)} »</div>${d.warnings.map((w) => `<div class="small warnline">${esc(w)}</div>`).join('')}
    <div class="row" style="margin-top:6px">${d.canConfirm ? b('Confirmer', 'cand-confirm', c.id, '', 'btn') : ''}${d.canCorrect ? b(open ? 'Annuler' : 'Corriger', 'cand-correct-open', c.id) : ''}${b('Rejeter', 'cand-reject', c.id)}</div>${open ? correctForm(c, d) : ''}</div>`;
}

function claimsCard(g) {
  if (!g.claims.length) return '';
  return `<div class="card claim"><h2>DOCUMENTS ANNONCÉS</h2>${g.claimsLine ? `<p>${esc(g.claimsLine)}</p>` : ''}${g.noLine ? `<p>${esc(g.noLine)}</p>` : ''}${b('Noter comme déclarations', 'claims-confirm', undefined, '', 'btn')}<p class="small muted">Cela enregistre ce que dit le fournisseur. Cela ne compte pas comme un document reçu ni comme une preuve.</p></div>`;
}

function conflictCards(c) {
  return (c.conflicts ?? []).filter((x) => x.state === 'OPEN').map((x) => { const [o, n] = x.entries.map((e) => (typeof e.value === 'object' ? JSON.stringify(e.value) : String(e.value))); const label = { 'quote.moq': 'MOQ', 'identifier.model': 'le modèle', 'quote.unitPrice': 'le prix', 'quote.incoterm': "l'Incoterm", 'quote.leadTime': 'le délai', 'payment.depositPct': "l'acompte" }[x.key] ?? 'cette information';
    return `<div class="card conflict"><div>⚠ <b>Avant :</b> ${esc(label)} ${esc(o)}. <b>Maintenant :</b> ${esc(n)}.</div><div class="row" style="margin-top:8px">${b(esc(o), 'conflict-resolve', x.id, val('OLD'), 'btn sec')}${b(esc(n), 'conflict-resolve', x.id, val('NEW'), 'btn sec')}${b('Demander', 'conflict-ask', x.id, '', 'btn')}</div></div>`; }).join('');
}

function nextCard(p) {
  const q = p.next; if (!q) return `<div class="card"><h2>PROCHAINE QUESTION</h2><p class="muted">Rien d'important à demander pour l'instant. Écrivez ce que dit le fournisseur ou ouvrez le résumé.</p></div>`;
  const head = `<h2>PROCHAINE QUESTION <span class="muted small">· ${esc(DIM_TEXT[q.dimension] ?? '')}</span></h2>`;
  if (q.audience === 'USER') {
    const a = q.answer; return `<div class="card nextq" data-qid="${esc(q.id)}" data-audience="${esc(q.audience)}">${head}<p class="qtext">${esc(q.text.fr)}</p><p class="small muted">${esc(q.reason.fr)}</p>
      ${a.kind === 'YESNO' ? `<div class="row">${b('Oui', 'uanswer', q.id, val(true), 'btn')}${b('Non', 'uanswer', q.id, val(false), 'btn sec')}${b('Plus tard', 'q-skip', q.id)}</div>`
      : `<form data-form="uanswer" data-id="${esc(q.id)}" class="row" style="align-items:end"><label>${esc(a.unit)}<input name="value" inputmode="decimal" autocomplete="off" placeholder="0"></label><button class="btn" style="flex:0 0 auto">OK</button></form>${q.id === 'u:fx' && S.token && S.online ? b('Taux du jour (BCE)', 'fx') : ''}<div style="margin-top:6px">${b('Plus tard', 'q-skip', q.id)}</div>`}</div>`;
  }
  const zh = q.supplier.zh; const showLabel = zh.text ? 'Montrer en 中文' : 'Montrer le français';
  return `<div class="card nextq" data-qid="${esc(q.id)}" data-audience="${esc(q.audience)}">${head}<p class="qtext">${esc(q.text.fr).replace(/\n/g, '<br>')}</p>${q.repeat ? '<p class="small warnline">Pas de réponse claire à cette question : la reposer ?</p>' : ''}
    <div class="row">${b(showLabel, 'show-q', q.id, '', 'btn')}${b('Plus tard', 'q-skip', q.id)}</div>
    <p class="small muted">${esc(REVIEW_TEXT[zh.review] ?? '')}${zh.review === REVIEW.UNAVAILABLE ? ' : montrez le français ou utilisez votre application de traduction' : ''}</p><p class="small muted">${esc(q.reason.fr)}</p>
    ${p.upcoming.length ? `<p class="small muted">Ensuite : ${esc(p.upcoming.map((u) => u.short.fr).join(' · '))}</p>` : ''}</div>`;
}

function productCard(c, A) {
  const named = c.identity.workingName || A.identity.category; if (named) return '';
  return `<div class="card"><h2>PRODUIT</h2><p class="small muted">Quel est ce produit ? Une photo, ou quelques mots.</p>
    <form data-form="fh-product"><label>Nom ou description<input name="name" autocomplete="off" placeholder="Power bank 10000 mAh"></label><button class="btn" style="margin-top:8px">Continuer</button></form>
    <label>Photo du produit (gardée comme preuve)<input type="file" accept="image/*" capture="environment" data-act="photo"></label></div>`;
}
function categoryHint(c, A) {
  if (A.identity.category || !c.identity.workingName) return '';
  const sugg = suggestCategories(c.identity.workingName); if (!sugg.length) return '';
  return `<div class="card"><p>Probablement : <b>${esc(sugg[0].label)}</b></p><div class="row">${b('Oui', 'cat', sugg[0].id, '', 'btn')}${sugg.slice(1, 3).map((s) => b(esc(s.label), 'cat', s.id)).join('')}</div><p class="small muted">Vous confirmez : Nordla ne devine pas à votre place.</p></div>`;
}

function composer(c) {
  const draft = (S.captureDraft ??= {})[c.id] ?? '';
  return `<div class="card composer"><form data-form="compose"><label>Ce que dit le fournisseur (tapez ou collez ; anglais ou 中文)<textarea name="text" data-draft="capture" placeholder="Ex. : For 300 pcs we can do USD 6.80, FOB Shenzhen, 30% deposit...">${esc(draft)}</textarea></label>
    <div class="row" style="align-items:end"><label>De qui<select name="speaker"><option value="supplier">Fournisseur</option><option value="me">Ma note</option></select></label><button class="btn" style="flex:0 0 auto">Envoyer</button>${b('📎', 'attach-toggle', undefined, 'aria-label="Ajouter une photo ou un document"')}</div></form>
    ${S.attach ? `<div class="attach"><label class="btn sec" style="display:block;text-align:center">Photo du produit<input type="file" accept="image/*" capture="environment" data-act="photo" style="display:none"></label>${b('Document (PDF, photo, texte)', 'attach-doc')}${b('Capture WeChat, offre, catalogue', 'attach-doc')}<p class="small muted">La lecture automatique d'offres n'existe pas encore : le fichier est gardé comme preuve ; tapez l'essentiel dans la conversation.</p></div>` : ''}</div>`;
}

export { bubble, understanding, attentionCard, claimsCard, conflictCards, nextCard, REVIEW_TEXT, b, val };
export function talkScreen(A, c) {
  const p = planConversation(c, A); const g = groupUnderstanding(c); const tl = p.timeline;
  const attention = g.attention;
  return `<div class="card sumline" data-act="ftab" data-key="summary" role="button"><div class="msg">${esc(p.summary.message.fr)}</div>
    <div class="chips"><span class="chip">connus <b>${p.known.length}</b></span><span class="chip">manquants <b>${p.summary.missingImportant}</b></span>${p.summary.pending ? `<span class="chip t-AMBER">à confirmer <b>${p.summary.pending}</b></span>` : ''}${p.summary.conflicts ? `<span class="chip t-RED">contradictions <b>${p.summary.conflicts}</b></span>` : ''}</div></div>
  ${productCard(c, A)}${categoryHint(c, A)}
  ${tl.length ? `<div class="timeline">${tl.map(bubble).join('')}</div>` : ''}
  ${understanding(c, g)}${attention.map((a) => attentionCard(a, c)).join('')}${claimsCard(g)}${conflictCards(c)}
  ${nextCard(p)}${composer(c)}`;
}

export function summaryScreen(A, c) {
  const p = planConversation(c, A); const d = A.decision; const [, fr] = VERDICT_TEXT[d.verdict]; const mp = A.maxPurchasePrice; const hasMax = mp?.maxUnitPriceMinor !== null && mp?.maxUnitPriceMinor !== undefined; const missing = p.questions.filter((q) => q.priority === 'P1' && !['ANSWER_PENDING'].includes(q.state) && q.source !== 'USER_FREE');
  return `<div class="card sumline"><div class="msg">${esc(p.summary.message.fr)}</div></div>
  <div class="card"><h2>OÙ ON EN EST</h2><table>
    <tr><td>Connu et confirmé</td><td class="n"><b>${p.known.length}</b></td></tr><tr><td>Important qui manque</td><td class="n"><b>${p.summary.missingImportant}</b></td></tr>
    <tr><td>À confirmer par vous</td><td class="n"><b>${p.summary.pending}</b></td></tr><tr><td>Contradictions</td><td class="n"><b>${p.summary.conflicts}</b></td></tr></table></div>
  ${p.summary.stage === 'EVALUABLE' || p.summary.stage === 'ALMOST' ? `<section class="verdict v-${d.verdict}"><p class="q">ÉVALUATION D'ACHAT (conformité et économie, ce produit à ces conditions)</p><div class="v">${esc(d.verdict.replace(/_/g, ' '))}</div><p class="a">${esc(fr)}</p>
    ${hasMax ? `<p style="margin:0"><b>Prix maximum à payer : ${esc(mp.display ?? '')}</b></p>` : '<p style="margin:0" class="muted">Prix maximum : pas encore calculable.</p>'}${A.negotiation?.targetUnitPrice?.display ? `<p style="margin:4px 0 0">Cible de négociation : <b>${esc(A.negotiation.targetUnitPrice.display)}</b></p>` : ''}</section>` : '<div class="card"><h2>ANALYSE</h2><p class="muted">Pas encore assez d\'informations pour une première évaluation. Nordla continue de calculer à chaque nouvelle information.</p></div>'}
  <div class="card"><h2>DÉCISION D'ENTREPRISE</h2><p><b>Pas encore disponible.</b></p><p class="small muted">La décision pour votre entreprise se prend dans le socle commun de Nordla (votre profil, votre argent, vos règles), qui n'est pas encore raccordé. L'évaluation ci-dessus ne couvre que ce produit.</p></div>
  ${p.questions.some((q) => q.audience === 'USER' && ['OPEN', 'UNANSWERED'].includes(q.state)) ? `<div class="card"><h2>À RENSEIGNER PAR VOUS</h2><p class="small muted">Ce sont des hypothèses de ce dossier : elles ne sont pas des règles de votre entreprise.</p></div>${p.questions.filter((q) => q.audience === 'USER' && ['OPEN', 'UNANSWERED'].includes(q.state)).map((q) => nextCard({ next: q, upcoming: [] })).join('')}` : ''}
  ${missing.length ? `<div class="card"><h2>CE QUI MANQUE</h2>${list(missing.map((q) => `${esc(q.text.fr.split('\n')[0])} <span class="chip">${q.audience === 'USER' ? 'vous' : 'fournisseur'}</span>`))}</div>` : ''}
  <details class="card"><summary>Ce que Nordla sait (${p.known.length})</summary>${list(p.known.map((k) => `${esc(k.label)} : <b>${esc(k.valueText)}</b> <span class="muted small">${k.status === 'SUPPLIER_CLAIM' ? 'dit par le fournisseur' : k.status === 'USER_PROVIDED' ? 'saisi par vous' : esc(k.status)}</span>`))}</details>
  <details class="card"><summary>Pas encore disponible (${UNAVAILABLE_ENGINES.length})</summary>${list(UNAVAILABLE_ENGINES.map((u) => `<b>${esc(u.label)}</b> - ${esc(u.note)}`))}${chip('', 'PAS ENCORE DISPONIBLE', 'UNKNOWN')}</details>
  <div class="row">${b('Retour à la conversation', 'ftab', 'talk', '', 'btn')}${b('Détails (mode expert)', 'mode-expert')}</div>`;
}
