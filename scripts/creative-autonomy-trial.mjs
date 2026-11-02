// THE FIRST REAL TRIAL OF NORDLA'S CREATIVE AUTONOMY: one product, one model, one hard ceiling, one attempt.
//
//   node scripts/creative-autonomy-trial.mjs --plan    --out <dir> --product gourde-noire --photo <file>     (no network, no cost)
//   node scripts/creative-autonomy-trial.mjs --execute --out <dir> --product gourde-noire --photo <file>     (refused unless every gate below passes)
//   ... --scene   PREMIUM PATH (Creative Production V1): Nordla's SELECTED concept only; ONE image edit (qwen-image-3.0-pro, GLOBAL scope, n = 3 variants) builds
//                 the scene AROUND a plate made from the real photo; the authentic pixels are restored locally; text from the verified Shopify facts; 0.50 EUR ceiling.
//                 Extra gates: an IMAGE workspace key (GLOBAL scope), the owner's NORDLA_SCENE_MEDIA_AUTHORIZATION_FILE (purpose NORDLA_SCENE_PRODUCTION, IMAGE_EDIT,
//                 derived images), and the provider's free model list showing qwen-image-3.0-pro in that workspace.
//
// Gates for --execute: the key from the environment or from a secrets file OUTSIDE any git work tree with mode 600 (never printed, never written);
// NORDLA_TRIAL_AUTHORIZATION equal to the plan id (bound to model, scope, region, limits, product and the photo's SHA-256); NORDLA_PHOTO_RIGHTS=OWNER_CONFIRMED;
// output folder outside any git work tree; the one-attempt lock; the provider's free model list showing the model. Then ONE SpendGuard of 1.50 EUR for every call.
//
// Three money figures are kept apart:
//   ESTIMATE   the forecast below, at the model's list price, from measured prompt sizes
//   CEILING    the application cap: the SpendGuard reserves each call's worst case BEFORE sending it and refuses past 1.50 EUR. It prices every call at the
//              qwen3.8-max rate with USD = EUR, so its ledger runs HIGHER than the real cost: it is a safety ledger, not a bill
//   USAGE      after the run: the tokens Alibaba reports in each response, priced at the qwen3-vl-plus list price. The INVOICE itself is only in the Alibaba
//              console (Billing), which this script cannot read: it is the one figure to check by hand
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, statSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { tmpdir, homedir, userInfo } from 'node:os';
import { createHash } from 'node:crypto';
import { runAutonomous, localEngines } from '../src/creative-autonomy/run.js';
import { connectProviders, worstCaseCallEur, VISION_MAX_TOKENS, VISION_PURPOSE } from '../src/creative-autonomy/providers.js';
import { VISION_OPERATION } from '../src/marketing-creative/alibaba/qwen-vision.js';
import { BRAIN_PORT_LIMITS } from '../src/marketing-creative/alibaba/qwen-brain-port.js';

import { FRANKFURT_CATALOGUE, RECOMMENDED, TRIAL_LIMITS, trialPlanId, forecastCost, modelAllowedInScope, briefBinding, modelListUrl, providerConfirmsModel, codeFingerprint, secretsFileProblems, runtimeInjections } from '../src/creative-autonomy/trial.js';
import { loadAlibabaCreativeConfig } from '../src/marketing-creative/alibaba/config.js';
import { SpendGuard, priceImagesEur } from '../src/marketing-creative/alibaba/budget.js';
import { JsonlCallJournal } from '../src/marketing-creative/alibaba/journal.js';
import { takeLiveCallLock } from '../src/marketing-creative/alibaba/live-call-lock.js';
import { buildConceptCriticInstruction } from '../src/creative-brain/concept-critic.js';
import { createSceneEngine, SCENE_PURPOSE, SCENE_DEFAULTS } from '../src/creative-autonomy/scene-engine.js';
import { assessScopedExternalMediaUse } from '../src/marketing-creative/alibaba/scoped-media-authorization.js';
import { FileOutputStore } from '../src/marketing-creative/alibaba/output-store.js';
import { IMAGE_EDIT_MODEL, IMAGE_EDIT_PROVIDER_ID } from '../src/marketing-creative/alibaba/qwen-image-edit.js';
import { normalizeConceptSet } from '../src/creative-brain/concept.js';
// SIZING ONLY: generic invented answers of the test world, used to measure prompt sizes. They never reach the owner.
import { frameAnswer, CONCEPTS, artDirectionAnswer, evaluationsAnswer } from '../test/creative-brain-world.js';
import { loadMerchantCreativeBrand as __loadBrand, resolveBrandProfile as __resolveProfile, artDirectionHintFor as __hintFor } from '../src/creative-autonomy/brand-profile.js';
const HABB_BRAND = __loadBrand('habb'); // HABB is tenant configuration (config/merchants/habb/creative-brand.json)
const HABB = __resolveProfile(HABB_BRAND);

