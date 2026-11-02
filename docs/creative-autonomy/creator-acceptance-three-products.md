# Nordla Créateur — acceptance demonstration on three HABB products

**Scope, stated first.** The concepts, evaluations, art directions and stages were **written by Claude (engineering session, 2026-11-02) as a stand-in for Nordla's text provider** — no provider may run (NDR-D02). Everything else below is **Nordla's real code, deterministic**: distinctness guard, HABB's brand rules (from its tenant configuration), invented-capability checks, the selection decision, the art-direction and stage contracts, and the exact image request and prompt. **No image is rendered**: the catalogue photos are not reachable from this workspace and no real provider may run. The visual result, its technical quality and its creative quality are **NOT_MEASURABLE here**; a real-provider benchmark must verify them.

Product facts: read-only from HABB's Shopify on 2026-11-02 (nothing changed).

## Batterie externe Mini 10 000 mAh – 22,5W — Noir (29,00 €)

Shopify: product `gid://shopify/Product/15500510986588`, variant `gid://shopify/ProductVariant/57117887168860`, image `gid://shopify/MediaImage/69241642025308` (800×799 WebP, linked to the Noir variant only).

**Product truth.** A compact black power bank with its own USB-C cable, a small digital display and a neck lanyard: it travels ON the person, not in a bag.

**Creative opportunity.** Not “more mAh” (a spec, and a figure the headline may not carry) but the moment a phone is about to die far from any socket, and the answer is already hanging around the neck.

### Three concepts and the selection

| # | Central idea | Decision (Nordla, from the criteria) | Decisive evidence |
| --- | --- | --- | --- |
| 1 | The rescue was hanging around the neck all along: when a phone nears empty far from any socket, the lanyard pack answers with its own short cable. | SELECT → **selected** | FEASIBILITY PARTIAL: The fading phone must stay implied: Nordla refuses any device in a generated scene, so the story is carried by the empty platform and the lamp. |
| 2 | A whole travelling day packs into one pocket: the charge comes along like keys and a ticket, never as one more bag to remember. | REFINE_CONCEPT | DISTINCTIVENESS PARTIAL: An essentials row on a table is a common lifestyle composition; only the lanyard detail is specific. FEASIBILITY PARTIAL: The product photo stands upright; a top-down flat lay would need a different photograph. GENERIC_RISK PARTIAL: Flat lifestyle arrangements are frequent in accessory adverts. |
| 3 | The small display replaces an anxious guess with calm certainty: you read how much charge remains before you ever need it. | REJECT_CONCEPT | FEASIBILITY FAILS: The idea needs the display to emit light; the real product photo is never edited, so its display cannot be lit. |

Selection outcome: `SELECT`.

### Chosen art direction (validated)

- Atmosphere: A quiet late-evening platform, cool and empty, with one patient pause before the last train.
- Materials: Worn platform concrete, a painted steel bench, matte black plastic of the pack.
- Light: A single cool overhead platform light from the left, soft falloff into the dark beyond the bench.
- Depth / space: LAYERED_DEPTH / ASYMMETRIC_RESERVE; emotional temperature COOL, tension MEDIUM
- MIDGROUND: a folded paper ticket and a cold coffee cup left on the bench — *waiting for the last connection home, far from any socket*
- BACKGROUND: an empty platform edge receding into the dark — *far from any socket, waiting for the last connection home*

### Exact scene specification (validated stage, HABB profile)

```json
{
 "backdrop": "WALL_AND_FLOOR",
 "backdrop_tone": "CHARCOAL",
 "floor_finish": "SATIN",
 "key_light": {
  "kind": "SPOT",
  "side": "LEFT",
  "intensity": "MEDIUM",
  "temperature": "COOL",
  "purpose": "a lone platform lamp isolating the pack on the bench"
 },
 "accent_lights": [
  {
   "kind": "RIM",
   "side": "BACK",
   "intensity": "LOW",
   "temperature": "COOL",
   "purpose": "separate the black pack from the dark platform"
  }
 ],
 "camera": {
  "height": "PRODUCT_CENTER",
  "framing": "MEDIUM",
  "product_position": "RIGHT_THIRD"
 },
 "headline": "Le secours était déjà autour du cou",
 "text_placement": "LEFT_COLUMN",
 "show_price": "YES"
}
```

