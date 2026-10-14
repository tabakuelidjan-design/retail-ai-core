// INFORMATION NEEDS (pure, deterministic, explainable). Nordla is not a questionnaire: it holds a catalogue of information NEEDS - DATA with PREDICATES, not product-specific code - and ranks the ones that
// are worth asking NOW. Nothing here is a list of questions per category.
//
//   PRODUCT HYPOTHESIS + TRAITS (core/product-hypothesis.js) + KNOWN FACTS + MISSING INFORMATION + CONTRADICTIONS + RULE APPLICABILITY (core/rules-engine.js) + MARKET IDENTITY + CONVERSATION CONTEXT
//        -> a need APPLIES / is NOT_APPLICABLE / is UNKNOWN (three-valued, the same predicate language as the rules)
//        -> a score made of NAMED PARTS (each with a reason) -> ONE best next question
//
// A need says: what it is (dimension), when it applies (appliesWhen over TRAITS and the case context - never "if category == X"), what resolves it, what it unlocks, how much it matters for the decision, for
// the money, for the regulatory picture, and the question that gets it. The regulatory pictures are NOT duplicated here: needs READ rules-engine results (an unresolved rule that reads a trait makes the question about
// that trait valuable; an applicable rule with missing evidence makes the document request valuable).
//
// UNKNOWN is not NOT_APPLICABLE. An unknown trait can be the most valuable thing to ask first (it unlocks or eliminates several rules and needs): that "dependency unlock" is a scored part.
// Market evidence (core/market-search.js) is another input: an exact model number that would let Nordla tell the supplier's product from a probable Belgian match is worth asking. No LLM chooses anything here.
import { traitEnv } from './identity.js';
import { evaluate, readsOf } from './predicate.js';
import { TOPIC } from './topics.js';

export const DIMENSION = Object.freeze({ IDENTITY: 'IDENTITY', SPECIFICATION: 'SPECIFICATION', COMMERCIAL: 'COMMERCIAL', ECONOMIC: 'ECONOMIC', MARKETABILITY: 'MARKETABILITY', ROLE: 'ROLE', CONFLICT: 'CONFLICT' });
const T = TOPIC; const D = DIMENSION;
const yes = (trait) => ({ trait, is: true }); const no = (trait) => ({ trait, is: false });

/**
 * The catalogue. `ids` are the question ids the P5 engine already produces for this need (their text, Chinese phrasebook and review states stay where they are); `own` is a question the need
 * brings itself (French + English; Chinese stays UNAVAILABLE until a reviewed phrase exists). Scores: decision 0-5, economic 0-3, uncertainty 0-3 (see `explainScore`).
 */
