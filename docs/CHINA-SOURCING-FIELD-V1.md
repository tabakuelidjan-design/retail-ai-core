# China Sourcing - Field V1 (travel-ready build)

One workflow, not a set of features: **see -> capture -> understand -> verify -> compare -> know what is missing -> know what to ask -> negotiate -> update the offer -> see what changed -> get a sourcing recommendation -> save -> resume.**
It sits on the existing case, evidence ledger, conversation engine and P11-lite comparison. Nothing there was redesigned; Field V1 adds derived views over them.

Merchant profile: chosen explicitly with `SOURCING_MERCHANT_ID=<id>` (reads `config/merchants/<id>/sourcing-fit.json`) or `SOURCING_MERCHANT_PROFILE=<file>`; with neither, no profile is loaded and the fit says so. The sourcing source names no merchant (tested). Real-device flow: `docs/REAL-PHONE-TEST.md`; owner inputs still needed: `docs/HABB-SOURCING-PROFILE-INPUTS.md`.

Phone: Mode terrain -> **Salon** (menu or the "Salon" button of the guided screen). Everything below works offline; the server only keeps a merged copy.

## Layers (all pure, isomorphic, in `src/sourcing/core/field/`)
| Module | What it is | Source of truth |
|---|---|---|
| `offer-import.js` | **P6-lite OfferImport / OfferDraft**: pasted quote, chat, PDF text layer, typed quote -> candidate facts. Original text kept; a missing value is UNKNOWN. | `case.offers[]` is an index; facts are the existing candidates / ledger |
| review | CONFIRM / CORRECT / REJECT = the existing `CANDIDATE_*` events (original, reviewed value, time and state are on the candidate and the ledger) | case |
| `revisions.js` | offer revisions and **WHAT CHANGED** (price, tiers, MOQ, lead time, packaging..., landed cost, recommendation) | view over `quotes[]` + ledger (append-only), ordered by what the case recorded, never by a clock |
| `truth-card.js` + `memory.js` | **Supplier Truth Card** (identity, evidence health VERIFIED / SUPPLIER_CLAIM / ESTIMATED / UNKNOWN / CONFLICT, six risk areas, behaviour memory) and the supplier history across cases | recomputed from the case |
| `external-evidence.js` | `EvidenceProviderContract`: how ImportYeti / QIMA-type providers can feed the card later (one `EXTERNAL_EVIDENCE` event). No provider is connected. A declared VERIFIED is kept only for a *registered* provider (none today). Also the sample lifecycle (`SAMPLE_RECORD`). | case |
| `merchant-fit.js` | transparent checklist: 13 dimensions (SUPPORTED / PARTIAL / UNKNOWN / NOT_APPLICABLE, with a reason), label HIGH / MEDIUM / LOW / INSUFFICIENT_EVIDENCE by a printed counting rule. **The HABB data is config** (`config/merchants/habb/sourcing-fit.json`, DRAFT for owner review): the engine is generic. | derived |
| `deal.js` | **DealIntelligence**: quote, tiers, MOQ, landed per unit, maximum and target purchase price, margin, cash, sample cost, Incoterm effect, tier breakpoints, EXW-vs-FOB inversions. Customs, VAT, freight and fees are never guessed. | derived from the existing economics |
| `negotiation.js` | **NegotiationCoach**: current offer, target, walk-away, what to ask now, what to trade. Target only from the economics + a merchant-configured step; otherwise `INSUFFICIENT_DATA_FOR_NEGOTIATION_TARGET`. Never autonomous. | derived |
| `ask-now.js` | **Questions to ask now**: 2-5, ranked by decision impact, with the Chinese review state (the phrasebook is NOT native-reviewed) | derived from the conversation engine |
| `evidence-status.js` | **DecisionEvidenceStatus**: STRONG / MEDIUM / WEAK / INSUFFICIENT evidence *completeness* with blocking items and what would improve it. Not a probability of success. | derived |
| `derived.js` | dependency-aware recompute: each node declares what it reads; unchanged nodes are reused; the previous result moves to a bounded history; incremental == full recompute (tested) | cache (disposable) |
| `field-comparison.js` | the P11-lite set answered as the seven field questions + sections: summary, cards, decisive differences, risks, economics, evidence, ask next, recommendation | derived |
| `workspace.js` + `store/workspace-store.js` | saved comparisons (definition only), recommendation / fit / deal history (append-only, content-derived ids), ask progress, supplier index, last view. Merges phone and server **without loss**. | workspace (never case data) |
| `engine.js` | one entry point for the screens | - |

Fixes made on the way (each with a failing test first, `test/sourcing-field-v1-extract-ranges.test.js`): a price table written as ranges (`100-299pcs`) used the *upper* bound as the tier threshold (300 pieces were priced at the 100-299 price); `MOQ 300, FOB...` lost its MOQ (the comma was read as a thousands separator); a material lost its qualifier (`aluminium alloy` -> `aluminium`).

## Rules that hold everywhere (tested)
- A supplier statement is a **SUPPLIER_CLAIM**; nothing a supplier says is VERIFIED; a supplier document, even for the right model, stays a supplier document.
- A missing value is **UNKNOWN**; nothing is defaulted or inferred.
- A contradiction is never resolved silently; a changed *negotiable* term (price, MOQ, lead time, Incoterm, payment, packaging) of an **updated offer** is a revision, a changed *product fact* (material, model, certificate) is a conflict a person resolves; two values inside one offer are a conflict.
- The owner's own lines in a pasted chat never become supplier facts; a speaker nobody established is UNKNOWN until the owner says who is who.
- No price-only winner; the recommendation (BUY_CANDIDATE / INVESTIGATE / PASS) is always `RECOMMENDATION_PENDING_APPROVAL`, `canCommitMoney: false`; the business decision stays outside Sourcing.
- No provider call anywhere in Field V1 (tested: `fetch` is rigged to fail during the simulation).

## Offline
Cases and the workspace live on the phone (localStorage / IndexedDB); all computation runs in the browser; the service worker caches the whole shell (new files are in `/shell-manifest.json`). Reading a PDF needs the server and says so offline; pasting text works. The merchant profile is fetched once (token) and cached; without it every fit dimension says "profile not loaded".

## Tests
`test/sourcing-field-v1-*.test.js` (offer import, revisions/what changed, deal/negotiation, fit/truth card/memory/evidence/ask, derived state, workspace, server routes, **China Day simulation**, performance), `test/e2e/sourcing-field-v1.e2e.js` (real Chromium at 390 px), `tools/field-v1-mutation.mjs` (mutation check limited to decision logic, provenance, conflicts, recommendation, invalidation).

## Not built (by design)
Supplier CRM / procurement ERP, Buying handoff, live OCR or translation, Alibaba / 1688 / WeChat, outreach, customs or freight APIs, ImportYeti / QIMA connectors, a native-speaker review of the Chinese, business-card scanning (no capture path existed), automatic classification of goods (the HS/CN code stays a CANDIDATE).
