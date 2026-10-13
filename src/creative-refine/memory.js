import { SCHEMA } from './constants.js';

// THE REFINE MEMORY: what was already tried on a scene, as plain serializable data (it can be saved and resumed in another process, like the campaign working state). It is how a repair does not repeat itself:
// the planner reads the attempts of a scene (the number of repositions of a layer, a fingerprint that already failed, the ceiling of attempts) and escalates (reposition, then remove, or a replan) instead of looping.
// It stores no media: hashes, scopes and outcomes only.

export function createRefineMemory(initial = null) {
  const state = initial ? JSON.parse(JSON.stringify(initial)) : { schema: SCHEMA.memory, scenes: {} };
  return Object.freeze({
    attempts: (sceneId) => [...(state.scenes[sceneId]?.attempts ?? [])],
    record(sceneId, entry) {
      if (!state.scenes[sceneId]) state.scenes[sceneId] = { attempts: [] };
      state.scenes[sceneId].attempts.push(JSON.parse(JSON.stringify(entry)));
      return entry;
    },
    export: () => JSON.parse(JSON.stringify(state)),
  });
}
