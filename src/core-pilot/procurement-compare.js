// Parle à Nordla -> Stock / Achats, the questions procurement-answers.js does not cover: COMPARE offers ("meilleur fournisseur / coût rendu / moins cher"), expiring supplier documents,
// and the honest limits (no supplier search tool yet). READ ONLY: it only calls the assistant's read tools (best_landed_cost_supplier, expiring_supplier_documents); it selects, orders and writes nothing.
// It never invents an input: no exchange rate, no freight, no duty, no quantity - what is missing is asked for or said. A comparison on the goods price alone is labelled as such.
const norm = (s) => String(s ?? '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim();
const NL = String.fromCharCode(10);
const SRC = (tool, extra = {}) => ({ kind: 'procurement', ref: tool, as_of: new Date().toISOString(), ...extra });
const COMPARE = /(meilleur|meilleure|moins cher|compar|classement|plus avantageux).*(fournisseur|offre|devis|cout rendu|prix)|(fournisseur|offre|devis).*(meilleur|moins cher|compar)/;
const DOCS = /(certificat|document|contrat|attestation).*(expir|perim|echeance|a renouveler|bientot)/;
const PROVENANCE = { SUPPLIER_CLAIM: 'annoncé par le fournisseur (non vérifié)' };
const eur = (v) => (Number.isFinite(Number(v)) ? `${Number(v).toFixed(2).replace('.', ',')} €` : 'inconnu');

/** @returns {Promise<object|null>} an answer in the shape of ask.js, or null when the sentence is not about comparing offers / expiring documents (or has no item to compare). */
export async function procurementCompareAnswer(text, assistant) {
  const t = norm(text);
  if (DOCS.test(t)) {
    const r = await assistant.call('expiring_supplier_documents', {});
    const docs = r.documents ?? [];
    return { status: 'ANSWERED', answer: docs.length ? `${docs.length} document(s) fournisseur expiré(s) ou bientôt expirés :${NL}${docs.map((d) => `• ${d.title ?? d.type ?? d.id} — ${d.supplier ?? d.supplierName ?? 'fournisseur ?'}, échéance ${d.expiresOn ?? d.validUntil ?? 'inconnue'}`).join(NL)}` : 'Aucun document fournisseur n’est expiré ou proche de l’échéance dans Stock / Achats.', sources: [SRC('expiring_supplier_documents')], limits: ['Seuls les documents enregistrés dans Stock / Achats sont vus ; un document absent n’y apparaît pas.'] };
  }
  if (!COMPARE.test(t)) return null;
  const sku = (/\b[A-Za-z0-9]{2,}(?:-[A-Za-z0-9]+)*-\d{2,}\b/.exec(text) ?? [])[0];
  if (!sku) return null; // no item named: the case assistant (or the router) answers; it points to the exact next step
  const qtyMatch = /(\d{1,7})\s*(pieces?|pcs|unites?|exemplaires?)\b|\bpour\s+(\d{1,7})\b|\bx\s?(\d{1,7})\b/.exec(t);
  const qty = qtyMatch ? Number(qtyMatch[1] ?? qtyMatch[3] ?? qtyMatch[4]) : null;
  if (!Number.isInteger(qty) || qty <= 0) return { status: 'ASK', answer: `Pour comparer les offres de ${sku.toUpperCase()}, pour quelle quantité ? (le prix dépend de la quantité : je ne la devine pas)`, sources: [SRC('best_landed_cost_supplier')], limits: [] };
  const r = await assistant.call('best_landed_cost_supplier', { sku: sku.toUpperCase(), qty }); // no fx, no cost inputs: never invented here
  if (r.status !== 'OK') return { status: 'ASK', answer: String(r.question ?? 'Quel article (référence exacte) ?'), sources: [SRC('best_landed_cost_supplier')], limits: [] };
  const c = r.comparison; const offers = c.offers ?? [];
  if (!offers.length) return { status: 'ANSWERED', answer: `Aucune offre en cours de validité pour ${sku.toUpperCase()} dans Stock / Achats : rien à comparer.`, sources: [SRC('best_landed_cost_supplier', { sku: sku.toUpperCase(), qty })], limits: [] };
  const rank = new Map((c.ranking ?? []).map((x) => [x.quoteId, x.rank]));
  const line = (o) => {
    const head = `${rank.has(o.quoteId) ? `${rank.get(o.quoteId)}. ` : '• '}${o.supplier} — ${o.unitPrice} ${o.currency}${o.incoterm ? ` ${o.incoterm}` : ''}, délai ${o.leadTimeDays ?? '?'} j, ${PROVENANCE[o.provenance] ?? o.provenance}`;
    if (o.status === 'LANDED') return `${head} → coût rendu ${eur(o.landedPerUnit)} l’unité`;
    if (o.status === 'GOODS_ONLY') return `${head} → marchandise ≈ ${eur(o.goodsUnitEur)} l’unité ; coût rendu non calculé (${o.reason})`;
    if (o.status === 'NOT_COMPARABLE') return `${head} → non comparable : ${o.reason === 'FX_REQUIRED' ? 'taux de change non renseigné (je n’en invente pas)' : o.reason}`;
    return `${head} → écartée : ${o.reason ?? o.status}`;
  };
  const basis = c.basis === 'LANDED_COST' ? 'sur le coût rendu' : 'sur le prix de la marchandise SEULEMENT (pas le coût rendu : transport et droits non saisis)';
  return { status: 'ANSWERED', answer: [`Offres pour ${sku.toUpperCase()} × ${qty}, classées ${basis} :`, ...offers.map(line), 'Cette comparaison ne désigne ni ne commande personne : le choix et la commande restent humains, dans l’écran Achats.'].join(NL), sources: [SRC('best_landed_cost_supplier', { sku: sku.toUpperCase(), qty })], limits: [c.basis === 'LANDED_COST' ? 'Coût rendu calculé par le moteur Finance à partir des données saisies.' : 'Sans transport, droits et taux de change saisis, ce classement n’est pas un classement de coût rendu.'] };
}