export const NEEDS = Object.freeze([
  // ---- identity ------------------------------------------------------------------------------------------------------------------------------------------------------------------------
  { id: 'model', ids: ['model'], dimension: D.IDENTITY, topic: T.IDENTITY, appliesWhen: { always: true }, decision: 5, economic: 1, uncertainty: 3, marketIdentity: 'model', reason: { fr: 'Sans le modèle exact, rien ne peut être rattaché à ce produit ni comparé au marché.', en: 'Without the exact model nothing can be tied to this product or compared with the market.' } },
  { id: 'manufacturer', ids: ['manufacturer'], dimension: D.IDENTITY, topic: T.IDENTITY, appliesWhen: { always: true }, decision: 4, economic: 0, uncertainty: 2, reason: { fr: 'Le fabricant légal doit figurer sur les documents et les étiquettes.', en: 'The legal manufacturer must appear on documents and labels.' } },
  // discriminating traits: asked only while the trait is UNKNOWN; the value is what the answer unlocks or eliminates
  { id: 'battery', ids: ['battery'], dimension: D.IDENTITY, topic: T.IDENTITY, appliesWhen: { always: true }, discriminating: 'battery.present', decision: 2, economic: 0, uncertainty: 2, regulatory: { viaTrait: ['battery.present'] }, reason: { fr: 'Savoir s’il y a une batterie débloque ou écarte plusieurs règles (batteries, transport, CEM...).', en: 'Knowing whether there is a battery unlocks or removes several rules.' } },
  { id: 'radio', ids: ['radio'], dimension: D.IDENTITY, topic: T.IDENTITY, appliesWhen: { always: true }, discriminating: 'radio.present', decision: 2, economic: 0, uncertainty: 2, regulatory: { viaTrait: ['radio.present'] }, reason: { fr: 'Une fonction radio (Bluetooth, Wi-Fi) fait appliquer la directive RED.', en: 'A radio function brings the RED directive in.' } },
  { id: 'voltage', ids: ['voltage'], dimension: D.IDENTITY, topic: T.IDENTITY, appliesWhen: { always: true }, discriminating: 'electrical.present', decision: 2, economic: 0, uncertainty: 2, regulatory: { viaTrait: ['electrical.present', 'electrical.maxVoltageDc', 'electrical.maxVoltageAc'] }, reason: { fr: 'Les tensions décident de la directive basse tension et de la CEM.', en: 'Voltages decide the Low Voltage and EMC directives.' } },
  { id: 'mains', ids: ['mains'], dimension: D.IDENTITY, topic: T.IDENTITY, appliesWhen: yes('electrical.present'), discriminating: 'electrical.mainsConnected', decision: 1, economic: 0, uncertainty: 1, regulatory: { viaTrait: ['electrical.mainsConnected'] }, reason: { fr: 'Le raccordement au secteur décide de la directive basse tension.', en: 'A mains connection decides the Low Voltage Directive.' } },
  { id: 'children', ids: ['children'], dimension: D.IDENTITY, topic: T.IDENTITY, appliesWhen: { always: true }, discriminating: 'childrenUse', decision: 2, economic: 0, uncertainty: 2, regulatory: { viaTrait: ['childrenUse', 'toy'] }, reason: { fr: 'Un usage par des enfants fait appliquer les règles jouets.', en: 'Use by children brings the toy rules in.' } },
  { id: 'food', ids: ['food'], dimension: D.IDENTITY, topic: T.IDENTITY, appliesWhen: { always: true }, discriminating: 'foodContact', decision: 2, economic: 0, uncertainty: 2, regulatory: { viaTrait: ['foodContact'] }, reason: { fr: 'Un contact alimentaire impose des matériaux et des preuves spécifiques.', en: 'Food contact requires specific materials and evidence.' } },
  { id: 'materials', ids: ['materials'], dimension: D.IDENTITY, topic: T.IDENTITY, appliesWhen: { always: true }, discriminating: 'textile', decision: 2, economic: 0, uncertainty: 1, regulatory: { viaTrait: ['textile', 'chemicalMixture', 'ppe'] }, reason: { fr: 'La matière décide du textile, de REACH et des équipements de protection.', en: 'The material decides textile, REACH and protective-equipment rules.' } },
  { id: 'cosmetic', ids: ['cosmetic'], dimension: D.IDENTITY, topic: T.IDENTITY, appliesWhen: { always: true }, discriminating: 'cosmetic', decision: 2, economic: 0, uncertainty: 1, regulatory: { viaTrait: ['cosmetic'] }, reason: { fr: 'Un cosmétique relève d’un règlement entièrement différent.', en: 'A cosmetic falls under a different regulation altogether.' } },
  { id: 'medical', ids: ['medical'], dimension: D.IDENTITY, topic: T.IDENTITY, appliesWhen: { always: true }, discriminating: 'medical', decision: 2, economic: 0, uncertainty: 1, regulatory: { viaTrait: ['medical'] }, reason: { fr: 'Une revendication médicale change le cadre réglementaire.', en: 'A medical claim changes the regulatory frame.' } },
  // ---- product-specific specification needs (own questions): they exist only where the TRAITS say they matter ----------------------------------------------------------------------------
  { id: 'capacity_battery', own: { id: 'need:capacity_battery', fr: 'Quelle est la capacité nominale de la batterie (mAh et Wh) ? Est-ce la capacité réelle mesurée dans vos propres tests ?', en: 'What is the rated battery capacity (mAh and Wh)? Is that the real capacity measured in your own tests?', resolves: ['spec.capacity@mah', 'spec.capacity@wh'] },
    dimension: D.SPECIFICATION, topic: T.IDENTITY, appliesWhen: { all: [yes('battery.present'), yes('capacity.relevant')] }, decision: 4, economic: 1, uncertainty: 2, regulatory: { viaRule: ['transport.lithium', 'eu.batteries'] },
    reason: { fr: 'La capacité (Wh) décide du transport des batteries au lithium et de ce que vous achetez réellement.', en: 'The capacity (Wh) decides lithium-battery transport and what you are really buying.' } },
  { id: 'capacity_volume', own: { id: 'need:capacity_volume', fr: 'Quelle est la contenance exacte (ml) ?', en: 'What is the exact capacity (ml)?', resolves: ['spec.capacity@volume'] },
    dimension: D.SPECIFICATION, topic: T.IDENTITY, appliesWhen: { all: [yes('capacity.relevant'), { not: yes('battery.present') }] }, decision: 2, economic: 1, uncertainty: 2,
    reason: { fr: 'La contenance définit le produit vendu et son prix.', en: 'The capacity defines the product sold and its price.' } },
  { id: 'compat_models', own: { id: 'need:compat_models', fr: 'Pour quels modèles exacts d’appareils ce produit est-il compatible (marque, modèle, taille) ?', en: 'Which exact device models is this compatible with (brand, model, size)?', resolves: ['spec.compatibility'] },
    dimension: D.SPECIFICATION, topic: T.IDENTITY, appliesWhen: yes('compatibility.required'), decision: 4, economic: 2, uncertainty: 3,
    reason: { fr: 'Le prix, le MOQ et les moules dépendent souvent du modèle d’appareil visé.', en: 'Price, MOQ and tooling often depend on the target device model.' } },
  { id: 'contact_material', own: { id: 'need:contact_material', fr: 'Quel matériau touche l’aliment ou la boisson (qualité, revêtement) ? Avez-vous un rapport d’essai de contact alimentaire ?', en: 'Which material touches the food or drink (grade, coating)? Do you have a food-contact test report?', resolves: ['spec.material'] },
    dimension: D.SPECIFICATION, topic: T.IDENTITY, appliesWhen: yes('foodContact'), decision: 4, economic: 0, uncertainty: 3, regulatory: { viaRule: ['eu.fcm', 'fcm.material'] },
    reason: { fr: 'Le matériau en contact avec l’aliment décide de la conformité et des essais exigés.', en: 'The food-contact material decides conformity and the tests required.' } },
  { id: 'age_range', own: { id: 'need:age_range', fr: 'Pour quelle tranche d’âge le produit est-il conçu, et pour quelles normes de sécurité jouet avez-vous des rapports d’essai ?', en: 'What age range is it designed for, and for which toy-safety standards do you have test reports?', resolves: ['spec.ageRange'] },
    dimension: D.SPECIFICATION, topic: T.IDENTITY, appliesWhen: yes('childrenUse'), decision: 4, economic: 0, uncertainty: 3, regulatory: { viaRule: ['eu.toys'] },
    reason: { fr: 'L’âge visé décide des exigences de sécurité jouet et des avertissements.', en: 'The target age decides toy-safety requirements and warnings.' } },
  // ---- role / marketability -------------------------------------------------------------------------------------------------------------------------------------------------------------
  { id: 'eu_party', ids: ['eu_party', 'modification_effect', 'label_change', 'repackage_name', 'own_brand_docs'], dimension: D.ROLE, topic: T.COMPLIANCE, appliesWhen: { always: true }, decision: 3, economic: 0, uncertainty: 2, regulatory: { viaRole: true }, reason: { fr: 'Un représentant ou importateur UE est nécessaire pour vendre en Europe.', en: 'An EU representative or importer is needed to sell in Europe.' } },
  { id: 'docs', ids: ['docs-bundle'], idPrefixes: ['doc:'], requires: ['model'], dimension: D.MARKETABILITY, topic: T.DOCUMENTS, appliesWhen: { always: true }, decision: 4, economic: 0, uncertainty: 1, regulatory: { viaDocs: true }, reason: { fr: 'Sans ces documents, aucune commande n’est possible.', en: 'Without these documents no order is possible.' } },
  // ---- commercial / economic ------------------------------------------------------------------------------------------------------------------------------------------------------------
  { id: 'price', ids: ['price'], dimension: D.COMMERCIAL, topic: T.PRICE, appliesWhen: { always: true }, decision: 3, economic: 3, uncertainty: 2, reason: { fr: 'Sans prix ni MOQ, aucun coût rendu ni aucune marge ne peut être calculé.', en: 'Without price and MOQ no landed cost or margin can be computed.' } },
  // the owner's own numbers (transport, duty, exchange rate, selling price, margin): the engine only raises them when they BLOCK the next action, so they carry the weight of a blocker
  { id: 'owner_blockers', idPrefixes: ['u:freight', 'u:duty', 'u:fx', 'u:sellingPrice', 'u:margin'], dimension: D.ECONOMIC, topic: T.OTHER, appliesWhen: { always: true }, decision: 5, economic: 3, uncertainty: 0, reason: { fr: 'Cette information vous appartient et bloque le calcul du coût rendu ou de la marge.', en: 'This is yours to provide and blocks the landed cost or margin calculation.' } },
  { id: 'incoterm', ids: ['incoterm'], dimension: D.ECONOMIC, topic: T.LOGISTICS, appliesWhen: { always: true }, decision: 3, economic: 2, uncertainty: 2, dependsOnMe: [], reason: { fr: 'L’Incoterm décide des coûts déjà inclus dans le prix.', en: 'The Incoterm decides which costs are already in the price.' } },
  { id: 'lead_time', ids: ['lead_time'], dimension: D.COMMERCIAL, topic: T.LEADTIME, appliesWhen: { always: true }, decision: 2, economic: 1, uncertainty: 1, reason: { fr: 'Délai et paiement sont nécessaires avant de s’engager.', en: 'Lead time and payment terms are needed before committing.' } },
  { id: 'carton', ids: ['carton'], dimension: D.ECONOMIC, topic: T.LOGISTICS, appliesWhen: { always: true }, decision: 2, economic: 2, uncertainty: 1, reason: { fr: 'Les données du carton servent à estimer le transport.', en: 'Carton data is needed to estimate freight.' } },
  { id: 'sample', ids: ['sample', 'quality_inspection'], dimension: D.COMMERCIAL, topic: T.OTHER, appliesWhen: { always: true }, decision: 2, economic: 0, uncertainty: 1, reason: { fr: 'Un échantillon permet de vérifier le produit avant tout acompte.', en: 'A sample lets you check the product before a deposit.' } },
  { id: 'hs', ids: ['hs'], dimension: D.ECONOMIC, topic: T.OTHER, appliesWhen: { always: true }, decision: 1, economic: 1, uncertainty: 1, reason: { fr: 'Le code SH exporté est un indice pour le droit de douane.', en: 'The exported HS code is a hint for the customs duty.' } },
  { id: 'price_tiers', ids: ['s:price_tiers'], dimension: D.ECONOMIC, topic: T.PRICE, appliesWhen: { always: true }, dependsOn: ['price'], decision: 2, economic: 3, uncertainty: 1, reason: { fr: 'Les paliers de prix permettent de choisir la quantité rentable.', en: 'Price tiers let you choose the profitable quantity.' } },
  { id: 'payment', ids: ['s:payment'], dimension: D.COMMERCIAL, topic: T.PAYMENT, appliesWhen: { always: true }, decision: 2, economic: 1, uncertainty: 1, reason: { fr: 'Les conditions de paiement décident du risque avant livraison.', en: 'Payment terms decide the risk before delivery.' } },
  { id: 'colours', ids: ['s:colours', 's:mixed_colours'], dimension: D.COMMERCIAL, topic: T.COLOURS, appliesWhen: { always: true }, decision: 1, economic: 1, uncertainty: 1, reason: { fr: 'Les couleurs et leur mélange influencent le MOQ réel.', en: 'Colours and mixing influence the real MOQ.' } },
  { id: 'customisation', ids: ['s:logo', 's:packaging'], dimension: D.COMMERCIAL, topic: T.CUSTOMISATION, appliesWhen: { any: [{ ctx: 'ownBrand', is: true }, yes('customisable')] }, decision: 2, economic: 2, uncertainty: 2, reason: { fr: 'Le logo ou l’emballage personnalisé change le MOQ, le prix et le délai.', en: 'A custom logo or packaging changes MOQ, price and lead time.' } },
]);

