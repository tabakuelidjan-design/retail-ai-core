// Nordla Core - the first real path of the shared operating model, end to end:
//   ENTERPRISE (one merchant, from the server configuration) -> SUBJECT (a sourcing purchase, facts from the sourcing engine)
//   -> LEVERS (Buying & Suppliers + DO_NOTHING / TEST_SMALL) -> DECISION (Socle decide: eligibility, owner rules, Pareto, no score, no LLM)
//   -> HUMAN DECISION (a signed-in person with the required role; never a machine) -> FOLLOW-UP (measured result, NOT_MEASURABLE allowed).
// Everything is persisted in the hash-chained journal and rebuilt from it at start. Nordla executes NOTHING: an approved order is a
// plan recorded for the owner; no order, payment or message leaves Nordla.
import { HUMAN_DECISION, OUTCOME_RESULT, REQUIRED_APPROVAL, SUBJECT_STATUS, EVIDENCE_LEVEL } from '../socle-decision/constants.js';
import { SocleStore } from '../socle-decision/store.js';
import { createRuleSet } from '../socle-decision/rules.js';
import { buildSourcingPurchaseSubject, sourcingPurchaseLevers, SOURCING_PURCHASE, SOURCING_PURCHASE_PROFILE } from '../buying/sourcing-purchase.js';
import { SocleError } from '../socle-decision/util.js';
import { applyHumanDecision, applyResult } from '../socle-decision/ledger.js';
import { sourcingPurchaseFacts } from './sourcing-facts.js';

export class CoreError extends Error { constructor(code, message, status = 400) { super(message); this.name = 'CoreError'; this.code = code; this.status = status; } }

// Who may do what (policy enforced here, in code - not by a model). Roles are the identity layer's.
export const CAN_ANALYSE = Object.freeze(['OWNER', 'ADMIN', 'COLLABORATOR']);
const APPROVERS = Object.freeze({ [REQUIRED_APPROVAL.NONE]: ['OWNER', 'ADMIN', 'COLLABORATOR'], [REQUIRED_APPROVAL.MANAGER]: ['OWNER', 'ADMIN'], [REQUIRED_APPROVAL.OWNER]: ['OWNER'] });

/**
 * @param {{ merchantId: string, config: object, journal: ReturnType<import('./journal.js').createFileJournal>, now?: () => Date }} o
 * config = the merchant's core-decision.json (see config.js): gates, testSmall, ownerRules.
 */
