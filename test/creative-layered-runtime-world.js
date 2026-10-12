// A synthetic world for the LAYERED RUNTIME tests: a planned and produced campaign (the production planner over a scripted campaign), local image fixtures (a plate, props on a plain ground) behind a FAKE layer
// port that records every call, and the real local segmenter / analyst / typography. No network, no provider, no credential, no cost: nothing here is generated, every image is drawn by the test.

import { Resvg } from '@resvg/resvg-js';

import {
  createApprovedCopyAgent, createDecisionLedger, createLocalProductSegmenter, createProductAssetAnalyst, createLayerBudget, createLayerStore,
} from '../src/creative-runtime/index.js';
import { FONT, produced } from './creative-production-world.js';
import {
  BRAND, buildBrief, fonts, GUARDIAN_PASS, sha,
} from './runtime-world.js';

export { BRAND, FONT, GUARDIAN_PASS, buildBrief, fonts, sha };

const png = (svg) => new Uint8Array(new Resvg(svg).render().asPng());
const svgOf = (w, h, body) => `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">${body}</svg>`;

/** A calm, opaque plate of the requested size: a pale gradient (the product zone has no structure). */
export const calmPlate = ({ width, height }, [top = '#eef0f2', bottom = '#d4d9de'] = []) => png(svgOf(width, height, `<defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${top}"/><stop offset="1" stop-color="${bottom}"/></linearGradient></defs><rect width="${width}" height="${height}" fill="url(#g)"/>`));
/** A plate with a hard-edged object in the middle of the frame, where the product will stand (a provider may draw one although it was asked not to). */
export const busyPlate = ({ width, height }) => png(svgOf(width, height, `<rect width="${width}" height="${height}" fill="#e6e8ea"/>${Array.from({ length: 24 }, (_, i) => `<rect x="${width * 0.25 + (i % 6) * width * 0.08}" y="${height * 0.3 + Math.floor(i / 6) * height * 0.1}" width="${width * 0.04}" height="${height * 0.05}" fill="${i % 2 ? '#202020' : '#f4f4f4'}"/>`).join('')}`));
/** A plate that is not opaque. */
export const holedPlate = ({ width, height }) => png(svgOf(width, height, `<rect width="${width / 2}" height="${height}" fill="#dddddd"/>`));

/** One object alone on a plain ground (1024 x 1024): a coloured ellipse, or a rounded stick when wide. */
export const propOnGround = ({ colour = '#7a4b2a', shape = 'ellipse', ground = '#e8e4dc', size = 1024 } = {}) => png(svgOf(size, size, `<rect width="${size}" height="${size}" fill="${ground}"/>${shape === 'ellipse' ? `<ellipse cx="${size / 2}" cy="${size / 2}" rx="${size * 0.22}" ry="${size * 0.3}" fill="${colour}"/>` : `<rect x="${size * 0.2}" y="${size * 0.4}" width="${size * 0.6}" height="${size * 0.2}" rx="30" fill="${colour}"/>`}`));
/** A prop on a ground that is not plain (a scene): a gradient with stripes along the frame. */
export const propOnBusyGround = (size = 1024) => png(svgOf(size, size, `<rect width="${size}" height="${size}" fill="#e8e4dc"/>${Array.from({ length: 16 }, (_, i) => `<rect x="${i * 64}" y="0" width="30" height="${size}" fill="${i % 2 ? '#8a7a6a' : '#c8b8a8'}"/>`).join('')}<ellipse cx="512" cy="512" rx="220" ry="300" fill="#7a4b2a"/>`));
/** Two separate objects on a plain ground. */
export const propTwoObjects = (size = 1024) => png(svgOf(size, size, `<rect width="${size}" height="${size}" fill="#e8e4dc"/><ellipse cx="300" cy="512" rx="120" ry="200" fill="#7a4b2a"/><ellipse cx="740" cy="512" rx="120" ry="200" fill="#2a4b7a"/>`));
/** An object that runs off the frame. */
export const propTouchingFrame = (size = 1024) => png(svgOf(size, size, `<rect width="${size}" height="${size}" fill="#e8e4dc"/><ellipse cx="512" cy="512" rx="560" ry="300" fill="#7a4b2a"/>`));
/** A ground with nothing on it. */
export const emptyGround = (size = 1024) => png(svgOf(size, size, `<rect width="${size}" height="${size}" fill="#e8e4dc"/>`));

/**
 * A fake LAYER port: it answers each request from the scripted fixtures and records every call (with a global sequence number, so a test can say what happened before what). `executes` declares the tool it
 * implements for each provider capability (by default the tool the specifications select).
 */
export function fakeLayerPort({
  plate = (size) => calmPlate(size), prop = () => propOnGround(), executes = null, live = false, sequence = { n: 0 },
} = {}) {
  const calls = [];
  return {
    calls,
    live,
    executes: executes ?? { ENVIRONMENT_PLATE_GENERATION: 'text-to-image/primary', PROP_ON_PLAIN_GROUND_GENERATION: 'text-to-image/primary' },
    async generate({ request, expected_size: size, candidate_index: candidateIndex = 1 }) {
      sequence.n += 1;
      calls.push({ seq: sequence.n, kind: request.kind, request_key: request.request_key, candidate_index: candidateIndex, input_asset_refs: request.input_asset_refs, carries_input_asset: request.carries_input_asset, prompt: request.prompt });
      const custom = request.kind === 'PLATE' ? plate(size, { candidate_index: candidateIndex, request }) : prop({ candidate_index: candidateIndex, request });
      return { output_bytes: custom, provenance: { provider_id: 'fake-layer-provider', model: 'fake', region: 'test', request_id: `layer-req-${calls.length}`, lane: request.kind, carries_input_asset: false, sha256: sha(custom) } };
    },
  };
}

/** The campaign of the layered tests: a carousel over short locked copy, so that the first scene is a headline scene with a background prop and later scenes carry body text. */
export const LOCKED_COPY = 'Un souvenir que l’on garde pour toujours. Une coque faite pour durer. Chaque photo trouve sa place. Un cadeau qui ressemble à ceux que l’on aime.';

export async function layeredWorld({
  assets = 4, copy = LOCKED_COPY, art = {}, options = {}, ceilingEur,
} = {}) {
  const brief = buildBrief();
  const base = await produced({
    assets, art, ceilingEur, requestOver: { requested_format: 'CAROUSEL', copy: [{ copy_ref: 'copy://body', mode: 'COPY_LOCKED', text: copy }] }, ...options,
  }, { font: FONT, bytes: brief.asset.bytes, productionBrief: brief });
  return { ...base, brief };
}

/** The agents and ports of a layered run, over a fresh ledger. */
export function layeredHarness({ layerPort = fakeLayerPort(), ledger = createDecisionLedger() } = {}) {
  return {
    ledger,
    agents: { analyst: createProductAssetAnalyst({ ledger, expression: BRAND.expression }), copy: createApprovedCopyAgent({ ledger }) },
    ports: { segmenter: createLocalProductSegmenter({ ledger }), layers: layerPort },
    layerPort,
  };
}

export const AT = '2026-10-12T12:00:00.000Z';
export { createLayerBudget, createLayerStore };
