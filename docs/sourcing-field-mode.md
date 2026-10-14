# Nordla - China Sourcing Intelligence, field mode V0

**Question it answers, on a phone, in front of a supplier:** "I am looking at this product right now. Should I buy / import it for sale in Belgium / the EU and possibly on Amazon?"

Status: V0 on branch `feature/china-sourcing-field-mode` (base `3b44f19`). Local only: nothing deployed, no migration, no push.
Nordla is **decision support**. It is not a lawyer, a customs authority, a laboratory, a certification body or an Amazon approval authority.

## Run it

```bash
npm run sourcing
```

Opens `http://127.0.0.1:8787` (loopback). The access token is written to `data/local/sourcing/token.txt` (never printed; `data/local/` is git-ignored). To use it from a phone on your own network set `SOURCING_HOST=0.0.0.0` first: the token is then mandatory. The app is a PWA: after the first load the whole decision engine runs **offline in the phone's browser**; the server is optional (cases on disk, Safety Gate cache, PDF reading, ECB rates).

## The Product Case

One case is built progressively from events (photo, text, identifiers, trait answers, quote, documents, safety result, customs, Amazon observations) and **re-assessed from scratch after every event** (`assess(state)` is pure: same state + same externals + same clock = same result). Nothing restarts. The event log is append-only; the decision history only records real changes.

First screen = **DECISION** ("SHOULD I CONTINUE WITH THIS PRODUCT?"), then Case, Ask, Docs, Rules, Market, Money.

### The decision card

| Dimension | Values |
|---|---|
| Identification | HIGH / MEDIUM / LOW (a category guessed from a photo or text stays LOW until a person or the supplier confirms it) |
| EU / Belgium marketability | GREEN / AMBER / RED / UNKNOWN |
| Amazon readiness | READY / CONDITIONALLY_READY / NOT_READY / UNKNOWN / NOT_REQUESTED (never "approved") |
| Economics | ATTRACTIVE / BORDERLINE / UNATTRACTIVE / UNKNOWN |
| Supplier evidence | COMPLETE / PARTIAL / INSUFFICIENT / CONTRADICTORY |
| Safety / recall risk | LOW / MEDIUM / HIGH / UNKNOWN |
| **Verdict** | GO / CONDITIONAL_GO / NO_GO / INSUFFICIENT_INFORMATION (no numeric score) |

Plus: why, verified vs supplier-claimed vs calculated vs estimated vs assumed vs missing vs needs-expert, what to ask now, what could block import and what could block Amazon, maximum purchase price, next action.

**Verdict logic** (`src/sourcing/core/decision.js`, deterministic; the LLM never decides):
- **NO_GO**: Safety Gate exact/probable match; documents contradicting the case or not covering the regulation; negative unit economics (or margin below half the target); Amazon category restricted when Amazon is the only channel.
- **INSUFFICIENT_INFORMATION**: identification LOW; a regime that cannot be decided (CE applicability unresolved, medical claim); a critical cost unknown (supplier price, FX, freight, customs duty); no selling price / target.
- **CONDITIONAL_GO**: required documents missing; identification only MEDIUM; margin below target; Safety Gate not consulted or cached; own brand; higher-risk regime (toys, food contact, cosmetics, PPE, batteries) which always needs expert / authority confirmation; unresolved regimes; Amazon not ready.
- **GO**: none of the above. `canCommitMoney` is true only for GO.

## Modules (`src/sourcing/`)

