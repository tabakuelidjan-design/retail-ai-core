// THE FIRST REAL TRIAL, PREPARED BUT NOT RUN. What Nordla may call, where, for how much, and how it stops.
// Facts below were read on the provider's documentation on 2026-11-01 and are dated: re-verify before the trial (the trial script also asks the provider's own
// free model list, before any paid call, whether the chosen model is served to this workspace).
import { createHash } from 'node:crypto';

export const SCOPE = Object.freeze({ EU: 'EU', GLOBAL: 'GLOBAL' });

/**
 * Germany (Frankfurt), per deployment scope. EU = inference stays in the EU; GLOBAL = "any available node, including Chinese mainland and overseas".
 * Prices: list prices in USD per million tokens, input <= 32k tier, non-thinking output; no free quota in Frankfurt (the 1M free tokens are Singapore only).
 */
export const FRANKFURT_CATALOGUE = Object.freeze({
  verified_at: '2026-11-01',
  sources: [
    'https://www.alibabacloud.com/help/en/model-studio/model-pricing',
    'https://www.alibabacloud.com/help/en/model-studio/qwen3-vl-plus',
    'https://www.alibabacloud.com/help/en/model-studio/context-cache',
    'https://www.alibabacloud.com/help/en/model-studio/germany-frankfurt-global',
    'https://www.alibabacloud.com/help/en/model-studio/data-retention-policy',
  ],
  models: {
    'qwen3.8-max': { scopes: ['GLOBAL'], input: ['text'], usd_in: 1.65, usd_out: 4.951, note: 'flagship; Frankfurt GLOBAL only: inference may run outside the EU' },
    'qwen3.7-plus': { scopes: ['GLOBAL'], input: ['text', 'image', 'video'], usd_in: 0.276, usd_out: 1.101, note: 'multimodal; GLOBAL only' },
    'qwen-plus': { scopes: ['EU', 'GLOBAL'], input: ['text'], usd_in: 0.4, usd_out: 1.2, note: 'EU price; text only: cannot be the visual critic' },
    'qwen3-vl-plus': { scopes: ['EU', 'GLOBAL'], input: ['text', 'image', 'video'], usd_in: 0.2, usd_out: 1.6, note: 'EU price; structured output; thinking switchable; 262k context' },
    'qwen3-vl-flash': { scopes: ['EU', 'GLOBAL'], input: ['text', 'image', 'video'], usd_in: null, usd_out: null, note: 'EU; cheaper, weaker; price not read' },
    'qwen3.8-flash': { scopes: ['UNCONFIRMED'], input: ['text', 'image', 'video'], usd_in: null, usd_out: null, note: 'sources disagree on an EU scope in Frankfurt: not used until the provider model list confirms it' },
  },
  retention: { standard_inference_retention_days_max: 30, zdr: 'enterprise customers only, after assessment: NOT_CONFIRMED for HABB', training_on_api_data: false },
});

export const modelAllowedInScope = (model, scope) => (FRANKFURT_CATALOGUE.models[model]?.scopes ?? []).includes(scope);

export const RECOMMENDED = Object.freeze({ model: 'qwen3-vl-plus', scope: SCOPE.EU, why: 'the only model that is served with EU-only inference in Frankfurt AND reads images, so one model frames, imagines, stages AND critiques the renders' });

export const TRIAL_LIMITS = Object.freeze({
  max_spend_eur: 1.5, // hard: SpendGuard refuses a call whose WORST case would cross it, before anything is sent
  max_text_calls_per_product: 20, // 14 planned + protocol repairs
  max_vision_calls_per_product: 6, // 3 concepts x (1 + up to 1 re-critique)
  max_output_tokens_per_text_call: 4000, // the brain port's cap
  max_output_tokens_per_vision_call: 2200,
  render: { scale: 0.5, samples: 32 }, // 540 x 675 for a 4:5 feed format: enough for a critique, fast on CPU
  products: ['gid://shopify/Product/15514012254556 (variant Noir)', 'gid://shopify/Product/15684480696668'],
  attempts: 1, // the live-call lock: a second attempt needs a human review of the first
});

/** A stable id of what the owner authorises: model, scope, region, limits, products. Changing any of these needs a new authorisation. */
export function trialPlanId({ model, scope, region = 'eu-central-1', limits = TRIAL_LIMITS }) {
  return `trial-${createHash('sha256').update(JSON.stringify({ model, scope, region, limits })).digest('hex').slice(0, 16)}`;
}

