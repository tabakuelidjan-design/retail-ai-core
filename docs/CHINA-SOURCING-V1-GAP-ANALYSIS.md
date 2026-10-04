# China Sourcing Intelligence V1 - Architectural Gap Analysis

Status: analysis only. No V1 code was written. Baseline: branch `feature/china-sourcing-field-mode`, HEAD `e19a08f` (see section 0).
Language: this document is for the owner and for engineers; the product itself stays in plain language.

---

## 0. Baseline verified before reading anything

| Item | Value |
|---|---|
| Repository | `C:\Users\etaba\Desktop\retail-ai-core-finance-resume` |
| Branch | `feature/china-sourcing-field-mode` |
| Local HEAD | `e19a08f` (fix: background re-render wiped the Quick form) |
| `origin/feature/china-sourcing-field-mode` | `e838629` (field activation). Local is 0 behind, 3 ahead: `5562b8b`, `d7fcf2e`, `e19a08f` are local only |
| Working tree | clean |
| `b4eb7d1`, `e838629`, `5562b8b`, `d7fcf2e`, `e19a08f` | all reachable from HEAD. Only `b4eb7d1` and `e838629` are on origin |
| Size of V0 | 3,399 lines under `src/sourcing/` (core 2,300 incl. rulebook; ui/app.js 503; server 208; adapters 204), 12 test files, 5 docs |
| This machine (for provider sizing) | Intel i5-8350U (4 cores / 8 threads), 15.9 GB RAM, Intel UHD 620 (no discrete GPU), 220 GB free |

Everything below is based on reading the code, not on the earlier summaries.

---

## 1. V0 as it exists: current data and event flow

### 1.1 The one aggregate: the Product Case

A **Case = one product from one supplier**, a plain JSON document (`schema: 1`) built by `dispatch(state, event)` in `core/case.js` and re-assessed from scratch by the pure function `assess(state, {now, externals})` after every change. Unknown event types throw. State fields: `identity` (evidence per trait, with levels), `placing`, `context`, `supplier` (ONE object), `quotes[]` (append-only; **the engines read `quotes.at(-1)`**), `costs`, `sale`, `saleAmazon`, `documents[]`, `safetySnapshot`, `customs`, `amazon.observations[]`, `notes`, `decisions[]`, `events[]`.

Existing events (all of them): `NAME CATEGORY TRAIT IDENTIFIER ORIGIN PHOTO PLACING CONTEXT SUPPLIER QUOTE COSTS SALE SALE_AMAZON DOCUMENT DOCUMENT_CORRECT DOCUMENT_CONFIRM SAFETY_SNAPSHOT CUSTOMS AMAZON_OBS AMAZON_OBS_REMOVE AMAZON NOTE DECISION_RECORDED`.

### 1.2 Pipeline inside `assess` (pure, deterministic, runs on the phone)

```
identity (identity.js, levels.js)
  -> rules pass 1 (evaluateRules: which regimes apply -> which standards a document should cite)
  -> documents inspected (docinspect.js, ocrGuard) -> cross-checked
  -> rules pass 2 (evidence coverage, review status, materiality)
  -> Safety Gate match (safety.js; externals = phone copy; LIVE/CACHED/OFFLINE)
  -> customs (customs.js: HS candidates, user duty; never "verified")
  -> landed (landed.js: KNOWN/ESTIMATED/UNKNOWN lines, Incoterm model, importVat {recoverable})
  -> economics (economics.js: unitEconomics, maxPurchasePrice)
  -> Amazon (amazon.js: summarizeMarket, readiness, economics)
  -> questions (supplier.js buildQuestions: from what is missing)
  -> decide (decision.js: GO / CONDITIONAL_GO / NO_GO / INSUFFICIENT_INFORMATION + blockers + conditions + why + nextAction)
  -> supplierSheet (EN/ZH fixed phrasebook) + negotiationBrief
```

### 1.3 Who writes and who reads, per tab (current)