| Module | Role |
|---|---|
| `core/identity.js`, `taxonomy.js` | evidence-based identity; unknown stays unknown; strongest evidence wins; the owner's latest answer replaces his earlier one; documents/suppliers can contradict |
| `core/predicate.js`, `rules-engine.js`, `rulebook/` | rules are DATA, evaluated with three-valued logic (APPLIES / NOT_APPLICABLE / UNRESOLVED); each result carries why, required and missing evidence, sources with verification level and freshness, rule version |
| `core/operator.js` | economic-operator role; HIGH warning when selling under your own name or brand (you may be the manufacturer) |
| `core/docinspect.js` | document extraction and consistency checks (MODEL_MISMATCH, MANUFACTURER_MISMATCH, PRODUCT_MISMATCH, MISSING_PAGES, EXPIRED_OR_DATE_CONCERN, UNRELATED_STANDARD, INCOMPLETE_DECLARATION, UNKNOWN_LAB, DOCUMENT_TYPE_MISREPRESENTED, INSUFFICIENT_EVIDENCE) - wording SUSPICIOUS / INCONSISTENT / UNVERIFIED, never "fake" |
| `core/safety.js`, `adapters/safety-gate.js` | EU Safety Gate: official weekly XML ingested to a local cache and matched locally (EXACT / PROBABLE / SIMILAR PRODUCT RISK / NO MATCH FOUND; no match is not "safe") |
| `core/customs.js` | HS candidates (hints, heading level), duty only from the user or an official lookup, "CUSTOMS CLASSIFICATION REQUIRES CONFIRMATION", cheapest heading never picked silently |
| `core/landed.js`, `money.js` | deterministic landed cost in integer minor units; every line KNOWN / ESTIMATED / UNKNOWN / INCLUDED_IN_PRICE (Incoterm); unknown critical cost = INFORMATION_INSUFFICIENT |
| `core/economics.js` | unit economics, break-even, **maximum purchase price** by exact bisection over the real functions; instant what-if |
| `core/amazon.js` | market observations (OBSERVED / ESTIMATED / UNAVAILABLE, dated) and readiness; fees only from explicit inputs |
| `core/supplier.js` | prioritised "Ask the supplier now", fixed EN / Simplified Chinese phrasebook (model numbers, standards and document names inserted verbatim), negotiation brief |
| `core/decision.js`, `case.js` | decision engine, case aggregate, evidence ledger, freshness, what-if, decision history |
| `adapters/` | Safety Gate, ECB rates, AI provider boundary (disabled by default), PDF text (reuses the Finance reader) |
| `store/file-store.js` | one atomic JSON file per case, optimistic concurrency (rev) |
| `server/`, `ui/` | token-protected HTTP app (loopback by default) and the mobile-first PWA |

## Authoritative sources (what Nordla may rely on, what stays product-specific)

Checked 2026-10-03. "Original OJ text" means the Publications Office text of the original act was read (the EUR-Lex HTML pages were blocked for the research tool); **later consolidated amendments were not checked**. The full list with URLs lives in `src/sourcing/core/rulebook/sources.js` and is shown per rule in the Rules screen with its verification level.

| Source | Official URL | Last checked | Nordla may rely on | Remains product-specific |
|---|---|---|---|---|
| GPSR (EU) 2023/988 + Commission guidelines C/2025/6233 | publications.europa.eu `32023R0988`, `52025XC06233` | 2026-10-03 | applies from 13 Dec 2024; importer, manufacturer (own brand = manufacturer, Art. 13), responsible person (Art. 16), online-offer information (Art. 19), marketplaces (Art. 22); harmonised products keep only part of the chapters | risk analysis, standards, language per market |
| Reg. (EU) 2019/1020 Art. 4, Decision 768/2008, Reg. 765/2008 Art. 30, Blue Guide 2022 | publications.europa.eu `32019R1020`, `32008D0768`, `32008R0765`, `52022XC0629(04)` | 2026-10-03 | EU operator for harmonised products; CE only where an act provides for it; CE is not a safety approval; importer duties; operator details present at customs | which act applies, module, notified body |
| LVD 2014/35/EU, EMC 2014/30/EU, RED 2014/53/EU | `32014L0035`, `32014L0030`, `32014L0053` | 2026-10-03 | scope and voltage limits (50-1000 V AC / 75-1500 V DC); RED covers safety and EMC for radio equipment | rating, exclusions, standards |
| RED cybersecurity 2022/30 (applies from 1 Aug 2025; repealed from 11 Dec 2027 by 2026/339), CRA 2024/2847 | `32022R0030`, `32023R2444`, `32026R0339`; Commission news | 2026-10-03 | duty for internet-connected / personal-data / child radio equipment | the CRA text itself was NOT opened |
| Common charger 2022/2380 | `32022L2380` | 2026-10-03 | USB-C for listed rechargeable devices since 28 Dec 2024 (laptops 28 Apr 2026) | exact Annex Ia category |
| RoHS 2011/65 + 2015/863 | `32011L0065`; Commission RoHS page | 2026-10-03 | restricted substances and limits | test data, exemptions |
| Toys 2009/48/EC and Regulation (EU) 2025/2509 (from 1 Aug 2030) | `32009L0048`, `32025R2509`; FPS Economy | 2026-10-03 | scope, EN 71 expectations, transition | toy classification, age grading |
| PPE 2016/425, Machinery 2023/1230 (from 14 Jan 2027), ESPR 2024/1781 | `32016R0425`, `32023R1230`, `32024R1781` | 2026-10-03 | PPE categories and certificates; ESPR destruction ban for apparel / footwear from 19 Jul 2026 | category, delegated acts |
| Batteries 2023/1542, WEEE, PPWR 2025/40 (from 12 Aug 2026), REACH, CLP, food contact (1935/2004, 10/2011, 2024/3190), textiles 1007/2011, cosmetics 1223/2009 | Commission pages (opened); some regulation texts only via EUR-Lex links (not opened) | 2026-10-03 | existence and scope of the regimes, producer-responsibility registration, declaration of compliance for food contact, responsible person / CPNP for cosmetics | staggered application dates, article-level obligations: flagged REQUIRES EXPERT |
| Belgium: FPS Economy (GPSR, toys, electrical), ConsumerConnect (language), BIPT (radio), Recupel, Bebat, Fost Plus, Valipac, FASFC (food contact) | see `sources.js` | 2026-10-03 | language area rule (NL / FR / DE), registrations, authority routing | per-product language, per-sector authority |
| EU Safety Gate weekly XML | `ec.europa.eu/safety-gate-alerts/api/download/weeklyReport/list/xml/en` | 2026-10-03 (live fetch of the index and a report worked) | official alerts since 2005, no authentication; reuse needs source, extraction date and language | no search API: Nordla ingests and matches locally; only ingested weeks are searched |
| TARIC / EBTI | Commission pages | 2026-10-03 | tariff structure | no official REST API found: duty is entered by the user or a broker, never invented |
| Amazon (GPSR information, regulated product areas, FBA rate card effective 1 Jul 2026) | Amazon seller pages | 2026-10-03 | what Amazon asks sellers to hold | Seller Central is authoritative; fee numbers are NOT encoded |
| VAT standard rates BE 21 / FR 20 / DE 19 / NL 21 | FPS Finance; EP briefing quoting the Commission TEDB | 2026-10-03 | default VAT rate suggestions (always editable) | reduced rates by product |