export function createCoreRuntime({ merchantId, config, journal, now = () => new Date() }) {
  if (journal.merchantId !== merchantId) throw new CoreError('MERCHANT_MISMATCH', 'the journal belongs to another merchant', 500);
  const gate = { ...config.gates, currency: config.currency, ...(config.testSmall ? { testSmall: config.testSmall } : {}), profiles: { [SOURCING_PURCHASE]: SOURCING_PURCHASE_PROFILE } };
  const store = new SocleStore(gate);
  const decisions = new Map(); // decision id -> decision (needed to check a human decision)
  const meta = new Map(); // log entry id -> { case_id, case_version, assessment, analysed_by, analysed_at }
  let readyP = null;

  function applyAnalysed(p) {
    store.setRuleSet(merchantId, p.rule_set);
    const ing = store.ingestSubject(merchantId, p.subject, p.at);
    if (ing.outcome !== 'ACCEPTED') return null;
    const { decision, log_entry } = store.decide(merchantId, ing.subject.id, p.levers, p.at);
    decisions.set(decision.decision_id, decision);
    meta.set(log_entry.id, { case_id: p.case_id, case_version: p.subject.source_refs[0], assessment: p.assessment, analysed_at: p.at });
    return { subject: ing.subject, decision, log_entry };
  }
  function applyEvent(e) {
    const p = e.payload;
    if (e.kind === 'ANALYSED') {
      const r = applyAnalysed({ ...p, at: e.at });
      if (!r || r.decision.decision_id !== p.decision_id) throw new CoreError('JOURNAL_REPLAY_MISMATCH', `line ${e.seq}: the decision does not replay identically`, 500);
      meta.get(r.log_entry.id).analysed_by = e.actor;
    } else if (e.kind === 'HUMAN_DECISION') store.recordHumanDecision(merchantId, p.entry_id, p.input);
    else if (e.kind === 'RESULT') store.recordResult(merchantId, p.entry_id, p.input);
    else throw new CoreError('JOURNAL_UNKNOWN_EVENT', `line ${e.seq}: unknown event ${e.kind}`, 500);
  }
  const ready = () => (readyP ??= journal.all().then((evs) => { for (const e of evs) applyEvent(e); return true; }));

  const ruleSet = () => createRuleSet(merchantId, config.ownerRules ?? []);
  const entries = () => store.getLog(merchantId);
  const view = (entry) => {
    if (!entry) return null;
    const subject = store.getSubject(merchantId, entry.subject_id);
    return { entry, subject, source: meta.get(entry.id) ?? null };
  };

  /** Analyses one sourcing case (as held by the server). Same case version + still open => the existing analysis (idempotent). */
  async function analyseCase(state, { externals = {}, actor }) {
    await ready();
    if (!CAN_ANALYSE.includes(actor?.role)) throw new CoreError('ROLE_NOT_ALLOWED', 'votre rôle ne permet pas de lancer une analyse', 403);
    const at = now().toISOString();
    const { input, scenarios, assessment } = sourcingPurchaseFacts(state, { merchantId, now: new Date(at), externals });
    const subject = buildSourcingPurchaseSubject(input);
    const open = entries().find((e) => meta.get(e.id)?.case_id === state.id && meta.get(e.id)?.case_version === subject.source_refs[0] && !e.human_decision);
    if (open) return { status: 'UNCHANGED', ...view(open) };
    const levers = sourcingPurchaseLevers(subject, scenarios);
    const rs = ruleSet();
    // dry run on a copy of the inputs: only a decision that can be built is journaled
    const probe = new SocleStore(gate); probe.setRuleSet(merchantId, rs); const ing = probe.ingestSubject(merchantId, subject, at);
    if (ing.outcome !== 'ACCEPTED') return { status: 'SUPPRESSED', reason: ing.reason };
    let decision; try { ({ decision } = probe.decide(merchantId, ing.subject.id, levers, at)); } catch (err) { throw socle(err); }
    const e = await journal.append({ kind: 'ANALYSED', at, actor: actorRef(actor), payload: { case_id: state.id, subject, levers, rule_set: rs, assessment, decision_id: decision.decision_id } });
    applyEvent(e);
    return { status: 'ANALYSED', decision, ...view(entries().find((x) => x.decision_ref === decision.decision_id)) };
  }

  function requiredApproval(entry, chosen) {
    const ids = chosen.length ? chosen : entry.recommendation?.lever_ids ?? [];
    const order = [REQUIRED_APPROVAL.NONE, REQUIRED_APPROVAL.MANAGER, REQUIRED_APPROVAL.OWNER];
    // an option not found among the remaining ones (a combination) needs the owner: the strictest level is the default
    return ids.reduce((m, id) => { const l = entry.options.remaining.find((r) => r.lever_id === id); const need = l?.required_approval ?? REQUIRED_APPROVAL.OWNER; return order.indexOf(need) > order.indexOf(m) ? need : m; }, REQUIRED_APPROVAL.NONE);
  }

  /** The human decision. Approver = the signed-in person; the role must be allowed for the chosen option's required approval. */
  async function decideHuman(entryId, body, actor) {
    await ready();
    const entry = store.getLogEntry(merchantId, entryId); if (!entry) throw new CoreError('NOT_FOUND', 'décision introuvable', 404);
    const kind = body?.decision;
    if (!Object.values(HUMAN_DECISION).includes(kind)) throw new CoreError('INVALID_DECISION', 'décision : APPROVED, APPROVED_ALTERNATIVE, REJECTED ou DEFERRED');
    const chosen = kind === HUMAN_DECISION.APPROVED_ALTERNATIVE ? (Array.isArray(body.chosen_lever_ids) ? body.chosen_lever_ids.map(String) : []) : [];
    if ([HUMAN_DECISION.APPROVED, HUMAN_DECISION.APPROVED_ALTERNATIVE].includes(kind)) {
      const need = requiredApproval(entry, chosen);
      if (!APPROVERS[need].includes(actor?.role)) throw new CoreError('APPROVAL_ROLE_REQUIRED', `cette option demande l’approbation ${need === 'OWNER' ? 'du propriétaire' : 'd’un responsable'}`, 403);
    } else if (!CAN_ANALYSE.includes(actor?.role)) throw new CoreError('ROLE_NOT_ALLOWED', 'votre rôle ne permet pas de décider', 403);
    const subject = store.getSubject(merchantId, entry.subject_id);
    if (![SUBJECT_STATUS.TO_DECIDE, SUBJECT_STATUS.TO_VERIFY].includes(subject.status)) throw new CoreError('INVALID_STATE', 'ce sujet n’attend plus de décision', 409);
    const at = now().toISOString();
    const input = { decision: kind, reason: String(body.reason ?? '').trim(), approver: actorRef(actor).label, decided_at: at, chosen_lever_ids: chosen, planned_actions: [], next_review_at: body.next_review_at || null };
    try { applyHumanDecision(entry, decisions.get(entry.decision_ref), input); } catch (e) { throw socle(e); } // pure check first: a refused input never reaches the journal
    applyEvent(await journal.append({ kind: 'HUMAN_DECISION', at, actor: actorRef(actor), payload: { entry_id: entryId, input } }));
    return view(store.getLogEntry(merchantId, entryId));
  }

  /** Follow-up: the measured result of an approved decision. NOT_MEASURABLE / UNKNOWN are legitimate. A result never becomes a rule. */
  async function recordResult(entryId, body, actor) {
    await ready();
    if (!CAN_ANALYSE.includes(actor?.role)) throw new CoreError('ROLE_NOT_ALLOWED', 'votre rôle ne permet pas d’enregistrer un suivi', 403);
    const entry = store.getLogEntry(merchantId, entryId); if (!entry) throw new CoreError('NOT_FOUND', 'décision introuvable', 404);
    if (entry.result) throw new CoreError('ALREADY_MEASURED', 'un résultat est déjà enregistré pour cette décision', 409);
    if (!Object.values(OUTCOME_RESULT).includes(body?.result)) throw new CoreError('INVALID_RESULT', 'résultat : CONFIRMED, SUGGESTIVE, REFUTED, NOT_MEASURABLE ou UNKNOWN');
    const at = now().toISOString();
    const unmeasured = [OUTCOME_RESULT.NOT_MEASURABLE, OUTCOME_RESULT.UNKNOWN].includes(body.result);
    const input = { result: body.result, evidence_level: unmeasured ? EVIDENCE_LEVEL.NONE : body.evidence_level, measured_at: at, notes: String(body.notes ?? '').slice(0, 2000) };
    try { applyResult(entry, input); } catch (e) { throw socle(e); }
    applyEvent(await journal.append({ kind: 'RESULT', at, actor: actorRef(actor), payload: { entry_id: entryId, input } }));
    return view(store.getLogEntry(merchantId, entryId));
  }
  const socle = (e) => (e instanceof SocleError ? new CoreError(e.code, e.message.replace(/^[A-Z_]+: /, ''), 409) : e);

  async function overview() {
    await ready();
    const list = entries().map(view).sort((a, b) => (a.entry.created_at < b.entry.created_at ? 1 : -1));
    return {
      merchant_id: merchantId,
      owner_rules: (config.ownerRules ?? []).length ? 'CONFIGURED' : 'NOT_CONFIGURED',
      awaiting_human: list.filter((v) => !v.entry.human_decision && v.entry.recommendation).length,
      in_follow_up: list.filter((v) => v.entry.human_decision && [HUMAN_DECISION.APPROVED, HUMAN_DECISION.APPROVED_ALTERNATIVE].includes(v.entry.human_decision.decision) && !v.entry.result).length,
      journal_head: await journal.head(),
      decisions: list,
    };
  }

  return {
    merchantId, ready, overview, analyseCase,
    decideHuman, recordResult,
    entry: async (id) => { await ready(); return view(store.getLogEntry(merchantId, id)); },
    forCase: async (caseId) => { await ready(); return entries().filter((e) => meta.get(e.id)?.case_id === caseId).map(view); },
  };
}

/** What the journal records about a person: their user id and role (no e-mail, no name). A local PC server has no identity: it says so. */
export function actorRef(actor) {
  if (actor?.userId) return { label: `user:${actor.userId}`, user_id: actor.userId, role: actor.role, auth: 'NORDLA_SESSION' };
  return { label: String(actor?.label ?? '').trim() || 'local-owner', user_id: null, role: actor?.role ?? null, auth: 'LOCAL_TOKEN' };
}