| Tab | Writes (events) | Reads from `assess` | Note |
|---|---|---|---|
| Quick | NAME, CATEGORY, QUOTE, COSTS, CUSTOMS, SALE, CONTEXT, NOTE; traits via buttons (TRAIT, PLACING) | decision, maxPurchasePrice, landed | six fields; blank stays UNKNOWN |
| Case | NAME, IDENTIFIER, CATEGORY, TRAIT, PLACING, SUPPLIER, QUOTE, PHOTO, CONTEXT | identity confidence | the only place the supplier is entered |
| Ask | **nothing** | `questions`, `supplierSheet`, `negotiation` | read-only: an answer from the supplier has to be re-typed in Case/Money. Questions never "resolve" visibly except by the underlying fact changing |
| Docs | DOCUMENT, DOCUMENT_CORRECT, DOCUMENT_CONFIRM | per-document inspection, cross-check | the only place where supplier evidence is ingested; text from paste / PDF / OCR / typing |
| Rules | none | `rules` (31 rules, review status, sources) | |
| Market | AMAZON_OBS, SALE (use observed price), AMAZON | `summarizeMarket` | manual observations on four Amazon marketplaces only |
| Money | QUOTE, COSTS, SALE, CUSTOMS, SALE_AMAZON | landed, economics, maxPurchasePrice, `whatIf` | single order, single supplier |
| Verdict | none | `decision` | |

### 1.4 Persistence and sync today
- Phone: case JSON in localStorage; photos / document photos / Safety Gate copy in IndexedDB (`blobs`). **Blobs are phone-only: they are not synced to the server** (only the case JSON is).
- Server: `file-store.js` stores `<id>.json` per case with `rev` (optimistic concurrency, 409 on conflict). One collection only.
- Sync: `commit -> markDirty -> queueSync -> PUT /api/cases/:id`, retry with backoff, conflicts kept (never overwritten), "keep both".
- Header: `core/status.js` (SERVER state vs SAFETY GATE state, fail closed).
- Render: whole-screen `innerHTML` rewrite; typed-but-unsubmitted fields are preserved by the draft guard added in `e19a08f`.

### 1.5 Proposed V1 flow on top of it

```
DISCOVER   photo / label / short description / supplier quote          -> existing PHOTO, NAME, CATEGORY, TRAIT, IDENTIFIER (+ candidates, provenance)
TALK       Supplier Assistant: generated + suggested + free questions   -> existing buildQuestions/phrasebook + new question state + free-question composer
CAPTURE    voice note / typed / pasted / WeChat text / PDF / photo      -> NEW unified source pipeline (original -> text -> translation -> candidates)
COMPLETE   review candidates; resolve conflicts; see what is missing    -> candidates confirmed => EXISTING events (QUOTE, IDENTIFIER, TRAIT, SUPPLIER, DOCUMENT...)
ANALYZE    orchestrate engines; providers may be UNKNOWN                -> EXISTING assess() + new modules (cash, market, supplier intel, customs adapter)
DECIDE     BUY / NEGOTIATE / WAIT / PASS for THIS business              -> NEW business-decision layer ABOVE the existing compliance/economics verdict
NEGOTIATE  target / acceptable / too expensive; next best action        -> EXTENDS negotiationBrief + maxPurchasePrice; Ask composer for the next question
```

**Reuse principle (the key design decision):** a confirmed candidate is converted into the **same existing events** the forms dispatch today. The deterministic engines (`assess`, rules, landed, economics, decision) therefore keep working unchanged and their 116 + 18 + 1629 + 169 tests stay valid. V1 adds a layer **in front of** the engines (capture, provenance, candidates) and **beside/after** them (cash, plan, business decision), not inside them.

---

## 2. Existing V0 capabilities reusable UNCHANGED

| Capability | Where | Why it stays as is |
|---|---|---|
| Deterministic case reducer and pure `assess` | `core/case.js` | the backbone; confirmed facts keep entering through it |
| Identity evidence model and levels (PROBABLE ... VERIFIED_OFFICIAL) | `core/identity.js`, `levels.js` | already separates claim / user / document / official |
| Three-valued rule predicates, rulebook as data with review/materiality/scope/layer, 31 rules, sources, freshness | `core/rules-engine.js`, `core/rulebook/*` | regulatory closure was verified; V1 must not touch it |
| Document extraction / inspection / cross-check, OCR guard (OCR never evidence by itself) | `core/docinspect.js`, `case.js` | the model-mismatch detection (PB-X200 vs PB-X180) already exists for documents |
| Safety Gate adapter, matching, LIVE/CACHED/OFFLINE | `adapters/safety-gate.js`, `core/safety.js`, `core/status.js` | physical-phone verified |
| Integer-minor-unit money, landed cost with KNOWN/ESTIMATED/UNKNOWN, Incoterm model, max purchase price, what-if | `core/money.js`, `landed.js`, `economics.js` | UNKNOWN discipline is the product; extended by new modules, not rewritten |
| Customs candidate discipline and the customs lookup contract | `core/customs.js`, `adapters/customs-contract.js` | V1 only adds a real adapter behind the existing contract |
| Verdict engine with blockers, conditions, why, nextAction | `core/decision.js` | stays as the **compliance + economics** verdict (see 4) |
| EN/ZH fixed phrasebook with verbatim model numbers/standards | `core/supplier.js` | the trusted translation layer; extended with composable templates |
| Capability matrix, status header | `core/capabilities.js`, `core/status.js` | extended with new rows only |
| PWA shell, service worker, IndexedDB storage, token/fragment bootstrap, rate limit, host allow-list, CSP | `ui/sw.js`, `ui/storage.js`, `server/*`, `phone.js` | physical-phone verified; no semantic change |
| AI provider policy (disabled by default, consent, China-region block, payload minimisation) | `adapters/ai-provider.js` | becomes the policy core of all new providers |
| Test fixtures and the real-browser CDP e2e harness | `test/e2e/cdp.js`, fixtures | reused for V1 scenarios |