const argv = process.argv.slice(2);
const mode = argv.includes('--execute') ? 'execute' : 'plan';
// --ideation: text only. No photograph is read, examined, rendered or sent; Nordla frames, imagines 3 concepts, art-directs and stages them in words. NOT a visual production.
const ideation = argv.includes('--ideation');
// --scene: the premium path (see the header). Exclusive with --ideation.
const scene = argv.includes('--scene');
if (scene && ideation) throw new Error('--scene and --ideation are exclusive');
const arg = (k, d = null) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : d; };
const outDir = resolve(arg('out', mkdtempSync(join(tmpdir(), 'nordla-trial-'))));
const productKey = arg('product', 'gourde-noire');
const photoPath = arg('photo');
const snap = (f) => JSON.parse(readFileSync(new URL(`../test/fixtures/creative-autonomy/${f}`, import.meta.url), 'utf8'));
const CATALOG = {
  'gourde-noire': { snap: 'shopify-gourde-tyeso.json', variant: 'Noir', objective: 'Donner envie aux habitants de Namur de découvrir la gourde TYESO noire chez HABB' },
  // first premium benchmark (owner approval 2026-11-02: photo rights for this benchmark, 0,50 EUR maximum); Shopify read-only snapshot of 2026-11-02
  'batterie-noire': { snap: 'shopify-batterie-mini-noir.json', variant: 'Noir / 10000mAh', objective: 'Faire découvrir la batterie Mini noire aux clients qui voyagent et passent la journée dehors' },
  'coque-iphone12': { snap: 'shopify-coque-iphone12.json', variant: null, objective: 'Faire commander des coques iPhone 12 personnalisées pour les cadeaux de fin d\'année' },
};
if (!CATALOG[productKey]) throw new Error(`unknown product ${productKey}`);
if (!ideation && (!photoPath || !existsSync(photoPath))) throw new Error('--photo <file> is required (or --ideation for a text-only trial)');
const P = { key: productKey, ...CATALOG[productKey], snap: snap(CATALOG[productKey].snap) };
const photoBytes = ideation ? null : readFileSync(photoPath);
const photoSha = ideation ? null : createHash('sha256').update(photoBytes).digest('hex');

