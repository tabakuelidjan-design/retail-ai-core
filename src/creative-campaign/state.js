import { deepFreeze, deriveId } from '../creative-brain/validation.js';
import { DEPENDS_ON, SCHEMA } from './constants.js';

// THE WORKING STATE OF A CAMPAIGN. Every stage result is a NODE stored with the hash of the inputs it was made from; the state is plain, serializable data. A node is reused iff its stored input hash equals
// the hash of the inputs now: nothing is recomputed that did not change, and anything that depends on a changed input is recomputed. Upstream ids are part of the inputs of what follows, so a change travels
// down the dependency graph by itself. A store port (`load`, `save`) keeps the state between runs: a campaign can stop at any node and resume. This model is what a later Core Resilience layer persists; it
// knows nothing of any store but the port.

export const inputsHash = (body) => deriveId('inp', body);

export function emptyState(campaignRef) {
  return { schema: SCHEMA.state, campaign_ref: campaignRef, nodes: {}, saves: 0 };
}

/** A node can be reused for these inputs. */
export const reusable = (node, hash) => Boolean(node) && node.status === 'DONE' && node.inputs_hash === hash;

export function putNode(state, label, { inputsHash: hash, id, artifact, status = 'DONE', failureCode = null }) {
  state.nodes[label] = { label, status, inputs_hash: hash, id, failure_code: failureCode, artifact };
  return state.nodes[label];
}

/** The kinds that depend on a kind, transitively (the structure of the dependency graph). */
export function dependentsOf(kind) {
  const out = new Set(); const queue = [kind];
  while (queue.length) {
    const current = queue.shift();
    for (const [k, deps] of Object.entries(DEPENDS_ON)) if (deps.includes(current) && !out.has(k)) { out.add(k); queue.push(k); }
  }
  return [...out].sort();
}

/** An in-memory checkpoint store: the port a durable store (the Core's state layer) implements later. Saves copies; loads copies. */
export function createMemoryCheckpointStore(initial = null) {
  let stored = initial ? structuredClone(initial) : null; let saves = 0;
  return Object.freeze({
    async load() { return stored ? structuredClone(stored) : null; },
    async save(state) { stored = structuredClone(state); saves += 1; },
    saves: () => saves,
    peek: () => (stored ? structuredClone(stored) : null),
  });
}

export const freezeState = (state) => deepFreeze(structuredClone(state));
