// Parle à Nordla - field answers (stages 5-7: APPLY the engine's rules, WORD the answer, SHOW sources and limits).
// Pure: a snapshot (field-facts.js) + an intent in, a structured answer out. No write, no network, no order, no payment, no journal entry.
// Wording is French and written here; the figures are the engine's. Where the engine did not compute something the answer says "inconnu" and why.
import { FIELD_INTENT as I } from './field-intents.js';
import { safeText } from './field-facts.js';

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const eur = (v) => (isNum(v) ? `${v.toFixed(2).replace('.', ',')} €` : 'inconnu');
const money = (v, cur) => (isNum(v) ? `${v.toFixed(2).replace('.', ',')} ${cur && cur !== 'EUR' ? cur : '€'}` : 'inconnu');
const pct = (v) => (isNum(v) ? `${(v * 100).toFixed(1).replace('.', ',')} %` : 'inconnu');

export const BLOCKER_FR = Object.freeze({
  REQUIRED_DOCUMENT_MISSING: 'documents obligatoires manquants ou inexploitables', LEGAL_REQUIREMENT_UNRESOLVED: 'exigence légale pas encore tranchée', PRODUCT_IDENTITY_UNRESOLVED: 'produit pas assez identifié',
  SAFETY_ALERT_EXACT_MATCH: 'alerte Safety Gate qui correspond au produit', AMAZON_CATEGORY_RESTRICTION: 'catégorie restreinte sur Amazon', NEGATIVE_UNIT_ECONOMICS: 'marge unitaire négative',
  CRITICAL_COST_UNKNOWN: 'coût indispensable encore inconnu', DOCUMENT_CONTRADICTS_CASE: 'documents en contradiction avec le dossier', OWN_BRAND_MANUFACTURER_DUTIES: 'vente sous votre marque : obligations de fabricant pour vous',
  ROLE_UNRESOLVED: 'votre rôle (importateur / marque propre) pas encore tranché',
});
const BASIS_FR = Object.freeze({ OBSERVED: 'observé (une annonce réelle a été vue)', TARGET: 'visé par vous, pas observé sur le marché', ASSUMED: 'une hypothèse provisoire, ni observée ni visée' });
const VERDICT_FR = Object.freeze({ GO: 'GO', CONDITIONAL_GO: 'GO sous conditions (pas une autorisation de payer)', NO_GO: 'NO-GO', INSUFFICIENT_INFORMATION: 'informations insuffisantes' });
const COST_FR = Object.freeze({ originCharges: 'frais d’origine', insurance: 'assurance', brokerage: 'frais de dédouanement', inspection: 'inspection', testing: 'tests', labelling: 'étiquetage', epr: 'REP / éco-contributions', inboundLogistics: 'logistique d’entrée', 'supplier.unitPrice': 'prix unitaire fournisseur', 'costs.freight': 'transport', 'costs.customsDuty': 'droits de douane' });
const costFr = (k) => COST_FR[k] ?? COST_FR[String(k).replace(/^costs\./, '')] ?? safeText(k, 40);
const FRESH_FR = Object.freeze({ FRESH: 'à jour', STALE: 'périmé', UNCHECKED: 'non vérifié' });
const FRESH_NAME_FR = Object.freeze({ 'regulatory rulebook': 'base de règles', 'EU Safety Gate': 'Safety Gate UE', 'FX rate': 'taux de change', 'Amazon observations': 'annonces Amazon observées' });

