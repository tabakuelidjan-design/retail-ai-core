# Mise en ligne de Nordla (service `sourcing`) sur Railway — runbook

État au 2026-10-15. Branche `claude/nordla-core-p0`. **Rien n'est encore créé, migré, déployé ni changé dans le DNS.**
Chaque étape marquée **ACCORD** attend l'accord explicite du propriétaire pour *cette* action.

## 0. État réel vérifié

| Élément | État | Comment c'est vérifié |
|---|---|---|
| Code `sourcing` (connexion Core, photos, Nordla Core, sauvegardes) | Prêt ; CI verte sur `a550cff` (6/7 workflows ; Activation : test d'isolation corrigé dans `8ca330c`, voir §6) | GitHub Actions |
| Railway | **Inconnu depuis cette session** : aucun jeton, et l'API `backboard.railway.com` est bloquée par le réseau de la session | `curl` → 403 du proxy |
| Supabase production `xbtzjabbseclmqfozjeo` | 23 migrations, dernière `merchant_connectors` ; marchand HABB `36b1a1a7-2a48-416a-9dfe-ce66fe1ec2a5` | lecture seule (MCP) |
| Supabase staging `fvhiammdskpcnfodsnrc` | mêmes 23 migrations ; marchand synthétique uniquement | lecture seule (MCP) |
| RLS production | 0 table sans RLS ; 27 tables RLS sans policy = fermées au navigateur (seul le serveur lit) ; 0 vue ; 7 fonctions exécutables par `anon`, toutes `SECURITY INVOKER` (donc bloquées par RLS) ; 6 fonctions `fin_*` à `search_path` modifiable (WARN) | `get_advisors`, `pg_proc` |
| Domaine `app.nordla.app` | Acheté chez Porkbun (déclaration du propriétaire) ; aucun enregistrement créé par nous | — |

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
| A | Donner l'accès Railway à la session : jeton **en lecture** dans les secrets de l'environnement (variable `RAILWAY_TOKEN`) + autoriser le domaine `backboard.railway.com` dans l'accès réseau de l'environnement | Propriétaire | nul | retirer le jeton |
| B | Lire l'état réel Railway (projets, services Finance / Analytics, versions déployées, variables **noms seulement**) | Infra | nul (lecture) | — |
| C **ACCORD** | Supabase prod : vérifier qu'une sauvegarde quotidienne existe (Dashboard → Database → Backups) ; sinon sauvegarde manuelle avant D | Propriétaire + Infra | nul | — |
| D **ACCORD** | Appliquer les migrations 1→5 une par une (§1), `get_advisors` après chacune | Infra | faible : objets nouveaux uniquement ; aucune table existante modifiée | fichier de retour arrière §1 (efface les données d'identité créées depuis) |
| E | Supabase Auth : **désactiver les inscriptions publiques** (Authentication → Sign In / Providers → « Allow new users to sign up » off) | Propriétaire | nul pour Finance (connexion propre) | réactiver |
| F | Le propriétaire crée **lui-même** son compte (Authentication → Users → Add user, mot de passe choisi par lui, jamais écrit dans un chat) | Propriétaire | nul | supprimer l'utilisateur |
| G **ACCORD** | `supabase/provisioning/habb-owner-sourcing.sql` avec l'id du compte F : propriétaire OWNER de HABB + module `sourcing` actif | Infra | faible | suspendre le module (ligne dans le fichier) |
| H **ACCORD — coût** | Railway : nouveau service `sourcing` dans le projet existant, depuis la branche validée ; **volume** monté sur `/data` ; variables §3 ; healthcheck `/healthz` (réglé dans le service, pas dans `railway.json` qui est partagé) | Infra | coût mensuel (service + volume) ; Finance / Analytics non touchés (service séparé, `railway.json` et `package.json` inchangés) | supprimer le service (le volume est conservé tant qu'on ne le supprime pas) |
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
