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
// HOSTED: the page carries the HttpOnly session cookie, and every change carries the CSRF token (cookie __Host-nordla_creator_csrf) in x-nordla-csrf. A local demo server has neither: nothing is sent.
// (hosted: __Host-nordla_creator_csrf; the local loopback mode of the same server: nordla_dev_creator_csrf)
const CSRF_COOKIES = ['__Host-nordla_creator_csrf', '__Host-nordla_sourcing_csrf', 'nordla_dev_creator_csrf'];
const csrf = () => { for (const part of String(document.cookie).split(';')) { const i = part.indexOf('='); if (i > 0 && CSRF_COOKIES.includes(part.slice(0, i).trim())) return part.slice(i + 1).trim(); } return ''; };
const api = async (path, body) => {
  const r = await fetch(path, body ? { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json', ...(csrf() ? { 'x-nordla-csrf': csrf() } : {}) }, body: JSON.stringify(body) } : { credentials: 'same-origin' });
  const j = await r.json().catch(() => ({}));
  const code = typeof j?.error === 'string' ? j.error : j?.error?.code;
  if (r.status === 401 && code === 'SESSION_INVALID') state.needLogin = true;
  if (!r.ok) throw Object.assign(new Error(code || `HTTP ${r.status}`), { code, body: j });
  return j;
};

const state = { source: 'catalog', upload: null, uploadForm: { title: '', price: '', variant: '', features: '' }, uploadBusy: false, status: null, products: [], productId: null, variantId: null, objective: 'Faire découvrir ce produit aux clients de la boutique, pour une publication Instagram.', audience: '', occasion: '', offer: '', audienceUnknown: false,
  existing: [], day: null, creations: [], currentId: null, revising: false, revisionNote: '', error: null, busy: false, needLogin: false, loginError: '' };
const STATUS_LABEL = { AWAITING_AUTHORIZATION: 'En attente de votre autorisation', AWAITING_IMAGE_AUTHORIZATION: 'Concept prêt — autorisation de l’image', CANCELLED: 'Annulé', RUNNING: 'Création en cours…', READY: 'Résultat prêt', REFUSED: 'Création refusée', NO_RESULT: 'Aucun résultat retenu', FAILED: 'Échec' };
const isLive = () => state.status?.live_local === true;
const DECISION_LABEL = { ACCEPTED: 'Accepté — non publié', REVISION_REQUESTED: 'Révision demandée', REJECTED: 'Rejeté' };
const REFUSAL = { NO_VERIFIED_SOURCE_IMAGE: 'Nordla n’a trouvé aucune photo vérifiée liée à cette variante. Aucun visuel n’est créé : ajoutez une photo de cette variante dans le catalogue, ou importez votre propre photo (onglet « Importer une photo »).',
  PHOTO_NOT_USABLE: 'La photo de ce produit ne peut pas être détourée fidèlement (fond non uni ou produit mal séparé du fond). Aucune dépense n’a été proposée. Importez une photo du même produit sur fond blanc uni ou transparent (onglet « Importer une photo »).',
  BUDGET_CEILING_TOO_LOW: 'Le plafond de cette phase est insuffisant pour le pire cas du prochain appel : rien n’a été envoyé pour cet appel. Les dépenses déjà faites restent comptées. Aucune relance automatique.',
  CANCELLED_BY_ADMIN: 'Création annulée par vous.', SPEND_NOT_RESERVED: 'La dépense n’a pas pu être réservée (plafond mensuel ou par tentative).',
  PROCESSING_NOT_AUTHORIZED: 'La règle de traitement des photos de cette boutique n’est pas en vigueur.', PROVIDER_CALL_REFUSED: 'Les fournisseurs réels sont bloqués (NDR-D02).' };
const refusalText = (e) => { if (e?.code === 'AD_NO_CONVINCING_IDEA') return `Creator n’a trouvé aucune idée convaincante pour ce produit (réponse NONE) : aucune image n’a été générée. Sa raison : « ${e.reason} »`; if (e?.code === 'NO_RESULT_PASSED_CHECKS') return `Creator a proposé, mais toutes les propositions ont été écartées par les contrôles techniques : ${e.reason}`; const k = Object.keys(REFUSAL).find((x) => String(e?.reason ?? '').includes(x) || e?.code === x); return k ? REFUSAL[k] : `${e?.code ?? ''} ${e?.reason ?? ''}`.trim(); };

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

const fileToBase64 = (file) => new Promise((resolve, reject) => { const r = new FileReader(); r.onload = () => resolve(String(r.result).split(',')[1] ?? ''); r.onerror = () => reject(new Error('lecture impossible')); r.readAsDataURL(file); });
async function importPhoto() {
  const input = document.getElementById('cr-file'); const file = input?.files?.[0];
  if (!file) { state.error = 'Choisissez une photo.'; return render(); }
  state.error = null; state.uploadBusy = true; render();
  try {
    const f = state.uploadForm;
    const r = await api('/api/creator/uploads', { data_base64: await fileToBase64(file), title: f.title, price: f.price, variant: f.variant, features: f.features.split(',').map((x) => x.trim()).filter(Boolean) });
    state.upload = r;
  } catch (e) { state.error = e.body?.error?.reason || e.code || e.message; }
  state.uploadBusy = false; render();
}
async function authorize(phase, ceiling) {
  const c = current(); if (!c) return;
  state.error = null; state.busy = true; render();
  try { upsert(await api(`/api/creator/creations/${c.creation_id}/authorize`, { phase, ceiling_eur: ceiling, ...(phase === 'IMAGE' && c.ad?.request?.prompt_sha256 ? { request_sha256: c.ad.request.prompt_sha256 } : {}) })); } catch (e) { state.error = e.code || e.message; }
  state.busy = false; render(); poll();
}
async function cancelCreation() {
  const c = current(); if (!c) return;
  state.busy = true; render();
  try { upsert(await api(`/api/creator/creations/${c.creation_id}/cancel`, {})); } catch (e) { state.error = e.code || e.message; }
  state.busy = false; render(); poll();
}
async function create() {
  state.error = null; state.busy = true; render();
  try {
    const campaign = { audience: state.audience, occasion: state.occasion, offer: state.offer, audience_unknown: state.audienceUnknown };
    const body = state.source === 'upload' && state.upload ? { upload_id: state.upload.upload_id, objective: state.objective, ...campaign } : { product_id: state.productId, variant_id: state.variantId, objective: state.objective, ...campaign };
    const c = await api('/api/creator/creations', body);
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

const eur2 = (x) => `${(Math.round(Number(x ?? 0) * 1000) / 1000).toFixed(3).replace(/0$/, '').replace('.', ',')} €`;
function spendLine(c) { return c.spend ? h('p', { class: 'cr-small cr-spend', role: 'status' }, `Dépensé jusqu’ici : ${eur2(c.spend.spent_eur)} sur un plafond de ${eur2(c.spend.attempt_cap_eur)} pour toute la tentative.`) : null; }
function adBox(ad) {
  const chosen = ad.selection?.selection?.concept_id;
  const req = ad.request ?? {};
  return h('div', { class: 'cr-ad' },
    h('strong', null, 'Les quatre propositions de Nordla'),
    h('ul', { class: 'cr-ad-list' }, (ad.proposals ?? []).map((p) => h('li', { class: p.concept_id === chosen ? 'cr-ad-chosen' : '' },
      h('strong', null, `${p.name}${p.concept_id === chosen ? ' — retenue par Nordla' : ''}`), h('span', { class: 'cr-small' }, ` ${p.central_idea}`)))),
    ad.selection?.selection?.reasons ? h('p', { class: 'cr-small' }, `Pourquoi celle-ci : ${ad.selection.selection.reasons}`) : null,
    h('strong', null, 'Ce qui sera envoyé au générateur d’images'),
    h('p', { class: 'cr-small' }, `${(req.sent_fields ?? []).length} éléments de la composition sont transmis tels quels (preuve ${req.proof?.ok ? 'établie' : 'NON établie'}, ${req.proof?.checked ?? 0} éléments vérifiés). Non transmis : ${(req.not_sent ?? []).map((x) => x.field.replace('composition.', '')).join(', ') || 'rien'} (raisonnement et titre : le titre est ajouté après le rendu).`),
    (req.warnings ?? []).length ? h('p', { class: 'cr-refused', role: 'alert' }, `À corriger avant de payer : ${(req.warnings ?? []).map((w) => `${w.field} (${w.wording})`).join(', ')}`) : null,
    h('details', null, h('summary', null, 'Voir le texte exact envoyé'), h('pre', { class: 'cr-prompt' }, req.prompt ?? '')));
}
function adReview(r, c) {
  if (!r) return null;
  return h('div', { class: 'cr-review' },
    r.headline ? h('p', null, h('strong', null, 'Accroche : '), `« ${r.headline} »`, r.concept_name ? ` — proposition « ${r.concept_name} »` : '') : null,
    r.caption ? h('div', { class: 'cr-tocheck', role: 'note' }, h('strong', null, 'Légende Instagram et Facebook (prête à copier)'), h('p', { style: 'white-space:pre-wrap;user-select:all' }, r.caption)) : null,
    r.final_review ? h('div', { class: 'cr-tocheck', role: 'note' }, h('strong', null, `Revue finale de Creator : ${({ PUBLISHABLE: 'publiable', REVISE: 'à corriger', REJECT: 'à refuser', NOT_REVIEWED: 'non relue' })[r.final_review.verdict] ?? r.final_review.verdict}`), r.final_review.reason_to_buy ? h('p', null, h('strong', null, 'Raison d’acheter vue dans l’image : '), r.final_review.reason_to_buy.seen_in_the_picture) : null, ...(r.final_review.reasons ?? []).map((t) => h('p', null, t))) : null,
    r.to_check?.length ? h('div', { class: 'cr-tocheck', role: 'note' }, h('strong', null, 'À vérifier par vous avant d’accepter'), ...r.to_check.map((f) => h('div', null, h('p', null, h('strong', null, `${f.what} : `), f.status), ...(f.actions ?? []).map((a) => h('p', { class: 'cr-small' }, `Action utile : ${a}`))))) : h('p', { class: 'cr-small' }, 'Aucun point à vérifier signalé par les contrôles automatiques (ils ne remplacent pas votre regard).'),
    r.crops && Object.keys(r.crops).length ? h('div', { class: 'cr-crops' }, ...Object.entries(r.crops).filter(([k]) => k !== 'sans-titre').map(([k, src]) => h('figure', { class: 'cr-figure' }, h('img', { src, class: 'cr-img', alt: `Recadrage ${k}` }), h('figcaption', { class: 'cr-caption' }, k === 'appui-300' ? 'Recadrage de l’appui à 300 %' : 'Recadrage de l’appui à 100 %')))) : null);
}
function estimateBox(c) {
  const e = c.estimate; if (!e) return null;
  const isImage = e.phase === 'IMAGE';
  return h('div', { class: 'cr-plan cr-estimate', role: 'note' },
    isImage && c.concept ? h('div', { class: 'cr-concept' },
      h('strong', null, 'Concept proposé'),
      c.concept.central_idea ? h('p', null, c.concept.central_idea) : null,
      c.concept.story ? h('p', { class: 'cr-small' }, c.concept.story) : null,
      c.concept.atmosphere ? h('p', { class: 'cr-small' }, `Ambiance : ${c.concept.atmosphere}`) : null,
      c.concept.headline ? h('p', null, h('strong', null, 'Titre : '), `« ${c.concept.headline} »`) : null) : null,
    isImage && c.ad ? adBox(c.ad) : null,
    h('p', null, h('strong', null, `Phase payante : ${e.label}`)),
    h('p', { class: 'cr-small' }, `Coût attendu ≈ ${eur2(e.expected_eur)} · plafond de cette phase ${eur2(e.max_eur)} · plafond de toute la tentative ${eur2(e.attempt_cap_eur)}${e.spent_eur ? ` · déjà dépensé ${eur2(e.spent_eur)}` : ''}. Le fournisseur facture ; la dépense réelle est vérifiée dans la console du fournisseur.`),
    h('div', { class: 'cr-actions' },
      h('button', { id: `cr-authorize-${e.phase.toLowerCase()}`, type: 'button', class: 'btn-primary-sm', disabled: state.busy || Boolean(c.ad?.request?.warnings?.length), on: { click: () => authorize(e.phase, e.max_eur) } }, `Autoriser jusqu’à ${eur2(e.max_eur)}`),
      h('button', { id: 'cr-cancel', type: 'button', class: 'btn-text', disabled: state.busy, on: { click: cancelCreation } }, 'Annuler sans dépense supplémentaire')));
}

// ---------- view ----------
function sidebar() {
  return h('nav', { class: 'sidebar', 'aria-label': 'Navigation' },
    h('div', { class: 'brand' }, h('div', { class: 'brand-mark' }), h('div', { class: 'brand-name' }, 'Nordla AI')),
    h('div', { class: 'nav' }, h('a', { class: 'nav-item active', href: '#/', 'aria-current': 'page' }, h('span', { class: 'ico' }, NordlaIcon.semantic('produits', 'md')), 'Créateur')));
}
function banner() {
  const s = state.status;
  if (s?.live_local) return h('div', { class: 'cr-banner cr-banner-live', role: 'note' },
    s.simulated_providers ? h('strong', { class: 'cr-demo-label' }, 'SIMULATION — fournisseurs simulés, aucune dépense réelle. Les textes du concept et les images de décor sont des exemples génériques du simulateur ; seuls le produit, son nom, sa variante, son prix et ses caractéristiques viennent du catalogue. ') : null,
    h('strong', null, s.simulated_providers ? 'Mode réel local (parcours identique).' : 'MODE RÉEL LOCAL — dépenses réelles.'),
    ` Cet écran n’est accessible que depuis cet ordinateur. Chaque phase payante est affichée et doit être autorisée par vous avant de démarrer ; le plafond de ${String(s.caps.attempt_eur).replace('.', ',')} € couvre toute la tentative (concept, image et contrôles). Rien n’est publié automatiquement.`,
    s?.tenant ? h('span', { class: 'cr-tenant' }, ` Boutique : ${s.tenant}.`) : null);
  return h('div', { class: 'cr-banner', role: 'note' },
    s?.demo ? h('strong', { class: 'cr-demo-label' }, 'DÉMO — aucune image réelle.') : null,
    h('strong', null, s?.demo ? ' Démonstration simulée.' : 'Démonstration simulée.'),
    ' Les images sont produites par la vraie chaîne Nordla avec des fournisseurs simulés : ce ne sont pas des images générées par un fournisseur réel. Aucun appel payant, rien n’est publié.',
    s?.tenant ? h('span', { class: 'cr-tenant' }, ` Boutique : ${s.tenant}.`) : null);
}
function uploadCard() {
  const f = state.uploadForm; const set = (k) => (e) => { state.uploadForm[k] = e.target.value; };
  return h('div', { class: 'cr-upload' },
    h('label', { class: 'cr-label', for: 'cr-file' }, 'Photo du produit (PNG, JPEG ou WebP, fond uni de préférence)'),
    h('input', { id: 'cr-file', type: 'file', accept: 'image/png,image/jpeg,image/webp', class: 'cr-text' }),
    h('label', { class: 'cr-label', for: 'cr-up-title' }, 'Nom du produit (affiché sur l’annonce)'), h('input', { id: 'cr-up-title', class: 'cr-text', type: 'text', maxlength: '120', value: f.title, on: { input: set('title') } }),
    h('label', { class: 'cr-label', for: 'cr-up-price' }, 'Prix en euros'), h('input', { id: 'cr-up-price', class: 'cr-text', type: 'text', inputmode: 'decimal', maxlength: '12', value: f.price, on: { input: set('price') } }),
    h('label', { class: 'cr-label', for: 'cr-up-variant' }, 'Variante (facultatif, ex. Noir)'), h('input', { id: 'cr-up-variant', class: 'cr-text', type: 'text', maxlength: '60', value: f.variant, on: { input: set('variant') } }),
    h('label', { class: 'cr-label', for: 'cr-up-features' }, 'Caractéristiques à afficher (facultatif, séparées par des virgules, 3 maximum, vérifiées par vous)'), h('input', { id: 'cr-up-features', class: 'cr-text', type: 'text', maxlength: '160', value: f.features, on: { input: set('features') } }),
    h('div', { class: 'cr-actions' }, h('button', { id: 'cr-import', type: 'button', class: 'btn-ghost', disabled: state.uploadBusy, on: { click: importPhoto } }, state.uploadBusy ? 'Import…' : 'Importer la photo')),
    state.upload ? h('p', { class: 'cr-hint', role: 'status' }, `Photo importée : ${state.upload.title} (${state.upload.width_px}×${state.upload.height_px}, empreinte ${state.upload.sha256_prefix}…). Elle n’est envoyée à aucun fournisseur avant votre autorisation.`) : null);
}
function sourceTabs() {
  if (!isLive()) return null;
  const tab = (id, label) => h('button', { type: 'button', id: `cr-src-${id}`, role: 'tab', 'aria-selected': state.source === id ? 'true' : 'false', class: `cr-variant${state.source === id ? ' on' : ''}`, on: { click: () => { state.source = id; render(); } } }, label);
  return h('div', { class: 'cr-variants', role: 'tablist', 'aria-label': 'Source de la photo' }, tab('catalog', 'Catalogue Shopify'), tab('upload', 'Importer une photo'));
}
function productCard() {
  const p = product();
  if (isLive() && state.source === 'upload') return h('section', { class: 'ex-card cr-card' }, h('h3', { class: 'cr-step' }, h('span', { class: 'cr-num' }, '1'), 'Produit'), sourceTabs(), uploadCard());
  return h('section', { class: 'ex-card cr-card' },
    h('h3', { class: 'cr-step' }, h('span', { class: 'cr-num' }, '1'), 'Produit'), sourceTabs(),
    h('label', { class: 'cr-label', for: 'cr-product' }, 'Produit du catalogue'),
    h('select', { id: 'cr-product', class: 'cr-select', on: { change: (e) => { state.productId = e.target.value || null; state.variantId = null; render(); } } },
      h('option', { value: '' }, 'Choisir un produit…'),
      state.products.map((x) => h('option', { value: x.product_id, selected: x.product_id === state.productId }, x.title))),
    p ? h('div', null,
      h('div', { class: 'cr-label' }, 'Variante'),
      h('div', { class: 'cr-variants', role: 'radiogroup', 'aria-label': 'Variante' },
        p.variants.map((v) => h('button', { type: 'button', role: 'radio', 'aria-checked': v.variant_id === state.variantId ? 'true' : 'false',
          class: `cr-variant${v.variant_id === state.variantId ? ' on' : ''}`, 'data-variant': v.title, on: { click: () => { state.variantId = v.variant_id; render(); } } },
          h('span', { class: 'cr-variant-name' }, v.title === 'Default Title' ? 'Modèle unique' : v.title), h('span', { class: 'cr-variant-price' }, v.price)))),
      variant() ? h('p', { class: 'cr-hint' }, 'Nordla récupère automatiquement la photo de cette variante dans le catalogue.') : null) : null);
}
function requestCard() {
  const hasSource = isLive() && state.source === 'upload' ? !!state.upload : !!variant();
  const adRoute = isLive() && Boolean(state.status?.route);
  const ready = hasSource && state.objective.trim() && !state.busy && (!adRoute || state.audience.trim() || state.audienceUnknown);
  const refresh = () => { const b = document.getElementById('cr-create'); if (b) b.disabled = !(hasSource && state.objective.trim() && !state.busy && (!adRoute || state.audience.trim() || state.audienceUnknown)); };
  return h('section', { class: 'ex-card cr-card' },
    h('h3', { class: 'cr-step' }, h('span', { class: 'cr-num' }, '2'), 'Demande'),
    h('label', { class: 'cr-label', for: 'cr-objective' }, 'Objectif du visuel'),
    h('textarea', { id: 'cr-objective', class: 'cr-text', rows: '3', maxlength: '500', on: { input: (e) => { state.objective = e.target.value; const b = document.getElementById('cr-create'); if (b) b.disabled = !((isLive() && state.source === 'upload' ? state.upload : variant()) && state.objective.trim()); } } }, state.objective),
    adRoute ? h('div', { class: 'cr-campaign' },
      h('label', { class: 'cr-label', for: 'cr-audience' }, 'Public de la campagne (obligatoire)'),
      h('textarea', { id: 'cr-audience', class: 'cr-text', rows: '2', maxlength: '400', on: { input: (e) => { state.audience = e.target.value; refresh(); } } }, state.audience),
      h('label', { class: 'cr-check' }, h('input', { id: 'cr-audience-unknown', type: 'checkbox', checked: state.audienceUnknown, on: { change: (e) => { state.audienceUnknown = e.target.checked; refresh(); } } }), ' Le public n’est pas défini (Nordla s’adressera aux clients de la boutique en général)'),
      h('label', { class: 'cr-label', for: 'cr-occasion' }, 'Occasion (facultatif)'),
      h('input', { id: 'cr-occasion', class: 'cr-text', maxlength: '400', value: state.occasion, on: { input: (e) => { state.occasion = e.target.value; } } }),
      h('label', { class: 'cr-label', for: 'cr-offer' }, 'Offre (facultatif)'),
      h('input', { id: 'cr-offer', class: 'cr-text', maxlength: '400', value: state.offer, on: { input: (e) => { state.offer = e.target.value; } } }),
      h('p', { class: 'cr-hint' }, 'Nordla propose les idées, choisit, compose l’annonce (décor, lumière, placement, accroche). Vous ne fournissez ni idée ni consigne d’image.')) : null,
    h('div', { class: 'cr-actions' }, h('button', { id: 'cr-create', type: 'button', class: 'btn-ghost', disabled: !ready, on: { click: create } }, isLive() ? 'Préparer la création (aucune dépense)' : 'Créer le visuel')));
}
function resultCard() {
  const c = current();
  if (!c) return h('section', { class: 'ex-card cr-card cr-result cr-empty' }, h('h3', { class: 'cr-step' }, h('span', { class: 'cr-num' }, '3'), 'Résultat'), h('p', { class: 'cr-hint' }, 'Choisissez un produit, une variante, puis créez le visuel.'));
  const head = h('div', { class: 'cr-result-head' },
    h('h3', { class: 'cr-step' }, h('span', { class: 'cr-num' }, '3'), 'Résultat'),
    h('span', { class: `ex-chip cr-status cr-st-${c.status.toLowerCase()}` }, c.decision ? DECISION_LABEL[c.decision.decision] : STATUS_LABEL[c.status]));
  const meta = h('p', { class: 'cr-meta' }, `${c.product.title} — ${c.variant.title}`, c.revision_of ? ` · révision de ${c.revision_of}` : '', c.revision_note ? ` · « ${c.revision_note} »` : '');
  let body;
  if (c.status === 'AWAITING_AUTHORIZATION' || c.status === 'AWAITING_IMAGE_AUTHORIZATION') body = h('div', null, estimateBox(c), spendLine(c));
  else if (c.status === 'RUNNING') body = h('div', null, h('div', { class: 'cr-running', role: 'status' }, h('span', { class: 'cr-spinner', 'aria-hidden': 'true' }), 'Nordla crée le visuel : photo, concept, scène, contrôles techniques…'), spendLine(c));
  else if (c.status === 'READY' && c.origin === 'EXISTING_VISUAL') body = existingBody(c);
  else if (c.status === 'READY') body = h('div', null,
    h('div', { class: 'cr-images' }, c.result.images.map((src, i) => h('figure', { class: c.demo ? 'cr-figure cr-demo' : 'cr-figure' },
      h('img', { src, alt: `Visuel ${i + 1} — ${c.product.title} ${c.variant.title}`, class: 'cr-img' }),
      h('figcaption', { class: 'cr-caption' }, c.live_local && !c.simulated ? [h('span', { class: 'ex-chip cr-sim' }, 'RÉEL'), ' Image générée avec le fournisseur réel ; le produit est la photo authentique, vérifiée pixel à pixel. À contrôler avant de l’accepter.'] : [h('span', { class: 'ex-chip cr-sim' }, c.demo ? 'DÉMO' : 'SIMULATION'), ' SIMULATION : image de démonstration produite par un fournisseur simulé, pas par un fournisseur réel. Le produit, son nom, sa variante et son prix viennent du catalogue.'])))),
    c.result.mobile_images?.some(Boolean) ? h('div', { class: 'cr-mobile' }, h('strong', null, 'Aperçu sur téléphone'), ...c.result.mobile_images.filter(Boolean).map((src) => h('img', { src, class: 'cr-img cr-mobile-img', alt: 'Aperçu de l’annonce sur un téléphone (390 px de large)' }))) : null,
    ...(c.result.ad_results ?? []).map((r) => adReview(r, c)),
    spendLine(c),
    h('p', { class: 'cr-meta cr-small' }, `Photo source vérifiée ${c.result.media_id} · empreinte ${c.result.source_sha256.slice(0, 12)}… · règle v${c.result.policy_version} · dépense ${c.live_local && !c.simulated ? 'réelle (application)' : 'simulée'} ${c.result.reservation?.status === 'SETTLED' ? `réglée ${String(c.result.reservation.settled_eur).replace('.', ',')} € (plafond ${String(c.result.reservation.ceiling_eur).replace('.', ',')} €)` : (c.result.reservation?.status === 'NO_SPEND' ? 'aucune (retouche locale, sans appel fournisseur)' : (c.result.reservation?.status ?? '—'))} · non publié`),
    VERIF(c.verification),
    c.pending_revision ? planBox(c.pending_revision.plan, true) : null,
    !c.decision && state.planNotice ? planBox(state.planNotice, false) : null,
    c.exports?.length ? h('div', { class: 'cr-actions' }, c.exports.map((href, i) => h('a', { class: 'btn-primary-sm', href, download: '', id: `cr-export-${i}` }, c.exports.length > 1 ? `Exporter l’image ${i + 1} (PNG)` : 'Exporter l’image (PNG)'))) : null,
    c.decision ? h('p', { class: 'cr-decided' }, c.decision.decision === 'ACCEPTED' ? 'Résultat accepté. Il n’est pas publié : aucune publication automatique.' : c.decision.decision === 'REJECTED' ? 'Résultat rejeté.' : 'Révision demandée : une nouvelle création est lancée.')
      : c.pending_revision ? null : decisionBar());
  else body = h('p', { class: 'cr-refused', role: 'alert' }, refusalText(c.error));
  return h('section', { class: 'ex-card cr-card cr-result' }, head, meta, body);
}
const eur4 = (x) => `${(Math.round(Number(x ?? 0) * 10000) / 10000).toFixed(4).replace('.', ',')} €`;
async function openExisting(id) {
  state.busy = true; state.error = null; render();
  try { const c = await api(`/api/creator/existing-visuals/${id}/draft`, {}); upsert(c); state.currentId = c.creation_id; }
  catch (e) { state.error = `${e.code || e.message}${e.body?.error?.problems ? ` : ${e.body.error.problems.join(', ')}` : ''}`; }
  state.busy = false; render();
}
function existingCard() {
  if (!isLive() || !state.existing.length) return null;
  return h('section', { class: 'ex-card cr-card', id: 'cr-existing' }, h('h3', { class: 'cr-step' }, 'Visuels HABB existants'),
    h('p', { class: 'cr-hint' }, 'Un visuel que HABB a déjà, avec l’accroche et la légende écrites par Creator : aucune image n’est générée, aucune dépense nouvelle.'),
    h('ul', { class: 'cr-history' }, state.existing.map((v) => h('li', null, h('button', { type: 'button', class: 'btn-ghost', id: `cr-open-${v.id}`, disabled: state.busy, on: { click: () => openExisting(v.id) } }, `Ouvrir le brouillon : ${v.subject_label}`)))));
}
// the draft of an EXISTING visual: the visual, the headline and caption Creator wrote, the label the image carries, and the cost WITH its source (the archived call), counted once
function existingBody(c) {
  const rs = c.result.ad_results ?? []; const r = rs[0] ?? {}; const x = c.existing ?? {}; const k = x.cost ?? {};
  return h('div', null,
    h('div', { class: 'cr-images' }, c.result.images.map((src, i) => h('figure', { class: 'cr-figure' }, h('img', { src, alt: `Visuel HABB existant — ${x.mention ?? ''}${rs[i]?.label ? ` — ${rs[i].label}` : ''}`, class: 'cr-img', ...(i === 0 ? { id: 'cr-existing-img' } : {}) }),
      h('figcaption', { class: 'cr-caption' }, h('span', { class: 'ex-chip cr-sim' }, 'BROUILLON'), rs[i]?.label ? h('strong', null, ` ${rs[i].label}`) : null, ` Visuel HABB existant, présenté tel quel comme « ${x.mention} » : aucune image générée.${i === 0 ? ` ${x.image_origin ?? ''}` : ''}`, rs[i]?.layout ? h('span', { class: 'cr-small' }, ` ${rs[i].layout}.`) : null, rs[i]?.unverified ? h('span', { class: 'cr-small' }, ` À vérifier : ${rs[i].unverified}.`) : null)))),
    h('div', { class: 'cr-review' },
      r.headline ? h('p', { id: 'cr-existing-headline' }, h('strong', null, 'Accroche (écrite par Creator) : '), `« ${r.headline} »`) : null,
      ...rs.filter((x2) => x2.caption).map((x2, i) => h('div', { class: 'cr-tocheck', role: 'note' }, h('strong', null, `Légende ${x2.platform === 'TIKTOK' ? 'TikTok' : 'Instagram et Facebook'} (${x2.caption_source === 'CREATOR_TEXT_REUSED_NOT_YET_ADAPTED' ? 'texte de Creator réutilisé, pas encore adapté pour TikTok' : 'écrite par Creator, prête à copier'})`), h('p', { ...(i === 0 ? { id: 'cr-existing-caption' } : {}), class: 'cr-day-caption' }, x2.caption))),
      h('div', { class: 'cr-tocheck', role: 'note', id: 'cr-existing-cost' }, h('strong', null, `Coût : ${eur4(k.settled_eur)} (texte de Creator) · image : 0 €`),
        h('p', { class: 'cr-small' }, `Cet appel texte archivé (${k.model ?? 'modèle'}, empreinte ${String(k.archived_request_sha256 ?? '').slice(0, 12)}…) a été rapproché du registre (ligne ${k.ledger_run_id}), une seule fois : l’ouvrir de nouveau ne le compte pas deux fois. Aucune dépense nouvelle.`)),
      h('div', { class: 'cr-tocheck', role: 'note' }, h('strong', null, 'À vérifier par vous avant d’accepter'),
        h('p', { class: 'cr-small' }, `Prix 25 € : ${x.price_source ?? ''}. Aucun modèle de téléphone, aucun délai, aucun stock n’est annoncé. L’image est un exemple (rendu), pas une réalisation client.`))),
    c.decision?.decision === 'ACCEPTED' ? h('div', { class: 'cr-actions' }, rs.filter((x2) => x2.export_href).map((x2) => h('a', { class: 'btn-primary-sm', href: x2.export_href, download: '', id: 'cr-export-jpeg' }, `Exporter ${x2.platform === 'TIKTOK' ? 'TikTok' : ''} en ${x2.export_format ?? 'JPEG'}`)), c.exports?.map((href, i) => h('a', { class: 'btn-primary-sm', href, download: '' }, `Exporter l’image ${i + 1} (PNG)`))) : null,
    c.decision ? h('p', { class: 'cr-decided' }, c.decision.decision === 'ACCEPTED' ? 'Brouillon accepté. Il n’est pas publié : aucune publication automatique.' : 'Brouillon rejeté.') : h('div', { class: 'cr-decision' }, h('div', { class: 'cr-actions' },
      h('button', { id: 'cr-accept', type: 'button', class: 'btn-ghost', disabled: state.busy, on: { click: () => decide('ACCEPT') } }, 'Valider le brouillon (sans publier)'),
      h('button', { id: 'cr-reject', type: 'button', class: 'btn-outline', disabled: state.busy, on: { click: () => decide('REJECT') } }, 'Rejeter'))));
}
// THE DAY OF CONTENT (up to two distinct subjects, prepared by `habb-next-ad.mjs --day`): the drafts first, each with its previews and its caption; a subject that needs a paid generation shows its cost and waits for the owner's GO
async function openCostScreen(item) {
  state.busy = true; state.error = null; render();
  try { const p = item.product; const c = await api('/api/creator/creations', { product_id: p.product_id, variant_id: p.variant_id, objective: p.campaign.objective, audience: p.campaign.audience, occasion: p.campaign.occasion, offer: p.campaign.offer, permissions: p.campaign.permissions ?? [] }); upsert(c); state.currentId = c.creation_id; }
  catch (e) { state.error = e.code || e.message; }
  state.busy = false; render();
}
function dayCard() {
  const d = state.day; if (!isLive() || !d?.items) return null;
  const slot = (i) => {
    if (i.state === 'READY_DRAFT') {
      const c = state.creations.find((x) => x.creation_id === i.creation_id); const rs = c?.result?.ad_results ?? []; const imgs = c?.result?.images ?? [];
      return h('section', { class: 'ex-card cr-card', id: `cr-day-slot-${i.slot}` }, h('h3', { class: 'cr-step' }, h('span', { class: 'cr-num' }, i.slot === 'file' ? '↻' : String(i.slot)), i.subject), h('span', { class: 'ex-chip cr-sim' }, c?.decision ? DECISION_LABEL[c.decision.decision] : (i.slot === 'file' ? 'Dans la file — en attente de votre validation' : 'Brouillon prêt à valider')),
        h('div', { class: 'cr-day-thumbs' }, imgs.map((src, k) => h('figure', { class: 'cr-day-fig' }, h('img', { src, class: 'cr-day-thumb', alt: `Aperçu ${rs[k]?.label ?? ''}` }), h('figcaption', { class: 'cr-small' }, rs[k]?.label ?? '')))),
        rs[0]?.headline ? h('p', null, h('strong', null, 'Accroche : '), `« ${rs[0].headline} »`) : null,
        ...rs.filter((r) => r.caption).map((r) => h('div', { class: 'cr-tocheck', role: 'note' }, h('strong', null, `Légende ${r.platform === 'TIKTOK' ? 'TikTok' : 'Instagram et Facebook'}${r.caption_source === 'CREATOR_TEXT_REUSED_NOT_YET_ADAPTED' ? ' (texte de Creator réutilisé, pas encore adapté)' : ''}`), h('p', { class: 'cr-day-caption' }, r.caption))),
        h('p', { class: 'cr-small' }, `Coût : ${eur4(i.cost?.settled_eur)} (texte de Creator déjà réglé) · image : 0 € · ${i.units} unité(s) vendue(s) sur la famille dans la fenêtre.`),
        h('div', { class: 'cr-actions' }, h('button', { type: 'button', class: 'btn-ghost', id: `cr-day-open-${i.slot}`, on: { click: () => { state.currentId = i.creation_id; state.revising = false; render(); document.querySelector('.cr-result')?.scrollIntoView({ block: 'start' }); } } }, 'Ouvrir pour valider')));
    }
    return h('section', { class: 'ex-card cr-card', id: `cr-day-slot-${i.slot}` }, h('h3', { class: 'cr-step' }, h('span', { class: 'cr-num' }, String(i.slot)), i.subject), h('span', { class: 'ex-chip cr-sim' }, 'À préparer — en attente de votre GO'),
      h('p', null, 'Ce sujet exige une génération payante : un texte de Creator puis un rendu. Rien n’est lancé.'),
      h('p', { class: 'cr-small' }, `${i.units} unité(s) vendue(s) dans la fenêtre, ${i.product.stock} en stock vendable. Fiche produit : ${i.product.sheet === 'BUILT_NOT_CONFIRMED_BY_THE_OWNER' ? 'construite depuis le texte Shopify, non confirmée par vous' : i.product.sheet}.`),
      h('p', { class: 'cr-small' }, `Coût annoncé ≈ ${eur4(i.cost.expected_eur)} · plafond de la tentative ${eur4(i.cost.ceiling_eur)} (texte au plus ${eur4(i.cost.text_ceiling_eur)}). ${i.cost.note}`),
      h('div', { class: 'cr-actions' }, h('button', { type: 'button', class: 'btn-ghost', id: `cr-day-cost-${i.slot}`, disabled: state.busy, on: { click: () => openCostScreen(i) } }, 'Ouvrir l’écran de coût (aucune dépense)')));
  };
  return h('section', { class: 'cr-day', id: 'cr-day' }, h('h3', { class: 'cr-step' }, `Journée de contenu — ${d.date}`), h('p', { class: 'cr-hint' }, `${d.sentence} Instagram et TikTok. Rien n’est publié : la publication reste soumise à votre accord.`), h('div', { class: 'cr-day-slots' }, d.items.map(slot), (d.queue_items ?? []).map((q) => slot({ ...q, slot: 'file' })), d.free_slots > 0 ? h('section', { class: 'ex-card cr-card', id: 'cr-day-free' }, h('h3', { class: 'cr-step' }, `${d.free_slots} créneau${d.free_slots > 1 ? 'x' : ''} libre${d.free_slots > 1 ? 's' : ''}`), h('p', { class: 'cr-hint' }, d.free_slots_why ?? 'Aucun autre sujet ne convient.')) : null));
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
async function signIn() {
  const email = document.getElementById('cr-login-email')?.value.trim() ?? ''; const password = document.getElementById('cr-login-password')?.value ?? '';
  if (!email || !password) { state.loginError = 'Indiquez votre adresse e-mail et votre mot de passe.'; return render(); }
  state.busy = true; state.loginError = ''; render();
  try {
    const r = await fetch('/api/auth/login', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password }) });
    const b = await r.json().catch(() => ({}));
    if (r.ok && b.ok) { state.needLogin = false; state.busy = false; return load(); }
    state.loginError = b.message ?? 'Connexion impossible.';
  } catch { state.loginError = 'Le serveur ne répond pas.'; }
  state.busy = false; render();
}
function loginCard() {
  return h('section', { class: 'card cr-card cr-login' }, h('h2', null, 'Connexion'), h('p', { class: 'cr-hint' }, 'Connectez-vous avec votre compte Nordla pour utiliser le Créateur.'),
    state.loginError ? h('p', { class: 'cr-refused', role: 'alert' }, state.loginError) : null,
    h('label', { class: 'cr-label', for: 'cr-login-email' }, 'Adresse e-mail'), h('input', { id: 'cr-login-email', class: 'cr-text', type: 'email', autocomplete: 'username' }),
    h('label', { class: 'cr-label', for: 'cr-login-password' }, 'Mot de passe'), h('input', { id: 'cr-login-password', class: 'cr-text', type: 'password', autocomplete: 'current-password' }),
    h('button', { id: 'cr-login-go', type: 'button', class: 'btn-primary-sm', disabled: state.busy, on: { click: signIn } }, state.busy ? 'Connexion…' : 'Se connecter'));
}
function render() {
  const app = document.getElementById('app');
  const focusId = document.activeElement?.id;
  if (state.needLogin) { app.replaceChildren(h('div', { class: 'shell' }, h('main', { class: 'main cr-main' }, h('div', { class: 'topbar' }, h('div', { class: 'topbar-title' }, 'Créateur')), loginCard()))); return; }
  app.replaceChildren(h('div', { class: 'shell' }, sidebar(),
    h('main', { class: 'main cr-main' },
      h('div', { class: 'topbar' }, h('div', { class: 'topbar-title' }, 'Créateur'), h('div', { class: 'topbar-right' }, h('span', { class: 'ex-chip cr-sim' }, isLive() ? (state.status?.simulated_providers ? 'SIMULATION · local' : 'RÉEL · local') : state.status?.demo ? 'DÉMO · fournisseurs simulés' : 'Fournisseurs simulés'))),
      banner(),
      state.error ? h('p', { class: 'cr-refused', role: 'alert' }, `Erreur : ${state.error}`) : null,
      dayCard(),
      h('div', { class: 'cr-grid' }, h('div', { class: 'cr-col' }, existingCard(), productCard(), requestCard(), history()), h('div', { class: 'cr-col' }, resultCard())))));
  if (focusId) { const el = document.getElementById(focusId); if (el?.focus) el.focus(); }
}

async function load() {
  try {
    const [s, p, h] = await Promise.all([api('/api/creator/status'), api('/api/creator/products'), api('/api/creator/creations').catch(() => ({ creations: [] }))]);
    state.status = s; state.existing = s.live_local ? (await api('/api/creator/existing-visuals').catch(() => ({ visuals: [] }))).visuals : []; state.day = s.live_local ? (await api('/api/creator/day').catch(() => ({ plan: null }))).plan : null; state.products = p.products; state.creations = h.creations ?? []; if (state.creations.length) { const pending = state.creations.findLast((c) => c.origin === 'EXISTING_VISUAL' && c.status === 'READY' && !c.decision); state.currentId = (pending ?? state.creations.at(-1)).creation_id; } // a draft waiting for the owner is shown first
  }
  catch (e) { state.error = state.needLogin ? null : (e.code || e.message); }
  render();
}
(async () => {
  render();
  // a HOSTED server answers /api/auth/session ({ mode: 'session' }); a local demo server has no such route and goes straight to the screen
  try { const r = await fetch('/api/auth/session', { credentials: 'same-origin', headers: { accept: 'application/json' } }); const b = r.ok ? await r.json() : null; if (b?.mode === 'session' && !b.authenticated) { state.needLogin = true; return render(); } } catch { /* no auth route: local demo */ }
  await load();
})();