const CONDITION_FR = [
  [/obtain the required documents/i, 'obtenir les documents obligatoires AVANT tout acompte'],
  [/confirm the product traits/i, 'confirmer les caractéristiques du produit, seulement supposées d’après la catégorie'],
  [/import costs not entered/i, 'des coûts d’import ne sont pas saisis : le coût rendu est une borne basse, le prix d’achat maximum une borne haute'],
  [/margin is below the target/i, 'la marge est sous l’objectif : négocier le prix ou accepter une marge plus faible en connaissance de cause'],
  [/OUT OF RULEBOOK COVERAGE/i, 'hors de la couverture de la base de règles : l’absence de règle applicable n’est PAS la preuve qu’aucune règle ne s’applique'],
  [/Safety Gate result is .*(old|unknown age|NOT current)/i, 'le résultat Safety Gate n’est pas à jour : le revérifier en ligne'],
  [/Safety Gate was not consulted/i, 'le Safety Gate n’a pas été consulté : vérification hors ligne requise'],
  [/Safety Gate result is CACHED/i, 'le résultat Safety Gate vient du cache : le revérifier en ligne'],
  [/similar products were notified/i, 'des produits similaires ont fait l’objet d’alertes Safety Gate : demander au fournisseur comment son design évite ce danger'],
  [/expert or authority confirmation/i, 'une confirmation d’expert ou d’autorité est recommandée avant un acompte (régimes à risque plus élevé)'],
  [/rulebook not yet verified/i, 'la base de règles n’est pas encore vérifiée pour des régimes applicables : un expert doit les confirmer'],
  [/customs classification/i, 'choisir et confirmer la classification douanière (renseignement tarifaire contraignant ou transitaire)'],
  [/own brand/i, 'marque propre : le dossier technique et l’évaluation de conformité sont à votre charge'],
  [/regime\(s\) still unresolved/i, 'des régimes réglementaires restent à trancher'],
  [/selling price is ASSUMED/i, 'le prix de vente est une hypothèse provisoire : la marge ne vaut que ce que vaut cette hypothèse'],
  [/Amazon/i, 'condition liée à Amazon (voir le dossier)'],
];
const conditionFr = (c) => { const hit = CONDITION_FR.find(([re]) => re.test(c)); return hit ? hit[1] : `(texte du moteur, en anglais) ${safeText(c, 200)}`; };
const verdictLabel = (snap) => (snap.verdict === 'CONDITIONAL_GO' && snap.hardBlockers.length ? 'GO sous conditions, mais avec un blocage dur : aucune commande possible' : (VERDICT_FR[snap.verdict] ?? snap.verdict));
const bullets = (arr) => arr.map((x) => `• ${x}`);
const head = (title, arr) => (arr.length ? [`${title} :`, ...bullets(arr)] : []);

const relevantFresh = (f) => !(f.name === 'Amazon observations' && f.status === 'UNCHECKED'); // no Amazon listing was ever looked for: nothing to be stale
function sourcesOf(snap, extra = []) {
  const s = snap.source; const rule = snap.freshness.find((f) => f.name === 'regulatory rulebook');
  return [{ kind: 'sourcing_case', ref: s.ref, version: s.version }, ...(rule?.version ? [{ kind: 'rulebook', ref: 'regulatory rulebook', version: rule.version }] : []), ...extra];
}
function sourceLine(snap) {
  const s = snap.source; const parts = [`dossier ${s.ref}, version ${s.version ?? 'inconnue'}, calculé le ${String(s.asOf).slice(0, 10)}`];
  parts.push(...snap.freshness.filter(relevantFresh).map((f) => `${FRESH_NAME_FR[f.name] ?? f.name} : ${FRESH_FR[f.status] ?? f.status}${f.checkedAt ? ` (${String(f.checkedAt).slice(0, 10)})` : ''}`));
  return `Sources : ${parts.join(' ; ')}.`;
}
function limitsOf(snap) {
  const out = ['Les chiffres viennent du moteur du dossier ; Nordla n’invente ni prix, ni marge, ni conformité.'];
  for (const f of snap.freshness.filter(relevantFresh)) if (f.status !== 'FRESH') out.push(`${FRESH_NAME_FR[f.name] ?? f.name} : ${FRESH_FR[f.status] ?? f.status}${f.checkedAt ? ` (au ${String(f.checkedAt).slice(0, 10)})` : ''}`);
  if (snap.economics.priceBasis && snap.economics.priceBasis !== 'OBSERVED') out.push(`Prix de vente ${BASIS_FR[snap.economics.priceBasis] ?? snap.economics.priceBasis} : toute marge en dépend.`);
  return out;
}

function nextVerification(snap) {
  const codes = new Set(snap.hardBlockers.map((b) => b.code)); const steps = [];
  if (codes.has('SAFETY_ALERT_EXACT_MATCH')) steps.push('Ne pas acheter : une alerte Safety Gate correspond au produit. Demander au fournisseur la preuve de mesure corrective seulement si vous voulez poursuivre.');
  if (codes.has('DOCUMENT_CONTRADICTS_CASE')) steps.push('Ne pas s’appuyer sur les documents reçus : demander les bons documents pour le modèle exact.');
  if (codes.has('REQUIRED_DOCUMENT_MISSING')) steps.push(`Demander au fournisseur : ${snap.missingDocs.slice(0, 3).map((d) => `« ${d.label} »`).join(' ; ') || 'les documents obligatoires'}${snap.missingDocs.length > 3 ? ` (+ ${snap.missingDocs.length - 3} autre(s))` : ''}.`);
  if (codes.has('PRODUCT_IDENTITY_UNRESOLVED') || codes.has('LEGAL_REQUIREMENT_UNRESOLVED')) {
    const q = snap.supplierQuestions.slice(0, 3).map((x) => `« ${x.en.replace(/\?.*$/, '?')} »`);
    steps.push(`Préciser le produit avec le fournisseur${q.length ? ` : ${q.join(' ; ')}` : ''}.`);
  }
  if (codes.has('CRITICAL_COST_UNKNOWN')) steps.push(`Saisir les coûts indispensables encore inconnus : ${snap.economics.landedCriticalUnknown.map(costFr).join(', ') || 'voir le dossier'}.`);
  if (codes.has('NEGATIVE_UNIT_ECONOMICS')) steps.push(isNum(snap.economics.maxUnitPrice) ? `Renégocier : à ce prix la marge est négative ; le moteur calcule un prix unitaire maximum de ${money(snap.economics.maxUnitPrice, snap.economics.maxUnitPriceCurrency)}.` : 'Renégocier ou renoncer : la marge unitaire est négative.');
  if (!steps.length && snap.conditions.length) steps.push(`Lever les conditions du moteur avant tout acompte : ${snap.conditions.slice(0, 2).map(conditionFr).join(' ; ')}.`);
  if (!steps.length) steps.push('Demander un échantillon et la facture proforma, puis une inspection avant paiement final ; la décision d’acheter reste la vôtre.');
  if (snap.freshness.some((f) => f.name === 'EU Safety Gate' && f.status !== 'FRESH')) steps.push('Revérifier le Safety Gate en ligne (résultat absent, ancien ou en cache).');
  return steps;
}

