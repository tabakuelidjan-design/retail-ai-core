# Mise en ligne de Nordla (service `sourcing`) sur Railway — runbook

État au 2026-10-15 (fin de journée). Branche `claude/nordla-core-p0`, commit à déployer **`c2c314d`**.
Chaque étape marquée **ACCORD** attend l'accord explicite du propriétaire pour *cette* action.

## 0. État réel vérifié

| Élément | État | Source |
|---|---|---|
| Railway | Projet `app.nordla.app` (`261a1971-…`), environnement `staging` (`6b648e6b-…`), service **`sourcing-staging`** (`24cc9cd0-…`) et volume `sourcing-staging-data` (`d2c0c874-…`, 1 Go, Amsterdam, `/app/data`) **préparés dans un patch STAGED** (`7de09a12-…`, 28 changements) : **rien n'est réellement provisionné ni déployé**. Épinglé sur `c2c314d`, Dockerfile `deploy/sourcing/Dockerfile`, start command `/app/docker-entrypoint.sh node src/service-start.js`, healthcheck `/healthz`, 1 réplique, sommeil désactivé. Finance / Analytics / Core inchangés. **Ne pas créer de second service.** | transmission de la session Railway (ChatGPT), 2026-10-15 |
| Code | Image validée avec Docker (volume root, uid 1000, sonde Railway, HSTS, refus d'origine / CSRF / hôte) ; CI de `c2c314d` : China Sourcing, intégration Node 20/24, Provider verts ; Activation en cours à la rédaction | Docker local, GitHub Actions |
| Supabase production `xbtzjabbseclmqfozjeo` | 23 migrations, dernière `merchant_connectors` ; marchand HABB `36b1a1a7-2a48-416a-9dfe-ce66fe1ec2a5` ; **non utilisé par la préproduction** | lecture seule (MCP) |
| Supabase staging `fvhiammdskpcnfodsnrc` | 23 migrations ; marchand synthétique seulement ; **aucun conflit** pour l'UUID HABB ni pour `nordla-staging/habb-sourcing-staging` ; 0 table d'identité ; 0 compte Auth ; pas de bucket `nordla-backups` | lecture seule (MCP), 2026-10-15 |
| RLS production | 0 table sans RLS ; 27 tables RLS sans policy = fermées au navigateur ; 0 vue ; 7 fonctions exécutables par `anon`, toutes `SECURITY INVOKER` ; 6 fonctions `fin_*` à `search_path` modifiable (WARN) | `get_advisors`, `pg_proc` |
| Domaine `app.nordla.app` | Porkbun ; **aucun enregistrement créé** | — |

Préproduction = service `sourcing-staging` + identité Supabase **staging** (section « Service existant » en fin de document).
Les sections 1–3 ci-dessous décrivent la séquence générique (vérifiée pour la production) ; pour la préproduction, les mêmes
fichiers s'appliquent au projet **staging**.

## 1. Migrations nécessaires à la mise en ligne — et seulement elles

Ordre exact, **une par une**, sur production, chacune suivie d'une vérification avant la suivante :

| # | Fichier | Nature | Touche Finance / Analytics ? |
|---|---|---|---|
| 1 | `supabase/migrations/20260928120000_identity_sessions_events.sql` | additive : `app_sessions`, `identity_events` | non |
| 2 | `supabase/migrations/20260928130000_identity_rate_limits.sql` | additive : limitation des tentatives | non |
| 3 | `supabase/migrations/20260928140000_identity_members.sql` | additive : `merchant_members` | non |
| 4 | `supabase/migrations/20260928150000_identity_modules_sessions.sql` | additive : `module_entitlements`, `identity_open_session` | non |
| 5 | `supabase/migrations-pending/20261015093000_identity_module_sourcing.sql` | ajoute le module `sourcing` aux fonctions 4 | non |

**Pas maintenant** (non nécessaires à Sourcing, risque sur Finance / Analytics en production) : `20260929170000_merchants_deprecate_legacy_identity`,
`20261003…_finance_integrity_p0` → `20261009200000_provider_connections`, et les autres fichiers `migrations-pending/`. À traiter avec la session
Finance, service par service, après le départ.

Preuves (PostgreSQL 16 local isolé, état « production » reconstruit avec les 23 migrations) :
- les 5 s'appliquent dans cet ordre sans erreur ;
- fonctionnel : `BOOTSTRAPPED`, `MODULE_ENABLED`, `SESSION_OPENED` (rôle OWNER), module inconnu → `MODULE_UNKNOWN` ;
- `anon` et `authenticated` : aucun accès aux tables d'identité, aucune exécution des fonctions `SECURITY DEFINER` ;
- **retour arrière** `supabase/rollback/2026-10-sourcing-identity.rollback.sql` : schéma après = schéma avant (diff `pg_dump -s` vide), `merchants` et `auth.users` intacts.

## 2. Ordre d'exécution

| Étape | Action | Qui | Risque | Retour arrière |
|---|---|---|---|---|
| A | ~~Accès Railway pour cette session~~ — **sans objet** : la session Railway (ChatGPT) opère Railway | — | — | — |
| B | ~~Lire l'état Railway~~ — **fait** par la session Railway (§0) | — | — | — |
| C **ACCORD** | Supabase prod : vérifier qu'une sauvegarde quotidienne existe (Dashboard → Database → Backups) ; sinon sauvegarde manuelle avant D | Propriétaire + Infra | nul | — |
| D **ACCORD** | Appliquer les migrations 1→5 une par une (§1), `get_advisors` après chacune | Infra | faible : objets nouveaux uniquement ; aucune table existante modifiée | fichier de retour arrière §1 (efface les données d'identité créées depuis) |
| E | Supabase Auth : **désactiver les inscriptions publiques** (Authentication → Sign In / Providers → « Allow new users to sign up » off) | Propriétaire | nul pour Finance (connexion propre) | réactiver |
| F | Le propriétaire crée **lui-même** son compte (Authentication → Users → Add user, mot de passe choisi par lui, jamais écrit dans un chat) | Propriétaire | nul | supprimer l'utilisateur |
| G **ACCORD** | `supabase/provisioning/habb-owner-sourcing.sql` avec l'id du compte F : propriétaire OWNER de HABB + module `sourcing` actif | Infra | faible | suspendre le module (ligne dans le fichier) |
| H **ACCORD — coût** | Railway : **activer** le patch STAGED `7de09a12-…` (service `sourcing-staging` + volume 1 Go déjà préparés ; ne pas créer d'autre service) après saisie des valeurs (« Service existant ») et estimation du coût | Session Railway | coût mensuel (service + volume + stockage hors Railway) à chiffrer ; Finance / Analytics non touchés | désactiver / supprimer le service ; le volume est conservé tant qu'on ne le supprime pas |
| I **ACCORD** | Supabase Storage : bucket **privé** `nordla-backups` (sauvegardes chiffrées hors Railway) | Infra | quota de stockage | supprimer le bucket |
| J | Essai sur l'adresse Railway générée (`https://<service>.up.railway.app`) : `/healthz`, page de connexion, connexion, refus sans session, une sauvegarde forcée + restauration dans un dossier vide | Infra | nul | — |
| K **ACCORD — DNS** | Porkbun : `CNAME app → <cible donnée par Railway>` + l'enregistrement `TXT` de vérification demandé par Railway ; puis `SOURCING_PUBLIC_ORIGIN=https://app.nordla.app` | Propriétaire (Porkbun) + Infra | aucun autre sous-domaine touché | supprimer le CNAME |
| L | Test Xiaomi sur **`https://app.nordla.app`** (§5) — c'est la seule adresse que le téléphone doit connaître : changer d'adresse ensuite = stockage du navigateur vide | Propriétaire | — | — |

Pourquoi pas une URL de préproduction séparée pour le Xiaomi : le stockage du téléphone (dossiers, photos) appartient à **l'adresse**.
Tester sur une adresse puis passer à une autre obligerait à migrer les données du téléphone. L'adresse Railway générée sert donc
seulement à l'essai J (Infra, sans le téléphone) ; le téléphone utilise directement `app.nordla.app`.

## 3. Variables du service Railway `sourcing`

Valeurs secrètes générées par le propriétaire (ex. `openssl rand -hex 32`) et saisies **directement dans Railway**, jamais dans un chat.

| Variable | Valeur |
|---|---|
| `NORDLA_SERVICE` | `sourcing` |
| `RAILPACK_NODE_VERSION` | `24` (Node 24 pour ce service seulement ; Finance / Analytics gardent le leur) |
| `SOURCING_HOSTED` | `1` |
| `NORDLA_MERCHANT_ID` | `36b1a1a7-2a48-416a-9dfe-ce66fe1ec2a5` |
| `SOURCING_MERCHANT_ID` | `habb` |
| `SOURCING_PUBLIC_ORIGIN` | `https://<service>.up.railway.app` pour J, puis `https://app.nordla.app` |
| `SOURCING_DATA_DIR` | `/data/sourcing` |
| `SOURCING_BACKUP_DIR` | `/data/sourcing-backups` |
| `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_ANON_KEY` | projet production (référence aux variables partagées existantes si possible) |
| `NORDLA_IDENTITY_RATE_LIMIT_KEY`, `NORDLA_CSRF_KEY` | deux secrets **différents**, ≥ 32 octets |
| `SOURCING_BACKUP_PASSPHRASE` | ≥ 16 caractères ; **aussi** dans le gestionnaire de mots de passe du propriétaire + papier (sans elle, aucune archive ne se relit) |
| `SOURCING_BACKUP_BUCKET` | `nordla-backups` |

Le port : le service lit `PORT` fourni par Railway en mode hébergé. Le démarrage échoue avec un code explicite si une variable manque.

## 4. Sauvegarde et restauration

- Tous les jours (première 10 min après le démarrage) : archive chiffrée de `/data/sourcing` (dossiers, photos, journal Nordla Core),
  14 copies locales, **copie hors Railway** dans le bucket privé, sans écrasement. Un échec est journalisé et retenté, le service continue.
- Restauration : `node tools/sourcing-backup.mjs fetch <archive> <dossier>` puis `restore <archive> <dossier vide>` ; on vérifie, puis on
  bascule. Exercice prouvé : `test/sourcing-backup-full-restore.test.js` (dossier, photo et journal Core identiques sur un nouveau serveur ;
  archive modifiée refusée ; jamais d'écriture dans un dossier non vide).
- Limite honnête : le bucket n'est pas « immuable » face à quelqu'un qui détient la clé service (verrouillage d'objet = autre fournisseur,
  décision du propriétaire). Le test de restauration **sur le vrai serveur** reste à faire à l'étape J.

## 5. Test réel du 18 octobre (Xiaomi, PC éteint, Wi-Fi coupé, données mobiles)

1. Ouvrir `https://app.nordla.app` → écran Connexion ; se connecter.
2. Créer un dossier, 3 photos, des notes ; vérifier « enregistré sur le serveur ».
3. Fermer complètement le navigateur, rouvrir : dossier, photos, notes présents.
4. Mode avion : l'application s'ouvre et le dossier se modifie ; repasser en données mobiles : la synchronisation reprend.
5. Menu → Nordla Core : analyser l'achat, décider avec une raison, poser une question à Parle à Nordla.
6. Le soir : vérifier dans les journaux Railway qu'une sauvegarde est partie (`Backup OK`).

## 6. Points ouverts

- `growth-browser.test.js` : blocage intermittent de Chrome dans la suite d'un seul processus (workflow Activation coupé à 15 min sur
  `a550cff`) ; sans lien avec Sourcing ; à corriger par Core P0 sans désactiver le test.
- Lecture Finance / Analyses depuis le Core : après le départ (connexion propre de Finance à remplacer d'abord).

## Service existant `sourcing-staging` — ce qui a été vérifié et ce qu'il faut régler

Vérifié ici avec Docker sur l'image construite depuis la branche (le seul écart local : le certificat du proxy de la session, passé
en secret de build et absent de l'image) :

1. **Volume** : avec `USER node`, un volume monté par root (cas Railway) faisait planter le démarrage (`EACCES`, reproduit). Corrigé :
   `deploy/sourcing/docker-entrypoint.sh` donne `/app/data` (et les dossiers de données / sauvegardes) à `node`, puis lance le service
   sous `node` (uid 1000, aucune capacité, `no_new_privs`) — vérifié dans `/proc/1/status`. Écriture, sauvegarde et redémarrage vérifiés.
2. **Commande de démarrage** : la fixer à `/app/docker-entrypoint.sh node src/service-start.js` dans le service. Vérifié : correct que
   Railway garde l'ENTRYPOINT de l'image ou non. Sans cela, si la commande `railway.json` (`node src/service-start.js`) remplace
   l'ENTRYPOINT, le service tourne en root — il le signale au démarrage (`uid 0 (ROOT …)`).
3. **Healthcheck** : la sonde Railway arrive avec l'hôte `healthcheck.railway.app` ; elle aurait reçu 421 (déploiement refusé). Corrigé :
   `/healthz` répond quel que soit l'hôte (sans donnée) ; tout le reste garde la liste d'hôtes.
4. **HTTPS / cookies / CSRF** : vérifié sur le conteneur avec `SOURCING_PUBLIC_ORIGIN=https://app.nordla.app` : origine étrangère → 403,
   requête vue en HTTP → 400, modification sans session/CSRF → 401, autre hôte → 421 ; cookies `__Host-` (Secure, sans Domain, liés
   à l'hôte exact) ; HSTS ajouté pour cet hôte seul. Un changement d'origine = nouvelle connexion (cookies) et stockage du téléphone vide :
   le téléphone n'utilise que `https://app.nordla.app`.
5. **Sauvegardes** : couvrent tout `/app/data/sourcing` (dossiers + espace de travail, photos, journal Core, cache Safety Gate).
   Copies locales sur le même volume de 1 Go : **3** par défaut (`SOURCING_BACKUP_KEEP`), et aucune écriture si l'espace libre ne suffit
   pas (`BACKUP_LOW_SPACE`, journalisé) ; l'historique est hors Railway (bucket privé). Attention : le quota de stockage Supabase (offre
   gratuite 1 Go) se remplira aussi avec le temps : surveiller, ou décider d'une purge des archives anciennes (décision propriétaire).

Identité de la préproduction (Supabase **staging** `fvhiammdskpcnfodsnrc`, aucune donnée de production touchée), ordre :
a. **ACCORD** — appliquer les 5 migrations (§1) sur staging, une par une ; smoke `test/postgres/sourcing-identity-sequence.pg-smoke.mjs` 27/27 en local ;
b. **ACCORD** — `supabase/provisioning/staging-habb-merchant.sql` (marchand HABB avec **le même UUID** que la production) ;
c. propriétaire : couper les inscriptions publiques de l'Auth staging, créer son compte (mot de passe choisi par lui) ;
d. **ACCORD** — `supabase/provisioning/habb-owner-sourcing.sql` sur staging avec l'id de ce compte.
Plus tard, passage à l'identité de production **sur le même service et le même volume** : mêmes étapes sur production (§2 C→G) puis
changement des 3 variables Supabase du service ; le volume reste lisible parce que l'UUID marchand est le même. Changer de service ou
de volume demande en plus la migration des données serveur (section suivante) : l'UUID seul ne transfère rien.

Valeurs à régler dans `sourcing-staging` (en plus de celles déjà préparées) — secrets saisis directement dans Railway :

| Variable | Valeur | Secret |
|---|---|---|
| `NORDLA_MERCHANT_ID` | `36b1a1a7-2a48-416a-9dfe-ce66fe1ec2a5` | non |
| `SOURCING_MERCHANT_ID` | `habb` | non |
| `SOURCING_PUBLIC_ORIGIN` | d'abord l'adresse `https://<service>.up.railway.app` générée par Railway, pour l'essai technique **sans données réelles** ; puis `https://app.nordla.app` (changement d'origine = reconnexion ; le téléphone n'utilise que la seconde) | non |
| `SUPABASE_URL` | URL du projet **staging** | non |
| `SUPABASE_ANON_KEY` | clé publique du projet staging | quasi (ne pas diffuser) |
| `SUPABASE_SERVICE_ROLE_KEY` | clé service du projet staging | **oui** |
| `NORDLA_IDENTITY_RATE_LIMIT_KEY` | 32 octets aléatoires (`openssl rand -hex 32`) | **oui** |
| `NORDLA_CSRF_KEY` | 32 octets aléatoires, **différents** du précédent | **oui** |
| `SOURCING_BACKUP_PASSPHRASE` | ≥ 16 caractères, aussi dans le gestionnaire de mots de passe + papier | **oui** |
| `SOURCING_BACKUP_BUCKET` | `nordla-backups` (bucket privé à créer sur staging — **ACCORD**) | non |
| `SOURCING_BACKUP_KEEP` | `3` (optionnel) | non |
| Commande de démarrage | `/app/docker-entrypoint.sh node src/service-start.js` | — |
| Commit | `c2c314d` (fait par la session Railway ; `e84918e` n'avait ni l'entrypoint ni la correction du healthcheck) | — |

## Changer de service, de volume ou d'environnement : migration des données serveur (obligatoire, testée)

Avoir le même UUID marchand **ne déplace aucun fichier** : dossiers, photos et journal Core sont sur le volume du service. Ils ne
passent d'un volume à un autre que par cette procédure :
1. ancien service : `node tools/sourcing-backup.mjs offsite /app/data/sourcing /app/data/sourcing-backups` (archive chiffrée + copie hors Railway) ;
2. nouveau service, **avant** d'y ouvrir l'accès : `node tools/sourcing-backup.mjs fetch <archive> /app/data/restore-in` puis
   `restore /app/data/restore-in/<archive> /app/data/sourcing` (le dossier cible doit être **vide** : jamais d'écrasement) ;
3. démarrer : le journal Core est re-vérifié (chaîne SHA-256) ; une photo est re-vérifiée à chaque lecture ;
4. l'ancien volume est conservé tant que le propriétaire n'a pas vérifié le nouveau (aucune suppression).
Preuve automatisée : `test/sourcing-backup-full-restore.test.js` (serveur A → archive → restauration → serveur B : même dossier, même
photo, même journal ; archive modifiée refusée). À rejouer **sur Railway réel** après activation (étape J).
Identité : les comptes et sessions Supabase staging et production sont distincts. Passer à l'identité de production = recréer le
compte propriétaire en production (§2 C→G) puis changer les 3 variables Supabase du service ; chacun se reconnecte. Si l'adresse
reste `https://app.nordla.app`, le stockage du téléphone est conservé.
