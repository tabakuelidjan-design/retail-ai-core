# Finance module — testing checklist

State at freeze: branch `feature/finance-operations`, commit `02f1d07`. Steps 1–8 of the
index(4).html alignment mandate are done (design tokens, subpage typography, Achats, Banque &
Caisse, Ventes, Contacts, Trésorerie). Step 10 (shared-component consolidation) is deliberately
deferred — see "Deferred technical cleanup" at the end of this file. Full automated suite: 539/539.

This checklist is for manual/exploratory testing before any further refactor. It does not replace
the automated suite (`npm test`), it targets what that suite can't see: real browser behaviour,
visual regressions, and end-to-end flows across pages.

---

## Accueil

**Main flows**
- Load the dashboard as the demo merchant; all 4 KPI cards populate (Chiffre d'affaires, Dépenses,
  Solde de trésorerie, Factures en attente).
- Click through each KPI card's `›` link and confirm it lands on the right page/filtered view.
- Treasury chart renders with real monthly bars + cumulative balance line.
- "Activité récente" list shows the latest real events; "Tout voir" navigates correctly.
- Bank accounts card: with no bank connected, shows the real empty state and "Connecter une
  banque" CTA (not a fake account).
- Client invoice card and expense donut both reflect real data, with "Ce mois-ci"/"Depuis le
  début" toggle where present.

**Expected result**: every figure on this page is traceable to a real document/transaction; no
placeholder numbers, no demo-only content visible to a real merchant.

**Edge cases**
- Empty state: brand-new merchant with zero documents — every card should show its dedicated empty
  state, not a zero rendered as if it were real data.
- Multiple currencies present (if applicable) — dashboard should not silently sum incompatible
  currencies.
- Bank connected vs. not connected — card content and CTA must differ correctly.

**Known intentional limitation**: this page is structurally frozen for this cycle — only shared
token/typography/spacing changes were allowed, no new features. Do not expect anything beyond what
already exists.

---

## À faire

**Main flows**
- Action Center lists real actions (`/api/actions`); each row's CTA navigates to the right
  document/page.
- Metric cards (À traiter / Urgent / À vérifier / Informatif) match the actual counts below.
- Tone breakdown bar segments are proportional to the real counts.
- Clicking a row opens/selects it; "Recommended action" detail panel on the right shows the
  top-priority action with its real amount (money-strip) when the action carries one.
- Empty state: "Nothing needs your attention" when the action list is empty.

**Expected result**: two-column master-detail layout, real tone-colored priority list, real amount
context inline in the row text where applicable.

**Edge cases**
- Many actions of the same tone (e.g. several `bad` items) — list should not visually collapse or
  overflow.
- An action with no amount (e.g. "settings incomplete") — row and detail panel must render cleanly
  without a stray "undefined"/empty money-strip.
- Very long action text (long supplier/customer names) — no horizontal overflow.

**Known intentional limitations**:
- No "Tout marquer comme vu" — there is no seen/unseen persistence in the data model; do not expect
  a mark-all-as-read control.
- No due-date grouping ("today/tomorrow/this week") — the data model has no per-action due date to
  group by honestly.

---

## Ventes

**Main flows**
- Tabs: Factures / Devis / Avoirs / Analytique all load real rows.
- Real filters: État, Client, date range (Période) — each actually filters the visible table, not
  just decorative.
- Row selection opens the detail panel: Total TTC / Payé / Reste dû, due date, and (when
  applicable) "Encaisser" (payment modal) and "Créer un avoir" (credit note) actions.
- "Exporter" downloads a CSV matching the currently filtered/visible rows.
- Search box filters by number/customer name.
- Analytique tab: product/SKU search + period picker both work and reflect real sales data.

**Expected result**: filters are AND-combinable and always reflect the real dataset; detail panel
actions actually call the real payment/credit-note endpoints (verify a test payment/credit note is
recorded, not just visually accepted).

**Edge cases**
- Filter combination that matches zero rows — proper "no results" state, not a blank table.
- An invoice fully paid — "Encaisser" should not be offered (or should reflect zero remaining).
- A credit note issued against an invoice — remaining/paid figures update correctly afterward.
- Multi-currency invoices, if present, must not be summed together in the export or detail totals.

**Known intentional limitations**: no Peppol filter, no "Affichage" filter, no "Relancer" (payment
reminder) button — none of these have a real backend capability yet; they are intentionally
omitted rather than faked.

---

## Achats

**Main flows**
- 3-pane workspace: queue (left) / document preview (center) / validation form (right).
- Tabs: À traiter / À payer / Payés / Analytique.
- Selecting a queue row loads its real source document in the center pane (PDF/image inline, or an
  honest "preview not available" fallback — never a fabricated preview).
