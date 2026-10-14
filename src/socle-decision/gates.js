import { SUBJECT_STATUS } from './constants.js';
import { DAY_MS, SocleError, isNum, toIso } from './util.js';

// Materiality Gate, Attention Budget and Cooldown. Every threshold comes from
// configuration: no amount is hardcoded as a universal truth.
export function assertGateConfig(config) {
  const missing = [];
  if (!isNum(config?.materialityThreshold)) missing.push('materialityThreshold');
  if (typeof config?.currency !== 'string') missing.push('currency');
  if (!Number.isInteger(config?.maxPrioritySubjects) || config.maxPrioritySubjects < 0) missing.push('maxPrioritySubjects');
  if (!isNum(config?.cooldownDays)) missing.push('cooldownDays');
  if (!isNum(config?.aggravationFactor) || config.aggravationFactor < 1) missing.push('aggravationFactor');
  if (missing.length) throw new SocleError('INVALID_CONFIG', `gate config incomplete: ${missing.join(', ')}`);
  return config;
}

export function passesMateriality(subject, config) {
  assertGateConfig(config);
  if (subject.currency !== config.currency) {
    return { passes: false, reason: `CURRENCY_MISMATCH: subject ${subject.currency} vs threshold ${config.currency}` };
  }
  return subject.materiality >= config.materialityThreshold
    ? { passes: true, reason: `materiality ${subject.materiality} >= ${config.materialityThreshold}` }
    : { passes: false, reason: `BELOW_MATERIALITY: ${subject.materiality} < ${config.materialityThreshold}` };
}

const CANDIDATE_STATUSES = [SUBJECT_STATUS.TO_VERIFY, SUBJECT_STATUS.TO_DECIDE];

// One cycle: filter by materiality, rank by materiality (single explicit key),
// keep at most maxPrioritySubjects. Everything else is reported with a reason.
export function selectPriorities(subjects, config, merchantId) {
  assertGateConfig(config);
  const priority = [];
  const deferred = [];
  const below_materiality = [];
  const ineligible = [];
  const candidates = [];
  for (const s of subjects) {
    if (s.merchant_id !== merchantId) throw new SocleError('MERCHANT_MISMATCH', `subject ${s.id} belongs to another merchant`);
    if (!CANDIDATE_STATUSES.includes(s.status)) {
      ineligible.push({ subject_id: s.id, reason: `STATUS_${s.status}` });
      continue;
    }
    const m = passesMateriality(s, config);
    if (!m.passes) below_materiality.push({ subject_id: s.id, reason: m.reason });
    else candidates.push(s);
  }
  candidates.sort((a, b) => b.materiality - a.materiality || (a.detected_at < b.detected_at ? -1 : a.detected_at > b.detected_at ? 1 : 0) || (a.id < b.id ? -1 : 1));
  candidates.forEach((s, i) => {
    if (i < config.maxPrioritySubjects) priority.push(s);
    else deferred.push({ subject_id: s.id, reason: `ATTENTION_BUDGET_EXCEEDED (max ${config.maxPrioritySubjects})` });
  });
  return { priority, deferred, below_materiality, ineligible };
}

// A dismissed Subject must not come back immediately - unless it got worse.
export function evaluateCooldown(dismissed, candidate, config, now) {
  assertGateConfig(config);
  const elapsedDays = (new Date(toIso(now, 'now')).getTime() - new Date(dismissed.dismissal.dismissed_at).getTime()) / DAY_MS;
  if (elapsedDays >= config.cooldownDays) return { suppressed: false, reason: `cooldown over (${elapsedDays.toFixed(1)}d >= ${config.cooldownDays}d)` };
  const threshold = dismissed.dismissal.materiality_at_dismissal * config.aggravationFactor;
  if (candidate.materiality >= threshold) {
    return { suppressed: false, reason: `AGGRAVATED: materiality ${candidate.materiality} >= ${threshold} (x${config.aggravationFactor} of ${dismissed.dismissal.materiality_at_dismissal})` };
  }
  return { suppressed: true, reason: `IN_COOLDOWN: ${elapsedDays.toFixed(1)}d < ${config.cooldownDays}d and not aggravated (${candidate.materiality} < ${threshold})` };
}
