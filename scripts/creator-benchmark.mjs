#!/usr/bin/env node
// Nordla Créateur — performance benchmark on the SIMULATED demonstration world (same fixtures every time; no network, no cost).
//   node scripts/creator-benchmark.mjs [runs=5] [out.json]
// Per run: wall-clock of CREATIVE.produce_product_visual, every pipeline step from the run's trace.json, and the time spent inside the
// SIMULATED provider (the fetch double, timed separately: it stands in for the provider's network latency and is NOT Nordla's work).
// Run 1 is "cold" (first creation of this photo in the process); runs 2..N are what a revision / re-creation of the same photo costs.
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const runs = Number(process.argv[2] || 5); const outFile = process.argv[3] || null;
if (!process.env.NORDLA_CREATOR_DEMO_CHILD) {
  const work = mkdtempSync(join(tmpdir(), 'nordla-creator-bench-'));
  const env = { ...process.env, NORDLA_CREATOR_DEMO_CHILD: '1', NORDLA_CREATOR_DEMO_DIR: work, NORDLA_SCENE_DOUBLE_DIR: work,
    ALIBABA_MODEL_STUDIO_API_KEY: 'sk-test-double-0000000000', ALIBABA_MODEL_STUDIO_WORKSPACE_ID: 'ws-test-text-eu',
    ALIBABA_MODEL_STUDIO_IMAGE_API_KEY: 'sk-test-image-0000000000', ALIBABA_MODEL_STUDIO_IMAGE_WORKSPACE_ID: 'ws-test-image-global' };
  delete env.NODE_OPTIONS; delete env.NORDLA_MEDIA_AUTHORIZATION_FILE; delete env.NORDLA_SCENE_MEDIA_AUTHORIZATION_FILE;
  const child = spawn(process.execPath, ['--import', new URL('../test/fixtures/creative-autonomy/scene-fetch-double-preload.mjs', import.meta.url).href, fileURLToPath(import.meta.url), ...process.argv.slice(2)], { env, stdio: 'inherit', cwd: ROOT });
  child.on('exit', (code) => process.exit(code ?? 1));
} else {
  const work = process.env.NORDLA_CREATOR_DEMO_DIR;
  const doubled = globalThis.fetch; let providerMs = 0; let providerCalls = 0;
  globalThis.fetch = async (...a) => { const t = performance.now(); try { return await doubled(...a); } finally { providerMs += performance.now() - t; providerCalls += 1; } };
  const { buildCreatorDemoWorld } = await import('./creator-demo-world.mjs');
  const { MODULE } = await import('../src/integration/index.js');
  const { integration, PID, BLACK, OWNER } = await buildCreatorDemoWorld({ work });
  const rows = [];
  for (let i = 0; i < runs; i += 1) {
    const runId = `bench-${i + 1}`; providerMs = 0; providerCalls = 0;
    const t0 = performance.now();
    const out = await integration.call(MODULE.CREATIVE, 'produce_product_visual', { product_id: PID, variant_id: BLACK, expected_variant_title: 'Noir', objective: 'Faire découvrir la gourde démo noire', run_id: runId },
      { workflow_id: `bench:${runId}`, initiated_by: { kind: 'HUMAN', id: OWNER, role: 'OWNER' } });
    const wall = performance.now() - t0;
    const trace = JSON.parse(readFileSync(join(work, 'runs', runId, 'trace.json'), 'utf8'));
    const steps = {}; for (const s of trace.trace) steps[s.step] = (steps[s.step] ?? 0) + s.ms;
    const inTrace = Object.values(steps).reduce((a, b) => a + b, 0);
    rows.push({ run: i + 1, ok: out.ok, status: out.result?.status ?? out.code, wall_ms: Math.round(wall), steps, outside_trace_ms: Math.round(wall - inTrace),
      simulated_provider_ms: Math.round(providerMs), simulated_provider_calls: providerCalls, cost_eur: trace.cost_eur, result_png: out.result?.results?.[0]?.image ?? null });
    process.stderr.write(`run ${i + 1}: ${Math.round(wall)} ms ${out.result?.status ?? out.code}\n`);
  }
  const med = (xs) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.floor((s.length - 1) / 2)] : null; };
  const keys = [...new Set(rows.flatMap((r) => Object.keys(r.steps)))];
  const summary = { node: process.versions.node, runs, cold: rows[0], warm_median: rows.length > 1 ? {
    wall_ms: med(rows.slice(1).map((r) => r.wall_ms)), simulated_provider_ms: med(rows.slice(1).map((r) => r.simulated_provider_ms)), outside_trace_ms: med(rows.slice(1).map((r) => r.outside_trace_ms)),
    steps: Object.fromEntries(keys.map((k) => [k, med(rows.slice(1).map((r) => r.steps[k] ?? 0))])) } : null, rows };
  const text = JSON.stringify(summary, null, 1);
  if (outFile) writeFileSync(outFile, text);
  console.log(JSON.stringify({ cold_wall_ms: summary.cold.wall_ms, warm: summary.warm_median }, null, 1));
}
