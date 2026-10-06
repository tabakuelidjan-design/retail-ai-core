// FIELD MODE, CONVERSATION FIRST. The owner stands in front of a supplier and talks; Nordla works behind the scenes and shows only what has value NOW:
//   the product, the conversation, at most ONE suggestion (chosen for the current subject and shown at a calm moment), a compact line of states, and a quiet "N éléments à confirmer" pill.
// Everything else lives in SHEETS opened on demand (what Nordla understood, the contradiction, the summary with the purchase EVALUATION and the owner's own inputs, writing, adding a photo or document).
// Three entries, always at the bottom: Conversation, Scanner / Ajouter, Écrire. Nothing opens by itself: no modal, no sound, and the grouped confirmation is never opened automatically.
// The logic is the SAME pure engines as Expert (P5, topics, context engine, presenter, understanding): this file only chooses what to show. The screen is rebuilt from the case at every render;
// nothing that matters lives only in the DOM (the half-typed message is kept by app.js). The state glyphs mean: ✓ confirmed BY YOU (never "verified"), ◐ partly, ◌ the supplier says it, ! to check, ? unknown.
import { esc } from '../dom.js';
import { S } from '../state.js';
import { getBlob, ls } from '../storage.js';
import { suggestCategories } from '/core/case.js';
import { planContext } from '/core/context-engine.js';
import { presentSuggestion, normalizeTiming } from '/core/suggestion-presenter.js';
import { groupUnderstanding } from '/core/understanding.js';
import { bubble, understanding, attentionCard, claimsCard, conflictCards, summaryScreen, REVIEW_TEXT } from './fieldhome.js';

const LEGEND = [['✓', 'confirmé par vous'], ['◐', 'en partie confirmé'], ['◌', 'le fournisseur l\'affirme'], ['!', 'à vérifier'], ['?', 'inconnu']];
const ICON = {
  talk: '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 5h16v11H9l-5 4z"/><path d="M8 9h8M8 12h5"/></svg>',
  add: '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 8h3l2-3h6l2 3h3v11H4z"/><circle cx="12" cy="13" r="3.5"/></svg>',
  write: '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 20l1-4L16 5l3 3L8 19z"/><path d="M14 7l3 3"/></svg>',
};
const NAV = [['talk', 'Conversation'], ['add', 'Scanner / Ajouter'], ['write', 'Écrire']];

/** The bottom bar (Field Mode): three entries. */
export const fmNav = () => NAV.map(([k, l]) => `<button type="button" class="fm-nav" data-act="fm-nav" data-key="${k}" aria-current="${(k === 'talk' ? !S.sheet : S.sheet === k) ? 'true' : 'false'}">${ICON[k]}<span>${l}</span></button>`).join('');

/** What to show now: the contextual plan + the presenter's decision. The caller keeps `state` between renders (it is not part of the case) and wakes up at `hold.until`. */
export function fmCompute(A, c, now = Date.now()) {
  const ctx = planContext(c, A); const prev = S.fmPrev?.caseId === c.id ? S.fmPrev.state : null;
  const composing = S.sheet === 'write'; const explicit = !!S.askNow; S.askNow = false;
  const r = presentSuggestion(prev, ctx, { composing, lastUtteranceAt: null, explicit }, now, normalizeTiming(ls.get('nordla.sourcing.timing', null)));
  return { ctx, show: r.show, hold: r.hold, wake: r.wake, alerts: r.alerts, state: r.state, explicit };
}

const btn = (label, act, key, cls = 'fm-btn', extra = '') => `<button type="button" class="${cls}" data-act="${act}" ${key !== undefined ? `data-key="${esc(key)}"` : ''} ${extra}>${label}</button>`;

