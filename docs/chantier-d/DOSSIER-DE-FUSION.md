# Dossier de fusion : chantier D (pôle créatif HABB), phase 1

Préparé le 2026-10-17. **Aucune fusion n'a été faite.** Ce dossier décrit comment la faire, par le propriétaire ou le responsable de convergence, et comment revenir en arrière.

## 1. Source et cible

| | |
|---|---|
| **Branche source** | `feature/chantier-d-branding-creative-pole` (dépôt `retail-ai-core`) |
| **Commit source vérifié par la CI** | `97a7335f66ad9c4bd05402351bf7816fc1959a84` (dernier commit de code) |
| **Tête de branche** | `97a7335` + des commits de **documentation seule** : `git diff --stat 97a7335 HEAD` ne doit lister que des fichiers sous `docs/chantier-d/` (à vérifier avant la fusion) |
| **Base commune** | `f7197d596` (`integration/nordla-pre-china`) |
| **Cible recommandée** | **`integration/nordla-pre-china` @ `f7197d596`** : la branche D est en avance, jamais en retard (**fast-forward possible**, 0 conflit) |
| **Cible NON valide** | `main` (`a9d0e2fb8`) : `main` ne contient pas les modules Creative dont D dépend (voir §4) ; fusionner D dans `main` seul ferait échouer ses imports. D n'est pas extractible de la lignée d'intégration (569 commits d'avance sur `main`) |

Essais de fusion à blanc (aucune branche modifiée ; `git merge-tree`) :

| Cible | Fusion directe de la branche | Changements propres de D seuls (base `f7197d5`) | Tests D sur le résultat de la fusion |
|---|---|---|---|
| `integration/nordla-pre-china` `f7197d596` | fast-forward, 0 conflit | n/a | CI verte (§5) |
| `integration/nordla-convergence-v1` `2c8871d9b` | 0 conflit | 0 conflit | 41 réussis, 0 échec, 4 ignorés (E absent) |
| `claude/nordla-core-p0` `6b48b389f` | **1 conflit**, dans `.github/workflows/nordla-integration-pre-china.yml` : fichier **que D ne modifie pas** ; divergence préexistante entre la lignée `pre-china` et `core-p0` (base commune plus ancienne `4c0758676`), sans lien avec D | 0 conflit | 41 réussis, 0 échec, 4 ignorés (E absent) |
| `feature/social-publishing-e` `879198df3` | 0 conflit | 0 conflit | (CI de D l'utilise comme checkout jetable) |

Conséquence : fusionner D **dans la lignée d'intégration** (pre-china, puis convergence). Pour `core-p0`, la divergence de workflow est à réconcilier par ceux qui fusionnent la lignée ; les changements propres de D s'y appliquent sans conflit (série de commits ou cherry-pick).

## 2. Fichiers (ajouts uniquement, aucun fichier existant modifié)

**40 fichiers, tous des ajouts (A) :**

- `.github/workflows` (1) : `chantier-d-creative-pole.yml`
- `docs/chantier-d` (13) : `BILAN-2026-10-17.md`, `CI-COUVERTURE.md`, `CLOTURE-PHASE-1.md`, `CONTRAT-CHANTIER-E.md`, `CREATIVE-AI-ARCHITECTURE.md`, `DEMANDE-CORRECTIONS-RESERVE.md`, `ETAT-REEL.md`, `LIVRAISON-D-VERS-E.md`, `PROPOSITION-E-ALTERNATIVE-TO.md`, `UNIFICATION-EDITORIALE.md`, `e-proposals/.gitattributes`, `e-proposals/alternative-to.patch`, `e-proposals/confirmed-facts-prices.json`
- `src/asset-library` (10) : `claims.js`, `constants.js`, `contract.js`, `editorial.js`, `entry.js`, `image-info.js`, `index.js`, `indexer.js`, `library.js`, `social-proposal.js`
- `src/studio-compose` (6) : `ai-layer.js`, `capabilities.js`, `compose.js`, `index.js`, `jpeg.js`, `templates/habb.js`
- `test` (7) : `asset-library.test.js`, `habb-reserve-check.test.js`, `price-facts.test.js`, `social-alternative-to.test.js`, `social-compat.test.js`, `studio-ai-layer.test.js`, `studio-compose.test.js`
- `tools` (3) : `habb-asset-index.mjs`, `habb-editorial-check.mjs`, `habb-reserve-check.mjs`

Ce qui n'est **pas** dans le commit : tout ce qui est privé (`data/private/`, ignoré par git : index d'assets, plan éditorial, cartes, démonstrations, dossier de revue), les images, les clés. Aucune image ou binaire n'est suivi (`git diff --numstat` : aucune ligne binaire). Aucun fichier de Sourcing, Finance, Stock/Achat, Parle à Nordla, Core, Identity, E, ni de la CI existante n'est touché. `package.json` et `package-lock.json` sont inchangés.

## 3. Indépendance vis-à-vis des contenus privés et du fournisseur IA

Export propre du commit (`git archive`, **sans** `data/private`, sans worktrees voisins, sans E) :
- **45 tests D : 41 réussis, 0 échec, 4 ignorés** ; les 4 ignorés sont ceux qui exigent le code de E (SE-1, SE-2, PF-4, AT-3), exécutés en CI avec E extrait.
- Aucun module de D ne lit `data/private/` : les tests n'utilisent que des images synthétiques. Les scripts qui lisent les vrais fichiers HABB (`build-demo.mjs`, etc.) vivent dans `data/private/` et ne sont pas fusionnés.
- **Aucun fournisseur IA requis** : le fournisseur par défaut est `NOT_CONNECTED`, le mode actif est `PLATE_ONLY` ; composition, JPEG, contrôles, livraison à E, bibliothèque d'assets fonctionnent sans lui (tests AI-1 et AI-10, plus tous les tests de composition qui ne l'utilisent pas).
- Aucun appel réseau dans D : recherche de `fetch(`, `http`, `net`, variables `*KEY/TOKEN/SECRET` dans `src/asset-library` et `src/studio-compose` : seuls les espaces de noms SVG apparaissent.
- **Personne d'autre n'importe D** (`git grep` : aucun import de `asset-library` ou `studio-compose` hors de D) : la fusion ne change le comportement d'aucun module existant.

