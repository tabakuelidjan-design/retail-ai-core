# Xiaomi validation: the Remax case (10 minutes)

Goal: prove on the real phone, with the real stored case, that Terrain, Expert and Salon show the same facts and that the false "MOQ 11" is gone. **Do not repair anything before step 1.**

## 1. Preserve the original (computer, before any repair)
1. In the folder where `npm run sourcing:phone` runs: `grep -l Remax data/local/sourcing/*.json` → the case file(s).
2. `mkdir remax-original && cp <file> remax-original/ && sha256sum remax-original/*` → keep the hashes.
3. On the phone, optional second copy: menu → **Export** (downloads `nordla-case-<id>.json`).
4. `node tools/case-audit.mjs remax-original/<file> --trace MOQ > remax-before.txt` (read-only) and send me `remax-before.txt` (or the file). It prints every MOQ entry, its mode, timestamp and candidate: this is what settles *where 11 came from*.

## 2. Phone (online once, so the new app loads)
Open the pairing link, reload twice. The Salon fiche must show a **Faits** tab (cache `field-3`).

## 3. Check (tick each)
| # | Do | Expected |
|---|---|---|
| a | Salon → Remax → **Faits** | Prix 11 USD, MOQ, Puissance 45 W, Sorties 4, Couleurs, Stock « en stock »; each with source and version. A red « Ancienne correction » block if the 11 is still recorded |
| b | Menu → **Mode expert** → Quick | price 11, MOQ equal to the Faits value |
| c | Menu → **Mode terrain** → évaluation / résumé | same MOQ and price |
| d | Back to Salon → **Annuler cette correction** | MOQ 24 « dit par le fournisseur », the history still lists the cancelled 11 (« annulée ») |
| e | Repeat b and c | still the same values everywhere |
| f | Salon Faits → **Corriger** MOQ → 25, then Terrain, then **Annuler ma correction** | 25 everywhere, then 24 everywhere |
| g | Close the app completely, airplane mode, reopen | same values, no error |

## 4. After repair (computer, phone online)
Wait ~10 s online, then `node tools/case-audit.mjs data/local/sourcing/<file>`: MOQ 24, `FINDINGS (0)`, MOQ history shows `11 … VOIDED`. Send me the output.

## Limits to know
* The phone and the computer **do not share live state**. Each browser keeps its own copy; the phone pushes its cases to the server, and the server never pushes to another browser. A change made on the computer's browser is not seen on the phone.
* Check 3-b/3-c are the same device, three modes: that is what is guaranteed.
* The three guided E2E failures (first-screen photo/name card, layout "over: 2") are unrelated to facts; confirm by eye that the Terrain first screen has no sideways scroll on the Xiaomi.

## PASS
a–g as written, the audit after repair shows MOQ 24 and no finding, and the original copy still has its original hash.
