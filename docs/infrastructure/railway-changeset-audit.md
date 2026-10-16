# Audit du lot de changements Railway (environnement `staging`) avant activation

Constat de la session Railway (lecture seule, 16/10) : `sourcing-staging` en `staged-create` ; volume `sourcing-staging-data` 1 Go
monté sur `/app/data` (en attente) ; 1 réplique ; aucune variable partagée ; secrets absents ; commit épinglé **`c2c314d`** ; **29
changements en attente** dans l'environnement.

**Règle Railway** : « Deploy » applique **tout** le lot en attente de l'environnement en une fois. Un changement non voulu dans le lot
serait donc appliqué avec le reste : le lot doit être trié **ligne par ligne** avant toute activation.

## 1. Commit : `c2c314d` → `ab02b77` (obligatoire)

`ab02b7791b7dd91fbc7c10e7029bef5983a0c02a` descend de `c2c314d` (54 commits). **Rien de ce qui construit l'image ne change** : Dockerfile,
script d'entrée, `railway.json`, `railpack.json`, `package-lock.json` identiques ; `package.json` : un script de test en plus. Ce qui
change au démarrage (et rend le changement obligatoire) :

| Comportement | `c2c314d` | `ab02b77` |
|---|---|---|
| Projet Supabase | aucune protection | `NORDLA_SUPABASE_PROJECT_REF` **obligatoire sur Railway** ; adresse / clé d'un autre projet → refus de démarrer ; vérification en direct (toute clé) |
| Marchand absent du projet | démarre, personne ne peut se connecter | **refus de démarrer** (`HOSTED_MERCHANT_NOT_IN_PROJECT`) |
| Journal Core hors volume | décisions perdues au redéploiement | Core désactivé avec le motif |
| Disque plein / lecture seule | — | 503, jamais de fausse décision ; verrou nettoyé |
| Sauvegarde | échec retenté 24 h plus tard, aucune alerte | nouvel essai 1 h ; `/healthz/backup` pour l'alerte externe ; copie B2 immuable possible |

CI verte sur `ab02b77` : core-reliability 38864695248 (Linux + vrai disque + Windows), intégration 38864695260 (Node 20/24),
china-sourcing 38864695251. Les commits suivants (`3099bea`) ne touchent que la documentation.

## 2. Variables de `sourcing-staging` (à appliquer dans le même lot)

| Variable | Valeur cible | Action probable |
|---|---|---|
| `NORDLA_MERCHANT_ID` | `67646dbb-5e2e-4cd7-aad6-0ab289b068cb` | **modifier** (vaut l'identifiant de production `36b1a1a7-…` dans le patch d'origine) |
| `NORDLA_SUPABASE_PROJECT_REF` | `fvhiammdskpcnfodsnrc` | **ajouter** |
| `SUPABASE_URL` | `https://fvhiammdskpcnfodsnrc.supabase.co` | ajouter / vérifier |
| `NORDLA_SERVICE` | `sourcing` | ajouter / vérifier |
| `SOURCING_HOSTED` | `1` | ajouter / vérifier |
| `SOURCING_PUBLIC_ORIGIN` | `https://<adresse générée>.up.railway.app` | ajouter (après génération de l'adresse) |
| `SOURCING_BACKUP_BUCKET` | `nordla-backups` | ajouter / vérifier |
| `MERCHANT_TIMEZONE` | `Europe/Brussels` | vérifier |
| `SOURCING_MERCHANT_ID` | `habb` | vérifier |
| `SOURCING_DATA_DIR` / `SOURCING_BACKUP_DIR` | `/app/data/sourcing` / `/app/data/sourcing-backups` | vérifier (doivent être **dans** `/app/data`) |
| `SOURCING_BACKUP_KEEP` | `3` | vérifier |
| `NODE_ENV` / `SOURCING_HOST` | `production` / `0.0.0.0` | vérifier |
| `PORT` / `SOURCING_PORT` | `8787` / `8787` | vérifier |
| `ANTHROPIC_API_KEY`, `SOURCING_VISION_PROVIDER`, `SOURCING_TOKEN` | — | doivent rester **absentes** |
| Secrets (saisis par le propriétaire) | `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_ANON_KEY` (staging), `NORDLA_IDENTITY_RATE_LIMIT_KEY`, `NORDLA_CSRF_KEY`, `SOURCING_BACKUP_PASSPHRASE` | ajouter |

## 3. Tri des 29 changements — chaque ligne doit entrer dans **A**, sinon arrêt

**A. Requis (service `sourcing-staging` uniquement)** : création du service ; source (dépôt `retail-ai-core`, branche
`claude/nordla-core-p0`, **commit épinglé**) ; constructeur Dockerfile `deploy/sourcing/Dockerfile` ; commande de démarrage
`/app/docker-entrypoint.sh node src/service-start.js` ; healthcheck `/healthz` ; 1 réplique ; mise en veille désactivée ; région ;
création du volume `sourcing-staging-data` (1 Go) et son montage `/app/data` sur ce service ; variables du §2.

**B. Interdit (arrêt, retirer du lot avant toute activation)** :
- toute modification d'un **autre service** (Finance, Analytics, Core existants…) : source, commit, variables, domaine, réplique, volume ;
- toute **variable partagée** (`shared`) ou référence `${{…}}` vers un autre service ;
- toute **suppression** (service, volume, variable, domaine) ;
- tout **domaine** (personnalisé ou généré) sur un autre service ; un domaine personnalisé `app.nordla.app` (accord DNS séparé) ;
- tout changement de l'environnement **production** ou des réglages du projet / de l'espace (membres, facturation, intégrations) ;
- un **second** service Sourcing, un second volume, ou un volume attaché à un autre service ;
- une valeur contenant `xbtzjabbseclmqfozjeo` (production) ou `36b1a1a7-2a48-416a-9dfe-ce66fe1ec2a5`.

**C. À justifier avant d'accepter** : toute ligne non reconnue ci-dessus (la décrire : service, type, nom — **jamais la valeur d'un
secret**).