- Right pane: Validate / Reject / Pay / Save, and Link/Unlink contact (search by name or VAT).
- "Importer" opens the real upload modal (drag/drop + file picker) and the uploaded document
  appears in the queue.
- "+ Ajouter manuellement" still creates a manual entry.
- Search + supplier/invoice-number/date/amount/status filters actually filter the queue.

**Expected result**: the 3 panes stay in sync — selecting a row always updates both the preview and
the form pane; validating/rejecting/paying a document removes it from its current tab and it
reappears in the correct one.

**Edge cases**
- A document with no source file — center pane shows "This entry has no source document." rather
  than an error or a blank frame.
- An unsupported file type for preview (e.g. a non-PDF/image) — honest fallback message, not a
  broken embed.
- Reject requires a reason — confirm the UI actually enforces this before submitting.
- Linking a contact that doesn't exist yet vs. one that does — search should only ever show real
  matches, never invent one.
- **Tablet width (~1024px) regression check**: the validation form pane must stay reachable and
  usable — this was a fixed bug (the doc preview hides, not the form pane).

**Known intentional limitation**: none identified beyond the general no-fake-data rule — this page
implements the full P0 scope from the mandate.

---

## Banque & Caisse

**Main flows**
- Ledger tabs: À justifier / Toutes / Entrées / Sorties / Justifiées.
- Real search (label/amount/reference) and opt-in date-range filter (defaults to empty — must not
  hide real transactions by default).
- Day-grouped transaction list; selecting a transaction loads its real detail on the right (amount,
  date/time, source, reference, current reconciliation status).
- Match suggestion (if any) is shown with Justifier / choose another match / Ignore.
- Connect bank / Sync / Disconnect / Import CSV / Cash count controls still work exactly as before.

**Expected result**: ledger reflects only real `/api/bank/transactions` data; justify/ignore
actions actually change a transaction's status and move it between tabs correctly.

**Edge cases**
- A transaction with no suggestion available — right pane shows the honest "no suggestion yet"
  message, not an empty crash.
- A transaction already justified — re-opening it should not offer "Justifier" again as if it were
  still pending.
- Cash count / cash movements entered — "Espèces" balance on this page and on Accueil should agree.
- No bank connected at all — page should show the disconnected state cleanly, not throw.

**Known intentional limitation**: no "Compte" (per-account) filter — not implemented because
there's no real reliable per-account attribution to filter by yet.

---

## Contacts

**Main flows**
- Tabs: Tous / Clients / Fournisseurs / Les deux / À compléter / Archivés.
- Sort dropdown (Nom / Montant à recevoir / Montant à payer / Dernière activité) actually reorders
  the real rows.
- "Exporter" downloads a CSV of the currently visible rows.
- Opening a contact shows the drawer: financial strip, résumé, documents, informations, notes tabs
  (client-side, over already-loaded real data).
- Archive / Restore buttons in the drawer actually move a contact in/out of the Archivés tab.
- The "Overdue" figure, where present, is a real link into Ventes pre-filtered by that customer.
- "+ Create"/"Edit" still open the real contact form (no isCustomer/isSupplier checkbox — roles
  stay derived).

**Expected result**: Archivés tab shows only archived contacts with its own distinct empty state
("Aucun contact archivé.") — never confused with the "no contacts at all" onboarding state or with
"no results for this search."

**Edge cases**
- Archiving a contact that has open invoices/payables — confirm the app doesn't silently hide money
  owed; check what the drawer/list communicates in that case.
- Restoring a contact — it must reappear correctly in its original role tab (Client/Fournisseur/Les
  deux), not just in "Tous."
- Search combined with the Archivés tab — should filter within archived contacts, not fall back to
  all contacts.
- **Network-call regression check**: opening/reloading the Contacts list should issue exactly the
  expected calls (`GET /api/contacts`, `GET /api/contacts?role=archived`) in parallel — never a
  per-row call inside a table render.

**Known intentional limitation**: no "Import" button — there is no real backend import capability
for contacts yet, so none is offered.

---

## Trésorerie

**Main flows**
- 30 / 60 / 90-day horizon toggle — clicking each option re-fetches and visibly updates: "À
  recevoir/à payer sous {N} jours" labels, the amounts, and the projection panel's expected
  in/out figures.
