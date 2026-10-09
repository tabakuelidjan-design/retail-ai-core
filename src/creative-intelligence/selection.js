// Candidate selection V1: HARD GATES only.
//
//   recompute each candidate's preflight from its own document + the explicit context -> remove every FAIL -> expose the rest.
//
// There is no winner, no score, no ranking and no tie-break by taste: the exposed candidates are listed in candidate_id order (an
// arbitrary but stable order, stated as such) and a human - or a later, auditable pairwise stage - chooses. A REVIEW_REQUIRED or
// NOT_MEASURABLE candidate stays exactly that: it is never promoted to PASS. A stored report is never trusted: it must equal the
// recomputed one, otherwise the candidate is refused as stale.

import { CI_ERROR as E, PREFLIGHT_STATUS as S } from './constants.js';
import { normalizeCreativeCandidate } from './candidate.js';
import { runCreativePreflight } from './preflight.js';
import {
  canonical, deepFreeze, fail,
} from './validation.js';

export const SELECTION_STATUS = Object.freeze({
  CANDIDATES_EXPOSED: 'CANDIDATES_EXPOSED',
  NO_ELIGIBLE_CANDIDATE: 'NO_ELIGIBLE_CANDIDATE',
});

export function selectCandidates({ candidates, context = {} } = {}) {
  if (!Array.isArray(candidates) || candidates.length === 0 || candidates.length > 20) fail(E.SELECTION_INVALID, 'selection needs 1..20 candidates', { field: 'candidates' });
  const normalized = candidates.map((c) => normalizeCreativeCandidate(c));
  const ids = normalized.map((c) => c.candidate_id);
  if (new Set(ids).size !== ids.length) fail(E.SELECTION_INVALID, 'the same candidate appears twice', { field: 'candidates' });
  const first = normalized[0];
  if (normalized.some((c) => c.merchant_id !== first.merchant_id || c.brand_id !== first.brand_id || c.brief_ref !== first.brief_ref)) {
    fail(E.SELECTION_INVALID, 'candidates of different merchants, brands or briefs cannot be selected together', { field: 'candidates' });
  }
  const eligible = []; const rejected = [];
  for (const c of [...normalized].sort((a, b) => (a.candidate_id < b.candidate_id ? -1 : 1))) {
    const live = runCreativePreflight(c.design_document, context);
    if (canonical(live) !== canonical(c.preflight_report)) fail(E.CANDIDATE_REPORT_STALE, 'the stored preflight report differs from the one recomputed now', { candidate: c.candidate_id });
    const open = live.checks.filter((k) => k.status !== S.PASS).map((k) => ({ code: k.code, status: k.status }));
    if (live.status === S.FAIL) {
      rejected.push({ candidate_id: c.candidate_id, reasons: open.filter((k) => k.status === S.FAIL).map((k) => k.code) });
    } else {
      eligible.push({
        candidate_id: c.candidate_id,
        direction_ref: c.direction_ref,
        preflight_status: live.status,
        quality_status: c.quality_report ? c.quality_report.status : 'NOT_ASSESSED',
        needs_review: live.status !== S.PASS || !c.quality_report || c.quality_report.status !== 'PASS',
        open_checks: open,
      });
    }
  }
  return deepFreeze({
    status: eligible.length ? SELECTION_STATUS.CANDIDATES_EXPOSED : SELECTION_STATUS.NO_ELIGIBLE_CANDIDATE,
    ordering: 'candidate_id ascending - a stable order, NOT a ranking',
    eligible,
    rejected,
    human_choice_required: eligible.length > 1,
  });
}
