// Nordla Achats - phone app. Plain ES modules, no build step, no framework, no innerHTML with data (everything is built with textContent: nothing a supplier name
// contains can run as code). French UI.
import { initToken, getToken, forgetToken, request, getJson, photoUrl, setStatusListener, HOSTED } from './api.js';
import * as outbox from './outbox.js';
import { createV1Screens } from './screens-v1.js';
import { buildQuotePayload, parseDecimal, parseInteger, microToString, fmtMoney, fmtDate, PO_STATUS_FR, PO_GROUPS, poActions, describeOffer, addToCart, CURRENCIES, fxPlausibility, receiptLinesFrom, precisionWarning, currenciesOf, errText, ERRORS_FR } from './logic.js';

const $ = (id) => document.getElementById(id);
const main = $('main');
const FX_KEY = 'nordla.proc.fx'; const CART_KEY = 'nordla.proc.cart';
const safe = (fn, d = null) => { try { return fn(); } catch { return d; } };
const safeAsync = async (fn, d = null) => { try { return await fn(); } catch { return d; } };
const load = (k, d) => safe(() => JSON.parse(localStorage.getItem(k) ?? 'null'), null) ?? d;
const save = (k, v) => safe(() => localStorage.setItem(k, JSON.stringify(v)));
const today = () => new Date().toISOString().slice(0, 10);
const uid = (p = 'k') => `${p}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

function h(tag, attrs = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === false || v == null) continue;
    if (k === 'class') e.className = v; else if (k.startsWith('on')) e.addEventListener(k.slice(2), v); else if (k === 'value') e.value = v; else e.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat(Infinity)) if (kid != null && kid !== false) e.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  return e;
}

/** append / replaceChildren that skip null, false and nested arrays (the DOM would print "null"). */
const put = (el, ...kids) => el.append(...kids.flat(Infinity).filter((k) => k != null && k !== false));
const swap = (el, ...kids) => el.replaceChildren(...kids.flat(Infinity).filter((k) => k != null && k !== false));

// ------------------------------------------------------------------ state, navigation
const S = { me: null, tab: 'visits', stack: [], online: true, lastError: null };

function banner(text, kind = '') { const b = $('banner'); b.textContent = text ?? ''; b.hidden = !text; b.className = `banner ${kind}`; if (text && kind !== 'err') setTimeout(() => { if (b.textContent === text) b.hidden = true; }, 6000); }
function setHead(title, subtitle = '', back = false) { $('title').textContent = title; $('subtitle').textContent = subtitle; $('back').hidden = !back; }
function go(name, params = {}) { S.stack.push({ name, params }); render(); }
function back() { S.stack.pop(); render(); }
function tab(t) { S.tab = t; S.stack = []; render(); }
$('back').addEventListener('click', back);
document.querySelectorAll('.tabs button').forEach((b) => b.addEventListener('click', () => tab(b.dataset.tab)));

function netBadge() {
  const n = outbox.pending().length; const r = outbox.rejected().length; const b = $('net');
  if (r) { b.textContent = `${r} à corriger`; b.className = 'badge b-off'; } else if (n) { b.textContent = `${n} en attente d’envoi`; b.className = 'badge b-wait'; } else if (!S.online) { b.textContent = 'Hors connexion'; b.className = 'badge b-off'; } else { b.textContent = 'En ligne'; b.className = 'badge b-live'; }
  b.onclick = () => { S.tab = 'orders'; S.stack = [{ name: 'outbox', params: {} }]; render(); };
}
function offlineBanner() {
  const el = $('offline'); const up = S.online;
  el.hidden = up;
  $('offline-text').textContent = 'Connexion au serveur indisponible. Les données affichées peuvent être anciennes ; vos saisies restent sur ce téléphone et partiront au retour de la connexion. Approuver, commander et réceptionner sont impossibles pour l’instant.';
}
$('offline-retry').addEventListener('click', async () => { const r = await request('GET', '/api/health'); if (r.status === 200) { await outbox.flush({ force: true }).then(refreshAfterSend); render(); } else banner('Toujours pas de connexion.', 'err'); });
setStatusListener((status) => { const was = S.online; S.online = status !== 0 && status < 502; netBadge(); offlineBanner(); if (!was && S.online) outbox.flush({ force: true }).then(refreshAfterSend); });
outbox.onOutboxChange(netBadge);
window.addEventListener('online', () => outbox.flush({ force: true }).then(refreshAfterSend));
window.addEventListener('offline', () => { S.online = false; netBadge(); offlineBanner(); });
setInterval(() => { if (outbox.pending().length) outbox.flush().then(refreshAfterSend); }, 15_000);
function refreshAfterSend(sent) { if (sent) { banner(`${sent} saisie${sent > 1 ? 's' : ''} envoyée${sent > 1 ? 's' : ''} au serveur.`, 'ok'); render(); } }

// ------------------------------------------------------------------ small widgets
function thumb(ref, cls = 'thumb') {
  const img = h('img', { class: cls, alt: '', loading: 'lazy' });
  const box = h('div', { class: `${cls} missing`, title: 'Photo non disponible sur le serveur' }, 'photo sur le téléphone du terrain');
  photoUrl(ref).then((u) => { if (u) img.src = u; else img.replaceWith(box); });
  return img;
}
const chip = (t, k = '') => h('span', { class: `chip ${k}` }, t);
const empty = (t) => h('p', { class: 'empty' }, t);
const stale = (res) => (res.stale ? h('div', { class: 'note' }, `Connexion indisponible : données du ${fmtDate(res.at)} à ${new Date(res.at).toLocaleTimeString('fr-BE', { hour: '2-digit', minute: '2-digit' })}.`) : null);
const fail = (res) => h('div', { class: 'warn' }, res.status === 401 ? ERRORS_FR.UNAUTHORIZED : res.status === 0 ? 'Impossible de joindre le serveur (connexion coupée ou lente) et aucune donnée précédente n’est gardée pour cet écran.' : `Impossible de charger : ${res.error ?? res.status}`, res.status === 401 ? null : h('div', {}, h('button', { class: 'btn sec', onclick: () => render() }, 'Réessayer')));
function field(label, input, hint) { return h('div', {}, h('label', {}, label), input, hint ? h('div', { class: 'small muted' }, hint) : null); }
function select(options, value) { return h('select', {}, options.map(([v, t]) => h('option', { value: v, selected: v === value }, t))); }

// V1 screens (suppliers, adjustments, transfers, inventories, filed changes, history): same helpers, own file
const V1 = createV1Screens({ h, put, swap, go, S, request, getJson, uid, banner, setHead, field, select, chip, empty, fail, stale, fmtMoney, render, main });

// ------------------------------------------------------------------ screens
async function screenVisits() {
  setHead('Visites', 'Fournisseurs rencontrés');
  const box = h('div', {}); swap(main, box);
  const res = await getJson('/api/visits');
  if (!res.data) { put(box, fail(res)); return; }
  put(box, stale(res), pendingNote(),
    h('button', { class: 'btn fab', onclick: () => go('newVisit') }, '＋ Nouvelle visite'),
    res.data.visits.length ? h('ul', { class: 'list' }, res.data.visits.map((v) => h('li', {}, h('button', { class: 'tap', onclick: () => go('visit', { id: v.id }) }, h('div', { class: 'grow' }, h('div', { class: 'nm' }, v.supplier), h('div', { class: 'sub' }, `${fmtDate(v.date)}${v.place ? ` · ${v.place}` : ''} · ${v.products} produit${v.products > 1 ? 's' : ''}`)), chip(v.status === 'OPEN' ? 'ouverte' : 'clôturée', v.status === 'OPEN' ? 'g' : ''))))) : empty('Aucune visite pour l’instant. Appuyez sur « Nouvelle visite » chez un fournisseur.'),
    h('button', { class: 'btn sec', onclick: () => go('import') }, 'Importer depuis China Sourcing'));
}
function pendingNote() { const n = outbox.pending().length + outbox.rejected().length; return n ? h('button', { class: 'btn sec', onclick: () => go('outbox') }, `Saisies sur ce téléphone, pas encore envoyées : ${n}`) : null; }

function screenNewVisit() {
  setHead('Nouvelle visite', '', true);
  const key = uid('visit'); const sup = h('input', { placeholder: 'Nom du fournisseur', autocomplete: 'off' }); const cur = select(CURRENCIES.map((c) => [c, c]), 'CNY');
  const date = h('input', { type: 'date', value: today() }); const place = h('input', { placeholder: 'Hall, stand, usine…' }); const note = h('textarea', { placeholder: 'Contexte, contact rencontré…' });
  const err = h('div', {}); let busy = false;
  const btn = h('button', { class: 'btn', onclick: async () => {
    if (busy) return; err.replaceChildren();
    if (!sup.value.trim()) return put(err, h('div', { class: 'warn' }, 'Le nom du fournisseur est nécessaire.'));
    busy = true; btn.disabled = true;
    const r = await request('POST', '/api/visits', { key, body: { supplierName: sup.value.trim(), currency: cur.value, date: date.value, place: place.value.trim() || undefined, note: note.value.trim() || undefined } });
    busy = false; btn.disabled = false;
    if (r.status === 200 || r.status === 201) { S.stack.pop(); go('visit', { id: r.json.visit.id }); } else put(err, h('div', { class: 'warn' }, r.status === 0 ? 'Une connexion est nécessaire pour démarrer une visite. Les produits, eux, sont gardés sur le téléphone si la connexion tombe ensuite.' : errText(r)));
  } }, 'Démarrer la visite');
  swap(main, h('div', { class: 'card' }, field('Fournisseur', sup), field('Devise des prix', cur, 'La devise dans laquelle il vous donne ses prix.'), field('Date', date), field('Lieu', place), field('Note', note), err, btn));
}

async function screenVisit({ id }) {
  setHead('Visite', '', true);
  const box = h('div', {}); swap(main, box);
  const res = await getJson(`/api/visits/${id}`);
  if (!res.data) return put(box, fail(res));
  const v = res.data; setHead(v.supplier.name, `${fmtDate(v.date)}${v.place ? ` · ${v.place}` : ''}`, true);
  const queued = outbox.list().filter((x) => x.meta?.visitId === id);
  put(box, stale(res),
    v.status === 'OPEN' ? h('button', { class: 'btn fab', onclick: () => go('capture', { visit: v }) }, '＋ Produit') : h('div', { class: 'note' }, 'Visite clôturée.'),
    queued.length ? h('div', { class: 'card' }, h('h2', {}, 'Sur ce téléphone, en attente d’envoi'), h('ul', { class: 'list' }, queued.map((x) => h('li', { class: x.state === 'REJECTED' ? 'warn' : 'note' }, `${x.label} — ${x.state === 'REJECTED' ? `refusé : ${x.error}` : x.error ?? 'envoi en cours'}`))), h('button', { class: 'btn sec', onclick: () => go('outbox') }, 'Voir / corriger')) : null,
    v.entries.length ? h('ul', { class: 'list' }, v.entries.map((e) => h('li', {}, h('div', { class: 'tap' }, e.photo ? thumb(e.photo) : h('div', { class: 'thumb' }), h('div', { class: 'grow' }, h('div', { class: 'nm' }, e.name), h('div', { class: 'sub' }, e.quote ? quoteLine(e.quote) : 'Prix à saisir')), v.status === 'OPEN' ? h('button', { class: 'btn sec inline', onclick: () => go('capture', { visit: v, item: { id: e.itemId, name: e.name } }) }, e.quote ? 'Nouveau prix' : 'Prix') : null)))) : empty('Aucun produit enregistré.'),
    v.status === 'OPEN' ? h('button', { class: 'btn sec', onclick: async () => { if (!confirm('Clôturer cette visite ? Plus aucun produit ne pourra y être ajouté.')) return; const r = await request('POST', `/api/visits/${id}/close`, { key: uid('close'), body: {} }); if (r.status === 200) render(); else banner(errText(r), 'err'); } }, 'Clôturer la visite') : null);
}
const quoteLine = (q) => { const first = q.tiers[0]; const last = q.tiers.at(-1); return `${microToString(first.unitPriceMicro)} ${q.currency}${q.tiers.length > 1 ? ` → ${microToString(last.unitPriceMicro)}` : ''}${q.moq ? ` · MOQ ${q.moq}` : ''}${q.incoterm ? ` · ${q.incoterm}` : ''}`; };

async function resizeToJpeg(file, max = 1280) {
  const bmp = await createImageBitmap(file); const k = Math.min(1, max / Math.max(bmp.width, bmp.height));
  const c = document.createElement('canvas'); c.width = Math.round(bmp.width * k); c.height = Math.round(bmp.height * k); c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
  return new Promise((resolve) => c.toBlob((b) => resolve(b), 'image/jpeg', 0.8));
}
function screenCapture({ visit, item = null }) {
  setHead(item ? `Nouveau prix · ${item.name}` : 'Nouveau produit', visit.supplier.name, true);
  const blobs = []; const previews = h('div', { class: 'photos' });
  const file = h('input', { type: 'file', accept: 'image/*', capture: 'environment', multiple: true, class: 'hidden-input', id: 'file' });
  file.addEventListener('change', async () => { for (const f of file.files) { const b = await safeAsync(() => resizeToJpeg(f), null); if (b) { blobs.push(b); const img = h('img', { class: 'thumb', alt: '' }); img.src = URL.createObjectURL(b); put(previews, img); } } file.value = ''; });
  const name = h('input', { placeholder: 'Ex. : porte-clés acrylique 5 cm', autocomplete: 'off', value: item?.name ?? '', disabled: Boolean(item) });
  // the SAME product seen at another supplier: pick it so both prices end up on one product and can be compared
  const same = h('select', {}, h('option', { value: '' }, 'Nouveau produit'));
  if (!item) getJson('/api/items').then((r) => { for (const i of r.data?.items ?? []) same.append(h('option', { value: i.id }, `${i.name} (${i.sku})`)); });
  same.addEventListener('change', () => { name.disabled = Boolean(same.value); });
  const barcode = h('input', { placeholder: 'Code-barres (optionnel)', inputmode: 'numeric' });
  const cur = select(CURRENCIES.map((c) => [c, c]), visit.supplier.currency ?? 'CNY'); const price = h('input', { inputmode: 'decimal', placeholder: '0,52' }); const moq = h('input', { inputmode: 'numeric', placeholder: 'MOQ' });
  const tiersBox = h('div', {}); const tiers = [];
  const addTier = () => { const q = h('input', { inputmode: 'numeric', placeholder: 'à partir de (pièces)' }); const p = h('input', { inputmode: 'decimal', placeholder: 'prix' }); tiers.push({ q, p }); put(tiersBox, h('div', { class: 'row' }, q, p)); };
  const inco = select([['', 'Incoterm (?)'], ...['EXW', 'FCA', 'FOB', 'CFR', 'CIF', 'CPT', 'CIP', 'DAP', 'DDP'].map((x) => [x, x])], ''); const lead = h('input', { inputmode: 'numeric', placeholder: 'Délai (jours)' }); const note = h('textarea', { placeholder: 'Remarques, matière, couleurs, échantillon…' });
  const err = h('div', {}); let busy = false;
  const save_ = h('button', { class: 'btn', onclick: async () => {
    if (busy) return; err.replaceChildren();
    const hasPrice = price.value.trim() || tiers.some((t) => t.q.value.trim() || t.p.value.trim());
    const target = item ?? (same.value ? { id: same.value, name: same.selectedOptions[0].text } : null);
    if (!target && !name.value.trim()) return put(err, h('div', { class: 'warn' }, 'Donnez un nom au produit (ou prenez une photo puis un nom court).'));
    let quote; if (hasPrice) { const b = buildQuotePayload({ currency: cur.value, unitPrice: price.value, moq: moq.value, tiers: tiers.map((t) => ({ minQty: t.q.value, unitPrice: t.p.value })), incoterm: inco.value, leadTimeDays: lead.value, note: '' }); if (!b.ok) return put(err, ...b.errors.map((e) => h('div', { class: 'warn' }, e))); quote = b.quote; } else if (target) return put(err, h('div', { class: 'warn' }, 'Saisissez le nouveau prix.'));
    busy = true; save_.disabled = true;
    try {
      const photoIds = []; for (const b of blobs) { const pid = uid('photo'); await outbox.putPhoto(pid, b); photoIds.push(pid); }
      outbox.enqueue({ label: target ? `Nouveau prix · ${target.name}` : name.value.trim(), method: 'POST', path: `/api/visits/${visit.id}/products`, photosInto: blobs.length ? 'product.photos' : null, photoIds, meta: { visitId: visit.id },
        body: { ...(target ? { itemId: target.id } : {}), product: { ...(target ? {} : { name: name.value.trim() }), ...(barcode.value.trim() ? { barcode: barcode.value.trim() } : {}), photos: [] }, ...(quote ? { quote } : {}), ...(note.value.trim() ? { note: note.value.trim().slice(0, 500) } : {}) } });
      banner('Enregistré sur ce téléphone. Envoi en cours…', 'ok'); S.stack.pop(); render(); outbox.flush({ force: true }).then(refreshAfterSend);
    } catch (e) { busy = false; save_.disabled = false; put(err, h('div', { class: 'warn' }, e.message)); }
  } }, 'Enregistrer');
  swap(main, h('div', { class: 'card' },
    item ? null : [h('label', { for: 'file' }, 'Photos'), previews, h('button', { class: 'btn sec', onclick: () => file.click() }, '📷 Prendre / choisir une photo'), file, field('Même produit qu’un produit déjà vu ?', same), field('Produit', name), field('Code-barres', barcode)],
    h('h3', {}, 'Prix donné par le fournisseur'), h('div', { class: 'row' }, field('Prix unitaire', price), field('Devise', cur)), field('Quantité minimale (MOQ)', moq),
    h('h3', {}, 'Paliers de prix'), tiersBox, h('button', { class: 'btn sec', onclick: addTier }, '＋ Ajouter un palier (ex. 5000 pièces → 0,072)'),
    h('div', { class: 'row' }, field('Incoterm', inco), field('Délai', lead)), field('Note', note), err, save_,
    h('p', { class: 'small muted' }, 'La saisie est d’abord gardée sur ce téléphone puis envoyée ; si la connexion tombe, rien n’est perdu et rien n’est envoyé deux fois.')));
}

async function screenItems() {
  setHead('Produits', 'Tout ce qui a été vu');
  const box = h('div', {}); swap(main, box);
  const res = await getJson('/api/items'); if (!res.data) return put(box, fail(res));
  const search = h('input', { placeholder: 'Rechercher un produit', type: 'search' }); const out = h('ul', { class: 'list' });
  const draw = () => { const t = search.value.trim().toLowerCase(); const rows = res.data.items.filter((i) => !t || i.name.toLowerCase().includes(t) || i.sku.toLowerCase().includes(t)); out.replaceChildren(...(rows.length ? rows.map((i) => h('li', {}, h('button', { class: 'tap', onclick: () => go('item', { id: i.id }) }, i.photos[0] ? thumb(i.photos[0]) : h('div', { class: 'thumb' }), h('div', { class: 'grow' }, h('div', { class: 'nm' }, i.name), h('div', { class: 'sub' }, `${i.sku} · ${new Set(i.quotes.filter((q) => q.status !== 'SUPERSEDED').map((q) => q.supplierId)).size} fournisseur(s)`)), chip(i.status === 'PROSPECT' ? 'à étudier' : 'catalogue', i.status === 'PROSPECT' ? 'a' : 'g')))) : [empty('Aucun produit.')])); };
  search.addEventListener('input', draw); draw(); put(box, stale(res), search, out);
}
async function screenItem({ id }) {
  setHead('Produit', '', true); const box = h('div', {}); swap(main, box);
  const res = await getJson(`/api/items/${id}`); if (!res.data) return put(box, fail(res));
  const it = res.data; setHead(it.name, it.sku, true);
  const cur = it.quotes.filter((q) => q.status !== 'SUPERSEDED');
  put(box, stale(res), it.photos.length ? h('div', { class: 'photos' }, it.photos.map((p) => thumb(p))) : null,
    h('button', { class: 'btn', onclick: () => { S.compareItem = it.id; tab('compare'); } }, 'Comparer les offres'),
    h('div', { class: 'card' }, h('h2', {}, 'Offres en cours'), cur.length ? cur.map((q) => h('div', { class: 'note' }, h('b', {}, q.supplier), ` — ${quoteLine({ ...q, tiers: q.tiers.map((t) => ({ unitPriceMicro: t.unitPriceMicro })) })}`, q.leadTimeDays ? ` · ${q.leadTimeDays} j` : '', q.validUntil ? ` · valable jusqu’au ${fmtDate(q.validUntil)}` : '')) : h('p', { class: 'muted' }, 'Aucun prix enregistré.')),
    h('div', { class: 'card' }, h('h2', {}, 'Historique des prix négociés'), h('table', {}, h('tbody', {}, it.quotes.map((q) => h('tr', {}, h('td', {}, `${q.supplier} #${q.revision}`), h('td', { class: 'n' }, quoteLine({ ...q, tiers: q.tiers.map((t) => ({ unitPriceMicro: t.unitPriceMicro })) })), h('td', {}, q.status === 'SUPERSEDED' ? chip('remplacé') : chip('actuel', 'g'))))))));
}

