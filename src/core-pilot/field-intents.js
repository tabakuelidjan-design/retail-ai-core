// Parle à Nordla - field intents (stage 1 of the field assistant: RECOGNISE). Pure, deterministic, no I/O, no model.
// Input: a sentence. Output: which question it is, or why it cannot be decided. It never reads a case and never answers.
// A future language model may only help here (rephrase a sentence into one of these intents); it never builds an answer or a figure.
export const FIELD_INTENT = Object.freeze({
  KNOWLEDGE: 'KNOWLEDGE', // what do we know / not know about this case
  MISSING: 'MISSING', // what is missing, is the case complete
  DOCUMENTS: 'DOCUMENTS', // which documents to check / are missing
  RISKS: 'RISKS', // risks, what may block the purchase, why Nordla hesitates
  MARGIN: 'MARGIN', LANDED_COST: 'LANDED_COST', ORDER_TOTAL: 'ORDER_TOTAL', PRICE_GAP: 'PRICE_GAP', PRICE_BASIS: 'PRICE_BASIS', UNCOUNTED_COSTS: 'UNCOUNTED_COSTS', MOQ_SCENARIO: 'MOQ_SCENARIO',
  CAN_ORDER: 'CAN_ORDER', // "can I order": read-only explanation (the existing "dois-je acheter" runs the journaled Core analysis and is left alone)
  NEXT_STEP: 'NEXT_STEP',
  SUPPLIER_QUESTIONS: 'SUPPLIER_QUESTIONS', // the questions to put to the supplier (engine's own P1 list, English + Chinese)
  COMPARE_OFFERS: 'COMPARE_OFFERS', // "best supplier / best landed cost": what THIS case holds (one offer); several offers belong to Stock / Achats
  PRICE_JUDGEMENT: 'PRICE_JUDGEMENT', // "is this price good?": the quote against the engine's maximum purchase price - no market benchmark is invented
  EXPLAIN_RECOMMENDATION: 'EXPLAIN_RECOMMENDATION',
});