## Privacy

Cases, supplier identity, prices, contacts and documents stay on the phone and on your own server. Nothing is sent to an AI provider unless one is configured; the default provider is **disabled**. If one is configured, the payload is minimised (no supplier identity, no price, e-mail and phone redacted) and **CONFIDENTIAL / PERSONAL data is refused for any provider hosted in China** unless explicitly allowed. The AI may suggest (recognise a product, read a label); it is never authoritative for law, tariffs, fees, arithmetic, compliance status or the verdict.

## Offline behaviour

The header shows two separate facts. **Server**: SERVER VERIFIED only after an authenticated check of your server succeeded in the last 90 s; otherwise NO SERVER, TOKEN REFUSED, TOO MANY ATTEMPTS, NOT SIGNED IN or PHONE ONLY. **Safety Gate** (line below): LIVE needs a verified server AND a copy downloaded live under 24 h ago; otherwise CACHED (with its age) or NONE. The phone downloads the copy by itself once the server is verified. (Logic: `src/sourcing/core/status.js`; real-tunnel check: `npm run sourcing:e2e:tunnel`.)

- **LIVE VERIFIED** (engine mode): Safety Gate cache refreshed in this process (or a live check for the same product facts in the last 24 h).
- **CACHED**: an earlier result: shown as cached, with its date, with a condition to re-verify.
- **OFFLINE - VERIFICATION REQUIRED**: nothing available. This is never presented as a clean result.
Cases are stored locally on the phone first and synced when the server is reachable; a conflict (two devices) is reported and never overwritten silently.

## Persistence and the link to "Achats & Fournisseurs"

V0 stores one JSON file per case (`data/local/sourcing/cases`) and, in the browser, local storage. **No table, no migration.** The case JSON already carries `supplier` (identity, contact, market, booth, link), `quotes` (unit price, currency, quantity, MOQ, Incoterm, lead time, carton), `documents` (extraction + inspection) and an append-only `events` / `decisions` log. The planned additive tables, to be created only after validation, are `sourcing_cases`, `sourcing_evidence` (append-only), `sourcing_documents` and `sourcing_decisions` (append-only), each tenant-scoped like the rest of Nordla.

## Rule review status (regulatory closure, 2026-10-03)

Every one of the 31 existing rules carries a review record (`src/sourcing/core/rulebook/review.js`; the full per-rule table with instrument, article, consolidated version, application dates, interpretation and uncertainty is in `docs/sourcing-regulatory-closure.md`). No rule was added. The EU acts were verified against their CONSOLIDATED texts from the Publications Office; a rule is VERIFIED_CURRENT only if no amending act and no corrigendum is dated after the consolidation.