async function screenCompare() {
  setHead('Comparer', 'Quel fournisseur au meilleur coût ?');
  const box = h('div', {}); swap(main, box);
  const items = await getJson('/api/items'); if (!items.data) return put(box, fail(items));
  const sel = select([['', 'Choisir un produit…'], ...items.data.items.map((i) => [i.id, `${i.name} (${i.sku})`])], S.compareItem ?? '');
  const qty = h('input', { inputmode: 'numeric', placeholder: 'Quantité à acheter' }); const fxBox = h('div', {}); const freight = h('input', { inputmode: 'decimal', placeholder: 'Transport total, en € (optionnel)' }); const duty = h('input', { inputmode: 'decimal', placeholder: 'Droits de douane % (optionnel)' }); const sell = h('input', { inputmode: 'decimal', placeholder: 'Prix de vente TTC prévu, en € (optionnel)' });
  const result = h('div', {}); const fxIn = {};
  const storedFx = load(FX_KEY, {});
  const drawFx = () => { fxBox.replaceChildren(); const it = items.data.items.find((i) => i.id === sel.value); const curs = [...new Set((it?.quotes ?? []).filter((q) => q.status !== 'SUPERSEDED' && q.currency !== 'EUR').map((q) => q.currency))]; for (const c of curs) { fxIn[c] = h('input', { inputmode: 'decimal', placeholder: `1 ${c} = … €`, value: storedFx[c]?.rate ?? '' }); put(fxBox, field(`Taux ${c} → EUR`, fxIn[c], storedFx[c] ? `Saisi le ${fmtDate(storedFx[c].date)}` : 'À saisir : Nordla n’invente jamais un taux.')); } };
  sel.addEventListener('change', drawFx); drawFx();
  const run = h('button', { class: 'btn', onclick: async () => {
    result.replaceChildren(); const q_ = parseInteger(qty.value);
    if (!sel.value || !q_) return put(result, h('div', { class: 'warn' }, 'Choisissez un produit et une quantité.'));
    const fx = {};
    for (const [c, input] of Object.entries(fxIn)) {
      const r = parseDecimal(input.value); if (!input.value.trim()) continue;
      if (!r) return put(result, h('div', { class: 'warn' }, `Taux ${c} illisible : écrivez un nombre exact (0,128).`));
      const pl = fxPlausibility(c, r); if (!pl.ok && !confirm(`${pl.message}\n\nUtiliser quand même ${r} ?`)) return put(result, h('div', { class: 'warn' }, `Taux ${c} à vérifier : ${pl.message}`));
      fx[c] = { rate: r, date: today(), source: 'saisie sur téléphone' }; storedFx[c] = fx[c];
    }
    save(FX_KEY, storedFx);
    const f = parseDecimal(freight.value);
    const qs = new URLSearchParams({ itemId: sel.value, qty: String(q_), fx: JSON.stringify(fx), ...(f ? { freight: f, dutyPct: parseDecimal(duty.value) ?? '0' } : {}), ...(parseDecimal(sell.value) ? { sellPrice: parseDecimal(sell.value) } : {}) });
    const r = await request('GET', `/api/compare?${qs}`); if (r.status !== 200) return put(result, h('div', { class: 'warn' }, errText(r)));
    const cmp = r.json; const byQuote = new Map(cmp.offers.map((o) => [o.quoteId, o])); const it = items.data.items.find((i) => i.id === sel.value);
    put(result, h('div', { class: 'note' }, cmp.basis === 'LANDED_COST' ? 'Classement au COÛT RENDU estimé (marchandises + transport + droits saisis).' : 'Classement sur le PRIX DES MARCHANDISES seul : saisissez transport et droits pour un coût rendu.'));
    const pw = precisionWarning(cmp.offers); if (pw) put(result, h('div', { class: 'note' }, pw));
    put(result, h('div', { class: 'small muted' }, `Devises en jeu : ${currenciesOf(cmp.offers).join(', ')}. Chaque prix est affiché dans la devise du fournisseur ; la comparaison n’utilise que les taux saisis ci-dessus.`));
    const ranked = cmp.ranking.map((r_) => byQuote.get(r_.quoteId)); const others = cmp.offers.filter((o) => !cmp.ranking.some((r_) => r_.quoteId === o.quoteId));
    for (const [i, o] of [...ranked, ...others].entries()) {
      const d = describeOffer(o, q_); const isRank = i < ranked.length;
      put(result, h('div', { class: `card ${isRank && i === 0 ? 'best' : ''}` }, isRank ? h('div', { class: 'rank' }, i === 0 ? '1er — le moins cher' : `${i + 1}ᵉ`) : null, h('div', { class: 'nm' }, h('b', {}, o.supplier)), h('div', { class: d.usable ? 'big' : 'warn' }, d.headline), h('p', { class: 'small muted' }, d.detail), h('div', { class: 'chips' }, d.chips.map((c) => chip(c.t, c.k))),
        d.usable ? h('button', { class: 'btn sec', onclick: () => { const cart = load(CART_KEY, []); const line = { quoteId: o.quoteId, itemId: sel.value, supplierId: o.supplierId, supplier: o.supplier, currency: o.currency, name: it.name, qty: q_ }; let r2 = addToCart(cart, line); if (r2.conflict) { if (!confirm(`La sélection contient déjà des produits d’un autre fournisseur. La remplacer par celle de ${o.supplier} ?`)) return; r2 = addToCart(cart, line, { replace: true }); } save(CART_KEY, r2.cart); banner(`Ajouté à la sélection (${r2.cart.length}).`, 'ok'); } }, 'Ajouter à la sélection d’achat') : null));
    }
    put(result, h('p', { class: 'small muted' }, 'Ce classement compare ; il ne commande rien.'));
  } }, 'Comparer');
  put(box, stale(items), h('div', { class: 'card' }, field('Produit', sel), field('Quantité', qty), fxBox, h('h3', {}, 'Coûts d’approche (optionnels)'), freight, duty, sell, run), result);
  if (S.compareItem) { S.compareItem = null; }
}

