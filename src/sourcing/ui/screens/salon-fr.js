// SALON FRENCH LAYER. The core engines (core/field/*, comparison, decision) write their explanations in English and their contracts (enum names, snapshot values, tests) stay as they are; this module
// turns the sentences the SALON SHOWS to the owner into French. Pure, deterministic, no network. It only rewrites text: a sentence with no rule is returned unchanged (the coverage test
// test/sourcing-field-v1-phone-ui.test.js fails when a sentence of the screens stays in English, so a new engine sentence cannot slip through silently).
// Supplier-facing text (English / Chinese questions) is NOT passed through here: it stays in the language the supplier reads.

const DOC = [
  [/^Declaration of compliance for food contact for the exact product$/i, 'Déclaration de conformité contact alimentaire pour ce produit exact'],
  [/^Migration \/ material test report(?: \(e\.g\. specific and overall migration\))?(?: from a laboratory)?$/i, "Rapport d'essai de migration / matière (migration spécifique et globale) d'un laboratoire"],
  [/^Declaration of compliance available on request$/i, 'Déclaration de conformité disponible sur demande'],
  [/^EU declaration of conformity \/ compliance declaration for the category$/i, 'Déclaration UE de conformité / déclaration de conformité pour la catégorie'],
  [/^Laboratory test report for the category$/i, "Rapport d'essai de laboratoire pour la catégorie"],
  [/^Instructions in French, Dutch and German$/i, 'Notice en français, néerlandais et allemand'],
  [/^Label artwork with manufacturer \/ responsible person details and a product picture for the listing$/i, "Maquette d'étiquette avec fabricant / personne responsable et photo du produit pour la fiche"],
  [/^Manual, safety information and packaging text in French and Dutch.*$/i, "Notice, informations de sécurité et texte d'emballage en français et néerlandais (allemand pour la zone germanophone)"],
  [/^Material declaration \(material, additives, intended temperature and food types\)$/i, 'Déclaration matière (matière, additifs, température prévue et types d\'aliments)'],
  [/^Name the EU responsible person for each marketplace$/i, 'Nommer la personne responsable UE pour chaque place de marché'],
  [/^REACH \/ SVHC test evidence or supplier declaration for the exact product$/i, 'Preuve d\'essai REACH / SVHC ou déclaration du fournisseur pour ce produit exact'],
  [/^RoHS test report or material declaration for the exact model \(EN IEC 63000 technical documentation\)$/i, "Rapport d'essai RoHS ou déclaration matière pour ce modèle exact (documentation technique EN IEC 63000)"],
  [/^Safety data sheet$/i, 'Fiche de données de sécurité'],
  [/^UN 38\.3 summary for lithium batteries$/i, 'Résumé UN 38.3 pour batteries au lithium'],
];
const WORDS = {
  Price: 'Prix', 'Landed cost': 'Coût rendu', 'Landed cost per unit': 'Coût rendu par pièce', Margin: 'Marge', Documents: 'Documents', 'Lead time': 'Délai', Material: 'Matière', Contradiction: 'Contradiction', 'Contradictions ?': 'Contradictions ?',
  'Cheapest quote is not the cheapest landed': "Le devis le moins cher n'est pas le moins cher rendu", 'Compliance assessment differs': "L'évaluation de conformité diffère", 'Evidence completeness differs': 'La solidité des preuves diffère', 'No clear winner yet': 'Pas encore de gagnant net',
  Unknown: 'Inconnu', 'no quote': 'pas de devis', 'not stated': 'non précisé', 'nothing stated yet': 'rien de précisé pour l\'instant', 'what is required cannot be determined yet': 'ce qui est exigé ne peut pas encore être déterminé', 'cannot be calculated yet': 'ne peut pas encore être calculé',
  'no price on record': 'aucun prix enregistré', 'no usable price on record': 'aucun prix utilisable enregistré', 'no lead time stated': 'aucun délai précisé', 'no revision of the offer yet': "pas encore de nouvelle version de l'offre", 'no maximum purchase price yet': "pas encore de prix d'achat maximum",
  'calculated from claims and entered costs': 'calculé à partir des déclarations et des coûts saisis', 'stated by the supplier or typed by you': 'dit par le fournisseur ou saisi par vous', 'the supplier says so about itself: not checked': 'le fournisseur le dit de lui-même : non vérifié',
  'no sample requested or evaluated': 'aucun échantillon demandé ni évalué', 'the supplier says claimed: no document received': 'le fournisseur dit l\'avoir : aucun document reçu', 'nothing required is missing for the rules that apply today': "rien d'exigé ne manque pour les règles applicables aujourd'hui",
  'no external evidence on record: nothing here was checked against a registry, an audit or a shipment history': "aucune vérification externe enregistrée : rien n'a été contrôlé auprès d'un registre, d'un audit ou d'un historique d'expéditions",
  'the supplier has moved price or MOQ between offers': 'le fournisseur a changé le prix ou le MOQ entre deux offres', 'the material was stated differently': 'la matière a été annoncée de deux façons',
  'price within the limit and stable': 'prix dans la limite et stable', 'the sample was evaluated: PASS': "l'échantillon a été évalué : conforme", 'the sample was evaluated: FAIL': "l'échantillon a été évalué : échec", 'the sample was evaluated: CONCERNS': "l'échantillon a été évalué : avec réserves",
  'open contradiction; evidence too weak': 'contradiction ouverte ; preuves trop faibles', 'evidence too weak': 'preuves trop faibles', 'investigate': 'à creuser',
  'MOQ not stated': 'MOQ non précisé', 'lead time not stated': 'délai non précisé', 'customisation not stated': 'personnalisation non précisée', 'sample terms not stated': "conditions de l'échantillon non précisées", 'refund not mentioned': 'remboursement non mentionné',
  'no MOQ on record': 'aucun MOQ enregistré', 'no lead time on record': 'aucun délai enregistré', 'no customisation on record': 'aucune personnalisation enregistrée', 'no sample price on record': "aucun prix d'échantillon enregistré", 'sample price in the offer': "prix de l'échantillon dans l'offre", 'no Incoterm on record': 'aucun Incoterm enregistré',
  'no quote': 'pas de devis', 'quote': 'devis',
  'the lead time moved': 'le délai a changé', 'the supplier lengthened the lead time': 'le fournisseur a rallongé le délai',
  'the exact product (model) is not established': "le produit exact (le modèle) n'est pas établi", 'no usable unit price': 'aucun prix unitaire utilisable', 'get the exact model number': 'obtenir le numéro de modèle exact', 'get a clear unit price for your quantity': 'obtenir un prix unitaire clair pour votre quantité',
  'enter the selling price and the target margin': 'saisir le prix de vente et la marge visée', 'enter the missing import costs (freight, duty, exchange rate) or get the Incoterm': "saisir les coûts d'import manquants (transport, douane, taux de change) ou obtenir l'Incoterm", 'resolve the contradiction with the supplier': 'lever la contradiction avec le fournisseur',
  'get the correct document for this exact model': 'obtenir le bon document pour ce modèle exact', 'a supplied document names another model than the case': 'un document fourni cite un autre modèle que le dossier', 'request a sample': 'demander un échantillon', 'no sample requested': 'aucun échantillon demandé', 'evaluate the sample': "évaluer l'échantillon",
  'run the Safety Gate check while online': 'lancer la vérification Safety Gate en ligne', 'collect the supporting documents': 'réunir les documents justificatifs', 'confirm, correct or reject the imported facts': 'confirmer, corriger ou rejeter les faits importés', 'enter the remaining import costs': "saisir les coûts d'import restants",
  'the EU Safety Gate check is not live (cached or offline)': "la vérification EU Safety Gate n'est pas à jour (copie locale ou hors ligne)", 'the supplier evidence is only partly there': 'les preuves du fournisseur sont partielles', 'the margin cannot be calculated': 'la marge ne peut pas être calculée',
  'the landed cost is only a lower bound (some import costs are not entered)': "le coût rendu n'est qu'un minimum (des coûts d'import ne sont pas saisis)",
  'assessment cannot conclude yet (missing information)': "l'évaluation ne peut pas encore conclure (informations manquantes)", 'landed cost unknown': 'coût rendu inconnu', 'margin unknown': 'marge inconnue', 'the assessment cannot conclude yet (missing information)': "l'évaluation ne peut pas encore conclure (informations manquantes)",
  'the compliance assessment cannot conclude yet (missing information)': "l'évaluation de conformité ne peut pas encore conclure (informations manquantes)",
  'open contradiction': 'contradiction ouverte', 'weak': 'faible', 'WEAK': 'faible', 'MEDIUM': 'moyenne', 'STRONG': 'solide', 'INSUFFICIENT': 'insuffisante',
  'Ask the minimum order quantity.': 'Demander le minimum de commande.', 'Ask the production lead time and the payment terms.': 'Demander le délai de production et les conditions de paiement.', 'Get a clear unit price for your quantity first.': "D'abord obtenir un prix unitaire clair pour votre quantité.", 'Get the Incoterm and the port in writing.': "Obtenir l'Incoterm et le port par écrit.",
  'Ask whether a sample is possible, its cost and its lead time.': 'Demander si un échantillon est possible, son coût et son délai.', 'Ask whether it can be supplied blank or with your logo, and at which MOQ and extra cost.': 'Demander s\'il peut être livré neutre ou avec votre logo, et à quel MOQ et surcoût.',
  'No Chinese sentence available for this question: none is invented.': "Pas de phrase chinoise disponible pour cette question : aucune n'est inventée.", 'No Chinese sentence exists for this ask yet: none is invented.': "Pas encore de phrase chinoise pour cette demande : aucune n'est inventée.",
  'Nordla does not predict what the supplier will accept: targets are arithmetic from your own numbers, not a market forecast.': "Nordla ne prédit pas ce que le fournisseur acceptera : les objectifs sont un calcul à partir de vos propres chiffres, pas une prévision du marché.",
  'Customs, VAT, freight and fees are never guessed: only what was entered. A figure with a missing cost is a lower bound or UNKNOWN.': 'Douane, TVA, transport et frais ne sont jamais devinés : seulement ce qui a été saisi. Un chiffre auquel il manque un coût est un minimum ou INCONNU.',
  'The Chinese is a fixed phrasebook, checked technically but NOT reviewed by a native speaker. Model numbers, standards and document names are inserted exactly. Have anything important checked by a Chinese speaker.': 'Le chinois vient d\'un recueil de phrases fixes, vérifié techniquement mais PAS relu par un locuteur natif. Les numéros de modèle, normes et noms de documents sont insérés tels quels. Faites vérifier tout ce qui est important par un locuteur chinois.',
  'Some Chinese sentences were reviewed by a native speaker; each carries its own review state.': 'Certaines phrases chinoises ont été relues par un locuteur natif ; chacune porte son propre état de relecture.',
  'Nothing decision-relevant is open for this offer.': "Rien qui pèse sur la décision n'est ouvert pour cette offre.",
  'nothing can be tied to a product without its exact model': 'sans le modèle exact, rien ne peut être rattaché au produit',
  'selling price or VAT rate not entered': 'prix de vente ou taux de TVA non saisi', 'not computable: selling price or VAT rate not entered': 'non calculable : prix de vente ou taux de TVA non saisi',
  'no selling price entered for this product': 'aucun prix de vente saisi pour ce produit', 'the product category is not known yet': "la catégorie du produit n'est pas encore connue", 'the material is not known': "la matière n'est pas connue", 'the size of one unit is not known': "la taille d'une pièce n'est pas connue", 'neither the weight nor the size of one unit is known': "ni le poids ni la taille d'une pièce ne sont connus",
  'too little description to say': 'description trop courte pour se prononcer', 'nothing says whether it can be sold as a set or combined with other products': 'rien ne dit si le produit peut être vendu en lot ou combiné à d\'autres', 'nothing says whether the product can be customised or printed on': 'rien ne dit si le produit peut être personnalisé ou imprimé',
  'no marketplace observation entered: saturation cannot be judged': "aucune observation de place de marché saisie : la saturation ne peut pas être jugée", 'no merchant profile is loaded: nothing to compare with': "aucun profil marchand chargé : rien à comparer", 'differentiation can only be judged from market observations (similar listings, searches), and none are on record': "la différenciation ne se juge que sur des observations du marché (annonces similaires, recherches) et aucune n'est enregistrée",
  'no seasonal cue found in the name, notes or supplier statements (this is not a guarantee that the product sells all year)': "aucun indice de saison dans le nom, les notes ou les déclarations du fournisseur (cela ne garantit pas que le produit se vende toute l'année)",
  SELLING_PRICE_NOT_ENTERED: 'prix de vente non saisi',
};