const ownerLine = (owner) => (owner === 'CONFIGURED' ? 'Des règles propriétaire existent dans la configuration ; cette réponse ne les évalue pas elle-même (c’est le rôle du Core : demandez « dois-je acheter ce produit ? »).'
  : owner === 'NOT_CONFIGURED' ? 'Aucune règle propriétaire (budget, marge minimale, trésorerie) n’est définie : aucune ne peut être appliquée ni supposée.' : 'Les règles propriétaire ne sont pas lisibles ici : aucune n’est supposée.');

function wrap(intent, snap, { title, knownTitle = 'Ce que nous savons', known = [], unknown = [], risks = [], consequences = [], next = [], extraSources = [], extraLimits = [] }) {
  const lines = [title, ...head(knownTitle, known), ...head('Ce que nous ne savons pas', unknown), ...head('Risques', risks), ...head('Pourquoi c’est important', consequences), ...head('Prochaine vérification', next), sourceLine(snap)];
  return {
    status: 'ANSWERED', intent, answer: lines.join('\n'),
    sections: { known, unknown, risks, consequences, next }, sources: sourcesOf(snap, extraSources), limits: [...limitsOf(snap), ...extraLimits],
  };
}

// ---- shared building blocks
const quoteLine = (snap) => (snap.quote ? `devis fournisseur : ${money(snap.quote.unitPrice, snap.quote.currency)} l’unité, ${snap.quote.qty ?? '?'} unités, minimum ${snap.quote.moq ?? 'inconnu'}${snap.quote.incoterm ? `, ${snap.quote.incoterm}` : ''}` : null);
function economicsUnknowns(snap) {
  const e = snap.economics; const out = [];
  if (e.landedStatus === 'INFORMATION_INSUFFICIENT') out.push(`coût rendu incalculable : il manque ${e.landedCriticalUnknown.map(costFr).join(', ') || 'des coûts indispensables'}`);
  else if (e.landedLowerBound) out.push(`coût rendu incomplet (borne basse) : ${e.landedUnknownComponents.map(costFr).join(', ')} non saisis ; le vrai coût est plus élevé`);
  if (!isNum(e.contributionPerUnit)) out.push(`marge incalculable${e.economicsReason ? ` (${e.economicsReason})` : ''}`);
  else if (e.contributionUpperBound) out.push('marge = borne haute : des frais sont encore inconnus');
  if (e.priceBasis !== 'OBSERVED') out.push(`prix de vente non observé : ${BASIS_FR[e.priceBasis] ?? 'origine inconnue'}`);
  return out;
}
function blockerLines(snap) { return snap.hardBlockers.map((b) => `${BLOCKER_FR[b.code] ?? b.code} — « ${b.detail} »`); }

