# Couverture réelle de la CI de la branche D

Date : 2026-10-17. Source : API publique GitHub (étapes, annotations) du workflow `chantier-d-creative-pole`. Les journaux détaillés ne sont pas lisibles sans authentification : les nombres ci-dessous viennent d'annotations que le workflow écrit lui-même.

## Ce que la CI a réellement exécuté (run 38935051685, commit `05f736d`, Node 20 et Node 24, succès sur les deux)

| Groupe | Fichiers | Tests | Réussis | Ignorés |
|---|---|---|---|---|
| Suites D : `asset-library`, `studio-compose`, `social-compat`, `habb-reserve-check`, `studio-ai-layer` | 5 | 36 | 36 | **0** |
| Modules existants : `branding*`, `marketing*`, `creative-e2e*` | 28 | 507 | 507 | **0** |

Le workflow **échoue** si un seul test des suites D est ignoré : les tests de compatibilité avec le vrai code de E (SE-1, SE-2) sont conditionnels (ils s'ignorent sans checkout de E). Ils ont donc bien tourné sur GitHub, avec la branche `feature/social-publishing-e` extraite à côté.

## Historique honnête des runs
- `7ad031e` (run 38925612718) : succès, mais **les nombres de tests n'étaient pas observables** ; ce run ne prouve pas que les tests conditionnels ont tourné. Remplacé par les runs instrumentés.
- `ea4aed4` (38934344905) : échec, **fichier de workflow invalide** (une fin de ligne glissée dans un argument) : aucun job lancé. Cause : je n'avais pas validé le YAML avant de pousser.
- `c44842b` (38934556599) : Node 24 vert ; Node 20 en échec **à cause de mon garde-fou** qui ne lisait que le format de résumé de Node 24 (faux échec, pas un test ignoré).
- `05f736d` : corrigé, vert sur les deux versions.

## Ce qui n'est couvert qu'en local (pas par la CI de cette branche)

| Vérification | Pourquoi local seulement |
|---|---|
| Décodage du JPEG par Pillow (test SC-1) | le runner `ubuntu-latest` n'a pas Pillow (annotation « Pillow ABSENT ») : sur GitHub, SC-1 vérifie les en-têtes, la taille et le déterminisme, pas le décodage. Décodage vérifié localement (PSNR ≈ 49 dB sur une image d'essai) |
| Tests d'intégration inter-modules `integration-*` | non inclus dans ce workflow ; ils tournent sur `integration/**`. Exécutés en local (554/554 le 2026-10-16 avec les groupes ci-dessus) |
| Suite complète du dépôt | ne tourne pas sur cette branche (un push sur `feature/chantier-d-**` ne la déclenche pas) |
| Construction des démonstrations sur les vrais fichiers HABB, dossier de revue, import dans le service réel de E de la **vraie réserve** et des variantes de D | dépendent de fichiers privés (le dépôt est public) |
| Windows | la CI est Linux uniquement ; 8 tests `sourcing-*` échouent sous Windows sur la base d'origine (chemin `C:\C:\`), sans lien avec ce travail |

## Ce qu'aucune CI ne couvre
- La **qualité visuelle** (aucun test automatique ne juge le beau) ; les contrôles mesurés sont des garde-fous, pas un jugement.
- Les **tests de E eux-mêmes** (ceux de sa branche ; non lancés par ce workflow).
- Tout appel à un fournisseur d'images : aucun n'existe.

## Lecture
La CI de la branche D couvre ses propres suites et trois groupes de modules existants, sur Node 20 et 24, sans test ignoré. Elle ne remplace ni la suite complète ni le jugement humain, et la compatibilité avec E n'y est prouvée que contre la branche E telle qu'elle était au moment du run.
