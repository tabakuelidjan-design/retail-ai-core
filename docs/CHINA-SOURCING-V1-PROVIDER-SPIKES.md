# China Sourcing V1 - Phase 0 Provider Spikes (investigation only)

Date of investigation: 2026-10-04. Scope: verify legal/technical availability of zero-cost providers, benchmark only what needs no substantial download, separate phone capability from PC capability, recommend a stack. **No V1 functionality was implemented, no model was downloaded, no account was created, nothing was installed.**

## How to read the evidence labels

| Label | Meaning |
|---|---|
| **MEASURED** | I ran it on this machine or against the live service during this investigation |
| **SOURCE** | taken from an official page or a published source I read (linked at the end); not re-verified by me |
| **ESTIMATE** | my engineering estimate; not measured, not sourced |
| **UNVERIFIED** | could not be established; must be checked before any decision relies on it |

Where search-engine summaries and official pages disagreed, I say so. Third-party blog figures are marked as such and are never used as a legal basis.


> **Update (P0b, 2026-10-04):** sections 10 and 11 at the end of this document refine and, where they differ, supersede the TARIC and Eurostat statements in sections 2.4, 2.6 and 8. Short version: TARIC automated retrieval is **not** cleared (robots.txt disallows the consultation and daily-publication paths; CIRCABC anonymity unverified): V1 keeps manual duty input. Eurostat Comext stays a V1 candidate **as trade-activity context only, never as demand**.

## 1. The machine and the environments

**PC (MEASURED):** Intel Core i5-8350U (4 cores / 8 threads, 1.7 GHz base), 15.9 GB RAM, Intel UHD 620 (1 GB, no discrete GPU), 220 GB free disk, Windows 11 Pro, Node 24.19, Python 3.14.7, `cloudflared` present. **Not installed:** ffmpeg, tesseract, any whisper/ASR or MT software.
**Windows built-in capabilities (MEASURED):** offline speech recognizer: English (US) only. Windows OCR engine languages: English (US) and French (France) only, **no Chinese**. User languages: en-US, fr-BE.
**Desktop browser probe (MEASURED, Edge 154 on this PC, secure context):** `getUserMedia` yes; `MediaRecorder` yes (`audio/webm;codecs=opus` yes, `audio/mp4` yes, `audio/ogg;codecs=opus` no); Web Speech API present; Translator API present; Prompt API absent; WebAssembly yes; WebGPU yes; 8 cores / 16 GB; storage quota about 10.7 GB. **This is the PC browser, not the phone.** It says nothing about the owner's Android Firefox/Chrome.
**Phone (UNVERIFIED for audio):** Android phone, Firefox (the field-test browser) and possibly Chrome. Microphone capture, recording format, IndexedDB size limits and quota are unknown until the P0b probe is run on the phone.
**Python caveat (MEASURED against PyPI):** Python 3.14 is new; for several ML packages the latest release publishes no regular `cp314` Windows wheel (e.g. `ctranslate2` offers only `cp314t`, the free-threaded build). Packages with only pure-Python wheels (e.g. `faster-whisper`, `rapidocr-onnxruntime`, `funasr`) pull heavy dependencies that may not install on 3.14. **Consequence:** any local-AI service should not assume the system Python; use a dedicated Python 3.11/3.12 environment, a standalone binary (whisper.cpp), or the Node stack. Adding npm or Python dependencies to the repository needs owner approval.

## 2. Findings by capability

### 2.1 Speech to text

| Option | Where | Facts | Verdict |
|---|---|---|---|
| Browser Web Speech API on the phone | phone | Chrome sends audio to Google servers (SOURCE); Chrome 139 added an on-device mode that needs a downloaded language pack, otherwise still cloud (SOURCE). Firefox for Android does not enable SpeechRecognition (SOURCE). Edge here exposes it (MEASURED) but it is cloud-backed. | **Rejected as default**: breaks the "no automatic external upload" rule and is not available in the field-test browser. |
| Phone keyboard voice typing (Gboard etc.) | phone, OS level | outside Nordla's control; works in any text field; offline behaviour depends on the owner's keyboard settings (UNVERIFIED) | Free manual aid for the *owner's own* typing. Not a supplier-conversation solution. |
| Record the conversation (MediaRecorder) and keep the original | phone | Edge desktop: webm/opus OK (MEASURED). Phone: UNVERIFIED. | **V1 core**: the original is the evidence; transcription is a later derivation. |
| WeChat's own voice-to-text and translation inside the supplier chat | phone, owner-operated | not Nordla functionality; availability and quality on the owner's phone UNVERIFIED; the owner copies the resulting text into Nordla | Good manual path for WeChat-based suppliers; costs nothing; V1 documentation, not code. |
| whisper.cpp (C/C++, MIT; Whisper weights MIT) | PC | sizes (SOURCE): tiny 75 MiB / base 142 MiB / small 466 MiB / medium 1.5 GiB; RAM about 273 / 388 / 852 / 2,100 MB; quantised tiny 31-42 MiB. Mandarin accuracy of the small Whisper models is weak: one published comparison reports zero-shot character error rates of about 53% (tiny), 42% (base), 29% (small) on a Mandarin set (SOURCE, single dataset, indicative only). Speed on this CPU: UNMEASURED. | Good for English; **not good enough for Chinese conversation numbers/model names** at the sizes this PC can run comfortably. |
| SenseVoice-Small (FunASR; code MIT, weights under the "FunASR Model Open Source License Agreement") | PC | Mandarin, Cantonese, English, Japanese, Korean; 234 M parameters; described as CPU-viable (SOURCE). A reported Mandarin CER around 7.8% (SOURCE, third-party site, benchmark conditions unknown). **The weights' licence terms for commercial use must be read before any download** (UNVERIFIED). | Best candidate for Mandarin on CPU; **needs a licence check and a measured benchmark first.** |
| Vosk small Chinese model (Apache-2.0, 42 MB) | PC | small, streaming; accuracy and punctuation modest (SOURCE, no benchmark read) | Fallback candidate; likely too weak for numbers. |

