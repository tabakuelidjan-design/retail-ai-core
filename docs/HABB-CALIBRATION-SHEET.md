# HABB calibration sheet (before the China trip)

Companion to `docs/HABB-SOURCING-PROFILE-INPUTS.md` (same 19 numbers). **Nothing in this sheet is written into `config/merchants/habb/sourcing-fit.json`.** The "recommended" column is a proposal with its reasoning; only the owner's answer becomes data. Nordla knows no HABB prices, costs or sales figures (HABB Shopify is out of scope), so where a number would have to come from HABB's books, the recommendation is *how to get it*, not a value.

Rule for every "safe provisional" row: leaving a value empty is safe. The app then says **inconnu** for that dimension and invents nothing. A wrong number is worse than a blank.

## A. MUST DECIDE BEFORE THE TRIP (7 — the quote maths and the walk-away line depend on them)

| FIELD | CURRENT VALUE | WHY IT MATTERS | RECOMMENDED VALUE / RANGE | SOURCE OR REASONING | OWNER DECISION REQUIRED |
|---|---|---|---|---|---|
| 2. Target margin (`sale.targetContributionPct`, per case) | blank | Maximum purchase price, margin label and opening target all derive from it. Blank = no limit, no target | One % per product kind (resold vs personalised). Give it as contribution margin after selling-side costs | Your own books. Nordla will not propose a figure: any number would be a guess | **YES** |
| 3. Minimum margin (`margin.minContributionPct`) | null | Hard floor: below it the fit says AGAINST whatever the per-case target | A floor lower than the target, or "none" | Your own policy | **YES** |
| 4. Selling-side costs / max purchase price policy | none; UV ink, blanks, labour, waste empty in `config/merchants/habb/README.md` | Without them the maximum price is too generous (it only deducts what you type) | Per-unit amounts for: UV print (ink + operator time), packaging, returns allowance %, marketplace/payment fees. If you cannot get exact figures before the trip, enter a conservative rounded figure *per case* in "Vos chiffres" | Measured on your last 5-10 HABB orders. The fixture values (UV 2.20, packaging 0.60, returns 3 %) are INVENTED test data — do not reuse them | **YES** |
| 1. Retail price band (`retailPrice.bandGrossEur`) | null | "Retail price fit" is UNKNOWN for every product | Lowest and highest TTC price you sell at (e.g. read from your own catalog export) | Your catalog; Nordla does not read the store | **YES** |
| 7. MOQ preference | not modelled | Decides whether 500/1000 is acceptable or a lever | Acceptable MOQ range plus the maximum cash you will tie up in one first order | Your cash position. Cash exposure is the real limit, not the piece count | **YES** |
| 8. First-order risk policy | generic advice only | Decides sample / inspection / deposit rules and "too big for a first order" | Three numbers: max first-order value, max deposit %, sample required yes/no | A common, defensible baseline is "sample first, deposit capped, inspection before balance" — but the caps are your risk appetite | **YES** |
| 18. VAT rate prefilled | 21 % | Enters margin and max price | Keep 21 % if all products are standard-rated in Belgium; change per case otherwise | Belgian standard rate; editable in the form already | **YES** (30-second confirm) |

## B. CAN USE A SAFE PROVISIONAL VALUE (usable as is on the trip; confirm afterwards)

| FIELD | CURRENT VALUE | WHY IT MATTERS | RECOMMENDED VALUE / RANGE | SOURCE OR REASONING | OWNER DECISION REQUIRED |
|---|---|---|---|---|---|
| 9. Negotiation opening step (`negotiation.targetBelowMaxPct`) | 15 | Opening target = maximum price minus this step | Keep 15 for the trip; reasonable working range 10-20 | Arithmetic step copied from the generic brief, not a market fact. Only matters once rows 2 and 4 are set | NO for the trip; YES to change |
| 10. UV-compatible materials | 20 materials (metal, glass, acrylic, plastics, wood, ceramic, leather...) | UV suitability is SUPPORTED only for these | Keep. Remove any your printer cannot do; note primer needs | General UV-flatbed practice. Wrong inclusion only makes the fit slightly optimistic and every fact is still shown | NO for the trip; confirm after |
| 11. Difficult materials | silicone, TPU, rubber, cotton, polyester, nylon (with reasons) | These lean AGAINST | Keep | General practice; erring cautious is safe | NO for the trip |
| 17. Fragile materials | glass, ceramic | Fragility flag in shipping | Keep; add resin or porcelain if you sell them | Common sense; cautious is safe | NO |
| 5. Max storage volume per unit | null | Storage dimension is UNKNOWN | Leave empty on the trip, or give one ceiling in cm³ (or carton volume per 1000 units) | Leaving it blank is honest. Fill if you have a hard shelf limit | NO (YES only if you want it judged) |
| 6. Max shipping weight per unit | null | Shipping dimension cannot judge weight | Leave empty, or give the heaviest practical unit in grams / your parcel tier edge | Your carrier tiers | NO (YES only if you want it judged) |
| 19. "Unattractive" threshold | contribution < 50 % of target margin | When a margin is labelled UNATTRACTIVE | Keep | Generic engine default; only a label, never an action | NO |
| 16. Assortment overlap (`existingCategoryIds`) | gift/decor, bottle, glass/ceramic tableware | "Fit with current assortment" | Keep for the trip | Inferred from your description; a wrong list only changes one fit line | NO for the trip; confirm after |

## C. CAN WAIT UNTIL AFTER THE TRIP (soft fit cues, no money effect)

| FIELD | CURRENT VALUE | WHY IT MATTERS | RECOMMENDED VALUE / RANGE | SOURCE OR REASONING | OWNER DECISION REQUIRED |
|---|---|---|---|---|---|
| 12. Gift categories and cue words | 6 categories, cue words | What counts as a gift product | Keep; refine from the products you actually meet | Inferred; affects one fit line | NO now |
| 13. Personalisation cues | blank, sublimation, engrav, custom, logo, OEM, ODM, UV print | Detects customisation potential | Keep | Inferred wording | NO now |
| 14. Bundle cues and categories | set, kit, bundle, pack; 3 categories | Bundle potential | Keep | Inferred | NO now |
| 15. Seasonality | 7 seasons with cues | Order timing | Keep; correct after reviewing your real calendar | Inferred; affects timing advice only | NO now |

## Count
- A: 7 decisions (6 are real numbers only the owner has; VAT is a confirm).
- B: 8 can run on the current value or on blank.
- C: 4 can wait.
- Total 19. Decisions that block a *meaningful* quote verdict: rows 2, 4 (and 3 for a floor). Without them every quote still imports, is shown with provenance, compared, and asked about; only margin, maximum price and negotiation target stay `inconnu` / `INSUFFICIENT_DATA_FOR_NEGOTIATION_TARGET`.

## How an answer becomes data
Tell me each value and I will put it in `config/merchants/habb/sourcing-fit.json` (status stays DRAFT until you set it), with a test. Rows 2, 4 and 8 can also be typed per case in the app without touching the profile.
