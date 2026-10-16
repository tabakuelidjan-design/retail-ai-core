// Pure logic of the phone screens (no DOM, no network): parsing what a person types, building the payloads, French wording of what the server answered, the
// shopping-list ("selection") rules, and what the send queue does with each HTTP answer. Unit-tested in Node (test/procurement-ui-logic.test.js).

const INCOTERMS = ['EXW', 'FCA', 'FOB', 'CFR', 'CIF', 'CPT', 'CIP', 'DAP', 'DDP'];
export const CURRENCIES = ['CNY', 'USD', 'EUR'];

/** "3,5" -> "3.5"; "0.035" stays; anything that is not an exact positive decimal (max 6 decimals) -> null. Never guesses ("about 3", "¥3"). */
export function parseDecimal(text) {
  const s = String(text ?? '').trim().replace(',', '.');
  return /^\d{1,9}(\.\d{1,6})?$/.test(s) && Number(s) > 0 ? s : null;
}
/** A whole number, possibly negative: "-3" -> { ok: true, value: -3 }; "3.5", "abc", "" -> { ok: false }. */
export function parseWhole(text, { min = -1e6 } = {}) { const s = String(text ?? '').trim(); if (!/^-?\d{1,9}$/.test(s)) return { ok: false }; const v = Number(s); return v >= min ? { ok: true, value: v } : { ok: false }; }
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

/** Plausible EUR value of 1 unit of a currency. A rate outside the range is not refused (rates move) but must be confirmed: a typed-in inverse (0,92 vs 1,09) is the classic mistake. */
const FX_RANGES = { USD: [0.6, 1.3], CNY: [0.08, 0.2], GBP: [1.0, 1.5], HKD: [0.08, 0.15], JPY: [0.004, 0.009], CHF: [0.8, 1.3] };
export function fxPlausibility(currency, rate) {
  const range = FX_RANGES[currency]; const r = Number(rate);
  if (!range || !Number.isFinite(r) || r <= 0) return { ok: true, known: Boolean(range) };
  if (r >= range[0] && r <= range[1]) return { ok: true, known: true };
  const inverted = 1 / r >= range[0] && 1 / r <= range[1];
  return { ok: false, known: true, inverted, message: inverted ? `Ce taux ressemble à l’inverse : 1 ${currency} vaut environ ${range[0]} à ${range[1]} €, pas ${rate}. Vérifiez le sens.` : `Taux inhabituel : 1 ${currency} vaut en général entre ${range[0]} et ${range[1]} €.` };
}

/** Receipt form -> payload lines, or the errors to show. `po.lines[i]` has qty and qtyReceived; entries are what the person typed. Nothing above what is still outstanding. */
export function receiptLinesFrom(po, entries) {
  const errors = []; const lines = []; let total = 0;
  for (const l of po.lines) {
    const e = entries.find((x) => x.lineId === l.id) ?? { accepted: '', defective: '' };
    const num = (v, what) => { const t = String(v ?? '').trim(); if (!t) return 0; if (!/^\d{1,7}$/.test(t)) { errors.push(`${l.name ?? l.sku} : ${what} illisible.`); return 0; } return Number(t); };
    const accepted = num(e.accepted, 'quantité acceptée'); const defective = num(e.defective, 'quantité défectueuse'); const remaining = l.qty - l.qtyReceived;
    if (accepted + defective > remaining) errors.push(`${l.name ?? l.sku} : ${accepted + defective} reçus alors qu’il n’en reste que ${remaining} à recevoir.`);
    if (accepted + defective > 0) { lines.push({ poLineId: l.id, qtyAccepted: accepted, qtyDefective: defective }); total += accepted + defective; }
  }
  if (!errors.length && !total) errors.push('Saisissez au moins une quantité reçue.');
  return { ok: !errors.length, errors, lines, total };
}

