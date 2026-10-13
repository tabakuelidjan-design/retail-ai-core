# Creative provider benchmark runbook (DESIGN ONLY — not run)

Status: written 2026-10-14. **Nothing in this document has been executed.** No provider was called, no money spent. It specifies the next benchmark so it can be run once, cleanly, by the owner (credentials stay with the owner: never in the repository, never in a log).

Principle: **a provider is judged on what it does to the REAL product, not on how pretty the picture is.** Aesthetic quality is one column of nine and can never rescue a hard fail.

## 0. Ground rules

* Private directory only: `data/private/benchmark-assets/habb-benchmark-002/` (gitignored, already the convention of benchmark 001). Every input is pinned by SHA-256 in a committed manifest (hashes only, no pixels). Outputs go to `data/private/benchmark-runs/<run_id>/` with the request, the response metadata, the ledger entry and the cost. Nothing is committed but the manifest, the scoring sheet and the summary.
* One operation id per call (`bm002-<category>-<asset>-<provider>-<n>`), recorded in the ledger BEFORE the call; a repeated id is refused by the runner (no accidental double spend). Retry limit 0 in the benchmark (a failure is a data point, not something to retry away). Budget ceiling set per category and per run; the run aborts at 80 % of the ceiling and prints what remains.
* Reproducibility: fixed seed where the provider exposes one; otherwise 3 runs per cell and report spread, never the best run. Record provider, model id, version/date, region, parameters.
* Blind scoring: outputs are renamed to opaque ids; the person scoring does not see the provider name until the scores are saved.
* A **hard fail** in any cell forces that cell to FAIL whatever the other scores.

## 1. Test assets (small but representative, REAL HABB)

| Id | Asset | Why | Source |
|---|---|---|---|
| A1 | MILA phone case, white ground, 4K (integrates today) | baseline that works | `HABB_coque_MILA_fond_blanc_4K.png` |
| A2 | `remax_FC-02.png` (power bank + braided strap + chrome connector) | reflective edge, thin parts, ground-colour highlight (fails today) | Downloads / HABB folder |
| A3 | Black handbag + printed scarf, native alpha | thin ribbon, hole in handle, dark on dark | `Pu bag.png` |
| A4 | Pink tumbler with engraved text, native alpha with baked glow | text integrity, chrome rim, translucent ice | `flair 2.0 (2).png` |
| A5 | Ceramic plaque with printed logo + two stands | printed graphic (text must survive), multi-part | `plaque phot ceramique A4.png` |
| A6 | Magnet (gold scalloped frame, cream inside) | product colour collides with white ground | `habb-magnet-prune-or.png` |
| A7 | Bamboo frame (flat, checkerboard baked in) | pre-cut asset with fake transparency | `cadre base bamboo vierge.png` |
| A8 | The private benchmark-001 real case photo (1152×1536 JPEG) | the only photograph (not a render) with real lighting | `HABB_BENCHMARK_001_REAL_CASE_ASSET.jpg` (private) |
| A9 | NEW, to be shot by the owner: a gift box with ribbon, a UV-printed item on a table, a hand holding a case, two products touching | multi-object, hand contact, cluttered ground — the cases the local segmenter refuses | to shoot (phone is enough) |

Ten assets are enough: this is a discrimination benchmark, not a statistical one.

## 2. Categories, tasks, scoring, hard fails

Common scoring sheet (0–5 per column unless stated; blind): **product fidelity, edge quality, realism, text integrity, composition, mask compliance (edit categories), hallucination (5 = none), latency, cost**. Latency and cost are measured, then banded (not judged by eye).

### 2.1 Segmentation (cut-out of the real product)
* Task: return a matte (alpha) and bounds for A1–A9; for A9 the explicit selection "the phone case only, not the hand".
* Providers to run (candidates, none chosen): the current local plain-ground segmenter (control); one or two general-purpose segmentation / matting models (self-hostable and hosted); one hosted background-removal service; Canva's remove-background (the owner has Canva). Do not pick from claims.
* Scoring: run every output through `checkMatte` (the 14 deterministic checks) AND a human edge close-up at 6× on the composite over dark/light backdrops. Also IoU against a hand-made reference matte for A1, A2, A6.
* Hard fails: any non-selected object (hand, table, packaging) inside the matte; product pixels altered (the provider must return a mask or the original pixels, not a re-rendered product); dropped thin part (strap, connector, ribbon); transparent hole where the product is solid; halo run beyond the checker limit; matte not reproducible within 1 % IoU across 3 runs.
* Capture: latency per image, cost per image, output size, whether the response contains pixels or only a mask.