// ---- secrets: from the environment, or from a file outside any git work tree with mode 600. Values are never printed or written.
function insideGitWorkTree(p) { let d = resolve(p); for (;;) { if (existsSync(join(d, '.git'))) return d; const up = dirname(d); if (up === d) return null; d = up; } }
function loadSecrets() {
  const file = process.env.NORDLA_ALIBABA_SECRETS_FILE;
  if (!file) return { source: process.env.ALIBABA_MODEL_STUDIO_API_KEY ? 'environment' : 'none', values: {} };
  const problems = secretsFileProblems({ exists: existsSync(file), platform: process.platform, mode: existsSync(file) ? statSync(file).mode : 0, insideGitRepo: existsSync(file) && Boolean(insideGitWorkTree(file)) });
  if (problems.length) return { source: 'file', values: {}, problems };
  const values = {};
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const m = /^\s*(ALIBABA_MODEL_STUDIO_API_KEY|ALIBABA_MODEL_STUDIO_WORKSPACE_ID|ALIBABA_MODEL_STUDIO_IMAGE_API_KEY|ALIBABA_MODEL_STUDIO_IMAGE_WORKSPACE_ID)\s*=\s*(\S+)\s*$/.exec(line);
    if (m) values[m[1]] = m[2];
  }
  return { source: 'file', values };
}
const secrets = loadSecrets();
const env = { ...process.env, ...secrets.values, ALIBABA_QWEN_TEXT_MODEL: process.env.ALIBABA_QWEN_TEXT_MODEL || RECOMMENDED.model, NORDLA_ALIBABA_SCOPE: process.env.NORDLA_ALIBABA_SCOPE || RECOMMENDED.scope };
const model = env.ALIBABA_QWEN_TEXT_MODEL;
const scope = env.NORDLA_ALIBABA_SCOPE;
const rights = process.env.NORDLA_PHOTO_RIGHTS || 'UNVERIFIED';
// SCENE: the image model runs in a GLOBAL-scope workspace (Frankfurt serves qwen-image-3.0-pro in GLOBAL scope only); its key and workspace may differ from the text ones
const imageEnv = { ...env, ALIBABA_MODEL_STUDIO_API_KEY: env.ALIBABA_MODEL_STUDIO_IMAGE_API_KEY || env.ALIBABA_MODEL_STUDIO_API_KEY, ALIBABA_MODEL_STUDIO_WORKSPACE_ID: env.ALIBABA_MODEL_STUDIO_IMAGE_WORKSPACE_ID || env.ALIBABA_MODEL_STUDIO_WORKSPACE_ID, ALIBABA_QWEN_IMAGE_MODEL: IMAGE_EDIT_MODEL };
function sceneMediaRecord() {
  const file = process.env.NORDLA_SCENE_MEDIA_AUTHORIZATION_FILE;
  if (!file || !existsSync(file)) return { record: null, problem: 'absente' };
  let record; try { record = JSON.parse(readFileSync(file, 'utf8')); } catch { return { record: null, problem: 'illisible' }; }
  const a = assessScopedExternalMediaUse({ authorization: record, asset: { ref: record?.asset?.asset_ref, sha256: photoSha }, provider_id: IMAGE_EDIT_PROVIDER_ID, region: 'eu-central-1', purpose: SCENE_PURPOSE, operation: 'IMAGE_EDIT' });
  if (!a.allowed) return { record: null, problem: a.reason };
  if (record.transmissible !== 'THE_SOURCE_ASSET_AND_IMAGES_DERIVED_FROM_IT_FOR_THIS_PURPOSE_ONLY') return { record: null, problem: 'les images dérivées (la plaque) ne sont pas couvertes' };
  return { record, problem: null };
}
// The critic needs a SECOND, distinct owner authorization. A mere file path is not consent.
// Its sole purpose is to send the final rendered scene to the EU-scope visual model.
function criticMediaRecord() {
  const file = process.env.NORDLA_MEDIA_AUTHORIZATION_FILE;
  if (!file || !existsSync(file)) return { record: null, problem: 'absente' };
  let record; try { record = JSON.parse(readFileSync(file, 'utf8')); } catch { return { record: null, problem: 'illisible' }; }
  const a = assessScopedExternalMediaUse({ authorization: record,
    asset: { ref: record?.asset?.asset_ref, sha256: photoSha },
    provider_id: IMAGE_EDIT_PROVIDER_ID, region: 'eu-central-1', purpose: VISION_PURPOSE, operation: VISION_OPERATION });
  if (!a.allowed) return { record: null, problem: a.reason };
  if (record.transmissible !== 'THE_SOURCE_ASSET_AND_IMAGES_DERIVED_FROM_IT_FOR_THIS_PURPOSE_ONLY')
    return { record: null, problem: 'les rendus dérivés ne sont pas couverts' };
  return { record, problem: null };
}
// what Nordla is ASKED is part of what the owner authorises: objective, product snapshot, variant, format and brand rules are bound to the plan id
const BRIEF_BINDING = briefBinding({ snapshot: P.snap, variant: P.variant, objective: P.objective, format: 'INSTAGRAM_FEED_4_5', brand: HABB_BRAND });
// max_repair_calls: contract repairs (one more call of the SAME stage with the exact violation), part of what the owner authorises; 0 = none
const MAX_REPAIR_CALLS = 2;
// the call cap equals the worst case shown to the owner: 9 planned calls + every authorised repair (protocol re-asks included)
const IDEATION_LIMITS = { mode: 'IDEATION_ONLY', max_spend_eur: TRIAL_LIMITS.max_spend_eur, max_text_calls_per_product: 9 + MAX_REPAIR_CALLS, max_repair_calls: MAX_REPAIR_CALLS, max_vision_calls_per_product: 0, max_output_tokens_per_text_call: TRIAL_LIMITS.max_output_tokens_per_text_call, images_sent: 0, attempts: 1 };
// the code that a live attempt would execute is part of the plan (CRLF-normalised: same fingerprint on Windows and Linux)
const CODE = codeFingerprint();
// SCENE: FRAME, IDEATE, SELECT, then ART_DIRECT + STAGE of the selected concept only (5 calls) + the authorised repairs; ONE critique; ONE image edit with n variants.
// Everything that decides what is sent and what it may cost is in the plan: image model, its GLOBAL scope, variants, size, the reference image, the 0.50 EUR ceiling.
const SCENE_TRIAL = Object.freeze({
  max_spend_eur: 0.5, max_text_calls_per_product: 5 + MAX_REPAIR_CALLS, max_vision_calls_per_product: 1,
  image: Object.freeze({ provider: IMAGE_EDIT_PROVIDER_ID, model: IMAGE_EDIT_MODEL, scope: 'GLOBAL', region: 'eu-central-1', calls: SCENE_DEFAULTS.image_calls, variants: SCENE_DEFAULTS.variants, size: '1080*1350', reference_images: 1, sent: 'ONE_PLATE_DERIVED_FROM_THE_PHOTO (the cut-out product on a neutral grey canvas)' }),
});
const products = [`${P.snap.product.id}${P.variant ? ` (variant ${P.variant})` : ''}`];
const limits0 = ideation
  ? { ...IDEATION_LIMITS, products, brief: BRIEF_BINDING }
  : scene
    ? { mode: 'SCENE_AROUND_PRODUCT', max_spend_eur: SCENE_TRIAL.max_spend_eur, max_text_calls_per_product: SCENE_TRIAL.max_text_calls_per_product, max_repair_calls: MAX_REPAIR_CALLS, max_vision_calls_per_product: SCENE_TRIAL.max_vision_calls_per_product,
      max_output_tokens_per_text_call: TRIAL_LIMITS.max_output_tokens_per_text_call, max_output_tokens_per_vision_call: TRIAL_LIMITS.max_output_tokens_per_vision_call,
      image: SCENE_TRIAL.image, produce: 'SELECTED_CONCEPT_ONLY', refine: 'TEXT_PLACEMENT_ONLY_NO_NEW_IMAGE', attempts: 1, products, photo_sha256: photoSha, brief: BRIEF_BINDING }
    : { ...TRIAL_LIMITS, max_repair_calls: MAX_REPAIR_CALLS, mode: 'FULL', products, photo_sha256: photoSha, brief: BRIEF_BINDING };