const BY_ID = new Map(); for (const n of NEEDS) for (const id of [...(n.ids ?? []), ...(n.own ? [n.own.id] : [])]) BY_ID.set(id, n);
export const needOfQuestion = (qid) => BY_ID.get(qid) ?? NEEDS.find((n) => (n.idPrefixes ?? []).some((p) => String(qid).startsWith(p))) ?? null;

const PTS = Object.freeze({ DECISION: 8, ECONOMIC: 6, UNCERTAINTY: 3, TRAIT_RULE: 5, TRAIT_RULE_HIGH: 7, TRAIT_RULE_CAP: 25, UNLOCK_NEED: 3, UNLOCK_NEED_CAP: 9, DOC_RULE: 6, DOC_CAP: 30, RULE_APPLIES: 5, RULE_UNRESOLVED: 3, RULE_CAP: 10, ROLE: 10, DEPENDENCY: 5, DEPENDENCY_CAP: 10, FIT: 10, INTERRUPT: -4, REPEAT: -20, PREMATURE: -20, MARKET_IDENTITY: 10, CONTRADICTION: 100 });

/** The environment a predicate reads: the product's traits (best evidence, unknown = null) and the case context. */
export function needsEnv(st, A) { return traitEnv(st.identity, { ...(st.context ?? {}), role: A?.role?.roles ?? [], ownBrand: A?.role?.ownBrand ?? null }); }