Présentation attendue de la session Railway : un tableau des 29 lignes `n° | service | type (create / update / delete) | élément | A/B/C`.
Activation **seulement** si toutes les lignes sont en A.

## 4. Validation minimale après activation (rien d'autre n'est refait)

1. Journal : `Supabase project check (fvhiammdskpcnfodsnrc): VERIFIED`, `Nordla Core ON for merchant 67646dbb-…`, `uid 1000`, aucun secret.
2. Autres services de l'environnement : même état et même déploiement qu'avant (aucun redéploiement provoqué).
3. `/healthz` 200 ; `/api/core/modules` 401 ; `/healthz/backup` `PENDING_FIRST_RUN`.
4. +10 min : `Backup OK … copied off-server` ; puis restauration indépendante (`staging-backup-drill`, sur accord).
Retour arrière : service à 0 instance ; aucune donnée ni autre service touché.

## 5. Corrections à mettre en attente puis nouvel audit (16/10)

Premier audit (session Railway, lecture seule) : **29 lignes, toutes A** (26 création du service, 3 volume) ; 0 B, 0 C. Lot conservé.

Corrections exactes (valeurs non secrètes) : `ops/railway-staging/staged-corrections.json` — commit `c2c314d` → `ab02b77`,
`NORDLA_MERCHANT_ID` → `67646dbb-…`, variables manquantes, variables qui doivent rester absentes. **Mises en attente, pas déployées.**

Nouvel audit — chaque condition doit être vraie :
1. Le lot ne contient toujours **que** des lignes du service `sourcing-staging` et de son volume (A) ; 0 B ; 0 C. Le nombre de lignes peut
   augmenter (variables ajoutées) : chaque nouvelle ligne doit être une variable de ce service listée dans le fichier ci-dessus.
2. Commit épinglé = `ab02b7791b7dd91fbc7c10e7029bef5983a0c02a` (le SHA complet, pas une branche « dernière version »).
3. `NORDLA_MERCHANT_ID` = `67646dbb-5e2e-4cd7-aad6-0ab289b068cb` ; **aucune** valeur contenant `36b1a1a7` ni `xbtzjabbseclmqfozjeo`.
4. Chaque variable de `set_if_absent_or_different` a exactement sa valeur ; `must_be_absent` absentes.
5. Inchangés : Dockerfile, commande de démarrage, healthcheck, 1 réplique, volume 1 Go sur `/app/data`.
Réponse attendue : le même tableau `n° | service | type | élément | A/B/C` + une ligne par condition 1–5 (vrai / faux), sans valeur secrète.
