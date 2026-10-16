# Clôture de la phase 1 du chantier D (2026-10-17)

Branche `feature/chantier-d-branding-creative-pole`. Rien de fusionné, publié, déployé ni dépensé. Aucun fournisseur connecté. Aucun fichier de E, Sourcing, Finance, Stock/Achat ni Parle à Nordla modifié.

## 1. Corrections réalisées
| Demande | Fait |
|---|---|
| Registre A (vouvoiement) | visuels **et** légendes de D1-D3 en vouvoiement ; tutoiement retiré. **Correction d'une erreur de ma livraison précédente** : le « paquet A » avait des visuels en vouvoiement mais des légendes en tutoiement ; corrigé et vérifié sur `proposals.json` |
| « Exemple de personnalisation » sur D3 | ajouté sur l'image (nouvelle version d'asset, v3) |
| Plus de feuillage décoratif | la composition n'en ajoute aucun ; le contrôleur refuse ces mots (cœur, feuille, branche, or, halo…) sauf si le produit les porte. Le motif du rendu « MILA » est dans l'illustration de la coque (voir limites) |
| Rendus de coques : démonstration interne | chaque proposition de D commence par « DÉMONSTRATION INTERNE : droits non confirmés, ne pas publier » ; assets étiquetés `internal-demo`, droits `UNVERIFIED` |
| « Personnalisées dans notre atelier à Namur » | employée dans D3 (« Des coques personnalisées dans notre atelier à Namur ») ; D1/D2 gardent « Venez en boutique à Namur » |
| Pas de contrôle systématique des fichiers affirmé | nouvelle règle : `lintProcessClaims` refuse toute promesse de ce type (D le refuse dans ses propres propositions) ; le contrôleur de la réserve la signale |
| Prix boutique et prix web | un prix confirmé porte son **canal** : D1, D2 et la légende disent « prix en boutique » / « 25 € en boutique » ; `lintPriceChannel` refuse un prix sans canal et refuse tout texte « en ligne » tant que l'entrée `coque-25-web` n'existe pas dans le registre de E |
| `alternative_to` | proposition + patch (`PROPOSITION-E-ALTERNATIVE-TO.md`) |
| Mode IA « fond uniquement » | conservé, seul mode actif (`AI_MODE`) ; architecture des modes futurs documentée (§9 de `CREATIVE-AI-ARCHITECTURE.md`) |

## Prix web : résolu par la valeur Shopify
**Résolu, par la valeur vérifiée sur Shopify.** Lecture directe (Admin GraphQL, lecture seule, 2026-10-17) : les **83 coques** de la collection « Coques personnalisées », une variante chacune, sont à **25,00 € en ligne**, sans prix barré. Le prix web est donc 25,00 €, comme le prix boutique ; aucune autre valeur n'est conservée. Les deux sont deux faits distincts, datés et sourcés (`docs/chantier-d/e-proposals/confirmed-facts-prices.json`) : **E doit les enregistrer** ; tant que `coque-25-web` n'y est pas, aucun texte ne cite le prix en ligne.

## 2. Tests exécutés
Locaux (Windows, Node 24) : D 41 tests : 40 réussis + 1 ignoré volontairement en local quand E n'est pas patché (AT-3) ; 9/9 contre le E patché (asset-library 9, studio-compose 11, social-compat 6 dont 2 contre E, habb-reserve-check 2, studio-ai-layer 10, social-alternative-to 3) · E patché sur copie de travail : 66/66 · mutations : gardes retirées → tests en échec.
GitHub (commit final `463deb7`, Node 20 et 24, succès) : suites D 38/38 contre E tel qu'il est, 9/9 contre E patché, 507/507 modules existants, suite sociale de E avec le patch 65 réussis + 1 ignoré (test de E conditionnel), 0 échec, 0 test D ignoré. Détail et limites : `CI-COUVERTURE.md`.

## 3. Dépendances restantes avec E
1. **Adopter `alternative_to`** (patch prêt, 66/66, s'applique sans conflit sur `879198d`). Tant que ce n'est pas fait, E laisse approuver deux variantes ; la seule protection active est la note « ne publier qu'une des deux » et la vigilance du propriétaire.
2. Registre de faits confirmés de E : y ajouter les deux entrées datées et sourcées proposées (`confirmed-facts-prices.json`), dont `coque-25-web` (relevé Shopify du 2026-10-17).
3. Aucune publication réelle possible chez E (aucun compte connecté) : à régler par E / le propriétaire.

## 4. Limites
- **Artistiques** : D1, D2, D3 sont conformes aux contrôles mesurés mais **non qualifiées premium** (voir `revue-D1-D3/REVUE.md`). Les rendus de coques sont brillants et saturés (aspect « rendu IA ») ; le motif feuillage de MILA est dans le rendu (autorisé pour démonstration interne seulement). Aucune photo HABB n'existe.
- **Réserve éditoriale** : le contrôleur de D relève des passages à traiter par son auteur (non modifiés par D) : prix « 25 € » sans canal (P01, S10), promesses de contrôle de cadrage avant impression (P05, V2, S08), un texte alternatif manquant (S02).
- **Techniques** : le fournisseur IA est un double de test ; le journal de versions est en mémoire ; pas de vérification automatique d'absence de texte/personne dans une plaque générée ; la CI ne couvre pas la suite complète du dépôt ni le décodage JPEG par Pillow ; le patch E peut cesser de s'appliquer si E avance (la CI de D échoue alors explicitement).

## 5. Statut exact
- **Prêt pour intégration (code)** : oui pour `src/asset-library`, `src/studio-compose`, `tools/habb-*`, tests et workflow de D : additifs, isolés, CI verte sur Node 20 et 24, aucun fichier d'un autre chantier modifié. La fusion reste à décider par le propriétaire.
- **Prêt pour publication (contenus)** : **non**. Droits des rendus non confirmés, aucune photo, visuels non approuvés, prix web à clarifier, `alternative_to` non adopté par E.
