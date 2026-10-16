# Proposition pour E : `alternative_to` dans `social-post-proposal.v1`

Date : 2026-10-17. **Proposition, pas une modification.** Aucun fichier de la branche E n'a été touché : le correctif est un patch (`docs/chantier-d/e-proposals/alternative-to.patch`), établi sur une copie de travail de E (base `879198d`), et appliqué par la CI de D à *son propre* checkout jetable de E. E décide de l'appliquer ou non.

## Le problème, prouvé
Sur E tel qu'il est (`879198d`) : une variante de D déclarant `alternative_to` est importée **sans** ce champ (E l'ignore) ; l'original (par exemple P01 de la réserve) et la variante peuvent être **approuvés tous les deux** :
`reserve:P01 : APPROVED | d:D1 : APPROVED` (vérifié par un script local sur le code de E). Rien n'empêche donc de publier D1 et P01 pour le même créneau.

## Le contrat
Champ **optionnel**, dans `social-post-proposal.v1` (le `schema` ne change pas ; un champ absent = aucune alternative, comportement actuel).

```jsonc
"alternative_to": ["habb-editorial-2026-10-16:P01"]   // 0 à 5 identifiants de proposition ; jamais soi-même
```

Sémantique :
- **Un créneau = une plateforme + un format** : la variante D1 (Instagram image + Facebook image) est exclusive de P01 *pour Instagram image* et *pour Facebook image*, séparément. Pas de cible correspondante chez l'original = pas de lien pour cette cible.
- **La relation n'est stockée que chez la variante**, sous forme d'identifiants de proposition, et **résolue à chaque contrôle** dans les deux sens : l'ordre d'import n'a pas d'importance, et une réimportation de l'original ne peut pas « l'oublier ».
- **Un créneau est « tenu »** par un post `APPROVED`, `SCHEDULED`, `PUBLISHING`, `PUBLISHED`, `VERIFIED` ou `PUBLICATION_UNKNOWN`.

## Ce que fait le patch
1. `post.js` : normalise `alternative_to` (liste ≤ 5, triée, sans doublon, pas soi-même). Le champ entre dans l'empreinte du contenu **seulement s'il est non vide** : l'empreinte de tout post sans alternative est **identique** à celle d'aujourd'hui, donc aucune approbation existante n'est invalidée (empreinte de référence testée, EX-8).
2. `intake.js` / `workflow.js` : le champ est livré à l'import et modifiable ; l'ajouter ou le changer modifie l'empreinte, donc **annule l'approbation de la variante qui le porte** (D ne peut pas modifier en silence ce que le propriétaire a approuvé : EX-4).
3. `exclusivity.js` (nouveau) : `rivalsOf`, `holdingRivals`, `exclusivityConflicts` (audit : toute paire de rivaux qui tiennent tous deux leur créneau).
4. `service.js` : `approve`, `schedule`, `retry` et `mark_manual_schedule` sont **refusés** (`SOCIAL_CONFLICT`, `EXCLUSIVE_VARIANT_ALREADY_HOLDS_THE_SLOT`, avec les rivaux nommés) tant qu'un rival tient le créneau ; le propriétaire révoque ou annule d'abord l'autre.
5. `publisher.js` (défense en profondeur) : avant de publier, si un rival est déjà publié (ou peut l'être), le post passe en `ERROR` `EXCLUSIVE_VARIANT_PUBLISHED` et **rien n'est envoyé**.

## Preuves
| Contrôle | Où | Résultat |
|---|---|---|
| 9 tests `social-exclusive` (EX-1 à EX-9) : exclusion dans les deux ordres, réimport inchangé, réimport de l'original modifié, lien ajouté après deux approbations, créneau par plateforme, planification et reprise gardées, publisher, empreinte historique inchangée, validation | copie de travail (local) et CI de D | 9/9 |
| Mutations : désactiver la garde du service → 6 tests échouent ; désactiver la garde du publisher → EX-7 échoue | local | les tests tuent les deux mutants |
| Suite sociale de E complète avec le patch | copie de travail (local) ; CI de D (étape « E own suite with the patch ») | 66/66 (57 existants + 9) |
| `git apply --check` sur une copie propre de `879198d` | local ; CI de D sur le checkout courant de E | s'applique sans conflit |
| 3 tests D contre le E patché (`AT-3`) : les variantes que D produit réellement ne s'approuvent pas ensemble, quel que soit l'ordre d'import, et survivent à une réimportation | CI de D (étape patchée) | voir `CI-COUVERTURE.md` |

## Limites connues
- **Fenêtre de concurrence** : la vérification lit tous les posts avant la transition ; deux approbations strictement simultanées sur deux variantes pourraient passer toutes deux (le magasin sérialise par post, pas globalement). Le propriétaire est un seul humain ; la défense du publisher et `exclusivityConflicts` couvrent le reste ; une garde atomique demanderait un verrou de magasin (changement plus profond, non proposé ici).
- La **publication manuelle attestée** (`attest_manual`) n'est volontairement pas bloquée : elle enregistre une vérité. `exclusivityConflicts` la signale.
- Si E avance, le patch peut ne plus s'appliquer : la CI de D échoue alors **explicitement** (« le patch doit être rafraîchi »).

## Coordination
Aucun message n'a été envoyé à une autre session. À transmettre à E : ce document, le patch, et la demande : *adopter `alternative_to` (ou une variante de la même idée) avant d'importer les variantes de D*. Tant que E ne l'a pas adopté, **D marque ses variantes dans `notes` (« ne publier qu'une des deux ») et le propriétaire ne doit pas approuver les deux** : c'est la seule protection active aujourd'hui.
