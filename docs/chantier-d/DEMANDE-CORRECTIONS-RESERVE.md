# Demande de corrections à l'auteur de la réserve éditoriale (`reports/editorial-14j/`)

Date : 2026-10-17. **Aucun fichier de la réserve n'a été modifié par D.** Ce sont des propositions de remplacement à appliquer (ou refuser) par son auteur ; la décision finale est celle du propriétaire. Relevé par `tools/habb-reserve-check.mjs` (lecture seule).

Deux règles motivent les corrections (décisions du propriétaire, 2026-10-17) :
1. **Un prix dit son canal.** « 25 € » en boutique : le texte doit le dire (« 25 € en boutique »). Le prix en ligne (relevé Shopify le 2026-10-17 : 25,00 € sur les 83 coques) ne peut être cité qu'une fois l'entrée de faits datée et sourcée `coque-25-web` enregistrée dans E.
2. **Aucune affirmation de contrôle systématique des fichiers avant impression** tant que le processus n'est pas confirmé. Seul fait établi (brand snapshot ev-07) : l'équipe aide pour la photo, le texte et la mise en page.

| Élément | Champ | Texte actuel (extrait) | Problème | Proposition de remplacement |
|---|---|---|---|---|
| **P01** | `legende` (A) | « Coque personnalisée : 25 €. » | prix sans canal | « Coque personnalisée : 25 € en boutique. » |
| **P01** | `legende_variante_b` | « 25 €. » | prix sans canal | « 25 € en boutique. » (le registre B n'est plus retenu : à retirer ou aligner) |
| **S10** | `legende` (écran 3) | « Quel prix ? Coque personnalisée : 25 €. » | prix sans canal | « Quel prix ? Coque personnalisée : 25 € en boutique. » |
| **P05** | `legende` (A) | « cadrage vérifié par notre équipe avant impression » | promesse de contrôle systématique | « Notre équipe vous aide pour la photo, le texte et le cadrage. » |
| **P05** | `legende_variante_b` | « l'équipe vérifie tout avant l'impression » | idem | à retirer (registre B abandonné) ou « On t'aide pour la photo, le texte et le cadrage. » |
| **V2** | `legende` | « Notre équipe vérifie le cadrage avant impression. » | idem | « Une photo, une plaque : notre équipe vous aide pour le cadrage. » (et le script vidéo V2 à relire dans le même sens) |
| **S08** | `legende` (écran 2) | « Cadrage vérifié avant impression » | idem | « On vous aide pour le cadrage » |
| **S02** | `alt_text` | (absent, visuel prêt) | texte alternatif manquant | « Story HABB : « Photo · Prénom · Message ». Une coque de téléphone personnalisée avec le prénom MILA et un motif graphique, présentée seule sur fond blanc ; mention « Création directement en boutique », Rue de Bruxelles 18, Namur. » |

Observations sur S02 (non demandées, à titre d'information, sans proposition de modification) : le visuel est sur un fond sable ; le rendu de coque « MILA » porte un motif de feuillage dans son illustration (règle du propriétaire : pas de feuillage décoratif dans les futures compositions ; le rendu existant est en démonstration interne tant que ses droits ne sont pas confirmés).

Autres éléments **à ne pas confondre** : P03 (gourdes) et le délai « environ 5 minutes selon le modèle et la disponibilité » ne sont pas concernés ; le propriétaire a confirmé que les gourdes sont personnalisables (Q4 de la réserve en partie levée).

Vérification : après correction, `node tools/habb-reserve-check.mjs reports/editorial-14j/posts.json` doit afficher « no problem found by the deterministic checks » (code de sortie 0).
