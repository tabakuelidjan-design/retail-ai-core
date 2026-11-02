'use strict';
// Nordla Créateur — plain DOM, no framework, strict CSP (no inline styles). Every state shown comes from the server.
// The user chooses a product and a variant and asks for a visual. The source photo is retrieved by Nordla: this screen never
// shows it for selection, confirmation or approval. Only the finished result is presented, for accept / revision / reject.

function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  if (attrs) for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') { if (v != null) el.className = v; }
    else if (k === 'on' && v) for (const [ev, fn] of Object.entries(v)) el.addEventListener(ev, fn);
    else if (v === true) el.setAttribute(k, '');
    else if (v != null && v !== false) el.setAttribute(k, v);
  }
  for (const c of children.flat(Infinity)) if (c != null) el.append(c.nodeType ? c : document.createTextNode(String(c)));
  return el;
}
const api = async (path, body) => {
  const r = await fetch(path, body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {});
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(j?.error?.code || `HTTP ${r.status}`), { code: j?.error?.code, body: j });
  return j;
};

const state = { status: null, products: [], productId: null, variantId: null, objective: 'Faire découvrir ce produit aux clients de la boutique, pour une publication Instagram.',
  creations: [], currentId: null, revising: false, revisionNote: '', error: null, busy: false };
const STATUS_LABEL = { RUNNING: 'Création en cours…', READY: 'Résultat prêt', REFUSED: 'Création refusée', NO_RESULT: 'Aucun résultat retenu', FAILED: 'Échec' };
const DECISION_LABEL = { ACCEPTED: 'Accepté — non publié', REVISION_REQUESTED: 'Révision demandée', REJECTED: 'Rejeté' };
const REFUSAL = { NO_VERIFIED_SOURCE_IMAGE: 'Nordla n’a trouvé aucune photo vérifiée liée à cette variante. Aucun visuel n’est créé : ajoutez une photo de cette variante dans le catalogue.',
  PROCESSING_NOT_AUTHORIZED: 'La règle de traitement des photos de cette boutique n’est pas en vigueur.', PROVIDER_CALL_REFUSED: 'Les fournisseurs réels sont bloqués (NDR-D02).' };
const refusalText = (e) => { const k = Object.keys(REFUSAL).find((x) => String(e?.reason ?? '').includes(x) || e?.code === x); return k ? REFUSAL[k] : `${e?.code ?? ''} ${e?.reason ?? ''}`.trim(); };

const product = () => state.products.find((p) => p.product_id === state.productId) || null;
const variant = () => product()?.variants.find((v) => v.variant_id === state.variantId) || null;
const current = () => state.creations.find((c) => c.creation_id === state.currentId) || null;

function upsert(c) { const i = state.creations.findIndex((x) => x.creation_id === c.creation_id); if (i >= 0) state.creations[i] = c; else state.creations.unshift(c); }
let pollTimer = null;
function poll() {
  clearTimeout(pollTimer);
  const running = state.creations.filter((c) => c.status === 'RUNNING');
  if (!running.length) return;
  pollTimer = setTimeout(async () => {
    for (const c of running) { try { upsert(await api(`/api/creator/creations/${c.creation_id}`)); } catch { /* retried next tick */ } }
    render(); poll();
  }, 1000);
}

async function create() {
  state.error = null; state.busy = true; render();
  try {
    const c = await api('/api/creator/creations', { product_id: state.productId, variant_id: state.variantId, objective: state.objective });
    upsert(c); state.currentId = c.creation_id; state.revising = false;
  } catch (e) { state.error = e.code || e.message; }
  state.busy = false; render(); poll();
}
async function decide(decision) {
  const c = current(); if (!c) return;
  state.error = null; state.busy = true; render();
  try {
    const r = await api(`/api/creator/creations/${c.creation_id}/decision`, { decision, note: decision === 'REVISE' ? state.revisionNote : undefined });
    upsert(r.creation);
    if (r.revision) { upsert(r.revision); state.currentId = r.revision.creation_id; state.revising = false; state.revisionNote = ''; }
    else if (!r.creation.pending_revision) { state.revising = false; state.revisionNote = ''; }
    state.planNotice = null;
  } catch (e) { if (e.body?.plan) state.planNotice = e.body.plan; else state.error = e.code || e.message; }
  state.busy = false; render(); poll();
}
async function confirmRevision(ok) {
  const c = current(); if (!c) return;
  state.busy = true; render();
  try {
    const r = await api(`/api/creator/creations/${c.creation_id}/revision/${ok ? 'confirm' : 'cancel'}`, {});
    upsert(r.creation); if (r.revision) { upsert(r.revision); state.currentId = r.revision.creation_id; }
    state.revising = false; state.revisionNote = '';
  } catch (e) { state.error = e.code || e.message; }
  state.busy = false; render(); poll();
}
const FR = { 'the text would sit on the product': 'le texte passerait sur le produit', 'the headline is a placeholder, not copy': 'le titre est un texte provisoire', 'the headline states an unverified claim': 'le titre affirme une promesse non vérifiée',
  'the headline may not contain a figure': 'le titre ne peut pas contenir de chiffre', 'the generated scene (same pixels)': 'la scène générée (mêmes pixels)', 'the product photograph (authentic pixels, re-proven)': 'la photo du produit (pixels authentiques, revérifiés)',
  'the concept and art direction': 'le concept et la direction artistique', 'the concept': 'le concept', 'the headline': 'le titre', 'the text position': 'la position du texte', 'the earlier creation (kept in the history)': 'la création précédente (gardée dans l’historique)',
  'the product photograph': 'la photo du produit', headline: 'titre', text_placement: 'position du texte', show_price: 'prix affiché' };
