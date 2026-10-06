// Phrases for the conversation engine: French reading texts for the owner, the review state of every Chinese sentence, the suggested commercial questions and the fixed clarification sentences.
// RULES: a Chinese sentence is never presented as certified. NATIVE_REVIEWED = checked by a native speaker (none yet); TECHNICAL_ONLY = the V0 phrasebook, checked technically but awaiting a native
// reader; UNREVIEWED = written for V1 and not checked by anyone fluent; MACHINE = produced by a translation provider; UNAVAILABLE = there is no Chinese for this text and none is invented.
// A critical phrasebook MUST be validated by a native speaker before real commercial use. The origin market is a PROFILE (language + phrasebook), so another origin can be added later.
export const REVIEW = Object.freeze({ NATIVE_REVIEWED: 'NATIVE_REVIEWED', TECHNICAL_ONLY: 'TECHNICAL_ONLY', UNREVIEWED: 'UNREVIEWED', MACHINE: 'MACHINE', UNAVAILABLE: 'UNAVAILABLE' });

/** Origin-market profiles: the language the SUPPLIER reads and which phrasebook applies. Only China exists today; nothing here is China-specific code. */
export const MARKET_PROFILES = Object.freeze({ CN: { id: 'CN', label: 'China', supplierLang: 'zh', phrasebook: 'cn' } });
export const DEFAULT_PROFILE = MARKET_PROFILES.CN;

/** Sentences a native speaker has approved: sentence id -> { by, at }. EMPTY today: nothing is certified. Adding an entry here (after a real review, see docs/CHINA-SOURCING-PHRASEBOOK-REVIEW.md) is the ONLY way a sentence becomes NATIVE_REVIEWED. */
export const NATIVE_REVIEW = Object.freeze({});
export const reviewFor = (sentenceId, base) => (NATIVE_REVIEW[sentenceId] ? REVIEW.NATIVE_REVIEWED : base);

const DOC_FR = { EU_DOC: 'la déclaration UE de conformité (DoC)', TEST_REPORT: "le rapport d'essai complet d'un laboratoire accrédité (ISO/IEC 17025)", CERTIFICATE: 'le certificat', SDS: 'la fiche de données de sécurité (FDS / SDS)', UN383: "le rapport d'essai UN 38.3 de la batterie", BATTERY_DOC: 'le rapport de sécurité de la batterie (par exemple IEC 62133)', ROHS_EVIDENCE: "le rapport d'essai RoHS", REACH_EVIDENCE: 'le rapport ou la déclaration REACH / SVHC', FCM_DOC: 'la déclaration de conformité contact alimentaire', MATERIAL_DECL: 'la déclaration de matériaux', LABEL_ARTWORK: "le visuel de l'étiquette", PACKAGING_ARTWORK: "le visuel de l'emballage", MANUAL: "la notice d'utilisation" };
export const docNameFr = (docType) => DOC_FR[docType] ?? 'le document demandé';

/** French reading text of a V0 question. Params come from the case (model, quantity, document type, regulation reference). */
const FR = {
  model: () => "Quel est le numéro de modèle exact (référence) de ce produit ?",
  manufacturer: () => "Quel est le nom légal et l'adresse complète de l'usine qui fabrique ce produit ?",
  brand: () => 'Allez-vous vendre ce produit sous votre propre nom ou marque ?',
  eu_party: () => "Avez-vous un représentant autorisé ou un importateur dans l'UE pour ce produit ? Nom et adresse, s'il vous plaît.",
  price: (p) => `Quel est votre prix unitaire pour ${p.qty ? `${p.qty} pièces` : 'la quantité qui nous intéresse'}, et quel est le MOQ (quantité minimale) ?`,
  incoterm: () => "Sur quel Incoterm le prix est-il basé (EXW, FOB, CIF, DDP…) et depuis quel port ?",
  lead_time: () => 'Quel est le délai de production, et quelles sont les conditions de paiement ?',
  carton: () => 'Quelles sont les dimensions du carton, son poids brut et le nombre de pièces par carton ?',
  battery: () => 'Le produit contient-il une batterie ? Type (lithium-ion / lithium-polymère / autre), capacité en Wh et mAh, amovible ou non ?',
  radio: () => 'Le produit a-t-il le Bluetooth, le Wi-Fi ou une autre fonction radio ? Quel module et quelles fréquences ?',
  voltage: () => "Quelles sont la tension et l'intensité nominales d'entrée et de sortie du produit ?",
  mains: () => 'Le produit se branche-t-il directement sur le secteur (230 V) ?',
  children: () => "Pour quel âge le produit est-il conçu ? Est-il destiné aux enfants de moins de 14 ans ou au jeu ?",
  food: () => 'Le produit est-il destiné au contact avec des aliments ou des boissons ? Quels matériaux touchent l\'aliment ?',
  materials: () => 'En quelles matières est fait le produit (matière principale, revêtement, peinture, colorant) ?',
  cosmetic: () => "Est-ce un cosmétique ou un produit de soin ? Envoyez la liste complète des ingrédients (INCI).",
  medical: () => 'Le fournisseur revendique-t-il un usage médical ou thérapeutique pour ce produit ?',
  hs: () => 'Quel code SH utilisez-vous pour exporter ce produit depuis la Chine ?',
  sample: () => "Pouvez-vous envoyer un échantillon avant la commande ? Quel coût et quel délai ?",
  doc: (p) => `Pouvez-vous m'envoyer ${docNameFr(p.docType)} pour le modèle ${p.model}${p.refs ? `, citant ${p.refs}` : ''} ?`,
  doc_fix: (p) => `Le document « ${docNameFr(p.docType).replace(/^(la|le|l')\s?/, '')} » que vous avez envoyé ne correspond pas au modèle ${p.model} : merci d'envoyer le bon document pour ce modèle.`,
  own_brand_docs: () => "Si nous vendons sous notre propre marque, il nous faut le dossier technique complet, des rapports d'essai à notre nom ou couvrant notre modèle, et votre accord pour fournir des documents mis à jour. Est-ce possible ?",
  modification_effect: () => 'Si nous modifions le produit (conception, matériaux, firmware, batterie, accessoires), quels changements peuvent affecter sa sécurité ou sa conformité ? Donnez-nous les détails de conception.',
  label_change: () => "Nous prévoyons de changer les étiquettes ou la notice. Quelles informations de sécurité, avertissements et marquages doivent rester inchangés, et qui valide le nouveau texte ?",
  repackage_name: () => "Nous prévoyons de reconditionner le produit. Les marquages d'origine, le numéro de modèle et les coordonnées du fabricant peuvent-ils rester visibles sur le nouvel emballage ?",
  quality_inspection: () => "Acceptez-vous une inspection avant expédition par un tiers avant le paiement du solde ?",
};
export const templateOf = (id) => (id.startsWith('doc:') ? (id.endsWith(':fix') ? 'doc_fix' : 'doc') : id);
export function frText(id, params = {}) { const t = FR[templateOf(id)]; return t ? t(params) : null; }

