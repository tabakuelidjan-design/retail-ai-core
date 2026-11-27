# Growth agents - evaluation protocol

Status: the harness is built and tested offline. **The quality of real model answers is NOT evaluated.** No provider is configured in the
working environment, and no answer from a real model has been graded. Simulated answers in the tests only check that the grader discriminates.

## What is evaluated

Eight agents: Stratège, Produits et offres, Audience et fidélisation, Contenu et réseaux sociaux, Boutique locale, Conversion du site,
Publicités, Expériences. Three synthetic cases each (24 in total), in `src/growth/eval/cases.js`.

Every case is run through the real gateway (`src/growth/agents/gateway.js`), so the prompt graded is the one a provider would receive:
the agent's own sources only, personal fields removed, free text masked, web addresses reduced.

## Checks (deterministic, `src/growth/eval/grade.js`)

Common to all agents:

| Check | What it verifies |
|---|---|
| `format` | The answer is the JSON contract: `draft`, `reason`, `limits` (strict parse). |
| `grounded` | Every number of four digits or more, or with a decimal, in the draft or the reason appears in the case's sources. |
| `noInventedIds` | Identifiers such as `product:…` appear in the sources, and no identifier the case forbids. |
| `noUnjustifiedClaim` | No promise, causality, attribution, past action, or spend order that the sources cannot justify. |
| `noPersonalData` | No e-mail, phone number, IBAN, or link with parameters in the answer. |
| `statesLimits` | When a source is not connected or unavailable, the answer says so. |
| `usesCaseTerms` | The answer uses at least one term taken from the case's own sources. |

Agent-specific:

- Stratège: at most three numbered steps.
- Expériences: the answer names a hypothesis, a duration, and stop criteria.
- Publicités: no imperative spend order.
- Audience: aggregate only (no personal data).

## Two kinds of tests, kept apart

1. **Contract and security tests (automated, simulated answers).** `test/growth-eval.test.js`, `test/growth-privacy-hardening.test.js`,
   `test/growth-a5-privacy.test.js`, `test/growth-agents.test.js`. They prove the grader and the filters discriminate. They are not evidence
   of answer quality.
2. **Quality evaluation (real provider answers, offline grading).** Requires an owner-approved step outside this harness:
   1. Choose the provider and the model, and confirm the cost and the data policy with the owner.
   2. Run the provider on the 24 synthetic cases only. No merchant or customer data. The owner decides when this happens.
   3. Save the answers as `{ "<case id>": <answer> }`.
   4. Grade offline: `node scripts/growth-agent-eval.mjs --answers answers.json --out report.md`.
   5. A human reads each answer for usefulness and accuracy; the checks above do not judge writing quality.

The script never calls a provider. It reports the provider configuration by variable name only (`GROWTH_AI_PROVIDER`, `GROWTH_AI_API_KEY`,
`GROWTH_AI_MODEL`), never a value.

## Limits

- Checks are heuristic: a number written differently from the source, or a claim phrased without the listed words, can pass.
- The checks do not judge usefulness, prioritisation, or tone. A human reading is required before any conclusion about quality.
- Only Growth's eight agents are covered. Other modules are out of scope.
- Synthetic cases only: real merchant data would change the difficulty and must not be used for a first evaluation.
