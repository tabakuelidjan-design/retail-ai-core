# Creative Intelligence — PRE-C2 Foundation

**Status: `C1 FOUNDATION = COMPLETE` · `PRE-C2 TECHNICAL FOUNDATION = COMPLETE` · `C2 = NOT READY`**

Pushed at `d182e86` on `feature/branding-marketing-creative-v1`; remote CI green (Creative Intelligence V1 on Node 20 and 24, Branding V1, Marketing V1).
The technical foundation is complete. What is **not** complete is the real HABB data the benchmark needs (section 8): that is an operational / data
blocker, not a missing capability.

Nothing here starts C2, integrates a provider, or runs a benchmark. This patch closes the foundation blockers the C1 closure listed, from real
evidence only, and keeps `c2_allowed` false until HABB CREATIVE BENCHMARK 001 has actually been run.

## 1. What this patch adds

| Part | Delivered | Where |
|---|---|---|
| A | Common Socle resource resolver (9 kinds, owner adapters, provenance, FORMAT and FONT capability) | `src/resources/` — contract in `socle-resource-resolver-v1.md` |
| B | Brand Memory V1.1 — optional `expression_system` | `src/branding/expression-system.js`, `schemas/branding/brand-memory-v1.schema.json` — `branding-v1-contract.md` |
| C | Real typography: font bytes → bidi → shaping → line layout | `src/creative-intelligence/production-typography.js` |
| D | Deterministic rasterizer and real PNG path | `src/creative-intelligence/production-render.js` |
| E | HABB benchmark readiness as configuration + a generic readiness assessor | `benchmarks/creative-intelligence/habb-creative-benchmark-001.json`, `benchmark.js` |
| — | Evidence-issued C2 readiness; capability verifications | `readiness.js`, `pre-c2-probes.js` |

## 2. Decisions

- **One resolver.** There is no Format Resolver and no Font Resolver: FORMAT and FONT are kinds of the common resolver. The kind of a resolution
  is the owner adapter's answer, never inferred from the text of the reference. Only FONT and FORMAT may be platform-level (`merchant_id: null`).
- **FORMAT** metadata is exactly `{canvas:{width,height,unit}, medium, safe_zones, forbidden_zones, production_constraints}`. No aspect ratio
  (derived), no channel, no placement (Marketing facts). The Creative intake still accepts `px` only and converts nothing.
- **FONT payload is ephemeral**: verified against the owner's declared sha-256 on load, never stored in a DesignDocument or Brand Memory.
- **Evidence-issued readiness.** `assessCreativeC2Readiness` accepts only evidence objects issued by this package (a module-private registry).
  Strings, hand-made objects, copies and evidence of another dependency are refused (`CI_READINESS_INVALID`). The six capability verifications
  run named checks and throw `CI_PROBE_FAILED` if any fails; the benchmark evidence exists only through `recordBenchmarkRun` on a RUNNABLE
  benchmark whose preflight, fidelity and guardian gates are PASS and that produced a PNG.
- **Expression system** is an additive optional sixth Memory category. A legacy Memory stays valid and READY but is not C2 brand-ready
  (`assessExpressionReadiness`). The creative interface exposes it; the marketing interface does not. No hard rule is duplicated in it.
- **Explicit alignment.** Media slots in layout recipes now carry an explicit `align`; `fitInto` refuses a slot without one — no hidden
  "centred product" default.

## 3. Typography library decision (bake-off)

| Need | Chosen | Alternatives considered | Why |
|---|---|---|---|
| Shaping (GSUB/GPOS, Arabic joining, kerning) | `harfbuzzjs` 1.6.3 (HarfBuzz WASM, MIT) | `opentype.js` (no complex shaping), `fontkit` (larger, shaping coverage uneven), system/browser text (non-deterministic) | The reference shaping engine; WASM, so identical on every OS and Node version; no native build |
| Bidirectional levels | `bidi-js` 1.1.0 (pure JS, MIT) | hand-written reversal (incorrect for mixed text), ICU via Intl (not exposed as levels) | Implements the Unicode Bidirectional Algorithm levels and mirroring; the line reorder (rule L2) is done over runs by this package |
| Rasterization | `@resvg/resvg-js` 2.6.2 (native, MPL-2.0) | `sharp`/librsvg (system font and libvips dependence), headless browser (non-deterministic, heavy), canvas (system fonts) | Deterministic, no browser, `loadSystemFonts: false`; prebuilt binaries for Windows/Linux/macOS |

