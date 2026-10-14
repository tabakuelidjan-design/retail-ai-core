# HABB sourcing profile - what is missing, provisional, inferred or defaulted

File: `config/merchants/habb/sourcing-fit.json` (status `DRAFT_FOR_OWNER_REVIEW`). The engine is generic and reads it as data. **No business value below has been chosen for the owner.** Status: M = missing (null / no field), P = provisional (written in the file, to confirm), D = generic default outside the profile.

| # | St | FIELD | CURRENT VALUE | SOURCE | WHY IT MATTERS | RECOMMENDED OWNER INPUT |
|---|---|---|---|---|---|---|
| 1 | M | `retailPrice.bandGrossEur` | null | not set | "Retail price fit" stays UNKNOWN for every product | the lowest and highest consumer price (VAT incl.) HABB sells in |
| 2 | M | target margin (per case `sale.targetContributionPct`) | blank in the form; no merchant default | not set | the maximum purchase price, the margin label and the opening target all derive from it | the margin you require, per product kind if it differs (personalised vs resold) |
| 3 | M | `margin.minContributionPct` (floor) | null | not set | below it the fit says AGAINST regardless of the per-case target | a floor, or "none" |
| 4 | M | maximum-purchase-price policy | no merchant policy; computed per case from selling price + target margin + selling-side costs the owner types | no profile field; the HABB production costs (UV ink, blanks, operator time, waste) are empty in `config/merchants/habb/README.md` | with no selling-side costs the maximum price is too generous (blank-product price only) | the per-unit costs to deduct (UV ink + labour, packaging, returns allowance, marketplace fees) or the rule to enter them |
| 5 | M | `storage.maxVolumePerUnitCm3` | null | not set | "Storage footprint" is UNKNOWN even when the size is known | largest unit volume (or carton volume per 1000 units) you will stock |
| 6 | M | `shipping.maxWeightPerUnitG` | null | not set | "Shipping practicality" cannot judge weight | heaviest unit still practical to post / your parcel tiers |
| 7 | M | MOQ preference | no field exists; the engine only compares the supplier's MOQ with the quantity entered per case | not modelled | decides whether a 500/1000 MOQ is acceptable or a lever to negotiate | acceptable MOQ range and the maximum cash you will tie up in one first order |
| 8 | M | first-order risk policy | no field; generic advice only ("no deposit before documents, ask a sample, inspect before final payment") | `supplier.js` generic brief, not HABB data | decides sample / inspection / deposit-size rules and "when is a first order too big" | maximum first-order value, deposit % ceiling, sample and inspection requirements |
| 9 | P | `negotiation.targetBelowMaxPct` | 15 | copied from the generic negotiation-brief default (an arithmetic step, not a market fact) | the opening target = maximum price minus this; without it there is no target | confirm or change the step |
| 10 | P | `uvPrint.compatibleMaterials` | stainless steel, aluminium (alloy), zinc alloy, metal, brass, copper, glass, acrylic, ABS, plastic, PP, PET, PVC, wood, bamboo, ceramic, PU leather, leather, cardboard, paper | general UV-flatbed practice | UV suitability is SUPPORTED only for these | edit from what your printer actually prints (and primers needed) |
| 11 | P | `uvPrint.difficultMaterials` | silicone, TPU, rubber, cotton, polyester, nylon, each with a reason | general practice | these lean AGAINST | confirm or remove each |
| 12 | P | `giftability` categories and cues | 6 category ids (gift/decor, bottle, glass/ceramic tableware, household, costume jewellery, phone case); cue words (gift, set, box, mug...) | inferred from "personalised gifts" | what counts as a gift product | the categories and words that mean "gift" for HABB |
| 13 | P | `personalization.cues` | blank, sublimation, engrav, custom, logo, OEM, ODM, UV print... | inferred | detects customisation potential from wording | confirm the wording |
| 14 | P | `bundle` cues and complementary categories | set, kit, bundle, pack...; 3 categories | inferred | "Bundle potential" | which products HABB combines |
| 15 | P | `seasonality.seasons` | Christmas, Valentine's, Mother's, Father's, back to school, wedding, birth, with cue words | inferred | timing of orders and stock | your real seasons and their cues |
| 16 | P | `assortment.existingCategoryIds` | gift/decor, bottle, glass/ceramic tableware | inferred from the description | "Fit with current assortment" | categories HABB already sells |
| 17 | P | `shipping.fragileMaterials` | glass, ceramic | inferred | fragility flag in shipping | confirm / add |
| 18 | D | VAT rate prefilled in "Vos chiffres" | 21 % | Belgian standard rate, visible and editable in the form (the case stores what was saved) | enters the margin and maximum price | confirm 21 % applies to your products, or the rate per product |
| 19 | D | "unattractive" threshold | contribution below 50 % of the target margin | `DEFAULT_POLICY` in the generic engine | when a margin is labelled UNATTRACTIVE | confirm or change |

Engine constants that are NOT merchant decisions (counting rule of the fit label: 5 known dimensions, half applicable, one third supported, 70 % for HIGH; ask list of 2-5; Safety Gate staleness 14 days) are printed in the app / documented in `docs/CHINA-SOURCING-FIELD-V1.md`; tell me if any should become profile data.

Never defaulted (blank until entered): freight, brokerage, customs duty rate, exchange rate, selling price, quantity, sample cost. The selling-side cost lines used in the test fixtures (UV 2.20, packaging 0.60, returns 3 %) are INVENTED test values, not HABB values.

**Decisions needed from the owner: 19** (8 missing, 9 provisional to confirm, 2 generic defaults to confirm).