**Reality check (ESTIMATE):** a 4-core 8th-gen laptop CPU with no GPU can run these as *asynchronous batch jobs* on short clips. Live, in-the-room transcription of a noisy factory conversation is not a safe expectation. V1 therefore must not depend on transcription.

### 2.2 Translation

| Option | Where | Facts | Verdict |
|---|---|---|---|
| Fixed EN/ZH phrasebook (exists) | phone, offline | reviewed once; protected tokens inserted verbatim | **Primary and trusted.** Extend with composable templates. |
| Chrome/Edge built-in Translator API | desktop only | works on Chrome desktop; not on mobile (SOURCE); needs on-device model downloads and heavy hardware per docs (SOURCE); API surface present in Edge here (MEASURED), availability of the model UNVERIFIED | **Rejected for the phone path**; irrelevant to the field. |
| Opus-MT en-zh / zh-en (Helsinki-NLP) | PC | licence CC BY 4.0, commercial use allowed with attribution (SOURCE); about 300 MB per model (SOURCE, third-party summary; confirm on the model page); runtime via CTranslate2 (MIT) or ONNX/transformers.js (Apache-2.0) | **Best zero-cost local MT candidate.** Quality is gist-level for business terms (ESTIMATE); every output must be labelled MACHINE TRANSLATION with protected tokens masked. |
| NLLB-200 | PC | licence CC BY-NC 4.0: **non-commercial only** (SOURCE) | **Excluded** (HABB is a business). |
| Argos Translate | PC | library MIT/CC0 (SOURCE); its language packages carry their own licences (UNVERIFIED per package); needs Python | Possible wrapper around Opus-MT-class models; not required. |
| Owner uses Google Translate / WeChat translate in the apps | phone, owner-operated | outside Nordla; sends text to those services by the owner's own act | Documented manual fallback; Nordla never does it for the owner. |

### 2.3 Vision / OCR

| Option | Where | Facts | Verdict |
|---|---|---|---|
| Manual identification (exists) | phone | default path | stays the default |
| Windows OCR (Windows.Media.Ocr) | PC | free, offline; **Chinese not installed on this PC** (MEASURED: only en-US, fr-FR). A Chinese language pack can be added by the OS (needs admin and an OS change; size UNVERIFIED). | Attractive if the owner approves the OS pack: no model licences, no extra runtime. Windows-only; called via PowerShell/WinRT. |
| Tesseract (Apache-2.0), chi_sim | PC | tessdata-best chi_sim about 13 MB (SOURCE); reported accuracy 30-60% on complex layouts and backgrounds (SOURCE) | Weak on photos of papers; fallback. |
| PaddleOCR / RapidOCR (Apache-2.0), PP-OCR mobile ONNX | PC | mobile recognition models about 4-11 MB each (SOURCE); runtime onnxruntime (MIT, has a `cp314` Windows wheel: MEASURED); footprint about 50-80 MB, about 0.5-1 s per page on CPU (SOURCE, third-party) | **Best free Chinese OCR candidate**; small download; needs a benchmark on photographed certificates and quotations. |
| Existing Anthropic vision provider (paid per use, cloud) | cloud via PC server | already built, consent-gated, default disabled | Optional only; never mandatory. |
| Local vision-language model for product recognition | PC | CPU only, 1 GB iGPU: not realistic (ESTIMATE) | Not V1. |

### 2.4 EU market signals