// ONE attempt per plan on this machine, whatever --out is (the lock in the output folder alone could be bypassed by choosing another folder).
// Its location is part of the plan: overriding it (NORDLA_ATTEMPT_REGISTRY, used by tests) gives ANOTHER plan id, which the owner's authorisation does not match.
const registryOverride = process.env.NORDLA_ATTEMPT_REGISTRY || null;
// the ACCOUNT's home from the OS (passwd on POSIX, the user profile of the process token on Windows), not $HOME / %USERPROFILE%, which are plain variables
const userHome = (() => { try { return userInfo().homedir || homedir(); } catch { return homedir(); } })();
const registryDir = resolve(registryOverride || join(userHome, '.nordla', 'attempt-locks'));
const limits = {
  ...limits0, code_sha256: CODE.code_sha256,
  attempt_registry: registryOverride ? `OVERRIDE:${createHash('sha256').update(registryDir).digest('hex').slice(0, 16)}` : 'DEFAULT_USER_HOME',
  runtime_injections: runtimeInjections(), // --import / --require / NODE_OPTIONS: none in a real run
};
const planId = trialPlanId({ model, scope, limits });
const registryLock = join(registryDir, `${planId}.lock`);

const inputFor = () => ({ product: P.snap.product, variantTitle: P.variant, readAt: P.snap.read_at, objective: P.objective, brand: HABB_BRAND, format: 'INSTAGRAM_FEED_4_5', photoPath,
  photoMeta: { media_type: photoPath?.endsWith('.png') ? 'image/png' : 'image/jpeg', width_px: null, height_px: null, origin: 'SUPPLIER_IMAGE_OR_UNKNOWN', rights_class: rights === 'OWNER_CONFIRMED' ? 'LICENSED' : 'UNKNOWN' } });

// ---- preflight: presence only, never values
function preflight() {
  const checks = [];
  const ok = (name, pass, detail) => checks.push({ name, pass, detail });
  ok('clé API', Boolean(env.ALIBABA_MODEL_STUDIO_API_KEY), env.ALIBABA_MODEL_STUDIO_API_KEY ? `présente (${secrets.source}, non affichée)` : 'absente');
  ok('workspace Francfort', Boolean(env.ALIBABA_MODEL_STUDIO_WORKSPACE_ID), env.ALIBABA_MODEL_STUDIO_WORKSPACE_ID ? 'présent' : 'absent');
  for (const p of secrets.problems ?? []) ok('fichier de secrets', false, p);
  ok('région', (env.ALIBABA_MODEL_STUDIO_REGION || 'eu-central-1') === 'eu-central-1', env.ALIBABA_MODEL_STUDIO_REGION || 'eu-central-1');
  ok(`${model} servi en périmètre ${scope} à Francfort`, modelAllowedInScope(model, scope), FRANKFURT_CATALOGUE.models[model]?.note ?? 'modèle inconnu du catalogue');
  let cfgError = null; try { loadAlibabaCreativeConfig(env); } catch (e) { cfgError = e.message; }
  ok('modèle accepté par le lane Alibaba', !cfgError, cfgError ?? 'accepté');
  if (!ideation) ok('droits de la photo', rights === 'OWNER_CONFIRMED', rights === 'OWNER_CONFIRMED' ? 'confirmés par le propriétaire' : `${rights} : aucune image ne part, aucun essai`);
  if (!ideation && !scene) ok('autorisation média (photo + rendus dérivés)', Boolean(env.NORDLA_MEDIA_AUTHORIZATION_FILE), env.NORDLA_MEDIA_AUTHORIZATION_FILE ? 'fichier présent' : 'absente : le critique visuel restera non connecté');
  if (scene) {
    ok('critique visuel multimodal dans un périmètre EU déclaré', scope === 'EU' && FRANKFURT_CATALOGUE.models[model]?.input?.includes('image') === true,
      `modèle ${model}, périmètre déclaré ${scope} : exigence EU + modèle acceptant les images`);
    ok('clé API de l\'espace image', Boolean(imageEnv.ALIBABA_MODEL_STUDIO_API_KEY), imageEnv.ALIBABA_MODEL_STUDIO_API_KEY ? `présente (${env.ALIBABA_MODEL_STUDIO_IMAGE_API_KEY ? 'clé image dédiée' : 'même clé que le texte'}, non affichée)` : 'absente');
    ok('espace de travail image (périmètre Global, Francfort)', Boolean(imageEnv.ALIBABA_MODEL_STUDIO_WORKSPACE_ID), imageEnv.ALIBABA_MODEL_STUDIO_WORKSPACE_ID ? (env.ALIBABA_MODEL_STUDIO_IMAGE_WORKSPACE_ID ? 'dédié' : 'même espace que le texte : il doit servir qwen-image-3.0-pro (vérifié gratuitement avant toute dépense)') : 'absent');
    const media = sceneMediaRecord();
    ok('autorisation média de la scène (plaque dérivée de la photo, édition, Global)', !media.problem, media.problem ? `${media.problem} : aucune photo ne part` : 'conforme à CETTE photo');
    const criticMedia = criticMediaRecord();
    ok('autorisation distincte pour critique visuelle (rendu dérivé, EU)', !criticMedia.problem,
      criticMedia.problem ? `${criticMedia.problem} : aucun essai scène n'est autorisé sans critique visuelle` : 'conforme à CETTE photo et au but de critique');
  }
  ok('aucune tentative antérieure de ce plan sur cette machine', !existsSync(registryLock), existsSync(registryLock) ? `déjà tentée (${registryLock}) : un nouvel essai demande un nouveau plan` : `registre : ${registryDir}`);
  ok('registre des tentatives hors dépôt git', !insideGitWorkTree(registryDir), insideGitWorkTree(registryDir) ? 'refusé' : 'ok');
  ok('dossier de sortie hors dépôt git', !insideGitWorkTree(outDir), insideGitWorkTree(outDir) ? 'refusé : les traces ne doivent pas finir dans GitHub' : 'ok');
  ok('autorisation d\'essai pour CE plan', env.NORDLA_TRIAL_AUTHORIZATION === planId, env.NORDLA_TRIAL_AUTHORIZATION ? (env.NORDLA_TRIAL_AUTHORIZATION === planId ? 'conforme' : 'ne correspond pas au plan') : 'absente');
  return checks;
}