| Status | Before | After | Rules (after) |
|---|---|---|---|
| VERIFIED_CURRENT | 0 | 13 | GPSR, operator duties (Reg. 2019/1020 Art. 4), CE framework, EMC, RED, common charger, RoHS, REACH, CLP, PPE, WEEE, medical-device boundary, Belgian language |
| PRIMARY_TEXT_ONLY | 13 | 12 | LVD, RED cybersecurity / CRA, toys, food contact, textiles, cosmetics, PPWR, customs / EORI, Recupel, Bebat, BIPT, FASFC (a corrigendum after the consolidation, no consolidated text, or an authority page instead of the legal text) |
| NEEDS_EXPERT_REVIEW | 6 | 1 | Batteries (the labelling date depends on an implementing act that was not found; whether a power bank is a "battery" or a product incorporating one is an interpretation) |
| INCOMPLETE | 2 | 2 | Belgian packaging (schemes only), Amazon GPSR listing information |
| UNVERIFIED | 10 | 3 | UN 38.3 / lithium transport (UNECE refused the request), Amazon category documents, Amazon dangerous goods |

**Consequence in the engine**: only applicable rules that are MATERIAL to the product (`PRODUCT_COMPLIANCE`) and NEEDS_EXPERT_REVIEW / INCOMPLETE / UNVERIFIED (or whose review is older than 180 days) keep marketability at AMBER at best and the verdict at CONDITIONAL_GO at best. Operator / administrative obligations (registrations, producer responsibility, customs administration) are listed with their review status but never cap the product verdict, and Amazon rules only affect Amazon readiness. So a plain household product or a documented mains charger can reach GO, while a power bank cannot until an expert has reviewed the Batteries rules.

**What changed in the rules (each correction has a test)**: GPSR Arts. 9-18 do not apply to CE-harmonised products; the own-name = manufacturer rule is now explicit (sector acts, GPSR Art. 13, Blue Guide 3.1) with modification / repackaging / label-change cases and an UNRESOLVED state that asks a question instead of assuming an importer; REACH notification needs 0.1 % w/w AND one tonne per year (Art. 7(2)-(3)) and Art. 33 information; the common-charger rule applies only to RADIO equipment (RED Art. 3(4), Annex Ia); batteries are a CE regime; toys: EN 71 gives a presumption of conformity, it is not itself mandatory; food contact: bisphenol rules since 2026-07-20; customs: UCC replaced by Reg. 2026/2108 from 2027-09-21, a temporary EUR 3 duty on low-value distance sales since 2026-07-01; Belgian rules now separate the LEGAL obligation (regional) from the SCHEME service (Recupel, Fost Plus / Valipac) and the OPTIONAL service (Bebat membership).

## Field activation (2026-10-04)

**Gap list found by the audit** (all fixed unless marked OPEN):
1. **The service worker could never install**: `cache.addAll()` was given the page `/` twice and a duplicate URL rejects the whole install, so no phone would ever have had the app offline. Found only by running a real browser engine (the browser pane blocks service workers). Fixed and covered by the real-browser test.
2. **Offline changes were not marked as waiting** until the delayed sync ran: closing the app in that window could skip the sync. A case is now marked "changed" (and persisted) at the moment of the edit.
3. **A sync could overwrite edits made while the request was in flight** with the server's answer. It now keeps the newer local content and sends it again.
4. **Conflicts** offered only "take the server copy". They now offer "keep both copies" (mine is saved as "(my copy)") and never overwrite silently.
5. **localStorage quota**: 26 weeks of Safety Gate alerts plus phone photos would fill the ~5 MB and silently lose data. Photos, document photos and the Safety Gate copy now live in IndexedDB (auto-migrated from the old layout); the case JSON stays in localStorage.
6. **PWA**: only an SVG icon. Added 192 / 512 / maskable PNG icons, an Apple touch icon, `id`, `scope`, `start_url`, safe-area padding, and 8 tabs that fit 375 px.
7. **Phone access**: only a manual recipe. Added `npm run sourcing:phone` (server on loopback + optional Cloudflare quick tunnel through the installed `cloudflared`; nothing is started unless the owner runs it; the pairing link carries the token in the URL fragment). The rate limiter now tells real clients apart behind the tunnel (the proxy header is trusted only from a loopback peer).
8. **Quick field path** (thin form over the same events), **AT A GLANCE** numbers on the verdict, live results strip on Money (no re-render while typing), one-question-at-a-time supplier screen, customs source / origin / notes ("USER PROVIDED"), document evidence states, and the offline capability matrix (menu: "What works right now").
9. **OPEN**: not tested on a physical phone; the tunnel path was exercised only with a fake `cloudflared` (nothing was exposed during development); the live vision provider and Seller Central remain untested.

