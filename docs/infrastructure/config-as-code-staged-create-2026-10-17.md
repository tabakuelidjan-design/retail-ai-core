# Config as code d'un service `staged-create` : solution sûre et vérification du déploiement automatique (2026-10-17)

Rien n'est déployé, aucune variable ni secret, aucune migration, aucune production touchée. `release/sourcing-staging` n'a **pas** été déplacée (toujours `0f83fd2`).

## 1. Le blocage, et ce qu'il implique réellement
Le chemin « Config as code » (`railwayConfigFile`) est un champ de l'**instance du service**, pas du lot de configuration d'environnement : le lot (lisible avec `railway environment config --json`) ne connaît que `build.*`, `deploy.*`, `source.{repo,branch,checkSuites}`, `variables`, `volumeMounts`, `networking`. Tant que le service est en `staged-create`, l'instance n'existe pas : Railway répond « Service instance not found ». Il ne peut donc pas être posé avant le premier déploiement.
Ce que cela change : sans ce chemin, Railway lit le **`railway.json` racine** du commit. Celui-ci (voulu ainsi : `test/service-start.test.js`) lance `node src/service-start.js` sans l'entrée Docker. Les autres clés du lot restent valables (le fichier racine n'a pas de section `build` : le constructeur Dockerfile et le chemin du Dockerfile du lot restent effectifs ; pas de healthcheck ni de réplique dans le fichier racine : ceux du lot restent effectifs). **Seule la commande de démarrage est en cause** (et la politique de redémarrage) : sans l'entrée Docker, la sécurité d'exécution (volume préparé, utilisateur `node`, uid 1000) n'est plus garantie.

## 2. Solution retenue (aucune interaction avec l'API Railway)
Le fichier que Railway lit par défaut est celui du **commit déployé** : on met la bonne configuration **à la racine, sur la branche de release uniquement**.
- Commit `a7ecccdc49d28def444bb6db0b68865372c55286`, enfant direct de `0f83fd2`, sur la branche `candidate/sourcing-staging-root-config` (poussée) : **1 seul fichier change, `railway.json`**, dont le contenu est identique à `deploy/sourcing/railway.json` (Dockerfile `deploy/sourcing/Dockerfile`, démarrage `/app/docker-entrypoint.sh node src/service-start.js`, `/healthz` 120 s, 1 réplique, `ON_FAILURE` ×3, pas de veille).
- **L'image Docker est inchangée** : construites chacune depuis son commit, les deux images ont les **mêmes 16 couches de contenu** (le fichier racine n'est pas copié dans l'image).
- **Aucune autre branche n'est touchée** : `claude/nordla-core-p0` garde le `railway.json` racine à dispatcheur dont les autres services dépendent. Ce commit ne doit **jamais** être fusionné en retour (il ferait échouer `test/service-start.test.js` et changerait le démarrage des autres services) ; il n'existe que sur la branche de release. Aucun workflow ne se déclenche sur `release/**` ni `candidate/**` (filtres de branches relus).
- Pas de clé inconnue dans le fichier (j'avais d'abord ajouté un commentaire ; retiré par prudence : le schéma Railway pourrait le refuser).
Pour l'appliquer il faut, **sur votre autorisation** : (a) avancer `release/sourcing-staging` de `0f83fd2` à `a7ecccd` (fast-forward, par moi) ; (b) remplacer le commit épinglé du lot par `a7ecccdc49d28def444bb6db0b68865372c55286` (par vous / la session Railway) ; (c) relire le lot (`source.branch` = `release/sourcing-staging`, commit = `a7ecccd…`). Le SHA validé `0f83fd2` reste l'ancêtre exact : le code est le même, seule la configuration de déploiement diffère.

**Contrôle après le premier déploiement, de toute façon** : une fois l'instance créée, poser aussi `railwayConfigFile = /deploy/sourcing/railway.json` (désormais possible) pour que les deux sources de configuration soient identiques et que le fichier racine de la branche de release ne soit plus la seule garantie ; vérifier `uid 1000` dans le journal (`uid 0` = arrêt).

Solution de repli si vous refusez de déplacer le SHA : déployer `0f83fd2` tel quel, puis poser `railwayConfigFile` et redéployer. **Déconseillé** : le premier démarrage utiliserait la commande racine sans l'entrée Docker (utilisateur et propriété du volume non garantis) ; il faudrait constater `uid 1000` après coup et corriger.

## 3. Déploiement automatique : ce qui est vérifiable et ce qui ne l'est pas
- Le lot Railway ne contient **aucun interrupteur « déploiement automatique »** : seul `source.checkSuites` existe (« attendre la CI GitHub » ; `false` aujourd'hui sur les services de production). Railway redéploie à chaque poussée sur la branche suivie. « Attendre la CI » n'est pas une désactivation (sans workflow sur la branche, son comportement n'est pas garanti) : **je ne m'appuie pas dessus**.
- Garantie retenue : **branche dédiée, strictement contrôlée** — `release/sourcing-staging` n'est suivie par aucun workflow, aucun chantier n'y pousse, elle ne bouge que par fast-forward explicite sur autorisation. Contrôle avant chaque autorisation : `git ls-remote origin release/sourcing-staging` doit donner le SHA validé (aujourd'hui `0f83fd2…`, après autorisation `a7ecccd…`) — au moindre autre SHA, arrêt.
- À faire côté GitHub par le propriétaire si possible (je n'ai pas de droit d'administration) : une règle de protection de branche sur `release/sourcing-staging` (pas de poussée directe, pas de suppression). Tant qu'elle n'existe pas, la garantie repose sur la discipline et sur le contrôle ci-dessus.
- Vérification après création de l'instance : `railway environment config -e staging --json` doit montrer `source.branch = release/sourcing-staging` ; la liste des déploiements du service ne doit contenir que ceux que vous avez lancés ; les déploiements des 8 autres services restent ceux de la base de comparaison.

## 4. Ce qui demande votre autorisation
1. Avancer `release/sourcing-staging` à `a7ecccdc49d28def444bb6db0b68865372c55286` (ou choisir le repli).
2. Remplacer le commit épinglé du lot (vous / session Railway).
3. Règle de protection GitHub sur la branche (vous).
4. Tout le reste est inchangé : secrets (vous), Deploy, graine de test, DNS, migrations.