// ---- builders (one per intent)
function knowledge(snap) {
  const e = snap.economics; const known = [`produit « ${snap.source.productName} », verdict du moteur : ${verdictLabel(snap)}${snap.canCommitMoney ? '' : ' ; le dossier n’autorise pas d’engager de l’argent'}`];
  if (quoteLine(snap)) known.push(quoteLine(snap));
  if (isNum(e.landedTotal)) known.push(`coût rendu : ${eur(e.landedPerUnit)} l’unité, ${eur(e.landedTotal)} au total${e.landedLowerBound ? ' (au moins)' : ''}`);
  else if (e.landedLowerBoundFigure && isNum(e.landedLowerBoundFigure.total)) known.push(`coût rendu partiel : au moins ${eur(e.landedLowerBoundFigure.perUnit)} l’unité, ${eur(e.landedLowerBoundFigure.total)} au total (borne basse)`);
  if (isNum(e.contributionPerUnit)) known.push(`marge unitaire : ${eur(e.contributionPerUnit)}${e.contributionUpperBound ? ' (borne haute)' : ''}, prix de vente ${BASIS_FR[e.priceBasis] ?? 'inconnu'}`);
  const sg = snap.freshness.find((f) => f.name === 'EU Safety Gate'); if (sg) known.push(`Safety Gate : ${FRESH_FR[sg.status] ?? sg.status}${sg.mode ? ` (${sg.mode})` : ''}`);
  const unknown = economicsUnknowns(snap);
  if (snap.missingDocs.length) unknown.push(`${snap.missingDocs.length} document(s) obligatoire(s) manquant(s) ou inexploitable(s)`);
  for (const u of snap.unknowns.slice(0, 5)) unknown.push(`${u.item} : ${u.note}`);
  return wrap(I.KNOWLEDGE, snap, { title: 'Voici l’état du dossier.', known, unknown, risks: blockerLines(snap), consequences: snap.hardBlockers.length ? ['tant qu’un blocage dur existe, aucune commande n’est recommandable'] : [], next: nextVerification(snap).slice(0, 2) });
}

function missing(snap, { docsOnly = false } = {}) {
  const unknown = [];
  if (snap.missingDocs.length) unknown.push(...snap.missingDocs.map((d) => `document : ${d.label}`));
  if (!docsOnly) {
    unknown.push(...economicsUnknowns(snap));
    unknown.push(...snap.supplierQuestions.slice(0, 5).map((q) => `à demander au fournisseur : ${q.en}`));
    for (const c of snap.conditionBlockers) unknown.push(`${BLOCKER_FR[c.code] ?? c.code}`);
  } else {
    unknown.push(...snap.contradictions.map((c) => `contradiction : ${c}`));
    const given = snap.assessment.documents ?? [];
    if (given.length) unknown.push(...given.map((d) => `reçu : ${safeText(d.docType, 30)} (${safeText(d.fileName, 60)}) — état ${d.evidenceState}, cohérence ${d.consistency}`));
    else unknown.push('aucun document fournisseur n’a été enregistré dans ce dossier');
  }
  const complete = !unknown.length && snap.verdict === 'GO';
  return wrap(docsOnly ? I.DOCUMENTS : I.MISSING, snap, {
    title: docsOnly ? (snap.missingDocs.length || snap.contradictions.length ? 'Documents à obtenir ou à vérifier :' : 'Le moteur ne signale aucun document obligatoire manquant ; un document reçu reste une déclaration du fournisseur, pas une preuve de conformité.')
      : (complete ? 'Le moteur ne signale rien de manquant, ce qui ne garantit pas que le dossier est complet.' : 'Le dossier n’est pas complet.'),
    known: [], unknown, risks: [], consequences: snap.missingDocs.length ? ['sans ces documents, la conformité ne peut pas être établie et le moteur interdit tout acompte'] : [], next: nextVerification(snap).slice(0, 3),
  });
}

function risks(snap) {
  const proven = blockerLines(snap);
  const alerts = [...snap.conditions.slice(0, 6).map(conditionFr), ...snap.conditionBlockers.map((b) => `${BLOCKER_FR[b.code] ?? b.code} — « ${b.detail} »`)];
  const notAssessed = [];
  const dim = snap.dimensions;
  if (['OUT_OF_COVERAGE', 'PARTIAL', 'NOT_ASSESSED'].includes(dim.regulatoryCoverage)) notAssessed.push(`couverture réglementaire ${dim.regulatoryCoverage} : l’absence de règle trouvée ne prouve pas l’absence d’obligation`);
  if (dim.supplierEvidence === 'INSUFFICIENT') notAssessed.push('preuves fournisseur insuffisantes');
  for (const f of snap.freshness.filter(relevantFresh)) if (f.status !== 'FRESH') notAssessed.push(`${FRESH_NAME_FR[f.name] ?? f.name} : ${FRESH_FR[f.status] ?? f.status}`);
  if (snap.assessment.decision.rulebookReview?.allApplicableReviewed === false) notAssessed.push('règles applicables pas encore relues par un expert');
  const lines = [];
  if (proven.length) lines.push(...proven.map((p) => `Bloquant établi par le moteur : ${p}`));
  if (alerts.length) lines.push(...alerts.map((a) => `Alerte : ${a}`));
  if (notAssessed.length) lines.push(...notAssessed.map((n) => `Pas évalué / à revérifier : ${n}`));
  const title = proven.length ? `Le moteur établit ${proven.length} blocage(s) dur(s) : l’achat ne peut pas être engagé.` : lines.length ? 'Aucun blocage dur n’est établi, mais des alertes et des vérifications restent ouvertes.' : 'Le moteur n’établit aucun blocage ni alerte ; cela ne remplace pas une vérification par un expert.';
  return wrap(I.RISKS, snap, { title, known: [], unknown: [], risks: lines, consequences: proven.length ? ['un blocage dur retire l’option « commander » avant toute comparaison'] : [], next: nextVerification(snap).slice(0, 3) });
}

