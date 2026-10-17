# China Sourcing - French extraction fix (case-mvcbnpmd)

Branch `fix/sourcing-extract-moq-leadtime`, cut from `origin/release/sourcing-staging` (a7ecccd). `release/sourcing-staging` itself is untouched. Nothing deployed, no stored data modified, nothing pushed.

## The defect, reproduced

Note (exact): « Nous proposons 100 gourdes en acier inoxydable à 5 € pièce. Quantité minimale : 100 unités. Livraison en Belgique non précisée. Délai de fabrication : 15 jours. »

Before: `quote.currency = EUR`, `quote.unitPrice = 5`, nothing else. Everything else landed in "texte non compris".

## Root cause

`core/extract/` knows English (`en.js`) and Chinese (`zh.js`) wording for the minimum order and the lead time. Only a few French words existed (prix, tarif, couleurs). In particular:

- MOQ: the patterns need `MOQ` / `minimum order` / `min order`, and the unit list is `pcs|pieces|units|sets`. "Quantité minimale" and "unités" match nothing.
- Lead time: needs `lead time|production|delivery|ready in|within`... "Délai de fabrication" matches nothing (and the French `pièces` has an accent that `pieces?` does not match).
- Offered quantity: **no fact existed at all** for "the quantity the supplier offers". It could only be forced into the MOQ or a price tier, both wrong.

## The fix

| File | Change |
|---|---|
| `src/sourcing/core/extract/fr.js` (new) | French rules for the minimum order, the lead time and the offered quantity. Same contract as `en.js`: proposals pointing at exact spans, nothing applied. |
| `src/sourcing/core/extract/index.js` | Runs `extractFr` for non-Chinese text; a French candidate is dropped when another rule already read the same key at an overlapping place (never altered, never doubled). |
| `src/sourcing/core/candidate-view.js` | Label and value text for the new key (« Quantité proposée » / "Quantity offered"). |
| `src/sourcing/core/conversation.js` | `quote.offeredQty` compiles to **no event** (ledger only), like `carton.qty`; plain label. |
| `test/sourcing-extract-fr-terms.test.js` (new) | 13 regression tests. |

### Three quantities, three different things

| Meaning | Key | What confirming it does |
|---|---|---|
| Quantity the supplier offers / quotes for ("Nous proposons 100 gourdes") | `quote.offeredQty` (new) | Ledger entry only. Never the MOQ, never the quantity ordered. |
| Supplier minimum ("Quantité minimale : 100 unités") | `quote.moq` | Sets the quote MOQ, only when the owner confirms. |
| Quantity the owner plans to buy | `context.plannedQty` | Written only by the owner (`PLAN_QTY`). No extractor touches it. |

"Nous proposons 100 gourdes" alone yields no MOQ. "Quantité minimale : 100" alone yields no offered quantity.

### Result on the exact note

`quote.offeredQty = 100` (« 100 gourdes ») · `quote.currency = EUR` · `quote.unitPrice = 5` · `quote.moq = 100` (« Quantité minimale : 100 unités ») · `quote.leadTime = 15 days` (« Délai de fabrication : 15 jours »). « Livraison en Belgique non précisée » produces nothing (no invented lead time, Incoterm or port).

### Wordings covered (all tested)

- MOQ: quantité minimale (de commande) / quantité minimum / commande minimale / minimum de commande / minimum d'achat / minimum de N pièces / N pièces (au) minimum / Qté min / MOQ de N; with « avec votre logo » (context `custom_logo`), emballage, échantillons; « par couleur » becomes `moq.perColour` as in English. `1 000` and NBSP thousands read as 1000; `1.000` is refused as ambiguous (value null, suggestion 1000) instead of guessed.
- Lead time: délai (de fabrication / production / préparation / réalisation), durée de fabrication, fabrication / production en|sous N jours, prêt en N jours, ranges (`10 à 15`, `10-15`), weeks converted to days with the existing `WEEKS_CONVERTED` flag, jours ouvrés. « Délai de livraison » / « livraison N jours » is read with confidence MEDIUM (may include transport).
- Offered quantity: nous (vous) proposons / on propose / nous offrons / nous pouvons (vous) fournir|livrer N <chose>. Not read when the word after the number is a price, a duration or a percentage.
- Not read (tested): délai de paiement, validité de l'offre, garantie, « Livraison en Belgique », « minimum 5 jours », prix minimum, quantité par carton.

## Rules kept

- **Never auto-confirmed**: all new candidates are `PROPOSED` with the existing flow; nothing reaches a quote or the ledger without an owner action (test 11, 12).
- **Original note kept** word for word (test 11); stored data is not rewritten on load.
- **Existing case**: `case-mvcbnpmd` only gets the three missing proposals if the owner uses the existing explicit "re-read notes" action (`CONVERSATION_REANALYZE`): additive, `OWNER_INITIATED_REANALYSIS`, decided or rejected facts and the ledger untouched, second run adds nothing (test 13). This fix does not run it.

## Verification

- Differential run old extractor vs new on 1 334 text strings taken from every existing sourcing/extract test file: **no existing reading removed or changed**; only additions, all on French wording (plus my own new test strings). That run found and fixed one leak: English « minimum 25 pcs per color » briefly gained a product MOQ next to `moq.perColour`; now blocked and pinned in test 10.
- `test/sourcing-*.test.js`: 626 tests, 623 pass. The 3 failures also fail on the untouched release branch (`sourcing-ui-syntax` and the merchant-fit path test look like Windows path assumptions; the `sourcing-realistic` file failure was not investigated).
- Whole `test/*.test.js`: base 152 failures vs 153 after; the sets differ by three timing tests (`file lease clean stop`, `recompute after ONE changed fact`, `open a case cold/warm`) which pass in isolation on both branches (3 reruns). The remaining ~150 failures are identical on both: dependencies not installed (`node_modules` absent) in this checkout.
- Not done: a real run on Railway staging (no deployment allowed), and no visual check of the phone UI (the change is in the extractor and two display strings; the UI code is unchanged).

## Observations, not changed

- Price tiers still only recognise `pcs|pieces|units|sets`. "100 pièces à 5 €" stays a lone unit price, not a tier (changing it would alter price extraction).
- `detectLang` returns `en` for French text; candidates keep `lang: 'en'`.

## Rollback

Revert the single commit on this branch, or simply do not merge it. No data migration exists to undo.
