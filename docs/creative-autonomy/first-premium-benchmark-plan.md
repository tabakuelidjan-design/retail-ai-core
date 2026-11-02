# First premium visual — real-provider benchmark plan (READY FOR REVIEW, NOT AUTHORISED)

NDR-D02 stays in force. Nothing here runs until the owner approves it in writing (scoped exception, ADR 0007 Part B). TYESO 750 ml is **not** used.

## Product (read-only from HABB's Shopify, 2026-11-02)
| | |
|---|---|
| Product | Batterie externe Mini 10 000 mAh – 22,5W — `gid://shopify/Product/15500510986588` |
| Variant | Noir / 10000mAh — `gid://shopify/ProductVariant/57117887168860`, 29,00 €, stock 13 |
| Source image | `gid://shopify/MediaImage/69241642025308`, WebP 800×799, linked to the **Noir variant only** (each colour has its own image) |
| SHA-256 | **computed and pinned by `--plan` on the owner's machine** (the CDN is not reachable from the engineering workspace); the plan id binds it |
| Verified facts | Remax MH136; 10 000 mAh; integrated USB-C cable; fast charge up to 22,5W; digital display; neck lanyard; "journées actives, voyages, recharges d'appoint" |
| Why this product | exact variant identity (one image per colour), no people expected, a real HABB gift-tech item; alternatives: the crimson gift box (one image for S/M/L: size not provable) and the slate frame (image may show a person: not eligible) |

Owner checks before GO: the photo shows the black unit alone, no person, no foreign logo; HABB may use and transform this supplier image.

## Brief
Objective: "Faire découvrir la batterie Mini noire aux clients qui voyagent et passent la journée dehors." Tenant: HABB profile (`config/merchants/habb/creative-brand.json`). Format: Instagram 4:5, **1080×1350**. Creative direction candidates: see `creator-acceptance-three-products.md` (the selected concept there is an example; the real run lets Nordla's providers ideate).

## Providers and spend
Text and critique: Alibaba Model Studio, Frankfurt, EU scope (`qwen3-vl-plus`). Image: `qwen-image-3.0-pro`, Frankfurt endpoint, GLOBAL scope (cross-border processing possible, declared). One image call, 3 variants. **Ceiling 0,50 €** (reserved atomically in the Creative ledger), estimate ≈ 0,13 € (last simulated run: 0,128 €), worst case 0,50 €. Invoice checked by hand afterwards.

## Acceptance criteria
Technical (automatic, blocking): at least one variant passes `scene_check` (product where expected, no ghost edge, no duplicate); product fidelity after restoration (max level difference ≤ 2); no typography defect; 1080×1350 delivered.
Artistic (owner, not automatic): the image tells the selected concept at a glance; product/background integration credible (light side, contact shadow); no generic AI look, no HABB-forbidden element; headline real and fitting. The concept critic's 7-axis judgement is recorded with its evidence but **does not** replace the owner's decision.

## Expected outputs and audit
Proposal PNG and its report; `scene_variants.json` (request, negative prompt and dropped terms, request id, cost estimate); `trace.json`; ledger rows (policy version, reservation, AUTHORIZED → RESERVED → ATTEMPTED → SENT → SUCCEEDED with the provider request id); the owner's decision. Nothing published.
