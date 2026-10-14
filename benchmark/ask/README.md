# Benchmark "Demander à Nordla"

Compares AI providers on the **structural reasoning** Nordla needs — not on writing style. 30 fixed cases, played through the real Nordla orchestrator
(plan → tools → facts → explain → verify) on a fixed synthetic dataset.

**Status: no real provider is connected.** No adapter exists, no API is called. The only provider in this folder is the scripted *oracle*, which validates the
benchmark itself.

## Safety

- It lives in `benchmark/ask/`, **not** in `test/`. `npm test` (`node --test test/*.test.js`) and CI never run it.
- `run.js` refuses any provider other than `oracle` unless you pass `--provider <adapter module>` **and** set `NORDLA_BENCH_ALLOW_PROVIDER_CALLS=1`.
- Nothing in this folder makes a network call or names a provider; adapters (added later) read their own keys from the environment and never store them.
- Results are written to `benchmark/ask/results/` (git-ignored).

## Files

| File | Role |
|---|---|
| `cases.json` | the 30 cases (versioned, readable) |
| `oracle.json` | scripted plans of the oracle (validates that the expectations are achievable) |
| `score-schema.json` | shape of a per-case score and of a per-provider report |
| `run.js` | runner (CLI) |
| `lib/dataset.js` | the fixed synthetic dataset and reference date (2026-09-26, Europe/Brussels) — the same data as the unit tests, never real HABB data |
| `lib/truth.js` | every expected quantity names its source (tool call + path) and a pinned value; `verifyTruth` fails if the data or engine drifts |
| `lib/validate-cases.js` | structure and exact distribution of `cases.json` |
| `lib/run-case.js` | plays 1–3 turns through the orchestrator, records responses, diagnostics, provider inputs, latency, usage |
| `lib/score.js` | scoring (pure functions) |
| `lib/oracle-provider.js` | the oracle and its deliberate degradations (test-only) |

## The 30 cases

| Category | # | What it tests |
|---|---|---|
| simple | 4 | one tool, one figure (revenue, orders, average basket, best product) |
| quantitative | 4 | exact amount / percentage / dates / volume, varied phrasings |
| multi_tool | 4 | what changed this week; compare two months; products + channels; discounts + refunds + sales |
| premise | 6 | 4 false (trend down, trend up, wrong best product, "zero"), 1 correct, 1 unverifiable (no history) |
| clarification | 3 | too vague; product/period ambiguity; a clear question that must **not** trigger a clarification |
| conversation | 3 | "Et le mois dernier ?"; answer to a clarification; follow-up after a premise correction (2–3 turns) |
| refusal | 3 | data Nordla does not have; period outside the history; margin with unverified costs |
| trap | 3 | invented tool/metric; personal data in the question; instruction to invent a figure |

Languages: **24 FR, 3 NL, 3 EN** (natural phrasings, not translations of each other).

## Case format

```json
{
  "id": "P01", "category": "premise", "language": "fr", "selectedPeriod": null,
  "turns": [ { "user": "…" } ],                      // 1–3 turns; a non-final turn carries expected.status
  "expected": {
    "premises": [ { "kind": "trend", "metric": "sales", "direction": "decrease" } ],   // structure, never wording
    "verdict": "contradicted",                        // supported | contradicted | unknown | null
    "status": ["PREMISE_CONTRADICTED"],               // OK | CLARIFICATION | CANNOT_ANSWER | PREMISE_CONTRADICTED | PREMISE_UNVERIFIABLE
    "clarification": false,
    "tools": { "required": ["get_sales_metrics"], "forbidden": ["get_top_products"], "minDistinct": 1 },   // "a|b" = either; "*" = no tool at all
    "periods": [ { "from": "2026-08-27", "to": "2026-09-25" } ],                       // exact windows, whatever the way the provider wrote them
    "gaps": [], "limitations": [], "caveats": [],
    "quantities": [ { "kind": "money", "value": 489.25, "source": { "tool": "…", "args": {}, "path": "values.net_sales_ex_tax" } } ],
    "forbiddenQuantities": [], "labels": [], "hypotheses": "none",
    "privacy": { "mustNotReachProvider": [] }, "unknownToolCalls": 0, "honestRefusal": false
  },
  "notes": "…"
}
```

