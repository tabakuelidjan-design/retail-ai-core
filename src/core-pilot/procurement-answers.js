// Parle à Nordla -> Stock / Achats (READ ONLY). The answers come from the persistent procurement store through its assistant tools (src/procurement/assistant.js);
// nothing here writes, orders, receives or adjusts: those steps stay on the Achats screens with the named-human approval.
// Deterministic: a sentence is recognised by plain rules; an unknown item or an ambiguous name is asked back, never guessed.
const norm = (s) => String(s ?? '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim();
const money = (minor, cur) => (Number.isInteger(minor) ? `${(minor / 100).toFixed(2).replace('.', ',')} ${cur ?? ''}`.trim() : 'inconnu');
const SRC = (tool, extra = {}) => ({ kind: 'procurement', ref: tool, ...extra });
const NL = String.fromCharCode(10);

const S = Object.freeze({
  openOrders: /(commandes?|bons? de commande|purchase orders?)\b.*(en cours|ouvert|en attente|a approuver|ou en est|liste|statut|suivi)|\bPO-\d{4}-\d{3,}/i,
  transit: /(en transit|en route|en cours de livraison|attendu|a recevoir|en commande)/,
  delayed: /retard/,
  reorder: /(reapprovision|rupture|a recommander|a commander|restock)/,
  stock: /(\bstock\b|en stock|inventaire)/,
});

/** @returns {Promise<object|null>} an answer in the shape of ask.js, or null when the sentence is not about orders / stock. */
export async function procurementAnswer(text, assistant) {
  const t = norm(text);
  const call = (tool, args = {}) => assistant.call(tool, args);
  if (S.delayed.test(t) && /(commande|livraison|fournisseur|achat)/.test(t)) {
    const r = await call('delayed_orders');
    return reply(r.delayed.length ? `${r.delayed.length} commande(s) en retard :${NL}${r.delayed.map((d) => `• ${d.number ?? d.poId} — attendue le ${d.expectedDate ?? 'date inconnue'}`).join(NL)}` : 'Aucune commande en retard.', 'delayed_orders');
  }
  if (S.reorder.test(t)) {
    const r = await call('reorder_alerts');
    return reply(r.alerts.length ? `${r.alerts.length} article(s) à réapprovisionner :${NL}${r.alerts.map((a) => `• ${a.sku ?? a.itemId} — disponible ${a.available ?? '?'}, seuil ${a.reorderPoint ?? '?'} (le stock entrant n’est jamais compté comme disponible)`).join(NL)}` : 'Aucun article sous son seuil de réapprovisionnement (seuils configurés uniquement).', 'reorder_alerts');
  }
  if (S.openOrders.test(text) || /(mes|les|toutes les) (commandes|bons de commande)/.test(t)) {
    const r = await call('open_purchase_orders');
    const po = (/PO-\d{4}-\d{3,}/i.exec(text) ?? [])[0]?.toUpperCase();
    const list = po ? r.orders.filter((o) => o.number === po) : r.orders;
    if (po && !list.length) return reply(`Je ne trouve pas la commande ${po}.`, 'open_purchase_orders', 'NOT_FOUND');
    return reply(list.length ? `${list.length} commande(s) d’achat :${NL}${list.map((o) => `• ${o.number} — ${o.status}, ${money(o.totalMinor, o.currency)}${o.expectedDate ? `, attendue le ${o.expectedDate}` : ''}`).join(NL)}${NL}Commander, approuver ou réceptionner se fait dans l’écran Achats (approbation nommée), jamais par une phrase.` : 'Aucune commande d’achat en cours.', 'open_purchase_orders');
  }
  if (S.transit.test(t) && !S.stock.test(t)) {
    const r = await call('goods_in_transit'); const o = r.orderedNotReceived;
    const vals = Object.entries(o.goodsValueMinorByCurrency ?? {}).map(([c, v]) => money(v, c)).join(' + ');
    return reply(o.units ? `${o.units} unité(s) commandées et pas encore reçues (${o.lines.length} ligne(s))${vals ? `, valeur marchandises ${vals} (devises jamais additionnées)` : ''}. Elles ne sont pas dans le stock disponible.` : 'Rien n’est en commande en attente de réception.', 'goods_in_transit');
  }
  if (S.stock.test(t)) {
    const sku = (/\b[A-Za-z]{2,}-\d{2,}\b/.exec(text) ?? [])[0];
    const name = t.replace(/.*\b(?:stock|inventaire)\b\s*(?:de|du|des|d'|pour|sur)?\s*/, '').replace(/[?!.]+$/, '').trim();
    if (!sku && (!name || /^(total|general|actuel|disponible|global|ma boutique|tout)$/.test(name) || name.split(' ').length > 4)) {
      const r = await call('stock_overview'); const ps = r.positions ?? [];
      return reply(ps.length ? `Stock de ${ps.length} article(s) :${NL}${ps.map((p) => `• ${p.sku} — physique ${p.physical}, disponible ${p.available}${p.incoming?.qty ? `, + ${p.incoming.qty} attendus (non comptés)` : ''}`).join(NL)}` : 'Aucun article au catalogue Achats.', 'stock_overview');
    }
    const found = sku ? { candidates: [{ sku: sku.toUpperCase() }], status: 'OK' } : await call('find_item', { text: name });
    if (found.status === 'NOT_FOUND') return reply(`Je ne trouve aucun article « ${name} » dans le catalogue Achats.`, 'find_item', 'NOT_FOUND');
    if (found.status === 'AMBIGUOUS') return { status: 'ASK', answer: `Plusieurs articles correspondent : ${found.candidates.map((c) => `${c.sku} (${c.name})`).join(' ; ')}. Lequel ?`, sources: [SRC('find_item')], limits: [] };
    const s = await call('stock_position', { sku: found.candidates[0].sku });
    if (s.status !== 'OK') return { status: 'ASK', answer: 'Quel article (référence exacte) ?', sources: [SRC('stock_position')], limits: [] };
    const p = s.position; const v = p.valuation;
    return reply(`${p.sku} — physique ${p.physical}, disponible ${p.available} (réservé ${p.reserved}, quarantaine ${p.quarantine}). Attendu : ${p.incoming?.qty ?? 0} unité(s)${p.incoming?.orders?.length ? ` (${p.incoming.orders.map((o) => `${o.number} ${o.status}${o.delayed ? ', en retard' : ''}`).join(' ; ')})` : ''}, non compté comme disponible. Valeur du stock : ${v?.status === 'UNKNOWN' ? 'inconnue (coût d’achat non renseigné pour certaines unités)' : money(v?.valueEurMinor, 'EUR')}.`, 'stock_position', 'ANSWERED', { sku: p.sku });
  }
  return null;
}

function reply(answer, tool, status = 'ANSWERED', extra = {}) {
  return { status, answer, sources: [SRC(tool, { as_of: new Date().toISOString(), ...extra })], limits: [] };
}
