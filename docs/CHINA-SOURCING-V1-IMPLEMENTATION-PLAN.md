# China Sourcing Intelligence V1 - Implementation Plan

Companion to `docs/CHINA-SOURCING-V1-GAP-ANALYSIS.md` and `docs/CHINA-SOURCING-V1-PROVIDER-SPIKES.md`. Nothing here has been built.

**Revision 2 (after Phase 0).** P0 is done (investigation only). Owner decisions are recorded in the section "Owner decisions". The workflow shell is now built EARLY as **P3.5** so the field UX can be validated on the physical phone before the deep layers exist. Provider choices changed in light of the P0 findings (see the spikes document): Access2Markets is not usable as a data source; Chrome/Edge speech and translation APIs are not an acceptable privacy path. Each phase is one small, reversible, separately committed unit on its own branch off `feature/china-sourcing-field-mode`. **No phase starts without the owner's approval of that phase. No push, merge, deploy or production change in any phase.**

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
`cashRequired = economicCost + importVatToAdvance`. The VAT treatment is a configurable per-business setting (overridable per order) with four values plus unknown: `ADVANCED_RECOVERABLE` (cash out now, economic cost zero, recovered later), `DEFERRED_NOT_ADVANCED` (no import-VAT cash at the border; economic cost zero), `NON_RECOVERABLE` (VAT is a real cost AND a cash item), `UNKNOWN` (default until the owner confirms the real treatment: VAT lines are shown as UNKNOWN and cash becomes a lower bound; nothing is assumed either way). `recoverableVat` is reported separately. Example target output: landed ex VAT 1,215 / import VAT to advance 255 / cash required 1,470 / recoverable 255.
`peakCash` = maximum of the running balance over the payment timeline (deposit, balance, freight, customs, VAT, final delivery), each item dated or ordered; unknown dates keep the item as UNSCHEDULED and make the peak a lower bound.

**Allocation of shared costs.** Largest-remainder method on integers over the chosen basis (weight, CBM, value, units, manual), so allocated parts always sum exactly to the shared total; a missing basis value for any SKU makes the allocation UNKNOWN (never a silent equal split).

**Can I buy this?** For a prospective order (qty, unit price) against the session: `additionalCash = cash(order)`; `remaining = budget - paid - committedUnpaid - futureImportCosts - futureVatToAdvance - otherExpected - reserve`; recommendation by explicit rules; `maxQtyWithinBudget` = largest integer qty with `additionalCash(qty) <= remaining` found by deterministic search (cost is monotone in qty; tiers resolved per qty); the result states what is fixed and what scales.

**Negotiation bands.** From the money engine, not thresholds: `targetBuy` = price at which contribution equals the target margin using the *pessimistic-leaning* cost scenario; `acceptable` = from target up to the price where contribution equals the owner's stated minimum margin (or the existing "borderline" definition); `tooExpensive` = above. Each bound shows its derivation inputs and is UNKNOWN when an input is UNKNOWN.

**Provenance vocabulary** (`FACT_STATUS`): SUPPLIER_CLAIM, DOCUMENT_RECEIVED, DOCUMENT_MATCHED, VERIFIED, ESTIMATED, USER_PROVIDED, UNKNOWN, CONFLICT - mapped onto, not replacing, `FACT_CLASS` / `IDENTITY_LEVEL`. A spoken or written supplier statement can never exceed SUPPLIER_CLAIM; DOCUMENT_MATCHED requires a received document that names the same model; VERIFIED requires an official source.

---

## P0 - Baseline and provider spikes (no product code) - DONE (documentation only)

Result: `docs/CHINA-SOURCING-V1-PROVIDER-SPIKES.md`. The remaining P0 items that need a human or an approval are listed there as P0b (phone capability probe, first model download approval). The original scope of P0 follows for reference.

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

## P3.5 - Field workflow shell v0 and FIELD-UX CHECKPOINT 1 (new, early)

- **Purpose:** validate on the physical phone, in real use in front of a supplier, whether the path Discover -> Talk -> Capture -> Complete -> Analyze -> Decide -> Negotiate is understandable and fast, BEFORE the deep layers are built. What is learned here may reshape P4-P9.
- **Scope (thin, honest, reuses V0 engines only):** a new default entry "Field" above the existing eight tabs (which move into a "Specialist" drawer, unchanged). A stepper with one primary action per step and a visible "next best step":
  - **Discover:** existing Quick / identification (photo, name, category, traits); shows what is known vs unknown.
  - **Talk:** existing Ask content (P1/P2 questions, EN + 中文, single / Show-all) presented as the Supplier Assistant: "N missing, M block an order" from the existing question list. A free question can be typed and shown to the supplier; with no translation provider it is shown in English only, labelled "no Chinese available for this question" (never fake Chinese).
  - **Capture:** the supplier's answer is typed or pasted and stored as an original note (and, if the P0b probe passes, an optional voice note stored on the phone only). At this stage it is NOT parsed: a "Not extracted yet - type it into the field it belongs to" hand-off to the existing forms. Extraction and candidate review (P2/P4) plug into this same step later.
  - **Complete:** what is still missing (existing evidence gaps, questions, missing costs) with deep links.
  - **Analyze:** a button that runs the existing `assess()`; engines not built yet (market, supplier intelligence, customs official lookup, purchase plan) appear as "NOT AVAILABLE YET", neither hidden nor faked.
  - **Decide:** the existing verdict (GO / CONDITIONAL GO / NO GO / INFORMATION INSUFFICIENT) labelled as compliance + economics; the business decision (BUY / NEGOTIATE / WAIT / PASS) shows "BUSINESS PROFILE NOT SET" until P9.
  - **Negotiate:** the existing walk-away / target price and negotiation brief.