**Several valid strategies.** Where more than one tool plan is acceptable, `expected.tools.acceptablePlans` lists them (each: `required` tools, with `"a|b"`
alternatives, and `minDistinct`); `required`/`minDistinct` are then `[]`/`0`. A case passes its tool check if **at least one plan is satisfied** with data that was
really obtained (the tool answered — except in refusal cases, where the tool's error is the point), no `forbidden` tool was used (this applies to every plan),
the exact `periods` were covered, and the provider stayed inside the budgets (2 premise-verification calls + 4 analysis calls). The order of the calls never
matters. Cases where one plan suffices keep `required` / `forbidden` / `minDistinct`.

No expected answer text: the reasoning structure is evaluated, not the prose. Numbers are checked against Nordla's facts: a quantity counts as cited only if the
verified answer references the fact that holds it.

## Scoring (no composite)

Per case: `planValid`, `premisesDeclared`, `premiseVerdict`, `noSpuriousPremise`, `toolSelection`, `status`, `intermediateTurns`, `clarification`,
`explanationVerified`, `quantities`, `forbiddenQuantities`, `labels`, `noCausalAfterContradiction`, `limitations`, `caveats`, `gaps`, `honestRefusal`, `privacy`,
plus hypotheses accepted/rejected, latency, tokens, cost. A case `pass`es only if **every applicable check** passes.

Per provider — **separate sub-scores, each with numerator and denominator, never averaged together**: success rate (global, by category, by language), premise
recall, premise false-positive rate, premise verdict accuracy, tool selection rate, explanation verification pass rate, quantity citation rate, clarification
accuracy, honest refusal rate, no-causal-after-contradiction rate, privacy violations, unknown tool calls, median and p95 latency, tokens, average cost per
question. A model that writes well but misses premises shows a low `premiseRecall` no matter what its other scores are.

### Repetitions and stability

`--repeats N` (1 to 10, default 1; **3 for the final comparison**) runs the whole benchmark N times, each repetition fully independent (a new provider
instance, a new dataset and new orchestrators). The existing sub-scores are pooled over all case × repetition samples; the report adds a `stability` block:
the distribution of cases by passes (`3/3`, `2/3`, `1/3`, `0/3`), the mean per-case success rate, the unstable cases (passed sometimes), the cases whose status
changed between repetitions, and the latency and cost spread (standard deviation; cost is `null` until an adapter reports it). Still no composite score.

### Reproducibility metadata (`meta` in every result file)

benchmark name/version and the SHA-256 of `cases.json` and of the fixed dataset · start/finish time and repetitions · Nordla commit, branch and whether the
working tree was dirty · provider name, model, exact model version, temperature (or equivalent) as declared by the adapter's optional `metadata()` or the config
· the redacted config · the adapter's path, last commit, uncommitted changes and file hash. **Secrets never enter a result:** the config and the adapter metadata
are redacted by key name (`apiKey`, `token`, `secret`, `password`, `authorization`…) and by value shape (`sk-…`, `Bearer …`); the environment is never dumped
(the *name* of an environment variable may appear, never its value).

Latency is measured around each provider call. Tokens and cost come from the adapter's optional `drainUsage()`; without it they are `null` — never estimated.

## Running

```bash
# harness check: the oracle must pass 30/30 on every repetition (no model, no network)
node benchmark/ask/run.js --provider oracle --repeats 3
```

Later, with a real adapter (an ES module exporting `createProvider(config) → { name, plan, explain, drainUsage? }`, i.e. the Nordla AI provider contract):

```bash
NORDLA_BENCH_ALLOW_PROVIDER_CALLS=1 node benchmark/ask/run.js --provider ./benchmark/ask/adapters/<name>.js --config <name>.json --repeats 3
```

Same 30 cases, same data, same tools, same expectations for every provider; compare the sub-score tables side by side. A second, qualitative pass on the real HABB
data comes after — it never defines the benchmark score.