---

## 3. Components that need EXTENSION

| Component | Extension | Why |
|---|---|---|
| `core/case.js` | schema 2 fields (conversations, sources, candidates, fact ledger, offers, question states, document ledger, supplier-intel, market signals, scenarios); new events; `upgradeCase()` | everything V1 captures needs a home |
| `core/levels.js` | new `FACT_STATUS` (SUPPLIER_CLAIM, DOCUMENT_RECEIVED, DOCUMENT_MATCHED, VERIFIED, ESTIMATED, USER_PROVIDED, UNKNOWN, CONFLICT) mapped onto existing `FACT_CLASS` and `IDENTITY_LEVEL` (never replacing them) | the requested provenance vocabulary |
| `core/landed.js` / `case.js landedInputOf` | resolve unit price from **price tiers by quantity**; expose goods / freight / duty / VAT / total cash components | tiers and cash |
| `importVat` in `landed.js` | already has `{minor, recoverable, includedInLanded}`; add cash-advance semantics in a new module, not here | VAT cost vs cash |
| `core/supplier.js` | question **state** (open / asked / answered / resolved / superseded), free questions, suggested commercial questions (colours, mixed MOQ, logo, tiers, samples), dynamic doc-mismatch questions (the `doc_fix` template exists), composable bilingual templates | adaptive Ask |
| `core/decision.js` | keep as is; add an upstream/downstream layer (see 4); add cash and budget as new dimensions in the NEW layer | no engine rewrite |
| `core/amazon.js` | generalise observations to market **signals** with kind (OBSERVED_LISTING / ESTIMATE / DEMAND_SIGNAL / CONFIRMED_SALES), Europe-first marketplaces (+ bol.com, user-entered), ranges with confidence and method | Market V1 |
| `core/customs.js` | carry verification status, measures, source, review time from an adapter result | official source |
| `server/file-store.js` + `server/app.js` | second collection (sessions) and a blob store (audio, photos, offer files) | purchase plan, backup of evidence |
| `ui/sync` logic in `ui/app.js` | dirty tracking and conflicts for sessions and blobs | same guarantees as cases |
| `adapters/ai-provider.js` | generalise to the provider registry (section 8); keep the policy functions | zero-cost providers |
| `ui/app.js` | new Field workflow screens; old tabs kept as "Specialist" | section 7 |
| `core/capabilities.js` | rows for voice capture, transcription, translation, offer import, purchase plan, market signals | honest offline matrix |

## 4. Components that should be REFACTORED (only where V1 cannot be built safely otherwise)

1. **`ui/app.js` is one 503-line, very dense file** with all screens, sync, storage, rendering. V1 adds roughly five new screens plus a recording flow. Refactor first into modules (`ui/screens/*.js`, `ui/sync.js`, `ui/draft.js`, `ui/state.js`) with **no behaviour change**, protected by the existing 18-check e2e. Without this, every V1 phase edits one giant file and the blast radius is the whole phone app.
2. **Full-screen `innerHTML` render.** A voice recording in progress, or a typed question, must never be destroyed by a background re-render. The draft guard covers form fields only. Capture screens need their own stable DOM (update-in-place), and recording state must live outside the render cycle.
3. **"One case = one supplier = `quotes.at(-1)`".** Multi-supplier comparison and tiers need an **offers** collection. Refactor by *keeping* `quotes.at(-1)` as the "applied terms" the engines read and adding `offers[]` as a layer that can apply an offer to the quote. This is a layering change, not an engine change.
4. **Questions are recomputed from scratch and stateless.** Adaptive Ask needs per-question state kept in the case (what was asked, what was answered, by whom, when). `buildQuestions` stays as the generator; a thin state layer wraps it.
5. **Blobs are phone-only.** Evidence (audio, supplier photos, offer files) that never leaves the phone is one lost phone from gone. Add blob sync (optional, owner-controlled) - see 10 for the privacy trade-off.
6. **`file-store` only knows cases.** Generalise to named collections (`cases`, `sessions`, `blobs`) with the same `rev` semantics.