| Source | Facts | Verdict |
|---|---|---|
| **Eurostat Comext** (EU trade by HS/CN8) | **MEASURED:** an anonymous SDMX/JSON request for Belgium imports from China, CN8 85076000, 2024, returned HTTP 200 in 1.8 s, no key, dataset DS-045409, last updated 2026-09-15 (so the CN8 detail and recency are real). Licence: CC BY 4.0 for Eurostat content, commercial reuse generally allowed with attribution; restrictions listed for some trade data subsets (SOURCE). Rate limits: not found in the pages I read (UNVERIFIED): cache and keep calls few. | **V1: yes** (server-side, cached). It is *market-size and trend context* (EU imports from China by product code), **not demand for this SKU** and not sales. |
| Google Trends | official API is an application-gated alpha (SOURCE); automated access through unofficial libraries violates Google's terms and the best-known library is archived (SOURCE) | **V1: manual** (the owner reads trends.google.com and types a DEMAND_SIGNAL with a date); official API only if access is granted: V2. |
| Amazon (EU) | no free official source of competitor sales; the old Product Advertising API is retired in favour of the Creators API, which requires an Associates account and qualifying affiliate sales (SOURCE: reported thresholds differ between pages: 3 vs 10 sales) and is meant for affiliate content, not market research; Amazon's Conditions of Use prohibit robots/scrapers (SOURCE) | **No automated Amazon data.** Manual observations stay (existing). Sales numbers are never invented. |
| bol.com | the Open API ended on 2023-10-16 (SOURCE); the Retailer API needs credentials issued through a professional seller account, is free to call, and is governed by bol's API terms (SOURCE); it serves a seller's own offers/orders, not competitor market data | **No for market research.** Manual bol.com observations in V1; Retailer API only if HABB sells on bol: V2. |
| OECD GlobalRecalls | the documented API is for governments to upload; the public surface is a 7-day RSS feed (SOURCE) | Not useful beyond Safety Gate. |
| Paid estimators (Helium 10, Keepa, JungleScout...) | paid | V2. |

### 2.5 Supplier intelligence

| Item | Facts | Verdict |
|---|---|---|
| USCC (unified social credit code) check digit | **MEASURED:** the GB 32100-2015 check-digit algorithm (alphabet of 31 characters without I, O, S, V, Z; weights 3^i mod 31; check = (31 - sum mod 31) mod 31) accepts two published sample codes and rejects a one-character corruption. Offline, deterministic, no data source. It proves *format consistency only*, never that the company exists. | **V1: yes** (offline, phone). Always labelled "format valid, existence not verified". |
| GSXT / National Enterprise Credit Information Publicity System (official registry) | free for basic queries, but the captcha is in Chinese, real-name authentication applies beyond basic search, and access from outside mainland China is reported as blocked or unreliable (SOURCE, third-party guides; the official site was not tested by me). Automating it would mean defeating a captcha. | **Manual only**: a guided "look this up" step (supplier or a Chinese-speaking helper does it); the owner types the result and the date. No automation. |
| IAF CertSearch (ISO management-system certificates) | free account; reported quotas of a few verifications per day (SOURCE, pages disagree on the exact limits); paid API for volume (SOURCE) | **Manual verify link** in V1. Only covers accredited management-system certificates (ISO 9001 etc.), not product compliance. |
| NANDO (EU notified bodies) | free, no account (SOURCE); useful to check that the body named on a CE certificate is a real notified body; machine access UNVERIFIED | **Manual verify link** in V1. |
| EPREL (energy labels) | public API needs a whitelisted key (SOURCE); only energy-labelled products | V2 / not core. |
| Commercial KYB (QCC, Tianyancha, Dun & Bradstreet) | paid | V2. |

### 2.6 Customs and regulatory sources

| Source | Facts | Verdict |
|---|---|---|
| **TARIC** (EU customs tariff, DG TAXUD) | **MEASURED (metadata query):** the official dataset record on data.europa.eu carries the licence "European Commission reuse notice" (Decision 2011/833/EU: reuse including commercial, with acknowledgement and no distortion of meaning: SOURCE for what that notice allows); its distributions are a CIRCABC group page and the TARIC Consultation web page (both HTML). A third-party GitHub project mirrors TARIC data (not a basis to rely on). **Whether an anonymous machine-readable snapshot download is possible on CIRCABC, its size, and its update cadence are UNVERIFIED.** The consultation website is a human interface; its automated-use terms were not found. | **V1: manual duty input only** (see section 10: no cleared automated route yet). |
| **Access2Markets** | the portal's own "Sources and copyright" page (SOURCE, read directly): content is licensed by a publisher (Mendel Verlag) and **may not be used for resale, consultancy, redistribution, building of databases, storage, or any purpose other than reference use**; use is restricted to users located in the EU and a list of countries; **no API or bulk download is mentioned**. | **NOT usable as an automated source.** Human reference and a deep link only. This corrects the earlier gap analysis, which named it as a candidate. |
| EU Safety Gate | existing adapter uses the public weekly-report XML endpoint (works, MEASURED in earlier phases). Reuse terms not re-read in this phase (UNVERIFIED). | already in V0 |
| ECB reference rates | existing | already in V0 |
| EBTI (binding tariff information) | public EU database; automated access and terms UNVERIFIED | optional later |

## 3. Which integrations need credentials or accounts, even if free

| Integration | Credential needed | Notes |
|---|---|---|
| Eurostat Comext | none | |
| TARIC snapshot | possibly an EU Login for CIRCABC (UNVERIFIED) | check in P0b |
| IAF CertSearch | free user account | small daily quota |
| NANDO | none | |
| EPREL public API | whitelisted key | V2 |
| bol.com Retailer API | professional seller account + client id/secret | V2, only if HABB sells there |
| Amazon Creators API | Associates account with qualifying sales | not for research; not planned |
| Google Trends official API | application to an alpha programme | V2 if granted |
| GSXT | Chinese-language captcha; beyond basics a Chinese ID or phone | manual by a helper |
| Local models (whisper.cpp, SenseVoice, Opus-MT, PP-OCR) | none to download (SOURCE for the open hubs; terms to be read per model) | licence terms differ per weight set |
| Anthropic vision (existing) | API key | optional, paid |

