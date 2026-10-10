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

## Revision Cycle 1 preparation (the two runtime gaps, closed)

**Brand Guardian is a deterministic gate of the runtime.** `src/creative-runtime/guardian-gate.js` wraps the existing `evaluateBrandGuardian` over a manifest built from the produced
DesignDocument and the Fidelity gate it consumes. `runProductPreservingCreative` runs it on **every** candidate it produces; a runtime without a gate cannot reach `READY_FOR_REVIEW`
(`BLOCKED: BRAND_GUARDIAN_NOT_CONFIGURED`), and a Guardian that does not PASS gives `GUARDIAN_FAIL`. The critic never replaces or overrides it. The verdict adds
`ready_for_owner_review` = Preflight PASS ∧ Fidelity PASS ∧ Guardian PASS ∧ critic not `CREATIVE_FAIL` (a routing state, not an approval).

**The revision-side Creative Director.** `src/creative-runtime/revision-director.js`. It consumes, through an explicit allow-list (`normalizeRevisionEvidence`): the original brief, the
previous creative direction (its creative fields), the evidence of the previous candidate (recipe, roles, gate outcomes, product share: facts, no geometry), the normalized critique and the
normalized semantic revision request. Anything else (an owner review, a coordinate, a colour, a font size, a design opinion) is refused at the door, and all text that crosses is re-checked
for pixel / coordinate / font / colour literals. The model's revised direction is checked the same way, must not add fields, and must **differ meaningfully** from the previous one (a
structural field changed, or at least two descriptive fields rewritten). It is recorded as `REVISION_DIRECTION` by `nordla:revision-director@1`. The owner-review module is imported by none
of the revision path (a test checks it).

**Revision cycle** (`scripts/run-c3-revision.mjs`): Candidate 1 → critique v2 → semantic intents → revised direction → production plan → environment (text-only) → deterministic product-preserving
composite → deterministic text → Preflight → Fidelity → Brand Guardian → critique of Candidate 2 (only if every deterministic gate passed). Bounded by `MAX_CANDIDATES = 3`; a cycle needs
`--confirm-revision-cycle=1`; one lock that code never releases; three billable calls (revision Director, environment, vision critic).

## Revision Cycle 1, first live attempt (2026-10-10): stopped at the layout

The revision Director's accepted direction (spatial intent `PRODUCT_START_TEXT_END`) selected the recipe `EDITORIAL_SPLIT`, whose text column (46% of the usable width) cannot hold the approved
supporting claim on one line at the minimum size of the type scale (`TEXT_DOES_NOT_FIT / TOO_MANY_LINES`, supporting text limited to one line by `TYPE_SCALE_V1`). The solver returned
`UNSATISFIED`, no document was rendered, so Preflight, Fidelity and Brand Guardian never ran. Cause: **LAYOUT_CAPABILITY_LIMIT** (a limit of the five recipes and of the type rules, not a
bug and not a HABB-specific problem). Two runtime defects were found and fixed generically: the layout is now solved **before** the billable environment call (it needs only the cut-out and
the canvas size), and a stop is reported by its real stage and one classified cause (`stop-stage.js`, `--explain`), never as a failure of gates that did not run. The layout rules were not
changed to make this direction pass.

## Known gaps (reported, not hidden)

- Candidate 1 was produced before the Guardian existed in the runtime, so it keeps `guardian = NOT_EVALUATED`; every later candidate has a Guardian result.
- Whether a revised direction is sufficient to move the layout depends on the recipes available (five today): the Director can change the spatial intent, the hierarchy and the environment, not invent a layout.
