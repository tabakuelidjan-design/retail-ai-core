// Stock / Achats V1 screens: suppliers and offers, stock adjustments, transfers, inventories (counts), the queue of filed stock changes, the history of an item.
// Plain DOM, no innerHTML with data. Everything here needs the server's answer (nothing is queued on the phone): an engaging step is never "saved for later".
// The helpers come from app.js, so these screens look and behave like the existing ones.
import { parseDecimal, parseInteger, parseWhole, CURRENCIES, errText, ERRORS_FR, fmtDate, countLinesFrom, requestSummary, supplierMetricsLine } from './logic.js';

const INCOTERMS = ['EXW', 'FCA', 'FOB', 'CFR', 'CIF', 'DAP', 'DDP'];
const LOC_FR = { WAREHOUSE: 'entrepôt', STORE: 'magasin', BACKROOM: 'réserve', TRANSIT: 'en transit', QUARANTINE: 'quarantaine' };
const KIND_FR = { RECEIPT: 'Réception', ADJUSTMENT: 'Ajustement', TRANSFER_OUT: 'Transfert (sortie)', TRANSFER_IN: 'Transfert (entrée)', DEFECT_QUARANTINE_OUT: 'Défaut : sortie du stock', DEFECT_QUARANTINE_IN: 'Défaut : entrée en quarantaine', COUNT_ADJUST: 'Inventaire', RESERVE: 'Réservation', RELEASE: 'Libération' };
const EVENT_FR = { STOCK_CHANGE_REQUESTED: 'Demande déposée', STOCK_CHANGE_APPROVED: 'Demande approuvée', STOCK_CHANGE_REJECTED: 'Demande refusée', STOCK_ADJUSTED: 'Ajustement appliqué', STOCK_TRANSFERRED: 'Transfert enregistré', COUNT_ADJUSTED: 'Inventaire : écarts corrigés', COUNT_CONFIRMED: 'Inventaire confirmé', GOODS_RECEIVED: 'Réception enregistrée', ITEM_CREATED: 'Produit créé', ITEM_UPDATED: 'Produit modifié', STOCK_RESERVED: 'Stock réservé', STOCK_RELEASED: 'Réservation levée', STOCK_QUARANTINED: 'Défaut mis en quarantaine' };
const eventLabel = (type) => EVENT_FR[type] ?? 'Autre événement enregistré'; // never a raw internal code
export const SOLO_TEXT = 'Vous avez vous-même préparé cette opération. En tant que propriétaire, vous pouvez l’approuver vous-même : c’est une EXCEPTION, elle sera inscrite au journal avec votre nom. Confirmer ?';

