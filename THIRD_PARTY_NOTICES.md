# Third-party notices

Inventory of third-party software and fonts whose licence imposes a notice or source obligation. Only items with such an obligation are listed
here; the other npm dependencies keep their own `license` field. Update this file whenever such a dependency is added, upgraded or modified.

## Production dependencies added by PRE-C2 (Creative Intelligence)

| Package | Version | Licence | Purpose | Upstream |
|---|---|---|---|---|
| `harfbuzzjs` | 1.6.3 | MIT | text shaping (HarfBuzz compiled to WASM) | https://github.com/harfbuzz/harfbuzzjs |
| `bidi-js` | 1.1.0 | MIT | Unicode bidirectional algorithm | https://github.com/lojjic/bidi-js |
| `@resvg/resvg-js` | 2.6.2 | **MPL-2.0** | SVG → PNG rasterizer (native prebuilt binary per platform: `@resvg/resvg-js-<platform>`, same version) | https://github.com/yisibl/resvg-js |

MIT notices: the licence text ships inside each package in `node_modules` and must be kept with any redistribution.

### `@resvg/resvg-js` 2.6.2 — MPL-2.0

- **Licence:** Mozilla Public License 2.0 (https://www.mozilla.org/MPL/2.0/). The licence text ships in `node_modules/@resvg/resvg-js/LICENSE`.
- **Nature:** MPL-2.0 is **file-level** copyleft. Using or linking resvg does **not** make Nordla's proprietary source MPL-licensed; only the
  MPL-covered files (resvg-js and the resvg crates it is built from) stay under MPL-2.0.
- **Nordla modifies covered files: NO.** Nordla uses the published npm package and its prebuilt platform binary as a dependency. Nothing from
  resvg is copied, patched or vendored in this repository.
- **Upstream source:** https://github.com/yisibl/resvg-js at the tag of version 2.6.2; the resvg crate versions it is built from are pinned in
  that tag's `Cargo.lock` and published on crates.io.
- **Distribution (MPL-2.0 §3.2):** if an executable form containing this software is *distributed* (for example a container image, installer or
  bundle handed to a third party), the source form of the MPL-covered software must be made available, with a notice of where to obtain it.
  Source availability mechanism: the upstream repository and tag above (unmodified, so upstream is the exact corresponding source); a
  distribution must repeat this notice and the link. Nordla currently runs the software on its own servers only, which is not a distribution to
  third parties; re-assess before shipping an image or desktop bundle.
- **If Nordla ever modifies a covered file,** the modified files must be published under MPL-2.0 (and listed here) before such a build is distributed.
- **Notice:** the MPL-2.0 licence text and this section accompany any distribution that includes the binary.

## Test fixtures (fonts; never shipped in a build)

Inventory with source, licence and hash: `test/fixtures/fonts/FONTS.json` (checked by a test). Licence texts sit beside the files.

| File | Licence | Notice file |
|---|---|---|
| `DejaVuSans.ttf` (DejaVu Sans 2.37) | Bitstream Vera Fonts licence (SPDX `Bitstream-Vera`) with DejaVu public-domain changes and Arev (Tavmjong Bah) terms | `test/fixtures/fonts/LICENSE-DejaVu.txt` |
| `NotoNaskhArabic_400Regular.ttf` (Noto Naskh Arabic 2.021) | SIL Open Font License 1.1 (`OFL-1.1`), Noto Project Authors | `test/fixtures/fonts/LICENSE-NotoNaskhArabic-OFL.txt` |

## Production fonts for Benchmark 001 (shipped with the repository; open fonts, not proprietary)

Open font resources selected for the benchmark. Bytes, pinned hashes and licence texts: `resources/fonts/habb-benchmark/` (`manifest.json`, checked by a test).
Both come from one pinned upstream commit of https://github.com/google/fonts (`51303ca9e8ac9dcea7b12d307ba568fd0e6fcfca`, never a moving branch), are unmodified,
and are licensed under the **SIL Open Font License, Version 1.1** (`OFL-1.1`). The OFL texts are kept beside the fonts and must accompany any redistribution of the font files.

| Family | File (upstream path) | Copyright (OFL notice) | Font SHA-256 | Licence-text SHA-256 |
|---|---|---|---|---|
| Playfair Display (variable `wght` 400-900, v1.203) | `PlayfairDisplay[wght].ttf` (`ofl/playfairdisplay/`) | Copyright 2017 The Playfair Display Project Authors (https://github.com/clauseggers/Playfair-Display), with Reserved Font Name "Playfair Display" | `c40f2293766a503bc70cce9e512ef844a4ccb7cbcde792fe2ea31d191917d8d6` | `566be814f8e96e93dfa16101331557eb6b5467e9e03f627c0910fe93ca12300e` |
| Montserrat (variable `wght` 100-900, v9.000) | `Montserrat[wght].ttf` (`ofl/montserrat/`) | Copyright 2024 The Montserrat.Git Project Authors (https://github.com/JulietaUla/Montserrat.git) | `0f7b311b2f3279e4eef9b2f968bcdbab6e28f4daeb1f049f4f278a902bcd82f7` | `8b7141c03fa4f8d44e6345d5d4931709290f0f67875e452e95ac1fd3a027802e` |

OFL obligations observed: the fonts are not sold on their own, the copyright and licence notice travel with them, and the files are not modified or renamed (a Reserved Font Name applies to Playfair Display).
Weights are selected at render time as instances of the variable fonts; no derived font file is created.
