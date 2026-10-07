import os from 'node:os';
import path from 'node:path';

import { runPremiumChallengerSmoke } from './smoke.js';

const source = process.env.PREMIUM_CHALLENGER_PRODUCT_URL;
if (!source) throw new Error('PREMIUM_CHALLENGER_PRODUCT_URL is required');

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const outputRoot = path.join(os.tmpdir(), 'nordla-premium-challengers', stamp);

const result = await runPremiumChallengerSmoke({
  productImageUrl: source,
  outputRoot,
});

process.stdout.write(`${JSON.stringify({
  status: result.status,
  openai: {
    model: result.openai.model,
    output: result.openai.output,
    cost_usd: result.openai.costUsd,
    cost_complete: result.openai.costComplete,
  },
  runway_campaign: {
    outputs: result.runwayImages.outputs,
    credits: result.runwayImages.credits,
    cost_usd: result.runwayImages.costUsd,
  },
  runway_video: {
    outputs: result.runwayVideo.outputs,
    credits: result.runwayVideo.credits,
    cost_usd: result.runwayVideo.costUsd,
  },
  runway_budget: result.runwayBudget,
  output_root: outputRoot,
}, null, 2)}\n`);
