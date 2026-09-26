# Provider adapters for the "Demander à Nordla" benchmark

Three adapters, one per provider. Each one only **translates the provider's API to the Nordla AI provider contract** (`plan`, `explain`, `metadata`,
`drainUsage`). They never touch the Nordla orchestrator, the 30 cases or the scoring. **Nothing here has been run against a real API**: every test uses mocked
HTTP responses.

| Adapter | Model id (from the config) | API used | Docs |
|---|---|---|---|
| `openai.js` | `gpt-6-sol` | Responses API `POST /v1/responses`, function call | [model page](https://developers.openai.com/api/docs/models/gpt-6-sol), [reasoning](https://developers.openai.com/api/docs/guides/reasoning) |
| `anthropic.js` | `claude-opus-5-5` | Messages API `POST /v1/messages`, tool use | [Opus 5.5 migration guide](https://platform.claude.com/docs/en/models/opus-5-5/migration-guide) |
| `kimi.js` | `kimi-k3` | Kimi API platform, OpenAI-compatible `POST https://api.moonshot.ai/v1/chat/completions` (not Kimi Web) | [chat API](https://platform.kimi.ai/docs/api/chat) |

The model ids above are what the official pages state; they live in the **config**, not in the code (a test checks that no model id appears in the adapters).

## What every adapter does (identically)

- One function per job — `submit_plan` and `submit_explanation` — whose parameters are Nordla's own JSON Schemas (`PLAN_SCHEMA`, `EXPLANATION_SCHEMA`). The
  system prompt, the two function definitions and the user message are **byte-identical for the three providers** (tested; the SHA-256 of the prompt is recorded
  in every result). Only the wire format differs.
- The model's function arguments are returned **exactly as written**. The adapter never fills in `premises`: a plan without it is refused by Nordla
  (`PLAN_INVALID`) and counted in the premise diagnostics.
- If the model does not call the function (or the arguments are not JSON): **one corrective retry**, the same rule for every provider; then an error.
- Retries: HTTP 429 and 5xx (500, 502, 503, 504, 529) up to `maxRetries` (default 2), waiting `retry-after` or exponential backoff; 4xx are not retried. Timeouts
  (`timeoutMs`) and the orchestrator's own abort signal become `PROVIDER_TIMEOUT`.
- Forced tool call where the provider allows it (OpenAI, Kimi). **Opus 5.5 rejects a forced tool choice**, so it uses `auto` (the prompt requires the call and the
  corrective retry covers a miss). Opus 5.5 also rejects `temperature`, `top_p`, `top_k`; they are never sent unless the config passes them.
- Because the plan contract carries no date, every provider gets the same fixed reference date (`today`) in the system prompt. (A future contract change could
  pass the date in the plan input instead.)

## Configuration (`configs/<provider>.example.json` → copy to `<provider>.local.json`, git-ignored)

| Field | Required | Meaning |
|---|---|---|
| `model` | yes | exact model id |
| `reasoningEffort` | yes (`null` = send none) | OpenAI: `none`…`max`; Anthropic: `low`…`max`; Kimi: `low` \| `high` \| `max`. The examples use `high` for all three |
| `apiKeyEnv` | yes | the **name** of the environment variable that holds the key (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `KIMI_API_KEY`) — never the key |
| `today`, `timeZone` | `today` yes | reference date given to the model (`2026-09-26`, matching the benchmark data) |
| `pricing` | yes | `inputPerMTok`, `outputPerMTok` (USD per million tokens), optional `cachedInputPerMTok`, `cacheWriteInputPerMTok`. **Left `null` in the examples on purpose:** fill them from the provider's official price page; an unfilled config is refused so that the cost is always computable |
| `maxOutputTokens` | no | `max_output_tokens` / `max_tokens` / `max_completion_tokens` (thinking tokens count) |
| `timeoutMs`, `maxRetries`, `maxFormatRetries` | no | 60000 (examples: 120000), 2, 1 |
| `params` | no | extra request fields passed through unchanged (e.g. `temperature`, if the API accepts it) |
| `toolChoice` | no | OpenAI/Kimi: `forced` (default) or `auto`/`required`; Anthropic is always `auto` |
| `baseUrl` | no | must stay on the provider's official host over https (the key is never sent elsewhere) |

## Providing the three keys (nothing is ever written to a file)

Set each key **only in the environment of the terminal that will run the benchmark** — never in Git, in a config, in a log or in a chat. PowerShell (current
session only):

```powershell
$env:OPENAI_API_KEY    = '<paste the key>'
$env:ANTHROPIC_API_KEY = '<paste the key>'
$env:KIMI_API_KEY      = '<paste the key>'
```

Then (only when the benchmark is approved; the runner refuses without the opt-in):

```bash
NORDLA_BENCH_ALLOW_PROVIDER_CALLS=1 node benchmark/ask/run.js --provider benchmark/ask/adapters/openai.js    --config benchmark/ask/adapters/configs/openai.local.json    --repeats 3
NORDLA_BENCH_ALLOW_PROVIDER_CALLS=1 node benchmark/ask/run.js --provider benchmark/ask/adapters/anthropic.js --config benchmark/ask/adapters/configs/anthropic.local.json --repeats 3
NORDLA_BENCH_ALLOW_PROVIDER_CALLS=1 node benchmark/ask/run.js --provider benchmark/ask/adapters/kimi.js      --config benchmark/ask/adapters/configs/kimi.local.json      --repeats 3
```

## What the result files record

`meta.provider` (name, model, exact model/version **as returned by the API**, reasoning effort, temperature or `null`, parameters, endpoint, pricing, prompt
fingerprint), `meta.provider.repeatMetadata` (per repetition: token totals input/output/cached/cache-write/reasoning, cost, call counts including retries, rate
limits, timeouts, the last errors — all scrubbed) and, per case, latency, tokens and cost. **No key, header or environment value ever enters a result**: keys are
read at call time, scrubbed from every error message, and results are redacted by key name and value shape.

## Maximum number of API calls (one full benchmark = 30 cases, 34 user turns)

| | per repetition | 3 repetitions | 3 providers × 3 repetitions |
|---|---|---|---|
| **Expected** (a well-behaved model: one plan per turn, one explanation when there is something to explain) | 56 | 168 | 504 |
| **Logical maximum** (2 planning turns + 1 explanation per turn) | 102 | 306 | 918 |
| **Absolute worst case** (each call also uses its corrective retry and 2 HTTP retries: ×6) | 612 | 1 836 | 5 508 |

The expected figure is measured on the scripted oracle (56 provider calls). Tokens are not estimated here: they depend on the model, and the runs report them.

## Mandatory preflight (every real run)

Before anything network-related is created, `run.js` runs `lib/preflight.js`: local checks only, **no request, no test of the key**. It checks the adapter (`spec` export), endpoint (official, https), model, reasoning effort, supported parameters (nothing silently ignored), the key variable (present, non-empty, not a placeholder), `NORDLA_BENCH_ALLOW_PROVIDER_CALLS=1`, the request cap, `--repeats`, cases/dataset/commit/adapter identification and pricing (full run: dated and sourced pricing required; `--smoke` without pricing = warning, cost stays `null`).

On failure: `PREFLIGHT FAILED — <field or variable to fix>. No request was sent.`, exit code **6**. The message never contains a key, a fragment of one, or the offending value. On success it prints Provider / Model / Endpoint / Reasoning effort / Repeats / API key: present / Provider calls: enabled / Preflight: PASS.
