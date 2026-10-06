# China Sourcing - portail de fidélité V2 (390 px, statique)

Suite de `CHINA-SOURCING-FIDELITY-REPORT.md` (V1). Même portail statique `docs/fidelity-portal/`, données fictives, **aucun branchement** (ni moteur, ni micro, ni transcription, ni traduction, ni provider). Captures dans `docs/fidelity-portal/shots/` : `s1.png` à `s6.png`, `s6-full.png`, `overview.png`, comparaisons `compare-s1-vs-mockup.png`, `compare-s3-vs-mockup.png` (mockup | portail | superposition), `compare-s6-vs-mockup-panel.png`.

## 1. Vos huit points, un par un

| # | Demande | Fait | Mesure ou constat |
|---|---|---|---|
| 1 | Garder l'architecture des six écrans | oui | mêmes six états, même barre du bas, même dock |
| 2 | Écran 1 : garder l'espace, plus de présence pour la carte et la photo | oui | photo de 84 à 104 px (coins de 20 px, ombre douce), carte plus ample (rayon 26 px, ombre plus fine), titre 20 px sur deux lignes sans couper « 10 000 » ; **le vide n'est pas rempli** |
| 3 | Écran 3 : `ASK NEXT` nettement plus basse, anglais principal, français très discret | oui | **96,6 px de haut contre 150 px en V1** (le mockup : environ 77 px) ; « ASK NEXT » en petit repère avec l'ampoule, anglais 15,5 px sur deux lignes équilibrées, français 11,5 px sur une ligne grise |
| 4 | Retirer « N éléments à confirmer » du flux des écrans 2 et 3 | oui, **et de l'écran 4** | plus aucune rangée de confirmation dans la conversation ; seul le bandeau de contradiction (écran 4) reste immédiatement visible |
| 5 | Écran 5 recomposé : compris / manque réellement / contradictions-points critiques / prochaine étape, sans « Tout confirmer » | oui | quatre blocs ; **« Tout confirmer (4) » et « Revoir un par un » supprimés** ; une seule confirmation ciblée : la contradiction, avec « Garder 50 » / « Prendre 100 » ; le bas est une simple ligne « Ouvrir l'évaluation d'achat › » |
| 6 | Frise Discussion / Échantillons / Validation / Commande seulement dans l'Évaluation d'achat | oui | elle n'apparaît nulle part ailleurs |
| 7 | Dock d'écoute | conservé | inchangé (pause, terminer, « Écoute en cours », durée, « sur ce téléphone ») |
| 8 | Scanner / Ajouter et Écrire en alternatives secondaires | conservé | même barre à trois entrées, Conversation active |

## 2. Écran 5 : ce qui a changé et pourquoi
- **Ce que Nordla a compris** : trois lignes, chacune marquée ◌ (annoncé par le fournisseur), sans bouton.
- **Ce qui manque réellement** : deux points seulement (prix à 300 pièces, rapport UN38.3 du modèle exact), plus de liste exhaustive.
- **À clarifier** : le point critique (MOQ 50 puis 100) avec deux boutons ciblés. Si aucune contradiction n'existe, ce bloc n'apparaît pas.
- **Prochaine étape** : une phrase.
- Plus de formulaire, plus de bouton qui confirme en bloc.

## 3. Mesures V2 contre mockup (zones comparables)
| Mesure | Mockup (échelle ≈ 1,02) | V2 | V1 |
|---|---|---|---|
| carte suggestion : hauteur | 79 → ≈ 77 | **96,6** | 150 |
| carte suggestion : largeur / marges | ≈ 356 / 18 | 354 / 18 | 354 / 18 |
| pastille active de la barre du bas | ≈ 114 × 60 | 115,3 × 62 | 115,3 × 62 |
| espacement des pastilles | 8 | 8 | 8 |
Les couleurs de la section 2.1 du rapport V1 ne changent pas.

## 4. Écarts qui subsistent volontairement
1. La suggestion reste un peu plus haute que celle du mockup (+20 px) : deux lignes d'anglais plus une ligne française.
2. Photos et avatars : illustrations vectorielles, pas de photos.
3. Carte produit réduite en bandeau dans les écrans 2 à 4 (la carte ample n'est que sur l'écran 1).
4. Dock d'écoute : absent du mockup (Voice First).
5. Fil en chinois ou anglais d'origine avec ligne dérivée, au lieu du français des deux côtés.
6. Frise de l'Évaluation d'achat : les trois étapes suivantes sont grisées et inertes.
7. Écran 6 : « Prochaine étape » est à la limite des 844 px (défilement ; `s6-full.png`).
8. Pas de cadre de téléphone ni de barre d'état ; pas de vue ordinateur ; icônes dessinées ici ; police de repli (Noto Serif / Georgia).

## 5. Ce que la V2 laisse ouvert (à trancher, pas décidé par moi)
- **Où vit la confirmation** maintenant qu'elle a quitté le flux : dans la V2, un fait annoncé reste ◌ tant qu'il n'est pas confirmé ; les confirmations passent par le point ciblé de l'écran 5 et par l'Évaluation d'achat (barre « N éléments à confirmer », écran 6). Aucun compteur ne reste dans la conversation. Faut-il un signe très discret quelque part (par exemple sur le bandeau produit) ou rien du tout ?
- **Quand** une confirmation doit être ciblée à la fin : seulement les contradictions et les valeurs ambiguës ? Les faits propres restent-ils ◌ sans action ?
- **Accès à l'Évaluation d'achat pendant la conversation** : le bandeau produit (chevron) est prévu, à confirmer.

## 6. Non vérifié
Aucun test sur téléphone ; captures produites avec Edge simulant 390 × 844 (×2) ; proportions du mockup estimées sur une image compressée (quelques pixels d'incertitude).

## 7. V2.1 (décisions du propriétaire appliquées, pour le checkpoint visuel sur téléphone)

- **Aucun indicateur de confirmation dans la conversation** : confirmé, rien n'a été ajouté (pas de compteur sur le bandeau produit).
- **Bandeau produit entièrement tappable** (pas seulement le chevron) : ouvre l'Évaluation d'achat. Aucune autre action n'existe dans la carte, donc pas de conflit de tap.
- **ASK NEXT** : la lisibilité prime ; la phrase anglaise passe de 15,5 à **17 px** (comme les bulles), le français à 12 px ; la carte fait environ 100 px de haut (V1 : 150). Elle n'est plus réduite pour se rapprocher du mockup.
- **Sens des signes** (inchangé et rappelé dans l'Évaluation d'achat) : ✓ confirmé par l'utilisateur, jamais « vérifié » ; ◌ annoncé par le fournisseur, sans confirmation immédiate demandée ; les déclarations de documents (CE, UN38.3…) restent distinctes de « reçu », « correspondant » et « preuve acceptée ».
- **Visionneuse pour téléphone** (`index.html?view`) : une barre de six pastilles pour passer d'un état à l'autre, l'écran à sa largeur réelle ; quelques taps de navigation statique (bandeau produit vers l'évaluation, « Démarrer la conversation » vers l'écoute, bouton d'arrêt vers la fin, croix pour revenir, ligne « Ouvrir l'évaluation d'achat »). Rien d'autre n'est branché : aucun micro, aucune transcription, aucune traduction, aucun provider, aucun moteur.
