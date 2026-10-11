import { runChaos } from './benchmarks/core-resilience/harness.js';
import { SCENARIOS } from './benchmarks/core-resilience/scenarios.js';
const r = await runChaos(SCENARIOS);
console.log(r.scenarios, JSON.stringify(r.criteria));
for (const f of r.failed_scenarios) console.log(f.id, f.problems.join(' | '));
for (const x of r.records.filter((x) => /^[J-R]/.test(x.scenario_id))) console.log(x.scenario_id.padEnd(5), String(x.actual_classification).padEnd(26), String(x.actual_action).padEnd(20), String(x.terminal_state).padEnd(20), 'calls', x.provider_calls, 'depth', x.recovery_depth);
