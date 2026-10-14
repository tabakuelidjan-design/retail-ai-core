// Runs the benchmark: N independent repetitions of the 30 cases. Independence: every repetition gets a fresh provider instance (the adapter is created again), a
// fresh dataset/tool layer and fresh orchestrators - nothing is shared between two repetitions. Cases of one repetition are also independent of each other
// (a conversation only sees its own turns).

import { createBenchmarkTools } from './dataset.js';
import { runCase } from './run-case.js';
import { scoreCase } from './score.js';

/**
 * @param {{ cases: object[], createProvider: (repeat: number) => object|Promise<object>, repeats?: number, only?: string[]|null, timeoutMs?: number,
 *           onCase?: (info: {repeat, score}) => void }} opts
 * @returns {Promise<{ runs: object[][], provider: object, datasetFile: string, repeatMetadata: object[], aborted: boolean }>} `runs[k]` = the case scores of repetition k+1
 */
export async function runBenchmark({ cases, createProvider, repeats = 1, only = null, timeoutMs = 60_000, onCase = null, shouldStop = null }) {
  if (!Number.isInteger(repeats) || repeats < 1 || repeats > 10) throw new RangeError('repeats must be an integer from 1 to 10');
  const list = only ? cases.filter((c) => only.includes(c.id)) : cases;
  const runs = []; const repeatMetadata = []; let provider = null; let datasetFile = null; let aborted = false;
  for (let repeat = 1; repeat <= repeats; repeat += 1) {
    const { dir, tools } = await createBenchmarkTools(); datasetFile = `${dir}/dataset.json`;
    const p = await createProvider(repeat); provider ??= p;
    const scores = [];
    for (const c of list) { const score = scoreCase(c, await runCase({ testCase: c, provider: p, tools, timeoutMs })); scores.push(score); if (onCase) onCase({ repeat, score }); if (shouldStop?.() && !(c === list[list.length - 1] && repeat === repeats)) { aborted = true; break; } }   // a budget cap ends the run early (unless that was the last case anyway)
    repeatMetadata.push({ repeat, ...(p.metadata?.() ?? {}) });
    if (aborted && scores.length < list.length && runs.length > 0) break;                // an incomplete repetition is dropped when earlier ones are complete
    runs.push(scores); if (aborted) break;   // each repetition has its own provider instance, hence its own usage totals and call counts
  }
  return { runs, provider, datasetFile, repeatMetadata, aborted };
}