// ---- sizing: the real instructions of a full run, measured (no network)
async function sizing() {
  const calls = [];
  const complete = async ({ system, user }) => {
    const stage = system.includes('problem framer') ? 'FRAME' : system.includes('concept director') ? 'IDEATE' : system.includes('concept selector') ? 'SELECT' : system.includes('art director') ? 'ART_DIRECT' : 'STAGE';
    const c = stage === 'ART_DIRECT' || stage === 'STAGE' ? JSON.parse(user).concept : null;
    // scene sizing needs a selected concept (one art direction, one stage); the others size the full route
    const body = stage === 'FRAME' ? frameAnswer() : stage === 'IDEATE' ? { concepts: CONCEPTS } : stage === 'SELECT' ? evaluationsAnswer(normalizeConceptSet(CONCEPTS), scene ? [{}, { DISTINCTIVENESS: 'PARTIAL' }, { DISTINCTIVENESS: 'PARTIAL' }] : [])
      : stage === 'ART_DIRECT' ? artDirectionAnswer({ narrative_elements: [{ element: 'one element of the set', reason: c.visual_metaphor, zone: 'BACKGROUND' }, { element: 'a second element', reason: c.story, zone: 'FOREGROUND' }] })
        : { backdrop: 'SEAMLESS_SWEEP', backdrop_tone: 'CHARCOAL', floor_finish: 'SATIN', key_light: { kind: 'STRIP', side: 'LEFT', intensity: 'MEDIUM', temperature: 'NEUTRAL', purpose: 'sizing' }, accent_lights: [], camera: { height: 'PRODUCT_CENTER', framing: 'MEDIUM', product_position: 'LEFT_THIRD' }, props: [{ shape: 'BLOCK', material: 'CONCRETE', placement: 'BESIDE_RIGHT', scale: 'LOW', reason: c.visual_metaphor }], headline: 'Sizing', text_placement: 'RIGHT_COLUMN', show_price: 'YES', rationale: 'sizing' };
    const text = JSON.stringify(body);
    calls.push({ kind: 'TEXT', stage, input_chars: system.length + user.length, input_bytes: Buffer.byteLength(system + user, 'utf8'), expected_output_chars: Math.ceil(text.length * 1.5) });
    return { text, model: 'SIZING_DOUBLE', request_id: null, cost_eur: 0 };
  };
  const fake = { name: { render: 'sizing', compose: 'sizing' },
    examine: async () => ({ status: 'CUT_OUT' }), render: async ({ outPath }) => { writeFileSync(outPath, 'x'); return { resolution: [1, 1], foreground_props: 0 }; },
    compose: async ({ outPath }) => { writeFileSync(outPath, 'x'); return { fidelity: { max_level_difference_after_removing_layers: 0 }, technical: { defects: [], text_contrast_ratio: 21, product_height_share: 0.5 }, text_used: { facts_lines: [] } }; } };
  const tmpPhoto = join(mkdtempSync(join(tmpdir(), 'sz-')), 'p.jpg'); writeFileSync(tmpPhoto, 'sizing');
  await runAutonomous({ mode: ideation ? 'IDEATION_ONLY' : 'FULL', produce: scene ? 'SELECTED' : 'ALL', input: { ...inputFor(), photoPath: tmpPhoto }, ports: { text: complete, vision: null, state: { text: 'TEST_DOUBLE', vision: 'NOT_CONNECTED' } }, engines: fake, workdir: mkdtempSync(join(tmpdir(), 'sz-')) });
  // the authorised contract repairs, priced as the largest stage call (worst case: all of them used)
  const biggest = calls.reduce((a, c) => (c.input_chars > a.input_chars ? c : a), calls[0]);
  for (let i = 0; i < MAX_REPAIR_CALLS; i += 1) calls.push({ ...biggest, stage: 'REPAIR' });
  if (ideation) return calls; // FRAME, IDEATE, SELECT, 3 ART_DIRECT, 3 STAGE + up to 2 repairs: no refinement (nothing is rendered), no critique (no image)
  if (scene) {
    // no LLM refinement in scene mode (the paid scene is fixed; only the text may move, deterministically); ONE critique of the finished image
    const critic = buildConceptCriticInstruction({ brief: {} });
    calls.push({ kind: 'VISION', stage: 'CRITIC', input_chars: critic.system.length + critic.user.length + 400, input_bytes: Buffer.byteLength(critic.system + critic.user, 'utf8') + 400, expected_output_chars: 2400, images: 1 });
    return calls;
  }
  const stageCall = calls.find((c) => c.stage === 'STAGE');
  for (let i = 0; i < normalizeConceptSet(CONCEPTS).length * 2; i += 1) calls.push({ ...stageCall, stage: 'REFINE' });
  const critic = buildConceptCriticInstruction({ brief: {} });
  // a 540 x 675 render is about 360 image tokens (1 per 32 x 32 px); 1 000 are counted
  for (let i = 0; i < TRIAL_LIMITS.max_vision_calls_per_product; i += 1) calls.push({ kind: 'VISION', stage: 'CRITIC', input_chars: critic.system.length + critic.user.length + 400, input_bytes: Buffer.byteLength(critic.system + critic.user, 'utf8') + 400, expected_output_chars: 2400, images: 1 });
  return calls;
}

