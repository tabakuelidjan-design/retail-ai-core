// WORK IS KEPT, THE STEP TO RESUME IS SAID (2026-11-07). Every run, whatever its end, writes `reprise.json` next to its trace: what was completed, where it stopped, why, what is kept (frame, concepts, the advice of SELECT, files) and the NEXT STEP with the exact input
// to give it. Nothing is recomputed from memory: it is derived from the trace of the run, so it cannot say something the run did not do.
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const FILES = ['faits.json', 'trace.json', 'propositions.json', 'brain-calls'];
const stepOf = (name) => String(name ?? '').replace(/_REPAIR$/, '').replace(/-cnc_.*/, '');

/** { status, completed_steps, stopped_at, why, kept, next_step: { step, action, input? } } from the result of a run (its status, trace and extras). */
export function buildResumeManifest(result, workdir = null) {
  const trace = Array.isArray(result?.trace) ? result.trace : [];
  const completed = trace.filter((e) => e.outcome && !['ERROR', 'PROVIDER_NOT_CONNECTED'].includes(e.outcome)).map((e) => ({ step: e.step, concept_id: e.concept_id ?? null, outcome: e.outcome }));
  const lastError = [...trace].reverse().find((e) => e.outcome === 'ERROR');
  const kept = {
    frame: Boolean(result?.frame), concepts: Array.isArray(result?.concepts) ? result.concepts.map((c) => c.concept_id) : [], selection: result?.selection?.selection?.outcome ?? null,
    art_directions: Object.keys(result?.art_directions ?? {}), stages: Object.keys(result?.stages ?? {}), files: workdir ? FILES.filter((f) => existsSync(join(workdir, f))) : [],
  };
  let next; let why = null;
  switch (result?.status) {
    case 'PROPOSALS_READY_FOR_OWNER': next = { step: 'OWNER_REVIEW', action: 'the owner validates, refuses or asks a revision of each proposal (headline included); nothing is published' }; break;
    case 'IDEATION_ONLY_NOT_A_VISUAL': next = { step: 'RENDER', action: 'a visual run on the same photograph, from the kept decisions' }; break;
    case 'STOPPED_NO_CONCEPT_SELECTED':
      if (result.selection_verdict_applied) {
        why = `the verdict of SELECT was applied: ${result.selection?.selection?.outcome ?? 'no concept'} (no concept meets the bar of the route); nothing was produced`;
        next = { step: 'IDEATE', action: 'run IDEATE again from the kept frame with the advice of SELECT (input.resumeAdvice = resume_advice); the frame, the concepts and the advice are kept', input: { resumeAdvice: result.resume_advice ?? [] } };
      } else { why = 'no concept could be selected'; next = { step: 'SELECT', action: 'judge the concepts again' }; }
      break;
    case 'STOPPED_ERROR': {
      const step = stepOf(lastError?.step ?? result?.stopped_at?.step);
      why = lastError ? `${lastError.detail?.code ?? 'ERROR'}${lastError.detail?.field ? ` at ${lastError.detail.field}` : ''}: ${String(lastError.detail?.message ?? '').slice(0, 200)}` : (result?.error?.message ?? null);
      next = { step, action: `resume at ${step}: the steps before it are kept (${kept.frame ? 'frame' : 'no frame'}${kept.concepts.length ? `, ${kept.concepts.length} concepts` : ''}${kept.art_directions.length ? ', art direction' : ''}${kept.stages.length ? ', stage' : ''})`, ...(result?.error?.code ? { error_code: result.error.code } : {}) };
      break;
    }
    case 'STOPPED_BRIEF_INCOMPLETE': next = { step: 'BRIEF', action: 'complete the brief (see the issues of the BRIEF step)' }; break;
    case 'CONCEPTS_ONLY_ASSET_NOT_USABLE': next = { step: 'EXAMINE', action: 'provide another image of the same product (the photograph cannot be used)' }; break;
    case 'STOPPED_PROVIDER_NOT_CONNECTED': next = { step: 'FRAME', action: 'connect the text provider, then start again' }; break;
    default: next = { step: 'UNKNOWN', action: 'read the trace' };
  }
  return { status: result?.status ?? null, completed_steps: completed, stopped_at: lastError ? { step: lastError.step, concept_id: lastError.concept_id ?? null } : null, why, kept, next_step: next };
}
