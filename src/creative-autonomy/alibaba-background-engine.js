// Integrates Nordla's EXISTING Alibaba image client with the existing Creative Autonomy route.
// Background-only: the real product photo stays on the owner's machine and is composed locally.
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { generateMarketingImage } from '../marketing-creative/alibaba/qwen-image.js';
import { MemoryOutputStore } from '../marketing-creative/alibaba/output-store.js';
import { buildVisualBackgroundBrief, assertVisualProductionApproval } from './visual-production-contract.js';

const runFile = promisify(execFile);
const HERE = dirname(fileURLToPath(import.meta.url));
const PREPARE = resolve(HERE, '../../scripts/creative-autonomy/prepare_generated_background.py');
const PNG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const PROVIDER = 'alibaba-model-studio';
const MAX_BACKGROUND_BYTES = 48 * 1024 * 1024;

function exactFormat(canvas) {
  if (canvas?.width === 1080 && canvas?.height === 1350) return 'INSTAGRAM_FEED_4_5';
  if (canvas?.width === 1080 && canvas?.height === 1920) return 'INSTAGRAM_STORY_9_16';
  if (canvas?.width === 1920 && canvas?.height === 1080) return 'WEB_BANNER_16_9';
  throw new Error('UNSUPPORTED_VISUAL_CANVAS');
}
function safeProviderOutputStore(store) {
  return {
    storeUrl: async ({ url, ...args }) => {
      const u = new URL(url);
      // Provider-supplied URLs are untrusted. No arbitrary hosts or private addresses.
      if (u.protocol !== 'https:' || u.username || u.password || !u.hostname.toLowerCase().endsWith('.aliyuncs.com')) {
        throw new Error('UNTRUSTED_GENERATED_IMAGE_URL');
      }
      return store.storeUrl({ url, ...args });
    },
  };
}
export async function prepareImageForComposer({ imagePath, examPath, stagePath, python = process.env.NORDLA_PYTHON || (process.platform === 'win32' ? 'python' : 'python3') }) {
  const output = await runFile(python, [PREPARE, imagePath, examPath, stagePath], { timeout: 90_000, maxBuffer: 1 << 20 });
  return JSON.parse(output.stdout.trim().split('\n').at(-1));
}

/**
 * Opt-in image renderer replacing ONLY the Blender background renderer.
 * The Brain, local examination, product compositor, typography, visual critic and review are unchanged.
 *
 * A new explicit approval is mandatory. One approval does NOT authorize the older trial,
 * and no user photo is included in the Alibaba image request.
 */
export function createAlibabaBackgroundEngine({
  baseEngines, config, planId, authorization, sourcePhotoRights,
  budget, journal, outputStore = new MemoryOutputStore(),
  generate = generateMarketingImage, prepare = prepareImageForComposer,
  fetchImpl,
}) {
  if (typeof baseEngines?.examine !== 'function' || typeof baseEngines?.compose !== 'function') {
    throw new TypeError('Real examination and local compositor required');
  }
  if (!config?.imageModel || config.region !== 'eu-central-1') throw new Error('ALIBABA_IMAGE_CONFIG_NOT_VERIFIED');
  if (typeof generate !== 'function' || typeof prepare !== 'function' || typeof outputStore?.readBytes !== 'function') {
    throw new TypeError('Image provider, prepare function and readable output store required');
  }
  if (!budget?.reserveImages) throw new TypeError('SpendGuard is required');
  let attempted = 0;

  return Object.freeze({
    ...baseEngines,
    name: Object.freeze({ ...baseEngines.name, render: 'Qwen Image product-free environment', renderProvider: PROVIDER }),
    async render({ stage, concept, artDirection, canvas, stagePath, examPath, outPath }) {
      // Check BEFORE model invocation, file write, or budget reservation.
      assertVisualProductionApproval({
        planId, provider: PROVIDER, model: config.imageModel, authorization, sourcePhotoRights,
      });
      if (!stage?.camera?.product_position) throw new TypeError('stage.camera.product_position required');
      const visualBrief = buildVisualBackgroundBrief({
        concept, artDirection, format: exactFormat(canvas),
        productPosition: stage.camera.product_position,
      });
      if (attempted >= authorization.maxCalls) throw new Error('IMAGE_CALL_LIMIT_EXCEEDED');
      attempted += 1; // a failed call still consumes the slot; never retry silently.
      const result = await generate({
        config, prompt: visualBrief.prompt, referenceImages: [],
        dataPolicy: { classification: 'PUBLIC', contains_personal_data: false, contains_face: false,
          reason: 'HABB Creative Production: public text-only background prompt, no source photo' },
        budget, journal, outputStore: safeProviderOutputStore(outputStore),
        n: 1, size: `${canvas.width}x${canvas.height}`, watermark: false, fetchImpl,
      });
      if (result?.outputs?.length !== 1) throw new Error('EXPECTED_EXACTLY_ONE_BACKGROUND');
      const bytes = await outputStore.readBytes(result.outputs[0]);
      if (!Buffer.isBuffer(bytes) || bytes.length < 24 || bytes.length > MAX_BACKGROUND_BYTES || !bytes.subarray(0, 8).equals(PNG)) {
        throw new Error('INVALID_BACKGROUND_PNG');
      }
      // The original product photo never enters this provider or output PNG.
      writeFileSync(outPath, bytes, { mode: 0o600 });
      const prepared = await prepare({ imagePath: outPath, examPath, stagePath });
      return Object.freeze({
        resolution: prepared.resolution, foreground_props: 0,
        render_backend: 'GENERATIVE_BACKGROUND', model: result.model,
        request_id: result.requestId ?? null,
        image_sha256: createHash('sha256').update(bytes).digest('hex'),
        image_cost_eur: result.costEur ?? null,
        source_photo_transmitted: false,
        visual_contract: visualBrief.contract,
      });
    },
  });
}