## 4. Rate limits, licences and terms constraints (summary)

- **Eurostat:** CC BY 4.0, commercial reuse generally allowed with attribution; some subsets restricted; rate limits not found: cache aggressively, show attribution in the app.
- **TARIC via data.europa.eu:** Commission reuse notice (attribution, no distortion); access method still to verify.
- **Access2Markets:** reference use only, EU-located users, no storage or database building: **do not integrate**.
- **Amazon:** automated access prohibited by the Conditions of Use; official APIs gated by affiliate sales and purpose.
- **bol.com:** API terms bind seller/service-provider use; no competitor-research API.
- **Google:** automated Trends access not permitted; official API gated.
- **Models:** whisper.cpp MIT; Opus-MT CC BY 4.0; NLLB CC BY-NC (excluded); PaddleOCR/RapidOCR/Tesseract Apache-2.0; SenseVoice weights have their own licence (read before approval).
- **Rule kept:** nothing is scraped; anything not clearly permitted becomes manual entry with a date and a source note.

## 5. Implementation complexity (ESTIMATE; S = days, M = 1-2 weeks, L = several weeks)

| Item | Size | Main risk |
|---|---|---|
| Voice-note capture and storage on the phone | M | Android browser formats, IndexedDB quota, recording surviving re-render |
| Deterministic EN/ZH fact extractor | L | Chinese number/unit patterns, false positives |
| Local transcription service on the PC (async jobs) | M-L | model choice/licence, speed on this CPU, Python/Node packaging |
| Local MT (Opus-MT) service | M | quality, protected-token masking, packaging |
| Local OCR (PP-OCR via onnxruntime or Windows OCR zh pack) | M | Chinese accuracy on photographs |
| Comext client with cache and attribution | S | unknown rate limits |
| TARIC snapshot importer | M-L | depends on P0b result; large file; update process |
| USCC validator + guided registry checklist | S | none |
| Manual market-signal model (ranges, provenance) | M | UX, no fake precision |
| Optional copy of a recording to the owner's PC | M | transport transparency (LAN vs tunnel), size limits |

## 6. Candidate downloads for approval (NOTHING HAS BEEN DOWNLOADED)

You required exact model/version, licence, size, RAM/disk, expected performance and V1 capability **before** any download. These are the candidates; items I could not confirm are marked and will be confirmed on the model's own page when I come back with the formal request.

| # | Candidate | Licence | Size (as known now) | RAM / disk | Expected performance on this PC | Capability it would prove | Still to confirm |
|---|---|---|---|---|---|---|---|
| 1 | whisper.cpp prebuilt Windows binary + `ggml-tiny.bin` and `ggml-base.bin` | MIT | tiny 75 MiB, base 142 MiB (SOURCE); binary size UNVERIFIED | about 273 MB / 388 MB RAM (SOURCE) | UNMEASURED; to be measured on owner-recorded synthetic clips | English transcription of the owner's own speech; honest Mandarin baseline (expected weak) | exact release tag, binary size, SHA |
| 2 | SenseVoice-Small (int8/ONNX or GGUF build) | code MIT; **weights licence to be read** | 234 M parameters; file size UNVERIFIED (ESTIMATE a few hundred MB) | UNVERIFIED | UNMEASURED | Mandarin transcription quality on clips | licence permits commercial use? exact build, size |
| 3 | Opus-MT en-zh and zh-en (CTranslate2 or ONNX build) | CC BY 4.0 | about 300 MB each (SOURCE, third-party) | about 1 GB RAM while translating (ESTIMATE) | UNMEASURED; short sentences expected within seconds | machine translation of free questions with protected tokens | exact repo/revision, converted size |
| 4 | PP-OCR mobile detection + recognition (ONNX) with onnxruntime | Apache-2.0 / MIT | about 4-11 MB per model (SOURCE) | small | about 0.5-1 s per page (SOURCE, unmeasured here) | Chinese OCR of certificates and quotations | exact model files and versions |
| 5 | Chinese OCR language pack for Windows (OS component) | Microsoft | UNVERIFIED | UNVERIFIED | UNMEASURED | built-in alternative to #4 | requires admin; OS change; owner approval |
| 6 | One TARIC snapshot from CIRCABC | Commission reuse notice | UNVERIFIED (may be hundreds of MB) | disk only | n/a | proves anonymous machine-readable duty data | whether anonymous download works at all |

I recommend approving **#4 first** (tiny, Chinese-capable, directly useful for supplier documents), then **#1 and #2 together** for a like-for-like speech comparison, then **#3**. #6 is a pure access check that should start with a size check, not a download.

## 7. P0b - what still needs a human or an approval

