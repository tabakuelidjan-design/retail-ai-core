// The mandatory configuration PREFLIGHT of every real-provider run (smoke or full). It is local and pure: no network, no request, no key test - it only inspects the
// adapter's declared `spec`, the config file, the environment and the run options, and answers PASS or a list of things to fix.
//
// A failure message names only the field or the variable to fix. It NEVER contains a secret, a prefix or a suffix of one, or the offending value (a placeholder or a
// mistyped model is described, not quoted). Exit code of the runner on failure: PREFLIGHT_EXIT_CODE.

export const PREFLIGHT_EXIT_CODE = 6;

const PLACEHOLDER = /(your|^ton[-_]|^mon[-_]|[-_]ici$|nom[-_]du|ta_?vraie|ma_?cle|votre|changeme|change_me|replace|placeholder|example|dummy|fake|sample|insert|^x{3,}|x{6,}|<[^>]*>|\.\.\.|^sk-?$)/i;
const looksLikePlaceholder = (v) => typeof v === 'string' && PLACEHOLDER.test(v);
const isDate = (v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(v));
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const PRICING_MAX_AGE_DAYS = 90;

/**
 * @param {{ spec: object|null, config: object, env: object, options: { smoke: boolean, repeats: number|null, maxRequests: number|null, only: string[]|null },
 *           smokePreset?: object|null, casesOk: boolean, casesSha256: string|null, datasetSha256: string|null, nordla: {commit, dirty}|null, adapter: object|null, today: Date }} ctx
 */
