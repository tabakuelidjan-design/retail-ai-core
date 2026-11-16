// The execution boundary of the Creator on a HOSTED Nordla server WITHOUT a generation provider (staging).
//
// The Creator screen (app.js) produces nothing itself: it asks the integration hub for `produce_product_visual` and shows what comes back. On the owner's machine that call
// runs local Python engines and, when authorised, a paid provider. Neither exists on the Nordla server image (Node only), and no paid call is allowed here (NDR-D02).
// This file provides the SAME hub interface for the server, answering ONLY from archived runs (a replay: no network, no provider, no cost):
//   - TEST_IMAGE: an archived, really generated picture (config/creator/staging-replay/archived-result.png), copied into THIS merchant's own folder like a produced file;
//   - TEST_NONE:  a TEST copy of the archived run cr-08a0933b0836 (Creator answered "no convincing idea"): the reason shown is derived from the archived trace by the real
//                 deriveStopReason, so the screen carries Creator's own words and the AD_NO_CONVINCING_IDEA code.
// Every product here is titled TEST and every creation is flagged DEMO by the hosted wrapper. Nothing is published, nothing is spent.
//
// Storage: everything lives under <dataDir>/creator/<merchant>/ on the server volume (never a Windows path, never another merchant's folder):
//   history/<person>/<creation>.json  the creations of one person (written by app.js, read back at start)
//   images/<creation>-<n>.png         the produced files; readImage refuses any path outside this merchant's images folder
import { copyFile, mkdir, readFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { MODULE } from '../../integration/index.js';
import { deriveStopReason } from '../stop-reason.js';

export const TEST_IMAGE = Object.freeze({ product_id: 'test:archived-result', variant_id: 'test:archived-result:v1' });
export const TEST_NONE = Object.freeze({ product_id: 'test:archived-none', variant_id: 'test:archived-none:v1' });
export const REPLAY_DIR = new URL('../../../config/creator/staging-replay/', import.meta.url);
export const TEST_CATALOG = Object.freeze([
  { product_id: TEST_IMAGE.product_id, title: 'TEST — résultat archivé (une image)', variants: [{ variant_id: TEST_IMAGE.variant_id, title: 'Test archivé', price: '—' }] },
  { product_id: TEST_NONE.product_id, title: 'TEST — réponse « aucune idée » archivée (run cr-08a0933b0836)', variants: [{ variant_id: TEST_NONE.variant_id, title: 'Test archivé', price: '—' }] },
]);

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,80}$/;
const SAFE_RUN = /^cr-[0-9a-f]{12}$/;

/** @param {{ dataDir: string, delayMs?: number, replayDir?: URL }} o  dataDir = the server volume directory (hosted.dataDir) */
export function createStagingCreatorWorld({ dataDir, delayMs = 1500, replayDir = REPLAY_DIR } = {}) {
  if (typeof dataDir !== 'string' || !dataDir) throw new TypeError('dataDir is required');
  const urlOf = (name) => new URL(name, replayDir);
  const merchantRoot = (merchantId) => {
    if (!SAFE_ID.test(String(merchantId))) throw Object.assign(new Error('invalid merchant id'), { code: 'MERCHANT_INVALID' });
    return resolve(dataDir, 'creator', String(merchantId));
  };
  const imagesDir = (merchantId) => join(merchantRoot(merchantId), 'images');

  /** The hub of ONE merchant: the only thing app.js can call. Anything but the one known action is refused. */
  function integrationFor(merchantId) {
    const images = imagesDir(merchantId);
    return {
      async call(module, action, input) {
        if (module !== MODULE.CREATIVE || action !== 'produce_product_visual') return { ok: false, code: 'ACTION_NOT_AVAILABLE', reason: 'staging replay answers only produce_product_visual' };
        const runId = String(input?.run_id ?? '');
        if (!SAFE_RUN.test(runId)) return { ok: false, code: 'RUN_ID_INVALID', reason: 'invalid run id' };
        if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs)); // a visible RUNNING state: the screen tracks the creation until it ends
        if (input.product_id === TEST_IMAGE.product_id) {
          await mkdir(images, { recursive: true });
          const out = join(images, `${runId}-0.png`);
          await copyFile(urlOf('archived-result.png'), out);
          return { ok: true, result: { status: 'COMPLETED', results: [{ image: out }], source_sha256: null, policy_version: 'staging-replay-v1', withheld: [], reservation: null } };
        }
        if (input.product_id === TEST_NONE.product_id) {
          const archived = JSON.parse(await readFile(urlOf('cr-08a0933b0836.none.json'), 'utf8'));
          const stop = deriveStopReason({ r: archived, shown: [] });
          return { ok: true, result: { status: 'STOPPED_ERROR', results: [], stop_reason: stop, replay_of: archived.source_run } };
        }
        return { ok: false, code: 'UNKNOWN_PRODUCT', reason: 'no archived run for this product' };
      },
    };
  }

  return Object.freeze({
    integrationFor,
    catalogFor: () => async () => TEST_CATALOG.map((p) => ({ ...p, variants: p.variants.map((v) => ({ ...v })) })),
    persistDirFor: (merchantId, userId) => {
      if (!SAFE_ID.test(String(userId))) throw Object.assign(new Error('invalid user id'), { code: 'USER_INVALID' });
      return join(merchantRoot(merchantId), 'history', String(userId));
    },
    /** app.js reads a produced file through this: only files inside THIS merchant's images folder, whatever the history file says. */
    readImageFor: (merchantId) => {
      const root = imagesDir(merchantId) + sep;
      return async (p) => {
        const full = resolve(String(p));
        if (!full.startsWith(root)) throw Object.assign(new Error('path outside the merchant folder'), { code: 'PATH_REFUSED' });
        return readFile(full);
      };
    },
    imagesDir,
  });
}
