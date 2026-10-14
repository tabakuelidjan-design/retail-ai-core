# One case, three modes: the fact state (P0 repair)

Terrain (Conversation), Expert (Quick / Money / Case) and Salon are three views and controllers over **one** case: an append-only event log reduced into one aggregate (`core/case.js`), stored once (`S.cases[id]` on the phone, `PUT /api/cases/:id` on the server). Nothing below is a second store.

## Forensic map (what each mode read and wrote BEFORE this repair)
| | reads | writes |
|---|---|---|
| **Terrain** `ui/screens/fieldfirst.js` | the **ledger** (latest entry per key) + pending candidates | `CONVERSATION_ITEM`, `CANDIDATE_CONFIRM/CORRECT/REJECT` |
| **Expert** `quick.js`, `money.js`, `case.js` | the **quote projection** `quotes.at(-1)` (`quoteOf`) | `QUOTE` / `IDENTIFIER` events typed in a form: **no ledger entry, no provenance** |
| **Salon** `salon-views.js`, `core/field/*` | the **candidates of ONE offer** (`offerDraft`) for review; the quote projection for numbers | `OFFER_IMPORT`, `CANDIDATE_*`, `PLAN_QTY`, numbers |

Three read paths over three projections (ledger / quote / per-offer candidates), and one writer (Expert) that bypassed the ledger.

## The Remax trace (reproduced with the real code, `test 7`)
1. First phone test: the extractor of that build understood only `moq 24pc`. The review screen offered **one** fact. An explicit `CANDIDATE_CORRECT` on that candidate set `correctedValue = 11`, state `CORRECTED`, ledger `led-1 = 11 (USER_PROVIDED, corrected, original 24)`, quote `moq = 11`. (The first-test report said exactly this: "MOQ 24 pcs, then corrected by owner to 11 pcs".)
2. The full note was imported again (offer 2). The supplier's `moq 24pc` is a negotiable term of an updated offer, so it **supersedes** (ledger `led-4 = 24`, quote `moq = 24`). Offer 1's candidate is **not touched**: it stays `CORRECTED 11` as history.
3. Today: Terrain reads the ledger → **24**; Expert reads the quote → **24**; the Salon review of offer 1 reads that candidate → **"11, corrigé par vous (le fournisseur disait 24)"**. Same case, three answers. The review screen showed an *archive* as if it were the current fact and offered no way back to the current fact.

`WHERE_11_WAS_CREATED` = the ledger/candidate of offer 1 (`led-1`, `cand-1`) · `EVENT` = `CANDIDATE_CORRECT` · `MODE` = the Salon review (the only mode that showed that candidate with a "Corriger" button) · "corrected by you" = `status USER_PROVIDED` of a `CORRECTED` candidate, which is only ever set by an explicit correction event (every setter of `correctedValue` / `CORRECTED` was searched: `conversation.js` `confirm/correct/resolve`).

**What cannot be proven from this repository:** who tapped it, and when. The owner's stored case lives on the phone (and in the server's data folder on the owner's computer), not here. Two things settle it in one command: `node tools/case-audit.mjs <case.json> --trace MOQ` prints every ledger entry, candidate and event with its timestamp. Nothing in the code can create a `CORRECTED` candidate without an explicit `CANDIDATE_CORRECT` event.

## The repair
* `core/case-facts.js`: **`caseFacts(state)`** is the one read model (fact type, value, unit/currency, source type, source reference, provenance, review status, created_at, revision, supersedes / superseded_by, history). **`FACT_CORRECT` / `FACT_REVERT` / `FACT_OBSERVE` / `FACT_ACCEPT`** are the one way to change or observe a fact.
* Terrain, Expert and Salon read **`caseFacts`** (Terrain rows, Quick / Money prefill via `expertQuote`, Salon *Faits* tab) and write through it (Terrain *Corriger* on a fact, Quick / Money forms record **only the fields that changed**, Salon *Corriger*).
* Source types: `USER_PROVIDED · SUPPLIER_CLAIM · IMAGE_OBSERVED · DOCUMENT_OBSERVED · SYSTEM_DERIVED · VERIFIED` (+ `UNATTRIBUTED_LEGACY` for a value no ledger entry explains). Review status is separate: `NOT_REVIEWED · CONFIRMED · CORRECTED · REVERTED · REJECTED · CONFLICT`. A value shown, prefilled, parsed, merged, reloaded or stored never changes its source.
* Found by the three-mode test on the way: the **Quick form saved without a lead time wiped the quote's lead time** (a V0 form drops what it does not have). Fields a form does not carry are now kept.
* The review of an older offer says "Ancienne offre : lecture d'archive", shows the **current** value beside the old one and links to the fact. Salon *Faits* flags a stale correction and one equal to the unit price (a hint, not a verdict) with **Annuler cette correction**.
* **Cancelling a correction is append-only**: the correction stays in the ledger (voided, with the reason in `case.factAudit`); if it was the current value, the previous value comes back as a new entry (`revertOf`).

## Repairing the real Remax case
On the phone: Salon → the Remax fiche → **Faits** → the red "Ancienne correction" block → **Annuler cette correction**. On the computer: `node tools/case-audit.mjs case.json --revert <ledgerId> --reason "..." --out repaired.json` (never modifies the input). Neither has been run on the owner's data: that data is not in this repository.