1. **Phone capability probe (needs you, about 5 minutes).** A tiny page you open on the phone to report: microphone permission, recording formats, a 5 MB write to IndexedDB, storage quota, Firefox and Chrome behaviour. It would be served temporarily through the existing tunnel and removed afterwards. It records no audio content.
2. **Download approvals** from section 6, one at a time.
3. **Owner-side facts:** which phone keyboard/voice typing is used; whether WeChat is the supplier channel; whether a Chinese-speaking helper is available for registry lookups.

## 8. Recommended zero-mandatory-cost stack and decision table

Principles: the product must work with every provider UNAVAILABLE; originals are never replaced; machine output is labelled; supplier content stays local; nothing in this table is mandatory-paid.

| Capability | Recommended V1 provider/method | €0 mandatory? | Offline? | Phone/PC | Quality | Limitations | Legal/ToS risk | V1/V2 |
|---|---|---|---|---|---|---|---|---|
| Voice capture | MediaRecorder, original stored on the phone | Yes | Yes | Phone | Original = perfect | Android format/quota unverified until the probe; storage size | None (local) | V1 |
| Speech to text (English) | whisper.cpp base on the PC, async, after an optional explicit copy | Yes | Yes (PC local) | PC | Good for clear English (SOURCE-level, unmeasured here) | Not real time on this CPU (ESTIMATE); needs the copy step | MIT | V1 optional (P14) |
| Speech to text (Mandarin) | SenseVoice-Small on the PC, async (benchmark first) ; fallback: owner pastes WeChat voice-to-text | Yes | Yes (PC local) | PC | Best free candidate; whisper tiny/base too weak (SOURCE) | weights licence to read; unmeasured here | Licence check pending | V1 optional (P14) |
| Live/in-room transcription | none | n/a | n/a | n/a | n/a | not feasible on this hardware | n/a | V2 |
| Web Speech API (phone browser) | not used | n/a | No | Phone | n/a | cloud in Chrome; absent in Firefox Android | Privacy rule violation | Rejected |
| EN<->ZH supplier questions | Fixed phrasebook + composable templates (existing) | Yes | Yes | Phone | High for covered sentences; reviewed | covers only known sentences; native review still pending | None | V1 |
| EN->ZH / ZH->EN free text | Opus-MT on the PC, labelled MACHINE; English-only fallback with a copy button | Yes | PC local | PC | Gist-level (ESTIMATE); protected tokens required | ~300 MB per direction (SOURCE); not on phone | CC BY 4.0 (attribution) | V1 optional (P14) |
| Chrome/Edge Translator API | not used | n/a | desktop only | PC | n/a | no mobile support (SOURCE) | n/a | Rejected |
| NLLB | not used | n/a | n/a | n/a | n/a | CC BY-NC | Non-commercial licence | Excluded |
| Document/label OCR (Chinese) | PP-OCR mobile via onnxruntime on the PC (or Windows OCR zh pack if approved) | Yes | PC local | PC | Best free for Chinese (SOURCE); needs photo benchmark | accuracy on photos untested; result stays UNVERIFIED until confirmed | Apache-2.0 / MIT | V1 optional (P14) |
| Product recognition from photo | Manual identification (existing); existing consent-gated cloud provider optional | Yes (manual) | Yes | Phone | Owner-confirmed | no local VLM on this PC | Cloud provider = consent | V1 manual; AI V2 |
| Fact extraction from text | Deterministic EN/ZH rules, then optional AI second pass | Yes | Yes | Phone | Predictable; precision to be measured on corpora | Chinese patterns hard; never auto-applied | None | V1 (P2) |
| EU import statistics | Eurostat Comext (SDMX/JSON), cached, per member state (not the EU27 aggregate until the Austria point is settled) | Yes | Cached only | PC server | Official, CN8, 24 months, about 6 weeks lag (MEASURED) | **trade activity only: not demand, not sales**; transit effect; fair-use throttling | CC BY 4.0, attribution; Austrian CN8 restriction question | V1 context signal (P10) |
| Search demand | Manual Google Trends entry (human), dated | Yes | Yes | Phone | Directional | manual; no automation | Automated access prohibited; manual use fine | V1 manual; API V2 |
| Amazon EU signals | Manual observations (existing); ranges only | Yes | Yes | Phone | Observed listings only | no sales data; no scraping | Scraping prohibited; official APIs gated | V1 manual; paid V2 |
| bol.com signals | Manual observations | Yes | Yes | Phone | Observed listings only | Retailer API is seller-only | API terms; no research API | V1 manual; API V2 |
| Supplier legal identity | Supplier-provided data + offline USCC check-digit validation | Yes | Yes | Phone | Format check is exact (MEASURED); existence unproven | format only | None | V1 (P12) |
| Chinese registry check | Guided manual lookup (GSXT) by the owner or a helper | Yes | No | Human | Official | captcha, real-name, access issues | Automation would bypass a captcha: no | V1 manual |
| Certificate registries | Manual verify links: IAF CertSearch, NANDO | Yes (free account for IAF) | No | Human | Official | daily quotas; management-system certs only | Terms of each site | V1 manual |
| Paid KYB / trade data | none | n/a | n/a | n/a | n/a | n/a | n/a | V2 |
| Customs duty / measures | Existing user-provided duty (V1); TARIC snapshot import only after DG TAXUD confirms a supported retrieval route in writing | Yes | Manual / cached | Phone / PC server | Official if imported; indicative only | robots.txt disallows the consultation and daily-publication paths; CIRCABC anonymity unverified; derivation 2-4 weeks | Commission reuse notice (CC BY 4.0) but automated retrieval not cleared | V1 manual; import V1.5 conditional (P13) |
| Access2Markets | not integrated; deep link for human reference | n/a | No | Human | Official | reuse terms forbid storage/databases; no API | **High if automated** | Excluded |
| Safety Gate | existing adapter | Yes | Cached | PC server + phone cache | Official | weekly cadence | existing | V1 (done) |
| FX | ECB (existing) | Yes | Cached | PC server | Official | daily | existing | V1 (done) |

