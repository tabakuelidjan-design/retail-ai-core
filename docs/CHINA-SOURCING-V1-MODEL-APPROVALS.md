# China Sourcing V1 - Local model approval tables (P0b)

Date: 2026-10-04. Status: **NOTHING HAS BEEN DOWNLOADED.** This document is the approval request. Each row waits for an explicit owner approval before any file is fetched.
Machine: Intel i5-8350U (4 cores / 8 threads), 15.9 GB RAM, no GPU, Windows 11, Node 24, Python 3.14.7.
Method: sizes come from the Hugging Face API (`blobs=true`), the GitHub API and the ModelScope API; licence texts were read in full where decisive. The decisive claims were re-checked by me (see "Re-checked by me"). A research agent did the wide reading.
Labels: **SOURCE** (read, URL given) / **ESTIMATE** (reasoned, not measured) / **UNVERIFIED**. **No benchmark exists for this exact CPU; every speed figure for this machine is an ESTIMATE.** This is a technical reading of licences, not legal advice.

## Summary of recommendations

| Capability | Candidate | Weights licence allows commercial use? | Recommendation |
|---|---|---|---|
| Chinese/English OCR | PP-OCRv6 small (official PaddlePaddle ONNX); fallback PP-OCRv5 mobile | Yes (Apache-2.0) | **APPROVE FOR SPIKE** |
| English/French speech to text | whisper.cpp v1.9.4 / nightly b5130 + `ggml-base-q5_1.bin` (optional `ggml-small-q5_1.bin`) | Yes (MIT) | **APPROVE FOR SPIKE** (not for Mandarin) |
| Mandarin speech to text | SenseVoice-Small | **Not established clearly** | **REJECT FOR V1** (owner's rule: licence unclear for commercial Nordla use) |
| EN<->ZH machine translation | Opus-MT en-zh / zh-en (quantised ONNX) | Cards say yes; **training-data licence is CC-BY-NC-SA** | **HOLD: do not download for V1; revisit in V1.5 after legal clarity** |

Consequence for V1: there is **no approved local Mandarin speech recogniser and no approved local machine translator**. V1 stays useful without them: the original recording is kept, the owner pastes WeChat's own voice-to-text or types what was said, questions come from the fixed phrasebook, and free questions show English with a clear "no Chinese available" label. This is the zero-mandatory-cost path the plan already requires.

---

## 1. PP-OCR (Chinese + English OCR)

| Field | Value |
|---|---|
| Capability | Printed-text OCR of supplier documents, labels, quotations, certificates (Chinese, English; Latin script incl. French is covered by separate recognisers) |
| Exact model / repository / version | **PP-OCRv6 small**: `PaddlePaddle/PP-OCRv6_small_det_onnx` rev `28fe5895c24fd108c19eb3e8479f4ab385fbfc62` (`inference.onnx` 9,880,512 B) and `PaddlePaddle/PP-OCRv6_small_rec_onnx` rev `b8f84f0b80c529de40b4fbb3544b84fa7233a513` (`inference.onnx` 21,159,378 B), each with `inference.yml` (the rec yml carries the character dictionary, about 150 KB). Both last modified 2026-06-18. Fallback: **PP-OCRv5 mobile** via RapidOCR ONNX on ModelScope (`RapidAI/RapidOCR`, `onnx/PP-OCRv5/det/ch_PP-OCRv5_det_mobile.onnx` 4,819,576 B + `rec/ch_PP-OCRv5_rec_mobile.onnx` 16,631,306 B; revision hash not captured). Tiny and medium v6 variants also exist (tiny 1.8 + 4.5 MB; medium 62 + 77 MB). |
| Licence of the weights | Model-card metadata `license: apache-2.0` on every PaddlePaddle PP-OCRv5/v6 repository (SOURCE: https://huggingface.co/PaddlePaddle/PP-OCRv6_small_rec_onnx; re-checked by me through the HF API). PaddleOCR and RapidOCR code: Apache-2.0. No separate model licence found. |
| Commercial use allowed? | **Yes.** Apache-2.0: no user-count, revenue or field-of-use limits; patent grant. |
| Attribution obligations | Ship the Apache-2.0 text and a NOTICE with the PaddlePaddle/RapidOCR copyright notices; state changes if the files are modified. Use official files only (some community ONNX conversions carry no licence metadata). |
| Download size | about 31 MB (v6 small det + rec), about 21.5 MB for the v5 fallback |
| Installed size | about 31 MB of models plus the runtime. `onnxruntime-node` (npm 1.30.0, MIT) unpacks to about 301 MB because it bundles every platform; production needs only the Windows x64 binary (tens of MB). |
| Expected peak RAM | ESTIMATE 0.3-0.7 GB for one A4 image |
| CPU / runtime | CPU only; ONNX via `onnxruntime-node` (or Python `onnxruntime`; a Python 3.14 wheel is UNVERIFIED and must be checked at spike time). Detection and recognition postprocessing (DB postprocess, CTC decode) must be implemented or taken from a wrapper (`ppu-paddle-ocr`, `@gutenye/ocr-node`: MIT, v6 support and dependency licences UNVERIFIED). |
| Expected speed on i5-8350U | ESTIMATE about 1-4 s per scanned page for mobile/small models. Published: det 57.77 ms and rec 21.20 ms on a Xeon Gold 6271C (SOURCE via PaddleOCR docs, secondary; a server CPU, far faster than this laptop). |
| Languages | Simplified/Traditional Chinese, English, Japanese, pinyin; v6 covers about 50 languages. French accents on the zh+en model are UNVERIFIED. |
| Quality evidence | Vendor benchmark on the v6 card: recognition average 73.7 (v5 mobile), 73.5 (v6 tiny), **81.3 (v6 small)**, 83.2 (v6 medium); v6 small printed Chinese 90.5, printed English 93.3. Older v5 card (different benchmark): printed Chinese 0.8605, printed English 0.8753, handwritten Chinese 0.4166. All vendor-published, not independent. Reference paper: arXiv 2606.13108 (full text did not load). |
| Privacy | Fully local; no network at inference once the files are on disk. |
| Integration complexity | Medium (ONNX inference plus pre/post-processing in Node on the PC). |
| Recommendation | **APPROVE FOR SPIKE.** First choice v6 small; confirm v6 (not v5) is the intended target. Spike checklist: measure real speed and RAM, test French accents, test photographs of real certificates/quotations (synthetic or non-confidential), test a Python 3.14 `onnxruntime` wheel. OCR output stays UNVERIFIED until the owner confirms it against the paper (existing rule). |

## 2. whisper.cpp (speech to text)

| Field | Value |
|---|---|
| Capability | Local transcription of owner-recorded English (and French) speech, as an asynchronous job on the PC; honest Mandarin baseline |
| Exact model / repository / version | **Runtime:** `ggml-org/whisper.cpp` tag **v1.9.4** (2026-09-11, commit `927cfce34f31707e17f2bff35c349632fb9e2c3a`); that release has no assets, binaries are on the pre-release **b5130** (same commit): `whisper-bin-x64.zip` 8,573,270 B, sha256 `f9ec6c52a2e949b62ab51fa21d0d497958f9e41c3010c157c4e42932d5316f3c` (size and sha re-checked by me). **Models:** Hugging Face `ggerganov/whisper.cpp` revision `5359861c739e955e79d9a303bcbc70fb988958b1`: `ggml-base-q5_1.bin` 59,707,625 B (recommended), `ggml-tiny.bin` 77,691,713 B, `ggml-base.bin` 147,951,465 B, `ggml-small-q5_1.bin` 190,085,487 B (optional); other variants: tiny q5_1 32.2 MB, tiny q8_0 43.5 MB, base q8_0 81.8 MB, small 487.6 MB, small q8_0 264.5 MB. |
| Licence of the weights | whisper.cpp and ggml code: MIT. Underlying OpenAI Whisper weights: the openai/whisper README says "code and model weights are released under the MIT License" (LICENSE: MIT, Copyright 2022 OpenAI); the Hugging Face card for `openai/whisper-small` says `apache-2.0`. The sources disagree on the name; **both are permissive**. The ggerganov card says `mit`. |
| Commercial use allowed? | **Yes.** No user-count, revenue or field-of-use limits. Caveat (UNVERIFIED): OpenAI has not published the training data. |
| Attribution obligations | Include the MIT copyright and permission notices (OpenAI and whisper.cpp/ggml) in a THIRD-PARTY-NOTICES file. |
| Download size | recommended set about 68 MB (8.6 MB binary + 59.7 MB base q5_1); with small q5_1 about 259 MB |
| Installed size | about the same as the download |
| Expected peak RAM | tiny about 273 MB, base about 388 MB, small about 852 MB (SOURCE: whisper.cpp README memory table; f16 figures) |
| CPU / runtime | CPU only; `whisper-cli.exe` as a child process; input 16 kHz WAV, so a conversion step is needed (no ffmpeg is installed on this PC: UNVERIFIED how to convert the phone's webm/opus; a decoder dependency or a Node decoder must be chosen at spike time). AVX2 use in the prebuilt binary is UNVERIFIED (the CPU supports it). |
| Expected speed on i5-8350U | **ESTIMATE only.** Published encoder times for one 30 s window (SOURCE: https://github.com/ggml-org/whisper.cpp/issues/89): i7-8750H 4 threads tiny 571 ms / base 1,184 ms / small 4,157 ms; i5-8500T tiny 686 / base 1,600 / small 6,197 (`.en`); for the near-twin i5-8250U only the large model was posted (61.5 s). Scaled estimate for the 8350U (encoder per 30 s): tiny about 1-1.5 s, base about 2.5-4 s, small about 9-12 s; overall real-time factor roughly 0.1-0.5 for tiny/base and 0.5-1+ for small. Not measured. |
| Languages | multilingual including English, French, Mandarin |
| Quality evidence | English/French: strongest general open choice (the SenseVoice benchmark page concedes this); no independent French WER found (UNVERIFIED). **Mandarin: weak.** In a competitor-published test on 184 Mandarin clips, whisper.cpp `-l zh` gave character error rate 31.33% (base) and 22.12% (small) against 7.81-8.17% for SenseVoice (SOURCE: https://github.com/FunAudioLLM/SenseVoice/blob/main/runtime/llama.cpp/BENCHMARKS.md; self-interested, hardware not stated). |
| Privacy | Fully local. |
| Integration complexity | Easy to run from Node as a child process; the audio conversion step is the real work. |
| Recommendation | **APPROVE FOR SPIKE** with `whisper-bin-x64.zip` + `ggml-base-q5_1.bin` (+ optionally `ggml-small-q5_1.bin`). Purpose: English/French transcription of the owner's own speech and the audio-conversion question. **Not the answer for Mandarin supplier speech.** |

## 3. SenseVoice-Small (Mandarin speech to text)

| Field | Value |
|---|---|
| Capability | Mandarin/Cantonese/English/Japanese/Korean transcription on CPU (French not supported) |
| Exact model / repository / version | `FunAudioLLM/SenseVoiceSmall` (Hugging Face) rev `3847d57b6bdf2dd8875cb1508d2af43d80a16bf7`: `model.pt` 936,291,369 B. Runtime builds: sherpa-onnx `csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17` rev `2365baeacb507f821a0c8120fcee3d484dba7a07`, `model.int8.onnx` 239,233,841 B (the 2025-09-09 build is a third-party Cantonese fine-tune with an unchecked upstream licence: do not use); GGUF `FunAudioLLM/SenseVoiceSmall-GGUF` q8 254,208,320 B. |
| Licence of the weights | Model card: `license: other`, linking the **FunASR MODEL_LICENSE (v1.1)**. I read the file myself (via the GitHub contents API). Operative clauses: free to use, copy, modify and share; **must attribute source and author and retain model names**; Section 3: the software "is provided for reference and learning purposes only" with no liability; Section 4.2: "unjustified denigration, malicious smearing" means "automatic forfeiture of all licenses"; Section 6: revisions apply on continued use; **Section 7: "governed by the laws of [Country/Region]" - the placeholder is unfilled.** The text never uses the words "commercial" or "non-commercial". Converted ONNX/GGUF builds are derivatives and covered; relabels as apache-2.0/mit on community repos do not override it. |
| Commercial use allowed? | **NOT ESTABLISHED CLEARLY.** For: Section 2.1 grants free use without a field restriction; a project maintainer wrote in issues #286/#287 that commercial use is permitted subject to the licence. Against: the "reference and learning purposes only" wording can be read as a use restriction; the governing-law clause is blank; the licence can change unilaterally; the forfeiture clause is unusual; the maintainer answer on the exact question (issue #334) is recorded as **not a final licence-owner confirmation and the issue remains open**; GitHub comments are not a signed grant. |
| Attribution obligations | (if ever used) credit "SenseVoice-Small, FunASR / Alibaba Group" with a link, keep the model name unchanged, no public denigration. |
| Download size | about 239 MB (int8 ONNX) |
| Installed size | about 240-260 MB plus runtime (`sherpa-onnx-node` Apache-2.0; Windows binary package about 23.5 MB) |
| Expected peak RAM | ESTIMATE 0.5-1.0 GB |
| CPU / runtime | CPU; sherpa-onnx (Node addon) or the FunASR llama.cpp runtime (single binary, about 5 MB Windows asset) |
| Expected speed on i5-8350U | ESTIMATE about 5-10x real time. Vendor figures: about 20x real time on 8 CPU threads (hardware not disclosed); real-time factor 0.049-0.099 on an ARM RK3588 (not x86). Not measured. |
| Languages | Mandarin, Cantonese, English, Japanese, Korean (no French) |
| Quality evidence | Vendor benchmark (FunASR team, 184 real Mandarin clips of 44-60 s, micro-CER, 8 CPU threads): 7.81% (fp32), 8.17% (Q8), against whisper.cpp small 22.12% and base 31.33%. Home test set, undisclosed CPU, not independent. Published AISHELL numbers: UNVERIFIED (the README comparison is an image). |
| Privacy | Fully local |
| Integration complexity | Easy-medium |
| Recommendation | **REJECT FOR V1.** The owner's rule applies: the weights licence cannot be established clearly for commercial Nordla use (blank governing law, "reference and learning purposes only", open licence-owner clarification, unilateral revision). **Revisit only if** the licence owner (Alibaba/FunASR) confirms in writing, or a lawyer clears Section 3 and the missing governing-law clause. Technically it is the best free Mandarin candidate, which is why it is worth asking. |

## 4. Opus-MT English <-> Chinese (machine translation)

| Field | Value |
|---|---|
| Capability | Local gist translation of free questions and supplier text (labelled MACHINE TRANSLATION, protected tokens) |
| Exact model / repository / version | Originals: `Helsinki-NLP/opus-mt-en-zh` rev `408d9bc410a388e1d9aef112a2daba955b945255` (`pytorch_model.bin` 312,087,009 B) and `Helsinki-NLP/opus-mt-zh-en` rev `cf109095479db38d6df799875e34039d4938aaa6` (same size), both 2023-08-16. Quantised ONNX for transformers.js: `Xenova/opus-mt-en-zh` rev `046f55aec303cdee3e0318604406d4df20f1e8ea` and `Xenova/opus-mt-zh-en` rev `39d480d52a9ea3065a1f117adfe4dbc55de10e6f` (both 2025-07-14): per direction `encoder_model_quantized.onnx` 52,899,742 B + `decoder_model_merged_quantized.onnx` 60,212,804 B + tokenizer files about 9 MB, about 122 MB each way. |
| Licence of the weights | Cards: en-zh `apache-2.0`, zh-en `cc-by-4.0` (SOURCE: the two Hugging Face model cards). The Xenova conversions carry **no licence metadata** (inherited, UNVERIFIED). **Training-data caveat (SOURCE, read by me): the Tatoeba-Challenge README, whose pipeline produced these models, states "Training data is released under the CC-BY-NC-SA 4.0 license."** The cards ignore this; OPUS is an aggregate of corpora with mixed licences. Whether a model trained on non-commercial data inherits the restriction is legally unsettled. The newer Apache-2.0 `opus-mt-tc-bible-big-zhx-en` (946 MB, no ONNX found) has the same OPUS/Tatoeba lineage. |
| Commercial use allowed? | **UNCLEAR** (the declared licences say yes; the data lineage says non-commercial). |
| Attribution obligations | zh-en (CC-BY-4.0): credit Helsinki-NLP / OPUS-MT with a link and the licence, indicate changes (in credits, not on each translation). |
| Download size | about 245 MB for both directions (quantised ONNX) |
| Installed size | about the same |
| Expected peak RAM | ESTIMATE 0.5-1 GB per direction |
| CPU / runtime | CPU; `@huggingface/transformers` (npm 4.3.0, Apache-2.0) with `onnxruntime-node`; set offline mode explicitly (default `dtype` on Node UNVERIFIED); en->zh needs the `>>cmn_Hans<<` prefix |
| Expected speed on i5-8350U | ESTIMATE 0.3-1.5 s for a short sentence, several seconds per paragraph. Unmeasured; no published benchmark. |
| Languages | English <-> Mandarin only (no French; a pivot through English compounds errors) |
| Quality evidence | Card scores on short Tatoeba sentences: en-zh BLEU 31.4; zh-en BLEU 36.1, chr-F 0.548. They do not predict business-text quality. No WMT/Flores scores found (UNVERIFIED). |
| Privacy | Fully local once the offline path is set |
| Integration complexity | Low-medium |
| Recommendation | **HOLD - do not download for V1.** Resolve the training-data question first (a lawyer, or acceptance of the residual risk by the owner). V1 does not need it: the phrasebook plus templates cover supplier questions, and free questions can be shown in English with a copy button for the owner's own translator. Revisit in V1.5. If later approved: Xenova quantised pair, internal drafts only, human review before anything customer-facing. |

---

## Re-checked by me
- FunASR `MODEL_LICENSE`: Section 3 ("reference and learning purposes only"), Section 4.2 (forfeiture), Section 7 (`[Country/Region]` unfilled) and the attribution clause confirmed; no occurrence of "commercial" in the file.
- Tatoeba-Challenge README: "Training data is released under the CC-BY-NC-SA 4.0" confirmed.
- whisper.cpp b5130: `whisper-bin-x64.zip` 8,573,270 B and its sha256 confirmed; Hugging Face model sizes for `ggml-base-q5_1.bin`, `ggml-tiny.bin`, `ggml-base.bin`, `ggml-small-q5_1.bin` and the licence `mit` confirmed.
- PP-OCRv6 small det/rec repositories: licence `apache-2.0`, revisions and `inference.onnx` sizes confirmed.
Not re-checked (agent report only): SenseVoice maintainer statements in GitHub issues, the whisper.cpp benchmark table, PP-OCR quality tables, Xenova file sizes, npm package details.

## Dependencies this would add (needs owner approval at the time, not now)
`onnxruntime-node` (MIT; about 301 MB unpacked, only the Windows binary is needed), possibly a Node audio decoder or ffmpeg for webm/opus to 16 kHz WAV, and optionally a Node OCR wrapper. Nordla's core has no such dependency today; these would live in an optional local-AI service on the PC, never in the phone app or the core engines.

## Order of approval requests (when you choose to proceed)
1. PP-OCRv6 small (about 31 MB) with `onnxruntime-node`. 2. whisper.cpp binary + `ggml-base-q5_1.bin` (about 68 MB). 3. Nothing else for V1: SenseVoice rejected, Opus-MT on hold. Each request will repeat this table row with the final file list and hashes.
