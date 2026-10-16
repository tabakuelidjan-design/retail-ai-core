// Parle à Nordla (TEXT) on the Core server. Deterministic: the integration router decides WHERE a sentence goes; the answer is built by
// code from what this server really holds (the sourcing cases, the Core decision journal). No model, no invented figure: every number
// quoted comes with its source (case + version, or journal entry), and what is not connected here is said so, with the reason.
// Asking never executes anything; at most it runs the Core analysis of the open case (a recommendation, journaled, no action).
import { routeUtterance, STATUS } from '../integration/router.js';
import { MODULE as M } from '../integration/constants.js';
import { sourcingPurchaseFacts } from './sourcing-facts.js';
import { payablesAnswer, purchasesAnswer, salesAnswer, treasuryAnswer } from './answers.js';
import { recognizeFieldIntent, isActionRequest, INTENT_LABEL } from './field-intents.js';
import { buildFieldSnapshot, showVerdict } from './field-facts.js';
import { buildFieldAnswer } from './field-answers.js';
import { followUpIntent, stepConversation } from './field-context.js';
import { procurementAnswer } from './procurement-answers.js';

const norm = (s) => String(s ?? '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim();
const eur = (v) => (Number.isFinite(v) ? `${v.toFixed(2).replace('.', ',')} €` : 'inconnu');

// What is NOT connected to this server, and why (said as is, never hidden behind a vague error).
export const NOT_CONNECTED = Object.freeze({
  [M.FINANCE]: 'Finance n’est pas encore relié au Core : ses données restent dans le service Finance (connexion propre). Aucun chiffre Finance n’est donné ici.',
  [M.ANALYTICS]: 'Analyses n’est pas encore relié au Core : aucune vente ni tendance n’est lue ici. Aucun chiffre de ventes n’est donné.',
  [M.STOCK_SALES]: 'Le stock n’est pas relié au Core : aucune quantité en stock n’est lue ici.',
  [M.MARKETING]: 'Marketing et Création ne sont pas reliés au Core pour l’instant (prévu après la Chine).',
  [M.CREATIVE]: 'Marketing et Création ne sont pas reliés au Core pour l’instant (prévu après la Chine).',
});
export const CAN_DO = ['« qu’est-ce qui manque ? », « quels risques ? », « quelle est la marge ? », « quelle prochaine étape ? » (dossier ouvert)', '« quelles factures fournisseurs dois-je payer ? » (Finance)', '« ma trésorerie » (Finance)', '« mes achats du mois » (Finance)', '« comment évoluent mes ventes ? » (Analytics)', '« résume ce dossier » (dossier ouvert)', '« dois-je acheter ce produit ? » (analyse Core du dossier ouvert)', '« décisions en attente »', '« suivi des décisions »'];
const AVAILABLE = new Set([M.CHINA_SOURCING]);

const decisionLine = (v) => `• ${v.subject?.title ?? v.entry.subject.title} : ${v.entry.recommendation ? `recommandé « ${v.entry.recommendation.label} »` : 'à vérifier (données manquantes)'}${v.entry.human_decision ? ` — décidé : ${v.entry.human_decision.decision}` : ''}`;
const decisionSource = (v) => ({ kind: 'core_journal', ref: v.entry.id, case: v.source?.case_id ?? null, at: v.entry.created_at });

/**
 * @param {{ text: string, caseId?: string|null }} q
 * @param {{ runtime: object|null, getCase: (id)=>Promise<object|null>, externals?: object, actor: object, now?: Date }} ctx
 */
export async function askNordla({ text, caseId = null }, { runtime, getCase, externals = {}, actor, now = new Date(), finance = null, analytics = null, procurement = null, conversation }) {
  const t = norm(text);
  if (!t) return { status: 'ASK', answer: 'Posez votre question par écrit.', sources: [], limits: [] };
  const limits = [];

  // ---- an order to ACT is refused out loud: Nordla answers, it never orders, pays, sends, approves, records or erases anything
  if (isActionRequest(text)) return { status: 'ACTION_REFUSED', answer: 'Je ne peux pas faire cela : Nordla répond aux questions mais ne commande, ne paie, n’envoie, n’approuve, n’enregistre ni n’efface rien (ni dossier, ni blocage, ni journal). Les décisions se valident par vous (Valider / Rejeter dans le Core) et les achats se font hors de Nordla. Je peux en revanche vous dire ce qui manque, les risques ou la prochaine vérification.', sources: [], limits };

  // ---- Core questions (the decision journal)
  if (/(decision|decide|valider|approuv).*(attente|attend|en cours|a prendre|dois prendre|a valider|approbation)|(en attente|a valider).*(decision)/.test(t)) {
    if (!runtime) return notConfigured();
    const o = await runtime.overview(); const list = o.decisions.filter((v) => !v.entry.human_decision && v.entry.recommendation);
    return { status: 'ANSWERED', answer: list.length ? `${list.length} décision(s) attendent votre validation :\n${list.map(decisionLine).join('\n')}` : 'Aucune décision n’attend votre validation.', sources: list.map(decisionSource), limits };
  }
  if (/\bsuivi(e|s|es)?\b|follow.?up|resultat.*(decision|achat)/.test(t)) {
    if (!runtime) return notConfigured();
    const o = await runtime.overview(); const list = o.decisions.filter((v) => v.entry.human_decision);
    return { status: 'ANSWERED', answer: list.length ? `Décisions prises et leur suivi :\n${list.map((v) => `${decisionLine(v)}${v.entry.result ? ` — résultat : ${v.entry.result.result}` : ' — résultat pas encore enregistré'}`).join('\n')}` : 'Aucune décision n’a encore été prise.', sources: list.map(decisionSource), limits };
  }
  // ---- which modules are connected here (said as is, from the same table the "not connected" answers use)
  if (/\bmodules?\b|raccord|connect/.test(t) && /\bquel|liste|disponible|\bwhich\b|\bwhat\b|\betat\b|statut/.test(t) && !/(facture|vente|tresorerie|dossier|fournisseur)/.test(t)) {
    const off = Object.values(NOT_CONNECTED).filter((v, i, a) => a.indexOf(v) === i);
    return { status: 'ANSWERED', answer: ['Relié à ce serveur : China Sourcing (dossiers fournisseurs) et le journal de décisions du Core.', 'Pas encore relié :', ...off.map((o) => `• ${o}`)].join(String.fromCharCode(10)), sources: [], limits: off };
  }
  // ---- Stock / Achats (read-only tools over the persistent procurement store); without it, the router below says the stock is NOT connected
  if (procurement) { const pa = await procurementAnswer(text, procurement); if (pa) return pa; }

  // ---- field questions on the open case (what is known / missing / risky, margin, next check, why this recommendation): read-only, no journal entry, no Finance / Analytics reading
  const scope = { merchantId: runtime?.merchantId ?? 'local', caseId };
  let fi = recognizeFieldIntent(text);
  if (fi.status === 'UNKNOWN' && caseId) { const f = followUpIntent(text, conversation, scope); if (f) fi = { intent: f, status: 'RECOGNISED' }; } // elliptical follow-up, same merchant + same case only
  if (fi.status === 'AMBIGUOUS') {
    const opts = fi.reason === 'EQUAL_SCORE' ? fi.candidates.map((c) => INTENT_LABEL[c]).filter(Boolean) : null;
    return { status: 'ASK', answer: opts ? `Je peux répondre sur : ${opts.join(' ; ')}. Laquelle voulez-vous ?` : 'Parlez-vous du dossier ouvert (fournisseur, produit, devis) ou de chiffres Finance / Analyses (factures, trésorerie, ventes) ? Précisez, je ne devine pas.', sources: [], limits };
  }
  if (fi.status === 'RECOGNISED') {
    const c = caseId ? await getCase(caseId) : null;
    if (!c) return { status: 'ASK', answer: caseId ? 'Ce dossier n’est pas encore sur le serveur : synchronisez-le d’abord.' : 'Quel dossier ? Ouvrez-le d’abord.', sources: [], limits };
    const snap = buildFieldSnapshot(c, { merchantId: runtime?.merchantId ?? 'local', now, externals });
    const extra = {};
    if (runtime) {
      extra.ownerRules = (await runtime.overview()).owner_rules;
      if (fi.intent === 'EXPLAIN_RECOMMENDATION') extra.entryView = (await runtime.forCase(c.id)).sort((a, b) => (a.entry.created_at < b.entry.created_at ? 1 : -1))[0] ?? null;
    }
    const out = buildFieldAnswer(fi.intent, snap, extra);
    if (conversation !== undefined) { // opt-in: the caller owns the state (ids and intents only); nothing is stored here
      const step = stepConversation(conversation, { merchantId: scope.merchantId, caseId: c.id, caseVersion: snap.source.version, intent: fi.intent, sources: out.sources, now });
      out.conversation = step.conversation; if (step.notice) { out.notice = step.notice; out.answer = `${step.notice}
${out.answer}`; }
    }
    return out;
  }
  // ---- Finance (read-only reader over Finance's own engines) and Analytics (its Tool Layer); without a reader: said NOT connected
  const notConnected = (mod) => ({ status: 'MODULE_NOT_CONNECTED', module: mod, answer: NOT_CONNECTED[mod], sources: [], limits: [NOT_CONNECTED[mod]] });
  if (/(factur|invoice)/.test(t) && /(fournisseur|supplier)/.test(t) && /(pay|regl|echean|due|doi|ouvert|reste)/.test(t) || /(echeanc|a payer|payables)/.test(t)) return finance ? payablesAnswer(await finance.payables()) : notConnected(M.FINANCE);
  if (/(tresorerie|liquidit|solde bancaire|position de caisse|\bcash\b)/.test(t)) return finance ? treasuryAnswer(await finance.treasury()) : notConnected(M.FINANCE);
  if (/(depense|achats? (du|de ce|ce) mois|combien.*(achete|depense))/.test(t)) {
    if (!finance) return notConnected(M.FINANCE);
    const today = finance.today(); return purchasesAnswer(await finance.purchases({ from: `${today.slice(0, 8)}01`, to: today }));
  }
  if (/(vente|ventes|chiffre d.affaires|\bca\b|sales|performance)/.test(t) && !/(prix de vente|selling price)/.test(t)) return analytics ? salesAnswer(await analytics.salesEvolution()) : notConnected(M.ANALYTICS);

  if (/(dois.?je|faut.?il|devrais.?je|peut.?on|should i).*(achet|command|buy|order)|(analys).*(dossier|produit|achat)/.test(t)) {
    if (!runtime) return notConfigured();
    const c = caseId ? await getCase(caseId) : null;
    if (!c) return { status: 'ASK', answer: caseId ? 'Ce dossier n’est pas encore sur le serveur : synchronisez-le d’abord.' : 'Quel dossier ? Ouvrez-le d’abord.', sources: [], limits };
    const r = await runtime.analyseCase(c, { externals, actor });
    if (r.status === 'SUPPRESSED') return { status: 'ANSWERED', answer: `Sujet mis de côté récemment (${r.reason}).`, sources: [], limits };
    const e = r.entry; const facts = Object.fromEntries(r.subject.facts.map((f) => [f.key, f.value]));
    const lines = [
      e.recommendation ? `Recommandation Nordla Core : « ${e.recommendation.label} » (${e.recommendation.kind}).` : 'Nordla Core ne recommande rien : des données bloquantes manquent.',
      ...(e.recommendation?.rationale ?? []).map((x) => `Pourquoi : ${x}`),
      ...e.options.eliminated.filter((x) => x.stage !== 'RELEVANCE').map((x) => `Écarté : ${x.label} — ${x.reasons.join(' ; ')}`),
      `Faits : verdict sourcing ${showVerdict(sourcingPurchaseFacts(c, { merchantId: runtime.merchantId, now, externals }).assessment.verdictDisplay)}, coût rendu total ${eur(facts.landed_total)}, marge unitaire ${eur(facts.contribution_per_unit)}, prix de vente ${facts.price_basis ?? 'inconnu'}.`,
      ...r.subject.missing_data.map((m) => `Manque : ${m.field} — ${m.reason}`),
      'Rien n’est commandé ni payé par Nordla : c’est à vous de décider (bouton Valider / Rejeter).',
    ];
    return { status: 'ANSWERED', answer: lines.join('\n'), sources: [{ kind: 'sourcing_case', ref: c.id, version: c.updatedAt ?? null }, decisionSource({ entry: e, source: r.source })], limits, decision: { entry_id: e.id } };
  }

  // ---- everything else: the integration router decides which module it belongs to
  const routed = routeUtterance(text, { active: caseId ? { module: M.CHINA_SOURCING, entities: {} } : undefined, available: (m) => AVAILABLE.has(m) });
  const off = (routed.route ?? []).find((s) => !AVAILABLE.has(s.module));
  if (routed.status === STATUS.MODULE_NOT_AVAILABLE || off) {
    const mod = routed.module ?? off.module;
    return { status: 'MODULE_NOT_CONNECTED', module: mod, answer: NOT_CONNECTED[mod] ?? `${mod} n’est pas relié à ce serveur.`, sources: [], limits: [NOT_CONNECTED[mod] ?? mod] };
  }
  if (routed.status === STATUS.ROUTED && routed.route.some((s) => s.module === M.CHINA_SOURCING && s.command === 'summarize_case')) {
    const c = caseId ? await getCase(caseId) : null;
    if (!c) return { status: 'ASK', answer: caseId ? 'Ce dossier n’est pas encore sur le serveur : synchronisez-le d’abord.' : 'Quel dossier ? Ouvrez-le d’abord.', sources: [], limits };
    const { input, assessment } = sourcingPurchaseFacts(c, { merchantId: runtime?.merchantId ?? 'local', now, externals });
    const lines = [
      `${input.product_name || c.id} — verdict ${showVerdict(assessment.verdictDisplay)}.`,
      assessment.nextAction ? `Prochaine étape : ${assessment.nextAction}` : null,
      `Coût rendu : ${eur(input.landed_per_unit)} / unité, ${eur(input.landed_total)} au total pour ${input.quote_qty ?? '?'} unités.`,
      `Marge unitaire : ${eur(input.contribution_per_unit)} (prix de vente ${input.price_basis ?? 'inconnu'}).`,
      ...assessment.hardBlockers.map((b) => `Blocage : ${b.detail}`),
    ].filter(Boolean);
    return { status: 'ANSWERED', answer: lines.join('\n'), sources: [{ kind: 'sourcing_case', ref: c.id, version: c.updatedAt ?? null }], limits };
  }
  if (routed.status === STATUS.ASK) return { status: 'ASK', answer: routed.question, sources: [], limits };
  return { status: 'NOT_UNDERSTOOD', answer: `Je ne sais pas encore répondre à cela ici. Je sais : ${CAN_DO.join(', ')}.`, sources: [], limits: Object.values(NOT_CONNECTED).filter((v, i, a) => a.indexOf(v) === i) };
}

function notConfigured() {
  return { status: 'CORE_NOT_CONFIGURED', answer: 'Nordla Core n’est pas configuré sur ce serveur (core-decision.json du marchand absent) : aucune décision n’est proposée.', sources: [], limits: ['CORE_NOT_CONFIGURED'] };
}
