# China Sourcing V1 - Field Mode, Adaptive Ask (P5) and grouped confirmation

Date: 2026-10-06. Owner decisions applied: Field Mode = the terrain experience (PRODUCT > CONVERSATION > ANALYSIS > DECISION); Expert/Details keeps every existing screen and capability; Expert stays the default until FIELD UX CHECKPOINT 2; analysis is continuous; Adaptive Ask is the foundation of the future interpreter. Nothing pushed, merged or deployed; no model downloaded; no package installed.

## 1. Architecture actually created

| Layer | Module | Role |
|---|---|---|
| Domain (pure) | `core/conversation-engine.js` | P5: known / missing / contradictory / best next question / progress message / timeline, from the case + its assessment |
| Domain (pure) | `core/understanding.js` | which proposed facts may be confirmed together ("Nordla a compris"), which go to individual attention, which are document statements |
| Domain (pure) | `core/phrases.js` | French reading texts, suggested commercial questions, contradiction sentences, REVIEW states, market profiles, `NATIVE_REVIEW` (empty) |
| Domain (pure) | `core/candidate-view.js` | locale-aware (fr/en) descriptions and validated corrections |
| Reducers | `core/conversation.js` + `core/case.js` | new events `QUESTION_SHOWN`, `QUESTION_SKIP`, `CANDIDATES_CONFIRM_BATCH`, `CONVERSATION_DERIVE`; new collections `questionLog`, `confirmBatches` (additive, lazy upgrade) |
| UI | `ui/screens/fieldhome.js` | Field Mode: Conversation view and Summary view |
| UI | `ui/app.js` (controller) | mode switch (Mode terrain / Mode expert, persisted per device), Field handlers |
| Unchanged | all Expert screens, engines, rulebook, Safety Gate, sync, auth | the old Field tab is renamed **Guided** |

Expert is the default (`nordla.sourcing.mode`). The seven internal states (Discover ... Negotiate) remain as the pure `fieldProgress` summary used by the Guided tab; Field Mode shows four phases implicitly (product card, conversation, summary/analysis, decision) and no stepper.

## 2. Adaptive Ask behaviour

`planConversation(case, assessment, { userLang, profile, providers })` recomputes everything from the case at every render (nothing to launch):

- **Questions in play**: the V0 questions (generated from what is missing), the document questions **bundled into one** ("send these documents for model X"), suggested commercial questions (price tiers, payment terms, colours, mixing colours, logo, packaging; each only when useful), clarification questions for contradictions, the owner's own free questions, and the owner's answer cards.
- **State of each question**: OPEN, ASKED (shown to the supplier), UNANSWERED (the supplier spoke after it was shown and nothing answers it: a lower-ranked repeat), ANSWER_PENDING (a proposed fact would answer it, awaiting the owner), WAITING (documents the supplier claims or promises), SKIPPED (put aside until the next supplier message).
- **Best next question**: sorted by priority (P1 first), then dimension (contradiction, identity, commercial, role, regulatory, documents, cost, decision), supplier before owner at equal rank, repeats last. Questions already asked, waiting, pending or skipped are never "next". The owner's free questions are never pushed as next.
- **Progress message** (French), derived: "Il me manque encore N informations importantes" -> "Il me manque N informations avant de pouvoir évaluer cet achat" -> "Analyse suffisamment complète pour une première évaluation. Il reste un risque réglementaire et le transport à déterminer." (residual items computed from the engines: regulatory, documents, transport still an estimate, customs classification, contradictions). Supplier gaps and owner inputs are counted separately ("2 informations du fournisseur et 3 choses à saisir de votre côté").
- **Memory**: `questionLog` records every question shown (with the exact French/Chinese texts and the review state) or put aside, append-only.

### How one answer settles several questions
Each supplier message is stored as an original item and run through the deterministic extractor, which proposes candidates. Every V0/suggested question declares the fact keys that answer it (`resolves`). When a proposed candidate matches, the question becomes ANSWER_PENDING at once (not asked again, not counted as ignored). When the owner confirms the fact (alone, in the group, or corrected), the existing generators stop producing the question (the quote/identity now hold the fact) and it moves to `resolved` with the keys that settled it. A single message with model, MOQ, tiers, Incoterm, deposit and lead time therefore settles six questions together, out of order. Answers also reveal new needs (freight, duty, rate become owner cards; documents the supplier will send become WAITING), and a contradicting answer becomes the first thing to clarify.