async function screenOrders() {
  setHead('Achats', 'Sélection, bons de commande');
  const box = h('div', {}); swap(main, box);
  const cart = load(CART_KEY, []);
  if (cart.length) put(box, cartCard(cart));
  const res = await getJson('/api/purchase-orders'); if (!res.data) return put(box, fail(res));
  put(box, stale(res), pendingNote(), h('button', { class: 'btn sec', onclick: () => go('suppliers') }, 'Fournisseurs et offres'));
  const all = res.data.purchaseOrders;
  if (!all.length) put(box, empty('Aucun bon de commande en cours. Comparez des offres, ajoutez-les à la sélection, puis créez un brouillon.'));
  for (const [st, title] of PO_GROUPS) { const rows = all.filter((p) => p.status === st); if (!rows.length) continue; put(box, h('h3', {}, `${title} (${rows.length})`), h('ul', { class: 'list' }, rows.map((p) => h('li', {}, h('button', { class: 'tap', onclick: () => go('po', { id: p.id }) }, h('div', { class: 'grow' }, h('div', { class: 'nm' }, `${p.number} · ${p.supplier.name}`), h('div', { class: 'sub' }, `${p.lines.length} produit(s) · livraison prévue ${fmtDate(p.expectedDate)}`)), h('div', { class: 'nm' }, fmtMoney(p.totalMinor, p.currency)))))));
  }
}
function cartCard(cart) {
  const supplier = cart[0].supplier; const cur = cart[0].currency; const storedFx = load(FX_KEY, {});
  const exp = h('input', { type: 'date', value: new Date(Date.now() + 60 * 864e5).toISOString().slice(0, 10) }); const err = h('div', {});
  const rate = cur !== 'EUR' ? h('input', { inputmode: 'decimal', placeholder: `1 ${cur} = … €`, value: storedFx[cur]?.rate ?? '' }) : null;
  const qtyInputs = cart.map((l) => h('input', { inputmode: 'numeric', value: String(l.qty) }));
  return h('div', { class: 'card best' }, h('h2', {}, `Sélection d’achat · ${supplier}`),
    cart.map((l, i) => h('div', {}, h('label', {}, `${l.name} — quantité`), h('div', { class: 'row' }, qtyInputs[i], h('button', { class: 'btn danger inline', onclick: () => { save(CART_KEY, cart.filter((_, k) => k !== i)); render(); } }, 'Retirer')))),
    field('Livraison souhaitée', exp), rate ? field(`Taux ${cur} → EUR`, rate, 'Obligatoire pour estimer le coût en euros.') : null, err,
    h('button', { class: 'btn', onclick: async () => {
      err.replaceChildren();
      const qs = qtyInputs.map((i) => parseInteger(i.value)); if (qs.some((x) => !x)) return put(err, h('div', { class: 'warn' }, 'Quantités à corriger.'));
      let fx; if (rate) { const r = parseDecimal(rate.value); if (!r) return put(err, h('div', { class: 'warn' }, `Saisissez le taux ${cur} → EUR.`)); fx = { from: cur, to: 'EUR', rate: r, date: today(), source: 'saisie sur téléphone' }; storedFx[cur] = { rate: r, date: today() }; save(FX_KEY, storedFx); }
      outbox.enqueue({ label: `Bon brouillon · ${supplier}`, method: 'POST', path: '/api/purchase-orders', body: { lines: cart.map((l, i) => ({ quoteId: l.quoteId, qty: qs[i] })), expectedDate: exp.value, ...(fx ? { fx } : {}) } });
      save(CART_KEY, []); banner('Brouillon créé sur le téléphone, envoi en cours. Rien n’est commandé.', 'ok'); outbox.flush({ force: true }).then(refreshAfterSend); render();
    } }, 'Créer le bon de commande (brouillon)'), h('p', { class: 'small muted' }, 'Un brouillon n’engage à rien : il doit être envoyé pour approbation, approuvé, puis marqué commandé par une personne habilitée.'));
}