const fr = (s) => FR[s] ?? s;
const eur = (x) => `${String(x ?? 0).replace('.', ',')} €`;
const METHOD_LABEL = { LOCAL_RECOMPOSE: 'retouche locale sur la même scène (sans appel payant)', NEW_SCENE_GENERATION: 'nouvelle scène générée (appel payant au fournisseur d’images)', NEW_CREATIVE_RUN: 'nouvelle création complète' };
function planBox(pl, pending) {
  if (!pl) return null;
  if (pl.method === 'NEEDS_EXACT_INSTRUCTION') return h('p', { class: 'cr-refused', role: 'alert' }, pl.ask === 'EXACT_HEADLINE_WORDING' ? 'Indiquez le titre exact souhaité entre guillemets, par exemple : Remplace le titre par « … ». Aucun coût tant que la modification n’est pas précise.' : 'Indiquez où placer le texte (à gauche, à droite, en haut, en bas).');
  if (pl.refusals?.length) return h('p', { class: 'cr-refused', role: 'alert' }, `Révision impossible sans enfreindre une règle : ${pl.refusals.map((r) => fr(r.reason)).join(' ; ')}. Rien n’a été modifié.`);
  return h('div', { class: 'cr-plan', role: 'note' },
    h('strong', null, 'Plan de révision : '), METHOD_LABEL[pl.method] ?? pl.method, '.',
    h('div', { class: 'cr-small' }, `Coût estimé ${eur(pl.estimated_cost_eur)} (maximum ${eur(pl.worst_case_eur)}) · conservé : ${(pl.preserves ?? []).map(fr).join(', ')}.`),
    pending ? h('div', { class: 'cr-actions' },
      h('button', { id: 'cr-confirm-revision', type: 'button', class: 'btn-ghost', disabled: state.busy, on: { click: () => confirmRevision(true) } }, `Confirmer (≈ ${eur(pl.estimated_cost_eur)}, simulé)`),
      h('button', { type: 'button', class: 'btn-text', on: { click: () => confirmRevision(false) } }, 'Annuler')) : null);
}
const VERIF = (v) => {
  if (!v) return null;
  const pct = (x) => `${String(Math.round(x * 1000) / 10).replace('.', ',')} %`;
  const unreq = (v.unrequested_changes ?? []).map((u) => `${fr(u.field)} (« ${u.before} » → « ${u.after} »)`).join(', ');
  const text = v.outcome === 'APPLIED' ? `Révision vérifiée : ${pct(v.changed_share ?? v.final_changed_share)} de l’image modifiée${v.scene_identical ? ', scène identique' : ''}, produit vérifié pixel à pixel.`
    : v.outcome === 'UNCHANGED' ? `Aucun changement réalisé : ${v.scene_changed === false ? 'la scène est identique' : 'l’image est identique'}. La révision n’a pas abouti${v.scene_changed === false ? ' (le fournisseur simulé renvoie toujours la même scène)' : ''}.`
    : v.outcome === 'APPLIED_WITH_UNREQUESTED_CHANGES' ? 'Révision appliquée, avec des changements non demandés.' : `Révision refusée par les contrôles : ${(v.technical_defects ?? []).join(', ')}`;
  return h('p', { class: `cr-verif cr-verif-${String(v.outcome).toLowerCase()}`, role: 'status' }, text, unreq ? h('span', { class: 'cr-small' }, ` Modifié sans être demandé : ${unreq}.`) : null);
};