**Text projection decision.** Text is projected into the SVG as **glyph outlines** (`<path>` defs referenced by `<use>`), not as `<text>`.
The shaped glyph ids and positions the layout measured are exactly what is drawn, so SVG and PNG cannot disagree with the layout, no font is
resolved at raster time, and nothing can fall back to a system font. The cost is that the SVG text is not selectable, which is irrelevant for a
production still. The `<text>` projection is kept only for declared-metrics inspection renders (`typography_mode: DECLARED_METRICS`), which
can never be rasterized to a production PNG.

**CJK line breaking is DEFERRED**: documented, not claimed, does not block C2.

## 4. SVG / PNG parity

The ink rasterized by resvg for each text is compared with the analytic ink bounds of its shaped glyphs
(`PARITY_TOLERANCE_PX = 1.5`, anti-aliasing and hinting-free outline rounding). Verified for Latin, Arabic and centred text, LTR and RTL.

## 5. PNG determinism

`renderProductionPng` requires a RESOLVED render with REAL (or no) typography. The encoded PNG is normalized (see the PNG chunks paragraph in section 6):
no timestamp, text or machine-specific chunk survives and the sRGB colour signalling is explicit. Six consecutive renders are byte-identical.
Cross-platform byte equality of the encoded PNG is **not claimed** (zlib/encoder differences between native builds are possible); what is
verified on every platform is determinism per platform and pixel parity with the layout.

## 6. Dependency and licence audit

| Package | Version | Licence | Purpose | Kind | Node 20 | Node 24 | Windows | Linux |
|---|---|---|---|---|---|---|---|---|
| `harfbuzzjs` | 1.6.3 | MIT | text shaping | WASM | verified | verified | verified | verified (Docker, x64) |
| `bidi-js` | 1.1.0 | MIT | Unicode bidi levels | pure JS | verified | verified | verified | verified |
| `@resvg/resvg-js` | 2.6.2 | **MPL-2.0** | SVG → PNG | native (prebuilt, per-platform optional dependency) | verified | verified | verified (win32-x64) | verified (linux-x64-gnu, Docker) |

Fixtures (tests only, never shipped): DejaVu Sans 2.37 under the **Bitstream Vera Fonts licence** (with DejaVu public-domain changes and Arev terms; SPDX
`Bitstream-Vera`) and Noto Naskh Arabic 2.021 under the **SIL OFL 1.1**. Source, exact licence, notice file and content hash of every
committed font are in `test/fixtures/fonts/FONTS.json`, which a test checks against the files.

**MPL-2.0 (resvg):** file-level copyleft. Nordla's proprietary source does not become MPL by using or linking resvg. Nordla does not modify any
covered file. If an executable containing resvg is *distributed*, MPL-2.0 §3.2 requires the covered source to be made available. The exact
package/version, upstream source, source-availability mechanism, notice and modification status are recorded in the repository-level
`THIRD_PARTY_NOTICES.md`. Not verified: macOS, arm64 and musl prebuilds (declared by the package, not tested here).

**PNG chunks.** resvg's own output holds only `IHDR`, `IDAT`, `IEND`: it carries *no* colour signalling. The normalizer keeps the decoding chunks
(`IHDR`, `PLTE`, `tRNS`, `IDAT`, `IEND`), drops everything else (`tIME`, `tEXt`/`zTXt`/`iTXt`, `pHYs`, `eXIf`, `iCCP`, any incoming colour chunk) and
**generates** `cHRM` (sRGB primaries and white point), `gAMA` 45455 and `sRGB` (perceptual intent) right after `IHDR`, with valid CRCs. This states that
the DIGITAL pipeline's pixels are sRGB (resvg paints in sRGB) in the same bytes every time. The pixel data (`IDAT`) is the encoder's, unchanged; no ICC
profile is invented. ICC / CMYK belongs to a future print pipeline.

## 7. HABB CREATIVE BENCHMARK 001 — status (after preparation)

```text
HABB BENCHMARK 001 PREPARATION = COMPLETE   (pushed at 0b1e328, remote CI green)
HABB BENCHMARK 001 = NOT_RUN / BLOCKED
C2 = NOT READY
```

