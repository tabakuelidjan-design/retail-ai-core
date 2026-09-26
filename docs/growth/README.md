# Nordla Growth

Run locally: `npm run growth` → http://127.0.0.1:4413 (loopback only, no hosted mode, no access-token layer yet).

Reference captures (demonstration data, FR): `growth-overview-desktop-1440.png`, `growth-overview-mobile-375.png`.

## Architecture
Finance, Analytics and Growth are **separate Nordla modules**, each usable and sellable on its own. Each keeps its own
navigation; they share the Nordla design system and reuse compatible components. Growth does not depend on Finance or
Analytics to work: it imports none of their code and calls none of their services. It only reads, as static files,
the shared design-system files (`src/shared`) and Analytics' stylesheet/tokens/i18n runtime (see "Reuse").

## Scope
Built: **Growth Overview** (`#/`) and **Opportunités** (`#/opportunities`). Campaigns, Content, Store Growth, Audience and
Experiments are not started.

## Navigation (Growth's own)
- Rail: Overview · Opportunities · Campaigns · Content · Store Growth · Audience · Experiments — then, in the bottom
  zone: Nordla AI · Settings. Overview and Opportunities are links (the current one is active); the others are disabled
  ("Bientôt disponible"), never dead links. Routing is internal to Growth (hash routes, one payload per page, cached).
- Mobile bottom bar (5 slots, same density as Analytics): Overview · Opportunities · Campaigns · Content · Nordla AI.
  Store Growth, Audience, Experiments and Settings are desktop-only while they are not built; when they are, the bar
  will need a "More" entry (Finance's pattern).
- Approvals and Decision Ledger are not exposed; they may be added later as dedicated pages.

## Reuse (no new visual system)
- Analytics `style.css`, `nordla-tokens.css`, `i18n.js` served **as-is** (byte-identical, tested). `growth.css` only
  adds namespaced `.gr-*` layout/list details.
- Charts: `NordlaCharts.trendLines` / `trendLine` / `sparkline` / `head` (same axes, tooltips, responsive redraw).
- Icons: the Growth pack (final) for Growth concepts, `NordlaIcon` for generic business concepts (see "Icons").

## Icons
- **Nordla Growth Icon Pack (final)** — `src/growth/ui/assets/icons/`, served at `/growth-assets/icons/`. The 11 files used
  are transparent 256px exports of the supplied 1254px originals (downscaled only: not redrawn, recoloured or cropped;
  settings, approvals, audience, store-growth, content and growth-overview come from the transparent re-exports). Unused:
  `nordla-ai.png` (the rail keeps the official "Parle à Nordla" asset, as in Analytics), `decision-ledger.png` (no page yet).
- The five former `TEMP_ICON`s are gone: Opportunities, Campaigns, Experiments, AI Insights, Needs Attention use their own
  pack icons, on Overview too.
- Every Growth icon file is an RGBA PNG with a transparent background (tested); no blend-mode workaround.
- Generic business concepts (revenue, stock, segments, trophies…) keep the shared official Nordla icons.
- **Channel logos** — Google Search, Google Business, Instagram, TikTok, Facebook: 128px transparent exports of the v2
  pack's `channels/`, in `src/growth/ui/assets/channels/`, wired through `CHANNEL_LOGOS` (monograms remain only as a
  load-failure fallback). The pack notes they are reference renders; swap in each platform's official brand files before
  a public release if its brand rules require it.

## Placeholders still present

**PLACEHOLDER content thumbnails** — neutral swatch + channel mark until the data source provides real thumbnails.

## Data
All figures are demonstration data: `src/growth/server/demo-overview.js` and `demo-opportunities.js` (`demo: true`, badge
"Données de démonstration"). On Opportunités every KPI is computed from the pipeline rows (tested), so the page cannot
contradict itself. The UI holds no demo value (names, amounts, currency, dates and texts come from the payload; the data names row *kinds*, never
icons — enforced by a test). Replacing the source = returning the same payload shape from a real builder.

## Known demo-data gaps
- Opportunités: with the six pipeline rows given in the brief (12 500 €) and 12 active opportunities, the potential revenue
  is 14 800 €, not 12 800 € (derived, not typed).
- Opportunités: "Nécessite votre approbation" lists the three rows in status "Prête à approuver" (Trafic magasin, Offre
  étudiants, Bundle coque + support); "Upsell boîte cadeau" is "En cours" in the pipeline, so it is not awaiting approval.
- Overview and Opportunités demo sets are independent (e.g. Overview's top opportunities and figures differ). To align
  when the real engine feeds both pages.

## Accepted duplication / debt (phase decision: Finance and Analytics are frozen, no shared refactor now)
- Growth serves Analytics' `style.css` directly: a later Analytics CSS change also applies to Growth.
- Small helpers are copied from Analytics' UI (`h()`, arrows, formatters, top bar, language switch), because Analytics'
  `app.js` starts itself on load and cannot be imported.
- Two CSS overrides depend on Analytics internals: the Explorer table column rule (`.gr-table`) and the mobile top bar
  ordering (`.gr-demo`).
- Some `gr.*` translations repeat Analytics wording (e.g. "vs période précédente").
- Row kind → icon mapping lives in the UI: a new kind needs a UI entry.
- Some tests read `app.js` as text (navigation and marker checks); the page render test uses a minimal fake DOM.
- Growth's `h()` helper diverges slightly from Analytics' (ignores a `null` class).
- No extraction to `src/shared` in this phase.