/** Suggested commercial questions (not generated by V0). zh is UNREVIEWED: written for V1, to be validated by a native speaker before real use. */
export const SUGGESTED = Object.freeze({
  colours: { dimension: 'COMMERCIAL', priority: 'P3', resolves: ['variant.colours', 'variant.colourCount'], fr: 'Quelles couleurs sont disponibles pour ce modèle ?', en: 'Which colours are available for this model?', zh: '请问这款产品有哪些颜色可选?' },
  mixed_colours: { dimension: 'COMMERCIAL', priority: 'P3', resolves: ['moq.mixedColours', 'moq.perColour'], fr: 'Peut-on mélanger les couleurs dans la quantité minimale ? Quel minimum par couleur ?', en: 'Can colours be mixed within the MOQ? What is the minimum per colour?', zh: '不同颜色可以混批吗?每个颜色的最小起订量是多少?' },
  logo: { dimension: 'COMMERCIAL', priority: 'P2', resolves: ['quote.moq@custom_logo'], fr: 'Nous voulons notre logo : quel est le MOQ avec logo personnalisé, le surcoût et le délai ?', en: 'We want our own logo: what is the MOQ with custom logo, the extra cost and the lead time?', zh: '我们想印自己的 Logo。请问定制 Logo 的最小起订量(MOQ)、额外费用和交期是多少?' },
  packaging: { dimension: 'COMMERCIAL', priority: 'P2', resolves: ['quote.moq@custom_packaging'], fr: "Peut-on personnaliser l'emballage ? Quel MOQ et quel surcoût ?", en: 'Can the packaging be customised? What MOQ and extra cost?', zh: '请问可以定制包装吗?定制包装的最小起订量和额外费用是多少?' },
  price_tiers: { dimension: 'COMMERCIAL', priority: 'P2', resolves: ['quote.tiers'], fr: 'Pouvez-vous donner les prix par palier de quantité (par exemple 100, 300 et 500 pièces) ?', en: 'Can you give the price for different quantity tiers (for example 100, 300 and 500 pieces)?', zh: '请报出不同订购数量(例如 100、300、500 件)的阶梯单价。' },
  payment: { dimension: 'COMMERCIAL', priority: 'P2', resolves: ['payment.depositPct', 'payment.balancePct'], fr: 'Quelles sont les conditions de paiement : acompte, solde, et quand le solde est-il dû ?', en: 'What are the payment terms: deposit, balance, and when is the balance due?', zh: '请问付款方式是什么?定金比例是多少?尾款什么时候付(发货前还是见提单副本后)?' },
});