Image-model prompt Nordla would send (1865 characters):

> Edit the referenced product photograph: keep the real product exactly as it is and change only the environment around it. Preserve exactly: its position and size in the frame; its outline and proportions; its lid, clip and every printed mark; its colour and finish. New environment: a photorealistic commercial photograph, real materials, real optics, seen at the object's mid height. Atmosphere: A quiet late-evening platform, cool and empty, with one patient pause before the last train. Materials: Worn platform concrete, a painted steel bench, matte black plastic of the pack. Light: A single cool overhead platform light from the left, soft falloff into the dark beyond the bench; the key light comes from the left, cool in colour. Setting: a wall meeting the floor behind it in charcoal grey, the object standing on a satin surface with a soft sheen. Depth: a clear foreground, middle ground and background; a large calm area on one side. In the middle ground, beside the object: a folded paper ticket and a cold coffee cup left on the bench. In the background: an empty platform edge receding into the dark. The scene also needs: a steel platform bench as the surface; rails receding into the dark. Leave calm space on the side opposite the object, for a headline added later. Product presence: it stays exactly where it stands in the reference image, at the same size, upright and resting on the surface, with a natural contact shadow under it, lit by the same light as the scene. Keep the product upright, with the same orientation, the same viewing angle and the same proportions. Do not redesign, replace, recolor, relabel or retouch the product. Do not add any text, letters, numbers, prices, logos, labels, captions or watermarks anywhere in the image. The only text allowed is the text already printed on the product, which must stay exactly as it is.

Negative prompt (496/500 characters): `distorted product, changed printed text, redrawn artwork, altered camera module, extra lens, missing lens, added text, watermark, a second copy of the product, another product, duplicate object, people, hands, face, logos, letters, words, numbers, signage, neon, artificial glow, lens flare, cartoon, illustration, 3d render look, plastic look, distorted perspective, beige, cream, sand colour, ivory, gold, golden, glitter, hearts, leaves, foliage, flowers, plants, marble, velvet, bokeh, crowds` — dropped and reported: neon reflections, a substitute for the product, a phone, a case or any device, a competing hero object, a misleading commercial object, text, letters, logos or watermarks

Concept sentences withheld from the image prompt because they name phone, screen (forbidden in generated scenes): the story reaches the model through the art direction's planes instead.

### Limitations of the rendering engine

- The closed stage vocabulary cannot name: a steel platform bench as the surface; rails receding into the dark. In scene mode these are **requested** from the image model (above); whether they are drawn is only known on a real image. The local Blender engine cannot draw them at all.
- The image model redraws the product; Nordla puts the authentic photo pixels back and re-proves them. Lighting continuity between scene and real product is measured (warnings), not guaranteed.
- **Supplier image:** the photo comes from a supplier feed (alt text is a dropmagic URL): HABB's right to use and transform it must be confirmed (ADR 0007 open obligation).
- **Resolution:** 800×799 source for a 1080×1350 output: the product is restored at ≈1:1 at this framing; a CLOSE framing would upscale the real pixels.

### Assessment

| Axis | Verdict | Why |
| --- | --- | --- |
| Concept contracts (distinct, content, HABB rules, no invented capability) | PASS | Nordla validators, above |
| Stage and headline rules (no figure, no claim, no placeholder, text off the product) | PASS | Nordla validators, above |
| Technical quality of a finished image | NOT_MEASURABLE | no render (photo not reachable here, no real provider) |
| Creative quality / WOW / premium execution | NOT_MEASURABLE | judged only on a rendered image, by the concept critic and the owner |

## Coffret cadeau Premium avec poignée et ruban — Rouge Cramoisi / M (14,90 €)

Shopify: product `gid://shopify/Product/15547356250460`, variant `gid://shopify/ProductVariant/57444461773148`, image `gid://shopify/MediaImage/69640105689436` (1480×1062 PNG, linked to Rouge Cramoisi S, M AND L (one image for three sizes)).

**Product truth.** A crimson gift box with a handle and a ribbon: the presentation that makes any object ready to give.

**Creative opportunity.** The box is the first thing the receiver sees. The story is the second before opening, not the object inside (which Nordla must not invent).

### Three concepts and the selection

