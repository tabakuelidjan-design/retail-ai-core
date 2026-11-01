# Scene grammar vs concepts of the real trial `trial-40ce77ef0af9e1f3`

Inputs:
- the three concepts as reported by the owner: a wet ledge, a railing near the Meuse, a reflection in a puddle; with wet cobbles and urban reflections as recurring motifs;
- the scene contract (`stage-contract.js`) and what Blender really receives (`render_stage.py`, `blender_capabilities_used`).

No engine change was made for this analysis.

| Motif | 1. Already buildable | 2. Approximable without betraying the idea | 3. Not representable today |
|---|---|---|---|
| Dark, rainy, night mood | yes: `INFINITE_DARK` / `CHARCOAL` / `BRAND_NAVY` backdrop, `COOL` lights | | rain, droplets, mist (no volumetrics, no particles) |
| Wet ledge | | `BLOCK` or `PLINTH` in `CONCRETE` + `SATIN` floor + a `COOL` `STRIP` highlight: a wet-looking ledge, without water | water droplets on the surface |
| Reflection in a puddle | | `MIRROR` floor: the product is reflected, but the WHOLE floor is a mirror (an "infinite puddle", no edges) | a puddle with edges inside a dry surface (local reflective patch) |
| Wet cobbles | | | the cobble texture (no image or procedural textures in the grammar) |
| Railing near the Meuse | | | a thin railing (no `RAIL` shape; a `PANEL` or `BLOCK` would betray it), the river, the landscape |
| Urban reflections (city lights) | | coloured accent lights reduced to 3 temperatures; reflection on a `MIRROR` floor | recognisable lights or places of Namur |

## Reading
- **The product remains the real photo, frontal and upright**, so a concept that needs the bottle on a ledge seen from above, or held, stays limited by the photo, whatever the grammar.
- What the three concepts share is **a wet, reflective surface**. Two of the three need it, the third approximates it. That is the only recurring gap that is demonstrated.
- The railing and the cobbles appear in **only one concept each**. That is not enough to justify a new shape or texture.

## Minimal extension, justified by the evidence (proposed, NOT implemented)
- **One floor finish `WET_STONE`.** Blender procedural material, with no image: matte concrete plus glossy patches from a noise mask. It covers "wet ledge", "puddle with edges" and "wet surface" together.
- **Contract impact:** one value added to `FLOOR`, about 20 lines in `render_stage.py`.
- **Before deciding:** read the `wanted_but_not_available` fields that Nordla itself declared in the private trial report (section 4 of `RAPPORT.md`).
  - If they name the wet surface, the extension is justified by two independent sources.
  - If they name something else (railing, cobbles), wait for a second trial.

## Out of scope (not to be done now)
Rain or particles, landscapes and landmarks, image textures, multiple viewpoints of the product, depth of field.