- 4 metric cards (Disponible aujourd'hui / À recevoir / À payer / Projection) match the projection
  panel's own numbers for the same horizon.
- 12-month realised-flow chart (Entrées/Sorties/Solde cumulé) is present and does NOT change when
  the horizon toggle is clicked.
- Warnings banner appears when no bank balance / no cash count is available.
- "VAT is not provisioned here" note always present in the projection panel.

**Expected result**: only `/api/treasury?horizon=N` is re-fetched on a horizon click — verify via
devtools/network tab that `/api/overview/cashflow` is NOT re-fetched.

**Edge cases**
- No bank connected AND no cash count confirmed — "Disponible aujourd'hui" shows "—", not "0,00".
- Switching horizon back and forth quickly — no stale/out-of-order responses overwriting a newer
  selection (a race-condition check).
- A payable due exactly on the horizon boundary date — confirm it's included per the same rule as
  the metric cards (`dueDate <= horizonEnd`).

**Known intentional limitation**: no VAT projection figure — deliberately not shown here; the
Accountant Pack (`#/pack`) remains the sole source for the authoritative per-period VAT number.

---

## Desktop testing

- Verify all 7 pages at **1920px** (or your widest common monitor), **1440px**, and **1280×720**.
- No horizontal scroll on the page body at any of these widths.
- Cards/tables/master-detail panes keep sensible proportions — nothing looks squeezed or
  disproportionately empty.
- Hover states on rows, buttons, and tabs are visible and consistent across pages.

## Mobile testing

- Verify all 7 pages at **390×844** (or your team's baseline phone size) and **768px** (tablet).
- No horizontal scroll on any page.
- Achats' 3-pane workspace and Banque's master-detail must degrade to a usable single-column flow
  at tablet width — the validation form (Achats) and transaction detail (Banque) must both stay
  reachable, not just the list.
- Mobile nav (icon strip) reaches all 7 pages.
- Tables that don't fit the viewport scroll horizontally **inside their own card**, not the whole
  page.

## Permission / security checks

- Confirm the app clearly marks the bank connection as **read-only** ("Lecture seule : aucun
  paiement ne peut être initié.") wherever it's shown.
- Attempt mutating actions (justify/ignore a transaction, archive/restore a contact, validate/pay a
  supplier invoice, disconnect bank, confirm a cash count) as a non-merchant actor if your test
  environment supports simulating one — each should be rejected server-side
  (`THIS_STEP_REQUIRES_A_MERCHANT_ACTOR`), not just hidden client-side.
- Confirm no financial credentials, IBANs (beyond the masked display), or tokens ever appear
  unmasked in the UI or in exported CSVs.
- Confirm session/auth expiry (e.g. after a server restart) is handled with a clean re-login, not a
  silent broken state — a stale session should not appear to "work" with wrong/empty data.

## Regression checks

- Re-run the full automated suite: `npm test` — expect **539/539** passing. Any new failure blocks
  sign-off.
- Homepage (Accueil) must show **no structural change** — same 4 KPI cards, same chart, same recent
  activity/invoice/bank/expense card layout as before this cycle.
- Achats must still work exactly as validated when it was completed — re-check the tablet-width
  fix (validation pane reachable at ~1024px) hasn't regressed.
- Language switch (FR/NL/EN if enabled) — spot-check each of the 7 pages in at least French and one
  other language; no raw English key should leak into the FR/NL UI.
- Currency formatting (symbol placement) — spot-check FR vs. NL vs. EN money formatting matches the
  existing convention on at least Ventes and Trésorerie.

## Data integrity checks

- No fabricated bank accounts, balances, invoices, contacts, or Peppol states appear anywhere —
  every figure must trace to a real document, transaction, or setting.
- Sparse/empty real data renders as a polished empty state, never as an invented placeholder row.
- Exported CSVs (Ventes, Achats, Contacts) contain only real, currently-visible rows — cross-check
  row count and a couple of values against what's on screen.
- Archiving/restoring a contact and validating/paying a supplier invoice must be reflected
  immediately and consistently across every page that surfaces that same data (e.g. Accueil's
  "Factures en attente" count after paying a supplier invoice, Contacts' overdue link after an
  invoice is settled).
- Treasury horizon change must never alter the underlying documents — it only changes which real
  documents are counted within the window, never their amounts.

---

## Deferred technical cleanup

Not part of this testing cycle. To be scheduled as a separate, explicitly-approved task after
Finance testing concludes:

- **Step 10 — shared-component consolidation**: identify and merge the by-now-duplicated CSS/JS
  patterns across pages (subpage hero, metric card, workspace card, tabs, tool buttons, search
  field, master list, selected-row state, detail inspector, money strip, status badges, empty
  state) into single shared components instead of growing page-specific overrides further.
- Branch divergence: `feature/finance-operations` is currently 53 commits ahead / 13 commits behind
  `origin/feature/finance-operations` — needs a deliberate rebase/merge decision before any push,
  not a silent fast-forward.
- Revisit whether Contacts' "Import" and Ventes' "Peppol"/"Affichage"/"Relancer" controls should be
  built for real (would require new backend capability) or permanently removed from the reference
  parity target.