export const normalize = (s) => String(s ?? '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[’'`´-]/g, ' ').replace(/[^a-z0-9 ,.%€$?]/g, ' ').replace(/\s+/g, ' ').trim();
const tokens = (t) => t.split(/[^a-z0-9]+/).filter(Boolean);

function distance(a, b) { // Levenshtein, bounded: only used on short words to forgive one typo
  if (Math.abs(a.length - b.length) > 1) return 2;
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j += 1) d[0][j] = j;
  for (let i = 1; i <= a.length; i += 1) for (let j = 1; j <= b.length; j += 1) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length][b.length];
}
/** A stem matches a word that starts with it, or (stems of 6+ letters only) a word within one typo of it: "docments", "marje" stay readable, "sac" never matches "sec". */
function stemHit(words, stem) {
  return words.some((w) => w.startsWith(stem) || (stem.length >= 6 && w.length >= stem.length - 1 && distance(w.slice(0, stem.length), stem) <= 1));
}
const has = (words, list) => list.some((s) => stemHit(words, s));

// What makes a sentence "about a sourcing case" (vs. Finance's ledgers or Analytics' sales).
const CASE_WORDS = ['lot', 'dossier', 'fournisseur', 'produit', 'commande', 'devis', 'offre', 'proposition', 'quantite', 'moq', 'minimum', 'supplier', 'product', 'quote', 'order', 'fichier', 'cet article', 'article', 'sourcing', 'ce prix', 'deposit', 'acompte'];
const FINANCE_WORDS = ['factur', 'invoice', 'tresorerie', 'liquidit', 'cash', 'echeanc', 'depense'];
const PROCUREMENT_WORDS = ['stock', 'inventaire', 'transit', 'reapprovision', 'rupture', 'a recommander', 'bon de commande', 'bons de commande', 'commandes d achat', 'commandes en attente', 'commandes en cours', 'commandes ouvertes', 'purchase order', 'retard de livraison', 'commandes en retard', 'entrepot', 'marchandises en'];
const ANALYTICS_WORDS = ['vente', 'ventes', 'chiffre d affaires', 'sales', 'revenue', 'tendance', 'evolu', 'client', 'clients', 'customer', 'customers', 'shopify', 'catalogue', 'par produit', 'tous les produits', 'mes produits', 'mes marges', 'boutique en ligne', 'par mois', 'ce mois', 'cette semaine'];

const RULES = [
  // [intent, groups]: every group must be hit (any stem of the group). More groups = more specific. Order only breaks equal scores.
  [FIELD_INTENT.EXPLAIN_RECOMMENDATION, [['pourquoi', 'explique', 'expliqu', 'justifi', 'comment', 'why'], ['recommand', 'conseil', 'conclusion', 'decision', 'ecart', 'elimin', 'regle', 'recommend']]],
  [FIELD_INTENT.EXPLAIN_RECOMMENDATION, [['option', 'options', 'ecart', 'elimin', 'contrainte', 'regle', 'changer', 'changerait'], ['ecart', 'elimin', 'ecarte', 'recommand', 'propriet', 'budget', 'marge minimale', 'recommandation', 'changer', 'changerait', 'applique', 'appliquee', 'applique']]],
  [FIELD_INTENT.EXPLAIN_RECOMMENDATION, [['quelles options', 'les options', 'options possibles', 'options disponibles', 'autres options', 'quelles sont les options', 'what options']]],
  [FIELD_INTENT.EXPLAIN_RECOMMENDATION, [['pourquoi'], ['hesit', 'refus', 'pas recommand', 'ne recommande']]],
  [FIELD_INTENT.MOQ_SCENARIO, [['quantite minimale', 'quantite mini', 'moq', 'minimum', 'minimale', 'seulement le minimum', 'minimum fournisseur', 'qte min'], ['acheter', 'achete', 'commander', 'prend', 'si', 'seulement', 'marge', 'cout', 'coute', 'prix']]],
  [FIELD_INTENT.ORDER_TOTAL, [['combien'], ['coute', 'cout', 'total', 'ensemble'], ['commande', 'lot', 'ensemble', 'total', 'devis']]],
  [FIELD_INTENT.ORDER_TOTAL, [['total', 'totale', 'ensemble', 'toute la', 'tout le'], ['commande', 'lot', 'devis']]],
  [FIELD_INTENT.ORDER_TOTAL, [['combien'], ['sortir', 'debourser', 'depenser', 'investir', 'mettre', 'avancer'], ['commande', 'lot', 'devis', 'achat']]],
  [FIELD_INTENT.LANDED_COST, [['cout rendu', 'cout de revient', 'landed', 'prix de revient', 'revient', 'cout complet', 'cout total unitaire', 'cout par unite', 'cout unitaire']]],
  [FIELD_INTENT.LANDED_COST, [['quel', 'combien', 'quelle', 'what', 'how'], ['cout', 'coute', 'revient'], ['unite', 'piece', 'rendu', 'unitaire', 'chaque']]],
  [FIELD_INTENT.PRICE_GAP, [['quel', 'quels', 'quelle', 'what', 'quelles'], ['prix', 'cout', 'donnee', 'chiffre'], ['manque', 'manquent', 'absent', 'missing'], ['rentabilite', 'marge', 'calculer', 'profit', 'gagner']]],
  [FIELD_INTENT.PRICE_BASIS, [['prix de vente', 'prix vente', 'selling price', 'prix de revente', 'prix public'], ['observe', 'estime', 'hypothese', 'suppose', 'reel', 'verifie', 'confirm', 'vu', 'cible', 'observed', 'assum']]],
  [FIELD_INTENT.UNCOUNTED_COSTS, [['cout', 'couts', 'frais', 'cost', 'costs'], ['pas encore', 'non compt', 'pas pris', 'pris en compte', 'oubli', 'manqu', 'inclus', 'compris', 'inconnu', 'pas compt', 'not included', 'ignor']]],
  [FIELD_INTENT.MARGIN, [['marge', 'marje', 'rentab', 'benefice', 'gagner', 'gagne', 'profit', 'margin', 'contribution', 'rapporte', 'rapport']]],
  [FIELD_INTENT.SUPPLIER_QUESTIONS, [['question', 'questions', 'demander', 'poser', 'ask'], ['fournisseur', 'supplier', 'signer', 'commande', 'negocier', 'discuter', 'visite', 'usine', 'devis', 'salon'], ]],
  [FIELD_INTENT.SUPPLIER_QUESTIONS, [['quelles questions', 'quelle question', 'questions a poser', 'questions poser', 'questions to ask', 'que demander', 'quoi demander', 'que dois je demander', 'lui demander', 'leur demander', 'faut il demander', 'que demander']]],
  [FIELD_INTENT.PRICE_JUDGEMENT, [['prix'], ['bon', 'correct', 'interessant', 'raisonnable', 'eleve', 'cher', 'negocier', 'acceptable', 'good', 'fair', 'high']], ],
  [FIELD_INTENT.PRICE_JUDGEMENT, [['prix maximum', 'prix max', 'prix limite', 'jusqu a combien', 'maximum payer', 'prix d achat maximum', 'max purchase', 'combien au maximum', 'maximum a payer']], 2],
  [FIELD_INTENT.COMPARE_OFFERS, [['meilleur', 'meilleure', 'meilleurs', 'moins cher', 'comparer', 'compare', 'comparaison', 'classement', 'classer', 'plus avantageux'], ['fournisseur', 'fournisseurs', 'offre', 'offres', 'devis', 'proposition', 'propositions', 'cout rendu', 'prix']], 2],
  [FIELD_INTENT.CAN_ORDER, [['puis je', 'je peux', 'puis-je', 'peut on commander', 'ai je le droit', 'autoris', 'feu vert', 'can i', 'je peut', 'est ce que je peux', 'on peut', 'peux je'], ['command', 'acheter', 'achat', 'signer', 'passer', 'order', 'buy', 'valider', 'lancer', 'verser', 'acompte', 'payer']]],
  [FIELD_INTENT.RISKS, [['preuve', 'preuves'], ['manque', 'manquent', 'manquant', 'manquantes', 'insuffisant', 'insuffisantes', 'faut', 'absente', 'absentes']]],
  [FIELD_INTENT.RISKS, [['risque', 'risques', 'danger', 'bloquer', 'bloque', 'blocage', 'bloquant', 'bloquants', 'probleme', 'attention', 'alerte', 'risk', 'block', 'preuve', 'preuves', 'inquiet', 'hesit', 'point faible', 'piege', 'mal tourner', 'tourner mal', 'pourrait mal', 'risque de', 'dangereux', 'risque']]],
  [FIELD_INTENT.DOCUMENTS, [['document', 'documents', 'certificat', 'certificats', 'papier', 'papiers', 'declaration', 'rapport de test', 'conformite', 'marquage ce'], ['verifier', 'manque', 'manquent', 'manquant', 'faut', 'demander', 'exiger', 'reclamer', 'fournir', 'controler', 'check', 'missing', 'need', 'necessaire', 'requis', 'sont la', 'presents', 'recus', 'fournis', 'complets', 'complete']]],
  [FIELD_INTENT.NEXT_STEP, [['prochaine etape', 'etape suivante', 'next step', 'prochain pas', 'prochaine action', 'que faire', 'quoi faire', 'maintenant', 'conseille', 'recommandes tu', 'tu me conseilles', 'a verifier', 'verifier maintenant', 'dois je verifier', 'dois je faire', 'dois je demander', 'poser comme question', 'questions poser', 'quelles questions']]],
  [FIELD_INTENT.MISSING, [['point', 'points', 'sujets', 'elements', 'choses'], ['eclaircir', 'clarifier', 'preciser', 'verifier', 'regler', 'trancher']]],
  [FIELD_INTENT.MISSING, [['tout ce qu il faut', 'assez d infos', 'assez d informations', 'tout ce qu il me faut', 'suffisamment d informations']]],
  [FIELD_INTENT.MISSING, [['manque', 'manquent', 'manquant', 'manquants', 'incomplet', 'complet', 'absent', 'absents', 'lacune', 'missing', 'trou', 'reste a', 'il me faut', 'faut il encore', 'encore besoin']]],
  [FIELD_INTENT.KNOWLEDGE, [['sait', 'sais', 'savons', 'connais', 'connait', 'connaissons', 'confirme', 'confirmes', 'confirmee', 'confirmees', 'know', 'avons nous', 'donnees', 'infos', 'information', 'informations'], ['dossier', 'fournisseur', 'produit', 'supplier', 'product', 'case', 'file', 'tu', 'on', 'nous', 'avons', 'a ce', 'sur', 'disponible', 'disponibles', 'ne sais', 'savoir', 'sait pas']]],
  [FIELD_INTENT.KNOWLEDGE, [['fais moi le point', 'le point sur', 'etat du dossier', 'ou en est', 'ou en sommes', 'bilan du dossier', 'etat des lieux']]],
  [FIELD_INTENT.KNOWLEDGE, [['est confirme', 'est confirmee', 'sont confirmes', 'sont confirmees', 'est verifie', 'est prouve', 'est etabli']]],
  [FIELD_INTENT.KNOWLEDGE, [['quest ce que tu sais', 'qu est ce que tu sais', 'ce que tu sais', 'ce que tu ne sais', 'sais tu', 'sais-tu']]],
];

// Sentences the EXISTING flows own (kept exactly as they are): the router's "résume ce dossier", the journaled "dois-je acheter".
const EXISTING_SUMMARY = /(resum|summar|synthese|recap).*(dossier|case|file)|(dossier|case).*(resum|summar)/;
const EXISTING_BUY = /(dois.?je|faut.?il|devrais.?je|peut.?on|should i).*(achet|command|buy|order)|(analys).*(dossier|produit|achat)/;
const EXISTING_JOURNAL = /(decision|decide|valider|approuv).*(attente|en cours|a prendre|a valider)|(en attente|a valider).*(decision)|\bsuivi\b|follow.?up|resultat.*(decision|achat)/;

/**
 * @returns {{ intent: string|null, status: 'RECOGNISED'|'AMBIGUOUS'|'DEFERRED'|'UNKNOWN', candidates?: string[], reason?: string, caseWords?: boolean }}
 *   DEFERRED = the sentence belongs to another flow (existing Core answers, Finance, Analytics): the field assistant stays out of it.
 */
export function recognizeFieldIntent(text) {
  const t = normalize(text);
  if (!t) return { intent: null, status: 'UNKNOWN', reason: 'EMPTY' };
  if (EXISTING_SUMMARY.test(t) || EXISTING_BUY.test(t) || EXISTING_JOURNAL.test(t)) return { intent: null, status: 'DEFERRED', reason: 'EXISTING_FLOW' };
  const words = tokens(t);
  const phraseHit = (list) => list.some((s) => (s.includes(' ') ? t.includes(s) : stemHit(words, s)));
  const scored = [];
  for (const [intent, groups, bonus = 0] of RULES) {
    if (groups.every((g) => phraseHit(g))) scored.push({ intent, score: groups.length + bonus });
  }
  const caseWords = phraseHit(CASE_WORDS);
  const proc = phraseHit(PROCUREMENT_WORDS) || /po [0-9]{4} [0-9]+/.test(t); const finance = phraseHit(FINANCE_WORDS); const analytics = phraseHit(ANALYTICS_WORDS) && !/prix de vente|selling price/.test(t); // Stock / Achats sentences are treated like Finance's: they belong to their module

  // Stock / Achats (stock, transit, reorder, purchase orders, a PO number) always belongs to Stock / Achats, even beside a case word: its own answers come first, the router says "not connected" otherwise
  if (proc) return { intent: null, status: 'DEFERRED', reason: 'PROCUREMENT_ANCHOR' };
  // Finance / Analytics boundary: their anchor words with no case anchor stay theirs; with both, the sentence is ambiguous - ask, never guess.
  if ((finance || analytics) && (!caseWords || !scored.length)) return { intent: null, status: 'DEFERRED', reason: finance ? 'FINANCE_ANCHOR' : 'ANALYTICS_ANCHOR' };
  if (!scored.length) return { intent: null, status: 'UNKNOWN', caseWords };
  if (finance || analytics) return { intent: null, status: 'AMBIGUOUS', candidates: [...new Set(scored.map((s) => s.intent))], reason: finance ? 'FINANCE_AND_CASE' : 'ANALYTICS_AND_CASE', caseWords };

  const best = Math.max(...scored.map((s) => s.score));
  const top = [...new Set(scored.filter((s) => s.score === best).map((s) => s.intent))];
  if (top.length === 1) return { intent: top[0], status: 'RECOGNISED', caseWords };
  // Two intents equally specific: a few pairs are really one question, anything else is asked.
  const pair = (a, b) => top.length === 2 && top.includes(a) && top.includes(b);
  if (pair(FIELD_INTENT.SUPPLIER_QUESTIONS, FIELD_INTENT.DOCUMENTS)) return { intent: FIELD_INTENT.DOCUMENTS, status: 'RECOGNISED', caseWords };
  if (pair(FIELD_INTENT.RISKS, FIELD_INTENT.DOCUMENTS)) return { intent: FIELD_INTENT.RISKS, status: 'RECOGNISED', caseWords };
  if (pair(FIELD_INTENT.MISSING, FIELD_INTENT.DOCUMENTS)) return { intent: FIELD_INTENT.DOCUMENTS, status: 'RECOGNISED', caseWords };
  if (pair(FIELD_INTENT.MISSING, FIELD_INTENT.KNOWLEDGE)) return { intent: FIELD_INTENT.MISSING, status: 'RECOGNISED', caseWords };
  if (pair(FIELD_INTENT.NEXT_STEP, FIELD_INTENT.DOCUMENTS)) return { intent: FIELD_INTENT.NEXT_STEP, status: 'RECOGNISED', caseWords };
  return { intent: null, status: 'AMBIGUOUS', candidates: top, reason: 'EQUAL_SCORE', caseWords };
}

export const INTENT_LABEL = Object.freeze({
  KNOWLEDGE: 'ce que nous savons et ne savons pas du dossier', MISSING: 'ce qui manque au dossier', DOCUMENTS: 'les documents à vérifier', RISKS: 'les risques et blocages',
  MARGIN: 'la marge', LANDED_COST: 'le coût rendu', ORDER_TOTAL: 'le coût total de la commande', PRICE_GAP: 'le prix ou la donnée qui manque pour la rentabilité', PRICE_BASIS: 'l’origine du prix de vente',
  UNCOUNTED_COSTS: 'les coûts pas encore pris en compte', SUPPLIER_QUESTIONS: 'les questions à poser au fournisseur', PRICE_JUDGEMENT: 'le prix du devis comparé au prix maximum calculé', COMPARE_OFFERS: 'la comparaison des offres', MOQ_SCENARIO: 'le scénario à la quantité minimale', CAN_ORDER: 'la possibilité de commander', NEXT_STEP: 'la prochaine vérification', EXPLAIN_RECOMMENDATION: 'l’explication de la recommandation',
});

// An IMPERATIVE asking Nordla to act (order, pay, send, approve, record, erase, adjust stock...). Nordla only answers: such a sentence is refused out loud, never "answered" with an unrelated
// explanation that could be read as "done". Questions ("puis-je commander ?") are not imperatives and keep their own answers. Verbs that are also NOUNS ("commande", "achete", "signe", "lance")
// count only when an object follows (a determiner, a number, "maintenant"): "commande fournisseur en cours" is a noun phrase, "commande 500 pieces" is an order.
const ACTION_VERBS = 'passe|passer|approuve|approuver|valide|valider|paie|paye|payer|envoie|envoyer|enregistre|enregistrer|efface|effacer|supprime|supprimer|annule|annuler|desactive|desactiver|modifie|modifier|autorise|autoriser|ajoute|ajouter|verse|verser|transfere|transferer|debloque|debloquer|ignore|ignorer|ajuste|ajuster|receptionne|receptionner|corrige|corriger|incremente|decremente';
const NOUN_VERBS = 'commande|commander|achete|acheter|signe|signer|lance|lancer|cree|creer';
const LEAD = '^(nordla )?(tu peux |peux tu |s il te plait |stp |maintenant |alors |et )?';
const ACTION_RE = new RegExp(LEAD + '(' + ACTION_VERBS + ')( |$)');
const NOUN_ACTION_RE = new RegExp(LEAD + '(' + NOUN_VERBS + ') (le |la |les |l |un |une |des |ce |cet |cette |mon |ma |mes |tout |toute |tous |ca |moi |maintenant|[0-9])');
export function isActionRequest(text) {
  const segments = String(text ?? '').split(/[:;,.!?]/).flatMap((x) => normalize(x).split(/ puis | et puis /)).map((x) => x.trim()).filter(Boolean);
  return segments.some((seg) => ACTION_RE.test(seg) || NOUN_ACTION_RE.test(seg));
}
