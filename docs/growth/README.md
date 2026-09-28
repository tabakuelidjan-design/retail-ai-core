# Nordla Growth — « Développement des ventes »

Run locally: `npm run growth` → http://127.0.0.1:4413 (loopback only, no hosted mode, no access-token layer yet).

Status (2026-09-28): **internal beta for HABB**, not for sale. HABB's current volume produces no commercial recommendation
reliable enough; the module must not be sold with the promise of « opportunités de croissance mesurables ».

## Promise shown to the customer
> Nordla vérifie la qualité de vos fiches produit et de vos données, vous indique quoi corriger en premier et vous signalera
> les produits ou moments à pousser dès que les ventes et les coûts d’achat seront suffisamment fiables.

Not promised (and tested as absent from the interface): measurable growth, causality, a guaranteed sales increase,
advertising actions, automated campaigns.

## Scope
Built (6 pages): **Vue d'ensemble** (`#/`), **Opportunités** (`#/opportunities`), **Produits Potentiels** (`#/potential`),
**Audience** (`#/audience`), **Contenu** (`#/content`), **Croissance magasin** (`#/storeGrowth`). Every page shows real data
or an honest state (« Source non connectée », « Données insuffisantes »). There is **no demonstration data** anywhere.

- **Campagnes** is out of the launch scope (removed 2026-09-28: no advertising connector, all its figures were demonstration
  data). No menu entry, no route, no script, no endpoint; a former `#/campaigns` link shows Vue d'ensemble. The previous work
  is in the Git history (last commit with it: `225a4eb`). See « Feuille de route ».
- **Expériences** is not in the product (see « Feuille de route »). **Nordla AI** and **Paramètres** are disabled menu entries
  only (« Bientôt disponible », no page, no route, no API).
- **No action button that performs no action** (owner rule 2026-09-28): the former disabled « Créer une opportunité »,
  « Approuver », « Nouvelle campagne », « Améliorer ce produit », « + Nouveau segment » and the action menus are removed. What
  remains works: navigation, filters, sort, search, detail panels, language, « Réessayer », and links to the source pages.

## Opportunités (priorities)
`src/growth/priorities/priorities.js` (pure) aggregates the payloads of the four real engines; `src/growth/server/priorities.js`
calls the existing engine sources (tenant-scoped, read-only) and recomputes the priorities on every request. Nothing is
stored, no threshold is read, changed or invented: every status comes from an engine.

Three sections:
1. **À corriger maintenant** — reliable data problems, **grouped by problem** (one row for 126 products without SKU, never 126
   rows): missing SKU / product type / alt text / image / collection / duplicate title (Contenu), and **purchase costs missing
   or not verified** (Produits Potentiels). Each group: count, why it weakens or blocks the recommendations, a few examples
   (sold products first), link to the source page.
2. **Opportunités commerciales** — only what an engine validated with its existing thresholds: Produits Potentiels « À pousser »
   / « Réassort avant promotion », Audience segments flagged as an opportunity, a strong weekday of Croissance magasin. May be
   empty: then the page says what Nordla waits for (more sales per product, verified costs, identified customers, store
   history, online orders), read from the engines' own states.
3. **À surveiller** — signals too weak, or blocked by a guard. **One card per product**: what several engines say about the same
   product (sales status, store rank or suggestion, cost, listing) is merged into that card's findings, with the observed
   volume, why Nordla does not recommend acting yet, and what is missing.

Guard rule: a product is a commercial opportunity only when Produits Potentiels classifies it « À pousser » or « Réassort avant
promotion » (all its guards passed). A store highlight on a product with only a « Top vente » / « Stable » status (e.g. 4 sales
in 8 weeks) stays in « À surveiller ». The store's best seller kept out of the highlight by a guard is explained on its own card.

Contract (per item): stable `id` (`fix:purchase-cost`, `fix:content:<problem>`, `product:<id>`, `store:weekday:<n>`,
`audience:segment:<key>`), `category`, `title` / `explanation` (codes + params, translated in the UI), numeric `evidence`,
`reliability` (`reliable` / `limited`), `entity`, `sourcePage`, `rankReason`, `dataBlocker`; product cards add `findings`,
`missing`, `relatedPages`. The stable ids let a later status (to do / done / dismissed) attach without breaking existing items.