| # | Central idea | Decision (Nordla, from the criteria) | Decisive evidence |
| --- | --- | --- | --- |
| 1 | The present is already given on the way there: the handle lets the box travel through the city like a promise everyone can see. | REJECT_CONCEPT | FEASIBILITY FAILS: The story needs a hand carrying the box; people and hands are excluded from Nordla’s generated scenes. |
| 2 | The truest second of a present comes before the ribbon is pulled, while the box is still closed and anything is possible. | SELECT → **selected** | every criterion MEETS |
| 3 | Whatever you made or chose, the presentation makes it look intended: one crimson box gives a small object the dignity of a real gift. | REFINE_CONCEPT | DISTINCTIVENESS PARTIAL: Workbench settings are common for handmade goods. GENERIC_RISK PARTIAL: Maker-bench imagery is widespread. |

Selection outcome: `SELECT`.

### Chosen art direction (validated)

- Atmosphere: A hushed dark room in the second before a gift is opened, every surface still.
- Materials: Dark oiled table wood, matte crimson card, satin ribbon.
- Light: One narrow shaft of light from above-left landing on the box and the table edge, the room falling into soft dark.
- Depth / space: SHALLOW_LAYERS / SURROUNDING_REST; emotional temperature CONTRASTED, tension HIGH
- FOREGROUND: the edge of a dark table in sharp light — *the gift has been set down in front of someone: the moment before opening*
- BACKGROUND: an empty chair back half lost in shadow — *the room waits; nobody has touched the ribbon yet*

### Exact scene specification (validated stage, HABB profile)

```json
{
 "backdrop": "WALL_AND_FLOOR",
 "backdrop_tone": "DEEP_BLACK",
 "floor_finish": "SATIN",
 "key_light": {
  "kind": "SLIT_SHEET",
  "side": "TOP",
  "intensity": "HIGH",
  "temperature": "NEUTRAL",
  "purpose": "a single shaft of light on the closed box, the room in shadow"
 },
 "accent_lights": [],
 "camera": {
  "height": "LOW",
  "framing": "CLOSE",
  "product_position": "LEFT_THIRD"
 },
 "headline": "La seconde avant le ruban",
 "text_placement": "RIGHT_COLUMN",
 "show_price": "YES"
}
```

Image-model prompt Nordla would send (1765 characters):

> Edit the referenced product photograph: keep the real product exactly as it is and change only the environment around it. Preserve exactly: its position and size in the frame; its outline and proportions; its lid, clip and every printed mark; its colour and finish. New environment: a photorealistic commercial photograph, real materials, real optics, seen from slightly below. Atmosphere: A hushed dark room in the second before a gift is opened, every surface still. Materials: Dark oiled table wood, matte crimson card, satin ribbon. Light: One narrow shaft of light from above-left landing on the box and the table edge, the room falling into soft dark; the key light comes from above, neutral in colour. Setting: a wall meeting the floor behind it in near-black, the object standing on a satin surface with a soft sheen. Depth: two close layers of depth; quiet space all around the object. In the foreground: the edge of a dark table in sharp light. In the background: an empty chair back half lost in shadow. The scene also needs: dark oiled table wood as the surface; an empty chair back in shadow. Leave calm space on the side opposite the object, for a headline added later. Product presence: it stays exactly where it stands in the reference image, at the same size, upright and resting on the surface, with a natural contact shadow under it, lit by the same light as the scene. Keep the product upright, with the same orientation, the same viewing angle and the same proportions. Do not redesign, replace, recolor, relabel or retouch the product. Do not add any text, letters, numbers, prices, logos, labels, captions or watermarks anywhere in the image. The only text allowed is the text already printed on the product, which must stay exactly as it is.

Negative prompt (498/500 characters): `distorted product, changed printed text, redrawn artwork, altered camera module, extra lens, missing lens, added text, watermark, a second copy of the product, another product, duplicate object, people, hands, face, logos, letters, words, numbers, signage, neon, artificial glow, lens flare, cartoon, illustration, 3d render look, plastic look, distorted perspective, beige, cream, sand colour, ivory, gold, golden, glitter, hearts, leaves, foliage, flowers, plants, marble, velvet, bokeh, confetti` — dropped and reported: balloons, sparkles, a substitute for the product, a phone, a case or any device, a competing hero object, a misleading commercial object, text, letters, logos or watermarks

