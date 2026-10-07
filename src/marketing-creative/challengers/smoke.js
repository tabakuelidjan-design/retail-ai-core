import os from 'node:os';
import path from 'node:path';

import { FileArtifactStore } from '../shared/artifact-store.js';
import { assertPublicHttpsUrl } from '../shared/external-policy.js';
import { JsonlCallJournal } from '../alibaba/journal.js';
import { loadOpenAICreativeConfig } from '../openai/config.js';
import { OpenAIImageSpendGuard } from '../openai/budget.js';
import { createOpenAIProductCampaignImage } from '../openai/gpt-image.js';
import { loadRunwayCreativeConfig } from '../runway/config.js';
import { RunwayCreditGuard } from '../runway/budget.js';
import { createRunwayProductAd, createRunwayProductCampaign } from '../runway/recipes.js';

export async function runPremiumChallengerSmoke({
  productImageUrl,
  outputRoot = path.join(os.tmpdir(), 'nordla-premium-challengers'),
  openaiConfig = loadOpenAICreativeConfig(),
  runwayConfig = loadRunwayCreativeConfig(),
  fetchImpl = globalThis.fetch,
  sleep,
}) {
  const source = assertPublicHttpsUrl(productImageUrl, 'productImageUrl');
  const store = new FileArtifactStore(path.join(outputRoot, 'outputs'));
  const journal = new JsonlCallJournal(path.join(outputRoot, 'provider-calls.jsonl'));
  const dataPolicy = Object.freeze({ classification: 'PUBLIC', contains_face: false, contains_personal_data: false });

  const openai = await createOpenAIProductCampaignImage({
    config: openaiConfig,
    productImageUrl: source,
    prompt: [
      'Create a premium commercial product campaign image.',
      'Preserve the exact product identity, geometry, colors, logo and printed text.',
      'Change only the environment, lighting and supporting scene.',
      'Natural high-end retail photography, no artificial AI look.',
    ].join(' '),
    dataPolicy,
    budget: new OpenAIImageSpendGuard({ maxSpendUsd: 1, reservePerCallUsd: 1, maxCalls: 1 }),
    outputStore: store,
    journal,
    fetchImpl,
  });

  const runwayBudget = new RunwayCreditGuard({ maxCredits: 400 });
  const runwayImages = await createRunwayProductCampaign({
    config: runwayConfig,
    productImageUrl: source,
    prompt: 'Premium minimal retail campaign, natural light, precise product fidelity, clean editorial composition',
    dataPolicy,
    budget: runwayBudget,
    outputStore: store,
    journal,
    fetchImpl,
    sleep,
  });

  const runwayVideo = await createRunwayProductAd({
    config: runwayConfig,
    productImageUrls: [source],
    productInfo: 'Use the reference product exactly as supplied. Do not invent or alter logos, text, lid geometry, color, accessories or proportions.',
    userConcept: 'Natural premium retail commercial, subtle camera movement, realistic light, product-led composition, no exaggerated AI effects.',
    dataPolicy,
    budget: runwayBudget,
    outputStore: store,
    duration: 5,
    ratio: '1280:720',
    audio: false,
    journal,
    fetchImpl,
    sleep,
  });

  return Object.freeze({
    status: 'SUCCEEDED',
    openai,
    runwayImages,
    runwayVideo,
    runwayBudget: runwayBudget.snapshot(),
    outputRoot,
  });
}
