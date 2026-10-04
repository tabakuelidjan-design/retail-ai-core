# China Sourcing Intelligence V1 - Implementation Plan

Companion to `docs/CHINA-SOURCING-V1-GAP-ANALYSIS.md`. Nothing here has been built. Each phase is one small, reversible, separately committed unit on its own branch off `feature/china-sourcing-field-mode`. **No phase starts without the owner's approval of that phase. No push, merge, deploy or production change in any phase.**

## Rules that apply to every phase

- **Order of work:** write the failing tests first; implement; run the regression suite; physical-phone gate where marked.
- **Regression suite (every phase):** `node --test test/sourcing-*.test.js test/finance-privacy.test.js` (116 today), `npm run sourcing:e2e` (18 checks today), `npm test` (1629 today), PG17 `node --test test/pg/*.pg.test.js` (169 today) when shared code changed. Counts may only go **up**. No existing assertion is edited to pass.
- **Reporting:** the project's before/after report templates (blast radius, files, tests, rollback) per phase, then stop.
- **Rollback (default):** each phase is one commit (or a short series on one branch); rollback = `git revert` of that range. Schema changes are additive and lazy, so reverting code leaves old cases readable (unknown fields are preserved).
- **Service worker:** the cache name is bumped in any phase that changes the shell.
- **Providers:** every external capability returns `OK | UNKNOWN | UNAVAILABLE`; the product must work with all of them UNAVAILABLE.

## Cross-cutting definitions (so the phases are unambiguous)

**Business decision vs existing verdict.** The existing `decision.verdict` (GO / CONDITIONAL_GO / NO_GO / INSUFFICIENT_INFORMATION: compliance + economics + evidence) is kept exactly as is. A new field `businessDecision` is derived from it plus cash, budget and business context:

| businessDecision | Rule (deterministic, tested) |
|---|---|
| PASS | existing NO_GO (hard blocker: Safety Gate match, contradicting document, negative economics, restricted category), or no quantity/price combination keeps margin >= the business's minimum |
| WAIT | existing INSUFFICIENT_INFORMATION (critical unknowns) or a hard evidence gap that cannot be closed today (e.g. required document missing and the supplier cannot supply it before the trip ends) |
| NEGOTIATE | compliant enough to proceed but the quoted price is above the target buy price, or MOQ/terms exceed the budget or reserve; includes the quantity-reduction case |
| BUY | existing GO, or CONDITIONAL_GO whose remaining conditions are all *non-blocking before commitment*, AND price <= acceptable band AND the order fits budget minus reserve |

`canCommitMoney` stays false for anything but a real GO. BUY never overrides a compliance blocker. Each result carries `why`, `verified`, `estimated`, `unknown`, `couldChange`, `nextBestActions[]`.

**Cost vs cash (integer minor units).**
`economicCost = goods + chinaDomestic + consolidation + freight + insurance + originCharges + duty + brokerage + inspection + testing + compliance + labelling + epr + finalDelivery + otherNonRecoverable + (importVat if NOT recoverable)`.
`cashRequired = economicCost + importVatToAdvance` where `importVatToAdvance = importVat if the owner marks "VAT must be advanced" else 0` (an explicit per-order flag, default UNKNOWN -> shown as unknown, never assumed either way). `recoverableVat` is reported separately. Example target output: landed ex VAT 1,215 / import VAT to advance 255 / cash required 1,470 / recoverable 255.
`peakCash` = maximum of the running balance over the payment timeline (deposit, balance, freight, customs, VAT, final delivery), each item dated or ordered; unknown dates keep the item as UNSCHEDULED and make the peak a lower bound.

**Allocation of shared costs.** Largest-remainder method on integers over the chosen basis (weight, CBM, value, units, manual), so allocated parts always sum exactly to the shared total; a missing basis value for any SKU makes the allocation UNKNOWN (never a silent equal split).

**Can I buy this?** For a prospective order (qty, unit price) against the session: `additionalCash = cash(order)`; `remaining = budget - paid - committedUnpaid - futureImportCosts - futureVatToAdvance - otherExpected - reserve`; recommendation by explicit rules; `maxQtyWithinBudget` = largest integer qty with `additionalCash(qty) <= remaining` found by deterministic search (cost is monotone in qty; tiers resolved per qty); the result states what is fixed and what scales.

**Negotiation bands.** From the money engine, not thresholds: `targetBuy` = price at which contribution equals the target margin using the *pessimistic-leaning* cost scenario; `acceptable` = from target up to the price where contribution equals the owner's stated minimum margin (or the existing "borderline" definition); `tooExpensive` = above. Each bound shows its derivation inputs and is UNKNOWN when an input is UNKNOWN.

