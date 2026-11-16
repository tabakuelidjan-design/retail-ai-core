# Archived develop/compare answers of the real Remax run cr-bffaa93bffef (2026-11-14), kept as NEUTRAL fixtures

- `remax-cr-bffaa93bffef-develop-answer.json`: the four proposals Nordla's model (qwen3-vl-plus) wrote, word for word, BEFORE the use-situation fields existed (no `need`, `visible_cues`, `cable_role`).
- `remax-cr-bffaa93bffef-compare-answer-original.json`: the blind comparison of that run, word for word (it retained the proposal written about a backpack, scored HIGH on relevance, before `brief_fit` existed).
- `remax-cr-bffaa93bffef-reading-by-claude.json`: a READING by Claude of what each archived scene description shows. It exists only so the CODE tests can run the new rules on the real archived text. It is not Nordla's output and not an artistic judgment.

No raw trace, no brain-calls folder, no private data: only the answers' own text.

## Real run cr-1ce3ccd4c444 (2026-11-14, from commit 5011946b), develop step only
- `remax-cr-1ce3ccd4c444-develop-first-answer.json`: the four proposals of the first answer (refused: a shelf read as a device, a smartwatch and a laptop in the scene, a connected-cable false positive, a headline of eleven words).
- `remax-cr-1ce3ccd4c444-develop-whole-answer-repair.json`: the model's repair, a WHOLE new answer (the repair was not a patch at that time); its only refusal was the headline of proposal 3 ("20 000 mAh pour toute la journée": a figure and a duration promise).

## Real run cr-2f3e5240fe12 (2026-11-15, from commit 4893561f), develop step only
- `remax-cr-2f3e5240fe12-develop-first-answer.json`: the four proposals of the first answer (refused: the generic word "appareil" in the idea of proposal 1, a figure and "toute la journée" in the title of proposal 4).
- `remax-cr-2f3e5240fe12-develop-first-patch-repair.json`: the model's repair, a VALID PATCH reply (two patches). It removed the duration but wrote a title that still carries a figure, and kept "l'appareil" in the idea.

## Real run cr-b78a1230b600 (2026-11-15, from commit 6a9e3c0d), composition step
- `remax-cr-b78a1230b600-compose-first-answer-bus.json`: the first composition of the retained proposal (a bus seat), written in French for the generator fields (refused: 12 texts not in English, cable wording, an element naming the product).
- `remax-cr-b78a1230b600-compose-patch-repair-bus.json`: the model's repair, a VALID PATCH reply (9 patches). It fixed the language and the cable wording, but left "the device" in the light text and "the power bank" in the fourth element.

## Real run cr-bc12c30da975 (2026-11-15), composition step
- `remax-cr-bc12c30da975-compose-first-answer.json`: the FIRST composition of that run (word for word): refused on the digit "5 cm" in an element, then (masked behind it) on the cable texts of `materials` and `light` and on "off-screen smartphone". Used by creator-ad-all-refusals.test.js to show that all refusals now come together.
- `remax-cr-9378362e3cf2-develop-answer.json`: the four proposals of the café run (the bus is proposals[0], the café proposals[1]); used by creator-judgment-grid.test.js as the neutral text on which the owner's ratings (5/10 and 6.5/10) are replayed with SIMULATED comparator answers.

## Real run cr-40695f8e3f9c (2026-11-15), composition step (second real attempt of the day, stopped, 0.0836 EUR, no image, settled in the registry)
- `remax-cr-40695f8e3f9c-compose-first-answer.json`: the FIRST composition of that run (the model's own text, re-encoded as UTF-8; a few accents were already lost in the archive). It holds the model number in the idea, "5 cm" in the structure and in a phone element, and a café that rests on a table, a phone beside and a headline that repeats the cable. It has NO `buy_reason` and NO phone choice (those two decisions did not exist yet): test/creator-ad-phone-and-reason.test.js adds SIMULATED values for them and replays the text. Used to show how the code now treats that text; it shows nothing about what a real model answers to the new instructions.