**Real-browser proof** (`npm run sourcing:e2e`, 16 checks): it launches a REAL Edge / Chrome engine (service worker, Cache Storage, IndexedDB) with a phone-sized viewport and runs: online install through the pairing link -> shell cached -> case created with the quick path, big photo downscaled into IndexedDB, Safety Gate copy stored -> app closed, server stopped, **browser restarted** -> the installed entry opens offline with the case, calculations, rulebook and the CACHED Safety Gate -> edit offline, create a case offline -> network returns, repeated reconnects, server restart mid-use, interrupted sync, a real conflict (never overwritten) -> layout at 375 / 390 / 430 wide, portrait and landscape -> no secret in any response. **This is an engine-level proof, not a physical phone**: touch, the camera, the install prompt and the mobile OS are not covered. Run `docs/sourcing-phone-rehearsal.md` on the real phone.

**Phone access options** (see `docs/sourcing-china-procedure.md`): `npm run sourcing:phone` (recommended, needs `cloudflared`); your own HTTPS reverse proxy with `SOURCING_ALLOWED_HOSTS`; or work on the phone only (paper fallback for documents). Plain HTTP on the home network cannot keep the app offline (service workers need HTTPS or localhost).

## Photo input and document photos (field hardening)

- **Product photo**: kept as evidence only. Nordla does not recognise products by itself. An optional replaceable vision provider can SUGGEST a category: only the downscaled image is sent, only after the owner taps OK for that image, the answer is validated against Nordla's own category list and marked **AI_SUGGESTED** (identification stays LOW until the owner confirms it). The adapter is exercised with a mock fetch only (no key in this repository): **not tested against the live API**.
- **Document photo / scanned paper**: native text PDF -> deterministic extraction. Photo -> an AI reader (same consent and region rules) or the owner **types the key fields from the paper** (works offline). OCR text is **UNVERIFIED** (finding `OCR_UNCONFIRMED`) and never counts as present until the owner corrects it and confirms it against the paper; even then it is a supplier document (SUPPLIER_CLAIM), never VERIFIED_FACT. No OCR runs locally.

## Server hardening

Token on every `/api` route; 8 wrong tokens per minute per address locks the address for a minute (429); Host allow-list (`SOURCING_ALLOWED_HOSTS`, 421); CSP `default-src 'self'`, `frame-ancestors 'none'`, `nosniff`, no referrer; static files whitelisted; images sent to a provider only with `consent: true` per request (428 otherwise) and never to a China-hosted provider for confidential data. The offline shell is pre-cached from `/shell-manifest.json` (a test checks that every module `app.js` imports is in it).

## Not verified in this environment

The built-in browser could not register a service worker (even a trivial script failed with "unknown error fetching the script"), so a **cold start of the page with no network was not tested**. What was tested: the case, the decision engine and the Safety Gate copy keep working in the open page after the server is stopped, cases reopen offline, edits made offline are pushed on reconnect. Run the offline rehearsal on the real phone (see `docs/sourcing-china-procedure.md`).

## Known limitations (read before relying on it)

1. **Rule texts**: 13 rules match the current consolidated text; 12 are PRIMARY_TEXT_ONLY (a corrigendum after the consolidation, or the Belgian authority page instead of the legal text, was not read); Batteries stay NEEDS_EXPERT_REVIEW; 2 are INCOMPLETE and 3 UNVERIFIED (UN 38.3, two Amazon rules). Corrigenda cannot be read as text through the Publications Office route. An expert must still review the rulebook for any regulated product.
2. **Standard families** used for UNRELATED_STANDARD, the 3-year test-report age, and the HS candidates (heading level) are **heuristics**, labelled as such.
3. **No OCR**: a scanned PDF or an image document is INSUFFICIENT_EVIDENCE unless the text is pasted or an AI reader is configured.
4. **Safety Gate**: only the ingested weekly reports (12 by default) are searched; many alerts lack brand, model or barcode. No match is not safe. Matching on short model numbers (under 5 characters) is deliberately not done on its own.
5. **Amazon**: no scraping; market data is typed by the owner; fees are never guessed; category restrictions must be checked in Seller Central.
6. **Customs**: no tariff lookup; the duty rate is typed in. Classification always needs a broker or a binding tariff information.
7. **Phrasebook**: fixed sentences in English and Simplified Chinese written once; have a Chinese speaker check them.
8. **UI language is English** (verdict headlines are bilingual EN/FR); French UI is not done.
9. **Belgian-only layer**; FR / DE / NL language rules for Amazon marketplaces are not verified.
10. Not built, by design: procurement ERP, purchase orders, warehouse, supplier accounting, forecasting, global marketplaces, full legal automation, customs broker, supplier CRM.
