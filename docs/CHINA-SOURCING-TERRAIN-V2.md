# China Sourcing — Nordla Terrain (mobile UI V2)

Branch `feature/china-sourcing-mobile-ux-v2`, from `79c511f` (tip of `feature/china-sourcing-salon-reanalysis-fix`). Nothing is merged; `main` is untouched.
This file records what was built, what is reused, what the tests prove, and what is **not** proven (physical phone). Screenshots in `docs/terrain-v2/` are **real captures of the running app** in a Chromium engine at 390 px
(`SOURCING_E2E_SHOTS=<dir> npm run sourcing:e2e:terrain`); they are not photographs of a physical Xiaomi.

## 1. What the owner sees

One navigation, five entries (bottom bar): **Accueil · Fournisseurs · Noter · Visites · Plus**. No second tab system next to it (the old English tabs belong to the expert mode, reachable explicitly from *Plus*).

| Screen | Purpose |
|---|---|
| **Accueil** | search, four quick actions (Prendre une note, Nouveau fournisseur, Poser une question, Comparer), what is left to do (to confirm / answers awaited / contradictions), three recent files, "Reprendre" |
| **Fournisseurs** | cards (photo or initials, product, price, landed cost, evidence, follow-ups), live search, filters (Tous, À confirmer, En attente, Contradictions), `+` to select 2–5 offers to compare |
| **Fiche fournisseur** | hero + two actions (Prendre une note, Poser une question) + five tabs: **Aperçu** (short), **Infos** (what is proposed / confirmed, with sources), **Questions**, **Chiffres**, **Plus** (Négocier, Conformité et risques, Adéquation, Ce qui a changé, Historique, Échantillon, Mettre à jour l'offre, Relire, vue expert) |
| **Prise de note** | one box, who speaks (fournisseur / moi), modes Note · Photo · Audio · Document; the proposals read from what was just saved appear **on the same screen** |
| **Visites** | suppliers by day with what is left for each ("À poursuivre" / "Tous") |
| **Plus** | save / sync state in French, retry, export with a clear message, server token, recovery, offline matrix, saved comparisons, the vocabulary of states, guided and expert modes |

## 2. The priority defect: a question's answer is now recorded where the question is asked

Before: *Demander* offered Montrer / Posée / Répondue / Passer. "Répondue" only wrote `{state, at}` in the workspace, saved no text, changed nothing in the case; "Posée" made the question disappear from the list.

Now, on the question card (tab **Questions** of the right supplier):

1. **Montrer** (full screen, English and Chinese, as before) or **Copier** (English + Chinese, to paste in a WeChat chat);
2. **Noter la réponse** opens a box **inside the card**; **Enregistrer la réponse**;
3. the answer is stored as an item of the open conversation of **this case** (verbatim, speaker = supplier), linked to the question (`answersQuestion`), and logged append-only (`questionLog`: `SHOWN` then `ANSWERED`);
4. the extraction runs (same engine); the **proposals appear under the card** with « the supplier's words », a state word, and **Confirmer / Corriger / Rejeter**; a clear group can be confirmed in one deliberate tap; an ambiguous value (`10000mAp`) has **no** Confirmer: only Corriger / Rejeter;
5. the supplier sheet (Infos, Aperçu counters, Visites, Fournisseurs badges) updates without changing mode.

### Fixed vocabulary (never mixed)

`À poser` → `Posée · en attente` → `Réponse notée` → `Proposée · à confirmer` (or `Ambiguë · à corriger`) → `Confirmée` / `Corrigée par vous` / `Rejetée` → `Vérifiée`.
*Vérifiée* is reserved for an official source; a conversation can never produce it (a confirmed supplier statement stays `SUPPLIER_CLAIM`, a corrected value `USER_PROVIDED`). The screen never shows "Vérifiée" for anything the supplier said. Nothing becomes a fact without a tap of the owner.

## 3. What is reused unchanged (not rewritten)

Analysis engine, extraction (`core/extract/*`), prices / currencies / MOQ / models / specs, proposals + human confirmation, provenance, correction history (`FACT_CORRECT` / `FACT_REVERT`), risk and EU compliance rulebook, economics (landed cost, max price, margin, cash), comparison (`core/comparison.js`, `field-comparison.js`), questions (`ask-now`, `conversation-engine`), negotiation, cases and conversations, the offline shell (service worker), the sync protocol (optimistic revision, `409`), recovery / export. Detailed panes (`factsHtml`, `truthHtml`, `fitHtml`, `dealHtml`, `changedHtml`, `memoryHtml`, `negotiateHtml`, `compareHtml`, the offer review) are the existing renderers, placed one level down.

Core change (small, backward compatible): `CONVERSATION_ITEM` accepts `answersQuestion` / `questionText`; the engine reports `ANSWERED`. Cases without it behave exactly as before and still validate / export / recover.

## 4. Sync and backup

* A **state chip** on every main screen and a per-case state on the sheet. "Serveur à jour" is said only when the server verified it **and** nothing is waiting; a case says "Copie serveur à jour" only if the server returned its revision and it was not changed since; otherwise "Enregistré sur le téléphone" / "Envoi en cours" / "Hors ligne · n à envoyer".
* A conflict (`409`) found **in the background** now re-renders at once (it used to appear only on the next tap), shows a **banner on every main screen**, and a screen "Conflits de synchronisation" with both versions side by side, the counts, the **confirmed facts that differ** and **what was added only on each side**.
* **Garder les deux** (recommended): the server's version keeps its name, the owner's becomes « (ma copie) », photos included. **Prendre la version du serveur** needs a second explicit tap and **always keeps the owner's version** as « (ma version avant remplacement) ». No path loses a version.
* Export tells the owner the file name, its size and what it contains. An error raised by the shell is displayed (it was silently swallowed in the Salon).

## 5. Voice and photo: real capabilities only

* **Photo**: real. Captured with the phone camera input, downscaled, kept on the phone (IndexedDB) as the supplier's reference (name + position), attached to the right case at once, listed on the sheet. Nordla does not recognise the product from it, and says so.
* **Audio**: the existing on-device engine (Moonshine, English only). The Audio mode **checks `/voice/status`** and says "Dictée indisponible" with the reason when the model is not installed on the server; it never pretends to listen. Each dictated phrase stays *sans locuteur* until the owner says who spoke. **Not verified on a physical phone** (see §8).

## 6. Mock-up vs implementation

The validated image is a design reference, not a spec. Kept: structure, hierarchy, cards, bottom bar, large targets, Nordla identity. The official mark in the repository (`icon.svg`, navy square with the white N, navy `#14263f`, blue `#1d4f91`) is used; the orange cube of the image is **not** reproduced.

| Mock-up element | Implemented | Why / difference |
|---|---|---|
| 1 Accueil: search, categories, banner, recommended suppliers | search, quick actions, follow-ups, recent files | no categories, event banner or "recommended" list: there is no such data; none was invented |
| Bottom bar: Accueil, Exposants, Messages, Visites, Plus | Accueil, Fournisseurs, **Noter**, Visites, Plus | Nordla has no messaging; the central slot is the main field action |
| 2 Liste: photo, stand, tags (OEM/ODM/Certifié), ♡, sort | photo/initials, product, price, landed cost, evidence, follow-ups, `+` compare, search, filters | no OEM/ODM/Certifié tags (a certification is never shown without proof); `+` replaces ♡ because the useful action is comparing |
| 3 Fiche: hero, "À propos", main products, tabs Aperçu / Produits / Documents / Notes | hero, Aperçu, Infos, Questions, Chiffres, Plus | tabs follow Nordla's mission (facts with sources, questions, numbers); products and documents are inside Infos / Plus |
| 4 Prise de note: Note · Photo · Audio · Document, chips Prix · MOQ · Caractéristiques | Note · Photo · Audio · Document | the chips are replaced by the proposals read from the note, with their sources |
| 5 Visites: À venir / Visités / Favoris, by day | À poursuivre / Tous, by day | no schedule or favourites exist; the useful axis is "what is left to do" |

## 7. Tests (Node 24)

See `docs/REAL-PHONE-TEST-TERRAIN-V2.md` for the procedure and the results table at the end of the session report. Commands:

```
node --test test/sourcing-*.test.js          # unit, includes test/sourcing-terrain-v2.test.js
npm run sourcing:e2e:terrain                 # real browser, 390 + 375 px, the Sonny scenario (20 checks)
npm run sourcing:e2e:fieldv1                 # the existing Salon loop (offers, review, comparison, negotiation, offline), ported to the new screens
npm run sourcing:e2e                         # PWA, expert mode, conflict, layout (375 / 390 / 430)
```

The `uiGen` migration (`nordla.sourcing.uiGen = terrain-v2`) opens Terrain once on first launch of this generation; older e2e seeds were updated to stay in the mode they test. The service-worker cache name changed (`nordla-sourcing-terrain-v2-1`) so installed phones refresh.

## 8. Not verified / incomplete

* No physical Xiaomi: touch ergonomics, the real camera, the Android keyboard, one-hand reach and the home-screen install were **not** tested. The browser engine is Chromium on Linux.
* Voice: the code path (probe, start, pause, stop, attribution) is wired but **cannot be exercised without the speech model files** (git-ignored, ~65 MB). Needs a physical test.
* The detailed comparison page keeps its existing layout inside the new shell (not redesigned).
* No dark-mode review beyond the shared tokens.
* PDF reading still needs the server (online), as before.