async function screenPo({ id }) {
  setHead('Bon de commande', '', true); const box = h('div', {}); swap(main, box);
  const res = await getJson(`/api/purchase-orders/${id}`); if (!res.data) return put(box, fail(res));
  const po = res.data; setHead(po.number, po.supplier.name, true);
  const act = async (a) => {
    if (a.id === 'receive') return go('receive', { id });
    if (a.confirm && !confirm(a.confirm)) return; let body = {};
    if (a.needsReason) { const reason = prompt('Motif (obligatoire) :'); if (!reason || reason.trim().length < 3) return; body = { reason: reason.trim() }; }
    if (a.selfApprove) body = { ...body, confirmSelfApproval: true };
    if (a.id === 'confirm') { const ref = prompt('Référence de confirmation du fournisseur (optionnel) :'); if (ref?.trim()) body = { supplierReference: ref.trim() }; }
    if (a.id === 'order') { const ref = prompt('Référence donnée par le fournisseur (optionnel) :'); if (ref?.trim()) body = { supplierReference: ref.trim() }; }
    const r = await request('POST', `/api/purchase-orders/${id}/${a.id}`, { key: uid(a.id), body });
    if (r.status === 200) { banner(`${a.label} : fait.`, 'ok'); render(); } else banner(errText(r), 'err');
  };
  put(box, stale(res), h('div', { class: 'card' }, h('div', { class: 'row' }, h('div', {}, h('div', { class: 'small muted' }, 'Statut'), h('div', { class: 'big' }, PO_STATUS_FR[po.status])), h('div', {}, h('div', { class: 'small muted' }, 'Total'), h('div', { class: 'big' }, fmtMoney(po.totalMinor, po.currency)))),
    h('p', { class: 'small muted' }, `Livraison prévue ${fmtDate(po.expectedDate)} · préparé par ${po.createdBy}${po.submittedBy ? ` · envoyé par ${po.submittedBy}` : ''}`), po.fx ? h('div', { class: 'note' }, `Taux ${po.fx.from}→EUR ${po.fx.rate} (${fmtDate(po.fx.date)}, ${po.fx.source}) : montants en euros ESTIMÉS.`) : null),
    h('div', { class: 'card' }, h('h2', {}, 'Produits'), h('table', {}, h('tbody', {}, po.lines.map((l) => h('tr', {}, h('td', {}, l.name ?? l.sku), h('td', { class: 'n' }, `${l.qty} × ${microToString(l.unitPriceMicro)}`), h('td', { class: 'n' }, fmtMoney(l.totalMinor, po.currency))))))),
    po.schedule.length ? h('div', { class: 'card' }, h('h2', {}, 'Paiements prévus'), h('table', {}, h('tbody', {}, po.schedule.map((s) => h('tr', {}, h('td', {}, s.kind === 'DEPOSIT' ? 'Acompte' : 'Solde'), h('td', { class: 'n' }, fmtMoney(s.amountMinor, po.currency)), h('td', {}, chip(s.status === 'PAID_LINKED' ? 'payé' : 'à prévoir', s.status === 'PAID_LINKED' ? 'g' : ''))))), h('p', { class: 'small muted' }, 'Nordla ne paie rien : les paiements se font dans la comptabilité.'))) : null,
    poActions(po, S.me).map((a) => a.info ? h('div', { class: 'note' }, a.label) : h('button', { class: `btn ${a.primary ? '' : a.danger ? 'danger' : 'sec'}`, onclick: () => act(a) }, a.label)),
    h('p', { class: 'small muted' }, 'Aucune commande n’est envoyée au fournisseur par Nordla. « Commandé » signifie qu’une personne habilitée l’a passée.'));
}

