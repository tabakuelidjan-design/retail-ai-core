# C3 — Creative Critic and bounded revision loop

**Status: C3 IN PROGRESS.** Creative Intelligence is not complete; C4 and C5 have not started.

## Where C2 stands (recorded, not rewritten)

C2 = REAL PROVIDER EXECUTION ACHIEVED · TECHNICAL / FIDELITY PIPELINE WORKING · AUTONOMOUS CANDIDATE PRODUCED.

The latest autonomous candidate (`candidate.png`, SHA-256 `2d57bfac…e07d` (full hash in the owner review record), 1080×1350) is recorded as
**TECHNICAL_PASS · FIDELITY_PASS · OWNER_REJECTED · NOT_SHIPPABLE**, with manual creative steering NONE. It is **not** a technical failure: the owner rejected its
creative quality, which is exactly what a Creative Critic exists to see. The owner's words are evidence for a comparison (`benchmarks/creative-intelligence/habb-c2-owner-review-001.json`),
never an input of the critic and never a template.

## Responsibilities

| Layer | Owns |
|---|---|
| Deterministic gates (Preflight, Fidelity, Brand Guardian, price/claim truth, product identity, fonts, bounds) | facts. A FAIL is final; the critic cannot override it. A gate that was not evaluated is not a pass. |
| Creative Critic (this layer) | perceptual / creative opinion about the **rendered PNG**, in 14 closed dimensions, in words, with visual evidence. |
| Creative Director + production runtime | how a revision is realized (direction, recipe, type scale, environment). |
| Owner | approval. `OWNER_APPROVED` / `SHIPPABLE` can only come from an owner-recorded record; no function of Nordla produces them. |

## Files

- `src/creative-critic/dimensions.js` — the closed vocabulary: 14 dimensions, 4 outcomes (`PASS`, `FAIL`, `REVIEW_REQUIRED`, `NOT_MEASURABLE`), generic questions (no merchant, product or campaign in them).
- `src/creative-critic/critique.js` — the trust boundary. Model output is untrusted until `normalizeCritique` turns it into a strict, deep-frozen object, or refuses it. `finalizeVerdict` computes the creative status (FAIL > REVIEW_REQUIRED > NOT_MEASURABLE > PASS) and keeps the production status at most `AWAITING_OWNER_APPROVAL`.
- `src/creative-critic/critic.js` — the blind critic behind a vision-language **port**; no image ⇒ NOT_MEASURABLE without calling a model; provider failure or non-conforming output ⇒ NOT_MEASURABLE with a classified provenance record (never repaired, never a pass).
- `src/creative-critic/revision.js` — critique → revision request: closed semantic intents, one per failing dimension, hints re-checked.
- `src/creative-critic/pairwise.js` — A/B comparison by the same dimensions; Nordla derives `PREFER_A` / `PREFER_B` / `NO_CLEAR_PREFERENCE` / `NOT_MEASURABLE` from per-dimension preferences with evidence.
- `src/creative-critic/loop.js` — the bounded loop (hard cap `MAX_CANDIDATES = 3`; each revision cycle needs an explicit human authorization; every iteration is recorded).
- `src/creative-critic/owner-review.js` — owner evidence and the per-dimension agreement report. Not re-exported by `index.js`: the critic and the loop never see it.
- `src/marketing-creative/alibaba/qwen-vision.js` — the **only** place that knows the provider, the model and the wire format.
- `scripts/run-c3-critic.mjs` — `--check` (no network), `--live` (one billable vision call under a lock that code never releases), `--compare` (offline, after the critique).

## The critique contract

```
{ critique_id, schema_version, candidate_ref, candidate_sha256,
  dimensions: [ { dimension, outcome, evidence, revision_hint|null } ×14 ] }
```

Refused: an unknown or repeated dimension; an outcome outside the four words; any number or boolean anywhere; the keys `score`, `rating`, `rank`, `winner`, `confidence`, `model`, `provider`,
`prompt`, `api_key`, `request_id`, `usage`, `approved`, `publish`, `ship`… ; a score hidden in words ("8/10", "rated 4 out of 5"); a judged dimension without visual evidence; a revision hint on
a PASS. A dimension the model did not answer is NOT_MEASURABLE, never a guessed pass. Provider/model/cost live in the adapter's `provenance`, outside the canonical object.

## Revision and pairwise

A revision request holds `{ intent, dimension, outcome, hint }` items; the intent is one of 14 semantic intents (for example `INCREASE_PRODUCT_DOMINANCE`, `CLARIFY_TEXT_HIERARCHY`).
A hint with a coordinate, size, percentage, font or colour code is refused at normalization and again when the request is built. The Creative Director and the layout / typography runtime
decide the details. Pairwise returns per-dimension preferences with evidence; there is no opaque winner score and ineligible candidates are never compared.

## Provider

The existing Frankfurt (`eu-central-1`) lane, `qwen3.8-max`, through the OpenAI-compatible chat-completions endpoint with the candidate attached as a base64 PNG data URL. No other provider,
no model fallback, no retry. The candidate contains the merchant's product photograph, so it is sent only under the scoped external-media authorization: the owner's record states that images
derived from the authorized asset may be transmitted for this purpose; `deriveCandidateAuthorization` binds the **same** scope to the candidate's own ref and bytes. Retention is stated, ZDR is
not claimed. Whether this model accepts images in the Frankfurt region is confirmed only by the first real call; a failure is reported as the blocker, never faked.

## Known gaps (reported, not hidden)

- **Brand Guardian was never run in the creative runtime.** For the existing candidate it is `NOT_EVALUATED`, so its production status is `BLOCKED_BY_A_DETERMINISTIC_GATE` until a Guardian step exists. Adding it (and storing the DesignDocument in the run summary) is a runtime task, not done here.
- Director conditioning on a revision request (the producer side of revision cycle 1) is not wired; it starts only after the owner confirms the quality of the critic.