export function runPreflight(ctx) {
  const { spec, config, env, options, smokePreset = null, casesOk, casesSha256, datasetSha256, nordla, adapter, today } = ctx;
  const failures = []; const warnings = [];
  let keyName = null; let repeats = null; let src = null; let priced = false;
  const fail = (area, field, message) => failures.push({ area, field, message });
  const warn = (area, field, message) => warnings.push({ area, field, message });

  // --- authorisation and caps first: these hold even when nothing else could be read ---
  if (env.NORDLA_BENCH_ALLOW_PROVIDER_CALLS !== '1') fail('benchmark', 'NORDLA_BENCH_ALLOW_PROVIDER_CALLS', 'NORDLA_BENCH_ALLOW_PROVIDER_CALLS=1 is not set. Refusing to call a real provider: set it to confirm that this run may call an external AI service (and may cost money)');
  if (!options.smoke && options.maxRequests === null) fail('benchmark', '--max-requests', 'A real-provider run needs a request cap: use --smoke, or --max-requests N (every HTTP attempt counts, retries included)');

  // --- provider / adapter ---
  if (!spec || typeof spec !== 'object' || !spec.provider || !spec.endpoint) fail('provider', 'adapter', 'the adapter module does not export a valid `spec` (provider, endpoint): it cannot be identified');
  if (!adapter || !adapter.sha256) fail('benchmark', 'adapter', 'the adapter file cannot be identified (path/hash unavailable)');
  const cfg = config && typeof config === 'object' && !Array.isArray(config) ? config : null;
  if (!cfg) { fail('config', 'config', 'the config file is missing or is not a JSON object'); return finish(); }
  if (!spec) return finish();

  for (const k of Object.keys(cfg)) if (!k.startsWith('_') && !spec.configKeys.includes(k)) fail('parameters', `config.${k}`, `config.${k} is not a parameter this benchmark knows: it would be silently ignored (remove it, or prefix it with "_" for a comment)`);

  // --- endpoint ---
  if (cfg.baseUrl === undefined || cfg.baseUrl === null) { /* default = the adapter's official endpoint */ } else if (typeof cfg.baseUrl !== 'string' || !cfg.baseUrl) fail('endpoint', 'config.baseUrl', 'config.baseUrl is empty (remove it to use the adapter\'s official endpoint)');
  else {
    let u = null; try { u = new URL(cfg.baseUrl); } catch { fail('endpoint', 'config.baseUrl', 'config.baseUrl is not a valid URL'); }
    if (u) {
      if (u.protocol !== 'https:') fail('endpoint', 'config.baseUrl', 'config.baseUrl must use https');
      const built = `${u.origin}${u.pathname.replace(/\/$/, '')}${spec.path}`;
      if (!spec.allowedHosts.includes(u.hostname) || built !== spec.endpoint) fail('endpoint', 'config.baseUrl', `config.baseUrl does not lead to the endpoint this adapter expects (${spec.endpoint})`);
    }
  }

  // --- model ---
  if (typeof cfg.model !== 'string' || !cfg.model.trim()) fail('model', 'config.model', 'config.model is missing or empty');
  else if (looksLikePlaceholder(cfg.model) || /\s/.test(cfg.model) || !/^[A-Za-z0-9][A-Za-z0-9._:\/-]{1,99}$/.test(cfg.model)) fail('model', 'config.model', 'config.model looks like a placeholder or is not a valid model id (letters, digits, . _ - : / only, no spaces)');

  // --- reasoning / parameters ---
  if (cfg.reasoningEffort === undefined) fail('parameters', 'config.reasoningEffort', 'config.reasoningEffort is missing (a level, or null to send none)');
  else if (cfg.reasoningEffort !== null && !(spec.efforts ?? []).includes(cfg.reasoningEffort)) fail('parameters', 'config.reasoningEffort', `config.reasoningEffort is not valid for this adapter (allowed: ${(spec.efforts ?? []).join(', ')}, or null)`);
  if (cfg.toolChoice !== undefined && !spec.toolChoices.includes(cfg.toolChoice) && !(cfg.toolChoice === 'forced' && spec.toolChoices.includes('forced'))) fail('parameters', 'config.toolChoice', `config.toolChoice is not supported by this adapter (allowed: ${spec.toolChoices.join(', ')})`);
  if (cfg.params !== undefined && (cfg.params === null || typeof cfg.params !== 'object' || Array.isArray(cfg.params))) fail('parameters', 'config.params', 'config.params must be an object');
  else for (const k of Object.keys(cfg.params ?? {})) {
    if (spec.unsupportedParams[k]) fail('parameters', `config.params.${k}`, `config.params.${k} is not supported by this adapter: ${spec.unsupportedParams[k]} (remove it)`);
    else if (spec.controlledFields.includes(k)) fail('parameters', `config.params.${k}`, `config.params.${k} is controlled by the adapter and cannot be overridden`);
    else if (!spec.supportedParams.includes(k)) fail('parameters', `config.params.${k}`, `config.params.${k} is not a parameter this adapter knows: it would be forwarded unchecked (remove it)`);
  }
  if (cfg.today === undefined || !isDate(cfg.today)) fail('parameters', 'config.today', 'config.today (YYYY-MM-DD) is missing or invalid');
  const bound = (key, lo, hi) => { if (cfg[key] !== undefined && !(Number.isInteger(cfg[key]) && cfg[key] >= lo && cfg[key] <= hi)) fail('parameters', `config.${key}`, `config.${key} must be an integer from ${lo} to ${hi}`); };
  bound('maxOutputTokens', 256, 128000); bound('timeoutMs', 1000, 600000); bound('maxRetries', 0, 5); bound('maxFormatRetries', 0, 2);

  // --- API key (the variable NAME, then its presence; never its value) ---
  keyName = cfg.apiKeyEnv;
  if (typeof keyName !== 'string' || !/^[A-Z][A-Z0-9_]*$/.test(keyName)) fail('key', 'config.apiKeyEnv', 'config.apiKeyEnv must be the NAME of an environment variable (e.g. MY_PROVIDER_KEY), never a key');
  else {
    const v = env[keyName];
    if (v === undefined || v === null || v === '' || String(v).trim() === '') fail('key', keyName, `${keyName} is missing or empty`);
    else if (looksLikePlaceholder(String(v)) || String(v).trim().length < 16 || /\s/.test(String(v).trim()) || /^["'].*["']$/.test(String(v))) fail('key', keyName, `${keyName} is missing or appears to contain a placeholder`);
  }

  // --- benchmark ---
  if (!casesOk) fail('benchmark', 'cases', 'benchmark/ask/cases.json is missing or invalid');
  if (!datasetSha256) fail('benchmark', 'dataset', 'the dataset fingerprint is unavailable');
  if (!casesSha256) fail('benchmark', 'cases', 'the cases fingerprint is unavailable');
  if (!nordla?.commit) fail('benchmark', 'nordla', 'the Nordla commit cannot be identified (not a git checkout)'); else if (nordla.dirty) warn('benchmark', 'nordla', 'the Nordla working tree has uncommitted changes: the run is not reproducible from a commit');
  if (adapter?.uncommittedChanges) warn('benchmark', 'adapter', 'the adapter file has uncommitted changes');
  repeats = options.smoke ? smokePreset?.repeats : (options.repeats ?? 1);
  if (!Number.isInteger(repeats) || repeats < 1 || repeats > 10) fail('benchmark', '--repeats', '--repeats must be an integer from 1 to 10');
  if (options.smoke && (options.only !== null || options.repeatsGiven)) fail('benchmark', '--smoke', '--smoke fixes the cases and a single repetition: do not combine it with --only or --repeats');
  if (options.smoke && smokePreset && options.maxRequests > smokePreset.maxRequests) fail('benchmark', '--max-requests', `--max-requests cannot exceed the smoke cap (${smokePreset.maxRequests})`);

  // --- cost: full benchmark needs dated pricing; a smoke may run unpriced (cost stays null, never invented) ---
  const p = cfg.pricing; src = cfg.pricingSource;
  const pricingValid = p && isNum(p.inputPerMTok) && p.inputPerMTok >= 0 && isNum(p.outputPerMTok) && p.outputPerMTok >= 0;
  const sourceValid = src && typeof src.url === 'string' && /^https:/.test(src.url) && isDate(src.retrievedOn);
  const costProblem = (field, msg) => (options.smoke ? warn('cost', field, `${msg}; the cost will be reported as null (never estimated)`) : fail('cost', field, msg));
  if (p === undefined || p === null) costProblem('config.pricing', 'config.pricing is not configured');
  else if (!pricingValid) costProblem('config.pricing', 'config.pricing.inputPerMTok / outputPerMTok must be numbers (USD per million tokens)');
  else if (!sourceValid) costProblem('config.pricingSource', 'config.pricingSource {url (https), retrievedOn (YYYY-MM-DD)} is missing or invalid: the pricing must be dated and sourced');
  else if ((today - Date.parse(src.retrievedOn)) / 86400000 > PRICING_MAX_AGE_DAYS) warn('cost', 'config.pricingSource.retrievedOn', `the pricing is older than ${PRICING_MAX_AGE_DAYS} days: re-check it on the official page`);
  priced = !!(pricingValid && sourceValid);
  if (options.smoke && smokePreset && !priced) warn('cost', 'maxCostUsd', 'the cost cap cannot be enforced without pricing: only the request cap protects this run');

  return finish();

  function finish() {
    const ok = failures.length === 0;
    const keyOk = typeof keyName === 'string' && !failures.some((f) => f.area === 'key');
    const summary = ok ? {
      Provider: spec.provider, Model: cfg.model, Endpoint: cfg.baseUrl ? `${new URL(cfg.baseUrl).origin}${new URL(cfg.baseUrl).pathname.replace(/\/$/, '')}${spec.path}` : spec.endpoint,
      'Reasoning effort': cfg.reasoningEffort === null ? 'none' : cfg.reasoningEffort, Repeats: repeats, 'API key': keyOk ? 'present' : 'missing', 'Provider calls': 'enabled',
      Pricing: priced ? `configured (retrieved ${src.retrievedOn})` : 'not configured (cost = null)', Preflight: 'PASS',
    } : null;
    return { ok, failures, warnings, summary, priced };
  }
}

/** The one-line-per-problem text printed on failure: field names only, and the guarantee that nothing was sent. */
export function formatFailure(result) {
  const first = result.failures[0];
  const lines = [`PREFLIGHT FAILED — ${first.message}. No request was sent.`];
  for (const f of result.failures.slice(1)) lines.push(`  - ${f.field}: ${f.message}`);
  for (const w of result.warnings) lines.push(`  (warning) ${w.field}: ${w.message}`);
  return lines.join('\n');
}