export function createV1Screens(env) {
  const { h, put, swap, go, S, request, getJson, uid, banner, setHead, field, select, chip, empty, fail, stale, fmtMoney, render, main } = env;
  const warn = (t) => h('div', { class: 'warn' }, t);
  const locLabel = (l) => `${l.name}${LOC_FR[l.type] ? ` (${LOC_FR[l.type]})` : ''}`;
  const needs = (box, ok, text) => { if (ok) return false; put(box, warn(text)); return true; };

  // ------------------------------------------------------------------ suppliers and offers
  async function screenSuppliers() {
    setHead('Fournisseurs', 'Conditions et offres', true); const box = h('div', {}); swap(main, box);
    const res = await getJson('/api/suppliers'); if (!res.data) return put(box, fail(res));
    put(box, stale(res), S.me.prepare ? h('button', { class: 'btn fab', onclick: () => go('newSupplier') }, '＋ Nouveau fournisseur') : null,
      res.data.suppliers.length ? h('ul', { class: 'list' }, res.data.suppliers.map((s) => h('li', {}, h('button', { class: 'tap', onclick: () => go('supplier', { id: s.id }) }, h('div', { class: 'grow' }, h('div', { class: 'nm' }, s.name), h('div', { class: 'sub' }, `${s.country ?? '—'} · prix en ${s.currency} · ${s.offers} offre(s) en cours · ${s.openOrders} commande(s) ouverte(s)`)))))) : empty('Aucun fournisseur. Ils apparaissent quand vous démarrez une visite, ou ici avec « Nouveau fournisseur ».'));
  }
  function screenNewSupplier() {
    setHead('Nouveau fournisseur', '', true);
    if (!S.me.prepare) return swap(main, warn(ERRORS_FR.FORBIDDEN));
    const key = uid('sup'); const name = h('input', { placeholder: 'Nom du fournisseur', autocomplete: 'off' }); const country = h('input', { placeholder: 'CN', maxlength: '2', autocapitalize: 'characters' });
    const cur = select(CURRENCIES.map((c) => [c, c]), 'USD'); const inc = select([['', 'Non précisé'], ...INCOTERMS.map((i) => [i, i])], ''); const lead = h('input', { inputmode: 'numeric', placeholder: 'jours' }); const err = h('div', {}); let busy = false;
    const btn = h('button', { class: 'btn', onclick: async () => {
      if (busy) return; swap(err); if (!name.value.trim()) return put(err, warn('Le nom du fournisseur est nécessaire.'));
      busy = true; btn.disabled = true;
      const r = await request('POST', '/api/suppliers', { key, body: { name: name.value.trim(), country: country.value.trim() || undefined, currency: cur.value, incotermDefault: inc.value || undefined, leadTimeDays: lead.value.trim() || undefined } });
      busy = false; btn.disabled = false;
      if (r.status === 200) { banner('Fournisseur enregistré.', 'ok'); S.stack.pop(); go('supplier', { id: r.json.supplier.id }); } else put(err, warn(r.status === 0 ? 'Connexion indisponible : le fournisseur n’a pas été créé. Réessayez avec une connexion (le même envoi ne créera jamais deux fournisseurs).' : errText(r)));
    } }, 'Enregistrer le fournisseur');
    swap(main, h('div', { class: 'card' }, field('Nom', name), field('Pays (2 lettres, facultatif)', country), field('Devise de ses prix', cur), field('Incoterm habituel', inc), field('Délai habituel (jours)', lead), err, btn));
  }
  async function screenSupplier({ id }) {
    setHead('Fournisseur', '', true); const box = h('div', {}); swap(main, box);
    const res = await getJson(`/api/suppliers/${id}`); if (!res.data) return put(box, fail(res));
    const { supplier: s, offers, orders, documents, metrics } = res.data; setHead(s.name, `${s.country ?? '—'} · prix en ${s.currency}`, true);
    put(box, stale(res),
      h('div', { class: 'card' }, h('h2', {}, 'Fiabilité'), h('p', { class: 'small' }, supplierMetricsLine(metrics)), h('p', { class: 'small muted' }, `${s.incotermDefault ? `Incoterm habituel ${s.incotermDefault} · ` : ''}${s.leadTimeDays ? `délai habituel ${s.leadTimeDays} jours` : 'délai habituel non renseigné'}`)),
      h('div', { class: 'card' }, h('h2', {}, 'Offres'), offers.length ? offers.map((o) => h('div', { class: 'sub-block' }, h('div', { class: 'nm' }, `${o.name ?? o.sku} · v${o.revision}`, ' ', chip({ RECEIVED: 'en cours', SELECTED: 'retenue', SUPERSEDED: 'remplacée', EXPIRED: 'expirée' }[o.status] ?? o.status, o.status === 'SELECTED' ? 'g' : '')), h('div', { class: 'small muted' }, `${o.tiers.map((t) => `${t.minQty}+ : ${t.unitPrice} ${o.currency}`).join(' · ')}${o.moq ? ` · MOQ ${o.moq}` : ''}${o.incoterm ? ` · ${o.incoterm}` : ''}${o.leadTimeDays ? ` · ${o.leadTimeDays} j` : ''}${o.validUntil ? ` · valable jusqu’au ${fmtDate(o.validUntil)}` : ''}`))) : empty('Aucune offre enregistrée.'),
        S.me.prepare ? h('button', { class: 'btn sec', onclick: () => go('newOffer', { supplier: s }) }, 'Ajouter une offre') : null),
      h('div', { class: 'card' }, h('h2', {}, 'Commandes'), orders.length ? h('ul', { class: 'list' }, orders.map((o) => h('li', {}, h('button', { class: 'tap', onclick: () => go('po', { id: o.id }) }, h('div', { class: 'grow' }, h('div', { class: 'nm' }, o.number), h('div', { class: 'sub' }, `${fmtMoney(o.totalMinor, o.currency)} · ${fmtDate(o.expectedDate)}`)), chip(o.status.toLowerCase().replaceAll('_', ' ')))))) : empty('Aucune commande.')),
      documents.length ? h('div', { class: 'card' }, h('h2', {}, 'Documents'), h('table', {}, h('tbody', {}, documents.map((d) => h('tr', {}, h('td', {}, d.name), h('td', { class: 'n' }, d.expiresOn ? `expire le ${fmtDate(d.expiresOn)}` : '—'))))) ) : null);
  }
  async function screenNewOffer({ supplier }) {
    setHead('Nouvelle offre', supplier.name, true); const box = h('div', {}); swap(main, box);
    if (needs(box, S.me.prepare, ERRORS_FR.FORBIDDEN)) return;
    const items = await getJson('/api/items'); if (!items.data) return put(box, fail(items));
    if (!items.data.items.length) return put(box, empty('Aucun produit : saisissez d’abord un produit lors d’une visite.'));
    const key = uid('offer'); const it = select(items.data.items.map((i) => [i.id, `${i.name} (${i.sku})`]), items.data.items[0].id); const cur = select(CURRENCIES.map((c) => [c, c]), supplier.currency);
    const moq = h('input', { inputmode: 'numeric', placeholder: 'facultatif' }); const inc = select([['', 'Non précisé'], ...INCOTERMS.map((i) => [i, i])], supplier.incotermDefault ?? ''); const lead = h('input', { inputmode: 'numeric', placeholder: 'jours' }); const until = h('input', { type: 'date' });
    const tiers = [0, 1, 2].map((i) => ({ q: h('input', { inputmode: 'numeric', placeholder: i ? 'à partir de…' : 'quantité min.' }), p: h('input', { inputmode: 'decimal', placeholder: 'prix unitaire' }) })); const err = h('div', {}); let busy = false;
    const btn = h('button', { class: 'btn', onclick: async () => {
      if (busy) return; swap(err); const out = []; const problems = [];
      for (const [i, t] of tiers.entries()) { if (!t.q.value.trim() && !t.p.value.trim()) continue; const q = parseInteger(t.q.value); const p = parseDecimal(t.p.value); if (!q) problems.push(`Palier ${i + 1} : quantité invalide.`); else if (!p) problems.push(`Palier ${i + 1} : prix invalide (nombre positif, 6 décimales au maximum).`); else out.push({ minQty: q, unitPrice: p }); }
      if (!out.length) problems.push('Saisissez au moins un prix.'); if (problems.length) return put(err, ...problems.map(warn));
      busy = true; btn.disabled = true;
      const r = await request('POST', `/api/suppliers/${supplier.id}/offers`, { key, body: { itemId: it.value, currency: cur.value, moq: moq.value.trim() || undefined, incoterm: inc.value || undefined, leadTimeDays: lead.value.trim() || undefined, validUntil: until.value || undefined, tiers: out } });
      busy = false; btn.disabled = false;
      if (r.status === 200) { banner('Offre enregistrée.', 'ok'); S.stack.pop(); render(); } else put(err, warn(r.status === 0 ? 'Connexion indisponible : l’offre n’a pas été enregistrée.' : errText(r)));
    } }, 'Enregistrer l’offre');
    put(box, h('div', { class: 'card' }, field('Produit', it), field('Devise', cur), h('h2', {}, 'Prix par palier'), h('p', { class: 'small muted' }, 'Le prix baisse quand la quantité monte. Laissez vides les paliers inutiles.'), tiers.map((t) => h('div', { class: 'row' }, h('div', {}, t.q), h('div', {}, t.p))), field('Minimum de commande (MOQ)', moq), field('Incoterm', inc), field('Délai (jours)', lead), field('Valable jusqu’au', until), err, btn));
  }

  // ------------------------------------------------------------------ stock actions
  /** Send the decision of a request; an owner who prepared it themselves is asked to confirm the exception, once, for this operation. */
  async function decide(requestId, decision, { reason, selfConfirmed = false } = {}) {
    const r = await request('POST', `/api/stock/requests/${requestId}/decision`, { key: uid('dec'), body: { decision, ...(reason ? { reason } : {}), ...(selfConfirmed ? { confirmSelfApproval: true } : {}) } });
    if (r.status === 403 && r.json?.error === 'SEPARATION_OF_DUTIES' && S.me.canSelfApprove && !selfConfirmed) { if (confirm(SOLO_TEXT)) return decide(requestId, decision, { reason, selfConfirmed: true }); return { status: 0, cancelled: true }; }
    return r;
  }
  const verdict = (r) => (r.cancelled ? null : r.status === 200 ? { ok: true } : { ok: false, text: r.status === 0 ? 'Connexion indisponible : rien n’a été changé. Réessayez avec une connexion.' : errText(r) });

  async function screenAdjust({ item, locations }) {
    setHead('Ajuster le stock', item.name, true); const box = h('div', {}); swap(main, box);
    if (needs(box, S.me.canReceive || S.me.canAdjust, 'Seules les personnes autorisées par le propriétaire peuvent demander un ajustement.')) return;
    const here = item.perLocation.map((l) => [l.locationId, `${l.name} — ${l.onHand} en stock`]); const all = locations.filter((l) => ['WAREHOUSE', 'STORE', 'BACKROOM', 'QUARANTINE'].includes(l.type)).map((l) => [l.id, locLabel(l)]);
    const where = select(here.length ? here : all, (here[0] ?? all[0])?.[0]); const delta = h('input', { inputmode: 'numeric', placeholder: 'ex. -3 (perdu, cassé) ou 5 (trouvé)' }); const why = h('textarea', { placeholder: 'Pourquoi ? (obligatoire, 5 caractères minimum)' }); const out = h('div', {}); let busy = false;
    const send = h('button', { class: 'btn', onclick: async () => {
      if (busy) return; swap(out); const d = parseWhole(delta.value);
      if (!d.ok || d.value === 0) return put(out, warn('Indiquez un nombre d’unités différent de zéro (négatif pour retirer du stock).'));
      if (why.value.trim().length < 5) return put(out, warn('Le motif est obligatoire (5 caractères minimum).'));
      busy = true; send.disabled = true;
      const r = await request('POST', '/api/stock/requests', { key: uid('adj'), body: { type: 'ADJUST', itemId: item.itemId, locationId: where.value, delta: d.value, reason: why.value.trim() } });
      busy = false; send.disabled = false;
      if (r.status !== 200) return put(out, warn(r.status === 0 ? 'Connexion indisponible : la demande n’a pas été enregistrée.' : errText(r)));
      const id = r.json.request.requestId; swap(main, h('div', { class: 'card' }, h('h2', {}, 'Demande enregistrée'), h('p', {}, `${d.value > 0 ? '+' : ''}${d.value} × ${item.name}. Le stock ne change qu’après l’approbation d’une autre personne habilitée.`),
        S.me.canSelfApprove ? h('div', {}, h('p', { class: 'small muted' }, 'Vous êtes le propriétaire : si vous gérez seul le stock, vous pouvez l’appliquer vous-même (exception inscrite au journal).'), h('button', { class: 'btn', onclick: async () => { const v = verdict(await decide(id, 'APPROVE')); if (!v) return; if (v.ok) { banner('Ajustement appliqué.', 'ok'); S.stack.pop(); S.stack.pop(); render(); } else banner(v.text, 'err'); } }, 'Appliquer maintenant')) : null,
        h('button', { class: 'btn sec', onclick: () => { S.stack.pop(); S.stack.pop(); render(); } }, 'Terminer')));
    } }, 'Déposer la demande d’ajustement');
    put(box, h('div', { class: 'card' }, h('p', { class: 'small muted' }, `Stock actuel : ${item.physical} (dont ${item.available} à vendre). Un ajustement corrige le stock sans réception : il est toujours tracé et validé par une personne habilitée.`), field('Emplacement', where), field('Variation', delta), field('Motif', why), out, send));
  }
  function screenNewLocation() {
    setHead('Nouvel emplacement', '', true);
    if (!S.me.canSelfApprove) return swap(main, warn('Seul le propriétaire crée un emplacement de stock.'));
    const key = uid('loc'); const name = h('input', { placeholder: 'ex. Magasin de Namur', autocomplete: 'off' }); const type = select(Object.entries(LOC_FR).map(([v, t]) => [v, t[0].toUpperCase() + t.slice(1)]), 'STORE'); const err = h('div', {}); let busy = false;
    const btn = h('button', { class: 'btn', onclick: async () => {
      if (busy) return; swap(err); if (!name.value.trim()) return put(err, warn('Le nom de l’emplacement est nécessaire.'));
      busy = true; btn.disabled = true; const r = await request('POST', '/api/locations', { key, body: { name: name.value.trim(), type: type.value } }); busy = false; btn.disabled = false;
      if (r.status === 200) { banner('Emplacement créé.', 'ok'); S.stack.pop(); render(); } else put(err, warn(r.status === 0 ? 'Connexion indisponible : rien n’a été créé.' : errText(r)));
    } }, 'Créer l’emplacement');
    swap(main, h('div', { class: 'card' }, h('p', { class: 'small muted' }, 'Un emplacement est un endroit où le stock se trouve (entrepôt, magasin, réserve). Les transferts et les inventaires se font entre emplacements.'), field('Nom', name), field('Type', type), err, btn));
  }
  async function screenTransfer({ item, locations }) {
    setHead('Transférer', item.name, true); const box = h('div', {}); swap(main, box);
    if (needs(box, S.me.canReceive, 'Seules les personnes autorisées par le propriétaire peuvent déplacer du stock.')) return;
    const from = select(item.perLocation.filter((l) => l.onHand - l.reserved > 0).map((l) => [l.locationId, `${l.name} — ${l.onHand - l.reserved} disponibles`]), item.perLocation[0]?.locationId);
    const to = select(locations.filter((l) => ['WAREHOUSE', 'STORE', 'BACKROOM'].includes(l.type)).map((l) => [l.id, locLabel(l)]));
    const qty = h('input', { inputmode: 'numeric', placeholder: 'quantité' }); const why = h('input', { placeholder: 'motif (facultatif)' }); const out = h('div', {}); let busy = false; const key = uid('tr');
    const sellable = locations.filter((l) => ['WAREHOUSE', 'STORE', 'BACKROOM'].includes(l.type));
    if (sellable.length < 2) return put(box, empty('Un transfert demande au moins deux emplacements (par ex. entrepôt et magasin).'), S.me.canSelfApprove ? h('button', { class: 'btn', onclick: () => go('newLocation') }, 'Créer un emplacement') : h('div', { class: 'note' }, 'Demandez au propriétaire de créer l’emplacement.'));
    const send = h('button', { class: 'btn', onclick: async () => {
      if (busy) return; swap(out); const q = parseInteger(qty.value); if (!q) return put(out, warn('Indiquez une quantité d’au moins 1.')); if (from.value === to.value) return put(out, warn('Choisissez deux emplacements différents.'));
      busy = true; send.disabled = true;
      const r = await request('POST', '/api/stock/transfers', { key, body: { itemId: item.itemId, fromLocationId: from.value, toLocationId: to.value, qty: q, reason: why.value.trim() || undefined } });
      busy = false; send.disabled = false;
      if (r.status === 200) { banner('Transfert enregistré.', 'ok'); S.stack.pop(); S.stack.pop(); render(); } else put(out, warn(r.status === 0 ? 'Connexion perdue : le transfert n’a peut-être PAS été enregistré. Appuyez à nouveau : le même envoi ne sera jamais compté deux fois.' : errText(r)));
    } }, 'Enregistrer le transfert');
    if (!item.perLocation.some((l) => l.onHand - l.reserved > 0)) return put(box, empty('Aucune unité disponible à déplacer.'));
    put(box, h('div', { class: 'card' }, field('De', from), field('Vers', to), field('Quantité', qty), field('Motif', why), out, send));
  }
  async function screenHistory({ item }) {
    setHead('Historique', item.name, true); const box = h('div', {}); swap(main, box);
    const res = await getJson(`/api/stock/${item.itemId}/history`); if (!res.data) return put(box, fail(res));
    const m = [...res.data.movements].reverse();
    put(box, stale(res), h('div', { class: 'card' }, h('h2', {}, 'Mouvements (du plus récent au plus ancien)'), m.length ? h('table', {}, h('tbody', {}, m.map((x) => h('tr', {}, h('td', {}, h('div', {}, KIND_FR[x.kind] ?? x.kind), h('div', { class: 'small muted' }, `${new Date(x.at).toLocaleString('fr-BE', { dateStyle: 'short', timeStyle: 'short' })} · ${x.location ?? ''} · ${x.actorId}${x.reason ? ` · ${x.reason}` : ''}`)), h('td', { class: 'n' }, `${x.bucket === 'RESERVED' ? '(réservé) ' : ''}${x.delta > 0 ? '+' : ''}${x.delta}`))))) : empty('Aucun mouvement.')),
      h('div', { class: 'card' }, h('h2', {}, 'Journal'), res.data.events.length ? h('ul', { class: 'list' }, [...res.data.events].reverse().map((e) => h('li', {}, h('div', { class: 'grow' }, h('div', { class: 'nm' }, eventLabel(e.type)), h('div', { class: 'small muted' }, `${new Date(e.at).toLocaleString('fr-BE', { dateStyle: 'short', timeStyle: 'short' })} · ${e.actor?.id ?? ''}${e.approval ? ` · approuvé par ${e.approval.approverId}${e.approval.separationWaived ? ' (exception propriétaire)' : ''}` : ''}`))))) : empty('Aucun événement.')));
  }

  // ------------------------------------------------------------------ inventory (count)
  async function screenCount() {
    setHead('Inventaire', 'Compter un emplacement', true); const box = h('div', {}); swap(main, box);
    if (needs(box, S.me.canReceive || S.me.canAdjust, 'Seules les personnes autorisées par le propriétaire peuvent faire un inventaire.')) return;
    const res = await getJson('/api/stock'); if (!res.data) return put(box, fail(res));
    const locs = res.data.locations.filter((l) => ['WAREHOUSE', 'STORE', 'BACKROOM'].includes(l.type)); if (!locs.length) return put(box, empty('Aucun emplacement à compter.'));
    const where = select(locs.map((l) => [l.id, locLabel(l)]), locs[0].id); const list = h('div', {}); const out = h('div', {}); let rows = [];
    const draw = () => {
      const items = res.data.items.filter((i) => i.perLocation.some((l) => l.locationId === where.value)); const onHand = (i) => i.perLocation.find((l) => l.locationId === where.value)?.onHand ?? 0;
      rows = items.map((i) => ({ i, expected: onHand(i), counted: h('input', { inputmode: 'numeric', placeholder: String(onHand(i)) }), reason: h('input', { placeholder: 'motif si écart' }) })); swap(out);
      swap(list, rows.length ? rows.map((r) => h('div', { class: 'card' }, h('div', { class: 'nm' }, r.i.name), h('div', { class: 'small muted' }, `Attendu (stock Nordla) : ${r.expected} — comptez ce qui est réellement là`), h('div', { class: 'row' }, h('div', {}, r.counted), h('div', {}, r.reason)))) : empty('Aucun produit en stock à cet emplacement.'));
    };
    where.addEventListener('change', draw);
    const check = h('button', { class: 'btn', onclick: async () => {
      swap(out); const v = countLinesFrom(rows.map((r) => ({ itemId: r.i.itemId, name: r.i.name, expected: r.expected, counted: r.counted.value, reason: r.reason.value })));
      if (!v.ok) return put(out, ...v.errors.map(warn));
      const pv = await request('POST', '/api/stock/counts/preview', { body: { locationId: where.value, counts: v.lines.map((l) => ({ itemId: l.itemId, counted: l.counted })) } });
      if (pv.status !== 200) return put(out, warn(pv.status === 0 ? 'Connexion indisponible.' : errText(pv)));
      const diff = pv.json.lines.filter((x) => x.variance !== 0);
      put(out, h('div', { class: 'card' }, h('h2', {}, diff.length ? `${diff.length} écart(s) à valider` : 'Aucun écart : le stock Nordla est juste'), diff.length ? h('table', {}, h('tbody', {}, diff.map((x) => h('tr', {}, h('td', {}, x.name), h('td', { class: 'n' }, `${x.expected} → ${x.counted} (${x.variance > 0 ? '+' : ''}${x.variance})`))))) : null,
        h('button', { class: 'btn', onclick: async () => {
          const body = { type: 'COUNT', locationId: where.value, counts: v.lines.map((l) => ({ itemId: l.itemId, counted: l.counted, reason: l.reason || undefined })) };
          const r = await request('POST', '/api/stock/requests', { key: uid('cnt'), body });
          if (r.status !== 200) return banner(r.status === 0 ? 'Connexion indisponible : inventaire non enregistré.' : errText(r), 'err');
          if (r.json.status === 'CONFIRMED') { banner('Inventaire confirmé : aucun écart.', 'ok'); S.stack.pop(); return render(); }
          banner('Écarts déposés : ils seront appliqués après approbation.', 'ok'); S.stack.pop(); go('requests');
        } }, diff.length ? 'Déposer les écarts pour approbation' : 'Confirmer l’inventaire')));
    } }, 'Vérifier mon comptage');
    put(box, h('div', { class: 'card' }, h('p', { class: 'small muted' }, 'Comptez, puis vérifiez : rien ne change avant votre confirmation, et les écarts ne sont appliqués qu’après l’approbation d’une personne habilitée.'), field('Emplacement', where)), list, out, check); draw();
  }

  // ------------------------------------------------------------------ the queue of filed changes
  async function screenRequests() {
    setHead('Demandes de stock', 'Ajustements et inventaires', true); const box = h('div', {}); swap(main, box);
    const res = await getJson('/api/stock/requests'); if (!res.data) return put(box, fail(res));
    const pend = res.data.requests.filter((r) => r.status === 'PENDING'); const done = res.data.requests.filter((r) => r.status !== 'PENDING').slice(0, 15);
    const act = async (r, decision) => {
      let reason; if (decision === 'REJECT') { reason = prompt('Motif (obligatoire, 5 caractères minimum) :'); if (!reason || reason.trim().length < 5) return; reason = reason.trim(); }
      const v = verdict(await decide(r.requestId, decision, { reason })); if (!v) return; if (v.ok) { banner(decision === 'APPROVE' ? 'Demande approuvée et appliquée.' : 'Demande refusée.', 'ok'); render(); } else banner(v.text, 'err');
    };
    const card = (r) => h('div', { class: 'card' }, h('div', { class: 'nm' }, requestSummary(r)), h('div', { class: 'small muted' }, `Demandé par ${r.requestedBy} le ${fmtDate(r.requestedAt)}${r.location ? ` · ${r.location}` : ''}`),
      r.type === 'COUNT' && r.status === 'PENDING' ? h('table', {}, h('tbody', {}, r.lines.map((l) => h('tr', {}, h('td', {}, l.name), h('td', { class: 'n' }, `compté ${l.counted}${l.expectedNow != null ? ` · attendu ${l.expectedNow}` : ''}`))))) : null,
      r.type === 'ADJUST' ? h('div', { class: 'small' }, `Motif : ${r.why}`) : null,
      r.status === 'PENDING' ? h('div', {}, S.me.canAdjust && r.requestedBy !== S.me.id ? h('button', { class: 'btn', onclick: () => act(r, 'APPROVE') }, 'Approuver et appliquer') : null,
        S.me.canSelfApprove && r.requestedBy === S.me.id ? h('button', { class: 'btn sec', onclick: () => act(r, 'APPROVE') }, 'Appliquer moi-même (exception propriétaire)') : null,
        S.me.canAdjust || r.requestedBy === S.me.id ? h('button', { class: 'btn danger', onclick: () => act(r, 'REJECT') }, r.requestedBy === S.me.id ? 'Retirer ma demande' : 'Refuser') : null,
        !S.me.canAdjust && r.requestedBy !== S.me.id ? h('div', { class: 'note' }, 'En attente de la décision d’une personne habilitée.') : null)
        : h('div', { class: 'small' }, chip(r.status === 'APPROVED' ? 'approuvée' : 'refusée', r.status === 'APPROVED' ? 'g' : 'r'), ` par ${r.decidedBy ?? '—'}${r.selfApproved ? ' · exception propriétaire' : ''}${r.reason ? ` · ${r.reason}` : ''}`));
    put(box, stale(res), h('h2', {}, `À traiter (${pend.length})`), pend.length ? pend.map(card) : empty('Aucune demande en attente.'), done.length ? [h('h2', {}, 'Dernières décisions'), done.map(card)] : null);
  }

  return { newLocation: screenNewLocation, suppliers: screenSuppliers, newSupplier: screenNewSupplier, supplier: screenSupplier, newOffer: screenNewOffer, adjust: screenAdjust, transfer: screenTransfer, history: screenHistory, count: screenCount, requests: screenRequests, decide };
}