/** Fixed clarification sentences for a contradiction: UNREVIEWED Chinese with the two values inserted verbatim. null when no sentence exists for that fact. */
const CONFLICT_FR = { 'quote.moq': (o, n) => `Tout à l'heure le MOQ était ${o}, maintenant ${n}. Lequel est le bon ? L'un des deux concerne-t-il un autre cas (par exemple avec logo) ?`, 'quote.unitPrice': (o, n) => `Le prix était ${o}, maintenant ${n}. Lequel est correct, et pour quelle quantité ?`, 'quote.incoterm': (o, n) => `L'Incoterm était ${o}, maintenant ${n}. Lequel retenons-nous, et depuis quel port ?`, 'quote.leadTime': (o, n) => `Le délai était de ${o} jours, maintenant ${n}. Lequel est le bon ?`, 'payment.depositPct': (o, n) => `L'acompte était de ${o} %, maintenant ${n} %. Lequel est le bon ?`, 'identifier.model': (o, n) => `Le modèle était ${o}, maintenant ${n}. À quel modèle exact correspond cette offre ?` };
const CONFLICT_ZH = { 'quote.moq': (o, n) => `您之前说起订量是 ${o},现在说是 ${n}。请问哪个是对的?是否针对不同的情况(例如加 Logo)?`, 'quote.unitPrice': (o, n) => `您之前的报价是 ${o},现在是 ${n}。请问哪个价格是正确的?对应的订购数量是多少?`, 'quote.incoterm': (o, n) => `您之前说贸易条款是 ${o},现在是 ${n}。请确认最终使用哪一种,以及装运港。`, 'quote.leadTime': (o, n) => `交期之前是 ${o} 天,现在是 ${n} 天。请确认。`, 'payment.depositPct': (o, n) => `定金之前是 ${o}%,现在是 ${n}%。请确认。`, 'identifier.model': (o, n) => `您之前说型号是 ${o},现在说是 ${n}。请问这个报价对应的准确型号是哪一个?` };
export function conflictPhrases(conflict) {
  const [o, n] = conflict.entries.map((e) => (typeof e.value === 'object' ? JSON.stringify(e.value) : String(e.value))); const k = conflict.key;
  if (k.startsWith('docClaim.')) { const d = k.slice(9) === 'UN383' ? 'UN 38.3' : k.slice(9); return { fr: `Vous aviez compris que le fournisseur avait ${d}, et maintenant il dit le contraire (ou l'inverse). A-t-il, oui ou non, ${d} ?`, en: `The supplier's statement about ${d} changed. Do they have ${d} or not?`, zh: `您之前和现在关于 ${d} 的说法不一致。请确认是否有 ${d}。`, review: REVIEW.UNREVIEWED }; }
  const fr = CONFLICT_FR[k]?.(o, n) ?? `Avant : ${o}. Maintenant : ${n}. Lequel est le bon ?`;
  const zh = CONFLICT_ZH[k]?.(o, n) ?? null;
  return { fr, en: conflict.question?.en ?? `Earlier: ${o}. Now: ${n}. Which one is right?`, zh, review: zh ? REVIEW.UNREVIEWED : REVIEW.UNAVAILABLE };
}

/** Why a question matters, and a short label, in French (V0 reasons are English-only). */
const REASON_FR = { model: 'Sans le modèle exact, rien ne peut être rattaché à ce produit.', manufacturer: "Le fabricant légal doit figurer sur les documents et les étiquettes.", eu_party: "Un représentant ou un importateur dans l'UE est nécessaire pour vendre ce produit.", price: "Sans prix ni MOQ, aucun calcul n'est possible.", incoterm: "L'Incoterm décide des coûts déjà inclus dans le prix.", carton: 'Les dimensions du carton servent à estimer le transport.', lead_time: 'Le délai et le paiement sont nécessaires avant de vous engager.', sample: 'Un échantillon permet de vérifier le produit avant un acompte.', hs: 'Le code SH du fournisseur est un indice pour la classification douanière.', quality_inspection: "Un document incohérent justifie une inspection avant le paiement du solde.", own_brand_docs: 'Sous votre marque, vous portez les obligations du fabricant.', modification_effect: 'Modifier le produit peut changer sa conformité.', label_change: "Changer l'étiquette peut changer la conformité.", repackage_name: "Un nouvel emballage doit garder les marquages d'origine." };
const SHORT_FR = { model: 'modèle', manufacturer: 'fabricant', eu_party: 'représentant UE', price: 'prix et MOQ', incoterm: 'Incoterm', carton: 'carton', lead_time: 'délai', sample: 'échantillon', hs: 'code SH', 'docs-bundle': 'documents', 'u:brand': 'votre marque', 'u:freight': 'transport', 'u:duty': 'droits de douane', 'u:fx': 'taux de change', 'u:sellingPrice': 'prix de vente', 'u:margin': 'marge', 's:colours': 'couleurs', 's:mixed_colours': 'mélange de couleurs', 's:logo': 'logo', 's:packaging': 'emballage', 's:price_tiers': 'prix par palier', 's:payment': 'paiement' };
export function reasonFr(id) { return id.startsWith('doc:') ? "Sans ce document, aucune commande n'est possible." : REASON_FR[id] ?? 'Information utile pour évaluer ce produit.'; }
export function shortFr(id) { return SHORT_FR[id] ?? (id.startsWith('doc:') ? 'document' : id.startsWith('conflict:') ? 'contradiction' : id.startsWith('u:trait:') ? 'confirmation' : 'question'); }