## 4. Dépendances

D dépend, à sens unique, de 5 modules existants de la lignée d'intégration :
`src/creative-campaign/budget.js`, `src/creative-intelligence/png-encode.js`, `src/creative-intelligence/png-pixels.js`, `src/creative-intelligence/production-typography.js`, `src/creative-production/raster-ops.js`, et de la ressource `resources/fonts/habb-benchmark/` (polices épinglées). Présents sur `pre-china`, `convergence-v1`, `core-p0` et la branche E ; **absents de `main`**. Dépendance npm : `@resvg/resvg-js` (déjà direct dans `package.json`). Node ≥ 20.11 (`import.meta.dirname` dans les tests).
Dépendances **facultatives** vers E : les tests de compatibilité exigent le code de E ; sans E ils s'ignorent (comptés). À l'exécution, D n'importe rien de E ; E n'importe rien de D.

## 5. Contrôles CI et locaux

**GitHub, commit `97a7335`** (run `38948667155`, Node 20 et 24, succès) : suites D **42/42**, 0 ignoré (contre E tel qu'il est) ; tests D contre E patché **9/9** ; modules existants `branding*`, `marketing*`, `creative-e2e*` **507/507** sur 28 fichiers ; suite sociale de E avec le patch **66 tests, 65 réussis, 1 ignoré (de E), 0 échec**. Le workflow échoue si un test de D est ignoré ou si le patch ne s'applique plus.
**Locaux** : décodage JPEG par Pillow ; export propre sans E (ci-dessus) ; essais de fusion à blanc et suites D sur les résultats pour `convergence-v1` et `core-p0` ; vérification Shopify du prix (83 coques, 25,00 €, 2026-10-17).
**Non couvert** : suite complète du dépôt ; tests `integration-*` (exécutés en local le 2026-10-16, 554/554, avant les derniers changements) ; Windows ; qualité visuelle.
**Couverture du dernier commit** : les commits entre `97a7335` et la tête ne contiennent que de la documentation (`git diff --stat 97a7335 HEAD` : vérifiable) ; ils sont poussés avec `[skip ci]`.

## 6. Risques

| Risque | Gravité | Mitigation |
|---|---|---|
| Fusion dans `main` : imports cassés (modules Creative absents) | élevé si tenté | cible = lignée d'intégration seulement (§1) |
| Conflit de workflow avec `core-p0` | moyen | préexistant et hors D ; les changements de D seuls s'appliquent sans conflit |
| Le patch `alternative_to` pour E ne s'applique plus si E avance | faible | la CI de D échoue explicitement ; patch à rafraîchir |
| E n'adopte pas `alternative_to` : deux variantes approuvables | moyen (contenus, pas code) | notes « ne publier qu'une des deux » ; D1–D3 en démonstration interne non publiable |
| Nouveau workflow `chantier-d-creative-pole.yml` : minutes CI à chaque push `feature/chantier-d-**` | faible | déclenché uniquement sur ces branches et manuellement |
| Valeur 24,90 € résiduelle dans `benchmarks/creative-intelligence/habb-brand-canonical-v1.json` et des tests Creative/Branding **préexistants** (contradiction « 25 € / 24,90 € » volontairement conservée par Branding) | moyen (cohérence des prix) | **hors périmètre de D, non modifié** ; à traiter par le chantier Branding : le prix en ligne vérifié est 25,00 € |
| Test PM-6/RF-2 intermittent connu de Creative | faible | préexistant |

## 7. Procédure de fusion (à exécuter par le propriétaire, non automatique)

Avant :
```bash
git fetch origin
git diff --stat 97a7335 origin/feature/chantier-d-branding-creative-pole   # doit ne lister que docs/chantier-d/
git diff --name-status origin/integration/nordla-pre-china origin/feature/chantier-d-branding-creative-pole | grep -v -E "^A\s+(docs/chantier-d|src/asset-library|src/studio-compose|test/|tools/habb-|\.github/workflows/chantier-d)"   # doit être vide
git merge-tree --write-tree origin/integration/nordla-pre-china origin/feature/chantier-d-branding-creative-pole   # exit 0
```
Option de repère de retour : noter le commit cible avant fusion (`git rev-parse origin/integration/nordla-pre-china`, soit `f7197d596` si inchangé) ; un tag est possible mais c'est une décision du propriétaire (pousser un tag est une action publique).
Fusion (sur la branche d'intégration, localement, puis revue) :
```bash
git switch integration/nordla-pre-china
git merge --no-ff origin/feature/chantier-d-branding-creative-pole -m "merge: chantier D (pole creatif HABB, phase 1)"
node --test test/asset-library.test.js test/studio-compose.test.js test/social-compat.test.js test/habb-reserve-check.test.js test/studio-ai-layer.test.js test/price-facts.test.js test/social-alternative-to.test.js
```
Puis pousser et laisser tourner `nordla-integration-pre-china` (suite complète) ; ne publier que si elle est verte.

## 8. Retour arrière
Aucune migration, aucune donnée, aucun secret, aucun fichier existant modifié : le retour arrière est exact.
- Avant la poussée : `git reset --hard <commit cible noté>` sur la branche d'intégration locale.
- Après la poussée : `git revert -m 1 <commit de fusion>` (nouveau commit, historique conservé) ; D disparaît, rien d'autre ne change (personne n'importe D).
- La branche source reste intacte et peut être refusionnée.
- Effets de bord à nettoyer : aucun côté serveur (rien n'est déployé) ; côté local, `data/private/` (ignoré) peut être conservé ou supprimé.

## 9. Conditions restantes (hors fusion technique)
1. E adopte (ou refuse) `alternative_to` ; E enregistre `coque-25-web` (datée, sourcée) avant tout texte citant le prix en ligne.
2. Droits des rendus de coques, photos HABB, approbation des contenus : indispensables **avant publication**, sans effet sur la fusion du code.
3. Corrections de la réserve éditoriale (P01, S10, P05, V2, S08, S02) à décider par son auteur.