function canOrder(snap, owner) {
  const blockers = blockerLines(snap);
  let title; const consequences = [];
  if (snap.canCommitMoney && snap.verdict === 'GO') {
    title = 'Le moteur du dossier ne voit pas de blocage, mais il ne vous autorise pas à payer : Nordla ne commande ni ne paie rien, la décision est la vôtre.';
    if (snap.economics.priceBasis !== 'OBSERVED') consequences.push(`la marge repose sur un prix de vente ${BASIS_FR[snap.economics.priceBasis] ?? 'd’origine inconnue'}`);
  } else {
    title = `Pas à ce stade : le verdict du moteur est « ${verdictLabel(snap)} » et il ne permet pas d’engager de l’argent.`;
    consequences.push(snap.hardBlockers.length ? 'un blocage dur élimine l’option « commander » avant toute comparaison' : 'des conditions restent à lever avant un acompte');
  }
  return wrap(I.CAN_ORDER, snap, { title, known: [`verdict du moteur : ${verdictLabel(snap)}`, `argent engageable selon le moteur : ${snap.canCommitMoney ? 'oui' : 'non'}`], unknown: economicsUnknowns(snap), risks: [...blockers, ...snap.conditions.slice(0, 3).map((c) => `Condition : ${conditionFr(c)}`)], consequences: [...consequences, ownerLine(owner)], next: nextVerification(snap).slice(0, 3) });
}

function nextStep(snap) {
  const steps = nextVerification(snap);
  return wrap(I.NEXT_STEP, snap, { title: 'La prochaine vérification utile :', known: snap.engineNextAction ? [`le moteur indique (texte original, en anglais) : « ${snap.engineNextAction} »`] : [], unknown: [], risks: [], consequences: [], next: steps });
}

