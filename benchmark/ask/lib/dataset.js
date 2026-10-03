// The fixed benchmark dataset: the SAME synthetic dataset the unit tests use (test/fixtures/analytics-dataset.js), the SAME reference date, the SAME tools.
// Never the real HABB data: the benchmark score must be reproducible. Any drift of this dataset is caught by `verifyTruth` (the pinned quantities of cases.json).

import { NOW, TZ, writeDataset } from '../../../test/fixtures/analytics-dataset.js';
import { resetPeriodCache } from '../../../src/analytics-premium/server/period-engine.js';
import { createToolLayer } from '../../../src/analytics-premium/server/tools/index.js';

/** "Today" for every case: 2026-09-26 (Europe/Brussels). Presets ("last 30 days", "last month"...) resolve against it. */
export const REFERENCE_NOW = NOW;
export const REFERENCE_TZ = TZ;

export async function createBenchmarkTools() {
  resetPeriodCache();
  const dir = await writeDataset();
  return { dir, tools: createToolLayer({ reportsDir: dir, now: () => NOW }) };
}