### Supplier questions vs owner questions
- **SUPPLIER**: French reading text for the owner, the supplier-language text (Chinese) with its review state, and the English text.
- **USER (small cards)**: answered by the owner in the thread; compiled into the existing events; no supplier text. Contextual and one at a time: the brand/role card and trait confirmations only after the supplier basics are confirmed (at most two trait cards); freight, duty and exchange rate only after the supplier price and Incoterm are known; **selling price only when the landed cost is computable and the verdict is blocked by it; margin only after that.** Numbers are validated (digits and a dot, above zero, percentage <= 100). The VAT treatment is never touched by a card.

### Chinese: states, never certified
Review states: NATIVE_REVIEWED (none today: `NATIVE_REVIEW` is empty), TECHNICAL_ONLY (the V0 phrasebook), UNREVIEWED (all new V1 sentences), MACHINE (a provider produced it), UNAVAILABLE (no Chinese exists; none is invented). The state is shown next to the Chinese text on the owner's screen and kept in `questionLog`. `docs/CHINA-SOURCING-PHRASEBOOK-REVIEW.md` (generated by `tools/phrasebook-review.mjs`) lists every sentence for a native reviewer. A phrasebook that is critical **must be validated by a native speaker before real commercial use.**

### Foundation of the interpreter (nothing simulated)
Owner (FR/EN) -> Nordla -> supplier (zh): questions carry both texts; `QUESTION_SHOWN` records what was shown. Supplier (zh) -> Nordla -> owner: the **original is stored** (item `original`, with language), `CONVERSATION_DERIVE` attaches a TRANSCRIPTION / TRANSLATION / OCR as **derived data with provider and review state** (never replacing the original, never proposing facts by itself), the extractor proposes candidate facts from the original, the owner confirms (provenance), and the engine computes the next best question. `opts.providers.translation` is the seam for a future translation provider; without one the supplier text is UNAVAILABLE. The origin market is a **profile** (`MARKET_PROFILES.CN`: supplier language, phrasebook): another origin needs another profile, phrasebook, extractor patterns and sources, not a rewrite. No speech or translation provider exists and none is simulated.

## 3. Grouped confirmation ("Nordla a compris")

A fact joins the group only if it is HIGH confidence, unambiguous, not calculated by Nordla (derived balance, 万 conversion, European number format), not in conflict with the case or with another proposal, not duplicated, and not a document statement. Everything else is shown individually with its reason (ambiguous, duplicate, conflict, calculated, low confidence). Prices, tiers, MOQ and Incoterm are groupable when clean. The group is displayed in plain lines ("MOQ 50", "50 = 8 · 100 = 7.20 · 300 = 6.80 (USD)", "FOB Shenzhen · 30 % d'acompte · 70 % avant expédition", "4 couleurs : ... · mélange possible · min. 25 par couleur · 15 jours").

Provenance guarantees (all tested):
1. **Never implicit**: only the explicit tap "Oui, c'est ça" confirms; typing or navigating confirms nothing.
2. The reducer **re-checks eligibility** (a stale or forged list cannot confirm an ambiguous, calculated, conflicting or low-confidence fact) and requires the confirmed ids to match the list that was shown.
3. Each fact is still confirmed **one by one**: ledger rows stay SUPPLIER_CLAIM, `userConfirmed`, tagged `via: GROUP` and `batchId`; the batch stores the list shown to the owner.
4. **Document statements have their own tap** ("Noter comme déclarations"): they become claims in the document ledger, never documents, never proof; Docs, Rules, questions and the verdict do not move.
5. A double tap is harmless (already confirmed facts are skipped).
6. A contradiction is shown immediately as `Avant : ... Maintenant : ...` with the two honest choices and "Demander" (which shows the clarification sentence to the supplier).

## 4. Continuous analysis

Every confirmed fact, owner answer or typed value goes through the same events as before; `assess()`, the rules, landed cost, economics and the verdict are recomputed at each render and the progress message follows. There is no "Analyze" action in Field Mode; the Summary view shows the current state (verdict for compliance and economics, maximum price and negotiation target when computable, what is missing, what is not available yet). UNKNOWN, provenance, evidence states and safety rules are unchanged; the business decision (BUY/NEGOTIATE/WAIT/PASS) stays "pas encore disponible".

