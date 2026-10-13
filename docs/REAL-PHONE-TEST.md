# REAL-PHONE-TEST - China Sourcing Field V1

Goal: one person, one phone, a real supplier text, the whole loop, no computer once it is running. Nothing is sent to any provider. Allow 20 minutes.

## Before you leave (on the computer, once)
1. Node 24: `node -v` must print v24.x. `cloudflared` installed (free quick tunnel, no account).
2. In the repository, on branch `feature/china-sourcing-field-v1`: `npm ci`, then
   `SOURCING_MERCHANT_ID=habb npm run sourcing:phone`
   (Windows PowerShell: `$env:SOURCING_MERCHANT_ID="habb"; npm run sourcing:phone`). The line `Merchant profile: habb` must appear. Without that variable the fit checklist says "profil non chargé".
3. Open the **pairing link** printed in the terminal ON THE PHONE (it holds your token: send it only to yourself). Add the page to the home screen. Keep the computer on while testing.
4. On the phone: menu **⋯** -> **Salon (comparer)**. Wait for "en ligne" once, so the phone caches the app and the merchant profile. Then you may go offline.

Have two real supplier quotes ready as text (a WeChat/e-mail/quotation paste). Supplier A = the one you update in step 12.

## The 15 steps (tick each; write what you saw if it is not as described)
| # | Do | Expected |
|---|---|---|
| 1 | Salon -> **+ Capturer**. Type a supplier name and the product. | Nothing else is required. |
| 2 | Paste supplier A's real quote in the text box (tab **Devis**, or **Chat** for a conversation). Quantity envisagée: your number. **Créer et importer**. | "Relire l'offre" opens. Your text is not lost. |
| 3 | Look at the extracted facts. | Each fact shows « the supplier's words » and "dit par le fournisseur". Absent things are listed as **inconnu**. Nothing says "vérifié". |
| 4 | **Tout confirmer** for the clear facts; on one fact tap **Corriger** (type the right value, OK); on one tap **Rejeter**. Resolve a contradiction if one is shown. | Confirmed = "validés"; corrected shows what the supplier said; rejected stays visible but applies nothing. A comma price (6,8) must ask for a correction. |
| 5 | **Terminé** -> tab **Fournisseur**. | Facts with ◐ (supplier claim) / ? (unknown) / ≈ (estimate); six risks; "Comportement du fournisseur". |
| 6 | Tab **Fit**. | 13 lines, each with a reason; many "inconnu" is normal (profile values not set yet: see HABB-SOURCING-PROFILE-INPUTS.md). No percentage. |
| 7 | Tab **Plus** -> **Vos chiffres**: selling price TTC, target margin %, freight total, duty %, exchange rate. Save. Tab **Chiffres**. | Landed cost, maximum purchase price, margin, cash. A blank field stays **inconnu** (no invented number). |
| 8 | Back to Salon. Capture supplier B with its own real quote (steps 1-4 quickly). On the Salon list tap **+** on A and on B. | Both cards turn selected; "Comparer (2)". |
| 9 | **Comparer (2)**. | Résumé first, then cards, differences, risks, chiffres, preuves, à demander, recommandation. "Aucun gagnant au seul prix". Tap **Enregistrer cette comparaison**. |
| 10 | Open A -> **Demander**. | 2 to 5 questions, English + Chinese, and the note that the Chinese is not native-reviewed. **Montrer** gives a full-screen card to show the supplier. |
| 11 | A -> **Négocier**. | Offre actuelle, objectif, limite (prix d'achat max); if numbers are missing it says *données insuffisantes* and what is missing. No action is taken for you. |
| 12 | A -> **Mettre à jour l'offre**: paste a revised quote (change the price, MOQ or lead time) -> import -> **Tout confirmer** -> **Terminé**. | The old offer is kept ("offre 1" and "offre 2"). |
| 13 | Tab **Changements**. | Old -> new for each term that moved, landed cost old -> new, recommendation old -> new ("recalculée avec ce qu'on savait alors"). |
| 14 | Close the browser/app completely (swipe it away). Optional: airplane mode. Reopen it from the home screen. | It opens where you were (or Salon with a **Reprendre** banner). |
| 15 | Check A and B, the saved comparison, offers 1 and 2, your confirmed/corrected facts, the numbers you typed, the "asked" marks. | Everything is as you left it, also with no network. |

## Pass / fail
PASS only if steps 1-15 all behaved as written, nothing was lost or silently changed, no number appeared that you did not enter or the supplier did not state, and nothing said "vérifié" about a supplier's word.
Write down for each failure: step number, what you pasted (or a screenshot), what you expected, what you saw. A wrong extraction of a real quote is the most valuable thing you can send back.

Not tested by this flow (by design): PDF reading (needs the computer, online), voice, photo recognition, any provider.

## Optional: check one real quote from the computer (read-only)
`node tools/real-quote-check.mjs quote.txt [--source quote|chat] [--supplier NAME] [--product NAME] [--qty N] [--price P --vat V --target T] [--freight F] [--duty D] [--fx R] [--merchant habb]`
Runs your pasted quote through the same pipeline and prints extracted facts with provenance, what stayed unknown, conflicts, deal numbers, evidence completeness, recommendation, ASK NEXT, negotiation and fit. Only the numbers you pass are used; nothing is stored and no network call is made. Send back any fact it got wrong.