Prepared: price claim, speed claim, FORMAT, and the owner-approved HABB expression payload (as content; not yet in Brand Memory).
Remaining binding work: canonical HABB Brand Identity / Core / Memory, benchmark fonts, the real PRODUCT, the real merchant-provided ASSET.

`NOT_RUN`, and **BLOCKED**. Computed by `assessBenchmarkReadiness` over the common resolver (HABB tenant `36b1a1a7-2a48-416a-9dfe-ce66fe1ec2a5`,
read from the connected `merchants` table):

| Binding | State | Detail |
|---|---|---|
| FORMAT | BOUND | `format://habb/benchmark-001/instagram-feed-1080x1350`, 1080 × 1350 px, DIGITAL, explicit empty zones, platform-level (unchanged) |
| CLAIM price | BOUND | `claim://habb/benchmark-001/price-25`, wording `25 €`, approval `approval://habb/GBP-PROD-01` |
| CLAIM speed | BOUND | `claim://habb/benchmark-001/express-5-minutes`, wording `5 minutes`, same approval; the qualification (store, model available, customer file usable) is kept beside the evidence |
| PRODUCT | MISSING | `HABB_BENCHMARK_PRODUCT_BINDING_MISSING` — the catalogue holds one product per phone model; the owner must name the benchmark product |
| ASSET | MISSING | `HABB_BENCHMARK_REAL_ASSET_MISSING` — no verified real photograph of a personalised HABB case exists |
| FONT | MISSING | `HABB_BENCHMARK_FONT_BINDINGS_MISSING` — no approved HABB font files / licences found |
| Expression system | MISSING | content is owner-approved (`habb-expression-system-benchmark-001.json`) but there is no canonical HABB brand_id, approved Brand Core or approved Brand Memory to carry it |

The two claims are **benchmark-owned trusted records, not the Claims Registry** (which does not exist yet). 25 € is scoped to Benchmark 001 and
the approved store-service evidence; it is not the universal online price. Readiness values are never written in the configuration file. RUNNABLE is not RUN.

## 8. C2 readiness

**Technical foundation — COMPLETE**

| Capability | State |
|---|---|
| Common Socle Resource Resolver | COMPLETE |
| FORMAT resource resolution | COMPLETE |
| FONT resource resolution | COMPLETE |
| Brand Memory V1.1 `expression_system` (mechanism) | COMPLETE |
| Real font metrics | COMPLETE |
| Real font shaping | COMPLETE |
| Arabic / bidi / RTL verification | COMPLETE |
| Deterministic rasterizer | COMPLETE |
| Real PNG path | COMPLETE |
| Deterministic sRGB PNG semantics | COMPLETE |
| Third-party licence inventory (`THIRD_PARTY_NOTICES.md`) | COMPLETE |

**Operational / data blockers (not capabilities) — OPEN**

- real HABB PRODUCT binding;
- real approved HABB product photo (`HABB_BENCHMARK_REAL_ASSET_MISSING`);
- approved CLAIM resource for "25 €";
- approved CLAIM resource for "5 minutes";
- actual HABB font resource bindings (files + licence references);
- approved HABB Brand Memory V1.1 `expression_system`;
- HABB CREATIVE BENCHMARK 001 execution.

HABB BENCHMARK 001 = NOT_RUN / BLOCKED. `c2_allowed` is `false`: the two dependencies that need this data, `BRAND_EXPRESSION_SYSTEM` and
`REAL_CAMPAIGN_BENCHMARK`, stay OPEN.

Detail:

`c2_allowed` is `false`. Of the blocking dependencies, six are capabilities this patch implements and verifies (resolver, font metrics, shaping,
Arabic/bidi, rasterizer, PNG path); the remaining two depend on real data and stay open until it exists: `BRAND_EXPRESSION_SYSTEM`
(an approved HABB expression system) and `REAL_CAMPAIGN_BENCHMARK` (the benchmark actually run, gates PASS).

## 9. Rollback

All changes are additive and sit above `3d4f850` (six commits, `17e4d04` to `d182e86`). Reverting the four commits restores C1
exactly; the Brand Memory V1 shape and every C1 DesignDocument semantic are unchanged.

## 10. Coverage matrix

Each row is a `// PC2-N` marker in the named test; the coverage test checks that every row's test exists.