**Provenance vocabulary** (`FACT_STATUS`): SUPPLIER_CLAIM, DOCUMENT_RECEIVED, DOCUMENT_MATCHED, VERIFIED, ESTIMATED, USER_PROVIDED, UNKNOWN, CONFLICT - mapped onto, not replacing, `FACT_CLASS` / `IDENTITY_LEVEL`. A spoken or written supplier statement can never exceed SUPPLIER_CLAIM; DOCUMENT_MATCHED requires a received document that names the same model; VERIFIED requires an official source.

---

## P0 - Baseline and provider spikes (no product code)

- **Goal:** settle the "honest unknowns" before designing against them.
- **Files/modules:** `docs/CHINA-SOURCING-V1-PROVIDER-SPIKES.md` only; throw-away scripts outside the repo.
- **Data changes:** none.
- **Tests first:** n/a (measurements). Record: speech (English and Mandarin sample clips, real-time factor and error on numbers/model names), local MT (EN<->ZH on the 20 phrasebook sentences plus 20 free questions), OCR on Chinese printed text, memory/disk per model; free sources: TARIC / Access2Markets machine access, Eurostat Comext, bol.com programmes, terms of use for each.
- **Acceptance:** a table: provider, works Y/N, speed, accuracy on protected tokens, disk, terms OK Y/N/unclear. Owner decides which to pursue. No model is committed or shipped by this phase.
- **Regression:** none needed (no code); baseline counts re-run and recorded.
- **Rollback:** delete the doc.
- **Dependencies:** none. Downloads require explicit owner approval per item (size stated first).
- **Physical phone:** microphone/audio capture check on the owner's Android (MediaRecorder + IndexedDB size) - short human test.

## P1 - Provenance, fact ledger, conflicts, schema 2 (pure core)

- **Goal:** the vocabulary and rules that stop claims from becoming facts.
- **Files:** new `core/provenance.js`, `core/conflicts.js`, `core/upgrade.js`; edit `core/levels.js` (additive), `core/case.js` (schema 2 fields + events `SOURCE_ADD`, `DERIVATION_ADD`, `CONFLICT_RAISED`, `CONFLICT_RESOLVE`, `DOC_CLAIMED`, `DOC_PROMISED`).
- **Data changes:** `schema: 2` adds empty `sources, derivations, ledger, conflicts, documentLedger, conversations, questionStates, offers`; `upgradeCase` pure and idempotent.
- **Tests first:** supplier claim never exceeds SUPPLIER_CLAIM; "UN38.3 available" stays a claim and Docs still shows not received; contextual MOQ (100 product vs 300 custom-logo) is not a conflict; unresolved MOQ 100 vs 300 is CONFLICT with a clarification question; case model PB-X200 vs document PB-X180 raises a HIGH mismatch; schema-1 fixtures upgrade losslessly and re-assess to identical results; double upgrade is a no-op.
- **Acceptance:** every existing fixture's `assess()` output is byte-identical after `upgradeCase`; new suites green.
- **Regression:** full suite (this touches `case.js`).
- **Rollback:** revert; schema-2 cases read fine by V0 code because fields are additive.
- **Dependencies:** none.
- **Physical phone:** no.

## P2 - Deterministic extraction (English + Chinese) producing candidates

- **Goal:** turn text into candidate facts, offline, with no AI.
- **Files:** new `core/extract/{patterns,en,zh,index}.js`, `core/candidates.js`; events `CANDIDATES_PROPOSED`, `CANDIDATE_CONFIRM`, `CANDIDATE_CORRECT`, `CANDIDATE_REJECT`.
- **Data changes:** `candidates[]`, ledger entries on confirm.
- **Tests first (corpora, synthetic):** price + currency (USD, US$, 美金, RMB, 元, 块), MOQ (起订量, "MOQ 100"), tiers ("100pcs 6.5, 500pcs 6.0"), Incoterm and port, lead time, payment (30% deposit / 70%, 定金/尾款), colours and mixed-colour MOQ, logo/packaging customisation and its MOQ, capacity (mAh/Wh), carton data, model numbers and company names preserved byte-for-byte, quantities with 万, ambiguous numbers produce a context-labelled candidate or none (never a guess), supplier answers several questions at once.
- **Acceptance:** precision on the corpus reported (not just pass/fail); every candidate has `span` and `extractor` version; confirming dispatches only existing events (QUOTE, IDENTIFIER, TRAIT, SUPPLIER, COSTS) and the engines recompute; confirm is idempotent.
- **Regression:** sourcing suites + e2e.
- **Rollback:** revert; no UI yet, nothing user-visible.
- **Dependencies:** P1.
- **Physical phone:** no.