### 2.2 Selective / masked editing
* Task: with an explicit mask and protected regions, (a) replace the background around the product, (b) change a prop beside the product, (c) fix a defect region, (d) remove a hand. The mask comes from the deterministic stack, not from the provider.
* Providers: current Qwen image-edit (already wired for `editProductImage`), plus other mask-capable editors. Candidates only.
* Scoring: **mask compliance is the main score**: pixel difference of the protected region before/after must be 0 (the `protectedRegionsIntact` check of `src/creative-refine/masked-edit.js`); anything the provider changed outside the mask is a violation. Plus product fidelity (logo, text, ports, buttons unchanged), realism of the edited region, seam quality.
* Hard fails: any change inside a protected region; any change outside the mask beyond a declared tolerance; text/logo altered; product geometry changed; the provider returns a different resolution without declaring it.
* Capture: cost per edit, latency, whether the provider honours the mask natively or only via instruction.

### 2.3 Image generation (plates and props, never the product)
* Task: environment plate for A1/A2/A6 (table scene, window light), a prop on plain ground (flowers, books), at the production canvases (1080×1350, 1080×1920, 1200×628).
* Scoring: plate suitability gates already in the runtime (`environment-suitability`, `matteProp` plain-ground matte), composition (space for the product and the text), realism (perspective, light direction consistent with the declared light), absence of text/logos/people/hands in the plate, absence of a competing "product-like" object (the substitute detector).
* Hard fails: any product-like object, any readable text or logo, any human body part, a horizon/perspective that makes the declared support surface impossible, an unplain prop ground (the matte gate rejects it).
* Capture: cost per accepted plate (not per call: rejected plates are paid for), latency, acceptance rate over 5 draws per cell.

### 2.4 Visual critique / vision
* Task: critique 20 finished composites (10 good, 10 with injected known defects: halo, floating product, wrong shadow, text overlap, altered logo, duplicated object) against the HABB brand rules; return structured findings.
* Scoring: precision/recall on the injected defects, false-alarm rate on the good ones, agreement with the human blind score, JSON/protocol validity (no repair needed), consistency across 3 runs.
* Hard fails: missing an injected "product altered" defect; claiming an unverifiable fact; unstructured output after repair limit.
* Capture: cost and latency per critique.

### 2.5 Upscale
* Task: 2× and 4× of A1, A2, A5 (fine text, braided strap, chrome).
* Scoring: text integrity (OCR of the printed logo before/after), edge quality, texture honesty, no invented detail (compare downscaled output against the source: it must match within a PSNR/SSIM floor), artefacts.
* Hard fails: altered text/logo, invented features, changed colour beyond the controlled grade, geometry drift.
* Capture: cost per MP, latency.

### 2.6 Multi-reference (optional, last)
* Task: product + style reference + scene reference → scene; only if 2.1–2.4 are settled.
* Hard fails: product identity drift (identity-preserve check of C2a), style reference leaking into the product.

## 3. Product identity checks (every category)
After any provider step the real-product layer is verified by the existing deterministic gates, not by eye: `checkIdentity` (silhouette byte-exact, detail field global + worst tile, chromaticity/hue), `evaluateHardFidelityGate`, and the compositor's `product_pixels_changed = 0`. A provider whose output replaces the product pixels is only admissible for plates/props, never for the product.

## 4. Outputs
* `scoring-sheet.csv` (cell × score columns × hard-fail flag), `summary.md` (per category: ranking, failure modes, cost per accepted output), `ledger.jsonl`, and a go / no-go per category with the connection effort (LOW / MEDIUM / HIGH).
* Decision rule: a provider is connectable for a category only if it has **zero hard fails** on A1, A2, A3, A6 and A8 and its cost per accepted output fits the production budget.

## 5. Order and estimated spend
Run 2.1 first (cheap, and it unblocks the product path), then 2.2, then 2.3, 2.4; 2.5 and 2.6 only if needed. Set the ceiling before starting; the owner supplies credentials at run time. Estimated number of calls: 2.1 ≈ 10 assets × 3 providers × 3 runs = 90; 2.2 ≈ 4 tasks × 4 assets × 2 providers × 3 = 96; 2.3 ≈ 5 draws × 3 plates × 2 providers = 30; 2.4 ≈ 20 × 2 providers × 3 = 120 (cheap). Prices must be read from the providers' current price pages at run time, not assumed here.
