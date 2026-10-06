# China Sourcing - portail de fidélité visuelle (390 px) : comparaison capture ↔ mockup

- **Date** : 2026-10-06 - **Branche** : `feature/china-sourcing-field-mode`
- **Ce qui a été fait** : six écrans **statiques**, données **fictives**, dans `docs/fidelity-portal/` (`index.html`, `portal.css`, `portal.js`). Aucun micro, aucun moteur de transcription, aucune traduction, aucun provider, aucune lecture du dossier, aucun accès réseau. L'application (`src/`) n'est pas modifiée.
- **Références** : le mockup joint (spécification visuelle normative) et la décision G1 corrigée : **Voice First** est le parcours principal ; le mockup reste la référence de composition, hiérarchie, finition, espacements, carte produit, fil et Évaluation d'achat.
- **Voir** : `docs/fidelity-portal/shots/` : `s1.png` à `s6.png` (390 × 844, ×2), `s6-full.png` (Évaluation d'achat en entier), `overview.png`, `compare-s3-vs-mockup.png` (mockup | portail | superposition 50 %), `compare-s6-vs-mockup-panel.png` (panneau « Évaluation d'achat » du mockup | état 6), `mockup-phone-crop.png`. Pour ouvrir le portail : ouvrir `docs/fidelity-portal/index.html` (vue d'ensemble) ou `index.html#s1` … `#s6` (un écran à la fois).

## 1. Les six états

| # | État | Contenu (fictif) | Écart voulu par rapport au mockup |
|---|---|---|---|
| 1 | Avant conversation | en-tête de marque + cloche, carte produit (photo, nom, catégorie, pastille « Nouveau »), **gros bouton marine 🎙️ Démarrer la conversation** dans la zone du pouce, barre à trois pastilles | l'action micro n'existe pas dans le mockup (G1 corrigée) |
| 2 | Conversation active · écoute | bandeau produit compact, fil de messagerie (fournisseur en chinois avec ligne EN dérivée « traduction automatique », propriétaire à droite, fournisseur en anglais, **pièce jointe PDF**), rangée « 3 éléments à confirmer », **dock « Écoute en cours »** (point rouge, durée, « sur ce téléphone », pause, terminer) | dock d'écoute : nouveau (Voice First) |
| 3 | Suggestion ASK NEXT | état 2 + **une** carte beige : « ASK NEXT », *Can we mix different colours in the same carton?* en gros, *FR — Peut-on mélanger…* discret, chevron | carte plus haute que dans le mockup (contenu EN + FR) |
| 4 | Alerte critique | bandeau ambre « MOQ : avant 50, maintenant 100 · Contradiction à clarifier », fil avec la phrase contradictoire entourée d'ambre, dock d'écoute toujours actif | alerte absente du mockup |
| 5 | Fin de conversation | feuille « Conversation terminée · 12 min · enregistrée sur ce téléphone » : ce que j'ai compris (◌), ce qui manque (3 puces ambre), prochaine étape, **Tout confirmer (4)** / **Revoir un par un** | absent du mockup ; style repris du panneau « Évaluation d'achat » |
| 6 | Évaluation d'achat | titre, barre « 3 éléments à confirmer », frise de statut, fournisseur, informations clés (✓ / ◌), informations manquantes, prochaine étape | voir le point 4 ci-dessous |

## 2. Mesures (pas « ça ressemble »)

### 2.1 Palette : mockup mesuré (pixels de l'image) contre portail (valeurs CSS)
| Élément | Mockup | Portail |
|---|---|---|
| fond | `#f7f2ef` / `#f6f4f2` | `#f6f3ef` |
| cartes blanches | `#fcf8f5` / `#fafbf8` | `#fdfbf8` |
| bulle du propriétaire | `#e7e3e2` | `#e8e4e1` |
| pastille active (marine) | `#11223a` | `#10223b` |
| pastilles inactives | `#ebe6e6` | `#ece8e5` |
| carte suggestion | `#f6eae0` | `#f7ebe0` |
| pastille « En discussion » | `#d3e8d5` | `#d4e8d6` |
| point rouge de la cloche | `#dd4939` | `#dd4939` (identique) |
| texte secondaire | `#64605d` | `#64605d` |
Écarts : 1 à 2 niveaux par canal, invisibles à l'œil ; l'image du mockup est compressée (bruit de ±3).

### 2.2 Géométrie (barre du bas, la seule zone identique dans les deux)
| Mesure | Mockup (pixels de l'image, échelle ≈ 1,02) | Portail (DOM exact) |
|---|---|---|
| pastille active : largeur × hauteur | 116 × 61 → ≈ 114 × 60 | 115,3 × 62 |
| espace entre pastilles | 8 | 8 |
| carte suggestion : largeur | 363 → ≈ 356 | 354 |
| marge latérale des cartes | ≈ 18 | 18 |
| rayon des pastilles / cartes | ≈ 22 / ≈ 20 | 22 / 18 à 20 |
Écart maximal mesuré : 2 px.

### 2.3 Comparaison composant par composant (mockup ↔ portail)
| Composant | Verdict | Détail |
|---|---|---|
| Barre du bas (3 pastilles, actif marine) | **identique** | dimensions et espacement mesurés ci-dessus |
| En-tête (« Nordla » serif + « China Sourcing » + cloche à point rouge) | **proche** | même hiérarchie ; la police serif de repli (Noto Serif / Georgia) n'est pas la police du mockup (inconnue), traits un peu plus larges |
| Carte produit | **proche** (état 1), **volontairement réduite** (états 2 à 4) | photo à gauche, nom en gras, catégorie, pastille d'état, chevron ; réduite en bandeau quand l'écran sert à la conversation |
| Fil de messagerie | **proche** | deux côtés, avatars, heures, doubles coches, bulles très arrondies ; bulles un peu plus étroites (292 px max) et texte 17 px (le mockup semble 16,5 px) |
| Pièce jointe | **proche** | icône PDF rouge, nom en gras, taille en brun, téléchargement |
| Carte suggestion | **même famille, plus haute** | 150 px contre 79 px : « ASK NEXT » + phrase anglaise 19 px + ligne française, au lieu de « Suggestion » + 2 lignes françaises ; sans bouton, avec chevron |
| Rangée « N éléments à confirmer » | **proche** | icône liste, texte en gras, chevron ; le mockup a un fond gris pâle dans la pastille, le portail une carte blanche |
| Panneau « Évaluation d'achat » (état 6) | **structure reprise** | titre sans empattement, barre ambre avec horloge, « Statut » + frise, « Fournisseur », « Informations clés » (étiquette grise, valeur à droite d'une colonne fixe), « Informations manquantes » (puces ambre), « Prochaine étape » (icône dans un carré gris) ; titres de section en casse de phrase, filets fins, **sans cartes internes** |
| Bannière d'alerte | **nouveau** | ambre, un seul message, chevron ; aucune modale |
| Dock d'écoute | **nouveau** | marine, même famille de couleurs que la pastille active |

### 2.4 Ce que la comparaison a corrigé avant cette présentation
La première version du panneau (état 6) utilisait de petits titres majuscules grisés et des cartes internes : écart net avec le mockup. Elle a été refaite (titres en casse de phrase, filets, pas de cartes, frise de statut, colonne de valeurs). Le dock d'écoute débordait sur deux lignes : refait. La suggestion et la rangée de confirmation se chevauchaient avec le dock : refait.

## 3. Écarts qui subsistent volontairement

1. **Photos** : le produit est une illustration vectorielle et les avatars des silhouettes (le mockup montre des photos de personnes). Les visages ne sont pas des données de l'application.
2. **Contenu de la suggestion** : anglais en premier + français discret (votre décision) : la carte est plus haute que celle du mockup.
3. **Carte produit réduite** dans les états 2 à 4 : sinon le fil n'aurait pas la place avec le dock ; dans l'application la carte complète défile avec le fil comme dans le mockup.
4. **Dock « Écoute en cours »** : élément nouveau (Voice First), absent du mockup.
5. **Langue du fil** : chinois/anglais d'origine + ligne dérivée EN, au lieu du français des deux côtés du mockup (l'original du fournisseur n'est jamais remplacé).
6. **« Vérifié »** (G3) : remplacé par « Fabricant · déclaré ◌ » ; **frise de statut** (G4) : les trois étapes suivantes sont grisées et inertes (aucun workflow d'achat derrière) ; **certifications** (G5) : « annoncées, non reçues » ; **« 8 ans d'activité »** : retiré (aucune donnée).
7. **Cloche** (G6) : présente avec son point rouge ; dans l'application elle ouvrirait les alertes déjà calculées, sans notification poussée.
8. **Icônes** : jeu de traits dessiné ici, formes proches mais pas identiques à celles du mockup.
9. **Cadre du téléphone et barre d'état (9:41)** : non reproduits (c'est le système, pas l'application) ; l'indicateur noir en bas est conservé comme repère.
10. **Ordinateur** (trois volets) : non reproduit (G11, second lot).
11. **Évaluation d'achat** : sur 844 px de haut, la rubrique « Prochaine étape » est à la limite ; la feuille défile (`s6-full.png` montre tout).
12. **Police** : non vérifiée sur Firefox Android (Noto Serif est présent sur Android, à confirmer sur votre téléphone).

## 4. Non vérifié

- Aucun test sur téléphone physique : captures produites avec Edge simulant 390 × 844 (×2).
- Les proportions fines du mockup (taille exacte des textes, police) ont été estimées sur une image compressée : l'incertitude est de quelques pixels.
- Aucun comportement : les écrans ne réagissent à rien. La suite (branchement sur le moteur déjà construit, puis capture audio) ne commence qu'après votre validation.

## 5. Ce que je vous demande

1. Dire, état par état, ce qui ne correspond pas à votre mockup (l'écart que vous voyez prime sur mes mesures).
2. Trancher : carte suggestion plus haute que dans le mockup (EN + FR) acceptable ?
3. Trancher : frise de statut grisée (inerte) ou seulement « Discussion en cours » ?
4. Valider le dock d'écoute (pause / terminer à droite) ou en proposer un autre.