## 5. Compatibility, offline, privacy

- **V0/V1**: V0 and older schema-2 cases plan and upgrade losslessly; all Expert screens and events unchanged (tests: sourcing suites, three real-browser suites).
- **Offline**: planning, extraction, grouping, owner cards and all new events are local and pure; the new collections live in the case JSON (saved at every commit, synced after reconnect). Proven in the real browser: server stopped + browser offline + cold reload keeps Field Mode and the conversation, grouped confirmation works offline, sync after reconnect delivers identical data.
- **Privacy**: no network call, no provider, no analytics in any new code path; the supplier's text never leaves the phone and the owner's PC unless the owner syncs the case to their own server as before.

## 6. Known limits

- Field Mode texts are French only (the engine also produces English); no English UI yet.
- Free supplier answers outside the extractor's patterns stay unparsed (visible in the original); precision on real chats is unmeasured.
- Corrections only for single values (price, MOQ, currency, Incoterm, port, model, brand, manufacturer, percentages, counts).
- Chinese sentences are not natively reviewed; Chinese for the owner's own free questions does not exist (UNAVAILABLE).
- No audio capture, no photo/offer parsing, no automatic currency or tier suggestions beyond the extractor.
- Field Mode is not the default; the Guided tab and Expert remain the default entry until checkpoint 2.
- Edge only; not yet on the physical phone or Firefox.

## 7. FIELD UX CHECKPOINT 2 - exact plan (physical Android phone, Firefox)

Preparation (PC): start the checkpoint server from the current HEAD (the assistant does it and gives ONE URL); open it on the phone, wait for SERVER VERIFIED, reload once. Menu (hamburger) > **Mode terrain**. Create a new product case.

1. **Product**: type "Power bank", tap "Oui" on the category suggestion. Observe: is "Produit" clear? Is the progress message readable?
2. **Conversation, all at once**: paste `PB-X200. MOQ is 50 pcs. Price is USD 8 for 50 pcs, USD 7.20 for 100 pcs and USD 6.80 for 300 pcs. FOB Shenzhen. 30% deposit, 70% balance before shipment. We have black, white, blue and pink. You can mix colors, minimum 25 pcs per color. Production time is 15 days. We have CE, RoHS and UN38.3.` Expected: "Nordla a compris" with 4 lines; the model alone as "confiance faible"; documents on their own card; the case still empty (check in Détails > Money later).
3. Tap **Oui, c'est ça**. Expected: the group disappears; the progress message drops; the next question appears. Tap **Noter comme déclarations**: no document appears in Docs.
4. Confirm the model (Confirmer).
5. **Next question**: read the French; tap **Montrer en 中文**: full-screen Chinese, French small; the state "relecture par un locuteur natif à faire" shows on your side. Have someone who reads Chinese look at it and tell us if it is understandable.
6. **Out-of-order answer**: type `Manufacturer: Brightway Electronics Ltd. Sample price USD 15. 50 pcs per carton, carton size 52x38x30 cm, G.W. 12.5 kg.` Several questions should disappear at once.
7. **Contradiction**: type `Sorry, MOQ is 100 pcs.` Expected: "Avant : MOQ 50. Maintenant : 100." with [50] [100] [Demander]; tap **Demander** (Chinese sentence), then choose.
8. **Your cards**: answer the cards that appear (transport, droits, taux, then prix de vente, marge). Try `6,5` for the transport: it must be refused. Note: did any card feel premature or like a questionnaire?
9. **Summary** (Résumé): read the message and the verdict; check "Décision d'achat : pas encore disponible".
10. **Offline**: type half a message, switch airplane mode on and off: the text stays. Airplane mode on, reload the app: the conversation is still there; type `Lead time 20 days`, confirm; airplane mode off: header returns to SERVER VERIFIED.
11. **Expert**: Détails: all tabs present; open Docs (UN 38.3 as NOT RECEIVED), Money (tiers); return to Field via the banner.
12. Tell us: where you hesitated, which French words were unclear, what you expected next, what was too slow or too small, whether the grouped tap felt safe, whether Field Mode should become the default.