function screenOutbox() {
  setHead('Sur ce téléphone', 'Saisies pas encore envoyées', true);
  const q = outbox.list();
  swap(main, h('div', {}, q.length ? h('ul', { class: 'list' }, q.map((x) => h('li', { class: 'card' }, h('div', { class: 'nm' }, x.label), h('div', { class: x.state === 'REJECTED' ? 'warn' : 'small muted' }, x.state === 'REJECTED' ? `Refusé par le serveur : ${x.error}` : `En attente${x.error ? ` — ${x.error}` : ''} · ${x.attempts} essai(s)`), h('div', { class: 'row' }, x.state === 'REJECTED' ? h('button', { class: 'btn sec', onclick: () => { outbox.retryRejected(x.id); outbox.flush({ force: true }).then(refreshAfterSend); render(); } }, 'Réessayer') : null, h('button', { class: 'btn danger', onclick: async () => { if (confirm('Supprimer cette saisie du téléphone ? Elle ne sera jamais envoyée.')) { await outbox.remove(x.id); render(); } } }, 'Supprimer'))))) : empty('Tout est envoyé.'), q.length ? h('button', { class: 'btn', onclick: () => outbox.flush({ force: true }).then((n) => { refreshAfterSend(n); render(); }) }, 'Envoyer maintenant') : null));
}

