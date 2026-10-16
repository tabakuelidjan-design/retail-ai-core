# Enquête CI — « Creative Intelligence V1 » rouge sur `feature/stock-achat-v1`

Question posée : l'échec est-il **préexistant** ou **lié au chantier C** ? Sources : API publique GitHub Actions (liste des exécutions, étapes, annotations des jobs), historique du workflow sur toutes les branches, relectures locales. Les **journaux bruts** exigent une authentification (non disponible) : tout ce qui suit s'appuie sur les annotations et les étapes.

## 1. Chronologie sur ma branche
| Commit | Résultat | Étape en échec | Test annoncé en échec (annotations) |
|---|---|---|---|
| `dae712c` (8 h 41 UTC) | échec (Node 24) | « Focused Creative Intelligence tests » | `test/creative-intelligence-product-mask.test.js` |
| `e571b90` (9 h 31 UTC) | échec (Node 24) | « Full suite (cross-domain non-regression) » (`npm test`) | `test/benchmark-preflight.test.js` (« no report in results/ : 1 !== 0 ») |
Le job Node 20 a été **annulé** (pas échoué) dans les deux cas : l'échec Node 24 du même workflow l'annule.

## 2. Ce workflow est rouge de façon récurrente, sur d'autres branches, avant mon travail
91 exécutions au total ; sur les 30 plus récentes (lues par l'API), 11 échecs, sur 6 branches dont la mienne : `claude/nordla-core-p0` (3 fois), `feature/creative-system-closure`, `feature/creative-mask-determinism-diagnostic`, `feature/creative-phase-4-refine-layer-repair` (2), `feature/creative-phase-3-layered-scene-production` (2), puis les deux de ma branche. Tests en cause, hors de ma branche : `creative-intelligence-product-mask` (**4 exécutions, dont 3 avant mon travail** : `claude/nordla-core-p0` 38659540142 et 38689519552, `feature/creative-mask-determinism-diagnostic` 38407269114, puis la mienne `dae712c`), `creative-readiness` (4), `creative-refine` (1), et une panne multiple (`finance-privacy`, `sourcing-backup-full-restore`, `sourcing-field-v1-merchant-profile`…) sur 38742368807.
Sur `claude/nordla-core-p0` les exécutions alternent échec et succès sur des commits consécutifs (7681aa2 ✗, 20ee43d ✓, 6d721c4 ✗, a550cff ✓, f7b2b16 ✗, 9e25f1d ✓) : signature d'un test **instable**, pas d'une régression déterministe.

## 3. Mécanisme de l'échec de `e571b90` (`benchmark-preflight`)
Le test compte les entrées de `benchmark/ask/results` avant et après avoir lancé `benchmark/ask/run.js --preflight-only`, et exige qu'aucun rapport n'ait été écrit. D'autres fichiers (`benchmark-adapters`, `benchmark-ask`) écrivent des rapports dans le **même dossier partagé**. Le workflow `nordla-integration-pre-china.yml` le documente et contourne la faiblesse en exécutant les `benchmark-*` un par un (« inherited isolation weakness »). Le workflow « Creative Intelligence V1 » lance `npm test` (tous les fichiers) sans ce contournement : l'échec est donc possible dès que deux fichiers `benchmark-*` se chevauchent, quelle que soit la branche.

## 4. Ce que j'ai pu reproduire / exclure
- Ces tests **ne touchent pas** mon code : `creative-intelligence-product-mask` et `benchmark-preflight` n'importent ni `src/procurement`, ni `src/integration`. Mon seul fichier partagé modifié qui entre dans `npm test` est `package.json` (3 scripts ajoutés) et `src/integration/{approval,router,index}.js` (+8/−2 lignes, comportement par défaut inchangé, 50/50 tests d'intégration verts).
- **Local (Windows, Node 24)** : la suite complète passe (346/354 fichiers ; les 8 échecs sont `sourcing-*`, identiques sur la base intacte) ; `benchmark-adapters + benchmark-ask + benchmark-preflight` lancés ensemble : 3/3 verts sur la base **et** sur ma branche. L'échec CI n'est donc **pas reproductible localement** : il dépend de la charge/de l'ordonnancement du runner.
- **Reproduction en conditions CI** (Linux, Node 24, 2 CPU, `npm ci` + `npm test` en Docker) : tentée, **interrompue** parce qu'elle saturait la machine ; non concluante. À relancer seule, voir §6.

## 5. Conclusion
- `dae712c` : **préexistant** (même test, déjà en échec sur 3 autres exécutions avant mon travail).
- `e571b90` : cause **probable préexistante** (course sur un dossier partagé documentée par le dépôt ; instabilité du même workflow sur d'autres branches). Je **ne peux pas l'affirmer avec certitude** : les journaux bruts ne sont pas accessibles et la reproduction CI n'a pas abouti. Aucune donnée ne relie cet échec à mon code, et rien ne l'exclut formellement.
- **Aucun test ni garde de sécurité n'a été désactivé ou modifié** pour obtenir un résultat.

## 6. Actions proposées (pour le propriétaire de ce workflow ; non appliquées, car elles touchent un fichier hors de ma branche)
1. Dans `creative-intelligence-v1.yml`, exécuter les `benchmark-*` en série comme le fait `nordla-integration-pre-china.yml` (ou donner à chaque test un dossier de résultats propre via une variable d'environnement).
2. Relancer l'exécution rouge pour confirmer l'instabilité (bouton « Re-run failed jobs » ; je n'ai pas le droit de le faire depuis ici).
3. Si l'échec persiste sur un re-run **de ma branche uniquement**, rouvrir l'enquête avec les journaux bruts (`gh run view --log-failed`).
