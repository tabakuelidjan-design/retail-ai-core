// Pure logic of the phone screens (no DOM, no network): parsing what a person types, building the payloads, French wording of what the server answered, the
// shopping-list ("selection") rules, and what the send queue does with each HTTP answer. Unit-tested in Node (test/procurement-ui-logic.test.js).

const INCOTERMS = ['EXW', 'FCA', 'FOB', 'CFR', 'CIF', 'CPT', 'CIP', 'DAP', 'DDP'];
export const CURRENCIES = ['CNY', 'USD', 'EUR'];

/** "3,5" -> "3.5"; "0.035" stays; anything that is not an exact positive decimal (max 6 decimals) -> null. Never guesses ("about 3", "¥3"). */
export function parseDecimal(text) {
  const s = String(text ?? '').trim().replace(',', '.');
  return /^\d{1,9}(\.\d{1,6})?$/.test(s) && Number(s) > 0 ? s : null;
}
export const parseInteger = (text) => { const s = String(text ?? '').trim(); return /^\d{1,9}$/.test(s) && Number(s) > 0 ? Number(s) : null; };

/**
 * @param {{ currency: string, unitPrice: string, moq: string, tiers: {minQty: string, unitPrice: string}[], incoterm: string, leadTimeDays: string, note: string }} f
 * @returns {{ ok: boolean, quote?: object, errors: string[] }}
 */
export function buildQuotePayload(f) {
  const errors = [];
  const currency = String(f.currency ?? '').toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) errors.push('Choisissez la devise.');
  const unit = parseDecimal(f.unitPrice);
  const tierRows = (f.tiers ?? []).filter((t) => String(t.minQty ?? '').trim() || String(t.unitPrice ?? '').trim());
  const typed = String(f.unitPrice ?? '').trim();
  if (typed && !unit) errors.push('Prix unitaire illisible : écrivez un nombre exact, sans symbole (0,52).');
  else if (!unit && !tierRows.length) errors.push('Saisissez le prix unitaire (par exemple 0,52).');
  const moq = String(f.moq ?? '').trim() ? parseInteger(f.moq) : null;
  if (String(f.moq ?? '').trim() && !moq) errors.push('Quantité minimale (MOQ) illisible.');
  const tiers = [];
  if (unit) tiers.push({ minQty: moq ?? 1, unitPrice: unit });
  for (const [i, t] of tierRows.entries()) {
    const q = parseInteger(t.minQty); const p = parseDecimal(t.unitPrice);
    if (!q || !p) { errors.push(`Palier ${i + 1} : quantité et prix exacts attendus.`); continue; }
    tiers.push({ minQty: q, unitPrice: p });
  }
  tiers.sort((a, b) => a.minQty - b.minQty);
  for (let i = 1; i < tiers.length; i++) {
    if (tiers[i].minQty === tiers[i - 1].minQty) { errors.push(`Deux prix pour la même quantité (${tiers[i].minQty}).`); break; }
    if (Number(tiers[i].unitPrice) > Number(tiers[i - 1].unitPrice)) { errors.push(`Un palier plus grand ne peut pas coûter plus cher (${tiers[i].minQty} pièces).`); break; }
  }
  const lead = String(f.leadTimeDays ?? '').trim() ? parseInteger(f.leadTimeDays) : null;
  if (String(f.leadTimeDays ?? '').trim() && !lead) errors.push('Délai illisible (en jours).');
  const incoterm = f.incoterm && INCOTERMS.includes(f.incoterm) ? f.incoterm : null;
  if (errors.length) return { ok: false, errors };
  return { ok: true, errors, quote: { currency, tiers, ...(moq ? { moq } : {}), ...(incoterm ? { incoterm } : {}), ...(lead ? { leadTimeDays: lead } : {}), ...(String(f.note ?? '').trim() ? { note: String(f.note).trim().slice(0, 300) } : {}) } };
}

export const microToString = (m) => `${Math.floor(m / 1e6)}.${String(m % 1e6).padStart(6, '0')}`.replace(/0+$/, '').replace(/\.$/, '.0');
export const fmtMoney = (minor, currency = 'EUR', locale = 'fr-BE') => { try { return new Intl.NumberFormat(locale, { style: 'currency', currency }).format(minor / 100); } catch { return `${(minor / 100).toFixed(2)} ${currency}`; } };
export const fmtDate = (iso, locale = 'fr-BE') => { try { return new Date(iso).toLocaleDateString(locale, { day: 'numeric', month: 'short', year: 'numeric' }); } catch { return String(iso); } };

export const PO_STATUS_FR = { DRAFT: 'Brouillon', PENDING_APPROVAL: 'À approuver', APPROVED: 'Approuvé', ORDERED: 'Commandé', CONFIRMED: 'Confirmé', PARTIALLY_RECEIVED: 'Reçu en partie', RECEIVED: 'Reçu', CLOSED: 'Clos', CANCELLED: 'Annulé' };
export const PO_GROUPS = [['DRAFT', 'Brouillons'], ['PENDING_APPROVAL', 'À approuver'], ['APPROVED', 'Approuvés, à commander'], ['ORDERED', 'Commandés'], ['CONFIRMED', 'Confirmés'], ['PARTIALLY_RECEIVED', 'Reçus en partie']];