## P3 - UI modularisation (zero behaviour change)

- **Goal:** make the phone app safe to extend.
- **Files:** split `ui/app.js` into `ui/screens/*.js`, `ui/sync.js`, `ui/draft.js`, `ui/state.js`; update `sw.js`/shell manifest list.
- **Data changes:** none.
- **Tests first:** the existing 18 e2e checks are the safety net; add a test that fails if any module is missing from the shell manifest (offline cold start proves it).
- **Acceptance:** 18/18 unchanged; DOM output of every existing screen identical (snapshot compare in the e2e harness); no new feature.
- **Regression:** full suite + e2e.
- **Rollback:** revert the single commit.
- **Dependencies:** none (can run before P1).
- **Physical phone:** yes (smoke): install, offline, edit, reconnect - the same scenario that passed.

## P4 - Capture, Review, Finish conversation (first visible V1 surface)

- **Goal:** record or paste what the supplier said, see candidates, confirm, finish with a summary.
- **Files:** `ui/screens/{capture,review,finish}.js`, `ui/recorder.js`, `core/conversation.js`; events `CONVERSATION_START/FINISH/CONFIRM`; `ui/storage.js` audio blobs; capability rows.
- **Data changes:** `conversations[]`, `sources[]` (original voice/text kept), audio blob in IndexedDB.
- **Tests first:** capture offline then review offline; original Chinese preserved; finish summary counts (facts collected / questions resolved / documents received / missing / contradictions) computed deterministically; "Confirm and update case" is the only propagation point; re-render during recording does not stop it; refused server save loses nothing.
- **Acceptance:** works with every provider UNAVAILABLE (paste/type path complete); voice note saved as an original even with no transcription.
- **Regression:** full + e2e (new checks).
- **Rollback:** revert; stored sources are inert data.
- **Dependencies:** P1, P2, P3.
- **Physical phone:** **required** (microphone, Firefox/Chrome, airplane mode).

## P5 - Adaptive Ask / Supplier Assistant

- **Goal:** questions that update as facts arrive, plus free questions.
- **Files:** `core/questions-state.js`, edit `core/supplier.js` (templates, suggested commercial questions, dynamic `doc_fix` for model mismatch), `ui/screens/talk.js`; events `QUESTION_ADD`, `QUESTION_STATE`.
- **Data changes:** `questionStates[]`.
- **Tests first:** "9 missing, 3 block an order" counts; a confirmed fact resolves its question; a UN38.3 for PB-X180 on a PB-X200 case generates the exact English question and its Chinese phrasebook form; free question gets a bilingual rendering labelled by origin (PHRASEBOOK / MACHINE / USER-supplied); model numbers verbatim; P1/P2 and single/Show-all modes preserved.
- **Acceptance:** all existing Ask behaviour intact; Chinese for free questions is *labelled* machine translation unless a provider is present, otherwise the English is shown with a copy button and a clear "no translation available" state.
- **Regression:** full + e2e.
- **Rollback:** revert.
- **Dependencies:** P1, P4.
- **Physical phone:** yes (show-to-supplier readability).

## P6 - Supplier offers and price tiers

- **Goal:** import an offer, review it, apply it.
- **Files:** `core/offers.js`, edit `core/landed.js` input mapping (tier resolved by quantity), `ui/screens/offers.js`; events `OFFER_IMPORT`, `OFFER_CONFIRM`, `OFFER_APPLY`.
- **Data changes:** `offers[]` (original source kept; PDF/text/photo-derived).
- **Tests first:** quotation text and PDF-text extraction into an offer; tiers choose the right unit price per quantity (boundaries 99/100/101); applying an offer dispatches the existing QUOTE; validity date; a photo/scan offer without readable text stays an *original with no candidates* (never invented).
- **Acceptance:** "I found these terms" requires confirmation before apply; original offer retrievable.
- **Regression:** full + e2e.
- **Rollback:** revert.
- **Dependencies:** P1, P2, P4.
- **Physical phone:** yes (camera/PDF import).

## P7 - Cash, VAT and payment timeline (order level)