const checks = preflight();
const calls = await sizing();
const forecast = forecastCost({ calls, model, imageTokens: 1000 });
// the vision port books 3 000 image tokens per image: the ledger figure uses the same rule
const ledger = forecastCost({ calls, model, imageTokens: 3000 });
// the settlement guard's provable maximum for the whole plan (bytes as tokens + template overhead, every output at its cap, images at >= 3 000 tokens), ledger prices
const PNG_1080x1350 = Buffer.alloc(24); PNG_1080x1350.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13], 0); PNG_1080x1350.write('IHDR', 12, 'latin1'); PNG_1080x1350.writeUInt32BE(1080, 16); PNG_1080x1350.writeUInt32BE(1350, 20);
// the scene's image call: n variants + the reference image, at the Frankfurt list price (USD); the ledger counts USD = EUR, the estimate converts at 0.92
const imageUsd = scene ? priceImagesEur({ n: SCENE_TRIAL.image.variants, size: '1080x1350', usdToEur: 1, inputImages: SCENE_TRIAL.image.reference_images }) : 0;
const provableMax = Math.round((calls.reduce((n, c) => n + worstCaseCallEur({ texts: ['x'.repeat(c.input_bytes ?? c.input_chars * 2)], images: c.images ? [PNG_1080x1350] : [], maxOutputTokens: c.kind === 'VISION' ? VISION_MAX_TOKENS : BRAIN_PORT_LIMITS.max_output_tokens, usdToEur: 1 }).eur, 0) + imageUsd) * 10000) / 10000;
const ceiling = scene ? SCENE_TRIAL.max_spend_eur : TRIAL_LIMITS.max_spend_eur;
const plan = {
  plan_id: planId, code_sha256: CODE.code_sha256, code_files: CODE.files, attempt_registry: registryDir, runtime_injections: limits.runtime_injections.length, objective: P.objective, mode: ideation ? 'IDEATION_ONLY (texte seulement, aucune image, PAS une production visuelle)' : scene ? 'SCENE_AROUND_PRODUCT (concept sélectionné par Nordla, une scène générée autour du vrai produit, pixels authentiques restaurés)' : 'FULL', product: productKey, model, scope, region: 'eu-central-1', photo_sha256: photoSha, photo_rights: rights,
  ...(scene ? { image: { ...SCENE_TRIAL.image, workspace: env.ALIBABA_MODEL_STUDIO_IMAGE_WORKSPACE_ID ? 'DEDICATED_IMAGE_WORKSPACE' : 'SAME_WORKSPACE_AS_TEXT' } } : {}),
  limits, catalogue_verified_at: FRANKFURT_CATALOGUE.verified_at, preflight: checks,
  calls_by_stage: calls.reduce((a, c) => ({ ...a, [c.stage]: (a[c.stage] ?? 0) + 1 }), {}),
  money: {
    ESTIMATE_expected_eur: Math.round((forecast.expected_eur + imageUsd * 0.92) * 10000) / 10000,
    ESTIMATE_worst_case_eur: Math.round((forecast.worst_case_eur + imageUsd * 0.92) * 10000) / 10000,
    ...(scene ? { ESTIMATE_parts: { text_and_critique_expected_eur: forecast.expected_eur, text_and_critique_worst_eur: forecast.worst_case_eur, image_call_usd: Math.round(imageUsd * 1e6) / 1e6, image_call_detail: `${SCENE_TRIAL.image.variants} x ${priceImagesEur({ n: 1, size: '1080x1350' })} USD (1K) + ${SCENE_TRIAL.image.reference_images} x reference image` } } : {}),
    CEILING_application_eur: ceiling,
    CEILING_ledger_max_reserved_eur: Math.round((ledger.spendguard_reserved_eur + imageUsd) * 10000) / 10000,
    CEILING_provable_max_ledger_eur: provableMax, // what the ledger could reach at most if every call happened; the settlement guard refuses any call past the ceiling
    CEILING_provable_max_fits: provableMax <= ceiling,
    USAGE_and_INVOICE: 'après l\'essai seulement : usage déclaré par Alibaba dans chaque réponse (calculé par ce script) ; facture réelle dans la console Alibaba, à vérifier à la main',
  },
};
if (mode === 'plan') {
  mkdirSync(outDir, { recursive: true }); writeFileSync(join(outDir, `${planId}.plan.json`), JSON.stringify(plan, null, 1));
  if (scene) {
    // a TEMPLATE of the owner's media record for THIS photo. It is written REVOKED: it authorises nothing until the owner reads it, sets "revoked": false and points
    // NORDLA_SCENE_MEDIA_AUTHORIZATION_FILE at it. Nothing in the code flips it.
    const sceneAuthTemplate = {
      kind: 'EXTERNAL_MEDIA_AUTHORIZATION', authorization_id: `authz://habb/scene/${photoSha.slice(0, 16)}`,
      purpose_note: 'Nordla Creative Production V1 : envoyer UNE plaque (le produit détouré de cette photo, sur fond gris) à Alibaba qwen-image-3.0-pro, espace Francfort en périmètre GLOBAL (traitement possible hors UE), pour générer la scène autour du produit. Aucune personne, aucun visage.',
      asset: { asset_ref: `asset://habb/${productKey}/${photoSha.slice(0, 16)}`, asset_sha256: photoSha, data_class: 'MERCHANT_PRIVATE_MEDIA', contains_personal_data: false, contains_face: false },
      provider: { provider_id: IMAGE_EDIT_PROVIDER_ID, region: 'eu-central-1' }, purpose: SCENE_PURPOSE, allowed_operations: ['IMAGE_EDIT'],
      transmissible: 'THE_SOURCE_ASSET_AND_IMAGES_DERIVED_FROM_IT_FOR_THIS_PURPOSE_ONLY',
      retention: { standard_inference_retention_days_max: 30, zdr_status: 'NOT_CONFIRMED', zdr_claimed: false, zdr_evidence_ref: null, acknowledged: true },
      authorization: { revoked: true }, state: {}, global_policy: { changed_by_this_record: false },
    };
    writeFileSync(join(outDir, 'scene-media-authorization.TEMPLATE.json'), JSON.stringify(sceneAuthTemplate, null, 1));
    // Independent permission for the final image to be reviewed by the EU visual critic.
    // Both templates are REVOKED by default: an owner must explicitly enable each one.
    writeFileSync(join(outDir, 'scene-critic-authorization.TEMPLATE.json'), JSON.stringify({
      ...sceneAuthTemplate, authorization_id: `authz://habb/critic/${photoSha.slice(0, 16)}`,
      purpose_note: 'Nordla Creative Production V1 : envoyer le rendu final contenant la photo de cette gourde à Alibaba qwen3-vl-plus, espace Francfort en périmètre EU, uniquement pour une critique visuelle. Aucune personne, aucun visage.',
      purpose: VISION_PURPOSE, allowed_operations: [VISION_OPERATION],
    }, null, 1));
  }
  console.log(JSON.stringify(plan, null, 1)); process.exit(0);
}

