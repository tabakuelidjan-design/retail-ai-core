# ADR 0004 : l'identité Nordla appartient à Core

- **Statut :** ACCEPTÉ le 2026-09-28 (décisions D1 à D10, D-merchants et N1 à N7 validées par le propriétaire, § 11 et § 12).
  **Rien n'est implémenté** : aucune migration, aucun compte, aucune variable Railway, aucun service créé ou modifié.
- **Date :** proposé le 2026-09-28, accepté le 2026-09-28 (phase C0).
- **Branche :** `feature/core-identity` (depuis `5679382`, poussé sur `origin/feature/growth-priorities-v1`).
- **Liens :** ADR 0003 (identité du tenant, résolveur `src/tenant/`, bascule Shopify), `docs/growth/GROWTH_DEEP_AUDIT.md`,
  `docs/security/baseline.md`.

Dans tout ce document, quatre états sont toujours distingués :

| État | Signification |
|---|---|
| **Accepté** | décision validée par le propriétaire ; ne dit rien du code |
| **Construit** | code et tests présents dans le dépôt |
| **Déployé** | code réellement en service (Railway), vérifié |
| **À faire** | ni construit ni déployé |

## Décision

L'identité des utilisateurs, leur appartenance à une entreprise (marchand), leurs rôles, leurs sessions et leurs droits d'accès aux
modules **appartiennent à Core**. Finances, Analyses et Développement des ventes restent des modules autonomes (services, domaines et
déploiements séparés), mais utilisent **la même identité Nordla** : mêmes comptes, mêmes appartenances, mêmes règles d'accès, même
magasin de sessions, même journal de sécurité, via une seule bibliothèque serveur partagée. Développement des ventes est le premier
module à l'utiliser ; la conception n'est pas propre à Growth.

Core reste nommé **Core** : c'est la fondation commune de Nordla, pas un module métier vendu séparément. Il peut avoir une interface
d'administration réservée au propriétaire et aux personnes autorisées (§ 12, N1).

---

## 1. Ce qui existe réellement aujourd'hui (vérifié le 2026-09-28, phase C0)

Vérifications faites en lecture seule : Git, suite de tests, `railway status` / variables (noms seulement), requêtes SQL de lecture
sur les deux projets Supabase. Aucune valeur secrète n'a été affichée.

### 1.1 Modules

