// FIELD SUMMARY: a plain-text record of one product, meant to be COPIED right after leaving a supplier and pasted into Notes, WhatsApp or an e-mail. Pure and deterministic.
// It restates what the case already holds, with its provenance words ([confirmé par vous], [annoncé, à confirmer]); it never invents a value: a missing fact reads "non obtenu".
// Nothing here is a conformity statement: "aucune correspondance" in the Safety Gate is reported as exactly that.
import { describeFact, describeCandidate } from './candidate-view.js';
import { documentStatusOf } from './provenance.js';

const VERDICT_FR = Object.freeze({ GO: 'Oui, continuer', CONDITIONAL_GO: 'Continuer, sous conditions', NO_GO: 'Non, pas dans ces conditions', INSUFFICIENT_INFORMATION: "Pas assez d'informations pour conclure" });
const DOC_NAME = Object.freeze({ CE: 'CE', ROHS: 'RoHS', UN383: 'UN 38.3', REACH: 'REACH', SDS: 'FDS', IEC62133: 'IEC 62133', TEST_REPORT: "rapport d'essai" });
const DOC_STATE_FR = Object.freeze({ DOCUMENT_MATCHED: 'document reçu, correspond au modèle, pas encore accepté comme preuve', DOCUMENT_RECEIVED: 'document reçu, pas accepté comme preuve', MISMATCH: 'document reçu, NE correspond PAS au modèle' });
const KEY_ROWS = Object.freeze([
  ['MOQ', ['quote.moq']], ['Prix (paliers)', ['quote.tiers', 'quote.unitPrice']], ['Devise', ['quote.currency']], ['Incoterm', ['quote.incoterm']], ['Port', ['quote.port']], ['Délai de production', ['quote.leadTime']],
  ['Paiement : acompte', ['payment.depositPct']], ['Paiement : solde', ['payment.balancePct']], ['Modèle / référence', ['identifier.model']],
]);
const NOT_GOT = 'non obtenu';
const one = (v) => (typeof v === 'object' && v !== null ? JSON.stringify(v) : String(v));
const latest = (ledger, keys, ctx = 'product') => [...(ledger ?? [])].reverse().find((e) => keys.includes(e.key) && (e.context ?? 'product') === ctx);
const who = (p) => (p.speaker === 'unknown' ? 'locuteur inconnu' : p.speaker === 'me' ? 'dit par vous' : 'annoncé par le fournisseur');

/**
 * @param {object} c the case state  @param {object} A its assessment (assess())
 * @param {{ now?: Date, missing?: string[] }} [o] `missing`: the missing items as the screen shows them (otherwise the priority-1 questions of the assessment)
 * @returns {string}
 */