Per the project rules, existing architectural weaknesses found are reported here and not fixed outside an approved phase.

## 5. Missing data models

All JSON, integer minor units for money, ISO dates, every record carries `id`, `at`, `source`.

- **Source** (immutable original): `{id, kind: VOICE|TEXT|PASTE|WECHAT_TEXT|SCREENSHOT|EMAIL|PDF|PHOTO|SPREADSHEET|DOCUMENT, lang: en|zh|unknown, blobRef|text, capturedAt, capturedBy, deviceOffline}`. The original Chinese is stored as-is.
- **Derivation** (never overwrites the source): `{sourceId, step: TRANSCRIPTION|OCR|TRANSLATION, provider, providerVersion, text, protectedTokens[], confidence, status: MACHINE_READING, confirmedBy?}`.
- **Candidate fact**: `{id, key (e.g. quote.moq, quote.unitPrice, identifier.model), value, unit, context (product|custom_logo|per_colour|sample|tier:100), sourceId, span, extractor: RULE|AI|MANUAL, extractorVersion, status, proposedAt}`.
- **Fact ledger entry** (confirmed): `{key, value, context, status: FACT_STATUS, provenance: {sourceId, who, when, how, translation?}, userConfirmed: bool, corroboratedBy: [evidenceRefs], supersedes?}`. The ledger holds *all* statements about a key (so MOQ 100 and MOQ 300 can coexist as contexts or as a CONFLICT); the case's single applied value is derived from it.
- **Conflict**: `{id, key, entries[], resolution: CONTEXTUAL|PICKED|OPEN, clarificationQuestionId}`; includes document-vs-case model mismatch as a HIGH conflict.
- **Conversation**: `{id, supplierRef, startedAt, finishedAt, sourceIds[], summary: {learned[], missing[], contradictions[]}, confirmedAt}`.
- **Question**: `{id, origin: NORDLA|SUGGESTED|USER, textEn, textZh, zhOrigin: PHRASEBOOK|MACHINE|USER, priority, state, askedAt, answeredBy: [candidateIds], resolves: [keys]}`.
- **Document ledger**: `{docType, forModel, status: CLAIMED|PROMISED|RECEIVED|MATCHED|MISMATCHED, sourceId}` - so "supplier says UN38.3 exists" is a SUPPLIER_CLAIM and Docs still says *not received*.
- **Offer**: `{id, supplierRef, product/model, currency, tiers: [{minQty, unitPriceMinor}], moq, incoterm, port, leadTimeDays, payment: {depositPct, balanceTrigger}, carton, validUntil, sourceId, status: IMPORTED|CONFIRMED|APPLIED}`.
- **Supplier (registry entry)**: `{id, legalName, address, website, uscc?, factoryClaim: CLAIMED|CORROBORATED|VERIFIED|UNKNOWN, signals[] }` - separate from the case so one supplier serves many cases and offers.
- **Market signal**: `{id, market (BE|NL|FR|DE|EU|US), kind: OBSERVED_LISTING|DEMAND_SIGNAL|ESTIMATE|CONFIRMED_SALES, value | range{min,max}, confidence, method, source, observedAt}`.
- **Scenario**: `{name: PESSIMISTIC|EXPECTED|OPTIMISTIC, overrides: {fx, freight, sellingPrice, fees, demand}}`.
- **Sourcing Session (the trip / purchase plan)** - a NEW aggregate, not a case: `{id, name, budget {availableMinor, reserveMinor}, caseRefs[], orders[], shipments[], allocations[], payments[], commitments[]}` with `orders[] = {caseId, offerId, qty, unitPriceMinor, payment terms, status: CONSIDERING|COMMITTED|PAID}`.
- **Business context** (per session): `{channels, markets, targetMarginPct, riskLimits, currentInventory?, storage?}`.
- **Provider status**: `{provider, capability, status: AVAILABLE|UNAVAILABLE|DISABLED, reason}`; any provider output is `{status: OK|UNKNOWN|UNAVAILABLE, data?, provenance}`.

