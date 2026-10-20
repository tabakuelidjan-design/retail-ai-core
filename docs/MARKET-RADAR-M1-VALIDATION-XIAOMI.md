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
| M13 | Cas avec deux variantes de prix différents (ex. goulot large / standard) | Après la taille, **une** carte « Quelle variante ? » avec les variantes réellement vues et leur prix médian ; jamais plus de 2 questions en tout |
| M14 | Taper la vraie taille dans « Autre » (ex. « 64 oz ») ; puis « beaucoup » | « 64 oz » → « taille 1,89 L », 0 $ ; « beaucoup » → message « Taille non comprise », rien d'enregistré |
| M15 | « Je ne sais pas » aux deux questions | Un prix **par groupe** (jamais une médiane mélangée) ; plus aucune question |
| M16 | Résultat final | « Aucun produit exact trouvé » écrit s'il y en a aucun ; chaque annonce porte « disponibilité non vérifiée » ; accessoires et lots dans leurs groupes à part (lots : prix à la pièce marqué estimation) |
| M17 | Un produit dont le nom est seulement la marque (ex. « Hydro Flask »), avec des gourdes **et** des gobelets de voyage dans les résultats | **Une** carte « De quel type de produit s'agit-il ? » (gobelet de voyage / gourde-bouteille) avec les prix médians observés ; aucune médiane tant qu'elle est là ; après la réponse, les annonces de l'autre type sont listées « autre type de produit » et hors du prix |
| M18 | Une annonce sans le mot « bouteille » mais avec la marque et la taille (ex. « … Wide Mouth 710 ml ») | Classée « Correspondance probable », confiance faible, raison « type de produit non précisé dans le titre » ; jamais « exacte » |
| M19 | « Préciser la taille, le modèle ou la variante » (section repliable sous la question) : taper « beaucoup » en taille, puis « 64 oz », puis un modèle | « beaucoup » → « Non compris : taille » et rien d'enregistré ; « 64 oz » → « taille 1,89 L », **0 $**, aucune question automatique consommée ; la nouvelle taille remplace l'ancienne ; le tout survit à la fermeture de l'application |
| M20 | Question de type puis réponse | Le prix médian annoncé sur la carte est **le même** que celui des « Prix indicatifs par famille — pas un prix de référence » affichés après ; aucune annonce n'est « probable » sur la seule base de la marque et du type ; aucun rapport avec le prix fournisseur sur un prix indicatif |
| M21 | Produit dont la marque est connue (ex. Hydro Flask) : regarder les prix indicatifs ; puis un produit **sans marque** | Marque connue : « seules les annonces qui la nomment sont retenues ; N annonce(s) d'autres marques sont laissées de côté », aucune autre marque dans l'indicatif, les écritures « Hydroflask / HYDRO-FLASK » comptent ; marque inconnue : « Marque inconnue : ces prix peuvent mélanger plusieurs marques » |
| M22 | Produit dont la marque vient d'un **code-barres** ou d'une **photo** (marque lue par une machine) | Bandeau « Marque à confirmer » + « les prix peuvent mélanger plusieurs marques » ; aucune annonce écartée pour cette marque ; « Confirmer la marque » → « Précision confirmée par vous : marque X », crédit DataForSEO **inchangé**, puis seules les annonces qui nomment la marque sont retenues |

## Limites connues (reportées, à ne pas confondre avec un échec)
- Une annonce sans nom de contenant ni taille (ex. « Hydro Flask Wide Mouth ») reste « similaire » et hors prix indicatifs : seule une variante ou une taille confirmée la promeut, avec au moins 3 annonces homogènes (H5).
- « Préciser » ne permet pas de saisir le type de produit ; la question de type est une liste fermée (H6).

## Critères d'arrêt
Une photo envoyée sans carte d'accord ; une dépense à la réponse ; une valeur présélectionnée ; une médiane affichée avec < 3 annonces comparables ; une annonce d'une autre marque ou taille dans la médiane après confirmation.

## Compte rendu
Pour chaque étape : OK / écart / stop, heure, capture, crédit avant/après, nombre de photos envoyées. Les faux classements relevés en M5 servent à calibrer les règles (titres réels), pas à les assouplir.