/** What a person may do with an order on the phone. Engaging steps are never queued: they need the server's answer. */
export function poActions(po, me) {
  const acts = [];
  if (po.status === 'DRAFT') acts.push({ id: 'submit', label: 'Envoyer pour approbation', primary: true }, { id: 'cancel', label: 'Supprimer ce brouillon', danger: true, needsReason: true });
  if (po.status === 'PENDING_APPROVAL') {
    if (me.canApprove && me.id !== po.createdBy && me.id !== po.submittedBy) acts.push({ id: 'approve', label: 'Approuver', primary: true });
    else if (me.canApprove && me.canSelfApprove) acts.push({ id: 'approve', label: 'Approuver quand même (exception propriétaire)', selfApprove: true, confirm: 'Vous avez vous-même préparé ce bon. En tant que propriétaire, vous pouvez l’approuver vous-même : c’est une EXCEPTION, elle sera inscrite au journal avec votre nom. Confirmer ?' });
    else if (me.canApprove) acts.push({ id: 'blocked', label: 'Vous avez préparé ce bon : une autre personne habilitée doit l’approuver.', info: true });
    if (me.canApprove) acts.push({ id: 'reject', label: 'Renvoyer en brouillon', needsReason: true });
  }
  if (['ORDERED', 'CONFIRMED', 'PARTIALLY_RECEIVED'].includes(po.status) && me.canReceive) acts.push({ id: 'receive', label: 'Réceptionner la marchandise', primary: true });
  if (['ORDERED', 'CONFIRMED', 'PARTIALLY_RECEIVED'].includes(po.status) && !me.canReceive) acts.push({ id: 'wait-receive', label: 'La réception est faite par une personne habilitée (entrepôt ou propriétaire).', info: true });
  if (po.status === 'ORDERED' && me.prepare) acts.push({ id: 'confirm', label: 'Noter la confirmation du fournisseur' });
  if (['PARTIALLY_RECEIVED', 'RECEIVED'].includes(po.status) && me.prepare) acts.push({ id: 'close', label: po.status === 'RECEIVED' ? 'Clôturer la commande' : 'Clôturer (le reste n’arrivera pas)', needsReason: po.status === 'PARTIALLY_RECEIVED', confirm: po.status === 'PARTIALLY_RECEIVED' ? 'Clôturer maintenant : les quantités non arrivées sont abandonnées et le motif est conservé. Confirmer ?' : undefined });
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
const eur4 = (minor, qty) => (minor / 100 / qty).toLocaleString('fr-BE', { minimumFractionDigits: 4, maximumFractionDigits: 4 });
export function describeOffer(o, qty) {
  const chips = [];
  if (o.incoterm) chips.push({ t: o.incoterm, k: '' });
  if (o.leadTimeDays) chips.push({ t: `${o.leadTimeDays} j`, k: '' });
  if (o.estimated) chips.push({ t: 'ESTIMÉ (taux saisi)', k: 'a' });
  if (o.status === 'LANDED') return { usable: true, headline: `Coût rendu : ${fmtMoney(Number(o.landedTotal ?? o.landedPerUnit * qty))} pour ${qty} pièces`, detail: `≈ ${o.landedTotal !== undefined ? eur4(Number(o.landedTotal), qty) : fmtMoney(Number(o.landedPerUnit))} € / pièce (total ÷ quantité ; le calcul Finance arrondit au centime : seul le total est exact à 0,01 € près). Prix fournisseur ${o.unitPrice} ${o.currency}. Estimation : transport, droits et taux saisis par vous ; ce n’est pas un montant fiscal définitif.`, chips: [...chips, { t: 'coût rendu', k: 'g' }] };
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

/** A warning when the pieces are so cheap that rounding to the cent matters: below 0,10 EUR a piece, one cent is 10 % or more of the price. */
export function precisionWarning(offers) {
  const cheap = offers.some((o) => (o.status === 'LANDED' && Number(o.landedPerUnit) < 10) || (o.status === 'GOODS_ONLY' && o.goodsUnitEur < 0.1));
  return cheap ? 'Pièces à quelques centimes : le calcul arrondit au centime, comparez les TOTAUX affichés plutôt que le prix par pièce.' : null;
}
/** Quotes of different currencies are compared only through the rates the person typed; list the currencies in play so none is overlooked. */
export const currenciesOf = (offers) => [...new Set(offers.map((o) => o.currency))];
/** What a person reads for a refused request: a French sentence per known code, else the server's message, else a neutral line. Never a code, a table or a stack. */
export const ERRORS_FR = {
  SEPARATION_OF_DUTIES: 'Vous avez préparé ou envoyé ce bon : une autre personne habilitée doit l’approuver.', FORBIDDEN: 'Votre accès ne permet pas cette action.', UNAUTHORIZED: 'Accès refusé : rouvrez le lien d’accès fourni par le propriétaire.',
  TOO_MANY_ATTEMPTS: 'Trop d’essais : patientez une minute.', INVALID_TRANSITION: 'Le bon a changé entre-temps : actualisez la page.', BELOW_MOQ: 'Quantité sous le minimum du fournisseur (MOQ).', FX_REQUIRED: 'Un taux de change est nécessaire.',
  QUOTE_EXPIRED: 'Ce devis a expiré.', VISIT_CLOSED: 'Cette visite est clôturée.', APPROVAL_ALREADY_USED: 'Cette approbation a déjà été utilisée.',
  OVER_RECEIPT: 'Vous essayez de réceptionner plus que la quantité restant à recevoir.', NOT_FOUND: 'Introuvable : actualisez la page.',
};
export const errText = (r) => ERRORS_FR[r.json?.error] ?? (/_NOT_FOUND$/.test(r.json?.error ?? '') ? ERRORS_FR.NOT_FOUND : null) ?? r.json?.message ?? (r.status === 0 ? 'Connexion indisponible.' : `Erreur ${r.status}`);

// ---------------------------------------------------------------- V1: stock changes, inventories, supplier reliability

/** Lines of a physical count typed by hand: only the lines that were counted; a difference from what Nordla expects needs a reason. */
export function countLinesFrom(rows) {
  const errors = []; const lines = [];
  for (const r of rows) {
    const raw = String(r.counted ?? '').trim(); if (raw === '') continue;
    const n = parseWhole(raw, { min: 0 });
    if (!n.ok) { errors.push(`${r.name} : le comptage doit être un nombre entier, 0 ou plus.`); continue; }
    const reason = String(r.reason ?? '').trim();
    if (n.value !== r.expected && reason.length < 5) { errors.push(`${r.name} : écart de ${n.value - r.expected > 0 ? '+' : ''}${n.value - r.expected} : indiquez le motif (5 caractères minimum).`); continue; }
    lines.push({ itemId: r.itemId, counted: n.value, reason: n.value === r.expected ? '' : reason });
  }
  if (!lines.length && !errors.length) errors.push('Comptez au moins un produit.');
  return { ok: !errors.length, errors, lines };
}

/** One line for a filed stock change, in plain French. */
export function requestSummary(r) {
  if (r.type === 'ADJUST') return `Ajustement ${r.delta > 0 ? '+' : ''}${r.delta} × ${r.name ?? r.sku ?? 'produit'}`;
  return `Inventaire : ${r.lines?.length ?? 0} produit(s)`;
}

/** What the supplier's measured reliability says - and nothing when there is not enough data to say anything. */
export function supplierMetricsLine(m) {
  if (!m) return 'Pas de mesure disponible.';
  const pct = (x) => `${Math.round(x.ratio * 100)} %`; const inc = m.incidents?.total ? ` · ${m.incidents.total} incident(s) enregistré(s)` : '';
  const a = m.onTimeReceipts; const d = m.defectRateUnits;
  if (a?.status !== 'MEASURED' && d?.status !== 'MEASURED') return `Pas encore assez de livraisons pour mesurer la fiabilité (minimum ${a?.minSample ?? 3} réceptions).${inc}`;
  return `${a.status === 'MEASURED' ? `${pct(a)} des réceptions à l’heure (${a.numerator}/${a.denominator})` : 'ponctualité : pas assez de réceptions'} · ${d.status === 'MEASURED' ? `${pct(d)} de pièces défectueuses (${d.numerator}/${d.denominator})` : 'défauts : pas assez de pièces'}${inc}`;
}