export function fieldSummaryText(c, A, { now = new Date(), missing = null } = {}) {
  const L = []; const P = (s = '') => L.push(s); const ledger = c.ledger ?? []; const id = c.identity ?? {}; const idf = id.identifiers ?? {};
  const supplier = c.supplier?.name || idf.manufacturer || (c.candidates ?? []).filter((x) => x.key === 'identifier.manufacturer').map((x) => String(x.value)).at(-1) || '';
  P(`RÉSUMÉ FOURNISSEUR - ${now.toISOString().slice(0, 10)}`);
  P(`Produit : ${id.workingName || NOT_GOT}`); P(`Modèle / référence : ${(latest(ledger, ['identifier.model'])?.value ?? idf.model) || NOT_GOT}`); P(`Fournisseur : ${supplier || NOT_GOT}`);

  P(); P('CONDITIONS COMMERCIALES');
  const shown = new Set();
  for (const [label, keys] of KEY_ROWS) {
    const e = latest(ledger, keys); keys.forEach((k) => shown.add(k));
    if (e) P(`- ${label} : ${describeFact({ key: e.key, value: e.value, context: 'product' }, 'fr').valueText} [${e.status === 'SUPPLIER_CLAIM' ? 'annoncé par le fournisseur, confirmé par vous' : 'confirmé par vous'}]`);
    else P(`- ${label} : ${(c.candidates ?? []).some((x) => x.state === 'PROPOSED' && keys.includes(x.key)) ? 'non confirmé (voir « À confirmer »)' : NOT_GOT}`);
  }
  const others = ledger.filter((e) => !shown.has(e.key)); const seen = new Set();
  const rest = [...others].reverse().filter((e) => { const k = `${e.key}|${e.context ?? 'product'}`; if (seen.has(k)) return false; seen.add(k); return true; }).reverse();
  if (rest.length) { P(); P('AUTRES FAITS CONFIRMÉS'); for (const e of rest) { const d = describeFact({ key: e.key, value: e.value, context: e.context ?? 'product' }, 'fr'); P(`- ${d.label} : ${d.valueText} [${e.status === 'SUPPLIER_CLAIM' ? 'annoncé par le fournisseur, confirmé par vous' : 'confirmé par vous'}]`); } }

  const proposed = (c.candidates ?? []).filter((x) => x.state === 'PROPOSED' && !x.key.startsWith('docClaim.'));
  const claims = new Map(); for (const d of c.documentLedger ?? []) claims.set(d.claim, d); for (const x of (c.candidates ?? [])) if (x.state === 'PROPOSED' && x.key.startsWith('docClaim.') && x.value !== 'NOT_AVAILABLE') claims.set(x.key.slice(9), claims.get(x.key.slice(9)) ?? { claim: x.key.slice(9) });
  P(); P('À CONFIRMER (annoncé, pas encore confirmé par vous)');
  if (!proposed.length && !claims.size) P('- rien');
  for (const p of proposed) { const d = describeCandidate(p, 'fr'); P(`- ${d.label} : ${d.valueText} [${who(p)}${(p.flags ?? []).includes('MACHINE_DERIVED') ? ', transcription automatique' : ''}]`); }
  if (claims.size) { const names = [...claims.keys()].map((k) => DOC_NAME[k] ?? k).join(', '); const states = [...claims.keys()].map((k) => documentStatusOf(c, k).status); const st = states.find((s) => DOC_STATE_FR[s]); P(`- Certifications annoncées : ${names} [${st ? DOC_STATE_FR[st] : 'annoncées, AUCUN document reçu'}]`); }

  const open = (c.conflicts ?? []).filter((x) => x.state === 'OPEN');
  P(); P('CONTRADICTIONS');
  if (!open.length) P('- aucune détectée'); for (const x of open) P(`- ${x.entries.map((e) => one(e.value)).join(' puis ')} : à clarifier avec le fournisseur`);

  const miss = missing ?? (A.questions ?? []).filter((q) => q.priority === 'P1').slice(0, 5).map((q) => q.fr ?? q.en).filter(Boolean);
  P(); P('INFORMATIONS IMPORTANTES MANQUANTES'); if (!miss.length) P('- rien d\'important ne manque d\'après Nordla'); for (const m of miss) P(`- ${m}`);

  P(); P('RÉGLEMENTATION / SAFETY GATE');
  const cov = A.coverage;
  if (cov?.status === 'OUT_OF_COVERAGE') P(`- ${cov.banner.toUpperCase()} : ${(cov.reasonsFr?.length ? cov.reasonsFr : cov.reasons).join(" ")} L'absence de règle applicable ne veut pas dire que rien ne s'applique.`);
  else if (cov?.status === 'PARTIAL') P(`- Couverture partielle : ${cov.notes.join(' ')}`);
  const sg = A.safety ?? {}; const sgText = { NO_MATCH_FOUND: 'aucune correspondance trouvée (cela ne prouve PAS que le produit est sûr)', NOT_CHECKED: 'NON CONSULTÉ (hors ligne) - vérification requise', EXACT_MATCH: 'CORRESPONDANCE EXACTE avec une alerte', PROBABLE_MATCH: 'correspondance probable avec une alerte', SIMILAR_PRODUCT_RISK: 'produits similaires notifiés' }[sg.status] ?? String(sg.status ?? 'inconnu');
  P(`- Safety Gate : ${sgText}${sg.stale ? ` - RÉSULTAT PÉRIMÉ (${sg.ageDays ?? 'âge inconnu'}${sg.ageDays != null ? ' jours' : ''}), à revérifier en ligne` : ''}`);
  const unrev = A.decision?.rulebookReview?.unreviewedApplicable ?? []; if (unrev.length) P(`- Règles applicables non relues par un expert : ${unrev.length}`);
  P('- Les codes douaniers (HS/CN) restent des candidats, pas une classification. Les certifications annoncées ne sont pas des preuves.');

  P(); P("ÉVALUATION D'ACHAT");
  const d = A.decision; const mp = A.maxPurchasePrice; const lb = A.landed?.isLowerBound === true;
  if (d) {
    P(`- Verdict : ${VERDICT_FR[d.verdict] ?? d.verdict}`);
    if (mp?.maxUnitPriceMinor != null) P(`- Prix maximum à payer : ${mp.display ?? ''}${mp.upperBound ? ' (BORNE HAUTE : le vrai maximum est plus bas)' : ''}`);
    if (A.negotiation?.targetUnitPrice?.display) P(`- Cible de négociation : ${A.negotiation.targetUnitPrice.display}`);
    if (A.landed && A.landed.status !== 'INFORMATION_INSUFFICIENT' && A.landed.totals?.landedPerUnitEurMinor != null) P(`- Coût de revient par unité : ${lb ? 'AU MOINS ' : ''}${(A.landed.totals.landedPerUnitEurMinor / 100).toFixed(2)} EUR${lb ? ' (BORNE BASSE)' : ''}`);
    if (lb) P(`- INCERTITUDE ÉCONOMIQUE : coûts non saisis (${A.landed.unknownCostComponents.map((u) => u.replace(/^costs\./, '')).join(', ')}). Le coût réel est plus élevé ; ne pas payer d'acompte sur cette base.`);
    for (const x of (d.conditions ?? []).slice(0, 5)) P(`- Condition : ${x}`);
    for (const b of (d.hardBlockers ?? []).slice(0, 3)) P(`- Bloquant : ${b.detail}`);
  } else P('- pas encore évalué');
  P(); P('Résumé généré par Nordla : aide à la décision, pas un avis juridique ni une preuve de conformité.');
  return L.join('\n');
}
