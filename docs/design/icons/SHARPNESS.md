# Nordla — contrôle de netteté des pictogrammes

Tailles contrôlées : 16 px, 24 px, 32 px, 48 px, 64 px, 128 px, 256 px. **Aucun fichier n'est vectoriel** : tous les pictogrammes sont des PNG. Un PNG est net **jusqu'à sa taille native** ; au-delà il est agrandi (flou) et signalé comme tel. Aucune image bitmap agrandie n'est présentée comme vectorielle.

| Ensemble | Fichiers | Nets jusqu'à (px) |
|---|---|---|
| Pack officiel V1 (validé) | 46 | 256 px : 46 |
| V2 conformes (validation en attente) | 34 | 256 px : 34 |
| Candidats techniques (fond nettoyé, résolution native conservée) | 75 | 48 px : 1, 64 px : 67, 128 px : 6, 256 px : 1 |

Lecture : les écrans affichent 16, 20 et 28 px CSS (soit 32 à 84 px sur écran 2× / 3×). Les 80 icônes V1 et V2 (256 px) sont nettes à toutes ces tailles. Les candidats techniques issus de fichiers basse résolution (48–64 px natifs) sont nets pour **16 à 24 px CSS** (32–48 px sur écran 2×) et **flous au-delà** : ils ne conviennent pas aux grandes tailles ni aux écrans 3×.

Planches : `sharpness/sheet-*.png` (chaque ligne = une icône à 16, 24, 32, 48, 64 px, rendue depuis le fichier source).
