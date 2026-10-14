import { meterCalls } from './kit.js';
import { askAndNormalize, buildFramerInstruction, buildProblemFrame, observeBrief } from '../../src/creative-brain/index.js';
import { STAGE_CONTRACTS } from '../../src/creative-brain/parity.js';
import { RESULT_STATE } from '../../src/creative-brain-benchmark/index.js';
import { coreErrorOfBrainStop } from '../../src/core-resilience/adapters/index.js';
import { artDirectionAnswer, compositionAnswer, CONCEPTS, frameAnswer, OTHER_CONCEPTS } from '../../test/creative-brain-world.js';
import { live, PALE, selectAnswer, world } from '../../test/creative-brain-benchmark-world.js';
import { buildBrief } from '../../test/runtime-world.js';
import { issueInvoice, makeService, MERCHANT_ACTOR, AGENT_ACTOR, draftInvoice } from '../../test/finance-fixtures.js';

// Real-module workloads for the chaos scenarios: the Creative Brain benchmark runner on its synthetic fake world, the Brain's own structured-answer boundary, and the Finance service on its in-memory store.
// Nothing here talks to a network, a credential or a paid provider.

// ---------------------------------------------------------------------------------------------------------------- CREATIVE
export { artDirectionAnswer, compositionAnswer, CONCEPTS, OTHER_CONCEPTS, frameAnswer, PALE, selectAnswer };

/** One whole Creative Brain benchmark run on the fake world. A stopped plan becomes the CoreError of its cause; a finished run returns a small summary. */
export async function creativeRun(answers = {}, worldOptions = {}) {
  const w = world({ answers, ...worldOptions });
  await live(w);
  const summary = await w.store.readJson('summary.json');
  meterCalls(summary.provider_calls?.total ?? 0); // every attempt of the Brain, successful or not
  if (summary.error) throw coreErrorOfBrainStop(summary.error);
  if (summary.final.state === RESULT_STATE.BLOCKED) throw coreErrorOfBrainStop({ cause: summary.final.reason, brain_stage: summary.final.stopped_at }); // a VALID rejection of every concept
  return { state: summary.final.state, provider_calls: summary.provider_calls?.total ?? null, protocol_repairs: JSON.stringify(summary.brain_ledger ?? []).includes('malformed_response_sha256') ? 1 : 0, stopped: summary.final.state === RESULT_STATE.BLOCKED };
}

const FRAME_CONTRACT = STAGE_CONTRACTS.find((c) => c.stage === 'FRAME');
const OBSERVATION = observeBrief({ brief: buildBrief() });

/** The Brain's own boundary for the FRAME stage: provider replies in order, parsed, repaired once if unparseable, normalized and validated. */
export async function askFrame(replies) {
  const calls = [];
  const complete = async (instruction) => {
    calls.push(instruction);
    const next = replies[calls.length - 1];
    if (next === undefined) throw Object.assign(new Error('no more replies'), { code: 'NO_MORE_REPLIES' });
    if (next instanceof Error) throw next;
    return { text: typeof next === 'string' ? next : JSON.stringify(next), model: 'fake', request_id: `chaos-${calls.length}` };
  };
  const metered = async (instruction) => { meterCalls(1); return complete(instruction); };
  const { value, meta } = await askAndNormalize({ complete: metered, instruction: buildFramerInstruction({ observation: OBSERVATION }), stage: 'FRAME', spec: FRAME_CONTRACT.spec, normalize: (raw) => buildProblemFrame({ observation: OBSERVATION, model: raw }) });
  return { frame_id: value.frame_id, calls: calls.length, protocol_repair: meta.protocol_repair?.outcome ?? null, repairs: meta.repairs.length };
}

// ---------------------------------------------------------------------------------------------------------------- FINANCE
export { AGENT_ACTOR, MERCHANT_ACTOR, draftInvoice, issueInvoice, makeService };
