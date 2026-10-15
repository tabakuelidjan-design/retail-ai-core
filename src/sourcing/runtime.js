// China Sourcing requires Node 24 (owner decision 2026-10-12): the field tooling relies on the global WebSocket and the other runtime behaviour of Node 24.
// The repository-wide `engines` field is deliberately NOT changed (owner decision 2026-10-14: the deployment configuration belongs to Infrastructure); the requirement is enforced here, for China Sourcing only.
export const REQUIRED_NODE_MAJOR = 24;

export class SourcingRuntimeError extends Error { constructor(msg) { super(msg); this.code = 'SOURCING_NODE_UNSUPPORTED'; } }

/** Throws a clear error on any Node older than 24 (or an unreadable version). */
export function assertSourcingRuntime(version = process.versions.node) {
  const major = Number.parseInt(String(version).split('.')[0], 10);
  if (!Number.isInteger(major) || major < REQUIRED_NODE_MAJOR) throw new SourcingRuntimeError(`China Sourcing requires Node ${REQUIRED_NODE_MAJOR} or later (found ${version}). Start it with Node ${REQUIRED_NODE_MAJOR}.`);
  return major;
}