function economics(snap, intent) {
  const e = snap.economics; const known = []; const unknown = []; const consequences = []; let title; const extra = [];
  const q = snap.orderQuoted; const m = snap.orderMoq;
  const ifSold = (o) => (o && isNum(o.marginIfAllSold) ? `${eur(o.marginIfAllSold)} si les ${o.qty} unités se vendaient toutes au prix saisi (hypothèse, pas une prévision)` : null);
  switch (intent) {
    case I.MARGIN:
      if (isNum(e.contributionPerUnit)) {
        title = `Marge unitaire estimée : ${eur(e.contributionPerUnit)}${isNum(e.contributionPct) ? ` (${pct(e.contributionPct)} du chiffre d’affaires net)` : ''}${e.contributionUpperBound ? ', borne haute' : ''}.`;
        known.push(`prix de vente ${BASIS_FR[e.priceBasis] ?? 'd’origine inconnue'}${isNum(e.sellingPriceGross) ? ` : ${eur(e.sellingPriceGross)} TTC` : ''}`); if (ifSold(q)) known.push(ifSold(q));
        consequences.push(e.priceBasis === 'OBSERVED' ? 'le prix vient d’une annonce vue, pas d’une vente réalisée' : 'la marge ne vaut que ce que vaut le prix de vente supposé');
      } else { title = 'La marge ne peut pas être calculée avec le dossier actuel.'; consequences.push('sans coût rendu complet et prix de vente, toute marge annoncée serait inventée'); }
      unknown.push(...economicsUnknowns(snap)); break;
    case I.LANDED_COST:
      if (isNum(e.landedPerUnit)) { title = `Coût rendu : ${eur(e.landedPerUnit)} l’unité${e.landedLowerBound ? ' au moins' : ''}.`; known.push(`${eur(e.landedTotal)} au total pour ${snap.quote?.qty ?? '?'} unités`); if (e.landedLowerBound) consequences.push('coût incomplet : le coût réel est plus élevé'); }
      else if (e.landedLowerBoundFigure && isNum(e.landedLowerBoundFigure.perUnit)) { title = `Coût rendu partiel : au moins ${eur(e.landedLowerBoundFigure.perUnit)} l’unité (borne basse).`; known.push(`au moins ${eur(e.landedLowerBoundFigure.total)} au total pour ${snap.quote?.qty ?? '?'} unités`); consequences.push('des coûts d’import ne sont pas saisis : le coût réel est plus élevé, la marge calculée est une borne haute'); }
      else { title = 'Le coût rendu ne peut pas être calculé.'; consequences.push('un coût indispensable manque : le moteur refuse de chiffrer'); }
      unknown.push(...economicsUnknowns(snap).filter((x) => x.startsWith('coût'))); break;
    case I.ORDER_TOTAL:
      if (isNum(e.landedTotal)) {
        title = `Coût rendu de la commande : ${eur(e.landedTotal)} pour ${snap.quote?.qty ?? '?'} unités${e.landedLowerBound ? ' (au moins)' : ''}.`;
        const t = snap.assessment.landed?.totals; if (t) known.push(`dont achat fournisseur ${eur((t.purchaseTotalEurMinor ?? NaN) / 100)} et import/frais ${eur((t.importCostEurMinor ?? NaN) / 100)}${isNum(t.estimatedMinor) && t.estimatedMinor > 0 ? ` (dont ${eur(t.estimatedMinor / 100)} estimés)` : ''}`);
      } else if (e.landedLowerBoundFigure && isNum(e.landedLowerBoundFigure.total)) { title = `Coût rendu de la commande : au moins ${eur(e.landedLowerBoundFigure.total)} pour ${snap.quote?.qty ?? '?'} unités (borne basse).`; consequences.push('des coûts d’import ne sont pas saisis : le total réel est plus élevé'); }
      else title = 'Le coût de la commande ne peut pas être calculé.';
      if (snap.quote?.qty === null) unknown.push('quantité du devis inconnue');
      unknown.push(...economicsUnknowns(snap).filter((x) => x.startsWith('coût'))); break;
    case I.PRICE_GAP: {
      const gaps = [];
      if (e.landedCriticalUnknown.length) gaps.push(...e.landedCriticalUnknown.map(costFr));
      if (e.economicsReason) gaps.push(e.economicsReason);
      if (!isNum(e.sellingPriceGross)) gaps.push('prix de vente (et taux de TVA) non saisis');
      title = gaps.length ? 'Il manque, pour calculer la rentabilité :' : 'Rien ne manque pour le calcul lui-même ; reste à vérifier la solidité du prix de vente.';
      unknown.push(...gaps); if (!gaps.length && e.priceBasis !== 'OBSERVED') unknown.push(`prix de vente ${BASIS_FR[e.priceBasis] ?? 'd’origine inconnue'}`);
      if (isNum(e.maxUnitPrice)) known.push(`prix unitaire maximum calculé par le moteur : ${money(e.maxUnitPrice, e.maxUnitPriceCurrency)}${e.maxUnitPriceUpperBound ? ' (borne haute)' : ''}`); break; }
    case I.PRICE_BASIS:
      title = `Le prix de vente est ${BASIS_FR[e.priceBasis] ?? 'd’origine inconnue'}.`;
      if (isNum(e.sellingPriceGross)) known.push(`prix retenu : ${eur(e.sellingPriceGross)} TTC`);
      else unknown.push('aucun prix de vente saisi');
      consequences.push(e.priceBasis === 'OBSERVED' ? 'une annonce vue n’est pas une autorisation de vendre à ce prix' : 'la marge n’est qu’une conséquence de ce prix choisi, pas un fait de marché'); break;
    case I.UNCOUNTED_COSTS:
      title = e.landedUnknownComponents.length ? 'Coûts pas encore pris en compte (non saisis) :' : e.landedCriticalUnknown.length ? 'Le coût rendu est incalculable : coûts indispensables manquants :' : 'Le moteur ne signale aucun coût de revient non saisi.';
      unknown.push(...e.landedUnknownComponents.map(costFr), ...e.landedCriticalUnknown.map(costFr));
      consequences.push('ne saisir 0 que si le coût est réellement nul ; une liste vide ne prouve pas qu’aucun autre coût n’existe hors du modèle du moteur'); break;
    case I.MOQ_SCENARIO:
      if (snap.moqScenario && m) {
        title = `À la quantité minimale (${m.qty} unités) : coût rendu ${eur(m.landedTotal)}, marge unitaire ${eur(snap.moqScenario.contribution_per_unit)}.`;
        if (ifSold(m)) known.push(ifSold(m)); if (q && isNum(q.landedTotal)) known.push(`pour comparaison, au devis (${q.qty} unités) : coût rendu ${eur(q.landedTotal)}`);
        consequences.push('le prix unitaire du devis est supposé inchangé à cette quantité ; seul le fournisseur peut confirmer un autre prix');
      } else { title = 'Scénario à la quantité minimale indisponible.'; unknown.push(snap.quote?.moq == null ? 'quantité minimale du fournisseur inconnue' : snap.quote.qty != null && snap.quote.moq >= snap.quote.qty ? 'la quantité minimale est déjà celle du devis' : 'le coût rendu ou la marge ne sont pas calculables à cette quantité'); }
      unknown.push(...economicsUnknowns(snap).filter((x) => x.startsWith('prix')));
      break;
    default: title = '';
  }
  return wrap(intent, snap, { title, known, unknown, risks: snap.hardBlockers.length ? [`blocage(s) dur(s) : ${snap.hardBlockers.map((b) => BLOCKER_FR[b.code] ?? b.code).join(', ')} — les chiffres ci-dessus ne rendent pas la commande possible`] : [], consequences, next: nextVerification(snap).slice(0, 2), extraSources: extra });
}