// ================= EXECUTE =================
const failed = checks.filter((c) => !c.pass && c.name !== 'autorisation média (photo + rendus dérivés)');
if (failed.length) { console.error(JSON.stringify({ refused: 'PREFLIGHT_FAILED', failed }, null, 1)); process.exit(2); }
mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, `${planId}.plan.json`), JSON.stringify(plan, null, 1));
const journalPath = join(outDir, `${planId}.calls.jsonl`);
const journal = new JsonlCallJournal(journalPath);

// FREE check first (no token billed), BEFORE the one-attempt lock: a refusal here must not consume the single attempt
const cfg = loadAlibabaCreativeConfig(env);
const listed = await fetch(modelListUrl(cfg.workspaceId, model), { headers: { Authorization: `Bearer ${cfg.apiKey}` } })
  .then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) })).catch((e) => ({ status: 0, body: null, error: e.code ?? 'NETWORK' }));
const confirmation = providerConfirmsModel(listed.body, model);
const served = listed.status === 200 && confirmation.confirmed;
await journal.append({ event: 'MODEL_LIST_CHECK', provider: 'alibaba-cloud-model-studio', model, region: 'eu-central-1', request_id: confirmation.request_id, status: served ? 'SERVED' : `NOT_CONFIRMED_HTTP_${listed.status}_SUCCESS_${confirmation.success}_TOTAL_${confirmation.total}` });
console.log(JSON.stringify({ model_list_check: { http: listed.status, success: confirmation.success, total: confirmation.total, confirmed: served, request_id: confirmation.request_id } }));
if (!served) { console.error(JSON.stringify({ refused: 'MODEL_NOT_CONFIRMED_BY_PROVIDER', http: listed.status, success: confirmation.success, total: confirmation.total, request_id: confirmation.request_id }, null, 1)); process.exit(3); }
let imageCfg = null;
if (scene) {
  // the same FREE check for the image model, in the image workspace, BEFORE the lock (a 403 / absent model must not consume the attempt)
  imageCfg = loadAlibabaCreativeConfig(imageEnv);
  const li = await fetch(modelListUrl(imageCfg.workspaceId, IMAGE_EDIT_MODEL), { headers: { Authorization: `Bearer ${imageCfg.apiKey}` } })
    .then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) })).catch((e) => ({ status: 0, body: null, error: e.code ?? 'NETWORK' }));
  const ci = providerConfirmsModel(li.body, IMAGE_EDIT_MODEL); const okImage = li.status === 200 && ci.confirmed;
  await journal.append({ event: 'MODEL_LIST_CHECK', provider: IMAGE_EDIT_PROVIDER_ID, model: IMAGE_EDIT_MODEL, region: 'eu-central-1', request_id: ci.request_id, status: okImage ? 'SERVED' : `NOT_CONFIRMED_HTTP_${li.status}_SUCCESS_${ci.success}_TOTAL_${ci.total}` });
  console.log(JSON.stringify({ image_model_list_check: { http: li.status, success: ci.success, total: ci.total, confirmed: okImage, request_id: ci.request_id } }));
  if (!okImage) { console.error(JSON.stringify({ refused: 'IMAGE_MODEL_NOT_CONFIRMED_BY_PROVIDER', hint: 'qwen-image-3.0-pro est servi à Francfort en périmètre Global : un espace EU le refuse (403). Renseigner ALIBABA_MODEL_STUDIO_IMAGE_WORKSPACE_ID / ALIBABA_MODEL_STUDIO_IMAGE_API_KEY d\'un espace Global.', http: li.status, request_id: ci.request_id }, null, 1)); process.exit(3); }
}

