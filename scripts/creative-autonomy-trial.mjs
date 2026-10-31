// THE FIRST REAL TRIAL OF NORDLA'S CREATIVE AUTONOMY. Two products, one model, one hard ceiling, one attempt.
//
//   node scripts/creative-autonomy-trial.mjs --plan    <outDir> <bottlePhoto> <casePhoto>   (default: no network, no cost)
//   node scripts/creative-autonomy-trial.mjs --execute <outDir> <bottlePhoto> <casePhoto>   (refused unless NORDLA_TRIAL_AUTHORIZATION equals the plan id)
//
// --plan    checks the environment WITHOUT printing any secret, measures the real size of every Brain call with a SIZING double (generic test content, never shown
//           as a proposal), prices them for the chosen model and prints the plan id the owner must authorise.
// --execute takes the one-attempt lock, asks the provider's FREE model list whether the model is served to this workspace, then runs both products under ONE
//           SpendGuard of 1.50 EUR shared by every call (worst case reserved before each call; BUDGET_EXCEEDED stops the run), with every call journalled.
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runAutonomous, localEngines } from '../src/creative-autonomy/run.js';
import { connectProviders } from '../src/creative-autonomy/providers.js';
import { HABB_BRAND } from '../src/creative-autonomy/brief.js';
import { FRANKFURT_CATALOGUE, RECOMMENDED, TRIAL_LIMITS, trialPlanId, forecastCost, modelAllowedInScope } from '../src/creative-autonomy/trial.js';
import { loadAlibabaCreativeConfig } from '../src/marketing-creative/alibaba/config.js';
import { SpendGuard } from '../src/marketing-creative/alibaba/budget.js';
import { JsonlCallJournal } from '../src/marketing-creative/alibaba/journal.js';
import { takeLiveCallLock } from '../src/marketing-creative/alibaba/live-call-lock.js';
import { buildConceptCriticInstruction } from '../src/creative-brain/concept-critic.js';
import { normalizeConceptSet } from '../src/creative-brain/concept.js';
// SIZING ONLY: generic invented answers of the test world, used to measure prompt sizes. They never reach the owner.
import { frameAnswer, CONCEPTS, artDirectionAnswer } from '../test/creative-brain-world.js';

const [mode = '--plan', outDir = mkdtempSync(join(tmpdir(), 'nordla-trial-')), bottlePhoto, casePhoto] = process.argv.slice(2);
mkdirSync(outDir, { recursive: true });
const snap = (f) => JSON.parse(readFileSync(new URL(`../test/fixtures/creative-autonomy/${f}`, import.meta.url), 'utf8'));
const PRODUCTS = [
  { key: 'gourde-noire', snap: snap('shopify-gourde-tyeso.json'), variant: 'Noir', photo: bottlePhoto, objective: 'Écouler les 7 gourdes noires en stock avant fin novembre, en boutique et en ligne' },
  { key: 'coque-iphone12', snap: snap('shopify-coque-iphone12.json'), variant: null, photo: casePhoto, objective: 'Faire commander des coques iPhone 12 personnalisées pour les cadeaux de fin d\'année' },
];
const inputFor = (p) => ({ product: p.snap.product, variantTitle: p.variant, readAt: p.snap.read_at, objective: p.objective, brand: HABB_BRAND, format: 'INSTAGRAM_FEED_4_5', photoPath: p.photo,
  photoMeta: { media_type: p.photo?.endsWith('.png') ? 'image/png' : 'image/jpeg', width_px: null, height_px: null, origin: 'MERCHANT_UPLOAD', rights_class: 'MERCHANT_OWNED' } });

const env = process.env;
const model = env.ALIBABA_QWEN_TEXT_MODEL || RECOMMENDED.model;
const scope = env.NORDLA_ALIBABA_SCOPE || RECOMMENDED.scope;
const planId = trialPlanId({ model, scope });