## 9. Corrections this investigation makes to earlier documents

1. Access2Markets must not be treated as a data source (gap analysis section 8 named it as a candidate). Corrected in this document; the implementation plan's P13 now relies only on TARIC if P0b proves anonymous access.
2. Browser speech and translation APIs are rejected as defaults for privacy and platform reasons.
3. A Python 3.14 environment is a packaging risk for local AI; plan for an isolated runtime or the Node stack.
4. NLLB is excluded by licence; Opus-MT (CC BY 4.0) is the translation candidate.

## Sources

- whisper.cpp project, model sizes and MIT licence: https://github.com/ggml-org/whisper.cpp ; https://huggingface.co/ggerganov/whisper.cpp
- Web Speech API behaviour: https://developer.mozilla.org/en-US/docs/Web/API/SpeechRecognition ; https://www.assemblyai.com/blog/speech-recognition-javascript-web-speech-api ; https://caniuse.com/speech-recognition ; Firefox Android voice input: https://support.mozilla.org/en-US/kb/voice-input-firefox-android
- Opus-MT zh-en: https://huggingface.co/Helsinki-NLP/opus-mt-zh-en ; overview of open translation models: https://picovoice.ai/blog/open-source-translation/
- Chrome Translator API: https://developer.chrome.com/docs/ai/translator-api ; availability on mobile: https://groups.google.com/a/chromium.org/g/chrome-ai-dev-preview-discuss/c/HKIndTczlPM
- SenseVoice / FunASR: https://github.com/modelscope/FunASR ; https://www.funasr.com/en/models.html ; Vosk models: https://github.com/alphacep/vosk-api/issues/1538
- Tesseract Chinese models: https://github.com/tesseract-ocr/tessdata/issues/72 ; PaddleOCR 3.0 report: https://arxiv.org/html/2507.05595v1 ; RapidOCR: https://github.com/RapidAI/RapidOCR/releases
- Argos Translate: https://github.com/argosopentech/argos-translate ; CTranslate2: https://github.com/OpenNMT/CTranslate2
- Access2Markets sources and copyright (read directly): https://trade.ec.europa.eu/access-to-markets/en/content/sources-and-copyright ; TARIC entry: https://trade.ec.europa.eu/access-to-markets/en/content/taric
- TARIC on the EU data portal: https://data.europa.eu/data/datasets/eu-customs-tariff-taric?locale=en
- Eurostat reuse policy (read directly): https://ec.europa.eu/eurostat/web/main/help/copyright-notice ; Comext API: https://ec.europa.eu/eurostat/web/user-guides/data-browser/api-data-access/api-introduction
- bol.com API terms and Open API end: https://developers.bol.com/en/ecosystem/terms-conditions-EN/ ; https://developers.bol.com/en/open-api-beta-endpoints-available-in-retailer-api/
- Amazon API and Conditions of Use discussion: https://webservices.amazon.com/paapi5/documentation/register-for-pa-api.html ; https://velantio.com/blog/amazon-creators-api-replacing-pa-api-5 ; https://thunderbit.com/blog/is-scraping-amazon-legal
- Google Trends API alpha: https://developers.google.com/search/blog/2025/07/trends-api
- USCC standard overview and validators: https://en.wikipedia.org/wiki/Unified_Social_Credit_Identifier ; https://github.com/zbl1998-sdjn/china-usci
- GSXT access guides: https://fdichina.com/blog/gsxt-access-outside-china/ ; https://chinesecheck.com/blog/national-enterprise-credit-information-system
- IAF CertSearch: https://www.iafcertsearch.org/verify-certificates ; NANDO: https://economie.fgov.be/en/themes/commercial-policy/technical-barriers/database-notified-bodies-nando ; EPREL public API terms: https://ec.europa.eu/assets/move-ener/eprel/EPREL%20Public/Public%20API%20Term%20and%20Conditions/API_TERMS_AND_CONDITIONS_EN.pdf
- Safety Gate download endpoint (existing adapter): https://ec.europa.eu/safety-gate-alerts/api/download/weeklyReport/list/xml/en ; OECD GlobalRecalls: https://www.oecd.org/en/publications/oecd-globalrecalls-portal_d8b0d605-en.html

---

# P0b - Findings (second pass)

