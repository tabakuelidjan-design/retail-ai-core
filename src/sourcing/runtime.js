// China Sourcing requires Node 24 (owner decision 2026-10-12): the field tooling relies on the global WebSocket and the other runtime behaviour of Node 24.
// Since the Nordla Core P0 the whole repository targets Node 24 (`engines` >=24, `.nvmrc`, Dockerfile); this guard stays so a wrong runtime is refused with a clear code before anything starts.
export const REQUIRED_NODE_MAJOR = 24;

export class SourcingRuntimeError extends Error { constructor(msg) { super(msg); this.code = 'SOURCING_NODE_UNSUPPORTED'; } }

/** Throws a clear error on any Node older than 24 (or an unreadable version). */
export function assertSourcingRuntime(version = process.versions.node) {
  const major = Number.parseInt(String(version).split('.')[0], 10);
  if (!Number.isInteger(major) || major < REQUIRED_NODE_MAJOR) throw new SourcingRuntimeError(`China Sourcing requires Node ${REQUIRED_NODE_MAJOR} or later (found ${version}). Start it with Node ${REQUIRED_NODE_MAJOR}.`);
  return major;
}