// ---- preflight: no secret is ever printed, only presence
function preflight() {
  const checks = [];
  const ok = (name, pass, detail) => checks.push({ name, pass, detail });
  ok('clé API présente', Boolean(env.ALIBABA_MODEL_STUDIO_API_KEY), env.ALIBABA_MODEL_STUDIO_API_KEY ? 'présente (non affichée)' : 'absente');
  ok('workspace présent', Boolean(env.ALIBABA_MODEL_STUDIO_WORKSPACE_ID), env.ALIBABA_MODEL_STUDIO_WORKSPACE_ID ? 'présent' : 'absent');
  ok('région Francfort', (env.ALIBABA_MODEL_STUDIO_REGION || 'eu-central-1') === 'eu-central-1', env.ALIBABA_MODEL_STUDIO_REGION || 'eu-central-1');
  ok(`modèle ${model} servi en périmètre ${scope}`, modelAllowedInScope(model, scope), FRANKFURT_CATALOGUE.models[model]?.note ?? 'modèle inconnu du catalogue');
  let cfgError = null; try { loadAlibabaCreativeConfig({ ...env, ALIBABA_QWEN_TEXT_MODEL: model }); } catch (e) { cfgError = e.message; }
  ok('modèle accepté par la configuration du lane Alibaba', !cfgError, cfgError ?? 'accepté');
  ok('autorisation média (photo + rendus dérivés)', Boolean(env.NORDLA_MEDIA_AUTHORIZATION_FILE), env.NORDLA_MEDIA_AUTHORIZATION_FILE ? 'fichier présent' : 'absente : le critique visuel restera non connecté');
  ok('autorisation d\'essai pour CE plan', env.NORDLA_TRIAL_AUTHORIZATION === planId, env.NORDLA_TRIAL_AUTHORIZATION ? (env.NORDLA_TRIAL_AUTHORIZATION === planId ? 'conforme' : 'ne correspond pas au plan') : 'absente');
  return checks;
}

// ---- sizing: the real instructions of a full run, measured (no network)
async function sizing(p) {
  const calls = [];
  const concepts = normalizeConceptSet(CONCEPTS);
  const complete = async ({ system, user }) => {
    const stage = system.includes('problem framer') ? 'FRAME' : system.includes('concept director') ? 'IDEATE' : system.includes('art director') ? 'ART_DIRECT' : 'STAGE';
    const c = stage === 'ART_DIRECT' || stage === 'STAGE' ? JSON.parse(user).concept : null;
    const body = stage === 'FRAME' ? frameAnswer() : stage === 'IDEATE' ? { concepts: CONCEPTS }
      : stage === 'ART_DIRECT' ? artDirectionAnswer({ narrative_elements: [{ element: 'one element of the set', reason: c.visual_metaphor, zone: 'BACKGROUND' }, { element: 'a second element', reason: c.story, zone: 'FOREGROUND' }] })
        : { backdrop: 'SEAMLESS_SWEEP', backdrop_tone: 'CHARCOAL', floor_finish: 'SATIN', key_light: { kind: 'STRIP', side: 'LEFT', intensity: 'MEDIUM', temperature: 'NEUTRAL', purpose: 'sizing' }, accent_lights: [], camera: { height: 'PRODUCT_CENTER', framing: 'MEDIUM', product_position: 'LEFT_THIRD' }, props: [{ shape: 'BLOCK', material: 'CONCRETE', placement: 'BESIDE_RIGHT', scale: 'LOW', reason: c.visual_metaphor }], headline: 'Sizing', text_placement: 'RIGHT_COLUMN', show_price: 'YES', rationale: 'sizing' };
    const text = JSON.stringify(body);
    calls.push({ kind: 'TEXT', stage, input_chars: system.length + user.length, expected_output_chars: Math.ceil(text.length * 1.5) });
    return { text, model: 'SIZING_DOUBLE', request_id: null, cost_eur: 0 };
  };
  const fake = { name: { render: 'sizing', compose: 'sizing' },
    examine: async () => ({ status: 'CUT_OUT' }), render: async ({ outPath }) => { writeFileSync(outPath, 'x'); return { resolution: [1, 1], foreground_props: 0 }; },
    compose: async ({ outPath }) => { writeFileSync(outPath, 'x'); return { fidelity: { max_level_difference_after_removing_layers: 0 }, technical: { defects: [], text_contrast_ratio: 21, product_height_share: 0.5 }, text_used: { facts_lines: [] } }; } };
  const tmpPhoto = join(mkdtempSync(join(tmpdir(), 'sz-')), 'p.jpg'); writeFileSync(tmpPhoto, 'sizing');
  await runAutonomous({ input: { ...inputFor(p), photoPath: tmpPhoto }, ports: { text: complete, vision: null, state: { text: 'TEST_DOUBLE', vision: 'NOT_CONNECTED' } }, engines: fake, workdir: mkdtempSync(join(tmpdir(), 'sz-')) });
  // the run itself does one STAGE per concept; a real run may add up to 2 refinements per concept: priced as STAGE re-asks
  const stageCall = calls.find((c) => c.stage === 'STAGE');
  for (let i = 0; i < concepts.length * 2; i += 1) calls.push({ ...stageCall, stage: 'REFINE' });
  const critic = buildConceptCriticInstruction({ brief: {} });
  for (let i = 0; i < TRIAL_LIMITS.max_vision_calls_per_product; i += 1) calls.push({ kind: 'VISION', stage: 'CRITIC', input_chars: critic.system.length + critic.user.length + 400, expected_output_chars: 2400, images: 1 });
  return calls;
}