function productStart() {
  return `<section class="fm-card fm-start"><h1 class="fm-h">Quel est ce produit ?</h1><p class="fm-sub">Une photo, ou quelques mots.</p>
    <form data-form="fh-product"><label class="fm-label">Nom ou description<input name="name" autocomplete="off" placeholder="Power bank 10000 mAh"></label><button class="fm-btn fm-primary">Continuer</button></form>
    <label class="fm-btn fm-ghost fm-file">Photographier le produit<input type="file" accept="image/*" capture="environment" data-act="photo"></label></section>`;
}
function productHeader(c, A) {
  const photo = getBlob(`photo:${c.id}.0`); const name = c.identity.workingName || A.identity.category || '';
  const sugg = !A.identity.category && c.identity.workingName ? suggestCategories(c.identity.workingName) : [];
  return `<section class="fm-product">${photo ? `<img src="${esc(photo)}" alt="Photo du produit" class="fm-photo">` : ''}<div class="fm-product__t"><h1 class="fm-h">${esc(name)}</h1>${A.identity.category ? `<p class="fm-sub">${esc(String(A.identity.categoryLabel ?? A.identity.category).replace(/_/g, ' '))}</p>` : ''}</div></section>
    ${sugg.length ? `<div class="fm-hint">Probablement : <b>${esc(sugg[0].label)}</b> ${btn('Oui', 'cat', sugg[0].id, 'fm-btn fm-small')}</div>` : ''}`;
}

function suggestion(q) {
  const zh = q.supplier?.zh; const label = zh?.text ? 'Montrer en 中文' : 'Montrer le français';
  return `<section class="fm-suggest" data-qid="${esc(q.id)}" data-audience="${esc(q.audience)}" aria-live="polite"><div class="fm-eyebrow">À demander maintenant</div>
    <p class="fm-q">${esc(q.text.fr).replace(/\n/g, '<br>')}</p>${q.repeat ? '<p class="fm-note">Pas de réponse claire jusqu\'ici : la reposer ?</p>' : ''}
    <div class="fm-row">${btn(label, 'show-q', q.id, 'fm-btn fm-primary')}${btn('Pas maintenant', 'q-skip', q.id, 'fm-btn fm-ghost')}</div>
    ${zh?.text ? `<p class="fm-note">${esc(REVIEW_TEXT[zh.review] ?? '')}</p>` : '<p class="fm-note">Pas de chinois disponible pour cette question : montrez le français.</p>'}</section>`;
}

function statusLine(ctx) {
  const chips = ctx.chips.filter((x) => x.symbol !== '?'); if (!chips.length && !ctx.messages.length) return '';
  return `<button type="button" class="fm-status" data-act="fm-sheet" data-key="summary" aria-label="Ouvrir le résumé">${chips.map((x) => `<span class="fm-chip g${x.symbol === '✓' ? 'ok' : x.symbol === '!' ? 'warn' : 'mid'}" title="${esc(x.meaning.fr)}">${esc(x.label.fr)} <b>${x.symbol}</b></span>`).join('')}</button>
    ${ctx.messages.map((m) => `<p class="fm-msg">${esc(m.fr)}</p>`).join('')}`;
}

function thread(ctx) {
  const tl = ctx.plan.timeline; if (!tl.length) return '<p class="fm-empty">Le fournisseur parle : appuyez sur « Écrire » pour noter ou coller ce qu\'il dit.</p>';
  const old = tl.slice(0, Math.max(0, tl.length - 12)); const recent = tl.slice(-12);
  return `<div class="fm-thread">${old.length ? `<details class="fm-old"><summary>${old.length} message${old.length > 1 ? 's' : ''} plus ancien${old.length > 1 ? 's' : ''}</summary>${old.map(bubble).join('')}</details>` : ''}${recent.map(bubble).join('')}</div>`;
}

function alertBar(alerts) {
  if (!alerts.length) return '';
  const a = alerts[0]; return `<button type="button" class="fm-alert" data-act="fm-sheet" data-key="${a.kind === 'CONFLICT' ? 'conflict' : 'summary'}"><span aria-hidden="true">⚠</span> ${esc(a.text.fr)}${alerts.length > 1 ? ` <i>+${alerts.length - 1}</i>` : ''} <span aria-hidden="true">›</span></button>`;
}

