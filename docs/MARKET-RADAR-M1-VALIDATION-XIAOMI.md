# Plan de validation Xiaomi — confirmation modèle/taille du radar de prix (M1)

Branche `feature/market-radar-proof-v0`. **Rien n'est déployé** : ce plan suppose un déploiement de test décidé séparément par le propriétaire (variables `DATAFORSEO_*` ; `GOOGLE_VISION_API_KEY` + `MARKET_PHOTO_ENABLED=1` seulement si l'on teste la photo ; relever `CACHE` de `src/sourcing/ui/sw.js`). A0 (`284648e`) reste intact.

## Budget et accords
- Une recherche : ≤ 0,02 à 0,05 $ (plafond serveur 0,05 $). Une photo à Vision : ≤ 0,0065 $, **accord du propriétaire pour chaque photo** (carte d'accord avec empreinte). Répondre à la question : 0 $.
- Prévoir au plus 6 recherches payantes et 3 photos pour toute la recette (≈ 0,3 $).
- Noter le crédit DataForSEO avant/après.

## Matériel
Une gourde avec étiquette lisible (idéalement une taille imprimée en oz et en litres), un produit avec **code-barres**, un produit sans marque lisible, un produit rare (peu d'annonces).

## Étapes (cocher, noter l'heure, capturer l'écran)
| ID | Action | Réussi uniquement si |
|---|---|---|
| M1 | Dossier avec photo de l'étiquette (marque + modèle lisibles) → « Prix en Europe » → vignette | Carte d'accord affichée **avant** tout envoi, avec taille, destination, coût max, empreinte. « Non » n'envoie rien |
| M2 | Accepter pour **cette** photo | Une seule analyse ; valeurs marquées « à confirmer » ; recherche automatique |
| M3 | Cas « taille incertaine » (dossier sans taille, annonces de plusieurs tailles) | **Une seule** carte « Une précision (une touche) » ; options avec leur preuve ; **aucune présélectionnée** ; « Je ne sais pas » présent ; **aucune médiane** affichée tant que la carte est là |
| M4 | Toucher une taille | Résultat en < 2 s, **sans nouvelle dépense** (crédit DataForSEO inchangé) ; ligne « Précision confirmée par vous » ; fourchette recalculée ; annonces écartées listées avec leur raison (taille différente / non indiquée / autre marque / lot / accessoire) |
| M5 | Vérifier à la main 3 annonces **retenues** et 3 **écartées** (ouvrir la page Google Shopping) | Les retenues sont bien le même produit et la même taille ; les écartées ne le sont pas. Noter toute erreur de classement (faux écarté / faux retenu) |
| M6 | Refaire sur un autre dossier avec « Je ne sais pas » | Aucun filtre ajouté ; texte « la fourchette peut mélanger plusieurs tailles » ; pas de nouvelle dépense |
| M7 | Produit rare (< 3 annonces comparables) | « Prix de référence non fiable », aucune médiane, prix listés un par un, pas de ratio fournisseur |
| M8 | Produit avec code-barres | Code-barres lu **sur le téléphone** (aucune photo envoyée) ; question seulement si nécessaire |
| M9 | Mode avion après un résultat | Le dossier garde le résultat et sa précision ; une réponse sans réseau échoue avec un message clair, **rien n'est perdu** ; au retour du réseau elle fonctionne |
| M10 | Tuer l'application puis rouvrir | Résultat, précision et annonces écartées toujours là |
| M11 | Rôle non propriétaire (VIEWER/ACCOUNTANT) | Ne peut ni lancer une recherche ni répondre (403) ; aucune photo n'est envoyée sauf par le propriétaire |
| M12 | 390 px réel | Aucun débordement horizontal, boutons ≥ 44 px, texte lisible en plein soleil |

## Critères d'arrêt
Une photo envoyée sans carte d'accord ; une dépense à la réponse ; une valeur présélectionnée ; une médiane affichée avec < 3 annonces comparables ; une annonce d'une autre marque ou taille dans la médiane après confirmation.

## Compte rendu
Pour chaque étape : OK / écart / stop, heure, capture, crédit avant/après, nombre de photos envoyées. Les faux classements relevés en M5 servent à calibrer les règles (titres réels), pas à les assouplir.