// ---- on-site helpers: the questions to put to the supplier, and "is this price good?"
function supplierQuestions(snap) {
  const qs = snap.supplierQuestions; const lines = qs.slice(0, 8).map((q) => `${q.en}${q.zh ? ` / ${q.zh}` : ''}`);
  const docs = snap.missingDocs.slice(0, 4).map((d) => `Please send: ${d.label}`);
  return wrap(I.SUPPLIER_QUESTIONS, snap, {
    title: qs.length || docs.length ? `Questions à poser au fournisseur (liste du moteur, ${qs.length} prioritaire(s)) :` : 'Le moteur n’a aucune question prioritaire à poser au fournisseur pour l’instant ; cela ne dispense pas de demander un échantillon et une facture proforma.',
    knownTitle: 'À demander (anglais / chinois)', known: lines, unknown: [], risks: [], consequences: qs.length ? ['chaque question a été posée parce qu’une règle ou un coût ne peut pas être tranché sans la réponse'] : [], next: docs.length ? [`Demander aussi les documents manquants (en anglais) : ${docs.join(' ; ')}`] : [],
  });
}
function priceJudgement(snap) {
  const e = snap.economics; const q = snap.quote; const known = []; const unknown = [];
  let title;
  if (q && isNum(q.unitPrice) && isNum(e.maxUnitPrice)) {
    const under = q.unitPrice <= e.maxUnitPrice;
    title = `Le prix du devis (${money(q.unitPrice, q.currency)}) est ${under ? 'sous le' : 'AU-DESSUS du'} prix unitaire maximum calculé par le moteur (${money(e.maxUnitPrice, e.maxUnitPriceCurrency)})${e.maxUnitPriceUpperBound ? ' — borne haute, le vrai maximum est plus bas' : ''}.`;
    known.push(`maximum calculé avec un prix de vente ${BASIS_FR[e.priceBasis] ?? 'd’origine inconnue'}`);
    if (e.maxUnitPriceCurrency && q.currency && e.maxUnitPriceCurrency !== q.currency) unknown.push(`devis en ${q.currency}, maximum en ${e.maxUnitPriceCurrency} : comparer avec prudence`);
  } else {
    title = 'Je ne peux pas dire si ce prix est bon : il manque le prix du devis ou le prix maximum n’est pas calculable.';
    if (!q || !isNum(q?.unitPrice)) unknown.push('prix unitaire du devis');
    if (!isNum(e.maxUnitPrice)) unknown.push(e.maxUnitPriceReason ? `prix maximum incalculable (${e.maxUnitPriceReason})` : 'prix maximum incalculable');
  }
  unknown.push('aucun prix de marché ou de concurrent n’est lu ici : « bon » signifie seulement « sous le maximum de rentabilité du dossier »');
  return wrap(I.PRICE_JUDGEMENT, snap, { title, known, unknown, risks: snap.hardBlockers.length ? ['un blocage dur reste ouvert : un bon prix ne rend pas la commande possible'] : [], consequences: e.priceBasis !== 'OBSERVED' ? ['le prix maximum dépend du prix de vente supposé'] : [], next: nextVerification(snap).slice(0, 2) });
}

// ---- Phase D: explain the Core recommendation already journaled for this case. Read-only: it never runs a new analysis.
const REASON_FR = [
  [/can_commit_money eq true \(actual false\)/, 'le dossier n’autorise pas d’engager de l’argent (verdict sourcing)'],
  [/hard_blockers eq 0 \(actual (\d+)\)/, (m) => `${m[1]} blocage(s) dur(s) dans le dossier`],
];
const reasonFr = (r) => { for (const [re, to] of REASON_FR) { const m = String(r).match(re); if (m) return typeof to === 'function' ? to(m) : to; } return safeText(r, 160); };
const ruleLabel = (r) => safeText(r?.label ?? r?.id ?? r?.rule_id ?? JSON.stringify(r), 120);

