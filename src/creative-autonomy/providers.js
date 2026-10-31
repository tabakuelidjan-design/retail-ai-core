// WHICH ENGINES ARE REALLY CONNECTED. Nordla never pretends: a port exists only if its provider is configured in the environment. When it is not, the port is
// null and the run stops honestly at the first stage that needs it (PROVIDER_NOT_CONNECTED). There is no silent fallback to a fake, a template or a human.
//
// Text (FRAME, IDEATE, ART_DIRECT, STAGE): Alibaba Model Studio, Frankfurt lane, qwen3.8-max, through the existing createQwenBrainPort (bounded calls, bounded cost).
// Vision (concept critic): the same provider's vision lane, through createQwenVisionPort; it ALSO needs the owner's scoped authorization to send the rendered images
// (NORDLA_MEDIA_AUTHORIZATION_FILE): without it the critic is NOT_CONNECTED even when the key exists.
// Local engines (examination, Blender scene, compositor) cost nothing and are always real.
import { readFileSync, existsSync } from 'node:fs';
import { loadAlibabaCreativeConfig } from '../marketing-creative/alibaba/config.js';
import { createQwenBrainPort } from '../marketing-creative/alibaba/qwen-brain-port.js';
import { createQwenVisionPort } from '../marketing-creative/alibaba/qwen-vision.js';
import { SpendGuard } from '../marketing-creative/alibaba/budget.js';

export const PROVIDER_STATE = Object.freeze({ REAL: 'REAL', TEST_DOUBLE: 'TEST_DOUBLE', NOT_CONNECTED: 'NOT_CONNECTED', NONE: 'NONE' });

/** What the owner must authorise before Nordla can think on its own. Shown verbatim in every trace that stops for lack of a provider. */
export const WHAT_IS_NEEDED = Object.freeze({
  text: {
    provider: 'Alibaba Cloud Model Studio (région eu-central-1, Francfort)',
    model: 'qwen3.8-max',
    env: ['ALIBABA_MODEL_STUDIO_API_KEY', 'ALIBABA_MODEL_STUDIO_WORKSPACE_ID'],
    why: 'FRAME, IDEATE, ART_DIRECT et STAGE sont des décisions de langage : sans modèle, aucune idée ne peut naître de Nordla.',
    cost: 'environ 2 $ / M jetons en entrée, 6 $ / M en sortie ; un passage complet (3 concepts, 1 révision chacun) ≈ 12 appels ≈ 0,15 € à 0,30 € ; quota gratuit de 1 M jetons pendant 90 jours sur un compte neuf',
    authorisation: 'clé API déposée dans le coffre des connexions fournisseur + plafond de dépense par passage (proposé : 1,50 €)',
  },
  vision: {
    provider: 'même fournisseur, voie vision',
    env: ['ALIBABA_MODEL_STUDIO_API_KEY', 'NORDLA_MEDIA_AUTHORIZATION_FILE'],
    why: 'juger la force du concept sur l\'image rendue (6 dimensions) et donner des indices de révision ; les contrôles techniques restent locaux',
    cost: '≈ 3 000 jetons par image ; 3 à 6 images par passage ≈ 0,05 € à 0,15 €',
    authorisation: 'consentement écrit du propriétaire pour envoyer les rendus (qui contiennent la photo produit) au fournisseur, limité à cet usage',
  },
});

/**
 * @param {object} o { env, maxSpendEur, maxTextCalls, maxVisionCalls }
 * @returns {{ text: Function|null, vision: object|null, state: { text, vision }, budget: SpendGuard|null, missing: string[] }}
 */
export function connectProviders({ env = process.env, maxSpendEur = 1.5, maxTextCalls = 16, maxVisionCalls = 6, fetchImpl = globalThis.fetch } = {}) {
  const missing = [];
  let config = null;
  try { config = loadAlibabaCreativeConfig(env); } catch (error) { missing.push(`configuration Alibaba invalide : ${error.message}`); }
  const hasKey = Boolean(config?.apiKey && config?.workspaceId);
  if (!hasKey) missing.push('ALIBABA_MODEL_STUDIO_API_KEY / ALIBABA_MODEL_STUDIO_WORKSPACE_ID absents');
  const budget = hasKey ? new SpendGuard({ maxSpendEur, maxImages: 0, maxVideoSeconds: 0 }) : null;
  const text = hasKey ? createQwenBrainPort({ config, budget, maxCalls: maxTextCalls, fetchImpl }) : null;

  let vision = null;
  const authFile = env.NORDLA_MEDIA_AUTHORIZATION_FILE;
  if (hasKey && authFile && existsSync(authFile)) {
    const authorization = JSON.parse(readFileSync(authFile, 'utf8'));
    vision = createQwenVisionPort({ config, budget, authorization, purpose: 'CREATIVE_CRITIQUE', assetRefFor: (sha) => `asset://nordla/render/${sha.slice(0, 16)}`, maxCalls: maxVisionCalls, fetchImpl });
  } else if (hasKey) missing.push('NORDLA_MEDIA_AUTHORIZATION_FILE absent : le critique visuel ne peut pas envoyer les rendus');

  return {
    text, vision, budget, missing,
    state: { text: text ? PROVIDER_STATE.REAL : PROVIDER_STATE.NOT_CONNECTED, vision: vision ? PROVIDER_STATE.REAL : PROVIDER_STATE.NOT_CONNECTED },
    model: { text: config?.textModel ?? null, vision: config?.textModel ?? null },
  };
}
