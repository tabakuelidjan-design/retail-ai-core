import { DIMENSIONS } from '../src/creative-critic/index.js';
import { CONCEPT_DIMENSIONS, normalizeConceptSet } from '../src/creative-brain/index.js';
import { createMemoryStore, runLive } from '../src/creative-brain-benchmark/index.js';
import { MemoryCallJournal } from '../src/marketing-creative/alibaba/index.js';
import {
  BRAND, buildBrief, fakeEnvironmentPort, fonts, GUARDIAN_PASS,
} from './runtime-world.js';
import {
  artDirectionAnswer, compositionAnswer, CONCEPTS, evaluationsAnswer, frameAnswer, scriptedPort,
} from './creative-brain-world.js';

// The shared synthetic world of the Creative Brain benchmark runner: fake providers only (no network, no credential, no provider), scripted answers per stage, scripted critics.

export const AT = '2026-10-12T09:00:00.000Z';
export const PALE = artDirectionAnswer({
  narrative_elements: [
    { element: 'a pair of worn tools laid aside at the edge of the bench', reason: 'they show the maker has just finished, the care taken in the making', zone: 'FOREGROUND' },
    { element: 'a pale window far behind the bench', reason: 'it places the finished piece at dusk, the quiet end of the work', zone: 'BACKGROUND' },
  ],
});
export const BELOW = compositionAnswer({ text_adjacency: 'BELOW', product_anchor: { horizontal: 'CENTER', vertical: 'UPPER' }, alignment_family: 'START' });
export const PICKS = [{}, { CONCEPT_STRENGTH: 'PARTIAL' }, { DISTINCTIVENESS: 'FAILS' }];
export const selectAnswer = (list, picks = PICKS) => evaluationsAnswer(normalizeConceptSet(list), picks);

/** A complete fake world. `answers` overrides the scripted Brain answers; `execution` / `concept` set critic outcomes per candidate (arrays of outcome maps). */
export function world({
  answers = {}, execution = [{}, {}], concept = [{}, {}], guardian = GUARDIAN_PASS, credentials = { present: true, valid: true, missing: [] }, store = createMemoryStore(), vlmAllowed = true, brief = buildBrief(), pixelsOf = null, hardCeilingEur,
} = {}) {
  const trace = []; const portArgs = []; const budgets = []; const instructions = []; const vlmCalls = []; const envRequests = [];
  const script = scriptedPort({
    frame: [frameAnswer()], ideate: [{ concepts: CONCEPTS }], select: [selectAnswer(CONCEPTS)], art_direct: [PALE], compose: [BELOW], ...answers,
  });
  const env = fakeEnvironmentPort({ pixelsOf });
  let candidateNo = 0;
  const deps = {
    store,
    readiness: () => ({ ready: true, status: 'CREATIVE_BRAIN_CONTRACT_PARITY_READY', reasons: [] }), // the gate itself is tested in creative-brain-readiness.test.js
    journal: new MemoryCallJournal(),
    now: () => AT,
    ...(hardCeilingEur === undefined ? {} : { hardCeilingEur }),
    credentials: () => credentials,
    loadInputs: async () => ({ brief, fonts, expression: BRAND.expression }),
    ports: {
      brainPort: (args) => async (instruction) => {
        if (!portArgs.includes(args)) portArgs.push(args);
        const out = await script.complete(instruction);
        trace.push(script.calls.at(-1).stage); instructions.push(instruction);
        return out;
      },
      environmentPort: ({ budget }) => ({
        budget,
        async generate(input) { if (!budgets.includes(budget)) budgets.push(budget); trace.push('environment'); envRequests.push(input.request); return env.generate(input); },
      }),
      vlm: ({ candidateRef }) => {
        if (!vlmAllowed) throw Object.assign(new Error('EXTERNAL_MEDIA_SHARING_NOT_AUTHORIZED'), { code: 'EXTERNAL_MEDIA_SHARING_NOT_AUTHORIZED' });
        return {
          invoke: async (req) => {
            const isConcept = /concept critic/.test(req.system);
            if (!isConcept) candidateNo += 1;
            const index = Math.min(candidateNo, 2) - 1;
            const outcomes = (isConcept ? concept : execution)[index] ?? {};
            trace.push(isConcept ? 'concept_critic' : 'execution_critic'); vlmCalls.push({ candidateRef, system: req.system, user: req.user });
            const dims = isConcept ? CONCEPT_DIMENSIONS : DIMENSIONS;
            return {
              text: JSON.stringify({
                dimensions: dims.map((dimension) => {
                  const outcome = outcomes[dimension] ?? 'PASS';
                  return { dimension, outcome, evidence: 'Concrete visible evidence for this judgment.', ...(outcome === 'FAIL' || outcome === 'REVIEW_REQUIRED' ? { revision_hint: 'Give the idea more presence in plain words.' } : {}) };
                }),
              }),
              model: 'fake-vlm', request_id: `vlm-${vlmCalls.length}`,
            };
          },
        };
      },
      guardian: () => guardian,
    },
  };
  return { deps, trace, portArgs, budgets, instructions, vlmCalls, envRequests, script, env, store };
}

export const live = (w) => runLive(w.deps, { confirmed: true });