Vue d'ensemble shows the same priorities (counts, first correction groups, commercial opportunities) and the real store sales
of Croissance magasin; everything no engine produces stays « Source non connectée ».

## Dependencies still to be treated elsewhere (not in Développement des ventes)
- **Purchase-cost verification** — Produits Potentiels only recommends « À pousser » and reports « Marge faible » on a verified
  cost. Today every cost comes from Shopify with `validation_status = 'unverified'` and **no code path can verify it**. Cost
  verification belongs to a future shared capability (Core, Finances or Achats & Fournisseurs); this module only shows the
  blocker and must never edit or auto-verify costs.
- **Identity and sessions (Core)** — required before any persistent status (à faire / fait / écarté), human validation,
  measurement after an action, database write or Shopify action.
- **Authentication, hosting, permissions** — Core prerequisites for any public release (the server binds to loopback only).

## Feuille de route (reportée, non planifiée)
- Statuses on priorities (à faire / fait / écarté), persistent human validation, observation 4 weeks after an action — after
  Core identity and sessions; the stable ids are ready.
- **Campagnes** — rebuild only once a real advertising connector (Meta, Google Ads) exists.
- Merchant-configurable thresholds and windows (small shops) — after the first customer feedback, never by lowering a guard.
- Shopify actions (e.g. a discount from a priority) — after Core, with human approval, never automatic.
- **Expériences** — idée future, non prioritaire; aucun code, aucune route, aucun écran, aucune entrée de menu.

## Architecture
Finance, Analytics and Growth are **separate Nordla modules**, each usable and sellable on its own. Growth imports none of
Finance's or Analytics' code and calls none of their services. It only reads, as static files, the shared design-system files
(`src/shared`) and Analytics' stylesheet/tokens/i18n runtime (see « Reuse »). Finance, Analytics and `src/shared` are frozen
(tested: `test/frozen-modules.js`).

## Navigation
- Rail: Vue d'ensemble · Opportunités · Produits Potentiels · Contenu · Croissance magasin · Audience — then Nordla AI ·
  Paramètres (disabled). Routing is internal (hash routes, one payload per page, cached).
- Mobile bottom bar: Vue d'ensemble · Opportunités · Produits Potentiels · Contenu · Audience · Plus; « Plus » holds Croissance
  magasin and the two disabled entries.

## Reuse (no new visual system)
- Analytics `style.css`, `nordla-tokens.css`, `i18n.js` served **as-is** (byte-identical, tested). `growth.css` only adds
  namespaced `.gr-*` layout/list details (Opportunités: `.gr-pr-*`, `.gr-op-link`).
- Charts: `NordlaCharts` components only. Icons: the Growth pack for Growth concepts, `NordlaIcon` for generic concepts.
- Every Growth icon file is an RGBA PNG with a transparent background (tested).

## Missing icons (Nordla style, to request from the owner)
- **« À surveiller »** (section title and KPI tile on Opportunités / Vue d'ensemble): no dedicated icon exists; the title is
  shown without an icon until one is supplied (square transparent PNG 1254px, navy + coral, Nordla pack style).

## Tests
Synthetic data only (never the real database): `test/growth-priorities.test.js` (aggregator + read-only source),
`test/growth-opportunities.test.js` (page), `test/growth-launch-scope.test.js` (no Campagnes, no demo, no fictive button,
honest promise), `test/growth-overview.test.js`, the page tests, and `test/growth-browser.test.js` (headless Chrome:
1440 / 1280 / 1024 / 768 / 390 / 375 / 320 px, no horizontal overflow). `GROWTH_DEEP_AUDIT.md` is the historical audit of the
earlier (demonstration) version.

## Accepted duplication / debt (Finance and Analytics are frozen, no shared refactor now)
- Growth serves Analytics' `style.css` directly: a later Analytics CSS change also applies to Growth.
- Small helpers are copied from Analytics' UI (`h()`, arrows, formatters, top bar, language switch), because Analytics'
  `app.js` starts itself on load and cannot be imported.
- Some tests read the UI sources as text; page render tests use a minimal fake DOM (`test/growth-dom.js`).
- Unused Growth pack files and channel logos stay on disk (not referenced by any page).
- No extraction to `src/shared` in this phase.