/** Applicability of a need over the current traits: true / false / null (unknown). */
export const applicabilityOf = (need, env) => evaluate(need.appliesWhen, env);

/** The own questions of the needs that APPLY now (a need whose applicability is UNKNOWN is not asked: only the trait-discriminating needs, below, handle unknowns). */
export function needQuestions(st, A) {
  const env = needsEnv(st, A); const out = [];
  for (const n of NEEDS) if (n.own && applicabilityOf(n, env) === true) out.push({ needId: n.id, id: n.own.id, dimension: n.dimension, text: { fr: n.own.fr, en: n.own.en }, resolves: n.own.resolves, reason: n.reason, priority: 'P2', topic: n.topic });
  return out;
}

const fam = (rs) => [...new Set(rs.map((r) => r.family ?? r.ruleId))].slice(0, 4).join(', ');
function regulatoryParts(need, rules, env, needsAll) {
  const parts = []; const res = rules?.results ?? []; const reg = need.regulatory; if (!reg) return parts;
  if (reg.viaTrait) {
    const reads = reg.viaTrait.map((t) => `trait:${t}`);
    const hit = res.filter((r) => r.status === 'UNRESOLVED' && (r.unknownReads ?? []).some((x) => reads.includes(x)));
    if (hit.length) { const pts = Math.min(PTS.TRAIT_RULE_CAP, hit.reduce((a, r) => a + (r.severity === 'HIGH' ? PTS.TRAIT_RULE_HIGH : PTS.TRAIT_RULE), 0)); parts.push({ code: 'REGULATORY_UNLOCK', pts, fr: `lève l’incertitude sur ${hit.length} règle${hit.length > 1 ? 's' : ''} réglementaire${hit.length > 1 ? 's' : ''} (${fam(hit)})`, en: `resolves uncertainty on ${hit.length} regulatory rule${hit.length > 1 ? 's' : ''} (${fam(hit)})` }); }
    const dep = needsAll.filter((n) => n.id !== need.id && n.own && applicabilityOf(n, env) === null && [...readsOf(n.appliesWhen)].some((x) => reads.includes(x)));
    if (dep.length) parts.push({ code: 'UNLOCKS_NEEDS', pts: Math.min(PTS.UNLOCK_NEED_CAP, dep.length * PTS.UNLOCK_NEED), fr: `débloque ${dep.length} autre${dep.length > 1 ? 's' : ''} besoin${dep.length > 1 ? 's' : ''} d’information`, en: `unlocks ${dep.length} other information need${dep.length > 1 ? 's' : ''}` });
  }
  if (reg.viaDocs) {
    const hit = res.filter((r) => r.status === 'APPLIES' && (r.missingEvidence ?? []).some((m) => m.requirement === 'REQUIRED'));
    if (hit.length) parts.push({ code: 'REGULATORY_EVIDENCE', pts: Math.min(PTS.DOC_CAP, hit.length * PTS.DOC_RULE), fr: `${hit.length} règle${hit.length > 1 ? 's' : ''} applicable${hit.length > 1 ? 's' : ''} sans preuve (${fam(hit)})`, en: `${hit.length} applicable rule${hit.length > 1 ? 's' : ''} with missing evidence (${fam(hit)})` });
  }
  if (reg.viaRule) {
    const hit = res.filter((r) => reg.viaRule.includes(r.ruleId) && r.status !== 'NOT_APPLICABLE'); const pts = hit.reduce((a, r) => a + (r.status === 'APPLIES' ? PTS.RULE_APPLIES : PTS.RULE_UNRESOLVED), 0);
    if (pts) parts.push({ code: 'REGULATORY_LINK', pts: Math.min(PTS.RULE_CAP, pts), fr: `touche ${hit.length} règle${hit.length > 1 ? 's' : ''} liée${hit.length > 1 ? 's' : ''} (${fam(hit)})`, en: `touches ${hit.length} linked rule${hit.length > 1 ? 's' : ''} (${fam(hit)})` });
  }
  if (reg.viaRole && (rules?.__roleUnresolved ?? 0) > 0) parts.push({ code: 'ROLE_UNRESOLVED', pts: PTS.ROLE, fr: 'votre rôle d’opérateur dans l’UE n’est pas établi', en: 'your EU operator role is not established' });
  return parts;
}