Concept sentences withheld from the image prompt because they name box (forbidden in generated scenes): the story reaches the model through the art direction's planes instead.

### Limitations of the rendering engine

- The closed stage vocabulary cannot name: dark oiled table wood as the surface; an empty chair back in shadow. In scene mode these are **requested** from the image model (above); whether they are drawn is only known on a real image. The local Blender engine cannot draw them at all.
- The image model redraws the product; Nordla puts the authentic photo pixels back and re-proves them. Lighting continuity between scene and real product is measured (warnings), not guaranteed.
- **Variant identity:** one image is linked to S, M and L: the picture cannot prove the M size. Nordla's selector may accept it (the image IS linked to the variant), but the owner must confirm which size it shows before a real trial.

### Assessment

| Axis | Verdict | Why |
| --- | --- | --- |
| Concept contracts (distinct, content, HABB rules, no invented capability) | PASS | Nordla validators, above |
| Stage and headline rules (no figure, no claim, no placeholder, text off the product) | PASS | Nordla validators, above |
| Technical quality of a finished image | NOT_MEASURABLE | no render (photo not reachable here, no real provider) |
| Creative quality / WOW / premium execution | NOT_MEASURABLE | judged only on a rendered image, by the concept critic and the owner |

## Cadre Photo Ardoise Bois (45,90 €)

Shopify: product `gid://shopify/Product/15547356971356`, variant `gid://shopify/ProductVariant/57398932210012`, image `gid://shopify/MediaImage/69719818043740` (1402×1122 PNG (file name “cyclisme”): product-level image, the only one).

**Product truth.** A slate-and-wood photo support personalised with the customer’s own photo and text, prepared in HABB’s Namur workshop.

**Creative opportunity.** A memory leaves the phone gallery and takes a place in the home; made locally, one at a time (both verified in the sheet).

### Three concepts and the selection

| # | Central idea | Decision (Nordla, from the criteria) | Decisive evidence |
| --- | --- | --- | --- |
| 1 | A photo that lived in a phone gallery finally gets a place at home, printed on slate and wood so it is met every morning. | SELECT → **selected** | every criterion MEETS |
| 2 | Each frame is prepared one at a time in the Namur workshop for one memory, which no mass-made frame can offer. | REFINE_CONCEPT | DISTINCTIVENESS PARTIAL: Workshop scenes are common for handmade goods, even if the Namur claim is verified. GENERIC_RISK PARTIAL: Maker-bench imagery is widespread. |
| 3 | Slate and wood give a photograph weight and texture: the memory becomes something you can touch instead of scroll past. | SELECT | RELEVANCE_TO_BRIEF PARTIAL: Material texture is secondary to the personal memory the customer buys. EMOTIONAL_RESONANCE PARTIAL: Texture is felt less than a memory placed in the home. |

Selection outcome: `SELECT`.

### Chosen art direction (validated)

- Atmosphere: A calm entry at dawn, the house still asleep, the first light reaching the shelf by the door.
- Materials: Pale painted plaster wall, a simple oak shelf, slate and wood of the frame.
- Light: Low soft morning light from the right through an unseen window, long gentle shadows across the wall.
- Depth / space: LAYERED_DEPTH / ASYMMETRIC_RESERVE; emotional temperature WARM, tension LOW
- FOREGROUND: a set of keys dropped on the shelf beside the frame — *every morning on the way out, the memory is met by the door*
- BACKGROUND: the edge of a front door slightly ajar, soft daylight beyond — *on the way out, the frame takes its place at home*

### Exact scene specification (validated stage, HABB profile)

```json
{
 "backdrop": "WALL_AND_FLOOR",
 "backdrop_tone": "WHITE",
 "floor_finish": "MATTE",
 "key_light": {
  "kind": "SOFTBOX",
  "side": "RIGHT",
  "intensity": "LOW",
  "temperature": "WARM",
  "purpose": "low morning light reaching the frame by the door"
 },
 "accent_lights": [],
 "camera": {
  "height": "PRODUCT_CENTER",
  "framing": "MEDIUM",
  "product_position": "RIGHT_THIRD"
 },
 "headline": "Ta photo, enfin à sa place",
 "text_placement": "LEFT_COLUMN",
 "show_price": "YES"
}
```