| Module | Authentification actuelle | Sessions | Journal |
|---|---|---|---|
| **Core** | Aucune. Core = planificateur de synchronisation Shopify (`src/sync/scheduler.js`) ; pas de serveur HTTP, pas d'utilisateurs | — | `sync_runs` (synchro seulement) |
| **Finances** | Un jeton partagé `FINANCE_DASHBOARD_TOKEN` (≥ 24 car.) saisi sur une page de connexion ; comparaison en temps constant ; limiteur de tentatives par IP | Cookie `fin_sid` HttpOnly, SameSite=Strict, Secure en ligne, 8 h ; jeton CSRF sur toute requête modifiante ; Origin vérifiée ; sessions dans un **fichier local** (`sessions.json`, identifiants hachés SHA-256) | `audit.log` local (LOGIN, LOGIN_FAILED, actions) |
| **Analyses** | Un jeton partagé `ANALYTICS_ACCESS_TOKEN` (≥ 24 car.) envoyé **à chaque requête** en HTTP Basic ; 5 échecs → blocage 5 min par IP | Aucune (pas de session, pas de déconnexion, pas d'expiration) | Aucun journal de connexion |
| **Développement des ventes** | **Aucune.** Écoute sur 127.0.0.1 uniquement, **sans contrôle du domaine (Host)** ; absent de `src/service-start.js`, donc non déployable | — | — |

Points communs déjà présents (Finances et Analyses, fichiers `server/hosting.js`, **code dupliqué**) : liste des domaines autorisés
(`*_ALLOWED_HOSTS`), IP client prise dans `X-Forwarded-For` compté depuis la droite (proxy de confiance), HSTS, en-têtes stricts (CSP
sans script inline, `nosniff`, `no-referrer`, `frame-ancestors 'none'`).

Aucune notion de **personne** : on ne sait pas *qui* s'est connecté, seulement que *quelqu'un* connaissait le jeton.

### 1.2 Tenant

- Résolveur unique `src/tenant/index.js` (ADR 0003). Source utilisée : `NORDLA_MERCHANT_ID` (un service = un marchand). La source
  **`session` est réservée mais non implémentée** (refus explicite `TENANT_SOURCE_NOT_AVAILABLE`). Aucune requête ne peut choisir le
  marchand (vérifié et testé).
- **Construit, pas déployé en production** : la production tourne encore sur l'ancienne identification par Shopify (ADR 0003 § 12).
- Table `merchants (id, name, vertical, created_at, source_system, source_id, source_domain)` ; `source_system` / `source_id` sont
  toujours `NOT NULL` + `UNIQUE` (M2 non fait). Table `merchant_connectors` : **staging seulement**.

### 1.3 Base de données (vérifié en SQL le 2026-09-28)

| | Production (`xbtzjabbseclmqfozjeo`) | Staging (`fvhiammdskpcnfodsnrc`) |
|---|---|---|
| Tables `public` | 26, **RLS activé sur toutes** | 27 (+ `merchant_connectors`), RLS activé sur toutes |
| Politiques RLS (`public` et `storage`) | **aucune** | **aucune** |
| Migrations appliquées | les 22 migrations du dépôt **sauf** `merchant_connectors` (mêmes noms ; les numéros de version sont les dates d'application) | les 23 migrations du dépôt |
| Marchands | 1 (HABB) | 1 (« Nordla Staging Retail (synthetic) ») |
| Utilisateurs `auth.users` | 0 | — |
| Bucket de stockage | `finance-inbox`, privé | — |

- Les serveurs utilisent la clé **service role** (jamais envoyée au navigateur). Client maison sans SDK (`fetch`).
- Aucune politique n'existe en base : il n'y a donc **rien à rapatrier** dans des migrations (D8). Une ancienne note interne
  mentionnant « ~2 politiques » est **fausse** (corrigée par cette vérification).
- L'isolation entre marchands repose sur les filtres `merchant_id` du code (testés, `test/tenant-isolation.test.js`).
- **Supabase Auth n'est pas utilisé** : aucune table d'utilisateurs Nordla, aucune appartenance, aucun rôle.
- Écart documentaire mineur : l'en-tête de `20260926160000_finance_purchase_document_model.sql` dit « NOT APPLIED » alors qu'elle est
  appliquée en production et en staging (commentaire périmé ; une migration appliquée n'est pas réécrite).

### 1.4 Domaines et Railway (vérifié le 2026-09-28)

| Environnement Railway | Service | Commit déployé | Domaine |
|---|---|---|---|
| production | Finance | `21dc924` (`feature/finance-shipping-vat-fix`) | `finance-production-8f71.up.railway.app` |
| production | Analytics | `e593475` (`feature/explorer-period-selector`) | `analytics-production-2c30.up.railway.app` |
| production | Core | `b7973dd` (`feature/core-sync-cron`) | aucun (tâche de fond) |
| production | nordla | — (en veille, gabarit « Hello world ») | `nordla-production.up.railway.app` |
| staging | finance-staging, analytics-staging, core-staging, shopify-stub-staging | déployés par envoi direct (pas de commit enregistré par Railway) | `*-staging-staging.up.railway.app` ; core-staging sans domaine |

- Variables de production (noms seulement) : **ni `NORDLA_MERCHANT_ID` ni `NORDLA_SERVICE`** sur Finance, Core et Analytics.
- Staging : `NORDLA_MERCHANT_ID` et `NORDLA_SERVICE` présents ; projet Supabase distinct ; Shopify = service simulé
  (`shopify-stub-staging`) ; **aucun** des secrets Shopify / Supabase de staging n'est identique à la production (comparaison par
  empreinte, sans affichage) ; données synthétiques.
- Aucun domaine personnalisé n'est configuré.
- **`up.railway.app` figure dans la Public Suffix List** (entrée soumise par Railway). Conséquence technique vérifiée : chaque
  service est un « site » distinct pour le navigateur ; un cookie `Domain=up.railway.app` est **refusé** ; aucun cookie ne peut être
  partagé entre Finances, Analyses et Growth sur ces domaines, et les appels entre eux sont *cross-site* (SameSite).
- `nordla.app` est enregistré (DNS chez Porkbun, page de parking) ; `app.nordla.app` et `www.nordla.app` pointent vers ce parking.
  Il n'est relié à aucun service. `.app` impose HTTPS (HSTS préchargé).
- Trois autres projets Railway existent (`caring-luck`, `ideal-renewal`, `illustrious-grace`) et n'ont pas été inspectés.

---

## 2. Ce qui sera construit dans Core (accepté, à faire)

### 2.1 Fournisseur d'identité : Supabase Auth (D1 accepté)

Retenu parce que :
- il est déjà dans l'infrastructure (même projet Supabase que les données) : pas de nouveau fournisseur, pas de mot de passe stocké
  par Nordla ;
- il offre ce qu'exige ce chantier : comptes personnels e-mail + mot de passe, réinitialisation (plus tard, D7), **double
  authentification TOTP** (niveaux `aal1` / `aal2`, D10), limites de débit intégrées, journal `auth.audit_log_entries` ;
- il s'utilise en **REST** (`/auth/v1/...`) avec le même client `fetch` que le reste du code : aucune dépendance, aucun SDK dans le
  navigateur.

**Le navigateur ne parle jamais à Supabase.** Modèle « backend for frontend » : le navigateur parle à son module ; le serveur du
module parle à Supabase. Donc ni clé `service_role`, ni clé `anon`, ni jeton Supabase dans le navigateur (D6).

### 2.2 Modèle de données (esquisse, **pas une migration**)

```
auth.users                      géré par Supabase Auth (e-mail, mot de passe haché, facteurs MFA). Nordla n'y écrit jamais directement
                                (création des comptes par l'API d'administration Supabase, côté serveur, D7).

merchants (existant)            id, name, vertical, created_at, source_system, source_id, source_domain
                                + à terme (D-merchants) : status ('active' | 'suspended'), updated_at. Pas de migration en C0.

merchant_members                qui appartient à quelle entreprise, avec quel rôle (construit en C2, migration 20260928140000)
  merchant_id   uuid not null  -> merchants(id) on delete restrict
  user_id       uuid not null  -> auth.users(id) on delete restrict
  role          text not null  check (role in ('OWNER','ADMIN','COLLABORATOR','VIEWER','ACCOUNTANT'))   -- D3
  status        text not null  check (status in ('ACTIVE','SUSPENDED'))   -- suspended_at renseigné si et seulement si SUSPENDED
  created_at, updated_at, suspended_at, created_by (uuid null), updated_by (uuid null)
  primary key (merchant_id, user_id)          -- plusieurs utilisateurs par entreprise, plusieurs entreprises par utilisateur
  -- au moins un OWNER actif par entreprise : garanti EN BASE (fonctions + déclencheur sous verrou par entreprise), jamais
  -- supprimée physiquement (on quitte une entreprise en étant suspendu)

merchant_invitations            PAS en v1 (D7) ; esquisse conservée pour plus tard
  id, merchant_id -> merchants, email (citext), role, token_hash (sha256), status ('pending','accepted','revoked','expired'),
  expires_at, invited_by, accepted_by, created_at, updated_at ; unique (merchant_id, email) where status = 'pending'

module_entitlements             modules activés par entreprise (construit en C3, migration 20260928150000)
  merchant_id  -> merchants (on delete restrict)
  module_code  check (module_code in ('finance','analytics','growth'))   -- registre FERMÉ, identique à src/identity/modules.js ;
                                                                         -- Core n'est pas un module et n'a jamais d'entitlement
  status       check (status in ('ACTIVE','SUSPENDED')), enabled_at, suspended_at (si et seulement si SUSPENDED),
  created_at, updated_at, source (provenance, ex. provisioning:manual), last_operation_id (corrélation)
  primary key (merchant_id, module_code) -- jamais supprimée physiquement ; écriture directe refusée au rôle serveur
  -- activation / suspension : UNIQUEMENT par l'opération interne Nordla de provisioning ou de facturation (fonction
  -- identity_module_set, sans acteur, non exposée au client), journalisée ATOMIQUEMENT (MODULE_ENABLED / MODULE_SUSPENDED).
  -- Un OWNER ou un ADMIN ne peut jamais activer lui-même un module ; aucun rôle ne contourne un module absent ou suspendu.

app_sessions                    sessions de l'application (une par connexion à un module)
  id uuid pk, token_hash text unique (sha256 du cookie), user_id -> auth.users, merchant_id -> merchants,
  module text (module où la session a été ouverte), aal text ('aal1'|'aal2'),
  created_at, last_seen_at, expires_at (absolue, 12 h), idle_expires_at (2 h), revoked_at null, revoked_reason null,
  ip_hash, user_agent (tronqué)
  -- index (user_id) where revoked_at is null  -> « se déconnecter partout »
  -- AUCUN jeton Supabase n'est stocké (D6)

identity_events                 journal de sécurité, en ajout seul
  id bigint identity, at timestamptz, event text (LOGIN_SUCCEEDED, LOGIN_FAILED, LOGOUT, LOGOUT_ALL, SESSION_EXPIRED,
  SESSION_REVOKED, ACCESS_DENIED, ACCOUNT_CREATED, MEMBER_ADDED, ROLE_CHANGED, MEMBER_SUSPENDED, MODULE_ENABLED, MODULE_DISABLED,
  MFA_ENROLLED, MFA_CHALLENGE_FAILED, RATE_LIMITED), user_id null, merchant_id null, module null, ip_hash, correlation_id, detail jsonb
  -- jamais de mot de passe, jeton, cookie ou e-mail en clair dans detail ; UPDATE / DELETE refusés
```

Raisons :
- `merchant_members` sépare **qui** (Supabase) de **où et avec quel rôle** (Nordla) ; l'unicité `(merchant_id, user_id)` permet
  plusieurs personnes par entreprise et une personne dans plusieurs entreprises, sans rien changer plus tard.
- `module_entitlements` au niveau entreprise : l'accès à un module = appartenance ACTIVE **et** module ACTIVE pour l'entreprise ;
  aucun rôle ne remplace l'activation. Registre **fermé** (liste SQL et code, testés ensemble) : un nouveau module est ajouté
  délibérément, par une migration et une modification du code.
- `app_sessions` en base (et non en fichier local comme Finances) : survit aux redéploiements, partagée entre instances, et permet la
  **révocation depuis n'importe quel module** (déconnexion commune sans cookie commun, voir § 3).

### 2.3 Rôles (D3 accepté)

Rôles définitifs (validés et construits en C2). Ils sont définis **par entreprise** : une même personne peut avoir un rôle différent
dans chaque entreprise.

| Rôle (affiché) | Code interne | Gestion des membres |
|---|---|---|
| Propriétaire | `OWNER` | tous les rôles, y compris d'autres OWNER et les ADMIN |
| Administrateur | `ADMIN` | seulement COLLABORATOR, VIEWER et ACCOUNTANT ; jamais un OWNER, un ADMIN ni lui-même |
| Collaborateur | `COLLABORATOR` | aucune |
| Lecture seule | `VIEWER` | aucune |
| Comptable | `ACCOUNTANT` | aucune |

- Une appartenance est `ACTIVE` ou `SUSPENDED`. Une personne quitte une entreprise en étant suspendue ; aucune appartenance n'est
  supprimée physiquement.
- **Aucun rôle ne contourne l'activation d'un module** : l'accès à un module exige une appartenance ACTIVE **et** le module activé pour
  l'entreprise. **ACCOUNTANT ne donne pas automatiquement accès à Finances.** Les permissions détaillées à l'intérieur des modules
  viendront avec chaque module.
- La **matrice de gestion des membres** est dans le code (`src/identity/members.js`, `MEMBER_RULES`), testée, et appliquée à
  l'identique par les fonctions SQL (accord vérifié sur 215 cas).
- **Il reste toujours au moins un OWNER actif** par entreprise, **garanti en base** : les fonctions de modification et un déclencheur,
  sous un verrou par entreprise, refusent toute suspension, rétrogradation ou suppression qui violerait cette règle, même en
  concurrence. Pour partir, un OWNER nomme d'abord un autre OWNER. Une procédure de secours (service role) sera documentée.
- Les libellés affichés sont en français simple ; les codes anglais restent internes.

### 2.4 RLS (D8 accepté)

- **Toutes** les nouvelles tables : RLS activé, **aucune politique** en v1 (même règle que les 26/27 tables existantes, vérifiées
  sans politique) : seuls les serveurs, avec la clé service role, y accèdent ; le navigateur n'a aucun chemin vers Supabase.
- `identity_events` : UPDATE / DELETE révoqués au rôle applicatif (journal non modifiable).
- **Bêta HABB** : fonctionnement serveur actuel conservé.
- **Obligatoire avant l'ajout d'un deuxième client réel** (phase C14) : lectures métier exécutées avec le JWT de l'utilisateur (rôle
  `authenticated`) et politiques par entreprise du type
  `using (exists (select 1 from merchant_members m where m.merchant_id = <table>.merchant_id and m.user_id = auth.uid() and m.status = 'ACTIVE'))`.
- Inventaire préalable exigé par D8 : **fait le 2026-09-28** (§ 1.3) — aucune politique en base, rien à rapatrier ; toute politique
  future sera créée **uniquement** par une migration versionnée du dépôt.

### 2.5 Bibliothèque serveur partagée `src/identity/`

Un seul code, utilisé par chaque module (aucun module n'écrit sa propre authentification) :

| Fichier | Rôle |
|---|---|
| `gotrue.js` | appels REST Supabase Auth : vérification e-mail + mot de passe, fermeture immédiate de la session Supabase, facteurs MFA (plus tard) |
| `sessions.js` | création (32 octets aléatoires, stockés hachés), lecture, expiration absolue (12 h) et d'inactivité (2 h), révocation, « partout » |
| `permissions.js` | matrice rôle × module × action (D3), testée |
| `access.js` | décision d'accès : membre actif × module activé × permission du rôle ; cache court (≤ 60 s) |
| `guard.js` | domaine autorisé (Host), Origin / Sec-Fetch-Site, CSRF (jeton synchronisé), limitation des tentatives, en-têtes de sécurité — remplacera à terme les deux `server/hosting.js` dupliqués |
| `events.js` | écriture `identity_events` (sans secret) |
| `routes.js` | `POST /api/auth/login`, `POST /api/auth/logout` (option « partout »), `GET /api/auth/session` |
| `config.js` | configuration par service (domaines autorisés, proxy de confiance, durées), refus de démarrer si incomplète en ligne |

**Jetons Supabase (D6 accepté) :** jamais envoyés ni conservés dans le navigateur comme session applicative. Le serveur vérifie
l'identité auprès de Supabase Auth (et, plus tard, le défi MFA dans la même procédure de connexion), puis **ferme la session Supabase
et ne conserve aucun jeton Supabase** ; la seule session est la session serveur Nordla révocable (`app_sessions`). Conséquence : la
variable `NORDLA_IDENTITY_TOKEN_KEY` initialement envisagée n'est plus nécessaire.

### 2.6 Résolution du tenant

- La source `session` du résolveur est implémentée (phase C3) : le marchand vient de la **session serveur**, jamais d'un paramètre,
  d'un en-tête ou d'un corps de requête.
- Tant que « un service = un marchand » (ADR 0003 § 11) : la session doit porter **exactement** le `NORDLA_MERCHANT_ID` du service,
  sinon 403 (`ACCESS_DENIED`), même si l'utilisateur est membre d'un autre marchand.
- Plus tard (multi-entreprise réel, C15) : choix du marchand après connexion parmi les appartenances actives, mémorisé côté serveur ;
  tout changement repasse par une vérification d'appartenance.

---

## 3. Domaines, cookies et sessions entre services

**Identité commune ≠ cookie commun.** L'identité commune = mêmes comptes, appartenances, droits, table de sessions et journal.
Un cookie commun = un même cookie envoyé à plusieurs services ; c'est **impossible** sur les domaines actuels (§ 1.4) et **non
nécessaire** pour une identité commune.

### 3.1 Première version (D4 accepté)

- Une seule identité Nordla, **le même e-mail et le même mot de passe** dans chaque module, une **session propre à chaque module**,
  **aucun cookie partagé** entre les domaines Railway actuels. Pas de SSO en v1 : ouvrir un deuxième module redemande la connexion.
- Chaque module pose **son propre cookie** de session, limité à son hôte : `__Host-nordla_sid` — `Secure`, `HttpOnly`, `Path=/`,
  sans attribut `Domain`, valeur aléatoire opaque, rien d'autre (D5).
- **Durées (D5 accepté)** : 12 heures maximum depuis la connexion, expiration après 2 heures d'inactivité.
- **Déconnexion :** « Se déconnecter » ferme la session de ce module ; « Se déconnecter partout » révoque **toutes** les sessions de
  la personne dans `app_sessions`. Chaque module vérifie la révocation à chaque requête (lecture en base, cache ≤ 30 s) : la
  déconnexion commune fonctionne **sans cookie commun**.
- **Pas trois systèmes divergents :** une bibliothèque, une table de sessions, un journal. Les mécanismes actuels (jeton Finances,
  jeton Basic Analyses) sont retirés lors de la migration de chaque module (C10, C11).

### 3.2 SameSite recommandé : `Lax` (justification)

- Les modules sont sur des « sites » différents (Public Suffix List, § 1.4). Avec `SameSite=Strict`, **tout lien venant d'un autre
  module ou de la future page Core** (« Applications connectées ») arrive **sans cookie** : la personne verrait l'écran de connexion
  alors qu'elle a une session valide dans ce module. `Lax` envoie le cookie lors d'une navigation de premier niveau (clic sur un lien,
  `GET`), ce qui rend la navigation entre applications normale.
- `Lax` ne l'envoie **pas** sur les requêtes intersites en arrière-plan (`fetch`, formulaires `POST`, images, iframes) : les
  requêtes modifiantes intersites restent sans session.
- La protection contre la falsification de requêtes ne repose pas sur SameSite seul : jeton CSRF synchronisé exigé en en-tête sur
  toute requête modifiante, vérification `Origin` / `Sec-Fetch-Site`, et **aucune route `GET` ne modifie de donnée** (règle testée).
- `Strict` reste possible pour un module isolé ; Finances utilise `Strict` aujourd'hui et passera à la règle commune lors de sa
  migration (C10). Le choix `Lax` est la **recommandation** documentée ; il est confirmé dans C1 avec les tests.

### 3.3 Plus tard : connexion centrale (C14)

**Connexion centrale sans cookie partagé** : un point de connexion unique servi par Core (`compte.nordla.app`) ; un module sans
session redirige vers lui ; après connexion, il renvoie vers le module (adresse de retour sur liste blanche) avec un **code à usage
unique** (≤ 60 s, lié au module) que le serveur du module échange, de serveur à serveur, contre sa propre session `__Host-`. Même
expérience qu'un SSO, chaque module garde un cookie limité à son hôte, la révocation reste centrale. Prérequis : DNS `nordla.app`
(Porkbun), domaines personnalisés Railway, API d'identité exposée par le service Core (N1). Un cookie de session unique
`Domain=nordla.app` reste **écarté** (surface d'exposition, incompatible avec le préfixe `__Host-`).

### 3.4 Protections communes (toutes phases)

Domaine autorisé (Host) obligatoire en ligne ; `Origin` / `Sec-Fetch-Site` vérifiés sur toute requête modifiante ; jeton CSRF
synchronisé (renvoyé par `/api/auth/session`, exigé en en-tête) ; limitation des tentatives par IP **et** par e-mail haché, stockée
en base (valable entre instances) ; expiration absolue et d'inactivité (D5) ; message d'erreur identique pour e-mail inconnu /
mauvais mot de passe / non membre (pas d'énumération) ; HSTS, CSP stricte, `X-Robots-Tag: noindex` hors production.

---

## 4. Comptes (D2, D7, D10 acceptés)

- **Deux comptes personnels distincts pour HABB** : le propriétaire (`OWNER`) et l'épouse du propriétaire (rôle choisi à la
  création). Les adresses e-mail exactes seront communiquées au moment de la création. **Aucun compte partagé entre plusieurs
  personnes.** Aucun compte n'est créé en C0.
- **Bêta HABB : comptes créés manuellement** par un script administratif côté serveur (API d'administration Supabase, jamais depuis
  une requête utilisateur) ; inscriptions publiques **désactivées** ; **aucune invitation par e-mail et aucun SMTP en v1**. Les
  invitations et les réinitialisations autonomes viendront plus tard.
- **Double authentification** : facultative pendant la bêta interne HABB ; **obligatoire pour Propriétaire et Administrateur avant
  l'ouverture à des clients externes** (C14).

## 5. Ce qui protégera Développement des ventes avant son ouverture

Growth (Développement des ventes) n'est ouvert — bêta interne HABB comprise — que lorsque **tout** ceci existe et est testé :
1. C1 à C4 : identité, sessions, rôles, accès aux modules, sécurité commune ;
2. **C6 : la production a basculé vers l'identité `merchant_id` (ADR 0003 § 12)** — la bascule Shopify **précède** l'ouverture de
   Growth (décision N2) ;
3. C5 : Growth en mode en ligne (`src/growth/server/hosting.js` ou `guard.js` commun : domaines autorisés, proxy, port), garde
   d'identité devant **toutes** les pages, fichiers statiques applicatifs et API (seuls l'écran de connexion et ses ressources sont
   publics), écran de connexion et de déconnexion FR/NL/EN, entrée `growth` dans `src/service-start.js` ;
4. un staging réellement séparé (D9, § 12) ;
5. les comptes HABB créés et testés (D2).

Pas de jeton temporaire, pas d'authentification propre à Growth.

## 6. Ce qui sera ensuite partagé avec Finances et Analyses

- **Finances (C10)** : la page de connexion par jeton est remplacée par la connexion Nordla ; `fin_sid` + `sessions.json` →
  `app_sessions` ; les événements de connexion de `audit.log` → `identity_events` (les événements métier restent dans l'audit
  Finances jusqu'à C13). Bascule par variable, retour arrière possible tant que l'ancien jeton n'est pas supprimé.
- **Analyses (C11)** : la garde HTTP Basic est remplacée par la garde d'identité + écran de connexion ; le menu compte obtient une
  vraie déconnexion.
- Chaque migration : un module à la fois, sur staging d'abord, avec une fenêtre annoncée (tout le monde est déconnecté une fois).

---

## 7. Roadmap Core (ordre accepté le 2026-09-28)

« Identité terminée » (C1 à C5) **n'est pas** « Core terminé » (C0 à C15).

| Ordre | Phase | Contenu | Critère de clôture |
|---|---|---|---|
| 1 | **C0** | Décisions, vérifications, ADR 0003 et 0004 | décisions inscrites ; état réel vérifié ; commit documentaire local |
| 2 | **C1** | Identité et sessions (`src/identity/` sessions, événements, Supabase Auth côté serveur) | connexion, déconnexion, expiration 12 h / 2 h, révocation testées ; aucun secret dans les réponses ; journal non modifiable |
| 3 | **C2** | Appartenances et rôles (`merchant_members`, matrice D3, règle « au moins un propriétaire ») | non-membre et suspendu refusés avec le même message ; verrouillage impossible |
| 4 | **C3** | Accès aux modules (`module_entitlements`) et source `session` du résolveur | membre actif × module activé × rôle ; marchand jamais pris dans la requête ; marchand ≠ service → 403 |
| 5 | **C4** | Sécurité commune (`guard.js`) | Host, Origin, CSRF, limitation IP + e-mail en base ; en-têtes identiques |
| 6 | **C6** | Bascule de la production vers `merchant_id`, retrait du fallback Shopify, préparation de M2 (ADR 0003 § 12) | aucun `SHOP_QUERY` d'identification en production ; interrupteur éteint puis code retiré |
| 7 | **C5** | Protection, staging et ouverture de Growth (§ 5) | aucune ressource sans session ; parcours navigateur réel 5 largeurs ; publication seulement avec accord |
| 8 | **C7** | Création d'entreprise (N3) et informations communes de l'entreprise (N5) | script administratif testé ; Finances lit l'entreprise depuis Core |
| 9 | **C8** | Centre des connexions et provenance (N4, provenance images/collections) | états des connecteurs exposés ; `fin_bank_connections` référence Core |
| 10 | **C9** | Page Core dans le véritable style Nordla | structure validée (§ 12, N1) ; desktop + mobile ; aucun nouveau style hors du système |
| 11 | **C10** | Migration de Finances vers l'identité Nordla | ancien jeton retiré ; retour arrière possible ; non-régression |
| 12 | **C11** | Migration d'Analyses | plus de HTTP Basic ; vraie déconnexion |
| 13 | **C12** | Vérification des coûts et qualité des données (N6) | un coût passe à « vérifié » avec preuve et historique |
| 14 | **C13** | Événements, validations et Journal des décisions (N7) | journal en ajout seul, lisible entre modules, corrélation testée |
| 15 | **C14** | RLS renforcé, SSO central, double authentification obligatoire (Propriétaire, Administrateur) | tests RLS avec le rôle `authenticated` ; SSO par code à usage unique |
| 16 | **C15** | Multi-entreprise réel (fichiers locaux → base avec `merchant_id`) | deux entreprises servies sans fuite |

- HABB peut utiliser Growth en **bêta interne** après C1 à C4, la bascule C6 et C5.
- **Aucun nouveau module métier** (Stock, Ventes, Achats & Fournisseurs, SAV, Conformité) ne commence avant la fin de C13.
- **C14 et C15 sont obligatoires avant le deuxième client réel** et avant une véritable exploitation multi-entreprise ; **M2** (ADR
  0003) est terminé avant le deuxième client externe.
- Centre de pilotage, Parle à Nordla complet, Assistants et Radar des marchés sont **hors de Core v1**.

Chaque phase : branche dédiée, tests, staging, accord du propriétaire avant tout push, migration ou déploiement.

## 8. Fichiers et migrations prévus (aucun n'est créé)

- Migrations : `..._identity_sessions_events.sql` (C1 : app_sessions, identity_events, révocations de droits),
  `..._identity_members.sql` (C2), `..._module_entitlements.sql` (C3), `..._merchants_status.sql` (D-merchants, phase à fixer).
- Code : `src/identity/{gotrue,sessions,permissions,access,guard,events,routes,config}.js` ; `src/tenant/index.js` (source `session`) ;
  `src/growth/server/{app,serve}.js` ; `src/growth/ui/` (écran de connexion FR/NL/EN) ; `src/service-start.js` ; script
  administratif de création de compte.
- Plus tard : `src/finance/server/{app,index,hosting}.js`, `src/analytics-premium/server/{app,serve,hosting}.js` + leurs UI.
- Documentation : `docs/security/identity.md` (exploitation : création de compte, révocation, MFA, secours propriétaire, matrice
  des rôles).

## 9. Variables (noms seulement)

Existantes réutilisées : `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `NORDLA_MERCHANT_ID`, `NORDLA_SERVICE`, `PORT`,
`MERCHANT_TIMEZONE`. Nouvelles : `SUPABASE_ANON_KEY` (appels Supabase Auth côté serveur uniquement), `GROWTH_HOSTED`,
`GROWTH_ALLOWED_HOSTS`, `GROWTH_TRUST_PROXY_HOPS`, `NORDLA_SESSION_ABSOLUTE_HOURS` (défaut 12) et `NORDLA_SESSION_IDLE_MINUTES`
(défaut 120). `NORDLA_IDENTITY_TOKEN_KEY` est **abandonnée** (D6 : aucun jeton Supabase conservé). Configuration Supabase Auth
(tableau de bord, pas des variables) : inscriptions publiques **désactivées** ; SMTP non nécessaire en v1 (D7).

## 10. Tests nécessaires

- Aucune page, ressource applicative ou API de Growth sans session valide (401 / redirection vers la connexion) ; domaine non
  autorisé → 403 ; démarrage refusé si la configuration en ligne est incomplète.
- Connexion : succès, mauvais mot de passe, e-mail inconnu, non membre, membre suspendu, module désactivé, marchand différent du
  service → même message côté client, événement correct côté journal.
- Limitation des tentatives (IP et e-mail), CSRF absent / faux → 403, Origin étrangère → 403, aucune route `GET` modifiante.
- Expiration absolue (12 h) et d'inactivité (2 h), révocation, « se déconnecter partout » effective dans un autre module (≤ 30 s).
- Matrice des rôles (D3) : chaque rôle × module × action ; au moins un propriétaire actif.
- Aucun `merchant_id` accepté depuis la requête (paramètre, en-tête, corps) ; aucune fuite entre deux marchands.
- Aucun secret (clé service role, clé anon, jeton Supabase) dans le HTML, le JS servi, les réponses API ou `app_sessions`.
- Journal : pas de mot de passe, jeton ou e-mail en clair ; UPDATE / DELETE refusés.
- Navigateur réel : parcours connexion / déconnexion aux 5 largeurs, FR/NL/EN, focus et accessibilité de l'écran de connexion.
- Non-régression Finances / Analyses tant qu'ils ne sont pas migrés.

## 11. Décisions acceptées (propriétaire, 2026-09-28)

| # | Décision | État |
|---|---|---|
| **D1** | Fournisseur d'identité : **Supabase Auth**, côté serveur uniquement | Accepté ; à faire (C1) |
| **D2** | Deux comptes personnels HABB distincts (propriétaire ; épouse du propriétaire) ; e-mails fournis à la création ; aucun compte partagé | Accepté ; aucun compte créé |
| **D3** | Rôles par entreprise `OWNER` (Propriétaire), `ADMIN` (Administrateur), `COLLABORATOR` (Collaborateur), `VIEWER` (Lecture seule), `ACCOUNTANT` (Comptable) ; appartenance `ACTIVE` ou `SUSPENDED` ; matrice dans le code, testée et documentée ; toujours au moins un OWNER actif, garanti en base ; aucun rôle ne contourne l'activation d'un module (ACCOUNTANT n'ouvre pas Finances automatiquement) ; comptes créés manuellement en v1 (D7) | Accepté ; construit en C2 (local, non appliqué) |
| **D4** | v1 : une identité, même e-mail / mot de passe, une session par module, aucun cookie partagé sur les domaines Railway ; SSO central `nordla.app` plus tard | Accepté ; à faire (C1, C14) |
| **D5** | 12 h maximum, 2 h d'inactivité ; cookies `Secure`, `HttpOnly`, limités à l'hôte du module ; SameSite recommandé `Lax` (§ 3.2) | Accepté ; SameSite confirmé en C1 |
| **D6** | Aucun jeton Supabase dans le navigateur ni conservé comme session ; session serveur Nordla révocable | Accepté ; à faire (C1) |
| **D7** | Bêta HABB : comptes créés manuellement ; pas d'invitation, pas de SMTP en v1 | Accepté |
| **D8** | Fonctionnement serveur conservé pour la bêta ; RLS par entreprise obligatoire avant un deuxième client réel ; politiques existantes inventoriées (aucune) et toujours versionnées | Accepté ; inventaire fait ; RLS à faire (C14) |
| **D9** | Staging réellement séparé : projet Supabase distinct, volume distinct, aucun vrai secret Shopify, données synthétiques ou anonymisées, aucune donnée personnelle HABB | Accepté ; état vérifié en § 12 |
| **D10** | Double authentification facultative en bêta interne ; obligatoire pour Propriétaire et Administrateur avant les clients externes | Accepté ; à faire (C14) |
| **D-merchants** | Ajouter à terme `status` et `updated_at` à `merchants` | Accepté ; pas de migration en C0 |

## 12. Décisions N1 à N7 (propriétaire, 2026-09-28)

### D9 — état réel du staging (vérifié le 2026-09-28)

| Exigence | État |
|---|---|
| Projet Supabase distinct | **Oui** (`fvhiammdskpcnfodsnrc` ≠ production `xbtzjabbseclmqfozjeo`) |
| Volume distinct | **Oui** pour les services qui en ont (volumes par service et par environnement Railway) |
| Aucun vrai secret Shopify de production | **Oui** : Shopify simulé ; secrets différents de la production (empreintes comparées) |
| Données synthétiques ou anonymisées | **Oui** : marchand « Nordla Staging Retail (synthetic) », 175 produits d'exemple, aucune clé client |
| Aucune vraie donnée personnelle HABB | **Oui** pour la base staging ; à re-vérifier pour Growth lors de C5 (aucun service Growth en staging aujourd'hui) |
| Réserve | staging et production sont deux *environnements* du même projet Railway `app.nordla.app` ; accepté tant que variables, bases et volumes sont séparés |

### N1 — Hébergement de la page Core

- La page d'administration Core **appartient au véritable service Core**. Pas de produit ni de module commercial `core-admin`.
- Le service Core devra assurer : les tâches de synchronisation, l'identité (API de connexion centrale plus tard), les API
  d'administration et la page Core réservée aux personnes autorisées.
- **Risque opérationnel d'un serveur HTTP et d'un planificateur dans le même service Railway :**
  - un redéploiement de la page (correctif d'interface) redémarre aussi le planificateur : une synchronisation part au démarrage
    (le planificateur lance un cycle immédiatement) ;
  - une panne mémoire ou une boucle d'erreur de la synchronisation peut faire tomber la connexion et l'administration, et
    inversement ;
  - passer le serveur web à plusieurs instances multiplierait le planificateur (synchronisations concurrentes) ;
  - `core-once` / `restartPolicy` de staging montrent déjà que le cycle de vie d'une tâche et celui d'un serveur web diffèrent.
- **Mécanisme recommandé (non implémenté)** : **un seul service Core** au sens produit et code (même dépôt, même dossier `src/core/`,
  même identité, mêmes tables), **exécuté en deux rôles** choisis par `NORDLA_SERVICE`, sur le modèle de `src/service-start.js` :
  - `core` (ou `core-sync`) : le planificateur actuel, sans port HTTP ;
  - `core-web` : serveur HTTP (identité, API d'administration, page Core), sans planificateur, extensible à plusieurs instances.
  Les deux rôles partagent la base et le code ; aucun ne dépend de l'autre pour démarrer. Un verrou en base (ligne `RUNNING` récente
  dans `sync_runs` ou verrou consultatif Postgres) empêche deux synchronisations simultanées pour un même marchand. Une action
  « Synchroniser maintenant » de la page Core **demande** une synchronisation (ligne en base lue par le rôle `core-sync`) au lieu de
  l'exécuter dans le serveur web.
- Alternative acceptable pour la seule bêta HABB : un processus unique qui sert le HTTP et lance chaque cycle dans un processus enfant
  (comme aujourd'hui), à condition d'une seule instance. Décision définitive au démarrage de C9.

### N2 — Ordre de la bascule Shopify

La production est basculée vers l'identité Nordla fondée sur `merchant_id` **avant** l'ouverture de Growth : C6 précède C5 (§ 7 ;
ADR 0003 § 12).

### N3 — Création d'une entreprise

- v1 : **script administratif sécurisé** (exécuté par un opérateur avec la clé service role, jamais exposé en HTTP public) ; **aucune
  création automatique pendant une synchronisation** (déjà vrai dans le code construit, pas encore en production) ; aucune création
  depuis une requête utilisateur ordinaire.
- Plus tard : depuis la page Core, pour les propriétaires autorisés.
- **M2** (ADR 0003 : `merchants.source_*` facultatifs) est terminé **avant le deuxième client externe** ; tant que M2 n'est pas fait,
  une entreprise sans Shopify ne peut pas être créée proprement.

### N4 — Connexion bancaire

Répartition officielle :
- **Core** possède le registre du connecteur (`merchant_connectors`, `kind = 'bank'`), son type, son état, sa configuration technique
  non secrète et sa santé ;
- **Finances** possède les comptes bancaires, transactions, soldes, rapprochements et données métier ;
- les données Finances **référencent le connecteur Core** : une seule vérité sur « la banque est-elle connectée ».

Migration possible entre `fin_bank_connections` et `merchant_connectors` (**documentée, non exécutée**) :
1. État vérifié le 2026-09-28 : `fin_bank_connections` contient **0 ligne** en production (0 transaction) ; la migration ne
   déplace donc aucune donnée réelle aujourd'hui.
2. Prérequis : `merchant_connectors` en production (M1, C6).
3. Migration additive : `alter table fin_bank_connections add column connector_id uuid references merchant_connectors(id)` ; pour
   chaque ligne existante, créer un connecteur `bank` (`external_id` = identifiant du compte chez le fournisseur quand il existe,
   sinon NULL ; `config` = fournisseur et périmètre, **jamais le jeton**), puis renseigner `connector_id`.
4. Le jeton bancaire chiffré (`token_ciphertext`) **reste côté Finances** (ou, plus tard, dans un coffre) : `merchant_connectors.config`
   refuse tout secret par construction.
5. Finances lit l'état du connecteur dans Core ; `revoked_at` / `expires_at` alimentent l'état `MISCONFIGURED` / `NOT_CONFIGURED`.
6. Plus tard seulement : `connector_id` `NOT NULL`, puis retrait des colonnes redondantes. Phase : C8.

### N5 — Informations de l'entreprise

Les informations communes de l'entreprise (nom légal, numéro d'entreprise, TVA, adresse, e-mail, téléphone, IBAN, langue et devise
par défaut, logo) **appartiennent à Core**. Aujourd'hui elles vivent dans un fichier local de Finances
(`data/local/finance/merchant.json`, `src/finance/settings.js`, sans `merchant_id`). Finances, Analyses et Growth les liront depuis
Core ; les réglages propres à Finances (numérotation, Peppol, pack comptable, boîte d'entrée) restent dans Finances. Phase : C7.

### N6 — Vérification des coûts d'achat

- **Core** possède la donnée canonique du coût (`product_costs`), son statut de vérification (`validation_status`), sa provenance,
  la preuve et l'historique.
- **Finances** fournit le premier écran permettant de vérifier un coût.
- Le futur module Achats & Fournisseurs utilisera la même capacité, sans seconde donnée.
- État vérifié : 295 coûts en production, **tous `unverified`** ; la synchronisation écrit toujours `unverified` et aucun chemin ne
  permet aujourd'hui de marquer un coût vérifié. Phase : C12.

### N7 — Événements et Journal des décisions

Un journal **en ajout uniquement** (phase C13), contenu minimal : identifiant ; `merchant_id` ; module source ; type d'événement ou
de décision ; acteur ; entité concernée ; date et heure ; action ou décision ; preuve ou données utilisées ; résultat ; identifiant
de corrélation permettant de suivre une même action entre plusieurs modules. Aucune suppression ni modification silencieuse d'une
entrée (UPDATE / DELETE refusés en base) ; une correction est une **nouvelle** entrée qui référence l'ancienne. `identity_events`
(C1) porte déjà un `correlation_id` compatible.

### Page Core et système visuel (rappel des décisions)

Structure validée : navigation verticale ; entreprise active en haut ; Applications connectées (Finances, Analyses, Développement des
ventes) ; Core comme fondation commune ; blocs Données communes, Identité et accès, Connexions, Décisions ; Connexions principales
avec l'état des connecteurs. L'image générée est une **référence structurelle uniquement** : le style vient du système Nordla
existant (composants, typographies, cartes, espacements, états, icônes, graphiques de `src/shared` et des modules) ; seule la couleur
du menu identifie le module actif ; une même fonction ou donnée garde la même icône partout. Développement : phase C9.

## 13. Risques

| Risque | Mesure |
|---|---|
| Verrouillage (plus aucun Propriétaire actif) | règle « au moins un propriétaire actif » dans le code + procédure de secours documentée (service role) |
| Comptes créés à la main mal configurés | script administratif testé, journalisé (`ACCOUNT_CREATED`), exécuté par un opérateur |
| Clé service role toujours toute-puissante | navigateur sans accès Supabase ; RLS par entreprise avant le deuxième client (C14) |
| Sessions et limites de débit en base : charge et latence | index dédiés, cache court, nettoyage périodique des sessions expirées |
| Production encore identifiée par Shopify | bascule C6 avant toute ouverture de Growth ; retour arrière par redéploiement du commit précédent |
| Deux mécanismes de connexion en parallèle trop longtemps | calendrier de migration Finances / Analyses fixé dès l'ouverture de Growth |
| Serveur web et planificateur dans le même service Core | deux rôles `NORDLA_SERVICE` + verrou de synchronisation (N1) |
| Trois projets Railway non inspectés | inspection avant tout déploiement Growth |

## Alternatives écartées

- **Jeton partagé pour Growth** (comme Analyses) : écarté (exigence propriétaire : pas de jeton temporaire faible, pas d'identité).
- **Authentification propre à Growth** : écartée (trois systèmes divergents).
- **Cookie partagé sur `up.railway.app`** : impossible (Public Suffix List).
- **Cookie de session unique `Domain=nordla.app`** : possible après sous-domaines, écarté au profit d'une connexion centrale avec
  cookies `__Host-` par module (surface d'exposition plus faible).
- **Conserver le jeton de rafraîchissement Supabase chiffré côté serveur** : écarté (D6) ; aucune utilité une fois la session Nordla
  révocable créée, et un secret de moins à protéger.
- **Invitations par e-mail dès la v1** : reportées (D7), pas de SMTP nécessaire pour la bêta.
- **Module ou produit séparé `core-admin`** : écarté (N1) ; la page appartient au service Core.
- **Fournisseur externe (Auth0, Clerk, etc.)** : écarté pour l'instant (nouveau fournisseur, coût, données personnelles hors de
  l'infrastructure existante) ; réévaluable si Supabase Auth ne suffit pas.
- **Supabase JS dans le navigateur** : écarté (jetons dans le navigateur, dépendance, contraire au modèle actuel sans SDK).