async function screenImport() {
  setHead('China Sourcing', 'Reprendre un dossier sans ressaisie', true); const box = h('div', {}); swap(main, box);
  const res = await getJson('/api/sourcing/cases'); if (!res.data) return put(box, fail(res));
  if (!res.data.available) return put(box, h('div', { class: 'note' }, `Les dossiers China Sourcing ne sont pas accessibles sur ce serveur (${res.data.reason}).`));
  const out = h('div', {}); const show = (r) => { out.replaceChildren(h('div', { class: `card ${r.status === 'IMPORTED' ? 'best' : ''}` }, h('h2', {}, r.status === 'IMPORTED' ? 'Importé' : r.status === 'PARTIAL' ? 'Importé en partie' : 'Non importé'), r.supplier ? h('p', {}, `Fournisseur : ${r.supplier.name} ${r.supplier.created ? '(créé)' : '(déjà connu)'}`) : null, r.item ? h('p', {}, `Produit : ${r.item.name} ${r.item.created ? '(créé)' : '(déjà connu)'} · ${r.item.attachments} pièce(s) jointe(s)`) : null, r.quotes?.length ? h('p', {}, `Devis : ${r.quotes.map((q) => ({ CREATED: 'ajouté', UNCHANGED: 'inchangé', SKIPPED: `ignoré (${q.reason})` }[q.status])).join(', ')}`) : null, r.purchaseOrder ? h('p', {}, `Brouillon ${r.purchaseOrder.number} ${r.purchaseOrder.reused ? '(déjà existant)' : '(créé)'}`) : null, (r.issues ?? []).map((i) => h('div', { class: 'warn' }, i.message)))); };
  put(box, res.data.cases.length ? h('ul', { class: 'list' }, res.data.cases.map((c) => h('li', { class: 'card' }, h('div', { class: 'nm' }, c.name || c.id), h('div', { class: 'sub' }, `${c.supplier ?? 'fournisseur ?'} · ${c.quotes} devis · ${c.photos} photo(s)`),
    h('button', { class: 'btn', onclick: async () => { const r = await request('POST', '/api/sourcing/import', { key: uid('imp'), body: { caseId: c.id } }); if (r.status === 200) show(r.json); else banner(errText(r), 'err'); } }, 'Importer'),
    h('button', { class: 'btn sec', onclick: async () => { const qty = parseInteger(prompt('Quantité du bon brouillon :')); if (!qty) return; const exp = prompt('Livraison souhaitée (AAAA-MM-JJ) :', new Date(Date.now() + 60 * 864e5).toISOString().slice(0, 10)); if (!exp) return; const fxr = prompt('Taux de change vers EUR si le prix n’est pas en euros (ex. 0,92), sinon laisser vide :'); const body = { caseId: c.id, qty, expectedDate: exp }; if (fxr && parseDecimal(fxr)) body.fxRate = parseDecimal(fxr); const r = await request('POST', '/api/sourcing/import', { key: uid('impo'), body }); if (r.status === 200) show(r.json); else banner(errText(r), 'err'); } }, 'Importer + brouillon de commande')))) : empty('Aucun dossier China Sourcing trouvé.'), out);
}

