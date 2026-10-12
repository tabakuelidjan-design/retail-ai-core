# China Sourcing - P11-lite: multi-offer comparison

Module: `src/sourcing/core/comparison.js` (pure, deterministic, no provider, no network). Tests: `test/sourcing-comparison.test.js` (17).

## What it does
Compares **2 to 5 existing cases** (one case = one product from one supplier) side by side. It reads each case and its `assess()` output; it **never writes to a case**. Same cases + same `now` + same externals = the same result, byte for byte. Human-in-the-loop stays mandatory: it only organises what is on record.

## What it refuses to do
- Rank on price alone (the summary carries `priceOnlyWinner: false`).
- Turn UNKNOWN into a value: an unknown cell has `value: null`, the numeric dimension is marked `comparable: false`, and an UNKNOWN never counts against an offer (it makes it INVESTIGATE, not BLOCKED).
- Name a winner on insufficient evidence: `PREFERRED` exists only among VIABLE offers, only by dominance (no worse on every compared dimension, strictly better on one, all values known), and never while another non-blocked offer is still unknown or in conflict. Otherwise `summary.noWinnerReason` says why.
- Take a company decision. It does not import the decision layer.

## Contract
| Type | Content |
|---|---|
| ComparisonSet | `schema, id, asOf, caseIds[], candidates[], dimensions[], conflicts[], summary` |
| ComparisonCandidate | `caseId, name, supplier, role, roleWhy, sourcingEvaluation{verdict,evidence,blockers,conditions,missing}, recommendation, askNext` |
| ComparisonDimension | `key, label, labelFr, comparable, cells[]` (one cell per offer) - price, MOQ, landed cost, max purchase price, margin, compliance, evidence strength, contradictions, missing evidence, lead time, terms |
| Cell / ComparisonEvidence | `caseId, status (VERIFIED / SUPPLIER_CLAIM / ESTIMATED / UNKNOWN / CONFLICT), value, display, evidence[{kind, ref, status, note}]` |
| ComparisonConflict | `CASE_CONFLICT` (an open conflict inside a case) and `CROSS_CASE_CLAIM` (same supplier and same model quoted differently in two cases); always `NOT_RESOLVED` |
| ComparisonSummary | counts per role, `preferredCaseId`, `noWinnerReason`, `priceOnlyWinner`, `openConflicts` |

Cell status rules: a supplier quote field is `SUPPLIER_CLAIM` (the ledger origin is kept in the evidence); a calculation from claims and typed estimates is `ESTIMATED`; a contradiction not yet resolved by the owner is `CONFLICT`; a missing or incalculable value is `UNKNOWN`. **Nothing is VERIFIED** except a blocking EU Safety Gate exact match read from a LIVE source. Compliance is a decision-support assessment, never a legal finding.

## Roles (sourcing evaluation)
`BLOCKED` (the existing verdict is NO_GO or a hard blocker applies) / `INVESTIGATE` (insufficient information, unknown or lower-bound landed cost, open contradiction, no usable price, weak evidence, unknown margin) / `VIABLE` / `PREFERRED`.

## Recommendation envelope (not a decision)
`BUY_CANDIDATE | INVESTIGATE | PASS`, always wrapped as `{ authority: 'SOURCING_EVALUATION', status: 'RECOMMENDATION_PENDING_APPROVAL', businessDecision: 'NOT_DECIDED', requiresMerchantApproval: true, canCommitMoney: false }`. SOURCING_EVALUATION is kept apart from BUSINESS_DECISION, which stays with the merchant / the Core (constitution); `socle-decision` is not imported (a test checks the module's imports).

## ASK NEXT (deterministic)
Per offer, the highest-weighted open item: open conflict (100) > document contradicting the case (95) > product not identified (90) > no price (88) > landed cost inputs (82) > missing required document (80) > MOQ (75) > Incoterm / terms (70) > carton (45) > lead time (40); +5 when the other offers have that dimension known (the unknown then blocks the comparison). Ties break alphabetically. The English and Chinese text come from the existing phrasebook (Chinese not native-reviewed); alternatives (max 2) are listed. `null` when nothing is decision-relevant.

## Resume later and mobile
`comparisonDefinition(set)` saves only `{ schema, id, caseIds, asOf }`; `recomputeComparison(def, casesById)` rebuilds the identical set, so it can never drift from the cases. `toMobileView(set, { lang })` gives one card per offer (lines of at most 78 characters, one status marker per line, a legend, FR or EN, "à valider / pending approval" on every recommendation).

## Not built (by design, tonight)
No UI screen yet, no persistence of comparison sets, no platform API, no supplier entity, no cash/VAT, no Buying handoff.
