# Does the scene grammar limit Nordla's creativity?

The short answer is **probably yes**. The first real trial is designed to MEASURE it rather than assume it.

## What the grammar allows today (src/creative-autonomy/stage-contract.js)
| Dimension | Vocabulary |
|---|---|
| Set | 3 backdrops (seamless sweep, infinite dark, wall and floor) × 6 tones × 3 floor finishes |
| Light | key + up to 3 accents; each light is 5 kinds × 5 sides × 3 intensities × 3 temperatures = 225 variants |
| Camera | 3 heights × 3 framings × 3 product positions = 27 variants; no tilt, no top-down view, no depth of field |
| Props | up to 4; each prop is 7 primitive shapes × 7 materials × 6 placements × 3 scales = 882 variants; one extruded word of 2 to 12 capitals |
| Text | one headline of at most 8 words, 6 placements, one typeface |

The count runs into millions of combinations. But they are millions of **variations of one kind of image**: an abstract studio, primitive volumes and a product standing upright.

## Where the limit really sits (by order of weight)
1. **The product is a frontal photograph.** Reversible fidelity guarantees the product is never altered. It also fixes the viewpoint to the photo's: the product cannot be shown lying down, from above, held in a hand, in use, several times, or in a real mirror. Only new photographs from other angles can widen this.
2. **No places and no real objects.** The concepts the Brain is asked for are narrative ("a workshop bench at dusk", "foam leaving a pebble beach"). The stage can only turn them into blocks, spheres and arches. There is no wood, stone, water, fabric, plant, tool or interior.
3. **No atmosphere.** No haze, dust, droplets, steam, coloured gels or light gradients. Blender can do all of this; the grammar does not ask for it.
4. **A fixed camera.** No angle, no shallow depth of field, no close detail.
5. **Minimal typography.** One headline and at most one word in volume. That is enough for a first trial.

## Blender: available versus used
Each render now records what Blender actually received (`blender_capabilities_used` in the trace):
- engine, samples, resolution, camera;
- objects by type, light types and energies;
- materials and their nodes;
- and, explicitly, what was NOT used: volumetrics, image textures, HDRI, depth of field, modifiers, particles, animation.

On the engine test, Blender received 6 primitive meshes, 2 AREA lights and 6 single-node materials. Volumetrics, textures, HDRI, depth of field, modifiers, particles and animation were all unused.

## How the trial measures it
- The STAGE contract has an optional field, `wanted_but_not_available` (up to 5 items). In it, the model **itself** names what its concept or art direction needed and the vocabulary could not express. It is reported to the owner as a system limit.
- The trace also places, for each concept, the art direction's narrative elements next to what the stage could actually translate (`grammar_gap`).
- The ideation trial (text only) is enough to collect this evidence before any image is sent.

## Ways to widen it (not implemented, for decision after the evidence)
- Add a vocabulary entry only where the trial shows a recurring need: materials (wood, stone, water, fabric), atmospheres (haze, gels), camera (angle, depth of field).
- Add a small library of real 3D objects under a free licence (CC0), named in the vocabulary, instead of primitives.
- Use multi-angle photographs of the product (see the photo brief) to free the viewpoint.
- Do not use image generation for the product itself: the product remains the real photograph.