<!-- coverage-matrix:start -->
| Row | Behaviour | Test |
|---|---|---|
| PC2-1 | an exact ACTIVE resource resolves, with its provenance | resources-resolver.test.js › Common resolver: one authoritative answer from the owner, kind from the owner, scope enforced |
| PC2-2 | a reference nobody owns stays UNRESOLVED (no kind, never READY) | resources-resolver.test.js › Common resolver: one authoritative answer from the owner, kind from the owner, scope enforced |
| PC2-3 | a resource of another merchant is refused deterministically (and a merchant-less asset too) | resources-resolver.test.js › Common resolver: one authoritative answer from the owner, kind from the owner, scope enforced |
| PC2-4 | two owner adapters resolving the same reference is a conflict, never a pick | resources-resolver.test.js › Common resolver: one authoritative answer from the owner, kind from the owner, scope enforced |
| PC2-5 | the kind comes from the owner, not from the text of the reference | resources-resolver.test.js › Common resolver: one authoritative answer from the owner, kind from the owner, scope enforced |
| PC2-6 | FORMAT resolves through the same common resolver (no separate format resolver) | resources-resolver.test.js › Common resolver: one authoritative answer from the owner, kind from the owner, scope enforced |
| PC2-7 | a FORMAT cannot state a channel | resources-resolver.test.js › Common resolver: one authoritative answer from the owner, kind from the owner, scope enforced |
| PC2-8 | a FORMAT cannot state a placement | resources-resolver.test.js › Common resolver: one authoritative answer from the owner, kind from the owner, scope enforced |
| PC2-9 | a FORMAT cannot state an aspect ratio as truth | resources-resolver.test.js › Common resolver: one authoritative answer from the owner, kind from the owner, scope enforced |
| PC2-10 | a non-px FORMAT resolves truthfully, but the current Creative intake refuses it (it converts nothing) | resources-resolver.test.js › Common resolver: one authoritative answer from the owner, kind from the owner, scope enforced |
| PC2-11 | a FONT payload never enters a DesignDocument: the document holds the canonical ref only | resources-resolver.test.js › Common resolver: one authoritative answer from the owner, kind from the owner, scope enforced |
| PC2-12 | a raw URL is never an identity: refused before any adapter is asked | resources-resolver.test.js › Common resolver: one authoritative answer from the owner, kind from the owner, scope enforced |
| PC2-13 | revoked, expired or restricted resources are returned as such and are never usable | resources-resolver.test.js › Common resolver: one authoritative answer from the owner, kind from the owner, scope enforced |
| PC2-14 | a legacy V1 Memory stays valid, keeps exactly its V1 shape and is still a READY context | branding-expression-system.test.js › Brand Memory V1.1: expression_system is an additive, optional, governed sixth category |
| PC2-15 | an expression_system is accepted, normalized and valid against the schema | branding-expression-system.test.js › Brand Memory V1.1: expression_system is an additive, optional, governed sixth category |
| PC2-16 | an unknown expression key is refused (anywhere: top level, domain, guideline, override) | branding-expression-system.test.js › Brand Memory V1.1: expression_system is an additive, optional, governed sixth category |
| PC2-17 | guideline lists and texts are bounded | branding-expression-system.test.js › Brand Memory V1.1: expression_system is an additive, optional, governed sixth category |
| PC2-18 | a raw URL / location is refused as a reference and inside a text | branding-expression-system.test.js › Brand Memory V1.1: expression_system is an additive, optional, governed sixth category |
| PC2-19 | no prompt, model, seed or score: as a key or as generation-parameter text | branding-expression-system.test.js › Brand Memory V1.1: expression_system is an additive, optional, governed sixth category |
| PC2-20 | locale overrides: canonical keys only (never silently rewritten), partial, sorted | branding-expression-system.test.js › Brand Memory V1.1: expression_system is an additive, optional, governed sixth category |
| PC2-21 | an override for a locale the brand does not support is refused at the governed boundary (draft; the brand is available) | branding-expression-system.test.js › Brand Memory V1.1: expression_system is an additive, optional, governed sixth category |
| PC2-22 | an expression change is a REVISION: a new Memory version, REVIEW_REQUIRED first, approved by a human, the old one superseded | branding-expression-system.test.js › Brand Memory V1.1: expression_system is an additive, optional, governed sixth category |
| PC2-23 | an approved Memory is immutable (deeply frozen); a revision never mutates it | branding-expression-system.test.js › Brand Memory V1.1: expression_system is an additive, optional, governed sixth category |
| PC2-24 | the exact Core binding is unchanged: a Memory bound to another Core version is still GATED | branding-expression-system.test.js › Brand Memory V1.1: expression_system is an additive, optional, governed sixth category |
| PC2-25 | the creative interface exposes the expression system (and states absence explicitly for a legacy Memory) | branding-expression-system.test.js › Brand Memory V1.1: expression_system is an additive, optional, governed sixth category |
| PC2-26 | the marketing interface does not inherit the visual-expression payload | branding-expression-system.test.js › Brand Memory V1.1: expression_system is an additive, optional, governed sixth category |
| PC2-27 | an absent or empty expression system blocks C2; an approved non-empty one closes only its own dependency | creative-intelligence-pre-c2.test.js › A brand with no expression system is not C2-ready, and nothing fills the gap with a style |
| PC2-28 | no hidden style fallback: the generic source holds no default background, font, composition, mood or photography | creative-intelligence-pre-c2.test.js › A brand with no expression system is not C2-ready, and nothing fills the gap with a style |
| PC2-29 | real font bytes are parsed into real metrics (units per em, ascent, descent, coverage) | creative-intelligence-production.test.js › Real typography: real font bytes, real shaping, real bidi - measured after shaping, never guessed |
| PC2-30 | a stable hash / version identify the exact font file that measured and drew the text (and it loads through the common resolver) | creative-intelligence-production.test.js › Real typography: real font bytes, real shaping, real bidi - measured after shaping, never guessed |
| PC2-31 | Latin shaping applies the font's kerning (GPOS): "AV" is narrower than "A" + "V" | creative-intelligence-production.test.js › Real typography: real font bytes, real shaping, real bidi - measured after shaping, never guessed |
| PC2-32 | Arabic shaping substitutes contextual forms (GSUB): the shaped glyphs are not the nominal glyphs of the characters | creative-intelligence-production.test.js › Real typography: real font bytes, real shaping, real bidi - measured after shaping, never guessed |
| PC2-33 | Arabic joining is correct on the fixture: the same letter takes a different glyph initial / medial / final / isolated | creative-intelligence-production.test.js › Real typography: real font bytes, real shaping, real bidi - measured after shaping, never guessed |
| PC2-34 | bidi reordering follows the Unicode algorithm: an RTL paragraph is laid out right to left, run by run (never a string reversal) | creative-intelligence-production.test.js › Real typography: real font bytes, real shaping, real bidi - measured after shaping, never guessed |
| PC2-35 | mixed Arabic + European digits: the digits keep their left-to-right order inside the right-to-left line | creative-intelligence-production.test.js › Real typography: real font bytes, real shaping, real bidi - measured after shaping, never guessed |
| PC2-36 | mixed Arabic + Latin words | creative-intelligence-production.test.js › Real typography: real font bytes, real shaping, real bidi - measured after shaping, never guessed |
| PC2-37 | mirrored punctuation: in a right-to-left run the brackets take the mirrored glyphs | creative-intelligence-production.test.js › Real typography: real font bytes, real shaping, real bidi - measured after shaping, never guessed |
| PC2-38 | logical START / END resolve against the direction: under RTL, START is the right edge and END the left edge | creative-intelligence-production.test.js › Real typography: real font bytes, real shaping, real bidi - measured after shaping, never guessed |
| PC2-39 | the SHAPED advances decide whether a line fits: one hundredth of a pixel either side of the measured width changes the breaking | creative-intelligence-production.test.js › Real typography: real font bytes, real shaping, real bidi - measured after shaping, never guessed |
| PC2-40 | there is no average-character width: proportional glyphs, no advance table, no default advance, and no such code | creative-intelligence-production.test.js › Real typography: real font bytes, real shaping, real bidi - measured after shaping, never guessed |
| PC2-41 | there is no system-font fallback: a character the font lacks is reported (never substituted), blocks the render and fails the preflight | creative-intelligence-production.test.js › Real typography: real font bytes, real shaping, real bidi - measured after shaping, never guessed |
| PC2-42 | the minimum font size is never crossed: fitting a long text stops at the minimum and reports the overflow | creative-intelligence-production.test.js › Real typography: real font bytes, real shaping, real bidi - measured after shaping, never guessed |
| PC2-43 | the critical text is exact: the glyph projection carries the approved characters and their digest back to the text layer | creative-intelligence-production.test.js › Real typography: real font bytes, real shaping, real bidi - measured after shaping, never guessed |
| PC2-44 | a STRUCTURAL render (unresolved media) is never rasterized | creative-intelligence-production.test.js › Deterministic rasterizer and the real PNG path |
| PC2-45 | a RESOLVED render with real typography rasterizes to a PNG | creative-intelligence-production.test.js › Deterministic rasterizer and the real PNG path |
| PC2-46 | only explicitly resolved media: a symbolic answer, a partial answer or a non-image payload cannot make a production image | creative-intelligence-production.test.js › Deterministic rasterizer and the real PNG path |
| PC2-47 | only explicitly resolved fonts: declared-metrics typography is inspection only, and a missing font stops the render | creative-intelligence-production.test.js › Deterministic rasterizer and the real PNG path |
| PC2-48 | the same inputs give the same SVG bytes | creative-intelligence-production.test.js › Deterministic rasterizer and the real PNG path |
| PC2-49 | the PNG hash is deterministic across repeated renders (and nothing that can vary survives in the file) | creative-intelligence-production.test.js › Deterministic rasterizer and the real PNG path |
| PC2-50 | the PNG dimensions are exactly the canvas | creative-intelligence-production.test.js › Deterministic rasterizer and the real PNG path |
| PC2-51 | no payload ever persists into the DesignDocument (font bytes, image bytes, the PNG) | creative-intelligence-production.test.js › Deterministic rasterizer and the real PNG path |
| PC2-52 | no network access is needed: the whole path runs with fetch and every socket module unavailable | creative-intelligence-production.test.js › Deterministic rasterizer and the real PNG path |
| PC2-53 | the benchmark is configuration data: nothing in the generic source knows the campaign, the merchant or the product | creative-intelligence-pre-c2.test.js › HABB Creative Benchmark 001: configuration data, bound through the common resolver, blocked until every binding is real |
| PC2-54 | as shipped (product, real asset, fonts and the Brand Memory expression system still missing) the benchmark is BLOCKED, never RUNNABLE, and names every missing binding | creative-intelligence-pre-c2.test.js › HABB Creative Benchmark 001: configuration data, bound through the common resolver, blocked until every binding is real |
| PC2-55 | the FORMAT is the one binding that resolves, from the benchmark's own owned record, through the common resolver (platform-level, 1080x1350 px DIGITAL) | creative-intelligence-pre-c2.test.js › HABB Creative Benchmark 001: configuration data, bound through the common resolver, blocked until every binding is real |
| PC2-56 | a missing real asset is never substituted: a generated, synthetic or unapproved asset, or one without bytes, keeps the benchmark blocked | creative-intelligence-pre-c2.test.js › HABB Creative Benchmark 001: configuration data, bound through the common resolver, blocked until every binding is real |
| PC2-57 | claim evidence missing (wording differs, unresolved or revoked) blocks RUNNABLE: nothing approves a claim by itself | creative-intelligence-pre-c2.test.js › HABB Creative Benchmark 001: configuration data, bound through the common resolver, blocked until every binding is real |
| PC2-58 | expression system missing or empty blocks RUNNABLE | creative-intelligence-pre-c2.test.js › HABB Creative Benchmark 001: configuration data, bound through the common resolver, blocked until every binding is real |
| PC2-59 | fonts need a licence reference and bytes; a canvas that is not the expected one blocks | creative-intelligence-pre-c2.test.js › HABB Creative Benchmark 001: configuration data, bound through the common resolver, blocked until every binding is real |
| PC2-60 | RUNNABLE only when every binding is real - and RUNNABLE is not RUN | creative-intelligence-pre-c2.test.js › HABB Creative Benchmark 001: configuration data, bound through the common resolver, blocked until every binding is real |
| PC2-61 | C2 stays blocked until the benchmark has ACTUALLY been run and its gates passed | creative-intelligence-pre-c2.test.js › HABB Creative Benchmark 001: configuration data, bound through the common resolver, blocked until every binding is real |
| PC2-62 | an adapter may only answer for the kinds it declared | resources-resolver.test.js › Common resolver: adapters stay honest, evidence is mandatory, payloads are verified and ephemeral |
| PC2-63 | an ACTIVE resource without an evidence reference is refused (no evidence, no readiness) | resources-resolver.test.js › Common resolver: adapters stay honest, evidence is mandatory, payloads are verified and ephemeral |
| PC2-64 | only FONT and FORMAT may be platform-level | resources-resolver.test.js › Common resolver: adapters stay honest, evidence is mandatory, payloads are verified and ephemeral |
| PC2-65 | an adapter outage is a refusal, never "not found" | resources-resolver.test.js › Common resolver: adapters stay honest, evidence is mandatory, payloads are verified and ephemeral |
| PC2-66 | a payload is checked against the content hash its owner declared | resources-resolver.test.js › Common resolver: adapters stay honest, evidence is mandatory, payloads are verified and ephemeral |
| PC2-67 | only an ASSET or a FONT has a payload | resources-resolver.test.js › Common resolver: adapters stay honest, evidence is mandatory, payloads are verified and ephemeral |
| PC2-68 | the common resolver satisfies the Creative consumer boundary (and resolveIntakeResources) with no adapter | resources-resolver.test.js › Common resolver: adapters stay honest, evidence is mandatory, payloads are verified and ephemeral |
| PC2-69 | provenance carries the adapter, the evidence, the version and the content hash | resources-resolver.test.js › Common resolver: adapters stay honest, evidence is mandatory, payloads are verified and ephemeral |
| PC2-70 | a CLAIM carries its approved wording AND the reference of its approval | resources-resolver.test.js › Common resolver: adapters stay honest, evidence is mandatory, payloads are verified and ephemeral |
| PC2-71 | free metadata (POLICY, PRODUCT...) can never carry a location or a payload | resources-resolver.test.js › Common resolver: adapters stay honest, evidence is mandatory, payloads are verified and ephemeral |
| PC2-72 | FONT and ASSET metadata are strict (hash, version, licence reference; no URL) | resources-resolver.test.js › Common resolver: adapters stay honest, evidence is mandatory, payloads are verified and ephemeral |
| PC2-73 | the resolver core performs no network access and never reads a reference to decide what it names | resources-resolver.test.js › Common resolver: adapters stay honest, evidence is mandatory, payloads are verified and ephemeral |
| PC2-74 | the declared Creative fixtures still work: declared-metrics fonts and the document fixtures are untouched | resources-resolver.test.js › Common resolver: adapters stay honest, evidence is mandatory, payloads are verified and ephemeral |
| PC2-75 | the rasterized ink of each text agrees with the analytic ink of its shaped glyphs (PARITY_TOLERANCE_PX), in LTR and RTL | creative-intelligence-production.test.js › SVG / PNG parity: the pixels land where the layout says, within a documented tolerance |
| PC2-76 | with real fonts the demo is laid out, preflight is measurable (no NOT_MEASURABLE for text) and passes, and the PNG renders | creative-intelligence-production.test.js › The full production path on the demo: layout, preflight, glyph render, PNG - measurable and green |
| PC2-77 | each verification issues registered evidence for ITS dependency, and assessCreativeC2Readiness accepts nothing else | creative-intelligence-pre-c2.test.js › PRE-C2 verifications run real checks and issue the only evidence that closes a dependency |
| PC2-78 | explicit sRGB (cHRM + gAMA + sRGB perceptual) before IDAT; no timestamp, text, ICC or physical-size chunk; repeated renders are byte-identical | creative-intelligence-colorspace.test.js › PNG colour semantics: explicit deterministic sRGB, no variable metadata, pixels untouched |
| PC2-79 | the inventory lists exactly the committed font files; each hash matches; each notice file exists and carries its licence text | creative-intelligence-colorspace.test.js › Font fixtures: every committed font file has its source, exact licence, notice and content hash |
| PC2-80 | opaque brand hex colours come out of the rasterizer unchanged: tolerance 0 per channel | creative-intelligence-colorspace.test.js › Brand colours survive rasterization exactly |
| PC2-81 | exact package, licence, upstream source, source-availability mechanism, notice, modification status | creative-intelligence-colorspace.test.js › THIRD_PARTY_NOTICES records the MPL-2.0 obligations of resvg exactly |
<!-- coverage-matrix:end -->
