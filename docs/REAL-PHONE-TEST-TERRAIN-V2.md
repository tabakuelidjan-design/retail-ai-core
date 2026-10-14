# REAL-PHONE-TEST — Nordla Terrain V2 (Xiaomi / Android)

Goal: one person, one Android phone, the Sonny scenario end to end. Nothing is sent to any AI provider. Allow 20 minutes.
Everything marked "browser-tested" below passes in a Chromium engine at 390 and 375 px; **only this procedure proves it on the physical phone** (touch, camera, keyboard, one hand, home-screen install).

## Before you leave (on the computer, once)
1. `node -v` prints `v24.x`. Branch `feature/china-sourcing-mobile-ux-v2`: `git fetch && git checkout feature/china-sourcing-mobile-ux-v2 && npm ci`.
2. `SOURCING_MERCHANT_ID=habb npm run sourcing:phone` (Windows PowerShell: `$env:SOURCING_MERCHANT_ID="habb"; npm run sourcing:phone`). `cloudflared` installed (free quick tunnel).
3. Open the **pairing link** printed in the terminal **on the phone** (it holds your token: send it only to yourself). Add the page to the home screen. Keep the computer on.
4. The first launch of this version opens **Nordla** (bottom bar: Accueil · Fournisseurs · Noter · Visites · Plus). If an old version was installed, close and reopen it once: the cache name changed so it refreshes.
5. Wait until the top-right chip says **Serveur à jour**, then you may go offline.

## The 14 steps (tick each; write what you saw if it is not as described)
| # | Do | Expected |
|---|---|---|
| 1 | Accueil → **Nouveau fournisseur**: `Sonny` / `batterie externe` → **Créer et prendre une note**. | The note screen opens with **Sonny** and the product on top. |
| 2 | In the box type: `prix 12$, MOQ 60, puissance 10000mAp. variante 4 couleur blanc, blue, rouge et noir. puissance 45W. nom de Modele AB521` → **Enregistrer la note**. | "8 informations proposées : rien n'est encore confirmé". Each card shows the supplier's words, « Proposée · à confirmer ». The box is empty again. Capacity says **Ambiguë · à corriger** and has **no Confirmer** button. |
| 3 | **Confirmer les 6 informations claires** (top of the list). | Those become *Confirmée*. The **currency** (read from "$") and the **capacity** stay undecided. |
| 4 | Capacité → **Corriger** → `10000 mAh` → OK. Currency → **Rejeter** (or Confirmer if it is really USD). | *Corrigée par vous* « le fournisseur disait « 10000mAp » ». *Rejetée* stays visible and changes nothing. Nothing says "vérifiée". |
| 5 | Back arrow → fiche → tab **Questions**. Pick **Fabricant** → **Montrer** (show the English / Chinese to someone) → **Fermer**. | Full-screen big text; Chinese marked as not native-reviewed. |
| 6 | Same card → **Noter la réponse**, type `Fabricant Shenzhen Sonny Electronics, delai 25 jours, FOB Ningbo` → **Enregistrer la réponse**. | The box is **inside the card**. A "Réponse enregistrée" block appears at the top of the tab with the proposals (Incoterm, Port, …) and Confirmer / Corriger / Rejeter. No other screen needed. |
| 7 | Tab **Infos**. | The confirmed values with source and date; the remaining proposals under "À confirmer". |
| 8 | **Noter** → mode **Photo** → take a photo of the product. | "Photo 1 enregistrée dans le dossier de Sonny"; the photo is listed on the fiche (Aperçu). |
| 9 | **Noter** → mode **Audio**. | Either a microphone button (if the speech model is installed on the computer) or "Dictée indisponible" with the reason. If it listens: speak English; each phrase is **sans locuteur** until you tap *Le fournisseur* / *Moi*. Report what happens either way. |
| 10 | Airplane mode ON. **Noter**: `Hors ligne: prix final 11.5 USD`. → Enregistrer. Open **Plus**. | The chip says **Hors ligne · 1 à envoyer** (never "à jour"). Airplane mode OFF → after a few seconds **Serveur à jour**. |
| 11 | (Optional, needs the computer) Open the same pairing link in a computer browser, edit Sonny there (add a note), then add a note on the phone. | A red **Conflit de synchronisation** banner appears by itself. **Voir les différences**: both versions, what each side added. **Garder les deux** keeps both (« (ma copie) »). The replace button asks a second question and says nothing is lost. |
| 12 | Create a second supplier, then **Fournisseurs** → `+` on both → **Comparer**. **Plus** → **Exporter le dossier actif**. | The comparison opens; "Aucun gagnant au seul prix". The export says the file name, its size and what it contains. |
| 13 | Close the app completely, reopen it. | It reopens where you were; an unsent draft in the note box is back. |
| 14 | **Plus** → **Mode expert** (then the ☰ button → **Nordla (écran principal)**). | The advanced screens still work; one tap brings you back. |

## Pass / fail
PASS only if steps 1–14 behaved as written, nothing was lost or silently changed, nothing proposed became a fact without your tap, and nothing said "vérifiée" about a supplier's word.
For each failure write: step number, a screenshot, what you expected, what you saw, and the phone model / Android / browser versions.