- **Files/modules:** `ui/screens/field.js` (new, after P3's split), `ui/app.js` shell routing, `ui/app.css`; no change to `core/*` except optionally one pure helper that only *summarises* existing outputs (`core/field-progress.js`: step status from the `assess()` output). No new events, no schema change.
- **Data changes:** none (UI state only: current step, kept in UI storage, not in engine state).
- **Tests first:** pure `field-progress` unit tests (each step status derived deterministically; a blocker is never hidden by the stepper; unavailable engines are labelled); e2e: shell reachable offline, all eight Specialist tabs unchanged and reachable, layout at 375/390/430 portrait and landscape, draft preservation inside the shell, no console errors, step state survives re-render and reload.
- **Acceptance:** an existing case opens in the shell with correct step statuses; the shell never states more than the engines know; the old UI path is one tap away; the 18 existing e2e checks are unchanged.
- **Regression:** full suite + e2e.
- **Rollback:** revert one commit, or a flag that makes the V0 tab bar the default again.
- **Dependencies:** P3 (modular UI). Independent of P1/P2 (it needs no extraction), so it can start right after P3.
- **Physical phone:** **REQUIRED - FIELD-UX CHECKPOINT 1.** A scripted human rehearsal on the phone: new case from a product photo, work through the seven steps with a real or role-played supplier, online and offline, in Firefox (and Chrome if available). The owner reports where they hesitated, which step name or button was unclear, what they expected next, what was too slow. Findings are written into this plan before P4 starts. No deep layer is built until the owner has seen this shell.

## P4 - Capture, Review, Finish conversation (first visible V1 surface)

- **Goal:** record or paste what the supplier said, see candidates, confirm, finish with a summary.
- **Files:** `ui/screens/{capture,review,finish}.js`, `ui/recorder.js`, `core/conversation.js`; events `CONVERSATION_START/FINISH/CONFIRM`; `ui/storage.js` audio blobs; capability rows.
- **Data changes:** `conversations[]`, `sources[]` (original voice/text kept), audio blob in IndexedDB.
- **Tests first:** capture offline then review offline; original Chinese preserved; finish summary counts (facts collected / questions resolved / documents received / missing / contradictions) computed deterministically; "Confirm and update case" is the only propagation point; re-render during recording does not stop it; refused server save loses nothing.
- **Acceptance:** works with every provider UNAVAILABLE (paste/type path complete); voice note saved as an original even with no transcription.
- **Regression:** full + e2e (new checks).
- **Rollback:** revert; stored sources are inert data.
- **Dependencies:** P1, P2, P3.
- **Audio policy (owner decision):** the original recording is kept ON THE PHONE. Nothing is uploaded automatically and nothing goes to an external provider. An explicit, optional "Copy this recording to my Nordla PC for local processing" action may exist; it names the path it will use (same Wi-Fi vs Cloudflare tunnel) before sending, and shows what was sent. Default = phone only.
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
- **Business profile (owner decision):** target margin, minimum acceptable margin, risk limits, budget and reserve are **business-profile settings entered by the owner**. Nordla ships NO default that can influence BUY / NEGOTIATE / WAIT / PASS. If the profile is missing the layer returns `PROFILE_REQUIRED` (listing exactly which settings are missing, with a one-screen form) and the existing compliance/economics verdict is still shown; it never falls back to an invented margin. (The 30% prefilled in Quick is a V0 form value for that case, not a default of the decision layer.)
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

## P14 - Local speech / translation / OCR providers (only those P0/P0b cleared)

**P0b outcome:** in scope = PP-OCRv6 small (OCR) and whisper.cpp base (English/French transcription), each only after the owner approves its exact download. **Out of scope for V1:** SenseVoice-Small (rejected: weights licence not clearly commercial) and Opus-MT (on hold: CC-BY-NC-SA training data). Mandarin speech and free-text translation stay manual in V1 (see `docs/CHINA-SOURCING-V1-MODEL-APPROVALS.md`).


- **Goal:** fill the provider interfaces with zero-cost local implementations running on the owner's PC as asynchronous jobs.
- **Files:** `providers/{speech,translation,vision}.js`, server routes `/api/transcribe`, `/api/translate`, `/api/ocr` (LOCAL region), job queue, capability rows.
- **Tests first:** provider unavailable degrades to the manual path without error; results are derivations, never replacing the original; protected tokens survive translation (model numbers, company names, standards, units); outputs labelled MACHINE READING / MACHINE TRANSLATION; no supplier content in logs; consent/region policy enforced.
- **Acceptance:** an offline voice note is transcribed after reconnect without user action; nothing is downloaded without the owner's approval.
- **Rollback:** disable the provider flag (default disabled); revert code.
- **Dependencies:** P0 results, P4. **Physical phone:** yes.

## P15 - Field workflow shell (stepper) and Specialist drawer

- **Goal:** finalise the workflow shell started in P3.5: every step backed by its real engine, honest states for anything still missing, old tabs under "Specialist".
- **Files:** `ui/screens/product.js`, `ui/app.js` shell, CSS; capability matrix wording.
- **Tests first:** the old eight tabs stay reachable and unchanged; layout at 375/390/430 portrait and landscape; no horizontal scroll; tap targets; the stepper never hides unresolved blockers.
- **Rollback:** revert (flag to restore the V0 tab bar as default).
- **Dependencies:** P4-P9. **Physical phone:** **required** (the final field rehearsal: create session, talk, capture, import offer, analyze, decide, negotiate, offline then reconnect).

The shell itself now exists from P3.5 (below); P15 is only the finalisation once the deep layers exist.

---

## Owner decisions (received after the analysis)

1. **Audio:** phone-first. Original audio preserved locally on the phone; no automatic cloud or external-provider upload. An explicit optional copy to the owner's Nordla PC for local processing may be supported; any transfer path must be visible to the user (P4, P14).
2. **Import VAT:** configurable, UNKNOWN until the business's treatment is confirmed. Must support advanced-and-recoverable, deferred/not-advanced, non-recoverable, unknown. Nothing is assumed (P7, P8).
3. **Margins and risk limits:** business-profile settings entered by the owner. No invented defaults that affect BUY/NEGOTIATE/WAIT/PASS (P9).
4. **Models and free sources:** exploration approved; before ANY substantial download Nordla reports exact model/version, licence, size, expected RAM/disk, expected performance on this machine and the V1 capability it provides, then waits for approval (P0b, P14).
5. **Plan adjustment:** an early minimal workflow shell for field-UX validation (P3.5 below).

## Suggested order of delivery and first slice

P0 (done) -> P1 -> P2 -> P3 -> **P3.5 Field workflow shell v0 + FIELD-UX CHECKPOINT 1** -> P4 (first thing the owner can touch in the field) -> P5 -> P6 -> P7 -> P8 -> P9 -> (P10, P11, P12, P13 in the order the field rehearsal shows to matter) -> P14 -> P15.
Each arrow is an owner approval and, where marked, a physical-phone check. No phase is bundled with another into one commit.

---

## Progress log (updated 2026-10-05, after the overnight build)

Done and tested (details in `docs/CHINA-SOURCING-V1-OVERNIGHT-REPORT.md`): **P2** (deterministic EN + narrow ZH extractor), **P1** (provenance ledger, candidates, conflicts, price tiers, schema 2, conversation sessions, free questions), **P3** (UI split into modules), **P3.5** (Field workflow shell) and the **P4 foundation** (text capture, candidate review, conflicts, finish summary; no audio, no AI). Learnings that adjust the plan:

- **P4 (full)** is now only the *audio* part: record on the phone (browser default format, ogg/opus on the owner's Firefox 157, about 950 KB per minute, so cap the bitrate), keep the original, chunk every second into IndexedDB, request persistent storage, assume a repeated microphone prompt, tell the owner to keep the screen on (background/lock-screen recording is UNTESTED). The review flow it plugs into already exists.
- **P5 (adaptive Ask)** is the next visible gap: the Talk step still shows the static V0 list; the ledger already knows which facts were confirmed, so questions can resolve themselves.
- **P6 (offers)** is cheaper than planned: pasted quotations and PDF text can go through the same extractor and review flow; tiers are already in the quote.
- **P3.5 FIELD-UX CHECKPOINT 1** (physical phone) is the gate before P5-P9: the rehearsal script is in the overnight report, section 14.
- The business decision stays "NOT AVAILABLE YET" until P9; the Field shell says so on screen.

---

## Progress log (2026-10-06): Field Mode, P5 conversation engine, grouped confirmation

Done (details in `docs/CHINA-SOURCING-V1-FIELD-MODE-REPORT.md`): Field/Expert mode switch (Expert default), conversational Field Mode (Conversation + Summary views), **P5 as a pure conversation engine** (known / missing / contradictions / best next question, supplier vs owner audience, memory of shown/skipped questions, bundled documents, suggested commercial questions, French progress message, timeline), **grouped confirmation** with provenance guarantees, continuous recomputation (no "Analyze"), interpreter foundation (`CONVERSATION_DERIVE`, translation-provider seam, market profile), Chinese review states + `NATIVE_REVIEW` mechanism + generated review sheet. Next gate: **FIELD UX CHECKPOINT 2** on the physical phone; Field becomes the default only if it passes. P6 (offers), P7 (money), P10 (market) remain unstarted.