// ---------- view ----------
function sidebar() {
  return h('nav', { class: 'sidebar', 'aria-label': 'Navigation' },
    h('div', { class: 'brand' }, h('div', { class: 'brand-mark' }), h('div', { class: 'brand-name' }, 'Nordla AI')),
    h('div', { class: 'nav' }, h('a', { class: 'nav-item active', href: '#/', 'aria-current': 'page' }, h('span', { class: 'ico' }, NordlaIcon.semantic('produits', 'md')), 'Créateur')));
}
function banner() {
  const s = state.status;
  return h('div', { class: 'cr-banner', role: 'note' },
    h('strong', null, 'Démonstration simulée.'),
    ' Les images sont produites par la vraie chaîne Nordla avec des fournisseurs simulés : ce ne sont pas des images générées par un fournisseur réel. Aucun appel payant, rien n’est publié.',
    s?.tenant ? h('span', { class: 'cr-tenant' }, ` Boutique : ${s.tenant}.`) : null);
}
function productCard() {
  const p = product();
  return h('section', { class: 'ex-card cr-card' },
    h('h3', { class: 'cr-step' }, h('span', { class: 'cr-num' }, '1'), 'Produit'),
    h('label', { class: 'cr-label', for: 'cr-product' }, 'Produit du catalogue'),
    h('select', { id: 'cr-product', class: 'cr-select', on: { change: (e) => { state.productId = e.target.value || null; state.variantId = null; render(); } } },
      h('option', { value: '' }, 'Choisir un produit…'),
      state.products.map((x) => h('option', { value: x.product_id, selected: x.product_id === state.productId }, x.title))),
    p ? h('div', null,
      h('div', { class: 'cr-label' }, 'Variante'),
      h('div', { class: 'cr-variants', role: 'radiogroup', 'aria-label': 'Variante' },
        p.variants.map((v) => h('button', { type: 'button', role: 'radio', 'aria-checked': v.variant_id === state.variantId ? 'true' : 'false',
          class: `cr-variant${v.variant_id === state.variantId ? ' on' : ''}`, 'data-variant': v.title, on: { click: () => { state.variantId = v.variant_id; render(); } } },
          h('span', { class: 'cr-variant-name' }, v.title), h('span', { class: 'cr-variant-price' }, v.price)))),
      variant() ? h('p', { class: 'cr-hint' }, 'Nordla récupère automatiquement la photo de cette variante dans le catalogue.') : null) : null);
}
function requestCard() {
  const ready = !!variant() && state.objective.trim() && !state.busy;
  return h('section', { class: 'ex-card cr-card' },
    h('h3', { class: 'cr-step' }, h('span', { class: 'cr-num' }, '2'), 'Demande'),
    h('label', { class: 'cr-label', for: 'cr-objective' }, 'Objectif du visuel'),
    h('textarea', { id: 'cr-objective', class: 'cr-text', rows: '3', maxlength: '500', on: { input: (e) => { state.objective = e.target.value; const b = document.getElementById('cr-create'); if (b) b.disabled = !(variant() && state.objective.trim()); } } }, state.objective),
    h('div', { class: 'cr-actions' }, h('button', { id: 'cr-create', type: 'button', class: 'btn-ghost', disabled: !ready, on: { click: create } }, 'Créer le visuel')));
}
function resultCard() {
  const c = current();
  if (!c) return h('section', { class: 'ex-card cr-card cr-result cr-empty' }, h('h3', { class: 'cr-step' }, h('span', { class: 'cr-num' }, '3'), 'Résultat'), h('p', { class: 'cr-hint' }, 'Choisissez un produit, une variante, puis créez le visuel.'));
  const head = h('div', { class: 'cr-result-head' },
    h('h3', { class: 'cr-step' }, h('span', { class: 'cr-num' }, '3'), 'Résultat'),
    h('span', { class: `ex-chip cr-status cr-st-${c.status.toLowerCase()}` }, c.decision ? DECISION_LABEL[c.decision.decision] : STATUS_LABEL[c.status]));
  const meta = h('p', { class: 'cr-meta' }, `${c.product.title} — ${c.variant.title}`, c.revision_of ? ` · révision de ${c.revision_of}` : '', c.revision_note ? ` · « ${c.revision_note} »` : '');
  let body;
  if (c.status === 'RUNNING') body = h('div', { class: 'cr-running', role: 'status' }, h('span', { class: 'cr-spinner', 'aria-hidden': 'true' }), 'Nordla crée le visuel : photo du catalogue, concept, scène, contrôles techniques…');
  else if (c.status === 'READY') body = h('div', null,
    h('div', { class: 'cr-images' }, c.result.images.map((src, i) => h('figure', { class: 'cr-figure' },
      h('img', { src, alt: `Visuel ${i + 1} — ${c.product.title} ${c.variant.title}`, class: 'cr-img' }),
      h('figcaption', { class: 'cr-caption' }, h('span', { class: 'ex-chip cr-sim' }, 'SIMULÉ'), ' Image de démonstration (fournisseur simulé), pas une image d’un fournisseur réel.')))),
    h('p', { class: 'cr-meta cr-small' }, `Photo source vérifiée ${c.result.media_id} · empreinte ${c.result.source_sha256.slice(0, 12)}… · règle v${c.result.policy_version} · dépense simulée ${c.result.reservation?.status === 'SETTLED' ? `réglée ${String(c.result.reservation.settled_eur).replace('.', ',')} € (plafond ${String(c.result.reservation.ceiling_eur).replace('.', ',')} €)` : (c.result.reservation?.status === 'NO_SPEND' ? 'aucune (retouche locale, sans appel fournisseur)' : (c.result.reservation?.status ?? '—'))} · non publié`),
    VERIF(c.verification),
    c.pending_revision ? planBox(c.pending_revision.plan, true) : null,
    !c.decision && state.planNotice ? planBox(state.planNotice, false) : null,
    c.decision ? h('p', { class: 'cr-decided' }, c.decision.decision === 'ACCEPTED' ? 'Résultat accepté. Il n’est pas publié : aucune publication automatique.' : c.decision.decision === 'REJECTED' ? 'Résultat rejeté.' : 'Révision demandée : une nouvelle création est lancée.')
      : c.pending_revision ? null : decisionBar());
  else body = h('p', { class: 'cr-refused', role: 'alert' }, refusalText(c.error));
  return h('section', { class: 'ex-card cr-card cr-result' }, head, meta, body);
}
function decisionBar() {
  return h('div', { class: 'cr-decision' },
    state.revising ? h('div', { class: 'cr-revise' },
      h('label', { class: 'cr-label', for: 'cr-note' }, 'Ce qu’il faut changer'),
      h('textarea', { id: 'cr-note', class: 'cr-text', rows: '2', maxlength: '500', on: { input: (e) => { state.revisionNote = e.target.value; const b = document.getElementById('cr-send-revision'); if (b) b.disabled = !state.revisionNote.trim(); } } }, state.revisionNote),
      h('p', { class: 'cr-hint' }, 'En démonstration, le fournisseur simulé renvoie la même scène : la demande est enregistrée et relancée, mais seul un fournisseur réel en tiendrait compte.'),
      h('div', { class: 'cr-actions' },
        h('button', { id: 'cr-send-revision', type: 'button', class: 'btn-ghost', disabled: !state.revisionNote.trim() || state.busy, on: { click: () => decide('REVISE') } }, 'Envoyer la révision'),
        h('button', { type: 'button', class: 'btn-text', on: { click: () => { state.revising = false; render(); } } }, 'Annuler')))
      : h('div', { class: 'cr-actions' },
        h('button', { id: 'cr-accept', type: 'button', class: 'btn-ghost', disabled: state.busy, on: { click: () => decide('ACCEPT') } }, 'Accepter'),
        h('button', { id: 'cr-revise', type: 'button', class: 'btn-primary-sm', disabled: state.busy, on: { click: () => { state.revising = true; render(); } } }, 'Demander une révision'),
        h('button', { id: 'cr-reject', type: 'button', class: 'btn-outline', disabled: state.busy, on: { click: () => decide('REJECT') } }, 'Rejeter')));
}
function history() {
  if (state.creations.length < 2) return null;
  return h('section', { class: 'ex-card cr-card' }, h('h3', { class: 'cr-step' }, 'Créations de la session'),
    h('ul', { class: 'cr-history' }, state.creations.map((c) => h('li', null,
      h('button', { type: 'button', class: `cr-history-item${c.creation_id === state.currentId ? ' on' : ''}`, on: { click: () => { state.currentId = c.creation_id; state.revising = false; render(); } } },
        `${c.variant.title} · ${c.decision ? DECISION_LABEL[c.decision.decision] : STATUS_LABEL[c.status]}${c.revision_of ? ' · révision' : ''}`)))));
}
function render() {
  const app = document.getElementById('app');
  const focusId = document.activeElement?.id;
  app.replaceChildren(h('div', { class: 'shell' }, sidebar(),
    h('main', { class: 'main cr-main' },
      h('div', { class: 'topbar' }, h('div', { class: 'topbar-title' }, 'Créateur'), h('div', { class: 'topbar-right' }, h('span', { class: 'ex-chip cr-sim' }, 'Fournisseurs simulés'))),
      banner(),
      state.error ? h('p', { class: 'cr-refused', role: 'alert' }, `Erreur : ${state.error}`) : null,
      h('div', { class: 'cr-grid' }, h('div', { class: 'cr-col' }, productCard(), requestCard(), history()), h('div', { class: 'cr-col' }, resultCard())))));
  if (focusId) { const el = document.getElementById(focusId); if (el?.focus) el.focus(); }
}

(async () => {
  render();
  try { const [s, p] = await Promise.all([api('/api/creator/status'), api('/api/creator/products')]); state.status = s; state.products = p.products; }
  catch (e) { state.error = e.code || e.message; }
  render();
})();