## 6. Missing event types

Case-level (new): `SOURCE_ADD`, `DERIVATION_ADD`, `CANDIDATES_PROPOSED`, `CANDIDATE_CONFIRM`, `CANDIDATE_CORRECT`, `CANDIDATE_REJECT`, `CONFLICT_RAISED`, `CONFLICT_RESOLVE`, `CONVERSATION_START`, `CONVERSATION_FINISH`, `CONVERSATION_CONFIRM`, `QUESTION_ADD` (free/suggested), `QUESTION_STATE`, `DOC_CLAIMED`, `DOC_PROMISED`, `OFFER_IMPORT`, `OFFER_CONFIRM`, `OFFER_APPLY`, `SUPPLIER_LINK`, `SUPPLIER_SIGNAL_ADD`, `MARKET_SIGNAL_ADD`, `MARKET_SIGNAL_REMOVE`, `SCENARIO_SET`.
Session-level (new reducer, same discipline: unknown events throw): `SESSION_CREATE`, `BUDGET_SET`, `ORDER_CONSIDER`, `ORDER_COMMIT`, `PAYMENT_RECORD`, `SHIPMENT_CREATE`, `ALLOCATION_SET`, `COST_ADD`.
**Rule:** `CANDIDATE_CONFIRM` is the only door through which a material conversational fact reaches the case, and it dispatches the **existing** events (QUOTE, IDENTIFIER, TRAIT, SUPPLIER, DOCUMENT, COSTS...). Existing events are not changed.

## 7. Missing UI surfaces

Design target: a non-developer standing in front of a supplier, one hand, bad signal. Eight tabs stay but move under "Specialist".

1. **Session home**: the China trip: list of products with a one-line status each, budget bar, "Add product".
2. **Product workflow** (stepper Discover - Talk - Capture - Complete - Analyze - Decide - Negotiate), always showing the single next action.
3. **Talk**: Supplier Assistant: "9 things missing, 3 block an order"; one question at a time, English and Chinese big text; a free-question box (typed now, spoken later); suggested commercial questions.
4. **Capture**: hold-to-record voice note (original stored), paste/typed answer, photo, PDF/screenshot import; each capture lands in a **Review** list of candidate facts ("I found these - confirm / fix / ignore").
5. **Finish conversation**: learned / still missing / contradictions, then **Confirm and update case**.
6. **Offer import** and **Offer comparison** (cards, not a score; "what you pay in total" and "what risk you carry").
7. **Cash and plan**: this order's cash and timeline; whole-trip total economic cost, total cash, peak cash, remaining capacity; **Can I buy this?** simulator.
8. **Decide / Negotiate**: BUY / NEGOTIATE / WAIT / PASS with why, verified/estimated/unknown, what could change it, next action; price bands; "make the question" button feeding Talk.
9. **Providers** status inside the existing "what works now" panel.
All layouts must hold at 375/390/430 and landscape (existing e2e check 16 extends).

## 8. Provider / adaptor architecture

One registry, one result shape, one policy gate.

```
providers/registry.js     register(capability, impl); capabilities() -> status of each; every call returns
                          { status: 'OK'|'UNKNOWN'|'UNAVAILABLE', data?, provenance:{provider,version,at,method}, reason? }
policy                    reuse ai-provider.js: data class, consent per call, region 'CN' block, payload minimisation;
                          add region 'LOCAL' (never leaves the owner's machine) as the default allowed class for supplier content
```