await takeLiveCallLock(registryLock); // machine-wide: one attempt per plan, never released by code
await takeLiveCallLock(join(outDir, `${planId}.lock`)); // and the evidence folder's own lock, as before
const budget = new SpendGuard({ maxSpendEur: ceiling, maxImages: scene ? SCENE_TRIAL.image.variants : 0, maxVideoSeconds: 0 });

const ports = ideation
  ? { ...connectProviders({ env: { ...env, NORDLA_MEDIA_AUTHORIZATION_FILE: '' }, journal, budget, trialAuthorized: true, maxTextCalls: limits.max_text_calls_per_product, maxVisionCalls: 0 }), visionFor: null }
  : connectProviders({ env, journal, budget, sourcePhotoBytes: photoBytes, trialAuthorized: true, maxTextCalls: limits.max_text_calls_per_product, maxVisionCalls: limits.max_vision_calls_per_product });
const local = localEngines({ renderScale: TRIAL_LIMITS.render.scale, samples: TRIAL_LIMITS.render.samples });
const engines = scene
  ? createSceneEngine({ baseEngines: local, config: imageCfg, authorization: sceneMediaRecord().record, photoSha256: photoSha, budget, journal, outputStore: new FileOutputStore(join(outDir, 'provider-outputs')), variants: SCENE_TRIAL.image.variants, maxImageCalls: SCENE_TRIAL.image.calls })
  : local;
const r = await runAutonomous({ mode: ideation ? 'IDEATION_ONLY' : 'FULL', produce: scene ? 'SELECTED' : 'ALL', maxRepairCalls: limits.max_repair_calls, input: inputFor(), ports, engines, workdir: join(outDir, productKey) });

// USAGE: what Alibaba itself reported, priced at the model's list price
const rows = readFileSync(journalPath, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
const price = FRANKFURT_CATALOGUE.models[model];
const used = rows.filter((e) => e.event === 'SUCCEEDED' && e.usage).reduce((a, e) => ({ in: a.in + (e.usage.prompt_tokens ?? 0), out: a.out + (e.usage.completion_tokens ?? 0), n: a.n + 1 }), { in: 0, out: 0, n: 0 });
const failedCalls = rows.filter((e) => e.event === 'FAILED').length;
const money = {
  ESTIMATE_expected_eur: forecast.expected_eur,
  CEILING_application_eur: ceiling,
  CEILING_ledger: budget.snapshot(),
  ...(scene ? { USAGE_image_call_usd_list_price: rows.filter((e) => e.operation === 'IMAGE_EDIT' && e.event === 'SUCCEEDED').reduce((n, e) => n + (e.actual_cost_eur ?? 0), 0), USAGE_image_note: 'priced by budget.js at the Frankfurt list price (USD = EUR in the ledger)' } : {}),
  USAGE_reported_by_alibaba: { calls: used.n, prompt_tokens: used.in, completion_tokens: used.out, eur_at_list_price: Math.round(((used.in * price.usd_in + used.out * price.usd_out) / 1e6) * 0.92 * 10000) / 10000, failed_calls_without_usage: failedCalls },
  INVOICE: 'console Alibaba > Billing : seule source de la facturation réelle',
};
writeFileSync(join(outDir, `${planId}.result.json`), JSON.stringify({ plan_id: planId, status: r.status, money }, null, 1));
console.log(JSON.stringify({ plan_id: planId, status: r.status, money }, null, 1));
// the owner's report, from the recorded trace only
const { execFileSync } = await import('node:child_process');
const { fileURLToPath } = await import('node:url'); // a URL pathname is not a Windows path ("/C:/..."): convert it
console.log(execFileSync(process.execPath, [fileURLToPath(new URL('./creative-autonomy-report.mjs', import.meta.url)), outDir, productKey, planId]).toString().trim());