/**
 * Scores every ACTIVE supplier question and returns the explanation. A question that belongs to a need which is NOT_APPLICABLE is excluded (state NOT_APPLICABLE). `questions` are the engine's questions with
 * their states; `topicId` is the current conversation topic; `market` (optional) says what is missing to tell the supplier's product from a market match.
 * @returns {{ items: object[], byQuestion: Map<string, object>, notApplicable: object[] }}
 */
export function rankNeeds({ st, A, questions, topicId = 'OTHER', market = null }) {
  const env = needsEnv(st, A); const rules = A?.rules ? { ...A.rules, __roleUnresolved: (A.role?.unresolved ?? []).length } : null;
  const active = (q) => ['OPEN', 'UNANSWERED'].includes(q.state) && (q.audience === 'SUPPLIER' || !!needOfQuestion(q.id));
  const open = questions.filter(active); const openNeedIds = new Set(open.map((q) => needOfQuestion(q.id)?.id).filter(Boolean));
  const byQuestion = new Map(); const items = []; const notApplicable = [];
  for (const q of questions) {
    if (q.source === 'USER_FREE') continue;
    if (q.source === 'CONFLICT') { if (active(q)) { const it = { questionId: q.id, needId: `conflict`, dimension: D.CONFLICT, applicability: 'APPLIES', score: PTS.CONTRADICTION, parts: [{ code: 'CONTRADICTION', pts: PTS.CONTRADICTION, fr: 'deux informations se contredisent : à trancher avant d’aller plus loin', en: 'two pieces of information contradict each other: settle it before going further' }] }; byQuestion.set(q.id, it); items.push(it); } continue; }
    const need = needOfQuestion(q.id);
    if (!need) { if (active(q)) { const base = { P1: 3, P2: 2, P3: 1 }[q.priority] ?? 1; const it = { questionId: q.id, needId: null, dimension: q.dimension ?? D.COMMERCIAL, applicability: 'APPLIES', score: base * PTS.DECISION, parts: [{ code: 'DECISION', pts: base * PTS.DECISION, fr: `priorité ${q.priority} du moteur de questions`, en: `${q.priority} priority of the question engine` }] }; byQuestion.set(q.id, it); items.push(it); } continue; }
    const app = applicabilityOf(need, env); const applicability = app === true ? 'APPLIES' : app === false ? 'NOT_APPLICABLE' : 'UNKNOWN';
    if (applicability === 'NOT_APPLICABLE') { const it = { questionId: q.id, needId: need.id, dimension: need.dimension, applicability, score: null, parts: [], why: { fr: `Non applicable : ${[...readsOf(need.appliesWhen)].join(', ')} l’exclut.`, en: `Not applicable: ${[...readsOf(need.appliesWhen)].join(', ')} excludes it.` } }; byQuestion.set(q.id, it); notApplicable.push(it); continue; }
    if (!active(q)) continue;
    const parts = [];
    parts.push({ code: 'DECISION', pts: need.decision * PTS.DECISION, fr: `importance pour la décision d’achat : ${need.decision}/5`, en: `importance for the purchase decision: ${need.decision}/5` });
    if (need.economic) parts.push({ code: 'ECONOMIC', pts: need.economic * PTS.ECONOMIC, fr: `impact économique (prix, coût rendu, marge) : ${need.economic}/3`, en: `economic impact (price, landed cost, margin): ${need.economic}/3` });
    if (need.uncertainty) parts.push({ code: 'UNCERTAINTY', pts: need.uncertainty * PTS.UNCERTAINTY, fr: 'on ne sait encore rien à ce sujet', en: 'nothing is known about this yet' });
    parts.push(...regulatoryParts(need, rules, env, NEEDS));
    const dependents = NEEDS.filter((n) => (n.dependsOn ?? []).includes(need.id) && openNeedIds.has(n.id)); if (dependents.length) parts.push({ code: 'DEPENDENCY_UNLOCK', pts: Math.min(PTS.DEPENDENCY_CAP, dependents.length * PTS.DEPENDENCY), fr: 'nécessaire avant de pouvoir poser d’autres questions', en: 'needed before other questions can be asked' });
    if (market?.missing?.includes(need.marketIdentity)) parts.push({ code: 'MARKET_IDENTITY', pts: PTS.MARKET_IDENTITY, fr: 'permet de distinguer ce produit d’un produit probablement vendu en Europe', en: 'lets Nordla tell this product from one probably sold in Europe' });
    if (topicId && topicId !== 'OTHER') parts.push(need.topic === topicId ? { code: 'CONVERSATION_FIT', pts: PTS.FIT, fr: 'colle au sujet dont on parle', en: 'fits the subject being discussed' } : { code: 'INTERRUPTION', pts: PTS.INTERRUPT, fr: 'changerait de sujet en pleine conversation', en: 'would change the subject mid-conversation' });
    for (const r of need.requires ?? []) if (openNeedIds.has(r)) parts.push({ code: 'PREMATURE', pts: PTS.PREMATURE, fr: `à demander après « ${r === 'model' ? 'le modèle' : r} », sur lequel cette question s’appuie`, en: `better asked after “${r}”, which this question builds on` });
    if (q.repeat) parts.push({ code: 'REPEAT', pts: PTS.REPEAT, fr: 'déjà demandé sans réponse claire', en: 'already asked without a clear answer' });
    if (applicability === 'UNKNOWN' && !need.discriminating) { const it = { questionId: q.id, needId: need.id, dimension: need.dimension, applicability, score: null, parts: [], why: { fr: 'Applicabilité inconnue : pas demandé tant que les caractéristiques du produit ne la précisent pas.', en: 'Applicability unknown: not asked until the product traits settle it.' } }; byQuestion.set(q.id, it); continue; }
    const score = parts.reduce((a, p) => a + p.pts, 0); const top = [...parts].filter((p) => p.pts > 0).sort((a, b) => b.pts - a.pts).slice(0, 2);
    const it = { questionId: q.id, needId: need.id, dimension: need.dimension, applicability, discriminating: need.discriminating ?? null, score, parts, why: { fr: `${need.reason.fr} (${top.map((p) => p.fr).join(' ; ')})`, en: `${need.reason.en} (${top.map((p) => p.en).join('; ')})` } };
    byQuestion.set(q.id, it); items.push(it);
  }
  items.sort((a, b) => b.score - a.score || (a.questionId < b.questionId ? -1 : 1));
  return { items, byQuestion, notApplicable };
}

/** For the Expert view: why is this question asked now, and what was set aside. */
export function explainRanking(ranking, limit = 8) {
  return { asked: ranking.items.slice(0, limit).map((i) => ({ questionId: i.questionId, need: i.needId, dimension: i.dimension, score: i.score, why: i.why ?? null, parts: i.parts })), setAside: ranking.notApplicable.map((i) => ({ questionId: i.questionId, need: i.needId, why: i.why })) };
}