const PLURAL = (n, one, many) => (Number(n) === 1 ? one : many);
const RULES = [
  [/^(\d+) contradiction$/i, (m) => `${m[1]} contradiction${Number(m[1]) > 1 ? 's' : ''}`],
  [/^! (\d+) contradiction$/i, (m) => `! ${m[1]} contradiction${Number(m[1]) > 1 ? 's' : ''}`],
  [/^(\d+) price tiers?$/i, (m) => `${m[1]} ${PLURAL(m[1], 'palier de prix', 'paliers de prix')}`],
  [/^(\d+) condition\(s\) to clear before any deposit\.?$/i, (m) => `${m[1]} ${PLURAL(m[1], 'condition à lever', 'conditions à lever')} avant tout acompte.`],
  [/^CONDITIONAL_GO with (\d+) condition\(s\) to clear before any deposit\.?$/, (m) => `Feu vert sous conditions : ${m[1]} ${PLURAL(m[1], 'condition à lever', 'conditions à lever')} avant tout acompte.`],
  [/^(.+?): viable \(CONDITIONAL_GO with (\d+) condition\(s\) to clear before any deposit\)\.$/, (m, t) => `${m[1]} : viable (feu vert sous conditions : ${m[2]} ${PLURAL(m[2], 'condition à lever', 'conditions à lever')} avant tout acompte).`],
  [/^(.+?): investigate \((.+)\)\.$/, (m, t) => `${m[1]} : à creuser (${t(m[2])}).`],
  [/^(.+?): (WEAK|MEDIUM|STRONG|INSUFFICIENT)( \| .+)?$/, (m, t) => `${m[1]} : ${t(m[2])}${m[3] ? m[3].replace(/ \| (.+?): (WEAK|MEDIUM|STRONG|INSUFFICIENT)/g, (_, n, l) => ` | ${n} : ${t(l)}`) : ''}`],
  [/^(\d+) required documents? missing: (.+)$/, (m, t) => `${m[1]} ${PLURAL(m[1], 'document exigé manque', 'documents exigés manquent')} : ${m[2].split(/; |, /).map((x) => t(x.trim())).join(' ; ')}`],
  [/^(\d+) required document\(s\) missing: (.+)$/, (m, t) => `${m[1]} ${PLURAL(m[1], 'document exigé manque', 'documents exigés manquent')} : ${m[2].split(/, (?=[A-Z])/).map((x) => t(x.trim())).join(' ; ')}`],
  [/^(\d+) contradictory statements?\(s\)(?:: (.+))?$/, (m) => `${m[1]} ${PLURAL(m[1], 'déclaration contradictoire', 'déclarations contradictoires')}${m[2] ? ` : ${m[2]}` : ''}`],
  [/^(\d+) contradictory statement\(s\) not resolved$/, (m) => `${m[1]} ${PLURAL(m[1], 'déclaration contradictoire non résolue', 'déclarations contradictoires non résolues')}`],
  [/^(\d+) contradictory statement\(s\): (.+)$/, (m) => `${m[1]} ${PLURAL(m[1], 'déclaration contradictoire', 'déclarations contradictoires')} : ${m[2]}`],
  [/^(\d+) (?:important )?questions? before leaving the stand(?: \((\d+) lower-impact questions? can wait\))?\.$/, (m) => `${m[1]} ${PLURAL(m[1], 'question', 'questions')} avant de quitter le stand${m[2] ? ` (${m[2]} ${PLURAL(m[2], 'question moins importante peut attendre', 'questions moins importantes peuvent attendre')})` : ''}.`],
  [/^(\d+) offer\(s\) are still unknown or in conflict: investigate them before concluding \(an unknown is not a defect\)\.$/, (m) => `${m[1]} ${PLURAL(m[1], 'offre est encore inconnue ou en conflit', 'offres sont encore inconnues ou en conflit')} : creusez-les avant de conclure (un inconnu n'est pas un défaut).`],
  [/^No offer is recommended as a buy candidate: no offer is viable on the evidence available\.$/, () => "Aucune offre n'est recommandée comme candidate à l'achat : aucune n'est viable avec les preuves disponibles."],
  [/^No offer is recommended as a buy candidate: (.+)$/, (m, t) => `Aucune offre n'est recommandée comme candidate à l'achat : ${t(m[1])}`],
  [/^no offer is viable on the evidence available$/, () => "aucune offre n'est viable avec les preuves disponibles"],
  [/^no landed cost can be compared yet$/i, () => "aucun coût rendu n'est encore comparable"],
  [/^no landed cost per unit$/i, () => 'pas de coût rendu par pièce'],
  [/^Some offers have no landed cost yet: the best landed cost among the others is PROVISIONAL\.$/, () => "Certaines offres n'ont pas encore de coût rendu : le meilleur coût rendu parmi les autres est PROVISOIRE."],
  [/^(.+?) has the lowest quote \(([^)]+)\) but (.+?) has the lowest landed cost \(([^)]+)\)\.(?: (.+))?$/, (m, t) => `${m[1]} a le devis le plus bas (${m[2]}) mais ${m[3]} a le coût rendu le plus bas (${m[4]}).${m[5] ? ` ${t(m[5])}` : ''}`],
  [/^(EXW|FOB|DAP|CIF|DDP|FCA|CFR) excludes origin charges \(export clearance, loading\), main freight, insurance that (\w+) already includes: the \w+ price looks lower only until those costs are added\.$/, (m) => `${m[1]} exclut les frais d'origine (dédouanement export, chargement), le transport principal et l'assurance que ${m[2]} inclut déjà : le prix ${m[1]} ne paraît plus bas que tant que ces coûts ne sont pas ajoutés.`],
  [/^(\w+): the price already covers nothing beyond the goods; you pay origin charges \(export clearance, loading\), main freight, insurance, import duties\.$/, (m) => `${m[1]} : le prix ne couvre que la marchandise ; vous payez les frais d'origine (dédouanement export, chargement), le transport principal, l'assurance et les droits d'import.`],
  [/^(\w+): the price already covers origin charges \(export clearance, loading\); you pay main freight, insurance, import duties\.$/, (m) => `${m[1]} : le prix couvre déjà les frais d'origine (dédouanement export, chargement) ; vous payez le transport principal, l'assurance et les droits d'import.`],
  [/^(\w+): the price already covers origin charges \(export clearance, loading\), main freight, insurance; you pay import duties\.$/, (m) => `${m[1]} : le prix couvre déjà les frais d'origine (dédouanement export, chargement), le transport principal et l'assurance ; vous payez les droits d'import.`],
  [/^(\w+) leaves origin charges and loading to you$/, (m) => `${m[1]} laisse les frais d'origine et le chargement à votre charge`],
  [/^Incoterm table of the landed-cost engine$/, () => "table des Incoterms du calcul du coût rendu"],
  [/^The quoted price \(([^)]+)\) is within the maximum purchase price \(([^)]+)\)\.$/, (m) => `Le prix annoncé (${m[1]}) est dans le prix d'achat maximum (${m[2]}).`],
  [/^The quoted price \(([^)]+)\) is above the maximum purchase price \(([^)]+)\)\.$/, (m) => `Le prix annoncé (${m[1]}) dépasse le prix d'achat maximum (${m[2]}).`],
  [/^cannot be calculated: missing (.+)$/, (m, t) => `ne peut pas être calculé : manque ${m[1].split(', ').map((x) => ({ unitPrice: 'le prix unitaire', freight: 'le transport', customsDuty: 'le droit de douane', fx: 'le taux de change', 'supplier.unitPrice': 'le prix unitaire', 'costs.freight': 'le transport', 'costs.customsDuty': 'le droit de douane' }[x] ?? x)).join(', ')}`],
  [/^cannot be calculated: (.+)$/, (m, t) => `ne peut pas être calculé : ${t(m[1])}`],
  [/^missing supplier\.unitPrice, costs\.freight, costs\.customsDuty$/, () => 'manque le prix unitaire, le transport et le droit de douane'],
  [/^(?:the )?landed cost cannot be calculated \(missing (.+)\)$/, (m) => `le coût rendu ne peut pas être calculé (manque : ${m[1].split(', ').map((x) => ({ unitPrice: 'prix unitaire', freight: 'transport', customsDuty: 'droit de douane', fx: 'taux de change', inputs: 'données' }[x] ?? x)).join(', ')})`],
  [/^(\d+(?:\.\d+)?) days stated, but nothing says when you need the goods$/, (m) => `${m[1]} jours annoncés, mais rien ne dit quand vous avez besoin de la marchandise`],
  [/^price moved (\d+) time\(s\)$/, (m) => `le prix a changé ${m[1]} ${PLURAL(m[1], 'fois', 'fois')}`],
  [/^MOQ changed (\d+) time\(s\): (.+)$/, (m) => `le MOQ a changé ${m[1]} fois : ${m[2].replace(/->/g, '→')}`],
  [/^(.+?) · price moved (\d+) time\(s\)$/, (m, t) => `${t(m[1])} · le prix a changé ${m[2]} fois`],
  [/^the lead time moved: (\d+) -> (\d+) days$/, (m) => `le délai a changé : ${m[1]} → ${m[2]} jours`],
  [/^The lead time moved from (\d+) to (\d+) days between two offers: ask to keep (\d+) days\.$/, (m) => `Le délai est passé de ${m[1]} à ${m[2]} jours entre deux offres : demandez de garder ${m[3]} jours.`],
  [/^certificate claimed repeatedly without a document: (.+)$/, (m) => `certificat annoncé plusieurs fois sans document : ${m[1]}`],
  [/^the sample was evaluated: (\w+)$/, (m) => `l'échantillon a été évalué : ${({ PASS: 'conforme', FAIL: 'échec', CONCERNS: 'avec réserves' })[m[1]] ?? m[1]}`],
  [/^Certificate: (.+)$/, (m) => `Certificat : ${DOC_NAME_FR[m[1]] ?? m[1]}`],
  [/^Landed cost$/, () => 'Coût rendu'],
  [/^≈ (.+) per unit$/, (m) => `≈ ${m[1]} par pièce`],
  [/^(.+?) for (\d+) pcs \((\d+) price tiers?\)$/, (m) => `${m[1]} pour ${m[2]} pièces (${m[3]} ${PLURAL(m[3], 'palier de prix', 'paliers de prix')})`],
  [/^([\d.]+ \w+) above the opening target, ([\d.]+ \w+) below the limit$/, (m) => `${m[1]} au-dessus de l'objectif d'ouverture, ${m[2]} sous la limite`],
  [/^(\d+)% below the maximum purchase price \(merchant setting\)$/, (m) => `${m[1]} % sous le prix d'achat maximum (réglage du marchand)`],
  [/^Ask for ([\d.]+ \w+) \(the quote is ([\d.]+ \w+)\); your limit is ([\d.]+ \w+)\.$/, (m) => `Demandez ${m[1]} (le devis est à ${m[2]}) ; votre limite est ${m[3]}.`],
  [/^You can accept up to ([\d.]+ \w+); the quote is ([\d.]+ \w+)\. Nordla has no opening target configured\.$/, (m) => `Vous pouvez accepter jusqu'à ${m[1]} ; le devis est à ${m[2]}. Aucun objectif d'ouverture n'est configuré.`],
  [/^The price is already at or below your opening target: do not spend effort on price, secure the other terms\.$/, () => "Le prix est déjà à votre objectif d'ouverture ou en dessous : ne dépensez pas d'énergie sur le prix, sécurisez les autres conditions."],
  [/^quote at or below the target$/, () => "devis à l'objectif ou en dessous"],
  [/^inside the limit; no target step configured$/, () => 'dans la limite ; aucun pas de négociation configuré'],
  [/^maximum purchase price from the economics engine$/, () => "prix d'achat maximum issu du calcul économique"],
  [/^the merchant has not configured how far below the maximum to open \(negotiation\.targetBelowMaxPct\)$/, () => "le marchand n'a pas configuré de combien ouvrir sous le maximum (negotiation.targetBelowMaxPct)"],
  [/^merchant setting: how far below the maximum to open$/, () => "réglage du marchand : de combien ouvrir sous le maximum"],
  [/^no walk-away price to derive a target from$/, () => "pas de prix limite dont déduire un objectif"],
  [/^selling price \(VAT included\)(, target margin, landed-cost inputs \(freight, duty, FX\))?$/, (m) => `prix de vente TTC${m[1] ? ', marge visée, éléments du coût rendu (transport, douane, change)' : ''}`],
  [/^Manque : (.+)$/, (m, t) => `Manque : ${splitTop(m[1], ', ').map(t).join(', ')}`],
  [/^Do not pay a deposit before you hold: (.+)\.$/, (m, t) => `Ne payez aucun acompte avant d'avoir : ${m[1].split('; ').map(t).join(' ; ')}.`],
  [/^required evidence is missing for the rules that apply$/, () => 'des preuves exigées manquent pour les règles applicables'],
  [/^regulatory assessment \(decision support\)$/, () => "évaluation réglementaire (aide à la décision)"],
  [/^the supplier lengthened the lead time$/, () => 'le fournisseur a rallongé le délai'],
  [/^offer (\d+) -> offer (\d+)$/, (m) => `offre ${m[1]} → offre ${m[2]}`],
  [/^get (.+)$/, (m, t) => `obtenir : ${t(m[1])}`],
  [/^enter (.+)$/, (m, t) => `saisir ${t(m[1])}`],
  [/^ask the supplier: (.+)$/, (m) => `demander au fournisseur : ${m[1].replace(/\bblank\b/, 'neutre').replace(/customisation/, 'personnalisation').replace(/\blogo\b/, 'logo').replace(/material of the printable surface/, 'matière de la surface imprimable')}`],
  [/^ask: (.+)$/, (m) => `demander : ${m[1].replace(/product size or carton size and units per carton/, 'taille du produit ou du carton et pièces par carton')}`],
  [/^carton weight and units per carton$/, () => 'poids du carton et pièces par carton'],
  [/^owner: price band in the profile$/, () => 'vous : la fourchette de prix dans le profil'],
  [/^selling price \(VAT included\)$/, () => 'prix de vente TTC'], [/^selling price, landed cost inputs$/, () => 'prix de vente, éléments du coût rendu'],
  [/^a selling price of ([\d.]+) EUR is entered but the merchant's price band is not configured$/, (m) => `un prix de vente de ${m[1]} EUR est saisi mais la fourchette de prix du marchand n'est pas configurée`],
  [/^contribution ([\d.]+)% reaches the target$/, (m) => `la contribution de ${m[1]} % atteint l'objectif`],
  [/^contribution ([\d.]+)% is below the target$/, (m) => `la contribution de ${m[1]} % est sous l'objectif`],
  [/^the margin cannot be calculated \(selling price or VAT rate not entered\)$/, () => 'la marge ne peut pas être calculée (prix de vente ou taux de TVA non saisi)'],
  [/^(.+) is a category the merchant already sells$/, (m) => `${m[1]} est une catégorie que le marchand vend déjà`],
  [/^the category \((.+)\) is one the merchant treats as a gift category$/, (m) => `la catégorie (${m[1]}) est traitée comme cadeau par le marchand`],
  [/^the category \((.+)\) combines with categories the merchant sells, but nothing says this product is a set$/, (m) => `la catégorie (${m[1]}) se combine avec des catégories vendues par le marchand, mais rien ne dit que ce produit est un lot`],
  [/^the description suggests a set\/bundle \((.+)\)$/, (m) => `la description évoque un lot (${m[1]})`],
  [/^(.+) is a material the profile lists as printable$/, (m) => `${m[1]} est une matière que le profil classe comme imprimable`],
  [/^the supplier says it offers: (.+) \(a supplier claim, not yet seen\)$/, (m) => `le fournisseur dit proposer : ${m[1]} (déclaration du fournisseur, pas encore vue)`],
  [/^blocked by:? (.+)$/, (m, t) => `bloqué par : ${m[1].split(', ').map((c) => BLOCK_CODE_FR[c] ?? c).join(', ')}`],
  [/^Known dimensions = SUPPORTED \+ PARTIAL\..*$/, () => "Dimensions connues = OUI + EN PARTIE. PREUVES INSUFFISANTES quand moins de 5 dimensions sont connues ou moins de la moitié de celles qui s'appliquent. Sinon FAIBLE si 2 dimensions ou plus penchent CONTRE ou si moins d'un tiers des dimensions connues sont OUI ; ÉLEVÉ si aucune ne penche CONTRE et qu'au moins 70 % des connues sont OUI ; sinon MOYEN. Une règle de comptage sur les raisons listées, pas une prévision."],
  [/^two supplier statements differ for (.+)$/, (m) => `deux déclarations du fournisseur diffèrent pour ${m[1]}`],
  [/^two statements contradict each other$/, () => 'deux déclarations se contredisent'],
  [/^Earlier: (.+)\. Now: (.+)\. Which one is right\? Is one of them for a different case \(for example with your logo\)\?$/, (m) => `Avant : ${m[1]}. Maintenant : ${m[2]}. Laquelle est la bonne ? L'une des deux concerne-t-elle un autre cas (par exemple avec votre logo) ?`],
  [/^a certificate or test report is missing$/, () => 'un certificat ou un rapport d’essai manque'],
  [/^a sample lets you check the product before a deposit$/, () => 'un échantillon permet de vérifier le produit avant un acompte'],
  [/^the material decides compliance, printing and quality$/, () => 'la matière décide de la conformité, de l’impression et de la qualité'],
];
const RULES2 = [
  [/^(\d+) offer\(s\) are still unknown or in conflict: investigate them before concluding \(an unknown is not a defect\)$/, (m) => `${m[1]} ${PLURAL(m[1], 'offre est encore inconnue ou en conflit', 'offres sont encore inconnues ou en conflit')} : creusez-les avant de conclure (un inconnu n'est pas un défaut)`],
  [/^(.+?): (CONDITIONAL_GO|GO|NO_GO|INSUFFICIENT_INFORMATION|NEEDS_EXPERT_REVIEW) - blocked by (.+?) \((\d+) conditions?\)$/, (m) => `${m[1]} : ${VERDICT_FR[m[2]] ?? m[2]} — bloqué par ${m[3].split(', ').map((c) => BLOCK_CODE_FR[c] ?? c).join(', ')} (${m[4]} ${PLURAL(m[4], 'condition', 'conditions')})`],
  [/^(.+?): (CONDITIONAL_GO|GO|NO_GO|INSUFFICIENT_INFORMATION|NEEDS_EXPERT_REVIEW)$/, (m) => `${m[1]} : ${VERDICT_FR[m[2]] ?? m[2]}`],
  [/^(\d+) required documents?(?:\(s\))? missing or not usable, e\.g\. (.+)$/, (m, t) => `${m[1]} ${PLURAL(m[1], 'document exigé manque ou est inutilisable', 'documents exigés manquent ou sont inutilisables')}, par exemple : ${splitTop(m[2], '; ').map(t).join(' ; ')}`],
  [/^identification is LOW: (\d+) key trait\(s\) unresolved, no category$/, (m) => `identification faible : ${m[1]} caractéristiques clés non résolues, aucune catégorie`],
  [/^identification is (\w+): (\d+) key trait\(s\) unresolved(?:, (.+))?$/, (m) => `identification ${({ LOW: 'faible', MEDIUM: 'moyenne', HIGH: 'élevée' })[m[1]] ?? m[1]} : ${m[2]} caractéristiques clés non résolues`],
  [/^cannot decide yet whether these regimes apply: (.+)$/, (m) => `impossible de dire pour l'instant si ces régimes s'appliquent : ${m[1].split(', ').map((x) => REGIME_FR[x] ?? x).join(', ')}`],
  [/^critical cost input\(s\) unknown: (.+)$/, (m) => `données de coût critiques inconnues : ${m[1].split(', ').map((x) => ({ 'supplier.unitPrice': 'prix unitaire', 'costs.freight': 'transport', 'costs.customsDuty': 'droit de douane', 'costs.fx': 'taux de change' }[x] ?? x)).join(', ')}`],
  [/^whether you carry the manufacturer obligations is not decided yet.*$/, () => "il n'est pas encore décidé si vous portez les obligations du fabricant (marque propre, modification, reconditionnement, changement d'étiquette) : répondez aux questions de rôle"],
  [/^The price is (EXW|FOB|FCA|CFR|CIF|DAP|DDP): ask for an? (\w+) price too, so origin charges are visible and offers are comparable\.$/, (m) => `Le prix est ${m[1]} : demandez aussi un prix ${m[2]}, pour que les frais d'origine soient visibles et les offres comparables.`],
  [/^The sample costs ([\d.]+ \w+): ask to have it deducted from the first order\.$/, (m) => `L'échantillon coûte ${m[1]} : demandez à le déduire de la première commande.`],
  [/^there is no usable unit price on record$/, () => "aucun prix unitaire utilisable n'est enregistré"],
  [/^without it the landed cost cannot be completed$/, () => 'sans cela le coût rendu ne peut pas être complété'],
  [/^No Incoterm on record: it is not known which costs the price already includes\. The landed cost is incomplete\.$/, () => "Aucun Incoterm enregistré : on ne sait pas quels coûts le prix inclut déjà. Le coût rendu est incomplet."],
  [/^a supplier statement$/, () => 'une déclaration du fournisseur'],
  [/^([\d.]+ \w+) per unit$/, (m) => `${m[1]} par pièce`],
  [/^target margin$/, () => 'marge visée'], [/^landed-cost inputs \(freight, duty, FX\)$/, () => 'éléments du coût rendu (transport, douane, change)'], [/^selling price \(VAT included\)$/, () => 'prix de vente TTC'],
  [/^(?:the )?price tiers? do(?:es)? not cover this quantity \(or are ambiguous\)$/, () => 'les paliers de prix ne couvrent pas cette quantité (ou sont ambigus)'], [/^no unit price$/, () => 'pas de prix unitaire'],
  [/^(\d+(?:\.\d+)?) days$/, (m) => `${m[1]} jours`],
];
export const DOC_NAME_FR = Object.freeze({ CE: 'CE', UN383: 'UN 38.3', ROHS: 'RoHS', REACH: 'REACH', FCC: 'FCC', SDS: 'fiche de données de sécurité', IEC62133: 'IEC 62133', TEST_REPORT: "rapport d'essai" });
export const DOC_STATE_FR = Object.freeze({ CLAIMED: 'annoncé par le fournisseur', PROMISED: 'promis', NONE: 'aucun', NOT_AVAILABLE: 'indisponible', RECEIVED: 'reçu', MATCHED: 'reçu, au bon modèle', MISMATCH: 'reçu, mais pour un autre modèle' });
const REGIME_FR = { CE_FRAMEWORK: 'marquage CE (cadre général)', CE: 'marquage CE', LVD: 'basse tension (LVD)', EMC: 'compatibilité électromagnétique (CEM)', RED: 'équipements radio (RED)', BATTERIES: 'batteries', TOYS: 'jouets', FCM: 'contact alimentaire', COSMETICS: 'cosmétiques', PPE: 'équipements de protection (EPI)' };
const VERDICT_FR = { CONDITIONAL_GO: 'feu vert sous conditions', GO: 'feu vert', NO_GO: 'pas de feu vert', INSUFFICIENT_INFORMATION: 'informations insuffisantes', NEEDS_EXPERT_REVIEW: 'avis d’expert nécessaire' };
/** split at the top level only: commas and semicolons inside parentheses stay in their phrase */
function splitTop(str, sep) { const out = []; let depth = 0; let cur = ''; for (let i = 0; i < str.length; i += 1) { const ch = str[i]; if (ch === '(') depth += 1; if (ch === ')') depth = Math.max(0, depth - 1); if (!depth && str.startsWith(sep, i)) { out.push(cur); cur = ''; i += sep.length - 1; } else cur += ch; } out.push(cur); return out.map((x) => x.trim()).filter(Boolean); }
export const BLOCK_CODE_FR = Object.freeze({
  PRODUCT_IDENTITY_UNRESOLVED: 'produit non identifié', LEGAL_REQUIREMENT_UNRESOLVED: 'règles applicables non déterminées', CRITICAL_COST_UNKNOWN: 'coûts critiques inconnus', REQUIRED_DOCUMENT_MISSING: 'documents de conformité manquants', DOCUMENT_CONTRADICTS_CASE: 'document contraire au dossier',
  ROLE_UNRESOLVED: 'votre rôle (marque, modification) non décidé', PRODUCT_NOT_IDENTIFIED: 'modèle exact manquant', NO_PRICE: 'prix unitaire manquant', LANDED_UNKNOWN: 'coût rendu inconnu', OPEN_CONTRADICTION: 'contradiction ouverte',
});

