#!/usr/bin/env node
// Nordla Créateur — LOCAL DEMONSTRATION (npm run creator:demo -> http://127.0.0.1:4420). Loopback only, never deployed.
//
// What is real: the Creator screen and API, the integration hub route CREATIVE.produce_product_visual, the variant-exact product
// photo selection, the Creative ledger rules (accepted tenant policy, atomic reservation, transmission lifecycle), the creative brain
// and the local Python engines that compose the final image around the real product pixels, and the technical checks.
// What is SIMULATED: the providers (text, critique, image edit) — a fetch double answers instead of Alibaba (no network, no key,
// no cost) — the Shopify catalog (a demonstration product: "TEST — Gourde démo 500 ml", not TYESO), and the ledger runs in memory.
// Real provider execution stays refused by the hub (NDR-D02). Nothing is ever published.
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const PY = process.env.NORDLA_PYTHON || (process.platform === 'win32' ? 'python' : 'python3');

if (!process.env.NORDLA_CREATOR_DEMO_CHILD) {
  // The provider double must be loaded BEFORE anything else (it replaces fetch): re-run this file with it, in a private work directory.
  const work = mkdtempSync(join(tmpdir(), 'nordla-creator-demo-'));
  const env = { ...process.env, NORDLA_CREATOR_DEMO_CHILD: '1', NORDLA_CREATOR_DEMO_DIR: work, NORDLA_SCENE_DOUBLE_DIR: work, NORDLA_PYTHON: PY,
    // test-double credentials: the fetch double answers every call, nothing leaves the machine
    ALIBABA_MODEL_STUDIO_API_KEY: 'sk-test-double-0000000000', ALIBABA_MODEL_STUDIO_WORKSPACE_ID: 'ws-test-text-eu',
    ALIBABA_MODEL_STUDIO_IMAGE_API_KEY: 'sk-test-image-0000000000', ALIBABA_MODEL_STUDIO_IMAGE_WORKSPACE_ID: 'ws-test-image-global' };
  delete env.NODE_OPTIONS; delete env.NORDLA_MEDIA_AUTHORIZATION_FILE; delete env.NORDLA_SCENE_MEDIA_AUTHORIZATION_FILE;
  const child = spawn(process.execPath, ['--import', new URL('../test/fixtures/creative-autonomy/scene-fetch-double-preload.mjs', import.meta.url).href, fileURLToPath(import.meta.url)],
    { env, stdio: 'inherit', cwd: ROOT });
  for (const s of ['SIGINT', 'SIGTERM']) process.on(s, () => child.kill(s));
  child.on('exit', (code) => process.exit(code ?? 1));
} else {
  const { buildCreatorDemoWorld } = await import('./creator-demo-world.mjs');
  const { createCreatorApp } = await import('../src/creative-autonomy/creator/app.js');
  const { integration, catalog, OWNER, revisions } = await buildCreatorDemoWorld({ work: process.env.NORDLA_CREATOR_DEMO_DIR });
  const handler = createCreatorApp({ integration, catalog, mode: 'SIMULATED', actor: { id: OWNER, role: 'OWNER' }, tenantName: 'Boutique de démonstration (test)', revisions });
  const port = Number(process.env.CREATOR_PORT || 4420);
  http.createServer(handler).listen(port, '127.0.0.1', () => {
    console.log(`Nordla Créateur (DÉMONSTRATION SIMULÉE — aucun fournisseur réel, rien n'est publié) : http://127.0.0.1:${port}`);
  });
}
