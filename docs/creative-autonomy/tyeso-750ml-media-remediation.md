# TYESO 750 ml (variant Noir) — source photo: findings and remediation plan

Date: 2026-11-02. **Nothing was changed in Shopify.** Read-only Admin GraphQL read of the HABB store, same day.

## What the store holds
- Product `gid://shopify/Product/15514012254556`, title **"Gourde Tyeso TS-8771C à paille – 750 ml"**, ACTIVE, 8 colour variants (Gris, Rose, Bleu, Blanc, Jaune, Vert, Noir, Rouge Cramoisi), price 29.90 EUR each.
- Variant **Noir** `gid://shopify/ProductVariant/57246326784348`, option `Couleur = Noir`, is **linked in Shopify** to one image: `TYESO_Wander_lockable_Stainless_Steel_Sports_Bottle_With_Straw_Black_20oz.webp` (2000×2000).
- Every colour image in the gallery is named `…Wander_lockable…_20oz.webp`; their alt texts all say **"Tyeso 318 Straw Bottle 750ml"**. One image's alt text is a `cdn.dropmagic.ai` URL.

## Contradictions (not resolved by guessing)
| Source | Says |
|---|---|
| Shopify title | model **TS-8771C**, **750 ml** |
| Image file names | TYESO **Wander lockable** straw bottle, **20 oz** (≈ 591 ml) |
| Image alt texts | "Tyeso **318** Straw Bottle **750ml**" |
| Public listing of TS-8770C (sister reference) | 600 ml straw sports bottle **with handle**, a 750 ml option exists; TS-8771C itself not found in a public source |

So the gallery may show **another capacity and possibly another model line** than the product sold. The official TYESO "Wander 25 oz" image proposed earlier (tyeso.com) is the Wander line; it is **not proven** to be the TS-8771C either. **Blocked: no official image could be conclusively verified for TS-8771C 750 ml black.**

## Remediation plan (owner approval required; no change made)
1. **Physically check** a black 750 ml bottle in the shop: reference printed on the bottle / box (TS-8771C?), capacity marking, handle or not.
2. **Best source: a HABB-owned photograph** of that bottle (plain light background, whole bottle, ≥ 2000 px, no person). It removes the supplier-licence question and is exactly the product sold.
   Alternative: an official TYESO image for that exact reference, with written confirmation from TYESO of the reference and the right to use it (the commercial relationship exists; this is about the exact file).
3. In Shopify (owner action, after approval): upload the photo to the product, **link it to the variant Noir** (variant media), with a precise alt text (e.g. "Gourde TYESO TS-8771C 750 ml noire avec paille"); **unlink** `…Black_20oz.webp` from the variant.
4. **Storefront correction to decide**: if the physical check confirms the bottle is not the 20 oz Wander, the 8 gallery images misrepresent the product (capacity, possibly model) to customers and should be replaced the same way for each colour; fix the alt text that is a URL.
5. Nordla needs nothing else: once the variant is linked to a correct, non-contradicting image, `product-media.js` selects it automatically, with no question to anyone.
