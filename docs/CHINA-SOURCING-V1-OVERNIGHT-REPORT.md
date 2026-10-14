# China Sourcing V1 - Overnight build report (2026-10-05)

Scope of the night: the deterministic, local foundation only (P1 provenance + candidates + conflicts, P2 extraction, P3 UI modularisation, P3.5 early workflow shell, P4 foundation: conversation capture and review without any AI). Nothing was pushed, merged, deployed or migrated; no production data was touched; no model was downloaded; no package was installed; no account was created.

## 1. Base state

| Item | Value |
|---|---|
| Repository | `C:\Users\etaba\Desktop\retail-ai-core-finance-resume` |
| Branch | `feature/china-sourcing-field-mode` |
| Starting commit (verified clean tree) | `f2f8d6d` (then `4b50b01`: the phone-probe results, documentation) |
| Origin branch | `e838629` (the owner's last push); local was and is ahead, nothing pushed |
| Known commits `e19a08f 29c16d4 cf79f5b c8f4c62 f2f8d6d` | all reachable |
| Temporary phone probe | was still running with 28 reports received from the physical phone; results recorded in the spikes document (section 12) and the probe stopped |
| Owner changes found | none |

## 2. Work completed

| Phase | Status | Commit |
|---|---|---|
| P2 deterministic extraction foundation (EN + narrow ZH) | done | `46d4f21`, extended later |
| P1 provenance ledger, candidates, conflicts, tiers, schema 2 | done | `d1f17a2`, `93eae53` |
| field step summary (pure) | done | `b5661c0` |
| P3 UI modularisation (no behaviour change) | done | `edde20f` |
| plain-language candidate/conflict view, validated corrections | done | `0d5750f` |
| P3.5 early workflow shell + P4 foundation (capture, review, finish, free questions) | done | `fc1d53f`, `85adaaa`, `07567e1` |

Not started (by design): offers import (P6), cash/VAT/payment (P7), sessions/budget (P8), business decision (P9), market (P10), comparison (P11), supplier intelligence (P12), customs adapter (P13), local AI providers (P14), adaptive Ask question states (P5), audio capture.

## 3. Architectural decisions

1. **Candidates are proposals; the case changes only on confirmation.** Confirmation compiles into the EXISTING events (`QUOTE`, `IDENTIFIER`), so every V0 engine, test and screen keeps working unchanged. New logic lives in front of the engines (capture, provenance) and beside them (field summary), never inside them.
2. **A supplier statement cannot rise above SUPPLIER_CLAIM.** The confirmed status of a spoken/written supplier fact is SUPPLIER_CLAIM; the owner's own note or a correction is USER_PROVIDED; nothing a conversation can do produces DOCUMENT_RECEIVED, DOCUMENT_MATCHED or VERIFIED. A document statement ("we have UN38.3") goes to a separate document ledger and changes nothing in Docs, Rules, questions or the verdict (tested by comparing the whole assessment before and after).
3. **Document status is computed, not stored**: NONE / CLAIMED / PROMISED / NOT_AVAILABLE (statements) -> DOCUMENT_RECEIVED -> DOCUMENT_MATCHED (names the case model) or MISMATCH.
4. **Conflicts are raised, never overwritten.** A confirmed candidate that differs from what the case holds (model, product MOQ, price, Incoterm, port, lead time, deposit, tiers, or "we have it" vs "we do not have it") becomes a conflict with a clarification question; the owner keeps the earlier value or takes the new one; both statements stay in the ledger. Contexts keep apart what only looks contradictory (product MOQ 100 vs custom-logo MOQ 300). Model identifiers are compared exactly: `PB-X200`, `PB X200`, `X200` are never silently equal; a format variant is reported as such.
5. **Number safety.** Values stay strings exactly as written (`6.80` is not `6.8`); an ambiguous token (`6,8`, `1,200` as a price) yields a candidate with NO value that must be corrected; typed corrections are validated and never reinterpreted (a decimal comma is refused). Weeks and 万 are converted only explicitly, flagged, with the original kept.
6. **Original preserved**: every conversation item stores the exact original text (Chinese included, byte for byte) and an empty `derived` list for future transcription/translation; each candidate points at an exact span of it.
7. **Price tiers** are an optional `tiers` extension of the quote; `quotes.at(-1)` consumers are untouched. `resolveUnitPrice` / `effectiveQuote` pick the tier price for the quantity and fail closed (below the first tier or two prices for one threshold = unknown). A V0 quote behaves exactly as before. Typing a genuinely different price replaces the tiers; a form still showing an earlier tier price does not.
8. **Schema 2 is additive and lazy**: `upgradeCase` adds six empty collections, is idempotent and never mutates; V0 cases assess identically before and after (tested on realistic scenarios) and accept every V0 event.
9. **The field shell is a view, not an engine** (`core/field-progress.js`): it summarises the case and its assessment, never decides, never hides a blocker, and lists every missing engine as NOT AVAILABLE YET. The business decision is explicitly "not available yet".
10. **Rendering invariant (recording-safe)**: a background render must never destroy user input or a running capture. Capture state lives outside the DOM; screens are rebuilt from state; typed-but-unsubmitted fields are captured/restored by `ui/draft.js`; the half-typed capture text is additionally kept in state and local storage. Documented in `draft.js` and `field.js`. The physical-phone probe confirmed that a recording keeps going through a re-render storm when its state is outside the DOM.

## 4. New data model (schema 2, additive)

On the case: `conversations[]` (id, supplierRef, startedAt, finishedAt, status, items[]: speaker, lang, **original**, derived[]), `candidates[]` (key, value, rawText, span, context, lang, confidence, flags, needsCorrection, suggestion, extractor{name,version,method}, state PROPOSED/CONFIRMED/CORRECTED/REJECTED/CONFLICT, convId, itemId, speaker, proposedAt, decidedAt, original, correctedValue), `ledger[]` (key, value, context, status FACT_STATUS, source{convId,itemId,candidateId}, rawText, span, confirmedAt, userConfirmed, corrected, original, resolvedConflict), `conflicts[]` (type, key, entries, question{en,zh:null,zhNote}, state, resolution), `documentLedger[]` (claim, status, source), `userQuestions[]` (origin USER, text as written, lang, translation null, state). Quote extension: `tiers`, `port`, `payment{depositPct,balancePct,balanceDue}`.

## 5. New events

`CONVERSATION_START`, `CONVERSATION_ITEM` (stores the original and proposes candidates through the extractor, deterministically), `CONVERSATION_FINISH`, `CANDIDATE_CONFIRM`, `CANDIDATE_CORRECT`, `CANDIDATE_REJECT`, `CONFLICT_RESOLVE` (choice NEW/OLD), `QUESTION_ADD`, `QUESTION_STATE`, `DOC_CLAIM`. Existing events changed: `QUOTE` now carries `port`/`payment`/`tiers` forward from the previous quote (V0 behaviour otherwise identical). Confirmation emits the existing `QUOTE`/`IDENTIFIER` events, each logged with a summary pointing at the candidate.

## 6. Extraction coverage (FactExtractor, `core/extract/*`, rules version `rules-1`)

English: unit price + currency (code, symbol flagged), quantity-price pairs -> tiers, MOQ with context (product, custom logo, custom packaging, sample, per colour), Incoterm (only the ten the engine supports; FAS stays unparsed) + port/place (known ports high confidence, others flagged), deposit/balance (stated, "30/70", or derived and flagged), balance due, lead time (days/weeks, ranges, "3 weeks lead time"), colours, colour count, mixed-colour yes/no, minimum per colour, carton quantity/dimensions/gross/net weight, model identifier (as written), brand, manufacturer, document statements (claimed / promised / not available). Chinese (narrow, deterministic): prices with 元/块/美元/美金/刀, 万 quantities, MOQ (起订量/起订), tiers, ports after an Incoterm, 定金/尾款 and when the balance is due, lead time (交期), 型号, colours, mixed colours, carton data, document statements. **It does not understand Chinese**: anything unmatched stays in `unparsed`; Chinese numerals written as characters (一百) are not read. Tests: 20 extraction tests plus domain/e2e coverage.

## 7. UI changes

`ui/app.js` 503 -> controller (354 lines) + `dom.js`, `state.js`, `draft.js`, `numbers.js` + one module per screen under `ui/screens/`. New **Field** tab (first tab; Quick stays the default entry): stepper (Discover, Talk, Capture, Complete, Analyze, Decide, Negotiate) in a 4-column grid, "next best step" banner, per-step screens, a "NOT AVAILABLE YET (5)" list. Capture: start/finish a conversation, original words shown unchanged, "TO REVIEW" with Confirm / Correct / Reject, "NEEDS CLARIFICATION" for conflicts, finish summary (what we learned / still missing / contradictions with counts). Talk: existing questions + "Ask my own question" (stored as written; honest "no Chinese translation" note). Docs tab: new card "What the supplier says about documents" marked NOT RECEIVED. Money tab: shows the supplier tiers. Service-worker cache v0-6.

## 8. Offline behaviour

Capture, extraction, review, conflicts, finish summary and free questions all work with the server stopped and the browser offline (proved in the real browser, including a cold reload): the conversation and candidates live in the case JSON that is saved locally at every commit, marked dirty, and synced after reconnect (the server copy is byte-identical, Chinese included, no token inside). Nothing in the new flow calls the network or any provider.

## 9. Backward compatibility

V0 cases (no V1 fields) assess identically before/after upgrade and still accept V0 events (tests). V0 quotes behave exactly as before. A phone still holding the old shell keeps working with V1 cases (unknown fields are preserved by the reducer); reloading picks up shell v0-6.

## 10. Test results

| Suite | Result |
|---|---|
| Sourcing + privacy (`node --test test/sourcing-*.test.js test/finance-privacy.test.js`) | **178 / 178** (116 before; +62 new) |
| `npm run sourcing:e2e` | **18 / 18** (layout check now also covers the Field tab) |
| `npm run sourcing:e2e:v1` (new) | **13 / 13** |
| Full suite `npm test` | **1691 / 1691** (1629 before) |
| PG17 `node --test test/pg/*.pg.test.js` | **169 / 169** |

One pre-existing process issue found and fixed: the repository privacy test (rightly) refuses a 64-character hex string in any committed file; the model-approval document of the previous session contained a release hash. It now carries only the first 16 characters.

## 11. Known limitations

- Extraction is conservative and narrow; unusual phrasing yields no candidate (the text stays in the original and in "unparsed"). Precision/recall on real supplier chats is unmeasured.
- Corrections only work for single values (price, MOQ, currency, Incoterm, port, model, brand, manufacturer, percentages...). Tiers, colours, sizes and weights can only be confirmed or rejected.
- A confirmed fact cannot be un-confirmed from the Field screen (change it in the specialist tabs; the ledger keeps the history).
- No audio, no photo/PDF offer import, no translation (fixed phrasebook only), no transcription.
- Conflict clarification questions are English only ("No Chinese version available yet").
- Field shell: the Field tab is the first tab, but Quick is still the default entry; no per-step memory across sessions.
- Tested in Edge (real engine); not yet tested on the physical phone or in Firefox.
- Chinese contexts for MOQ are decided at comma level.
- `quote.leadTime` keeps only the upper bound of a range in the V0 field.
- Everything money-related beyond V0 (cash, VAT treatment, budget, scenarios) is not built.

## 12. Blockers / decisions recorded (none blocking)

No stop condition was hit. Open owner decisions from the plan remain: import-VAT treatment, business profile (margins, limits, budget), approval of PP-OCR / whisper downloads, SenseVoice (rejected), Opus-MT (on hold), DG TAXUD written question for TARIC.

## 13. Next recommended phase

First the **physical-phone rehearsal of the Field shell (FIELD-UX CHECKPOINT 1)** (plan below). Then, in this order of value: P5 adaptive Ask (questions resolve/appear as facts arrive; the Talk step is still the static V0 list), P6 offer import (pasted text and PDF text feed the same extractor and review flow, plus a tiers view), then P7 cash/VAT with the four VAT treatments and no assumed default.

## 14. Physical-phone rehearsal plan (Firefox, the owner's phone)

1. On the PC: Ctrl+C the old `npm run sourcing:phone`, start it again; open the NEW link on the phone; reload the page twice (shell v0-6).
2. Tap **Field**. Read the "next best step". Expect seven steps and a "NOT AVAILABLE YET (5)" list; open **Decide** and confirm it says the business decision is not available.
3. Tap **Capture** -> Start a conversation. Paste: `For 300 pcs we can do USD 6.80, FOB Shenzhen, 30% deposit and balance before shipment. MOQ is 100 pcs for the standard model. With your logo the MOQ is 300 pcs. We have CE and UN38.3. Model: PB-X200`. Tap "Add and find the facts". Check the original words are shown unchanged and that the case (Quick/Money) is still empty.
4. Confirm a few facts; correct one (type `6.80` for an ambiguous `6,8` price: first try `6,8` and see it refused); reject one. Open Money: the price follows the quantity. Open Docs: UN 38.3 must say "NOT RECEIVED".
5. Paste Chinese: `型号：PB-X180，起订量300个，单价6.8美金`; confirm the model; expect "NEEDS CLARIFICATION" (the case says PB-X200). Choose to keep the earlier model.
6. Type half a message and, without adding it, switch to Talk and back; switch airplane mode on then off: the text must still be there.
7. Airplane mode ON: reload the app; the conversation must still be there; add another message (`Lead time 15-20 days`), confirm a fact. Airplane mode OFF: wait; the header must go back to SERVER VERIFIED and the change must sync.
8. Tap "Finish the conversation": read the summary. Add a free question in Talk; confirm the "no Chinese translation" note.
9. Tell us: where you hesitated, which words were unclear, what you expected next, what was too slow or too small to tap.

## 15. Files

Created: `src/sourcing/core/{extract/{claims,en,index,numbers,shared,zh}.js, candidate-view,conflicts,conversation,field-progress,offers,provenance,upgrade}.js`, `src/sourcing/ui/{dom,draft,numbers,state}.js`, `src/sourcing/ui/screens/{ask,case,decision,docs,field,market,money,quick,rules}.js`, tests `test/sourcing-v1-{extract,domain,field-progress,candidate-view,ui-modules}.test.js`, `test/e2e/sourcing-v1-field.e2e.js`, this report.
Modified: `src/sourcing/core/case.js` (schema 2, reducer split, new events, QUOTE carry-forward, tier-aware landed input), `src/sourcing/server/app.js` (serves core/extract and UI modules, lists them in the shell manifest), `src/sourcing/ui/{app.js,app.css,sw.js}`, `test/e2e/sourcing-pwa.e2e.js` (layout list +1), `package.json` (one script), docs (spikes, model approvals, implementation plan).
Deleted: none.

## 16. V2 / later backlog discovered tonight (not built)

| Idea | Reason | Dependency | Expected value |
|---|---|---|---|
| Chinese numeral characters (一百, 三千) in the extractor | real chats use them | a native-speaker reviewed corpus | medium |
| Bulk "confirm all safe facts" with an undo journal | speed at the booth | owner UX decision after the checkpoint | medium |
| Un-confirm / supersede a confirmed fact from the Field screen | recover from a wrong tap | ledger already keeps history | medium |
| Reviewed fixed Chinese for conflict clarification questions | the supplier should receive Chinese | native review | high |
| Extractor precision/recall report on a larger synthetic + real chat corpus | measure before trusting | corpus | high |
| Field tab as default entry with a remembered step | fewer taps | checkpoint result | medium |
| Voice notes (original recording on the phone) | probe proved feasibility | P4 audio design, bitrate cap | high |
| WeChat text paste helper (strip timestamps/names) | common input | sample exports | medium |
| Per-case "what changed since last visit" | multi-day trips | none | low |