const checks = preflight();
const perProduct = [];
for (const p of PRODUCTS) { const calls = await sizing(p); perProduct.push({ product: p.key, calls: calls.length, by_stage: calls.reduce((a, c) => ({ ...a, [c.stage]: (a[c.stage] ?? 0) + 1 }), {}), forecast: forecastCost({ calls, model }) }); }
const total = perProduct.reduce((a, p) => ({ expected_eur: a.expected_eur + p.forecast.expected_eur, worst_case_eur: a.worst_case_eur + p.forecast.worst_case_eur, spendguard_reserved_eur: a.spendguard_reserved_eur + p.forecast.spendguard_reserved_eur }), { expected_eur: 0, worst_case_eur: 0, spendguard_reserved_eur: 0 });
const plan = { plan_id: planId, model, scope, region: 'eu-central-1', limits: TRIAL_LIMITS, catalogue_verified_at: FRANKFURT_CATALOGUE.verified_at, preflight: checks, per_product: perProduct, total: Object.fromEntries(Object.entries(total).map(([k, v]) => [k, Math.round(v * 10000) / 10000])), hard_ceiling_eur: TRIAL_LIMITS.max_spend_eur };
writeFileSync(join(outDir, `${planId}.plan.json`), JSON.stringify(plan, null, 1));

if (mode !== '--execute') { console.log(JSON.stringify(plan, null, 1)); process.exit(0); }

// ================= EXECUTE: only with the owner's authorisation of THIS plan =================
const failed = checks.filter((c) => !c.pass && !/autorisation média/.test(c.name));
if (failed.length) { console.error(JSON.stringify({ refused: 'PREFLIGHT_FAILED', failed }, null, 1)); process.exit(2); }
await takeLiveCallLock(join(outDir, `${planId}.lock`)); // one attempt; never released by code
const journal = new JsonlCallJournal(join(outDir, `${planId}.calls.jsonl`));
const budget = new SpendGuard({ maxSpendEur: TRIAL_LIMITS.max_spend_eur, maxImages: 0, maxVideoSeconds: 0 });

// free check: is the model served to this workspace? (model list endpoint, no tokens billed)
const cfg = loadAlibabaCreativeConfig({ ...env, ALIBABA_QWEN_TEXT_MODEL: model });
const listUrl = `https://${cfg.workspaceId}.eu-central-1.maas.aliyuncs.com/api/v1/models`;
const listed = await fetch(listUrl, { headers: { Authorization: `Bearer ${cfg.apiKey}` } }).then(async (r) => ({ status: r.status, body: r.ok ? await r.json() : null })).catch((e) => ({ status: 0, error: e.code ?? 'NETWORK' }));
const served = JSON.stringify(listed.body ?? {}).includes(`"${model}"`);
await journal.append({ event: 'MODEL_LIST_CHECK', provider: 'alibaba-cloud-model-studio', model, region: 'eu-central-1', status: served ? 'SERVED' : `NOT_CONFIRMED_${listed.status}` });
if (!served) { console.error(JSON.stringify({ refused: 'MODEL_NOT_CONFIRMED_BY_PROVIDER', status: listed.status }, null, 1)); process.exit(3); }

const results = [];
for (const p of PRODUCTS) {
  const ports = connectProviders({ env: { ...env, ALIBABA_QWEN_TEXT_MODEL: model }, journal, budget, sourcePhotoBytes: readFileSync(p.photo), trialAuthorized: true, maxTextCalls: TRIAL_LIMITS.max_text_calls_per_product, maxVisionCalls: TRIAL_LIMITS.max_vision_calls_per_product });
  const r = await runAutonomous({ input: inputFor(p), ports, engines: localEngines({ renderScale: TRIAL_LIMITS.render.scale, samples: TRIAL_LIMITS.render.samples }), workdir: join(outDir, p.key) });
  results.push({ product: p.key, status: r.status, budget: budget.snapshot() });
  if (/BUDGET_EXCEEDED|BRAIN_CALL_LIMIT_REACHED/.test(JSON.stringify(r.error ?? ''))) break; // the ceiling stops everything, not just one product
}
writeFileSync(join(outDir, `${planId}.result.json`), JSON.stringify({ plan_id: planId, results, budget: budget.snapshot() }, null, 1));
console.log(JSON.stringify({ plan_id: planId, results, budget: budget.snapshot() }, null, 1));
