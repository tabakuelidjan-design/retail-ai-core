# Transmission Railway — candidat `sourcing-staging` (pour ChatGPT / session Railway)

**Ne rien déployer** : activation, coût et DNS restent soumis à l'autorisation distincte du propriétaire. Pas de second service.
Service : `sourcing-staging` (`24cc9cd0-e868-4210-90ce-23487ff2e65c`), volume `sourcing-staging-data` monté sur `/app/data`.

> **16/10 : remplacé par `docs/infrastructure/railway-staging-go-nogo.md`** — nouveau commit à déployer `a11324e` (fusion du Chantier B +
> garde de projet Supabase) et nouvelle variable obligatoire `NORDLA_SUPABASE_PROJECT_REF=fvhiammdskpcnfodsnrc`. Le reste de ce document
> (contrôles 1–10, retour arrière, coûts) s'applique.

## 0. Étape Railway prête à autoriser (état du 15/10, 22 h 25 UTC)

**Rien n'est lancé.** Activation, coût et DNS restent soumis à l'autorisation distincte du propriétaire.

Prérequis Supabase **staging** `fvhiammdskpcnfodsnrc`, tous faits et vérifiés (runs `staging-db-ops` 38813124178 et 38815730509) :
- migrations d'identité 1–5 appliquées (28 migrations au total) ;
- marchand de test **HABB (test staging)** `67646dbb-5e2e-4cd7-aad6-0ab289b068cb`, une adhésion **OWNER ACTIVE** (le seul compte Auth
  confirmé, celui du propriétaire), module `sourcing` **ACTIVE**, événements `MEMBER_BOOTSTRAPPED` et `MODULE_ENABLED` ;
- bucket privé `nordla-backups` (0 objet, aucune politique Storage) ;
- données préexistantes inchangées (empreinte avant / après) ; `finance-inbox` toujours 240 objets.