Date: 2026-10-04. Same labels as above (MEASURED / SOURCE / ESTIMATE / UNVERIFIED). Research for sections 10 and 11 was done by a research agent working under strict rules (no logins, no downloads beyond small API JSON and one public PDF, at most about 10 requests per host, no circumvention); the robots.txt finding was re-checked by me.

## 10. TARIC - is there a legal, stable, zero-cost, machine-readable route?

**Verdict: (2) a route exists, but with conditions and uncertainty. V1 keeps manual duty input as the primary and only supported path until DG TAXUD confirms a supported retrieval route in writing.**

### 10.1 What exists

| # | Route | What I found | Usable by Nordla? |
|---|---|---|---|
| 1 | TARIC consultation website (DG TAXUD), human interface | MEASURED: anonymous HTTP 200, HTML only (about 156-294 KB per page), no EU Login. **MEASURED (re-checked by me): `https://ec.europa.eu/robots.txt` contains `Disallow: /taxation_customs/dds2/taric/` for all crawlers.** No published terms on automated queries or rate limits found. | **No.** It would be scraping a human UI against the site's own crawler rules. |
| 2 | Daily TARIC update files ("daily publications") | MEASURED: the listing page answers anonymously ("Last TARIC update: 02-10-2026"), one zip per working day (about 19:15 CET), deltas of about 20-190 KB, XML. The page is under the same robots-disallowed path. Whether the zip files themselves are anonymous or encrypted was **not** tested (UNVERIFIED; a search snippet claims PGP-encrypted). | **Not without written confirmation.** |
| 3 | Monthly/full TARIC extractions on CIRCABC (Excel) | SOURCE: the Commission's TARIC page says raw data is "freely available in Excel format" and links the CIRCABC library. MEASURED: the library URL redirects to a single-page application; I could not list or download files without driving the interface, and I did not try to bypass anything. One CIRCABC document (the 37-page "Explanation for the Taric database extractions") was publicly readable by direct link, so some content is anonymous. | **Probably, but unverified** (anonymous bulk download, stable URLs, cadence). |
| 4 | TARIC3 web service (SOAP) | UNVERIFIED and likely not public: described as an internal DG TAXUD application used by national administrations. No public endpoint or registration route found. | No |
| 5 | EU Open Data Portal record | MEASURED: metadata only; the two distributions are HTML pointers (CIRCABC group, consultation page); the record's modified date is 2018-12-14; no licence field on the record I queried. | Pointer only |
| 6 | Access2Markets | Human portal; reuse terms forbid storage and databases (section 2.6). No official API. | No |
| 7 | National customs services (Belgian Tarbel, Dutch) | Not tested. A third-party mirror says it scrapes them. National terms apply (UNVERIFIED). | Not evaluated |
| 8 | Third-party mirror `rousseauxy/taric-opendata` (GitHub) | MEASURED via the GitHub API: created 2026-06-27, 2 stars, single maintainer, code MIT; release `eu-2026-10` (2026-10-01) has 35 assets: a 27.8 MB monthly XLSX bundle (nomenclature, duties, measures, geographical areas) and daily delta zips. It says it auto-syncs from CIRCABC and the DDS2 daily portal and that it is "not an authentic source of tariff law". | **No as a system of record.** It automates the very pulls that robots.txt disallows, and it is a continuity risk. At most a cross-check. |
| 9 | EBTI (binding tariff information) | MEASURED: public database answers anonymously but is robots-disallowed; the Commission says all BTIs are public; no API or bulk download described. | Human lookup only |
| 10 | UK Trade Tariff API | MEASURED: anonymous, fast, JSON. **It is the UK tariff, not the EU's.** | **No.** Never a proxy for EU duty. |

### 10.2 Licence and legal value
- SOURCE (Commission legal notice): the Commission's reuse policy implements Decision 2011/833/EU, default licence CC BY 4.0 (credit, indicate changes); third-party content, logos and software excluded.
- SOURCE: the Commission accepts no liability for the accuracy of its information, and only the Official Journal is authentic. TARIC itself "does not have the status of a legal instrument" (EUR-Lex 52002XC0430(02), found via search, not read in full).
- **Consequence:** commercial caching with attribution is probably permitted (inference, UNVERIFIED for TARIC specifically), but Nordla must present any TARIC-derived duty as **indicative, tied to a snapshot date**, never as a binding classification or duty.

### 10.3 Derivation complexity (SOURCE-based; not tested on real files)
Deriving "duty for CN8 X from China on date D" needs the 10-digit TARIC code, measure validity dates, geographical-area membership (China, erga omnes and groups), measure types (third-country duty vs preference, suspension, quota, anti-dumping, countervailing, prohibitions/licences), duty expressions (ad valorem, specific, minima/maxima, Meursing for agricultural goods), additional codes (company-specific anti-dumping) and conditions/footnotes; the nomenclature also changes every 1 January. ESTIMATE: 2-4 weeks for a correct third-country-duty and anti-dumping resolver; quotas and conditional measures more. A first release should show **raw measures with dates**, not a single computed duty.