function sheet(kind, A, c, ctx) {
  const close = btn('Fermer', 'fm-sheet-close', undefined, 'fm-btn fm-ghost fm-close');
  let title = ''; let body = '';
  if (kind === 'write') {
    const draft = (S.captureDraft ??= {})[c.id] ?? ''; title = 'Écrire';
    body = `<form data-form="compose"><label class="fm-label">Ce que dit le fournisseur (tapez ou collez ; anglais ou 中文)<textarea name="text" data-draft="capture" rows="5" placeholder="Ex. : For 300 pcs we can do USD 6.80, FOB Shenzhen...">${esc(draft)}</textarea></label>
      <div class="fm-row"><label class="fm-label fm-grow">De qui<select name="speaker"><option value="supplier">Fournisseur</option><option value="me">Ma note</option></select></label><button class="fm-btn fm-primary">Envoyer</button></div></form>`;
  } else if (kind === 'add') {
    title = 'Scanner / Ajouter';
    body = `<label class="fm-btn fm-file">Photographier le produit<input type="file" accept="image/*" capture="environment" data-act="photo"></label>
      ${btn('Photo ou fichier d\'un document', 'attach-doc', undefined, 'fm-btn fm-ghost')}${btn('Coller du texte', 'fm-nav', 'write', 'fm-btn fm-ghost')}
      <p class="fm-note">La lecture automatique des offres n'existe pas encore : la photo est gardée comme pièce, tapez l'essentiel dans « Écrire ».</p>`;
  } else if (kind === 'understood') {
    const g = groupUnderstanding(c); title = 'Nordla a compris';
    const inner = `${understanding(c, g)}${g.attention.map((a) => attentionCard(a, c)).join('')}${claimsCard(g)}`;
    body = inner.trim() ? inner : '<p class="fm-empty">Rien à confirmer pour l\'instant.</p>';
  } else if (kind === 'conflict') {
    const g = groupUnderstanding(c); title = 'Contradiction';
    const inner = `${g.attention.filter((a) => a.reason === 'CONFLICT').map((a) => attentionCard(a, c)).join('')}${conflictCards(c)}`;
    body = inner.trim() ? inner : '<p class="fm-empty">Aucune contradiction à clarifier.</p>';
  } else if (kind === 'summary') {
    title = 'Résumé';
    body = `${summaryScreen(A, c)}<div class="fm-legend"><b>Les signes</b>${LEGEND.map(([g, t]) => `<span><b>${g}</b> ${t}</span>`).join('')}<span class="fm-note">Les documents ont leurs propres états : annoncé, reçu, jamais « confirmé ».</span></div>`;
  }
  return `<div class="fm-backdrop" data-act="fm-sheet-close"></div><section class="fm-sheet" role="dialog" aria-label="${esc(title)}"><div class="fm-sheet__bar"><h2 class="fm-h2">${esc(title)}</h2>${close}</div><div class="fm-sheet__body">${body}</div></section>`;
}

/** @param {object} A the assessment @param {object} c the case @param {ReturnType<typeof fmCompute>} fm */
export function fieldFirst(A, c, fm) {
  const named = c.identity.workingName || A.identity.category;
  if (!named) return `<div class="fm">${productStart()}</div>`;
  const ctx = fm.ctx; const started = ctx.plan.timeline.length > 0 || (c.conversations ?? []).some((x) => x.status === 'OPEN');
  const home = !started;
  return `<div class="fm">${alertBar(fm.alerts)}${productHeader(c, A)}
    ${home ? `<section class="fm-home">${btn('Démarrer la conversation', 'fm-start', undefined, 'fm-btn fm-primary fm-xl')}<p class="fm-sub">Ou ajoutez une photo, un document, ou écrivez ce que dit le fournisseur.</p></section>`
      : `${thread(ctx)}${fm.show ? suggestion(fm.show) : ''}${ctx.pending ? `<button type="button" class="fm-pill" data-act="fm-sheet" data-key="understood">${ctx.pending} élément${ctx.pending > 1 ? 's' : ''} à confirmer <span aria-hidden="true">›</span></button>` : ''}
      ${statusLine(ctx)}<div class="fm-askrow">${btn('Que dois-je demander maintenant ?', 'ask-now', undefined, 'fm-link')}</div>`}
  </div>${S.sheet ? sheet(S.sheet, A, c, ctx) : ''}`;
}
