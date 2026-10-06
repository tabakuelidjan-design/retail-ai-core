import { HUMAN_DECISION, SUBJECT_STATUS } from './constants.js';
import { decide } from './decision.js';
import { assertGateConfig, evaluateCooldown, selectPriorities } from './gates.js';
import { applyHumanDecision, applyResult, createLogEntry } from './ledger.js';
import { transitionSubject, triageSubject } from './subject.js';
import { SocleError, clone, deepFreeze, nonEmpty, toIso } from './util.js';

// In-memory, merchant-scoped store. Every method takes a merchantId and can
// only see that merchant's data. (A DB-backed store is documented, not built.)
export class SocleStore {
  #config;
  #tenants = new Map();
  #suppressed = new Map();

  constructor(config) {
    this.#config = assertGateConfig(config);
  }

  #tenant(merchantId) {
    const id = nonEmpty(merchantId, 'merchantId');
    if (!this.#tenants.has(id)) this.#tenants.set(id, { rules: null, subjects: new Map(), decisions: new Map(), log: new Map() });
    return this.#tenants.get(id);
  }

  setRuleSet(merchantId, ruleSet) {
    if (ruleSet.merchant_id !== merchantId) throw new SocleError('MERCHANT_MISMATCH', 'rule set belongs to another merchant');
    this.#tenant(merchantId).rules = ruleSet;
  }

  getRuleSet(merchantId) {
    return this.#tenant(merchantId).rules;
  }

  // Triage (Data Quality First) + cooldown. Re-detection of a dismissed Subject is suppressed unless aggravated.
  ingestSubject(merchantId, subject, now) {
    if (subject.merchant_id !== merchantId) throw new SocleError('MERCHANT_MISMATCH', 'subject belongs to another merchant');
    const t = this.#tenant(merchantId);
    const dismissed = [...t.subjects.values()].filter((s) => s.key === subject.key && s.status === SUBJECT_STATUS.DISMISSED && s.dismissal);
    const last = dismissed.sort((a, b) => (a.dismissal.dismissed_at < b.dismissal.dismissed_at ? 1 : -1))[0];
    if (last) {
      const cd = evaluateCooldown(last, subject, this.#config, now);
      if (cd.suppressed) {
        const k = `${merchantId}|${subject.key}`;
        this.#suppressed.set(k, (this.#suppressed.get(k) ?? 0) + 1);
        return { outcome: 'SUPPRESSED_COOLDOWN', reason: cd.reason, subject: null };
      }
    }
    const triaged = triageSubject(subject);
    t.subjects.set(triaged.id, triaged);
    return { outcome: 'ACCEPTED', reason: last ? 'reopened after cooldown/aggravation' : 'new subject', subject: triaged };
  }

  getSubject(merchantId, id) {
    return this.#tenant(merchantId).subjects.get(id);
  }

  listSubjects(merchantId) {
    return [...this.#tenant(merchantId).subjects.values()];
  }

  selectPriorities(merchantId) {
    return selectPriorities(this.listSubjects(merchantId), this.#config, merchantId);
  }

  dismissSubject(merchantId, subjectId, { reason, approver, now }) {
    const t = this.#tenant(merchantId);
    const s = t.subjects.get(subjectId);
    if (!s) throw new SocleError('NOT_FOUND', `subject ${subjectId}`);
    const dismissal = { dismissed_at: toIso(now, 'now'), materiality_at_dismissal: s.materiality, reason: nonEmpty(reason, 'reason'), approver: nonEmpty(approver, 'approver') };
    const next = transitionSubject(s, SUBJECT_STATUS.DISMISSED, { dismissal });
    t.subjects.set(s.id, next);
    return next;
  }

  suppressedCount(merchantId, key) {
    return this.#suppressed.get(`${merchantId}|${key}`) ?? 0;
  }

  decide(merchantId, subjectId, levers, now) {
    const t = this.#tenant(merchantId);
    const subject = t.subjects.get(subjectId);
    if (!subject) throw new SocleError('NOT_FOUND', `subject ${subjectId} (for this merchant)`);
    if (!t.rules) throw new SocleError('NO_RULES', 'no rule set for this merchant');
    const decision = decide({ subject, levers, ruleSet: t.rules, config: this.#config, now });
    t.decisions.set(decision.decision_id, decision);
    const entry = createLogEntry(decision, subject);
    t.log.set(entry.id, entry);
    return { decision, log_entry: entry };
  }

  recordHumanDecision(merchantId, entryId, input) {
    const t = this.#tenant(merchantId);
    const entry = t.log.get(entryId);
    if (!entry) throw new SocleError('NOT_FOUND', `log entry ${entryId} (for this merchant)`);
    const next = applyHumanDecision(entry, t.decisions.get(entry.decision_ref), input);
    t.log.set(entryId, next);
    const subject = t.subjects.get(entry.subject_id);
    const kind = next.human_decision.decision;
    if (kind === HUMAN_DECISION.REJECTED) {
      t.subjects.set(subject.id, transitionSubject(subject, SUBJECT_STATUS.DISMISSED, {
        dismissal: { dismissed_at: next.human_decision.decided_at, materiality_at_dismissal: subject.materiality, reason: next.human_decision.reason, approver: next.human_decision.approver },
      }));
    } else if (kind !== HUMAN_DECISION.DEFERRED) {
      t.subjects.set(subject.id, transitionSubject(subject, SUBJECT_STATUS.IN_PROGRESS));
    }
    return next;
  }

  recordResult(merchantId, entryId, input) {
    const t = this.#tenant(merchantId);
    const entry = t.log.get(entryId);
    if (!entry) throw new SocleError('NOT_FOUND', `log entry ${entryId} (for this merchant)`);
    const next = applyResult(entry, input);
    t.log.set(entryId, next);
    const subject = t.subjects.get(entry.subject_id);
    t.subjects.set(subject.id, transitionSubject(subject, SUBJECT_STATUS.RESULT));
    return next; // rules are untouched on purpose
  }

  getLog(merchantId) {
    return [...this.#tenant(merchantId).log.values()];
  }

  getLogEntry(merchantId, entryId) {
    return this.#tenant(merchantId).log.get(entryId);
  }

  snapshotRules(merchantId) {
    return deepFreeze(clone(this.#tenant(merchantId).rules));
  }
}