/** French for ONE engine sentence (or a short phrase). Unknown text is returned unchanged. */
export function fr(text) {
  if (text === null || text === undefined) return text;
  const s = String(text).trim(); if (!s) return String(text);
  if (WORDS[s] !== undefined) return WORDS[s];
  for (const [rx, to] of DOC) if (rx.test(s)) return to;
  const t = (x) => fr(x);
  if (s.includes(' | ')) return splitTop(s, ' | ').map(fr).join(' | ');
  for (const [rx, fn] of [...RULES, ...RULES2]) { const m = rx.exec(s); if (m) return fn(m, t); }
  for (const [rx, fn] of [...RULES, ...RULES2]) { const m = rx.exec(`${s}.`); if (m) return fn(m, t).replace(/\.$/, ''); }
  if (splitTop(s, ' | ').length > 1) return splitTop(s, ' | ').map(fr).join(' | ');
  if (splitTop(s, ' · ').length > 1) return splitTop(s, ' · ').map(fr).join(' · ');
  if (splitTop(s, '; ').length > 1) return splitTop(s, '; ').map(fr).join(' ; ');
  const named = /^(.{1,60}?): (.+)$/.exec(s); if (named) { const r = fr(named[2]); if (r !== named[2]) return `${named[1]} : ${r}`; }
  const dot = /^(.+)\.$/.exec(s); if (dot) { const r = fr(dot[1]); if (r !== dot[1]) return `${r}.`; }
  return s;
}
export const frList = (arr, sep = ' · ') => (arr ?? []).map(fr).join(sep);