### 10.4 Decision for V1
1. **Manual duty input stays the V1 path** (user-provided, flagged USER PROVIDED, already built).
2. **One question to DG TAXUD in writing** (customs helpdesk / TARIC team): may a private company automatically retrieve the CIRCABC extractions and the daily files, and which URL is the supported one? That single answer settles the open points. I can draft the message for the owner to send.
3. If the answer is yes: import the monthly snapshot plus dailies into a cache, with attribution and a visible snapshot date; show raw measures first.
4. Do not scrape the consultation site or the daily-publication pages; do not rely on the mirror.

## 11. Eurostat Comext - what it can and cannot prove

Dataset `DS-045409` ("EU trade since 1988 by HS2-4-6 and CN8"; dimensions freq, reporter, partner, product, flow, indicators, time). All queries below were anonymous HTTP 200; dataset `updated` = 2026-09-15.

### 11.1 Measured
| Query (monthly, imports, CN8 85076000 = lithium-ion accumulators, partner China) | Response | Time |
|---|---|---|
| Belgium, value in euros, since 2024-08 | 3.0 KB | 1.44 s |
| EU27 (2020), value in euros | 3.2 KB | 1.23 s |
| EU27, quantity in 100 kg | 3.2 KB | 1.09 s |
| Belgium, all three indicators (value, quantity in 100 kg, supplementary quantity) | 3.8 KB | 1.15 s |

- **Latest month available: 2026-07** (2026-08 onward null; about 6 weeks after month-end).
- Example of what the data shows (EU27, imports from China, this code): value rose from about EUR 1.63 billion in 2024-08 to about EUR 2.72 billion in 2026-07, with 24 populated months; Belgium about 2-4% of the EU27 value, with visible month-to-month volatility (for example EUR 44.7 million in 2025-08 against EUR 100.9 million in 2025-09; the cause is unknown).
- No rate-limit or `Retry-After` headers were returned. SOURCE (Eurostat guidelines): sync below 500,000 cells, async above, HTTP 413 above 5 million; fair-use throttling by concurrent requests, frequency and cumulative cost; Comext complete-dataset downloads are disabled through the API. **Design:** always filter by reporter, partner, product and flow; one request at a time; cache for a month; store the dataset update date.

### 11.2 Licence and attribution
SOURCE (Eurostat copyright notice): reuse, including commercial, is authorised with acknowledgement of the source (CC BY 4.0; cite the dataset DOI and access date). Non-commercial-only restrictions are listed for: data from non-EU countries (including China), third-party material, Liechtenstein and Switzerland trade data under some classifications, and **Austrian trade data at CN 8-digit level**. EU-reported imports from China are not "data from China", so they are not in that exclusion. **Open point (UNVERIFIED):** the `EU27_2020` aggregate includes Austria; whether the Austrian CN8 restriction reaches the aggregate is unclear. Safe V1 choice: use individual reporters (Belgium first, then NL, FR, DE) rather than the EU27 aggregate, or ask Eurostat. The DOI of DS-045409 was not found and must be looked up before publication.

### 11.3 What Comext CAN show (with caveats)
- Whether a product code is imported from China at scale into the EU or a member state, and its value and weight.
- Direction, seasonality and growth over 24 months or more.
- Implied unit value (value / quantity) as a rough price-level signal (CIF basis).
- A feasibility filter (does meaningful trade exist for this code?), and which member states import.
- A citable, reproducible public benchmark with a stated update date.

### 11.4 What Comext CANNOT prove (and the app must say so)
**EU import activity is not consumer demand, and not marketplace sales.** Specifically it cannot show:
- consumer demand, retail sell-through, Amazon / bol.com / marketplace sales;
- where goods are consumed: goods declared in Belgium or the Netherlands include transit-style flows (the Antwerp/Rotterdam effect), so a Belgian figure can overstate Belgian demand;
- margins, landed cost or duty paid (the value is CIF and excludes duty);
- competitors or importers (no company-level data);
- anything finer than CN8 (one code mixes very different products, for example cells and finished packs, and the CN changes each 1 January: store the code with its year);
- current conditions (about 6 weeks of lag; recent months can be revised);
- origin certainty where a member state compiles on a consignment basis, or anything about quality, brand or compliance.

Further caveats (SOURCE: Eurostat methodology): imports valued CIF; partner = country of origin in the standard but not uniformly; confidentiality can suppress small CN8 cells; small traders below thresholds may be missing; exports include re-exports.

### 11.5 Rule for the product (binding for Market and Verdict)
1. A Comext figure is stored and displayed as **"EU customs-declared import activity for CN8 code X from China, member state Y, period P, dataset updated D. Not consumer demand."**
2. It is a signal of kind `TRADE_ACTIVITY`, separate from `DEMAND_SIGNAL`, `OBSERVED_LISTING`, `ESTIMATE` and `CONFIRMED_SALES`. It may never feed `businessDecision` as demand, may never be converted into a unit-sales estimate, and may never raise a verdict by itself.
3. It may only appear as context ("this category is actively imported"), a trend arrow with its period, and an implied unit-value range.
4. A test must assert that no code path maps a `TRADE_ACTIVITY` signal into a demand field.
5. Attribution line and dataset update date are always shown; the Austria/aggregate question is settled before any EU27 aggregate is used.