/** @param entryView the journal view of the newest analysis of this case (runtime.forCase), or null */
function explainRecommendation(snap, { entryView, ownerRules }) {
  if (!entryView) {
    return wrap(I.EXPLAIN_RECOMMENDATION, snap, { title: 'Aucune recommandation du Core n’est enregistrée pour ce dossier ; voici ce que le moteur du dossier établit déjà.', known: [`verdict du moteur : ${verdictLabel(snap)}`], unknown: ['pas encore d’analyse Core journalisée pour ce dossier'], risks: [...blockerLines(snap), ...snap.conditions.slice(0, 3).map((c) => `Condition : ${conditionFr(c)}`)], consequences: [], next: ['Demandez « dois-je acheter ce produit ? » : cela lance l’analyse du Core (journalisée, sans aucune commande) ; je ne la lance pas moi-même pour répondre à une question d’explication.'] });
  }
  const e = entryView.entry; const rec = e.recommendation;
  const used = e.facts_used ?? []; const analysedAt = used[0]?.source_ref ?? '';
  const stale = analysedAt && snap.source.version && !analysedAt.endsWith(`@${snap.source.version}`);
  const known = [];
  known.push(rec ? `recommandation du Core : « ${rec.label} » (${rec.kind})` : 'le Core ne recommande rien : des données bloquantes manquent');
  for (const r of rec?.rationale ?? []) known.push(`raison : ${safeText(r, 200)}`);
  const key = used.filter((f) => ['verdict', 'can_commit_money', 'hard_blockers', 'landed_total', 'contribution_per_unit', 'price_basis'].includes(f.key));
  known.push(...key.map((f) => `fait déterminant : ${f.key} = ${f.value === null ? 'inconnu' : f.value}${f.unit ? ` ${f.unit}` : ''}`));
  const eliminated = (e.options?.eliminated ?? []).filter((x) => x.stage !== 'RELEVANCE').map((x) => `écartée : ${safeText(x.label, 100)} — ${(x.reasons ?? []).map(reasonFr).join(' ; ')}`);
  const applied = e.rules_applied ?? [];
  const owner = applied.length ? `règles propriétaire appliquées : ${applied.map(ruleLabel).join(' ; ')}` : `règles propriétaire appliquées : aucune. ${ownerLine(ownerRules)}`;
  const unknown = [...(e.missing_data ?? []).map((m) => `${safeText(m.field, 60)} — ${safeText(m.reason, 120)}`)];
  const change = [];
  if (snap.hardBlockers.length) change.push(`lever les blocages (${snap.hardBlockers.map((b) => BLOCKER_FR[b.code] ?? b.code).join(', ')}) rendrait de nouveau les options de commande examinables — sans qu’aucune ne soit recommandée d’office`);
  if (snap.economics.priceBasis !== 'OBSERVED') change.push('observer un vrai prix de vente peut changer l’attrait économique');
  const risksOut = stale ? ['⚠ le dossier a changé depuis cette analyse : relancez « dois-je acheter ce produit ? » pour obtenir une recommandation à jour'] : [];
  return wrap(I.EXPLAIN_RECOMMENDATION, snap, {
    title: stale ? 'Cette explication porte sur une analyse plus ancienne que le dossier actuel.' : 'Voici pourquoi le Core a formulé cette recommandation.',
    known: [...known, ...eliminated, owner, ...(e.human_decision ? [`décision humaine enregistrée : ${e.human_decision.decision}`] : ['aucune décision humaine enregistrée : rien n’est approuvé'])],
    unknown, risks: risksOut, consequences: change.map((c) => `ce qui pourrait changer : ${c}`), next: nextVerification(snap).slice(0, 2),
    extraSources: [{ kind: 'core_journal', ref: e.id, case: snap.source.ref, at: e.created_at }],
  });
}

/**
 * @param {string} intent a FIELD_INTENT
 * @param {object} snap a snapshot from buildFieldSnapshot
 * @param {{ entryView?: object|null, ownerRules?: 'CONFIGURED'|'NOT_CONFIGURED'|null }} extra read-only extras (journal view of the case, owner-rule state)
 */
export function buildFieldAnswer(intent, snap, { entryView = null, ownerRules = null } = {}) {
  switch (intent) {
    case I.KNOWLEDGE: return knowledge(snap);
    case I.MISSING: return missing(snap);
    case I.DOCUMENTS: return missing(snap, { docsOnly: true });
    case I.RISKS: return risks(snap);
    case I.CAN_ORDER: return canOrder(snap, ownerRules);
    case I.NEXT_STEP: return nextStep(snap);
    case I.SUPPLIER_QUESTIONS: return supplierQuestions(snap);
    case I.PRICE_JUDGEMENT: return priceJudgement(snap);
    case I.EXPLAIN_RECOMMENDATION: return explainRecommendation(snap, { entryView, ownerRules });
    default: return economics(snap, intent);
  }
}