Commit à déployer : **`62ec977b63e2733e217863c0c05d0e7c3609b9dc`** (inchangé : depuis, seuls `.github`, `docs`, `ops`, `test`, `tools`
ont bougé, rien de ce que l'image exécute).

À faire par la session Railway, **après autorisation**, sur le service existant `sourcing-staging` uniquement (pas de second service) :
1. Variable non secrète à **changer** : `NORDLA_MERCHANT_ID=67646dbb-5e2e-4cd7-aad6-0ab289b068cb` (aujourd'hui : l'id de production).
2. Variables non secrètes à poser : `NORDLA_SERVICE=sourcing`, `SOURCING_HOSTED=1`, `SOURCING_BACKUP_BUCKET=nordla-backups`,
   `SOURCING_PUBLIC_ORIGIN=https://<adresse générée>.up.railway.app` (essai technique d'abord, voir §4), `SUPABASE_URL` = URL du
   projet **staging**.
3. Secrets, saisis **par le propriétaire** directement dans Railway (jamais dans un chat) : `SUPABASE_ANON_KEY` et
   `SUPABASE_SERVICE_ROLE_KEY` du projet **staging**, `NORDLA_IDENTITY_RATE_LIMIT_KEY` et `NORDLA_CSRF_KEY` (deux valeurs différentes,
   ≥ 32 octets), `SOURCING_BACKUP_PASSPHRASE` (≥ 16 caractères, aussi conservée hors ligne).
4. Commande de démarrage `/app/docker-entrypoint.sh node src/service-start.js`, healthcheck `/healthz` (limites CPU / mémoire non
   réglables avec un volume).
5. Activer le patch STAGED, épinglé sur `62ec977`. Coût estimé : 2–4 $/mois (§6, §9).
6. Contrôles §4 (1 à 8), sur l'adresse Railway générée, **données de test uniquement** ; le téléphone n'est pas utilisé à ce stade.

Point à garder en tête : les fichiers créés sur le volume pendant la répétition portent l'id du marchand de test. Le passage ultérieur à
l'identité de **production** (`36b1a1a7-…`) est une étape distincte (migrations production + changement de 3 variables) et ne doit pas
supposer que ces fichiers de test deviennent des données HABB réelles.

## 1. Commit candidat

**Mise à jour du 15/10 au soir : candidat = `62ec977b63e2733e217863c0c05d0e7c3609b9dc`** (= `9e25f1d` + l'export qui affiche « N photo(s)
sur M », la sauvegarde testée des données Core, le canal staging durci). CI verte sur ce SHA : china-sourcing 38770848179,
intégration Node 20/24 38770848181, Activation 38770848224, Provider Provisioning 38770848164. Le reste de ce document s'applique
à l'identique (aucune variable nouvelle, aucun fichier Finance / Analytics / deploy modifié).

`9e25f1d3eb2890c8dc5353170b96f37182250900` (branche `claude/nordla-core-p0`) — remplace l'épinglage actuel `c2c314d`
**uniquement quand le propriétaire le décide et une fois sa CI confirmée verte** (voir le rapport du 15/10).

Ajouté depuis `c2c314d` (36 fichiers) : lecture seule Finance / Analytics par le Core, Branding (proposition + approbation
propriétaire), Marketing (propositions + décision), Création locale sans fournisseur (photo + titre → PNG + contrôles de fidélité),
entrée « Nordla » unique sur le téléphone. **Aucun changement** dans `src/finance`, `src/analysis`, `src/report`, `src/sync`,
`src/service-start.js`, `deploy/`, `railway.json`, `railpack.json` : les services Finance et Analytics hébergés ne sont pas touchés.

Preuves locales sur ce SHA : image construite avec `deploy/sourcing/Dockerfile` (base `node:24-slim`) ; démarrage par
`/app/docker-entrypoint.sh node src/service-start.js` → `/healthz` 200, processus uid 1000 ; rendu Création **dans le conteneur**
= mêmes octets PNG qu'en local (SHA-256 identique), 4 contrôles produit PASS.

## 2. Variables

Déjà posées (patch 7de09a12) : `MERCHANT_TIMEZONE`, `NORDLA_MERCHANT_ID`, `SOURCING_MERCHANT_ID=habb`, `PORT`/`SOURCING_PORT=8787`,
`SOURCING_DATA_DIR=/app/data/sourcing`, `SOURCING_BACKUP_DIR=/app/data/sourcing-backups`, `SOURCING_BACKUP_KEEP=3`, `NODE_ENV`,
`SOURCING_HOST=0.0.0.0`.

**Nouvelle variable obligatoire pour ce candidat : aucune.** Les fichiers de configuration (`config/merchants/habb/creation.json`)
et les polices (`resources/fonts/`) sont dans l'image.

Toujours requis avant activation (inchangé, voir `docs/infrastructure/sourcing-railway-go-live.md`, tableau des variables) :
`NORDLA_SERVICE=sourcing`, `SOURCING_HOSTED=1`, `SOURCING_PUBLIC_ORIGIN`, `SUPABASE_URL` / `SUPABASE_ANON_KEY` /
`SUPABASE_SERVICE_ROLE_KEY` (**staging**), `NORDLA_IDENTITY_RATE_LIMIT_KEY`, `NORDLA_CSRF_KEY` (différents),
`SOURCING_BACKUP_PASSPHRASE`, `SOURCING_BACKUP_BUCKET=nordla-backups`. Secrets : saisis par le propriétaire, jamais dans un chat.

Optionnelles : `NORDLA_DATA_LABEL` (libellé de source affiché, sinon « Supabase <ref> »), `ANALYTICS_REPORTS_DIR` (défaut
`/app/data/analytics-reports`, sur le volume), `ANALYTICS_REFRESH_HOURS` (défaut 3).

Attendu honnête sur staging : Finance / Analytics lisent le projet **staging** (données synthétiques d'un autre marchand) → l'écran
dira « aucune facture » / données indisponibles pour HABB. Ce n'est pas une panne. Les vraies données HABB demandent l'accès lecture
seule en préparation (`docs/infrastructure/prod-readonly-habb-procedure.md`).

## 3. Dépendances Supabase staging (bloquantes pour la connexion)

1. Migrations d'identité 2–5 appliquées sur `fvhiammdskpcnfodsnrc` (workflow `staging-db-ops`, en attente de l'environnement GitHub
   protégé + 2 secrets + go propriétaire). **Sans elles : le service démarre et `/healthz` répond, mais personne ne peut se connecter.**
2. Marchand HABB de test + adhésion OWNER du propriétaire + module `sourcing` activé (après 1 ; compte créé par le propriétaire).
3. Bucket privé `nordla-backups` (copie hors serveur des sauvegardes).

## 4. Contrôles de santé et tests de validation (après activation)

| # | Contrôle | Attendu |
|---|---|---|
| 1 | `GET /healthz` | `200 {"ok":true}` (répond avant le contrôle d'hôte : sonde Railway) |
| 2 | Journaux au démarrage | `Process: Node 24…, uid 1000`, `Nordla Core ON for merchant 67646dbb-…` (staging), `Backups: every 24 h` ; **aucun secret imprimé** |
| 3 | `GET /api/core/modules` sans session | `401` |
| 4 | Connexion propriétaire (téléphone) → menu → « Nordla » | 7 modules ; China Sourcing seul marqué « hors ligne » |
| 5 | Création : photo + titre | PNG affiché, 4 contrôles « conforme », `TEXT : non mesuré`, « Rien n'est publié » |
| 6 | Redémarrage du service | décisions, approbations et visuels toujours présents (volume) |
| 7 | Sauvegarde | archive chiffrée dans `/app/data/sourcing-backups`, copie dans `nordla-backups` ; restauration réelle à vérifier |
| 8 | Finance / Analytics hébergés existants | inchangés (aucun fichier de ces services modifié) |
| 9 | `curl -sI http://<adresse>/` | redirection 301/308 vers `https://` (faite par Railway ; sinon : arrêt, le service ne doit pas servir la page de connexion en clair) |
| 10 | En-têtes du proxy | le service exige `X-Real-IP`, `X-Forwarded-Proto: https`, `X-Forwarded-Host` (posés par Railway) ; s'ils manquent, toute API répond 400 « Requête invalide » : c'est le premier diagnostic à faire |

Audit local du 15/10 au soir (image construite depuis `26cc9a1`, code exécuté identique à `62ec977`, configuration staging prévue,
secrets factices, Supabase volontairement injoignable) : démarrage en ≈ 10 s, uid 1000, aucune capacité, `no_new_privs` ; journal :
« Nordla Core ON for merchant 67646dbb-… », sauvegardes « every 24 h, first in 10 min, bucket nordla-backups » ; **aucun secret** dans
le journal ; `/healthz` 200 quel que soit l'hôte ; avec les en-têtes Railway : `/api/core/modules` et `/api/cases` sans session 401,
origine étrangère 403, POST sans session 401, connexion avec Supabase injoignable 503 « momentanément indisponible » (aucun e-mail ni
mot de passe journalisé) ; hôte non autorisé 421 ; en-têtes HSTS, CSP stricte, `X-Frame-Options: DENY`, `nosniff`, `no-referrer`.

## 5. Retour arrière

- Code : redéployer l'épinglage précédent `c2c314d` (ou l'avant-dernier déploiement Railway). Aucun changement de schéma n'est lié à
  ce candidat.
- Données : les fichiers ajoutés sur le volume (`core/brand-approved.json`, `core/campaigns.jsonl`, `core/creations/`) sont
  **additifs** ; `c2c314d` les ignore. Rien n'est supprimé ni réécrit au retour arrière.
- Arrêt d'urgence : retirer le domaine public du service ou mettre le service à 0 instance ; le volume reste intact.

## 6. Coût mensuel estimé de `sourcing-staging` (tarifs Railway officiels vérifiés le 15/10 : RAM 10 $/Go/mois, CPU 20 $/vCPU/mois, volume 0,15 $/Go/mois)

Mesure locale de l'image `9e25f1d` : **48 Mo de RAM au repos, CPU ≈ 0 %**. Prévision avec rendus Création et rapports Analytics :
100–200 Mo en moyenne.
| Poste | Hypothèse | Coût / mois |
|---|---|---|
| RAM | 0,1–0,2 Go en continu | 1–2 $ |
| CPU | < 0,02 vCPU en moyenne (usage ponctuel) | < 0,5 $ |
| Volume | 1 Go | 0,15 $ |
| Trafic sortant | quelques Go (photos) | < 0,5 $ |
| **Total** | | **≈ 2–4 $ / mois**, en plus des services existants (le plan Hobby inclut 5 $ d'usage au total, tous services confondus) |
À confirmer après une semaine réelle dans l'onglet *Usage* de Railway.

## 7. État réel de Supabase staging (lecture des métadonnées, 15/10 après-midi — **dépassé**, voir §0)
Migration d'identité 1 seule appliquée (`20261015114757 identity_sessions_events`, table `identity_events`) ; migrations 2–5 **non
appliquées** ; 0 compte Auth ; 1 marchand (le marqueur staging) ; bucket `nordla-backups` **absent** (seul `finance-inbox`, privé).
→ Tant que ces points ne sont pas faits, le service démarrerait mais **personne ne pourrait se connecter**.

## 8. Changement de variable nécessaire (identifié le 15/10)

`NORDLA_MERCHANT_ID` vaut aujourd'hui sur `sourcing-staging` **l'identifiant du marchand HABB de production**
(`36b1a1a7-…`). Sur Supabase **staging**, le marchand de test aura son propre identifiant :
**`NORDLA_MERCHANT_ID=67646dbb-5e2e-4cd7-aad6-0ab289b068cb`** (créé par `ops/staging-db/bootstrap-habb-test.sql`). Sans ce changement,
la connexion serait refusée (aucune adhésion sur l'identifiant de production en staging). Avantage : un serveur staging ne peut jamais
correspondre à des lignes HABB réelles. `SOURCING_MERCHANT_ID=habb` (configuration : règles, polices) ne change pas.

## 9. Ressources et coût : fixe / variable

- **Fixe** : l'abonnement Railway du compte (plan Hobby : 5 $/mois, qui inclut 5 $ d'usage tous services confondus) — déjà payé pour
  les services existants ; ce service n'ajoute aucun abonnement.
- **Variable** : l'usage de ce service, estimé à 2–4 $/mois (section 6). Il ne coûte réellement que si l'usage total du compte
  dépasse les 5 $ inclus.
- Limites CPU / mémoire : **non réglables** sur un service avec volume (correction du 16/10, communauté Railway). La dépense est bornée par
  la limite d'usage du compte (`procedure-activation-staging.md` §2) ; le service mesure 48 Mo au repos.