/** What a person may do with an order on the phone. Engaging steps are never queued: they need the server's answer. */
export function poActions(po, me) {
  const acts = [];
  if (po.status === 'DRAFT') acts.push({ id: 'submit', label: 'Envoyer pour approbation', primary: true }, { id: 'cancel', label: 'Supprimer ce brouillon', danger: true, needsReason: true });
  if (po.status === 'PENDING_APPROVAL') {
    if (me.canApprove && me.id !== po.createdBy && me.id !== po.submittedBy) acts.push({ id: 'approve', label: 'Approuver', primary: true });
    else if (me.canApprove) acts.push({ id: 'blocked', label: 'Vous avez préparé ce bon : une autre personne habilitée doit l’approuver.', info: true });
    if (me.canApprove) acts.push({ id: 'reject', label: 'Renvoyer en brouillon', needsReason: true });
  }
  if (po.status === 'APPROVED' && me.canApprove) acts.push({ id: 'order', label: 'Marquer comme commandé', primary: true, confirm: 'Confirmez : la commande a été passée auprès du fournisseur. Nordla n’envoie rien et ne paie rien.' });
  if (['APPROVED'].includes(po.status) && !me.canApprove) acts.push({ id: 'wait', label: 'En attente de la commande par une personne habilitée.', info: true });
  return acts;
}

const OFFER_FR = {
  FX_REQUIRED: (o) => `Saisissez le taux ${o.currency} → EUR pour comparer.`,
  BELOW_MOQ: () => 'Quantité sous le minimum du fournisseur (MOQ).',
  BELOW_FIRST_TIER: () => 'Quantité sous le premier palier de prix.',
  PRICE_PRECISION_EXCEEDS_FINANCE_ENGINE: () => 'Prix trop précis pour le calcul du coût rendu (4 décimales max).',
};
/** French card text for one comparison offer. `money` formats EUR minor units. */
export function describeOffer(o, qty) {
  const chips = [];
  if (o.incoterm) chips.push({ t: o.incoterm, k: '' });
  if (o.leadTimeDays) chips.push({ t: `${o.leadTimeDays} j`, k: '' });
  if (o.estimated) chips.push({ t: 'ESTIMÉ (taux saisi)', k: 'a' });
  if (o.status === 'LANDED') return { usable: true, headline: `Coût rendu : ${fmtMoney(Number(o.landedTotal ?? o.landedPerUnit * qty))} pour ${qty} pièces`, detail: `≈ ${fmtMoney(Number(o.landedPerUnit))} / pièce (arrondi au centime par le calcul Finance : fiez-vous au total). Prix fournisseur ${o.unitPrice} ${o.currency}. Estimation : transport, droits et taux saisis par vous ; ce n’est pas un montant fiscal définitif.`, chips: [...chips, { t: 'coût rendu', k: 'g' }] };
  if (o.status === 'GOODS_ONLY') return { usable: true, headline: `${o.unitPrice} ${o.currency} / pièce ≈ ${o.goodsUnitEur} € (marchandises seules)`, detail: 'Transport et droits non saisis : le classement ne compare que le prix des marchandises.', chips: [...chips, { t: 'sans coût d’approche', k: 'a' }] };
  const why = (OFFER_FR[o.reason] ?? (() => `Non comparable (${o.reason}).`))(o);
  return { usable: false, headline: why, detail: o.status === 'NOT_ELIGIBLE' ? `Pour ${qty} pièces.` : 'Offre listée mais non classée.', chips };
}

/** One selection = one supplier (one purchase order). Adding another supplier's line replaces the selection only after the person agreed. */
export function addToCart(cart, line, { replace = false } = {}) {
  if (cart.length && cart[0].supplierId !== line.supplierId && !replace) return { cart, conflict: true };
  const base = cart.length && cart[0].supplierId !== line.supplierId ? [] : cart.filter((l) => l.itemId !== line.itemId);
  return { cart: [...base, line], conflict: false };
}

/**
 * What the send queue does with an HTTP answer.
 *  DONE   the server has it (including a replayed duplicate): remove from the queue
 *  RETRY  connection / server trouble: keep, try again later with the SAME key
 *  REJECT the server understood and refused (bad input, forbidden...): keep visible for the person to fix or delete, do not loop
 */
export function classifyHttp(status) {
  if (status >= 200 && status < 300) return 'DONE';
  if (status === 0 || status === 408 || status === 425 || status === 429 || status >= 500) return 'RETRY';
  return 'REJECT';
}
export const backoffMs = (attempts) => Math.min(60_000, 2000 * 2 ** Math.max(0, attempts - 1));