- **Goal:** economic cost vs cash, VAT advance, peak cash, "how much and when".
- **Files:** `core/cash.js`, `core/payment-terms.js` (reads `landed` output, does not edit it), `ui/screens/cash.js`; the new fields appear in the Money tab and in `decide` inputs of the NEW layer only.
- **Data changes:** per-case `payment {depositPct, balanceTrigger}`, `vatAdvance: UNKNOWN|YES|NO`.
- **Tests first:** the worked example (1,215 / 255 / 1,470 / 255); recoverable VAT is an economic non-cost but a cash item when advanced; `vatAdvance` UNKNOWN keeps cash as a range lower bound; 30/70 timeline; peak cash on an ordered timeline; unscheduled items; rounding sums exactly.
- **Acceptance:** `landed`/`economics` outputs unchanged for all existing fixtures; a profitable but unaffordable order is visible.
- **Regression:** full.
- **Rollback:** revert.
- **Dependencies:** P6 (payment terms come from offers or manual entry).
- **Physical phone:** no (pure logic) - included in the next phone round.

## P8 - Sourcing session, budget, consolidation, Can-I-buy

- **Goal:** the trip-level purchase plan.
- **Files:** `core/session.js`, `core/budget.js`, `core/allocation.js`, `core/can-i-buy.js`, `store/file-store.js` (collections), `server/app.js` (`/api/sessions`), `ui/screens/{session,plan}.js`, sync for sessions.
- **Data changes:** new Session aggregate; per-order links to cases/offers; shipments and allocations.
- **Tests first:** the budget example (25,000 / 4,200 / 10,600 / 3,100 / 2,000 / reserve 2,000 -> 3,100 available); allocation by weight/CBM/value/units/manual sums exactly and is UNKNOWN when a basis is missing; SKU landed cost recomputed after allocation; whole-trip economic cost, total cash, peak cash; can-I-buy 500 x 4.20 with reserve breach and max quantity (e.g. 310 in the example); idempotent payment events; offline order/payment then reconnect without duplicates; sync conflicts on a session (409, keep both).
- **Acceptance:** cases without a session still work exactly as V0; the session is optional.
- **Regression:** full + PG17 (shared store code) + e2e.
- **Rollback:** revert; sessions are new files, ignored by V0.
- **Dependencies:** P3, P7.
- **Physical phone:** yes (offline order entry, reconnect).

## P9 - Business decision, negotiation bands, next best action, Analyze

- **Goal:** the single answer for THIS business and what to do next.
- **Files:** `core/business-decision.js`, `core/negotiation.js` (extends `negotiationBrief`), `core/analyze.js` (orchestrator: runs engines and providers, collects UNKNOWN), `ui/screens/{decide,negotiate}.js`.
- **Data changes:** business context on the session (channels, markets, target margin, risk limits).
- **Tests first:** the mapping table above, case by case (including "never BUY over a hard blocker"); every result has why / verified / estimated / unknown / couldChange / nextBestActions; bands derived from the money engine and UNKNOWN when inputs are UNKNOWN; analysis completes with every optional provider UNAVAILABLE; next-action list for the PB-X200 example ("obtain correct UN38.3, negotiate toward $X, confirm carton dimensions"); "make the question" produces the bilingual question.
- **Acceptance:** the existing `decision.verdict` is untouched and still shown in Specialist; the new decision is additive.
- **Regression:** full + e2e.
- **Rollback:** revert.
- **Dependencies:** P5, P7, P8.
- **Physical phone:** yes.

## P10 - Market Europe-first and scenarios

- **Goal:** honest market evidence feeding Money as scenarios.
- **Files:** `core/market.js`, edit `core/amazon.js` (generalise, keep V0 behaviour), `core/scenarios.js`, `providers/market.js`, `ui/screens` market additions.
- **Data changes:** `marketSignals[]`, `scenarios`.
- **Tests first:** CONFIRMED_SALES vs ESTIMATE vs DEMAND_SIGNAL vs OBSERVED_LISTING never merge; an estimate is always a range with confidence and method and the label "NOT PLATFORM CONFIRMED"; no sales number appears without a source; per-country (BE/NL/FR/DE) outputs UNKNOWN when no evidence; estimated market prices feed Money only as scenarios, never as verified price; pessimistic/expected/optimistic over FX, freight, price, fees; no decorative score (components shown, explainable).
- **Acceptance:** manual Amazon observations keep working unchanged; provider unavailable -> UNKNOWN with a manual-entry path.
- **Regression:** full + e2e.
- **Rollback:** revert.
- **Dependencies:** P7, P9; P0 results for any free source.
- **Physical phone:** no.

## P11 - Multi-supplier comparison

