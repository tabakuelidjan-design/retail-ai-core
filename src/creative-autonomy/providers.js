// WHICH ENGINES ARE REALLY CONNECTED. Nordla never pretends: a port exists only if its provider is configured in the environment AND the owner's trial
// authorisation is present. When it is not, the port is null and the run stops honestly at the first stage that needs it (PROVIDER_NOT_CONNECTED).
// There is no silent fallback to a fake, a template or a human.
//
// Everything below REUSES the Alibaba lane as it is: createQwenBrainPort (bounded calls), createQwenVisionPort (scoped media clearance per image),
// SpendGuard (worst-case reservation BEFORE every call, BUDGET_EXCEEDED refusal), JsonlCallJournal (every call recorded, no secret).
// Vision clearance: ONE owner record for the product photo (transmissible: the source AND images derived from it, for this purpose only); each render then
// gets its own clearance bound to its exact bytes through deriveCandidateAuthorization. Without that record the critic stays NOT_CONNECTED.
import { readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { loadAlibabaCreativeConfig } from '../marketing-creative/alibaba/config.js';
import { createQwenBrainPort } from '../marketing-creative/alibaba/qwen-brain-port.js';
import { createQwenVisionPort, deriveCandidateAuthorization } from '../marketing-creative/alibaba/qwen-vision.js';
import { SpendGuard } from '../marketing-creative/alibaba/budget.js';
import { modelAllowedInScope, SCOPE } from './trial.js';

export const PROVIDER_STATE = Object.freeze({ REAL: 'REAL', TEST_DOUBLE: 'TEST_DOUBLE', NOT_CONNECTED: 'NOT_CONNECTED', NONE: 'NONE' });
export const VISION_PURPOSE = 'NORDLA_CREATIVE_CRITIQUE';

/** What the owner must authorise before Nordla can think on its own. Shown verbatim in every trace that stops for lack of a provider. */
export const WHAT_IS_NEEDED = Object.freeze({
  text: {
    provider: 'Alibaba Cloud Model Studio, région Allemagne (Francfort), espace de travail en périmètre EU',
    model: 'qwen3-vl-plus (texte + image, périmètre EU) ; qwen3.8-max n\'existe à Francfort qu\'en périmètre Global',
    env: ['ALIBABA_MODEL_STUDIO_API_KEY', 'ALIBABA_MODEL_STUDIO_WORKSPACE_ID', 'ALIBABA_QWEN_TEXT_MODEL', 'NORDLA_ALIBABA_SCOPE', 'NORDLA_TRIAL_AUTHORIZATION'],
    why: 'FRAME, IDEATE, ART_DIRECT et STAGE sont des décisions de langage : sans modèle, aucune idée ne peut naître de Nordla.',
    cost: 'voir le plan d\'essai (scripts/creative-autonomy-trial.mjs --plan) ; plafond dur 1,50 € par essai ; aucun quota gratuit à Francfort',
    authorisation: 'clé API d\'un espace EU + autorisation d\'essai liée au plan + plafond',
  },
  vision: {
    provider: 'même fournisseur, même modèle multimodal',
    env: ['NORDLA_MEDIA_AUTHORIZATION_FILE'],
    why: 'juger la force du concept sur l\'image rendue (6 dimensions) et donner des indices de révision ; les contrôles techniques restent locaux',
    authorisation: 'consentement du propriétaire pour envoyer la photo produit ET les rendus qui en dérivent, pour cette seule critique (rétention standard ≤ 30 jours, pas de ZDR)',
  },
});

const sha = (b) => createHash('sha256').update(b).digest('hex');

/**
 * @param {object} o { env, maxSpendEur, maxTextCalls, maxVisionCalls, journal, sourcePhotoBytes, fetchImpl, trialAuthorized }
 *   trialAuthorized: the caller has verified the owner's authorisation for THIS plan; without it nothing is connected, even with a key.
 */
export function connectProviders({ env = process.env, maxSpendEur = 1.5, maxTextCalls = 20, maxVisionCalls = 6, journal = null, sourcePhotoBytes = null, fetchImpl = globalThis.fetch, trialAuthorized = false, budget: sharedBudget = null } = {}) {
  const missing = [];
  let config = null;
  try { config = loadAlibabaCreativeConfig(env); } catch (error) { missing.push(`configuration Alibaba refusée : ${error.message}`); }
  const scope = env.NORDLA_ALIBABA_SCOPE ?? null;
  if (!(config?.apiKey && config?.workspaceId)) missing.push('ALIBABA_MODEL_STUDIO_API_KEY / ALIBABA_MODEL_STUDIO_WORKSPACE_ID absents');
  if (!Object.values(SCOPE).includes(scope)) missing.push('NORDLA_ALIBABA_SCOPE (EU ou GLOBAL : le périmètre de l\'espace de travail) non déclaré');
  else if (config && !modelAllowedInScope(config.textModel, scope)) missing.push(`le modèle ${config.textModel} n'est pas disponible en périmètre ${scope} à Francfort`);
  if (!trialAuthorized) missing.push('autorisation d\'essai du propriétaire absente : aucun appel payant');
  const ready = missing.length === 0;

  const budget = ready ? (sharedBudget ?? new SpendGuard({ maxSpendEur, maxImages: 0, maxVideoSeconds: 0 })) : null;
  const text = ready ? createQwenBrainPort({ config, budget, journal, maxCalls: maxTextCalls, fetchImpl }) : null;

  let visionFor = null;
  const authFile = env.NORDLA_MEDIA_AUTHORIZATION_FILE;
  if (ready && authFile && existsSync(authFile) && sourcePhotoBytes) {
    const source = JSON.parse(readFileSync(authFile, 'utf8'));
    const sourceSha = sha(sourcePhotoBytes);
    let visionCalls = 0;
    visionFor = ({ ref, bytes }) => {
      if (visionCalls >= maxVisionCalls) return null;
      visionCalls += 1;
      const authorization = deriveCandidateAuthorization({ authorization: source, source_asset_sha256: sourceSha, candidate_ref: ref, candidate_sha256: sha(bytes) });
      return createQwenVisionPort({ config, budget, journal, authorization, purpose: VISION_PURPOSE, assetRefFor: () => ref, maxCalls: 1, fetchImpl });
    };
  } else if (ready) missing.push('NORDLA_MEDIA_AUTHORIZATION_FILE absent : le critique visuel ne peut rien envoyer');

  return {
    text, visionFor, vision: null, budget, missing, scope,
    state: { text: text ? PROVIDER_STATE.REAL : PROVIDER_STATE.NOT_CONNECTED, vision: visionFor ? PROVIDER_STATE.REAL : PROVIDER_STATE.NOT_CONNECTED },
    model: { text: config?.textModel ?? null, vision: config?.textModel ?? null },
  };
}