async function screenStock() {
  setHead('Stock', 'Quantités, emplacements, entrant');
  const box = h('div', {}); swap(main, box);
  const res = await getJson('/api/stock'); if (!res.data) return put(box, fail(res));
  const d = res.data; const v = d.valuation;
  put(box, stale(res),
    h('div', { class: 'card' }, h('h2', {}, 'Valeur du stock (moyenne pondérée mobile)'),
      h('div', { class: 'big' }, fmtMoney(v.confirmedEurMinor + v.estimatedEurMinor, 'EUR')),
      h('p', { class: 'small muted' }, `${fmtMoney(v.confirmedEurMinor, 'EUR')} confirmé · ${fmtMoney(v.estimatedEurMinor, 'EUR')} estimé (prix des marchandises seul, sans transport ni droits)${v.itemsWithUnknownCost ? ` · ${v.unknownUnits} unité(s) de ${v.itemsWithUnknownCost} produit(s) SANS coût connu, non valorisées` : ''}.`)),
    S.me.canReceive || S.me.canAdjust ? h('div', { class: 'row' }, h('button', { class: 'btn sec', onclick: () => go('count') }, 'Faire un inventaire'), h('button', { class: 'btn sec', onclick: () => go('requests') }, 'Demandes en attente')) : h('button', { class: 'btn sec', onclick: () => go('requests') }, 'Demandes en attente'),
    S.me.canSelfApprove ? h('button', { class: 'btn sec', onclick: () => go('newLocation') }, 'Ajouter un emplacement') : null,
    d.items.length ? h('ul', { class: 'list' }, d.items.map((i) => h('li', {}, h('button', { class: 'tap', onclick: () => go('stockItem', { item: i, locations: d.locations }) }, i.photo ? thumb(i.photo) : h('div', { class: 'thumb' }), h('div', { class: 'grow' }, h('div', { class: 'nm' }, i.name), h('div', { class: 'sub' }, `${i.sku} · à vendre ${i.available}${i.incoming.qty ? ` · attendu ${i.incoming.qty}` : ''}${i.quarantine ? ` · quarantaine ${i.quarantine}` : ''}`)), valuationChip(i.valuation))))) : empty('Aucun produit en stock pour l’instant. Les marchandises apparaissent après leur réception.'),
    h('p', { class: 'small muted' }, 'Le stock vient des réceptions et des mouvements enregistrés ici : ce n’est pas le stock Shopify, et rien n’est écrit dans Shopify.'));
}
const valuationChip = (v) => chip({ CONFIRMED: 'coût confirmé', ESTIMATED: 'coût estimé', PARTIAL: 'coût partiel', UNKNOWN: 'coût inconnu', EMPTY: 'vide' }[v.status] ?? v.status, { CONFIRMED: 'g', ESTIMATED: 'a', PARTIAL: 'a', UNKNOWN: 'r', EMPTY: '' }[v.status] ?? '');
function screenStockItem({ item: i, locations = [] }) {
  setHead(i.name, i.sku, true);
  const loc = (l) => `${l.name ?? l.type}${l.type === 'QUARANTINE' ? ' (quarantaine)' : ''}`;
  swap(main, h('div', {},
    h('div', { class: 'card' }, h('div', { class: 'row' }, h('div', {}, h('div', { class: 'small muted' }, 'À vendre'), h('div', { class: 'big' }, String(i.available))), h('div', {}, h('div', { class: 'small muted' }, 'Physique'), h('div', { class: 'big' }, String(i.physical))), h('div', {}, h('div', { class: 'small muted' }, 'Attendu'), h('div', { class: 'big' }, String(i.incoming.qty)))),
      h('p', { class: 'small muted' }, `Réservé ${i.reserved} · en transit ${i.inTransit} · quarantaine ${i.quarantine}. L’attendu n’est jamais compté comme disponible.`)),
    h('div', { class: 'card' }, h('h2', {}, 'Par emplacement'), i.perLocation.length ? h('table', {}, h('tbody', {}, i.perLocation.map((l) => h('tr', {}, h('td', {}, loc(l)), h('td', { class: 'n' }, `${l.onHand}${l.reserved ? ` (dont ${l.reserved} réservés)` : ''}`))))) : h('p', { class: 'muted' }, 'Aucune unité en stock.')),
    i.incoming.orders.length ? h('div', { class: 'card' }, h('h2', {}, 'Commandes en attente de réception'), h('table', {}, h('tbody', {}, i.incoming.orders.map((o) => h('tr', {}, h('td', {}, o.number), h('td', { class: 'n' }, `${o.qty} · ${fmtDate(o.expectedDate)}`), h('td', {}, o.delayed ? chip('en retard', 'r') : null)))))) : null,
    h('div', { class: 'card' }, h('h2', {}, 'Actions'), h('div', { class: 'row' }, S.me.canReceive || S.me.canAdjust ? h('button', { class: 'btn sec', onclick: () => go('adjust', { item: i, locations }) }, 'Ajuster') : null, S.me.canReceive ? h('button', { class: 'btn sec', onclick: () => go('transfer', { item: i, locations }) }, 'Transférer') : null, h('button', { class: 'btn sec', onclick: () => go('history', { item: i }) }, 'Historique'))),
    h('div', { class: 'card' }, h('h2', {}, 'Valorisation'), h('div', { class: 'row' }, valuationChip(i.valuation)), h('p', { class: 'small muted' }, i.valuation.status === 'UNKNOWN' ? 'Aucun coût connu pour ces unités : elles ne sont pas valorisées (jamais à zéro, jamais inventé).' : `${i.valuation.valuedUnits} unité(s) valorisée(s) à ${i.valuation.unitCostEurMicro / 1e6} € en moyenne = ${fmtMoney(i.valuation.valueEurMinor ?? 0, 'EUR')}${i.valuation.unknownUnits ? ` · ${i.valuation.unknownUnits} unité(s) sans coût connu` : ''}${i.valuation.goodsOnly ? ' · prix des marchandises seul (transport et droits non inclus)' : ''}.`))));
}

