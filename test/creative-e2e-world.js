// The world of the END-TO-END tests: a provider-free chain. A real-looking product photograph drawn by the test (the synthetic case of the identity world, alone on a PLAIN ground so that the general segmentation can
// cut it out), the scripted Creative Brain / asset director of the campaign world, the fake layer port of the layered world (plates and props drawn locally), the stub Guardian. No network, no provider, no cost.

import { Resvg } from '@resvg/resvg-js';

import { fullScript, campaignRequest, campaignPort } from './creative-campaign-world.js';
import { LOCKED_COPY, fakeLayerPort } from './creative-layered-runtime-world.js';
import { FONT } from './creative-production-world.js';
import { PLACE_IN_SOURCE, productSvg } from './identity-preserve-world.js';
import {
  ANNOTATIONS, GUARDIAN_PASS, buildBrief, fonts, sha,
} from './runtime-world.js';

export { FONT, GUARDIAN_PASS, fonts };

const png = (svg) => new Uint8Array(new Resvg(svg).render().asPng());
const uri = (bytes) => `data:image/png;base64,${Buffer.from(bytes).toString('base64')}`;

/** The synthetic printed case alone on a flat light ground (600 x 800), as a merchant photograph taken for a cut-out. */
export const PLAIN_PHOTO = png(`<svg xmlns="http://www.w3.org/2000/svg" width="600" height="800" viewBox="0 0 600 800"><rect width="600" height="800" fill="#d8d4cc"/><image x="${PLACE_IN_SOURCE.x}" y="${PLACE_IN_SOURCE.y}" width="300" height="500" href="${uri(png(productSvg()))}"/></svg>`);

export function e2eBrief(over = {}) {
  const base = buildBrief();
  return { ...base, asset: { ...base.asset, bytes: PLAIN_PHOTO, sha256: sha(PLAIN_PHOTO) }, identity_annotations: ANNOTATIONS, ...over };
}

/** Everything a run needs, over scripted fakes. `calls` lets a test count what was asked of each port. */
export async function e2eWorld({ assets = 4, script = null, layerPort = null, brief = null, request = null } = {}) {
  const port = campaignPort(script ?? await fullScript({ assets: 12 }));
  const layers = layerPort ?? fakeLayerPort();
  return {
    brief: brief ?? e2eBrief(),
    request: request ?? campaignRequest({ requested_asset_count: assets, requested_format: 'CAROUSEL', copy: [{ copy_ref: 'copy://body', mode: 'COPY_LOCKED', text: LOCKED_COPY }] }),
    ports: { brainComplete: port.complete, directorComplete: port.complete, layers },
    brainPort: port,
    layers,
    fonts,
    font: FONT,
    guardian: GUARDIAN_PASS,
  };
}