/**
 * Cost of a run from measured call sizes. calls: [{ kind: 'TEXT'|'VISION', input_chars, expected_output_chars, images }]
 * Three figures: EXPECTED at the model's list price; WORST at list price with every output at its cap; RESERVED = what the existing SpendGuard books
 * (it prices every call at the qwen3.8-max rate and USD = EUR, i.e. it over-reserves for qwen3-vl-plus: the cap binds earlier than the real spend).
 */
export function forecastCost({ calls, model, imageTokens = 3000, usdToEur = 0.92, reservedPrice = { usd_in: 1.65, usd_out: 4.951 } }) {
  const m = FRANKFURT_CATALOGUE.models[model];
  if (!m?.usd_in) throw new Error(`no verified price for ${model}`);
  let expected = 0; let worst = 0; let reserved = 0; let tokensIn = 0; let tokensOut = 0;
  for (const c of calls) {
    const inTok = Math.ceil(c.input_chars / 4) + (c.images ?? 0) * imageTokens;
    const outTok = Math.ceil(c.expected_output_chars / 4);
    const cap = c.kind === 'VISION' ? TRIAL_LIMITS.max_output_tokens_per_vision_call : TRIAL_LIMITS.max_output_tokens_per_text_call;
    tokensIn += inTok; tokensOut += outTok;
    expected += (inTok * m.usd_in + outTok * m.usd_out) / 1e6;
    worst += (inTok * m.usd_in + cap * m.usd_out) / 1e6;
    reserved += (inTok * reservedPrice.usd_in + cap * reservedPrice.usd_out) / 1e6;
  }
  const eur = (usd) => Math.round(usd * usdToEur * 10000) / 10000;
  return { model, calls: calls.length, tokens_in: tokensIn, tokens_out_expected: tokensOut, expected_eur: eur(expected), worst_case_eur: eur(worst), spendguard_reserved_eur: Math.round(reserved * 10000) / 10000, usd_to_eur: usdToEur };
}

/** Canonical JSON (keys sorted at every level): the same content always gives the same bytes, whatever the key order of the snapshot file. */
export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
  return JSON.stringify(value);
}

/**
 * What Nordla is ASKED, bound to the plan id: the objective, the format, HABB's brand rules and the FULL content of the Shopify product snapshot actually used
 * (title, description, tags, type, status, every variant with its price and stock). A change to any of them (a price, a word of the description) is a new plan.
 */
export function briefBinding({ snapshot, variant, objective, format, brand }) {
  const sha = (x) => createHash('sha256').update(canonicalJson(x)).digest('hex');
  return {
    objective, format, variant,
    product_id: snapshot.product.id,
    snapshot_read_at: snapshot.read_at,
    product_snapshot_sha256: sha(snapshot.product),
    brand_sha256: sha(brand),
  };
}

/**
 * The provider's own confirmation that a model is served to this workspace (GET /api/v1/models, free). The list is PAGINATED (20 per page, 160+ models), so
 * the request asks for the exact model (`model=` exact-match filter) and the answer is accepted only when success === true AND output.models contains an
 * entry whose model is exactly the one requested. Anything else (other page, other model, case variant, error envelope) is NOT a confirmation.
 */
export const modelListUrl = (workspaceId, model) => `https://${workspaceId}.eu-central-1.maas.aliyuncs.com/api/v1/models?model=${encodeURIComponent(model)}`;
export function providerConfirmsModel(body, model) {
  const models = body?.output?.models;
  const confirmed = body?.success === true && Array.isArray(models) && models.some((m) => m?.model === model);
  return { confirmed, request_id: body?.request_id ?? null, total: body?.output?.total ?? null, success: body?.success ?? null };
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------
// WHAT RUNS is part of what is authorised. The plan id binds a fingerprint of the code a live attempt executes (Brain, autonomy route, Alibaba lane, trial and
// report scripts). Line endings are normalised (CRLF -> LF) so that a Windows checkout with core.autocrlf gives the same fingerprint as Linux.
import { readdirSync, readFileSync as readFileSyncCode, existsSync as existsSyncCode } from 'node:fs';
import { join as joinCode, relative as relativeCode, dirname as dirnameCode, resolve as resolveCode } from 'node:path';
import { fileURLToPath as fileURLToPathCode } from 'node:url';

export const REPO_ROOT = resolveCode(dirnameCode(fileURLToPathCode(import.meta.url)), '..', '..');
/** What a live attempt executes: the trial and report scripts and EVERY local module they import (traced statically), the Python engines, the dependency lock. */
export const CODE_ENTRIES = Object.freeze(['scripts/creative-autonomy-trial.mjs', 'scripts/creative-autonomy-report.mjs']);
export const CODE_EXTRAS = Object.freeze(['scripts/creative-autonomy', 'package-lock.json']);
const IMPORT_RE = /(?:^|[\s;])(?:import|export)\s[^'"`;]*?\sfrom\s*['"]([^'"]+)['"]|(?:^|[\s;])import\s*['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)/g;