Image-model prompt Nordla would send (1984 characters):

> Edit the referenced product photograph: keep the real product exactly as it is and change only the environment around it. Preserve exactly: its position and size in the frame; its outline and proportions; its lid, clip and every printed mark; its colour and finish. New environment: a photorealistic commercial photograph, real materials, real optics, seen at the object's mid height. The image tells this idea: An entry shelf at dawn where the frame leans against the wall, catching the first light, a set of keys dropped beside it. Atmosphere: A calm entry at dawn, the house still asleep, the first light reaching the shelf by the door. Materials: Pale painted plaster wall, a simple oak shelf, slate and wood of the frame. Light: Low soft morning light from the right through an unseen window, long gentle shadows across the wall; the key light comes from the right, warm in colour. Setting: a wall meeting the floor behind it in white, the object standing on a matte surface. Depth: a clear foreground, middle ground and background; a large calm area on one side. In the foreground: a set of keys dropped on the shelf beside the frame. In the background: the edge of a front door slightly ajar, soft daylight beyond. The scene also needs: an oak shelf as the surface instead of a floor; a front door ajar with daylight. Leave calm space on the side opposite the object, for a headline added later. Product presence: it stays exactly where it stands in the reference image, at the same size, upright and resting on the surface, with a natural contact shadow under it, lit by the same light as the scene. Keep the product upright, with the same orientation, the same viewing angle and the same proportions. Do not redesign, replace, recolor, relabel or retouch the product. Do not add any text, letters, numbers, prices, logos, labels, captions or watermarks anywhere in the image. The only text allowed is the text already printed on the product, which must stay exactly as it is.

Negative prompt (497/500 characters): `distorted product, changed printed text, redrawn artwork, altered camera module, extra lens, missing lens, added text, watermark, a second copy of the product, another product, duplicate object, people, hands, face, logos, letters, words, numbers, signage, neon, artificial glow, lens flare, cartoon, illustration, 3d render look, plastic look, distorted perspective, beige, cream, sand colour, ivory, gold, golden, glitter, hearts, leaves, foliage, flowers, plants, marble, velvet, bokeh, candles` — dropped and reported: dried flowers, string lights, a substitute for the product, a phone, a case or any device, a competing hero object, a misleading commercial object, text, letters, logos or watermarks

Concept sentences withheld from the image prompt because they name phone (forbidden in generated scenes): the story reaches the model through the art direction's planes instead.

### Limitations of the rendering engine

- The closed stage vocabulary cannot name: an oak shelf as the surface instead of a floor; a front door ajar with daylight. In scene mode these are **requested** from the image model (above); whether they are drawn is only known on a real image. The local Blender engine cannot draw them at all.
- The image model redraws the product; Nordla puts the authentic photo pixels back and re-proves them. Lighting continuity between scene and real product is measured (warnings), not guaranteed.
- **Source eligibility:** the only image is named “cyclisme” and may show a person (a customer-style photo printed on the product). Under ADR 0007-A, images with people are refused (SOURCE_REQUIRES_SPECIFIC_CONSENT) unless the tenant attests otherwise: **not eligible for a real trial until verified**.

### Assessment

| Axis | Verdict | Why |
| --- | --- | --- |
| Concept contracts (distinct, content, HABB rules, no invented capability) | PASS | Nordla validators, above |
| Stage and headline rules (no figure, no claim, no placeholder, text off the product) | PASS | Nordla validators, above |
| Technical quality of a finished image | NOT_MEASURABLE | no render (photo not reachable here, no real provider) |
| Creative quality / WOW / premium execution | NOT_MEASURABLE | judged only on a rendered image, by the concept critic and the owner |

## What this shows and does not show

- **Shows:** three genuinely different ideas per product pass Nordla's distinctness and brand guards; Nordla's selection rejects a concept that would need an edited product (display lit) or people (a hand carrying the box) and prefers the specific over the generic; the chosen story reaches the image model as layered scene instructions; HABB's prohibitions apply from its configuration.
- **Does not show:** that any of this becomes a WOW image. Only a real image provider, on a verified photo, judged by the critic and the owner, can show that.
