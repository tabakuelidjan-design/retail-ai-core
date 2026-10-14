import { AsyncLocalStorage } from 'node:async_hooks';

import { createRecoveryBudget, runResilient } from '../../src/core-resilience/index.js';

export const meterContext = new AsyncLocalStorage();
/** Counts provider calls of the running stage (attempts count even when they fail). */
export const meterCalls = (n = 1, costEur = 0) => meterContext.getStore()?.meterAttempt(n, costEur);

// Helpers shared by the chaos scenarios: stage builders, a runner that gives each scenario its own tenant, run id and marker, and a scenario constructor with automatic ids.

const counters = {};
export const scenario = (group, module, input_class, expect, run) => {
  counters[group] = (counters[group] ?? 0) + 1;
  const id = `${group}-${String(counters[group]).padStart(2, '0')}`;
  return { id, group, module, input_class, expect, run: (env) => run(env, id) };
};
export const resetCounters = () => { for (const k of Object.keys(counters)) delete counters[k]; };

export const ids = (sid) => ({ tenant: `ten-${sid.toLowerCase()}`, runId: `run-${sid.toLowerCase()}` });
/** The marker a tenant puts in everything it holds, so that a leak into another tenant is detectable. */
export const markerOf = (tenant) => `MARK-${tenant.toUpperCase()}-PRIVATE`;

export const stage = (name, run, extra = {}) => ({ name, run, ...extra });
export const ok = (name, extra = {}) => stage(name, async (ctx) => ({ stage: name, marker: ctx.input.marker }), extra);
export const failing = (name, code, props = {}, extra = {}) => stage(name, async () => { throw Object.assign(new Error(code), { code, ...props }); }, extra);
/** A stage that fails its first `failures` attempts with `make(attempt)`, then succeeds. */
export const flaky = (name, failures, make, extra = {}) => stage(name, async (ctx) => { if (ctx.attempt <= failures) throw make(ctx.attempt); return { stage: name, marker: ctx.input.marker }; }, extra);
export const http = (status, extra = {}) => Object.assign(new Error(`HTTP ${status}`), { status, ...extra });

/**
 * Runs a plan for a scenario in its own tenant. opts: { input, modulePolicy, limits, capabilities, canAskUser, dataClass, tenant, runId, expectations, check, extra }.
 */
export async function go(env, sid, module, stages, opts = {}) {
  const { tenant, runId } = { ...ids(sid), ...(opts.tenant ? { tenant: opts.tenant } : {}), ...(opts.runId ? { runId: opts.runId } : {}) };
  env.markers.set(tenant, markerOf(tenant));
  const budget = createRecoveryBudget(opts.limits ?? {}, opts.clock ? { clock: opts.clock } : {});
  const report = await runResilient({
    hub: env.hub, tenant, runId, module, stages, registry: opts.registry ?? env.registry, input: { marker: markerOf(tenant), ...(opts.input ?? {}) }, modulePolicy: opts.modulePolicy ?? null, budget,
    capabilities: opts.capabilities ?? null, canAskUser: opts.canAskUser ?? true, dataClass: opts.dataClass ?? 'PUBLIC',
  });
  return { report, tenants: [tenant], modulePolicy: opts.modulePolicy ?? null, maxDepth: opts.limits?.depth ?? 4, expectations: opts.expectations, check: opts.check, ...(opts.extra ?? {}) };
}

/** Wraps a real module call into a stage: any thrown error is classified by the Core registry. */
export const real = (name, fn, extra = {}) => stage(name, async (ctx) => {
  const value = await meterContext.run(ctx, () => fn(ctx)); // the workload meters its own provider calls through `meterCalls`
  return { stage: name, marker: ctx.input.marker, value: value ?? null };
}, extra);
