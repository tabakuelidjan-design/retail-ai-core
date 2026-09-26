# Nordla Growth — Growth Overview

Run locally: `npm run growth` → http://127.0.0.1:4413 (loopback only, no hosted mode, no access-token layer yet).

Reference captures (demonstration data, FR): `growth-overview-desktop-1440.png`, `growth-overview-mobile-375.png`.

## Architecture
Finance, Analytics and Growth are **separate Nordla modules**, each usable and sellable on its own. Each keeps its own
navigation; they share the Nordla design system and reuse compatible components. Growth does not depend on Finance or
Analytics to work: it imports none of their code and calls none of their services. It only reads, as static files,
the shared design-system files (`src/shared`) and Analytics' stylesheet/tokens/i18n runtime (see "Reuse").

## Scope
Only **Growth Overview** is built. No other Growth page exists yet.

## Navigation (Growth's own)
- Rail: Overview · Opportunities · Campaigns · Content · Store Growth · Audience · Experiments — then, in the bottom
  zone: Nordla AI · Settings. Only Overview is active; the others are disabled ("Bientôt disponible"), never dead links.
- Mobile bottom bar (5 slots, same density as Analytics): Overview · Opportunities · Campaigns · Content · Nordla AI.
  Store Growth, Audience, Experiments and Settings are desktop-only while they are not built; when they are, the bar
  will need a "More" entry (Finance's pattern).
- Approvals and Decision Ledger are not exposed; they may be added later as dedicated pages.

## Reuse (no new visual system)
- Analytics `style.css`, `nordla-tokens.css`, `i18n.js` served **as-is** (byte-identical, tested). `growth.css` only
  adds namespaced `.gr-*` layout/list details.
- Charts: `NordlaCharts.trendLines` / `trendLine` / `sparkline` / `head` (same axes, tooltips, responsive redraw).
- Icons: `NordlaIcon` only. The Growth Icons v1 pack is pixel-identical to existing official icons: no file added.

## Temporary items (to be replaced by official assets supplied separately)
**TEMP_ICON** (marked in `src/growth/ui/app.js`) — five concepts have no usable official icon: the pack points them to
exports `NordlaIcon.DEFECTIVE` blocks (`official-icons/DEFECTS.md`). Temporary borrowings, not decisions:

| Concept | Temporary icon |
|---|---|
| Opportunities | `produitEnHausse` |
| Campaigns | `nouveauClient` |
| Experiments | `synchronisation` |
| AI Insights | Parle à Nordla asset |
| Needs Attention | `aFaire` |

When the re-exports arrive: add them to `NordlaIcon.ICONS`, point the `TEMP_ICON` entries to them.

**PLACEHOLDER channel logos** — `CHANNEL_LOGOS` (app.js) maps a channel id to an official logo file in
`src/growth/ui/assets/channels/` (served at `/growth-assets/channels/<file>`). All entries are `null`, so monograms
G, IG, TT, FB, GB are shown. Nothing is downloaded or redrawn.

**PLACEHOLDER content thumbnails** — neutral swatch + channel mark until the data source provides real thumbnails.

## Data
All figures come from `src/growth/server/demo-overview.js` (`demo: true`, badge "Données de démonstration"). The UI
holds no demo value (names, amounts, currency, dates and texts come from the payload; the data names row *kinds*, never
icons — enforced by a test). Replacing the source = returning the same payload shape from a real builder.

## Accepted duplication / debt (phase decision: Finance and Analytics are frozen, no shared refactor now)
- Growth serves Analytics' `style.css` directly: a later Analytics CSS change also applies to Growth.
- Small helpers are copied from Analytics' UI (`h()`, arrows, formatters, top bar, language switch), because Analytics'
  `app.js` starts itself on load and cannot be imported.
- Two CSS overrides depend on Analytics internals: the Explorer table column rule (`.gr-table`) and the mobile top bar
  ordering (`.gr-demo`).
- Some `gr.*` translations repeat Analytics wording (e.g. "vs période précédente").
- Row kind → icon mapping lives in the UI: a new kind needs a UI entry.
- Some tests read `app.js` as text (navigation and marker checks).
- No extraction to `src/shared` in this phase.