- **Goal:** compare offers without ranking on price alone.
- **Files:** `core/compare.js`, `ui/screens/compare.js`.
- **Tests first:** the "Supplier C costs $0.30 more but lower MOQ, better documents, better payment terms, similar landed cost" scenario yields a recommendation to negotiate Supplier C toward a computed price; dimensions shown separately (unit price, MOQ, Incoterm, landed, payment, cash, lead time, documents, compliance uncertainty, evidence, commercial risk); missing data stays UNKNOWN, never zero; no single hidden score.
- **Rollback:** revert. **Dependencies:** P6, P7, P9. **Physical phone:** no.

## P12 - Supplier intelligence (zero budget)

- **Goal:** claim / corroborated / verified ladder; UNKNOWN is never BAD.
- **Files:** `core/supplier-intel.js`, `core/uscc.js` (format and check-digit validation, deterministic), `providers/supplier-intel.js`, UI card.
- **Tests first:** FACTORY CLAIMED vs CORROBORATED vs VERIFIED rules (what evidence moves each step); a missing signal never lowers status below UNKNOWN; USCC validator on valid/invalid synthetic codes; address/legal-name mismatch between offer and document raises a conflict.
- **Rollback:** revert. **Dependencies:** P1, P6. **Physical phone:** no.

## P13 - Customs official-source adapter (only if P0 confirms free access)

- **Goal:** verification status, duty, measures, source and review time from an official source.
- **Files:** `providers/customs.js` behind `adapters/customs-contract.js`, edit `core/customs.js` to carry the result.
- **Tests first:** contract validation; candidate never becomes verified without an adapter result that says so; unavailable -> UNKNOWN; cached result shows its time; offline -> CACHED/UNKNOWN.
- **Rollback:** revert. **Dependencies:** P0, P1. **Physical phone:** no.

## P14 - Local speech / translation / OCR providers (only those P0 proved workable)

- **Goal:** fill the provider interfaces with zero-cost local implementations running on the owner's PC as asynchronous jobs.
- **Files:** `providers/{speech,translation,vision}.js`, server routes `/api/transcribe`, `/api/translate`, `/api/ocr` (LOCAL region), job queue, capability rows.
- **Tests first:** provider unavailable degrades to the manual path without error; results are derivations, never replacing the original; protected tokens survive translation (model numbers, company names, standards, units); outputs labelled MACHINE READING / MACHINE TRANSLATION; no supplier content in logs; consent/region policy enforced.
- **Acceptance:** an offline voice note is transcribed after reconnect without user action; nothing is downloaded without the owner's approval.
- **Rollback:** disable the provider flag (default disabled); revert code.
- **Dependencies:** P0 results, P4. **Physical phone:** yes.

## P15 - Field workflow shell (stepper) and Specialist drawer

- **Goal:** the owner sees one simple path Discover -> Talk -> Capture -> Complete -> Analyze -> Decide -> Negotiate with a single next action; old tabs under "Specialist".
- **Files:** `ui/screens/product.js`, `ui/app.js` shell, CSS; capability matrix wording.
- **Tests first:** the old eight tabs stay reachable and unchanged; layout at 375/390/430 portrait and landscape; no horizontal scroll; tap targets; the stepper never hides unresolved blockers.
- **Rollback:** revert (flag to restore the V0 tab bar as default).
- **Dependencies:** P4-P9. **Physical phone:** **required** (the final field rehearsal: create session, talk, capture, import offer, analyze, decide, negotiate, offline then reconnect).

The shell is introduced incrementally (a thin "Field" entry from P4); P15 finalises it. If the owner prefers, P15 can move earlier: its content has no logic dependencies beyond the screens it links to.

---

## Decisions needed from the owner before the phases that depend on them

1. **P4:** may audio notes stay on the phone only (default) or be copied to the PC? Over the Cloudflare tunnel audio would transit Cloudflare's edge.
2. **P7/P8:** how does the company actually treat import VAT (advance and reclaim, or deferral)? Ask the accountant/customs broker; until then the product shows it as UNKNOWN.
3. **P9:** minimum acceptable margin and risk limits (the product will not invent them).
4. **P0:** approval (with sizes stated) to try any local model.
5. **P14/P10:** approval of any specific free external source after its terms are read.

## Suggested order of delivery and first slice

P0 -> P1 -> P2 -> P3 -> P4 (first thing the owner can touch in the field) -> P5 -> P6 -> P7 -> P8 -> P9 -> (P10, P11, P12, P13 in the order the field rehearsal shows to matter) -> P14 -> P15.
Each arrow is an owner approval and, where marked, a physical-phone check. No phase is bundled with another into one commit.
