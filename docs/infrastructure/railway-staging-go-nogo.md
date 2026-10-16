# `sourcing-staging` sur Railway — grille GO / NO-GO (16/10)

Décision du propriétaire (16/10) : déploiement de `sourcing-staging` validé **dans son principe**, budget cible 2–4 USD/mois ;
**activation, dépenses et changements d'infrastructure seulement après sa confirmation explicite**, sur présentation de cette grille.
Adresse cible du test Xiaomi : `app.nordla.app` (aucun DNS modifié sans son accord). Staging reste séparé de la production.

Commit à déployer : **COMMIT_CANDIDAT** (branche `claude/nordla-core-p0`).

## A. Conditions vérifiables AVANT l'activation

| # | Condition du propriétaire | État | Preuve |
|---|---|---|---|
| A1 | CI finale verte sur le commit exact | ETAT_A1 | PREUVE_A1 |
| A2 | Aucune connexion à la production | **vérifié dans le code et sur l'image** | le service ne joint Supabase que par `SUPABASE_URL` + 2 clés ; **nouvelle garde** : sur Railway, `NORDLA_SUPABASE_PROJECT_REF` est obligatoire, `SUPABASE_URL` doit être exactement `https://<ref>.supabase.co` et une clé JWT d'un autre projet est refusée (sans être affichée). Simulé dans l'image (variables `RAILWAY_*`) : variable absente → refus de démarrer ; URL de production → refus de démarrer ; configuration staging → démarrage, journal « Supabase project fvhiammdskpcnfodsnrc ». Tests : `test/sourcing-hosted-project-pin.test.js` |
| A3 | Séparation des secrets et accès staging / production | **vérifié côté code ; à constater côté Railway** | les secrets sont saisis par le propriétaire ; le service staging ne reçoit **que** des valeurs du projet staging (garde A2) ; le canal GitHub `supabase-staging` refuse la référence de production ; aucune variable partagée avec Finance / Analytics de production ne doit être référencée par `sourcing-staging` (à constater dans l'onglet *Variables* : aucune « shared variable » de production) |
| A4 | Volume persistant pour le journal Core | **vérifié dans l'image ; à constater côté Railway** | garde du Chantier B : sur Railway, journal hors volume → « Nordla Core OFF (JOURNAL_NOT_ON_A_VOLUME) » (simulé) ; configuration prévue : volume `sourcing-staging-data` monté sur `/app/data`, `SOURCING_DATA_DIR=/app/data/sourcing` → « Nordla Core ON » (simulé). À constater : volume attaché, 1 réplique (Railway interdit les répliques avec volume) |
| A5 | Comportement en cas de panne du stockage ou des sauvegardes | **testé** | écriture du journal non durable → 503 et aucune décision « enregistrée » à tort (tests Chantier B `core-reliability*`) ; volume presque plein → aucune archive écrite, message `BACKUP_LOW_SPACE` ; copie hors serveur en échec → archive locale gardée, échec journalisé sans secret, **nouvel essai 1 h plus tard** (avant : 24 h ; corrigé et testé) ; archive modifiée ou mauvaise phrase de passe → refusée, jamais restaurée à moitié ; restauration jamais par écrasement |
| A6 | Coûts et ressources réellement configurés | **à constater côté Railway** (non visible d'ici) | attendu : 1 service, 1 réplique, limite 0,5 vCPU / 512 Mo, volume 1 Go, pas de second service ; mesure locale 48 Mo au repos ; estimation 2–4 USD/mois. Recommandé : **limite d'usage** du compte Railway (*Usage* → *Usage limits*) à 10 USD pour borner toute dérive |

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
obligatoire sur Railway), `SUPABASE_URL=https://fvhiammdskpcnfodsnrc.supabase.co`, `NORDLA_MERCHANT_ID=67646dbb-5e2e-4cd7-aad6-0ab289b068cb`,
`SOURCING_MERCHANT_ID=habb`, `MERCHANT_TIMEZONE=Europe/Brussels`, `SOURCING_PUBLIC_ORIGIN=https://app.nordla.app` (ou l'adresse Railway pour un
essai technique sans le téléphone), `SOURCING_DATA_DIR=/app/data/sourcing`, `SOURCING_BACKUP_DIR=/app/data/sourcing-backups`,
`SOURCING_BACKUP_KEEP=3`, `SOURCING_BACKUP_BUCKET=nordla-backups`, `SOURCING_HOST=0.0.0.0`, `PORT`/`SOURCING_PORT=8787`.
Commande de démarrage `/app/docker-entrypoint.sh node src/service-start.js`, healthcheck `/healthz`.

## E. Retour arrière

Code : redéployer le déploiement Railway précédent (ou mettre le service à 0 instance). Domaine : retirer le CNAME / TXT. Données :
le volume reste intact ; les fichiers ajoutés sont additifs. Base staging : non modifiée par l'activation. Production : jamais concernée.