/** Local modules reachable from the entries through static and literal dynamic imports (bare specifiers are dependencies, covered by package-lock.json). */
export function moduleGraph(root = REPO_ROOT, entries = CODE_ENTRIES) {
  const seen = new Set(); const stack = entries.map((e) => joinCode(root, e));
  while (stack.length) {
    const f = stack.pop(); if (seen.has(f)) continue;
    if (!existsSyncCode(f)) throw new Error(`module not found: ${relativeCode(root, f)}`);
    seen.add(f);
    const src = readFileSyncCode(f, 'utf8'); let m; const re = new RegExp(IMPORT_RE.source, 'g');
    while ((m = re.exec(src))) { const spec = m[1] ?? m[2] ?? m[3]; if (spec && spec.startsWith('.')) stack.push(resolveCode(dirnameCode(f), spec)); }
  }
  return [...seen];
}

/** sha256 over (relative path, content with CRLF -> LF) of the given files, in path order. */
export function fingerprintFiles(root, files) {
  const h = createHash('sha256');
  const rows = files.map((x) => ({ abs: x, rel: relativeCode(root, x).split('\\').join('/') })).sort((a, b) => (a.rel < b.rel ? -1 : 1));
  for (const f of rows) { h.update(`${f.rel}\n`); h.update(readFileSyncCode(f.abs, 'utf8').replace(/\r\n/g, '\n')); h.update('\n\0\n'); }
  return h.digest('hex');
}

export function codeFingerprint(root = REPO_ROOT) {
  const files = new Set(moduleGraph(root));
  for (const x of CODE_EXTRAS) {
    const p = joinCode(root, x); if (!existsSyncCode(p)) continue;
    let entries = null; try { entries = readdirSync(p, { withFileTypes: true }); } catch { files.add(p); continue; }
    for (const e of entries) if (e.isFile() && /\.(py|m?js|json)$/.test(e.name)) files.add(joinCode(p, e.name));
  }
  const list = [...files];
  return { code_sha256: fingerprintFiles(root, list), files: list.length, modules: list.map((f) => relativeCode(root, f).split('\\').join('/')).sort() };
}

/**
 * Code injected into the Node process from outside the files above (--import, --require, --loader, or the same in NODE_OPTIONS): it is part of what runs,
 * so it is part of the plan. A real run has none; a test that swaps fetch with a preload gets ANOTHER plan id and can never use the real authorisation.
 */
export function runtimeInjections(execArgv = process.execArgv, nodeOptions = process.env.NODE_OPTIONS ?? '') {
  const args = [...execArgv, ...nodeOptions.split(/\s+/).filter(Boolean)];
  const out = [];
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i]; const m = /^(--import|--require|-r|--loader|--experimental-loader)(?:=(.+))?$/.exec(a);
    if (!m) continue;
    const spec = m[2] ?? args[i + 1]; if (!m[2]) i += 1;
    let sha = null;
    try { const file = spec.startsWith('file:') ? fileURLToPathCode(spec) : resolveCode(spec); if (existsSyncCode(file)) sha = createHash('sha256').update(readFileSyncCode(file, 'utf8').replace(/\r\n/g, '\n')).digest('hex'); } catch { /* unresolvable: recorded without a hash */ }
    out.push({ flag: m[1], specifier_sha256: createHash('sha256').update(String(spec)).digest('hex').slice(0, 16), content_sha256: sha });
  }
  return out;
}

/**
 * Secrets file guard, as a pure function (testable on any platform). POSIX: refused when readable by group/others (chmod 600 required) or inside a git work tree.
 * Windows: Node cannot read NTFS permissions (st.mode always reports read/write for everyone), so a file can never be PROVEN private: it is refused with an
 * explicit message, and the key must come from environment variables. Fail-closed on both.
 */
export function secretsFileProblems({ exists, platform, mode, insideGitRepo }) {
  if (!exists) return ['fichier de secrets introuvable'];
  const problems = [];
  if (insideGitRepo) problems.push('le fichier de secrets est dans un dépôt git : refusé');
  if (platform === 'win32') problems.push('sous Windows, Nordla ne peut pas vérifier les droits NTFS du fichier : utilise les variables d\'environnement ALIBABA_MODEL_STUDIO_API_KEY et ALIBABA_MODEL_STUDIO_WORKSPACE_ID');
  else if ((mode & 0o077) !== 0) problems.push('le fichier de secrets est lisible par d\'autres que toi (chmod 600 requis)');
  return problems;
}