| Interface | V1 zero-cost implementation (mandatory path) | Optional / later |
|---|---|---|
| `SpeechProvider` | audio saved as the original; typed fallback always; OS keyboard dictation (the phone's own mic key, no app code); batch transcription on the owner's PC when connected (local whisper-class model, **to be benchmarked**) | cloud STT: explicit consent, V2 |
| `TranslationProvider` | fixed phrasebook + composable templates (exact, reviewed); free user questions: local offline MT on the PC (Marian/Argos-class, **to be benchmarked**), always labelled MACHINE TRANSLATION with protected tokens; manual fallback: show EN and copy for the phone's own translator | cloud MT: consent, V2 |
| `VisionProvider` | manual identification (default); typed text; Tesseract-class OCR on the PC for printed text (**to be benchmarked, Chinese quality unknown**); existing Anthropic provider stays optional and consent-gated | local VLM needs a GPU: V2 |
| `FactExtractor` (new) | **deterministic rules** (regex/grammar, EN + ZH patterns) - runs on the phone offline | AI-assisted extraction as a *second pass* proposing extra candidates, never auto-applied |
| `MarketProvider` | manual observations + free public signals where terms allow (**verify per source before building**) | paid sales-estimation: V2 |
| `TradeDataProvider` | Eurostat/Comext public statistics (**verify access**) | Panjiva/ImportGenius: V2 |
| `CustomsProvider` | user-entered duty (today) -> official TARIC / Access2Markets adapter if a free machine-readable access exists (**to verify**), behind the existing `customs-contract.js` | broker integration: V2 |
| `SupplierIntelProvider` | supplier-provided identity, USCC format/check-digit validation (deterministic), website/domain facts typed by the user, manual registry lookups with guided fields | paid KYB: V2 |
| `FxProvider` | ECB (exists) | |

Hardware reality (this PC: 4-core i5-8350U, 15.9 GB RAM, no discrete GPU): small speech and MT models are plausible on CPU as **asynchronous batch jobs**; real-time conversation transcription and any local vision-language model are **not** a safe assumption. Nothing is downloaded until a spike measures speed, accuracy (especially Chinese) and disk. The product must work with every provider UNAVAILABLE.

## 9. Offline implications

- Capture works offline: text and audio are stored on the phone (IndexedDB) and queued; transcription/translation/AI run later when the PC is reachable; the original is never replaced.
- Deterministic extraction runs on the phone, so "I found these terms" works with no signal.
- Every new screen must declare its row in the capability matrix (AVAILABLE_OFFLINE / REQUIRES_SERVER / REQUIRES_EXTERNAL_PROVIDER).
- Storage: audio is large. Quotas, a per-note size cap, compression choice, and a rule that nothing is evicted until the server confirmed receipt of the blob.
- Sessions sync like cases (rev, 409, keep both). Orders and payments recorded offline must not be lost or double-counted on reconnect: payments are append-only events keyed by id (idempotent).
- Clock: payment timeline and quotation validity use the device clock; show the date used.
- Safety Gate / header semantics unchanged. The new capture UI must not rely on full re-render (see 4.2).

## 10. Privacy and security implications

- Supplier names, conversation audio/text, prices and offers are **CONFIDENTIAL**. New rule: supplier content never goes to a non-LOCAL provider without per-call, per-item consent, and the policy gate refuses it by default. `minimizePayload` today strips only e-mails and phone numbers; conversation text also holds supplier names and prices, so it needs a stricter class.
- **Tunnel exposure:** with Cloudflare quick tunnel, TLS terminates at Cloudflare; uploaded audio and documents transit their edge. Decision for the owner before audio sync is built: upload only on the same Wi-Fi (no tunnel), or upload text only, or accept the transit. Default proposed: audio stays on the phone until the owner chooses to send it over a non-tunnel path.
- No supplier content in logs (the existing privacy test is extended to scan new routes).
- New routes (`/api/sessions`, `/api/blobs`, `/api/extract`, `/api/transcribe`, `/api/translate`) inherit token + rate limit + host allow-list + CSP; body-size limits and content-type validation for blobs.
- Provenance never leaves the case in a way that makes a supplier claim look verified (UI wording tests).
- Free-source access must respect each source's terms; no scraping of competitor or marketplace databases. Anything unclear is manual entry.

## 11. Test implications

Principles unchanged: test first for deterministic logic; no weakened or skipped tests; synthetic data only.

- New pure-logic suites: provenance/ledger/conflict, EN+ZH extractor (large synthetic corpora: numbers, units, 万, 美金/USD/RMB/元, 起订量, FOB/EXW, 定金/尾款 30/70, tiers, colours), question state machine, offers and tiers, cash/VAT/timeline, allocation (integer, sums exactly), purchase plan and budget, can-I-buy (monotone quantity search), scenarios, business decision mapping, provider registry (UNAVAILABLE degradation), USCC checksum.
- Property-style checks: allocation always sums to the shared cost; cash >= economic cost when VAT is advanced; recomputing after any event is deterministic; confirming a candidate twice is idempotent.
- Browser e2e additions (real engine, offline cold start included): capture a conversation offline, review candidates, finish and confirm, reconnect and sync; refused server save keeps data; recording survives a re-render; multi-supplier session; layout at 375/390/430.
- Regression: all existing suites stay green unchanged (116 / 18 / 1629 / 169 today).
- Physical-phone checks (cannot be automated): microphone recording, camera/PDF import, touch ergonomics, Firefox and Chrome Android, airplane-mode capture then reconnect.
- Schema 1 fixtures (every existing test case) become the migration corpus.

## 12. Migration and backward compatibility

- `upgradeCase(state)`: pure, idempotent, lazy (on load, on server read); `schema 1 -> 2` only **adds** empty fields. Old `quotes[]` stays authoritative for the engines; `offers[]` starts empty (or one derived offer per existing quote, marked `DERIVED`).
- A schema-2 case opened by an old client (e.g. a phone still holding the old shell) must not be corrupted: unknown fields are preserved by `dispatch` (it clones), the server stores what it receives, and `schema` mismatch is reported rather than overwritten. Service-worker cache name bump per phase so phones pick up the shell.
- Event log is append-only; no event is ever renamed or removed.
- Sessions are new objects: no existing data to migrate. Cases may belong to no session (V0 usage keeps working).
- Verdict compatibility: the existing four verdicts remain; the BUY/NEGOTIATE/WAIT/PASS decision is an **additional** field (see mapping in the plan). Nothing that reads `decision.verdict` changes.
- Server files on disk: unchanged format for cases; new directories for sessions and blobs; nothing touches production data (there is none in this repo's sourcing store).

## 13. Proposed implementation phases (summary; detail in the plan document)

P0 baseline + provider spikes (no integration) - P1 provenance/ledger/conflicts (pure) - P2 deterministic EN/ZH extraction -> candidates - P3 UI modularisation (no behaviour change) - P4 Capture + Review + Finish conversation - P5 Adaptive Ask - P6 Offers and tiers - P7 Cash, VAT, payment timeline (order level) - P8 Sourcing session, budget, consolidation, Can-I-buy - P9 Business decision + negotiation bands + next best action + Analyze orchestrator - P10 Market Europe-first + scenarios - P11 Multi-supplier comparison - P12 Supplier intelligence - P13 Customs official adapter - P14 Local providers (speech/translation/OCR) behind the interfaces - P15 Field workflow shell (stepper) and Specialist drawer finalisation. The shell skeleton is introduced progressively from P4.

## 14. Risk register

| # | Risk | Severity | Mitigation |
|---|---|---|---|
| R1 | Extracted facts silently becoming truth (supplier claim shown as verified) | Critical | candidates only; one confirm door; UI/wording tests; provenance on every fact |
| R2 | Chinese extraction/translation errors on numbers, units, model numbers | High | protected tokens; rules-first with corpora; show original beside translation; native-speaker review of templates; MACHINE label |
| R3 | `ui/app.js` monolith: every phase edits one file; a mistake breaks the whole phone app | High | P3 modularisation with no behaviour change under the existing e2e |
| R4 | Full re-render destroys capture state (recording, typed question) | High | stable capture DOM, recording state outside render, e2e that fires re-renders during capture |
| R5 | Phone storage quota / lost evidence (audio, photos phone-only) | High | caps, compression, server blob backup (owner-controlled), no eviction before confirmed upload |
| R6 | Privacy: supplier content leaving via a cloud provider or visible at the tunnel edge | High | LOCAL-only default, per-item consent, owner decision on audio over tunnel |
| R7 | Cash/VAT mis-modelled (Belgian import VAT mechanisms, deferral licences) giving false confidence | High | model "VAT to advance" as an explicit assumption flag the owner sets; never assume; mark as needing broker/accountant confirmation |
| R8 | Fake precision in market estimates and negotiation bands | High | ranges + confidence + method only; no sales numbers without a source; bands derived from the money engine, not thresholds |
| R9 | Free data sources unavailable, unstable or restricted by terms | Medium | provider contract returns UNAVAILABLE; manual fallback always; verify terms before each build |
| R10 | Local AI too slow/heavy for this 4-core, no-GPU PC | Medium | spike before commitment; async batch only; features optional |
| R11 | Sync complexity grows (sessions, blobs, orders, payments) -> duplicates, double-counted payments | Medium | event ids, idempotent append-only payments, same rev/409 model, tests |
| R12 | Scope creep: V1 becoming V2 | Medium | explicit V2 list below; each phase has acceptance criteria and a stop |
| R13 | Owner is field-testing: a regression on the phone costs real trips | High | one phase at a time, local only until approved, physical-phone gate where required, rollback per phase |
| R14 | Deterministic extractor false positives (picks the wrong "300") | Medium | context labels, conflict detection, confirmation, corpora from real (synthetic) chats |

## 15. V2 backlog (documented, not built)

Native WeChat integration; premium trade data (Panjiva/ImportGenius-class); paid marketplace and sales-estimation data; Keepa-class price history; global trade graph; autonomous supplier outreach; cross-user/network intelligence; cloud speech and translation as defaults; local vision-language models; supplier KYB paid providers; automatic registry scraping; automated freight-quote APIs; ERP/accounting export; multi-currency treasury; image-based competitor search; live exchange-rate hedging; multi-user roles on sessions.

## 16. Exact files likely to change

New (core, pure): `core/provenance.js`, `core/conflicts.js`, `core/extract/{en.js,zh.js,index.js,patterns.js}`, `core/candidates.js`, `core/conversation.js`, `core/questions-state.js`, `core/offers.js`, `core/cash.js`, `core/payment-terms.js`, `core/allocation.js`, `core/session.js` (reducer), `core/budget.js`, `core/can-i-buy.js`, `core/scenarios.js`, `core/business-decision.js`, `core/negotiation.js`, `core/market.js`, `core/supplier-intel.js`, `core/uscc.js`, `core/analyze.js`, `core/upgrade.js`; `providers/{registry.js,speech.js,translation.js,vision.js,market.js,trade.js,customs.js,supplier-intel.js}`.
Modified: `core/case.js` (events, schema 2, assess wiring), `core/levels.js`, `core/landed.js` (tier-resolved price only), `core/supplier.js` (templates, free questions), `core/customs.js`, `core/amazon.js` (generalise), `core/capabilities.js`, `adapters/ai-provider.js` (registry/policy), `adapters/customs-contract.js` (if needed), `server/app.js`, `server/index.js`, `store/file-store.js`, `ui/app.js` (split), `ui/index.html`, `ui/app.css`, `ui/sw.js`, `ui/storage.js`, docs.
New UI modules: `ui/screens/{session,product,talk,capture,review,finish,offers,compare,cash,plan,decide,negotiate,providers}.js`, `ui/sync.js`, `ui/draft.js`, `ui/recorder.js`.
Not touched: `core/rulebook/*`, `core/rules-engine.js`, `core/docinspect.js`, `core/safety.js`, `adapters/safety-gate.js`, `core/status.js`, `core/money.js`, `core/economics.js` (extended by new modules, not edited), and everything outside `src/sourcing` (Finance, Analyses, Brain, Identity, Security, Tenant).

## 17. Exact tests likely to be added / modified

Added: `test/sourcing-v1-provenance.test.js`, `-conflicts`, `-extract-en`, `-extract-zh`, `-candidates`, `-conversation`, `-questions`, `-offers`, `-cash`, `-payment-terms`, `-allocation`, `-session`, `-budget`, `-can-i-buy`, `-scenarios`, `-business-decision`, `-market`, `-supplier-intel`, `-providers`, `-upgrade` (schema migration), `-privacy-v1` (log/payload scanning), fixtures `sourcing-v1-conversations.js` (EN, ZH, mixed, WeChat-style, quotation text, multi-supplier trip), `test/e2e/sourcing-v1-field.e2e.js` (offline capture, review, finish, reconnect, session, layout).
Modified (additive only): `test/e2e/sourcing-pwa.e2e.js` (new checks; none removed), `test/sourcing-field-activation.test.js` (capability matrix rows), `test/finance-privacy.test.js` scope if it scans routes.
Never modified to pass: any existing assertion in the rules, regulatory, hardening, realistic, calculators, engines, products, status suites.

---

## Honest unknowns (must be settled by Phase 0, not assumed)

1. Which free machine-readable sources actually exist and permit this use: TARIC / Access2Markets API, Eurostat Comext, bol.com programmes, any public sales-rank data.
2. Real speed and Chinese accuracy of local speech, translation and OCR on this PC.
3. Whether Android Firefox/Chrome microphone capture and IndexedDB audio storage behave on the owner's phone (physical test required).
4. Belgian import-VAT handling options for this owner's company (an accountant/broker question, not an engineering one).
