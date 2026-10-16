# `sourcing-staging` sur Railway — grille GO / NO-GO (16/10)

> Procédure courte à suivre : **`docs/infrastructure/procedure-activation-staging.md`**.

Décision du propriétaire (16/10) : déploiement de `sourcing-staging` validé **dans son principe**, budget cible 2–4 USD/mois ;
**activation, dépenses et changements d'infrastructure seulement après sa confirmation explicite**, sur présentation de cette grille.
Adresse cible du test Xiaomi : `app.nordla.app` (aucun DNS modifié sans son accord). Staging reste séparé de la production.

Commit à déployer : **`ab02b7791b7dd91fbc7c10e7029bef5983a0c02a`** (`ab02b77` = `50c865c` + correction de la copie B2 ; CI verte 38864695248 / 38864695260 / 38864695251 ; remplace `a11324e` ; branche `claude/nordla-core-p0` ; contient la fusion du Chantier B #10 `9c78d44`). Les commits suivants ne touchent que la documentation : l'image serait identique.

## A. Conditions vérifiables AVANT l'activation

| # | Condition du propriétaire | État | Preuve |
|---|---|---|---|
| A1 | CI finale verte sur le commit exact | **vert** | sur `50c865c` : `core-reliability` 38858385566 (Linux suite complète + **vrai disque plein / lecture seule sous sudo** + **Windows**), `nordla-integration-pre-china` 38858385499 (Node 20 + 24), `china-sourcing` 38858385515 ; local 88 fichiers / 898 tests, 0 échec. Précédemment sur `a11324e` : `core-reliability` 38854414610 (Linux suite complète + **Windows**), `nordla-integration-pre-china` 38854414635 (Node 20 + Node 24, suite complète), `china-sourcing` 38854414576, `staging-backup-drill` 38854414639 (porte seule, `run: false`) ; local : 85 fichiers / 888 tests Sourcing-Core-sauvegardes, 0 échec |
| A2 | Aucune connexion à la production | **vérifié dans le code et sur l'image** | le service ne joint Supabase que par `SUPABASE_URL` + 2 clés ; **nouvelle garde** : sur Railway, `NORDLA_SUPABASE_PROJECT_REF` est obligatoire, `SUPABASE_URL` doit être exactement `https://<ref>.supabase.co` et une clé JWT d'un autre projet est refusée (sans être affichée). Simulé dans l'image (variables `RAILWAY_*`) : variable absente → refus de démarrer ; URL de production → refus de démarrer ; configuration staging → démarrage, journal « Supabase project fvhiammdskpcnfodsnrc ». Tests : `test/sourcing-hosted-project-pin.test.js` |
| A3 | Séparation des secrets et accès staging / production | **vérifié côté code ; à constater côté Railway** | les secrets sont saisis par le propriétaire ; le service staging ne reçoit **que** des valeurs du projet staging (garde A2) ; le canal GitHub `supabase-staging` refuse la référence de production ; aucune variable partagée avec Finance / Analytics de production ne doit être référencée par `sourcing-staging` (à constater dans l'onglet *Variables* : aucune « shared variable » de production) |
| A4 | Volume persistant pour le journal Core | **vérifié dans l'image ; à constater côté Railway** | garde du Chantier B : sur Railway, journal hors volume → « Nordla Core OFF (JOURNAL_NOT_ON_A_VOLUME) » (simulé) ; configuration prévue : volume `sourcing-staging-data` monté sur `/app/data`, `SOURCING_DATA_DIR=/app/data/sourcing` → « Nordla Core ON » (simulé). À constater : volume attaché, 1 réplique (Railway interdit les répliques avec volume) |
| A5 | Comportement en cas de panne du stockage ou des sauvegardes | **testé** | écriture du journal non durable → 503 et aucune décision « enregistrée » à tort (tests Chantier B `core-reliability*`) ; volume presque plein → aucune archive écrite, message `BACKUP_LOW_SPACE` ; copie hors serveur en échec → archive locale gardée, échec journalisé sans secret, **nouvel essai 1 h plus tard** (avant : 24 h ; corrigé et testé) ; archive modifiée ou mauvaise phrase de passe → refusée, jamais restaurée à moitié ; restauration jamais par écrasement |
| A6 | Coûts et ressources réellement configurés | **à constater côté Railway** (non visible d'ici) | attendu : 1 service, 1 réplique, volume 1 Go, pas de second service ; **correction 16/10 : les limites CPU / mémoire ne se règlent pas sur un service avec volume** (communauté Railway) — le coût est borné par la limite d'usage ; mesure locale 48 Mo au repos ; estimation 2–4 USD/mois. **limite d'usage** : alerte e-mail 8 USD ; limite stricte 10 USD seulement si l'usage actuel de l'espace laisse de la marge (elle met **tous** les services de l'espace hors ligne et n'est pas un plafond absolu) — voir `procedure-activation-staging.md` §2 |

## B. Conditions qui ne peuvent être prouvées qu'APRÈS l'activation (staging non « opérationnel » avant)

| # | Condition | Comment | Attendu |
|---|---|---|---|
| B1 | Démarrage réel | journaux Railway | `Supabase project fvhiammdskpcnfodsnrc`, `Nordla Core ON for merchant 67646dbb-…`, `uid 1000`, aucun secret |
| B2 | **Sauvegarde hors serveur réelle** | journaux Railway (+10 min) puis relecture du bucket par Infrastructure (métadonnées seulement) | `Backup OK: … copied off-server as sourcing-<date>.nsb` ; l'objet existe dans `nordla-backups` |
| B3 | **Restauration indépendante** | workflow `staging-backup-drill` (runner GitHub, pas le serveur), `run: true` après accord, approbation dans l'environnement `supabase-staging` | l'archive la plus récente du bucket est téléchargée, déchiffrée, vérifiée (SHA-256, chaîne du journal) et restaurée dans un dossier vide ; rapport sans donnée ni secret |
| B4 | Sécurité en ligne | contrôles 1–10 de `railway-handoff-9e25f1d.md` | 401 sans session, 421 autre hôte, redirection https, en-têtes |
| B5 | Domaine | `domaine-app-nordla-app.md` (après accord DNS) | certificat Let's Encrypt pour `app.nordla.app`, `/healthz` 200 |

Une sauvegarde **locale seule ne suffit pas** : staging n'est déclaré opérationnel qu'avec B2 **et** B3.

## C. Ce que le propriétaire saisit lui-même (jamais dans un chat)

- Railway, `sourcing-staging` : `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` (projet **staging**), `NORDLA_IDENTITY_RATE_LIMIT_KEY`,
  `NORDLA_CSRF_KEY` (différents, ≥ 32 octets), `SOURCING_BACKUP_PASSPHRASE` (≥ 16 caractères, gardée aussi hors ligne).
- GitHub, environnement `supabase-staging`, pour la restauration indépendante : `STAGING_SERVICE_ROLE_KEY` (la même clé service
  **staging**) et `STAGING_SOURCING_BACKUP_PASSPHRASE` (**la même valeur** que `SOURCING_BACKUP_PASSPHRASE` de Railway).

## D. Variables non secrètes (préparées)

`NORDLA_SERVICE=sourcing`, `SOURCING_HOSTED=1`, `NODE_ENV=production`, **`NORDLA_SUPABASE_PROJECT_REF=fvhiammdskpcnfodsnrc`** (nouvelle,
obligatoire sur Railway ; au démarrage le journal doit dire `Supabase project check (fvhiammdskpcnfodsnrc): VERIFIED`), `SUPABASE_URL=https://fvhiammdskpcnfodsnrc.supabase.co`, `NORDLA_MERCHANT_ID=67646dbb-5e2e-4cd7-aad6-0ab289b068cb`,
`SOURCING_MERCHANT_ID=habb`, `MERCHANT_TIMEZONE=Europe/Brussels`, `SOURCING_PUBLIC_ORIGIN=https://app.nordla.app` (ou l'adresse Railway pour un
essai technique sans le téléphone), `SOURCING_DATA_DIR=/app/data/sourcing`, `SOURCING_BACKUP_DIR=/app/data/sourcing-backups`,
`SOURCING_BACKUP_KEEP=3`, `SOURCING_BACKUP_BUCKET=nordla-backups`, `SOURCING_HOST=0.0.0.0`, `PORT`/`SOURCING_PORT=8787`.
Commande de démarrage `/app/docker-entrypoint.sh node src/service-start.js`, healthcheck `/healthz`.

## E. Retour arrière

Code : redéployer le déploiement Railway précédent (ou mettre le service à 0 instance). Domaine : retirer le CNAME / TXT. Données :
le volume reste intact ; les fichiers ajoutés sont additifs. Base staging : non modifiée par l'activation. Production : jamais concernée.

## F. Vérifications complémentaires du 16/10 (demande du propriétaire, avant l'autorisation finale)

| # | Exigence | Résultat | Preuve |
|---|---|---|---|
| F1 | Protection Supabase pour **tous** les formats de clés, aucune connexion à la production | **fait** | clés JWT : référence du projet lue et comparée ; clés opaques `sb_secret_` / `sb_publishable_` (sans référence) : **vérification en direct au démarrage** contre le seul projet épinglé — clé refusée par staging (une clé de production l'est) → le service **refuse de démarrer** ; marchand absent du projet → refus. Toutes les requêtes Supabase partent vers `https://fvhiammdskpcnfodsnrc.supabase.co` uniquement : **relevé réel** des connexions sortantes dans l'image (démarrage, connexion, sauvegarde) = ce projet + `ec.europa.eu` (Safety Gate), rien d'autre. Tests `test/sourcing-hosted-project-pin.test.js` (9) |
| F2 | Volume persistant ; jamais de décision « enregistrée » sans stockage | **fait (code et vrai disque)** ; volume Railway **à constater** | sur un **vrai** système de fichiers plein puis en lecture seule : 503, aucune décision affichée comme enregistrée, protection jusqu'au redémarrage, au redémarrage exactement les décisions confirmées (`test/core-storage-realfs.test.js`). **Défaut trouvé et corrigé** : un disque plein laissait un verrou vide qui bloquait toute écriture 15 s après redémarrage (`src/core-pilot/durable-file.js`, déclaré au Chantier B ; mutation 38/39 tués, 1 équivalent, 0 survivant) |
| F3 | Alerte réelle en cas d'échec de sauvegarde | **prêt, activation à décider** | le service expose `GET /healthz/backup` (âges et compteurs seulement ; 503 si aucune copie hors serveur depuis 26 h ou si le nouvel essai échoue aussi). Le workflow `staging-backup-monitor` l'interroge toutes les 3 h et ouvre **une issue GitHub** (e-mail au propriétaire) si le service ne répond pas ou si les sauvegardes ne sont pas à jour. Règle GitHub : les workflows planifiés ne tournent que depuis `main` → **il faut ajouter ce seul fichier sur `main`** (accord du propriétaire) ; activation par `ops/staging-monitor/target.json` `"enabled": true` |
| F4 | Sauvegarde immuable / isolée, résistante à la clé de service | **prête, non activée** | `docs/infrastructure/sauvegarde-isolee-b2.md` : Backblaze B2, Object Lock compliance 30 jours, clé serveur **ajout seul** (vérifiée à chaque envoi), restauration et verrou vérifiés par la restauration indépendante. Nouveau fournisseur = décision du propriétaire ; coût attendu 0 USD (offre gratuite 10 Go) |
| F5 | Le test Xiaomi n'efface aucune ancienne donnée | **confirmé (code + navigateur réel)** ; Xiaomi physique le 18 | le code du téléphone ne contient **aucune** suppression de dossier ou de photo (seule suppression : une copie `localStorage` après sa recopie confirmée dans IndexedDB ; le service worker ne vide que ses anciens caches d'application) ; un conflit n'écrase rien (409) ; la récupération « garde les deux » ; le serveur n'efface ni n'écrase. Navigateur réel : migration d'adresse 7/7 (l'ancienne adresse garde le dossier et ses 3 photos), récupération 12/12, reconnexion 9/9, photos 6/6. Le changement d'adresse ne touche pas l'ancienne : ses données restent dans Firefox et sur le PC tant qu'on n'efface pas les données du site (protocole §0) |