async function screenReceive({ id }) {
  setHead('Réception', '', true); const box = h('div', {}); swap(main, box);
  if (!S.me.canReceive) return put(box, h('div', { class: 'warn' }, ERRORS_FR.FORBIDDEN));
  const res = await getJson(`/api/purchase-orders/${id}`); if (!res.data) return put(box, fail(res));
  if (res.stale) return put(box, h('div', { class: 'warn' }, 'Connexion indisponible : une réception ne peut pas être enregistrée sur des données anciennes. Réessayez avec une connexion.'), h('button', { class: 'btn sec', onclick: () => render() }, 'Réessayer'));
  const po = res.data; setHead(`Réception · ${po.number}`, po.supplier.name, true);
  const ov = await getJson('/api/overview'); const sellable = (ov.data?.locations ?? []).filter((l) => ['WAREHOUSE', 'STORE', 'BACKROOM'].includes(l.type));
  const dest = sellable.find((l) => l.id === po.destinationLocationId)?.id ?? sellable[0]?.id ?? '';
  const where = select(sellable.map((l) => [l.id, `${l.name} (${{ WAREHOUSE: 'entrepôt', STORE: 'magasin', BACKROOM: 'réserve' }[l.type]})`]), dest);
  const key = uid('recv'); const date = h('input', { type: 'date', value: today() }); const err = h('div', {}); const preview = h('div', { class: 'note' });
  const rows = po.lines.map((l) => ({ l, ok: h('input', { inputmode: 'numeric', placeholder: '0' }), bad: h('input', { inputmode: 'numeric', placeholder: '0' }) }));
  const entries = () => rows.map((r) => ({ lineId: r.l.id, accepted: r.ok.value, defective: r.bad.value }));
  const refresh = () => { const v = receiptLinesFrom(po, entries()); preview.textContent = v.ok ? `${v.total} pièce(s) à enregistrer : ${v.lines.map((x) => `${x.qtyAccepted} acceptée(s)${x.qtyDefective ? ` + ${x.qtyDefective} défectueuse(s) en quarantaine` : ''}`).join(' ; ')}.` : v.errors[0]; };
  for (const r of rows) { r.ok.addEventListener('input', refresh); r.bad.addEventListener('input', refresh); }
  let busy = false;
  const send = h('button', { class: 'btn', onclick: async () => {
    if (busy) return; swap(err);
    const v = receiptLinesFrom(po, entries()); if (!v.ok) return put(err, ...v.errors.map((e) => h('div', { class: 'warn' }, e)));
    if (!confirm(`Enregistrer la réception de ${v.total} pièce(s) dans le stock ? Cette opération est tracée à votre nom.`)) return;
    busy = true; send.disabled = true;
    const r = await request('POST', `/api/purchase-orders/${id}/receive`, { key, body: { lines: v.lines, receivedAt: date.value, ...(where.value ? { locationId: where.value } : {}) } });
    busy = false; send.disabled = false;
    if (r.status === 200) { banner(r.json.complete ? 'Commande entièrement reçue.' : 'Réception partielle enregistrée.', 'ok'); S.stack.pop(); render(); }
    else put(err, h('div', { class: 'warn' }, r.status === 0 ? 'Connexion perdue : la réception n’a peut-être PAS été enregistrée. Appuyez à nouveau sur « Enregistrer » : le même envoi ne sera jamais compté deux fois.' : errText(r)));
  } }, 'Enregistrer la réception');
  put(box, h('div', { class: 'card' }, h('p', { class: 'small muted' }, 'Saisissez ce qui est ARRIVÉ. Ce qui n’arrive pas reste attendu ; les pièces défectueuses vont en quarantaine, hors du stock à vendre.'),
    rows.map(({ l, ok, bad }) => h('div', {}, h('label', {}, `${l.name ?? l.sku} — commandé ${l.qty}, déjà reçu ${l.qtyReceived}, reste ${l.qty - l.qtyReceived}`), h('div', { class: 'row' }, h('div', {}, h('div', { class: 'small muted' }, 'Acceptées'), ok), h('div', {}, h('div', { class: 'small muted' }, 'Défectueuses'), bad)))),
    field('Date de réception', date), field('Reçu dans', where, 'Les pièces acceptées entrent dans cet emplacement ; les défectueuses vont en quarantaine.'), preview, err, send));
  refresh();
}

// ------------------------------------------------------------------ router
const SCREENS = { visits: screenVisits, newVisit: screenNewVisit, visit: screenVisit, capture: screenCapture, items: screenItems, item: screenItem, compare: screenCompare, orders: screenOrders, po: screenPo, outbox: screenOutbox, import: screenImport, stock: screenStock, stockItem: screenStockItem, receive: screenReceive, newLocation: V1.newLocation, suppliers: V1.suppliers, newSupplier: V1.newSupplier, supplier: V1.supplier, newOffer: V1.newOffer, adjust: V1.adjust, transfer: V1.transfer, history: V1.history, count: V1.count, requests: V1.requests };
async function render() {
  document.querySelectorAll('.tabs button').forEach((b) => b.setAttribute('aria-current', String(b.dataset.tab === S.tab)));
  netBadge();
  const top = S.stack.at(-1);
  try { await (top ? SCREENS[top.name](top.params) : ({ visits: screenVisits, items: screenItems, compare: screenCompare, orders: screenOrders, stock: screenStock })[S.tab]()); } catch (e) { swap(main, h('div', { class: 'warn' }, `Erreur d’affichage : ${e.message}`)); }
  window.scrollTo(0, 0);
}

(async function start() {
  initToken();
  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1')) navigator.serviceWorker.register('sw.js').catch(() => {});
  if (!HOSTED && !getToken()) { setHead('Accès'); swap(main, h('div', { class: 'card' }, h('h2', {}, 'Lien d’accès nécessaire'), h('p', {}, 'Ouvrez le lien personnel fourni par le propriétaire (il contient votre jeton après le #).'))); return; }
  const me = await request('GET', '/api/me');
  if (me.status === 401 || me.status === 403) { if (!HOSTED) forgetToken(); setHead('Accès'); swap(main, h('div', { class: 'warn' }, HOSTED ? (me.status === 403 ? 'Votre accès Nordla ne donne pas droit à Stock / Achats.' : 'Votre session Nordla a expiré : reconnectez-vous sur Nordla, puis rouvrez Stock / Achats.') : ERRORS_FR.UNAUTHORIZED), HOSTED ? h('a', { class: 'btn sec', href: '/' }, 'Retour à Nordla') : null); return; }
  S.me = me.json ?? safe(() => JSON.parse(localStorage.getItem('nordla.proc.me')), { id: '?', role: 'BUYER', canApprove: false });
  if (me.json) save('nordla.proc.me', me.json);
  S.online = me.status !== 0;
  render(); outbox.flush({ force: true }).then(refreshAfterSend);
})();
