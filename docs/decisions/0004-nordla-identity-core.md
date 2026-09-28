# ADR 0004 : l'identité Nordla appartient à Core

- **Statut :** PROPOSÉ. Architecture et plan uniquement ; rien n'est implémenté, aucune migration, aucun compte, aucune variable
  Railway, aucun service n'a été créé ou modifié.
- **Date :** 2026-09-28.
- **Branche :** `feature/core-identity` (depuis `5679382`, poussé sur `origin/feature/growth-priorities-v1`).
- **Liens :** ADR 0003 (identité du tenant, résolveur `src/tenant/`), `docs/growth/GROWTH_DEEP_AUDIT.md`, `docs/security/baseline.md`.

## Décision

L'identité des utilisateurs, leur appartenance à une entreprise (marchand), leurs rôles, leurs sessions et leurs droits d'accès aux
modules **appartiennent à Core**. Finances, Analyses et Développement des ventes restent des modules autonomes (services, domaines et
déploiements séparés), mais utilisent **la même identité Nordla** : mêmes comptes, mêmes appartenances, mêmes règles d'accès, même
magasin de sessions, même journal de sécurité, via une seule bibliothèque serveur partagée. Développement des ventes est le premier
module à l'utiliser ; la conception n'est pas propre à Growth.

---

## 1. Ce qui existe réellement aujourd'hui (vérifié le 2026-09-28)

### 1.1 Modules

| Module | Authentification actuelle | Sessions | Journal |
|---|---|---|---|
| **Core** | Aucune. Core = planificateur de synchronisation Shopify (`src/sync/scheduler.js`) ; pas de serveur HTTP, pas d'utilisateurs | — | `sync_runs` (synchro seulement) |
| **Finances** | Un jeton partagé `FINANCE_DASHBOARD_TOKEN` (≥ 24 car.) saisi sur une page de connexion ; comparaison en temps constant ; limiteur de tentatives par IP | Cookie `fin_sid` HttpOnly, SameSite=Strict, Secure en ligne, 8 h ; jeton CSRF sur toute requête modifiante ; Origin vérifiée ; sessions dans un **fichier local** (`sessions.json`, identifiants hachés SHA-256) | `audit.log` local (LOGIN, LOGIN_FAILED, actions) |
| **Analyses** | Un jeton partagé `ANALYTICS_ACCESS_TOKEN` (≥ 24 car.) envoyé **à chaque requête** en HTTP Basic ; 5 échecs → blocage 5 min par IP | Aucune (pas de session, pas de déconnexion, pas d'expiration) | Aucun journal de connexion |
| **Développement des ventes** | **Aucune.** Écoute sur 127.0.0.1 uniquement, **sans contrôle du domaine (Host)** ; absent de `src/service-start.js`, donc non déployable | — | — |

Points communs déjà présents (Finances et Analyses, fichiers `server/hosting.js`) : liste des domaines autorisés (`*_ALLOWED_HOSTS`),
IP client prise dans `X-Forwarded-For` compté depuis la droite (proxy de confiance), HSTS, en-têtes stricts (CSP sans script inline,
`nosniff`, `no-referrer`, `frame-ancestors 'none'`).

Aucune notion de **personne** : on ne sait pas *qui* s'est connecté, seulement que *quelqu'un* connaissait le jeton.

### 1.2 Tenant

- Résolveur unique `src/tenant/index.js` (ADR 0003). Source utilisée : `NORDLA_MERCHANT_ID` (un service = un marchand). La source
  **`session` est réservée mais non implémentée**. Aucune requête ne peut choisir le marchand (vérifié et testé).
- Table `merchants (id, name, vertical, created_at)` ; table `merchant_connectors` (ADR 0003).

### 1.3 Base de données

- Supabase ; les serveurs utilisent la clé **service role** (jamais envoyée au navigateur). Client maison sans SDK (`fetch`).
- **27 tables avec RLS activé et 0 politique** : tout accès avec la clé `anon` ou un jeton utilisateur est refusé ; seule la clé
  service role lit/écrit. L'isolation entre marchands repose sur les filtres `merchant_id` du code (testés).
- **Supabase Auth n'est pas utilisé** : aucune table d'utilisateurs Nordla, aucune appartenance, aucun rôle.

### 1.4 Domaines et Railway (lecture seule)

| Environnement Railway | Service | Domaine |
|---|---|---|
| production | Finance | `finance-production-8f71.up.railway.app` |
| production | Analytics | `analytics-production-2c30.up.railway.app` |
| production | nordla | `nordla-production.up.railway.app` (en veille) |
| production | Core | aucun domaine (tâche de fond) |
| staging | finance-staging, analytics-staging, shopify-stub-staging | `*-staging-staging.up.railway.app` ; core-staging sans domaine |

- Aucun domaine personnalisé n'est configuré.
- **`up.railway.app` figure dans la Public Suffix List** (entrée soumise par Railway). Conséquence technique vérifiée : chaque
  service est un « site » distinct pour le navigateur ; un cookie `Domain=up.railway.app` est **refusé** ; aucun cookie ne peut être
  partagé entre Finances, Analyses et Growth sur ces domaines, et les appels entre eux sont *cross-site* (SameSite).
- `nordla.app` est enregistré (DNS chez Porkbun, page de parking) ; `app.nordla.app` et `www.nordla.app` pointent vers ce parking.
  Il n'est relié à aucun service. `.app` impose HTTPS (HSTS préchargé).
- Trois autres projets Railway existent (`caring-luck`, `ideal-renewal`, `illustrious-grace`) et n'ont pas été inspectés.

---

## 2. Ce qui sera construit dans Core

### 2.1 Fournisseur d'identité : Supabase Auth

Retenu (sous réserve de ton accord, décision D1), parce que :
- il est déjà dans l'infrastructure (même projet Supabase que les données) : pas de nouveau fournisseur, pas de mot de passe stocké
  par Nordla ;
- il offre ce qu'exige ce chantier : comptes personnels e-mail + mot de passe, lien magique, réinitialisation, **double
  authentification TOTP** (niveaux `aal1` / `aal2`, activable plus tard sans l'imposer), sessions et jetons de rafraîchissement
  révocables (`logout` avec portée `local` / `global`), limites de débit intégrées, journal `auth.audit_log_entries` ;
- il s'utilise en **REST** (`/auth/v1/...`) avec le même client `fetch` que le reste du code : aucune dépendance, aucun SDK dans le
  navigateur.

Limites à connaître : l'envoi d'e-mails (invitation, réinitialisation) exige un SMTP configuré (le SMTP par défaut de Supabase est
limité à quelques e-mails par heure) ; la session Supabase n'est pas la session de l'application (voir 2.4).

**Le navigateur ne parle jamais à Supabase.** Modèle « backend for frontend » : le navigateur parle à son module ; le serveur du
module parle à Supabase. Donc ni clé `service_role`, ni clé `anon`, ni jeton Supabase dans le navigateur.

### 2.2 Modèle de données proposé (esquisse, **pas une migration**)

```
auth.users                      géré par Supabase Auth (e-mail, mot de passe haché, facteurs MFA). Nordla n'y écrit jamais directement.

merchants (existant)            id, name, vertical, created_at  + (proposé) updated_at, status ('active' | 'suspended')

merchant_members                qui appartient à quelle entreprise, avec quel rôle
  id            uuid pk
  merchant_id   uuid not null  -> merchants(id) on delete restrict
  user_id       uuid not null  -> auth.users(id) on delete cascade
  role          text not null  check (role in ('owner','admin','editor','viewer','accountant'))   -- D3
  status        text not null  check (status in ('active','suspended'))
  created_at, updated_at, created_by (uuid null), suspended_at, suspended_reason
  unique (merchant_id, user_id)                -- plusieurs utilisateurs par entreprise, plusieurs entreprises par utilisateur
  -- au moins un 'owner' actif par marchand : vérifié par le code (et un test), pas par une contrainte différée

merchant_invitations            invitation avant la création / l'acceptation du compte
  id, merchant_id -> merchants, email (citext), role, token_hash (sha256, le jeton brut n'est jamais stocké),
  status check (status in ('pending','accepted','revoked','expired')), expires_at, invited_by -> auth.users,
  accepted_by -> auth.users null, created_at, updated_at
  unique (merchant_id, email) where status = 'pending'

module_entitlements             modules activés par entreprise
  merchant_id -> merchants, module text check (module in ('finance','analytics','growth')),   -- liste fermée, extensible par migration
  status check (status in ('enabled','disabled')), enabled_at, disabled_at, updated_by, created_at, updated_at
  primary key (merchant_id, module)

app_sessions                    sessions de l'application (une par connexion à un module)
  id uuid pk, token_hash text unique (sha256 du cookie), user_id -> auth.users, merchant_id -> merchants,
  module text (module où la session a été ouverte), aal text ('aal1'|'aal2'),
  created_at, last_seen_at, expires_at (absolue), idle_expires_at, revoked_at null, revoked_reason null,
  ip_hash, user_agent (tronqué)
  -- index (user_id) where revoked_at is null  -> « se déconnecter partout »

identity_events                 journal de sécurité, en ajout seul
  id bigint identity, at timestamptz, event text (LOGIN_SUCCEEDED, LOGIN_FAILED, LOGOUT, LOGOUT_ALL, SESSION_EXPIRED,
  SESSION_REVOKED, ACCESS_DENIED, MEMBER_INVITED, MEMBER_JOINED, ROLE_CHANGED, MEMBER_SUSPENDED, MODULE_ENABLED, MODULE_DISABLED,
  MFA_ENROLLED, MFA_CHALLENGE_FAILED, RATE_LIMITED), user_id null, merchant_id null, module null, ip_hash, detail jsonb
  -- jamais de mot de passe, jeton, cookie ou e-mail en clair dans detail ; pas de UPDATE / DELETE accordés
```

Raisons :
- `merchant_members` sépare **qui** (Supabase) de **où et avec quel rôle** (Nordla) ; l'unicité `(merchant_id, user_id)` permet
  plusieurs personnes par entreprise et une personne dans plusieurs entreprises, sans rien changer plus tard.
- `module_entitlements` au niveau entreprise : l'accès à un module = membre actif **et** module activé **et** rôle autorisé.
- `app_sessions` en base (et non en fichier local comme Finances) : survit aux redéploiements, partagée entre instances, et permet la
  **révocation depuis n'importe quel module** (déconnexion commune sans cookie commun, voir § 3).
- Rôles et permissions **dans le code** en v1 (matrice versionnée et testée) ; une table de permissions fines n'est ajoutée que si le
  besoin apparaît (décision D3).

### 2.3 RLS proposé

- **Toutes** les nouvelles tables : RLS activé.
- **v1 : aucune politique** (même règle que les 27 tables existantes) : seuls les serveurs, avec la clé service role, y accèdent ; le
  navigateur n'a aucun chemin vers Supabase. C'est le modèle le plus sûr tant que le navigateur ne lit pas la base directement.
- `identity_events` : en plus, révoquer UPDATE / DELETE au rôle applicatif utilisé (journal non modifiable).
- **Phase 10 (RLS renforcé)** : exécuter les lectures métier avec le JWT de l'utilisateur (rôle `authenticated`) plutôt qu'avec la
  service role, et ajouter sur les tables métier des politiques du type
  `using (exists (select 1 from merchant_members m where m.merchant_id = <table>.merchant_id and m.user_id = auth.uid() and m.status = 'active'))`.
  Cela ajoute une barrière au niveau de la base en plus des filtres du code. Décision D8.

### 2.4 Bibliothèque serveur partagée `src/identity/`

Un seul code, utilisé par chaque module (aucun module n'écrit sa propre authentification) :

| Fichier | Rôle |
|---|---|
| `gotrue.js` | appels REST Supabase Auth : connexion mot de passe, déconnexion (`local`/`global`), utilisateur, facteurs MFA (plus tard) |
| `sessions.js` | création (32 octets aléatoires, stockés hachés), lecture, expiration absolue et d'inactivité, révocation, « partout » |
| `access.js` | décision d'accès : membre actif × module activé × permission du rôle ; cache court (≤ 60 s) |
| `guard.js` | domaine autorisé (Host), Origin / Sec-Fetch-Site, CSRF (jeton synchronisé), limitation des tentatives, en-têtes de sécurité |
| `events.js` | écriture `identity_events` (sans secret) |
| `routes.js` | `POST /api/auth/login`, `POST /api/auth/logout` (option « partout »), `GET /api/auth/session` |
| `config.js` | configuration par service (domaines autorisés, proxy de confiance, durées), refus de démarrer si incomplète en ligne |

Jetons Supabase : après vérification du mot de passe, le serveur garde le jeton de rafraîchissement Supabase **chiffré** dans
`app_sessions` pour pouvoir révoquer la session Supabase et, plus tard, gérer le défi MFA ; il ne quitte jamais le serveur
(décision D6 : garder chiffré, ou fermer immédiatement la session Supabase et ne rien conserver).

### 2.5 Résolution du tenant

- La source `session` du résolveur est implémentée : le marchand vient de la **session serveur**, jamais d'un paramètre, d'un
  en-tête ou d'un corps de requête.
- Tant que « un service = un marchand » (ADR 0003 § 11) : la session doit porter **exactement** le `NORDLA_MERCHANT_ID` du service,
  sinon 403 (`ACCESS_DENIED`), même si l'utilisateur est membre d'un autre marchand.
- Plus tard (multi-marchands) : choix du marchand après connexion parmi les appartenances actives, mémorisé côté serveur ; tout
  changement repasse par une vérification d'appartenance.

---

## 3. Domaines, cookies et sessions entre services (point critique)

**Identité commune ≠ cookie commun.** L'identité commune = mêmes comptes, appartenances, droits, table de sessions et journal.
Un cookie commun = un même cookie envoyé à plusieurs services ; c'est **impossible** sur les domaines actuels (§ 1.4) et **non
nécessaire** pour une identité commune.

### 3.1 Phase 1 (domaines actuels, origines séparées)

- Chaque module pose **son propre cookie** de session, limité à son hôte : `__Host-nordla_sid` (Secure, HttpOnly, Path=/, sans
  Domain, SameSite=Lax ou Strict — décision D5), valeur aléatoire opaque, rien d'autre.
- **Connexion :** la personne se connecte sur le module qu'elle ouvre, avec **le même e-mail et le même mot de passe** partout (même
  écran, même bibliothèque). Pas de SSO automatique en phase 1 : ouvrir un deuxième module redemande la connexion.
- **Déconnexion :** « Se déconnecter » ferme la session de ce module ; « Se déconnecter partout » révoque **toutes** les sessions de
  la personne dans `app_sessions` (et sa session Supabase en portée `global`). Chaque module vérifie la révocation à chaque requête
  (lecture en base, cache ≤ 30 s) : la déconnexion commune fonctionne **sans cookie commun**.
- **Pas trois systèmes divergents :** une bibliothèque, une table de sessions, un journal. Les mécanismes actuels (jeton Finances,
  jeton Basic Analyses) sont retirés lors de la migration de chaque module (§ 5).

### 3.2 Plus tard : session commune (étape 10)

Deux options, décision D4 :

1. **Sous-domaines Nordla** (`finances.nordla.app`, `analyses.nordla.app`, `ventes.nordla.app`, `compte.nordla.app`) : les modules
   deviennent *same-site* ; SameSite n'empêche plus la navigation entre eux. Un cookie `Domain=nordla.app` deviendrait techniquement
   possible, mais **n'est pas recommandé** comme session (exposé à tous les sous-domaines, incompatible avec le préfixe `__Host-`).
2. **Connexion centrale sans cookie partagé (recommandé)** : un point de connexion unique (`compte.nordla.app`, servi par Core) ; un
   module sans session redirige vers lui ; après connexion, il renvoie vers le module (adresse de retour sur liste blanche) avec un
   **code à usage unique** (≤ 60 s, lié au module) que le serveur du module échange, de serveur à serveur, contre sa propre session
   `__Host-`. Même expérience qu'un SSO, chaque module garde un cookie limité à son hôte, la révocation reste centrale. Fonctionne
   même sur des domaines séparés, mieux avec des sous-domaines.

Prérequis de l'option 2 (actions à valider, décision D4) : DNS `nordla.app` chez Porkbun, domaines personnalisés Railway, un service
d'identité Core exposé en HTTP (aujourd'hui Core n'a pas de serveur web).

### 3.3 Protections communes (toutes phases)

Domaine autorisé (Host) obligatoire en ligne ; `Origin` / `Sec-Fetch-Site` vérifiés sur toute requête modifiante ; jeton CSRF
synchronisé (renvoyé par `/api/auth/session`, exigé en en-tête) ; limitation des tentatives par IP **et** par e-mail haché, stockée
en base (valable entre instances) ; expiration absolue et d'inactivité (décision D5) ; message d'erreur identique pour e-mail
inconnu / mauvais mot de passe / non membre (pas d'énumération) ; HSTS, CSP stricte, `X-Robots-Tag: noindex` hors production.

---

## 4. Ce qui protégera Développement des ventes avant sa mise en ligne

Growth ne sera publié que quand **tout** ceci existe et est testé :
1. tables `merchant_members`, `module_entitlements`, `app_sessions`, `identity_events` (+ invitations si D7) ;
2. bibliothèque `src/identity/` ;
3. Growth : mode en ligne (`src/growth/server/hosting.js` : domaines autorisés, proxy, port), garde d'identité devant **toutes** les
   pages, fichiers statiques applicatifs et API (seuls l'écran de connexion et ses ressources sont publics), écran de connexion et
   de déconnexion FR/NL/EN, entrée `growth` dans `src/service-start.js` ;
4. staging réellement isolé (décision D9) ;
5. compte HABB créé et testé (décision D2).

Pas de jeton temporaire, pas d'authentification propre à Growth.

## 5. Ce qui sera ensuite partagé avec Finances et Analyses

- **Finances** : la page de connexion par jeton est remplacée par la connexion Nordla ; `fin_sid` + `sessions.json` → `app_sessions` ;
  les événements de connexion de `audit.log` → `identity_events` (les événements métier restent dans l'audit Finances). Le modèle
  cookie + CSRF est déjà proche : changement limité à la couche de connexion. Bascule par variable, retour arrière possible tant que
  l'ancien jeton n'est pas supprimé.
- **Analyses** : la garde HTTP Basic est remplacée par la garde d'identité + écran de connexion ; le menu compte (qui dit aujourd'hui
  « aucune session ») obtient une vraie déconnexion.
- Chaque migration : un module à la fois, sur staging d'abord, avec une fenêtre annoncée (tout le monde est déconnecté une fois).

---

## 6. Séquence d'intégration

1. Identité Core (Supabase Auth configuré, bibliothèque `src/identity/`, tables sessions + journal).
2. Appartenance utilisateur–marchand (`merchant_members`, invitations si retenues).
3. Rôles, permissions et modules activés (`module_entitlements`, matrice des rôles).
4. Protection de Développement des ventes (garde, écran de connexion, mode en ligne).
5. Déploiement de Growth sur un staging réellement isolé.
6. Tests avec le compte HABB.
7. Mise en ligne de Développement des ventes.
8. Migration de Finances.
9. Migration d'Analyses.
10. Session commune (connexion centrale) et RLS renforcé.

Chaque étape : branche dédiée, tests, staging, ton accord avant tout push / migration / déploiement.

## 7. Fichiers et migrations prévus (aucun n'est créé)

- Migrations : `..._identity_members_entitlements.sql` (merchant_members, module_entitlements, invitations), `..._identity_sessions_events.sql`
  (app_sessions, identity_events, révocations de droits), `..._merchants_status.sql` (si D-merchants retenue).
- Code : `src/identity/{gotrue,sessions,access,guard,events,routes,config}.js` ; `src/tenant/index.js` (source `session`) ;
  `src/growth/server/{hosting,app,serve}.js` ; `src/growth/ui/` (écran de connexion, textes FR/NL/EN) ; `src/service-start.js`.
- Plus tard : `src/finance/server/{app,index,hosting}.js`, `src/analytics-premium/server/{app,serve,hosting}.js` + leurs UI.
- Documentation : ce ADR (passé à « Accepté »), `docs/security/identity.md` (exploitation : création de compte, révocation, MFA).

## 8. Variables (noms seulement)

Existantes réutilisées : `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `NORDLA_MERCHANT_ID`, `NORDLA_SERVICE`, `PORT`,
`MERCHANT_TIMEZONE`. Nouvelles : `SUPABASE_ANON_KEY` (appels Supabase Auth côté serveur uniquement), `NORDLA_IDENTITY_TOKEN_KEY`
(chiffrement des jetons Supabase conservés, si D6), `GROWTH_HOSTED`, `GROWTH_ALLOWED_HOSTS`, `GROWTH_TRUST_PROXY_HOPS`,
`NORDLA_SESSION_ABSOLUTE_HOURS` et `NORDLA_SESSION_IDLE_MINUTES` (valeurs par défaut dans le code). Configuration Supabase Auth
(tableau de bord, pas des variables) : SMTP, URL du site, URL de redirection, inscriptions publiques **désactivées**.

## 9. Tests nécessaires

- Aucune page, ressource applicative ou API de Growth sans session valide (401 / redirection vers la connexion) ; domaine non
  autorisé → 403 ; démarrage refusé si la configuration en ligne est incomplète.
- Connexion : succès, mauvais mot de passe, e-mail inconnu, non membre, membre suspendu, module désactivé, marchand différent du
  service → même message côté client, événement correct côté journal.
- Limitation des tentatives (IP et e-mail), CSRF absent / faux → 403, Origin étrangère → 403.
- Expiration absolue et d'inactivité, révocation, « se déconnecter partout » effective dans un autre module (≤ 30 s).
- Aucun `merchant_id` accepté depuis la requête (paramètre, en-tête, corps) ; aucune fuite entre deux marchands.
- Aucun secret (clé service role, clé anon, jeton Supabase) dans le HTML, le JS servi ou les réponses API.
- Journal : pas de mot de passe, jeton ou e-mail en clair ; UPDATE / DELETE refusés.
- Navigateur réel : parcours connexion / déconnexion aux 5 largeurs, FR/NL/EN, focus et accessibilité de l'écran de connexion.
- Non-régression Finances / Analyses tant qu'ils ne sont pas migrés.

## 10. Risques

| Risque | Mesure |
|---|---|
| Verrouillage (plus aucun `owner` actif) | règle « au moins un owner actif » dans le code + procédure de secours documentée (service role) |
| E-mails d'invitation / réinitialisation non délivrés | SMTP configuré avant l'étape 2 (D7) |
| Clé service role toujours toute-puissante | navigateur sans accès Supabase ; RLS renforcé en phase 10 |
| Sessions et limites de débit en base : charge et latence | index dédiés, cache court, nettoyage périodique des sessions expirées |
| Staging qui lit de vraies données HABB | décision D9 (staging isolé ou données réelles assumées) |
| Deux mécanismes en parallèle trop longtemps | calendrier de migration Finances / Analyses fixé dès la mise en ligne de Growth |
| Changement de domaine (sous-domaines) | prévu à l'étape 10 seulement, cookies `__Host-` inchangés |
| Trois projets Railway non inspectés | inspection avant tout déploiement Growth |

## 11. Décisions qui nécessitent ton accord

- **D1** Supabase Auth comme fournisseur d'identité (même projet Supabase que les données, ou projet séparé pour l'identité).
- **D2** Le compte HABB : quelle adresse e-mail, qui est `owner`, création par toi ou par invitation.
- **D3** La liste des rôles et la matrice de permissions (proposition : propriétaire, administrateur, éditeur, lecture seule,
  comptable) ; permissions dans le code en v1.
- **D4** Session commune : connexion centrale Core (recommandé) et sous-domaines `nordla.app` ; utilisation du domaine, DNS Porkbun,
  domaines personnalisés Railway, service d'identité Core exposé en HTTP.
- **D5** Durées de session (proposition : 12 h absolues, 60 min d'inactivité ; Finances utilise 8 h aujourd'hui) et SameSite
  (Strict comme Finances, ou Lax).
- **D6** Jetons Supabase : conservés chiffrés côté serveur (MFA, révocation) ou fermés immédiatement après la connexion.
- **D7** Invitations par e-mail dès la v1 (nécessite SMTP) ou comptes créés manuellement au début.
- **D8** RLS renforcé (lectures avec le JWT utilisateur) : à quel moment.
- **D9** Staging « réellement isolé » : nouveau projet / environnement Railway et projet Supabase séparé, ou staging actuel ; et
  s'il peut contenir de vraies données HABB.
- **D10** Double authentification : proposée (activable) dès la v1, obligatoire pour `owner` plus tard ?
- **D-merchants** Ajouter `status` / `updated_at` à `merchants`.

## Alternatives écartées

- **Jeton partagé pour Growth** (comme Analyses) : écarté (exigence propriétaire : pas de jeton temporaire faible, pas d'identité).
- **Authentification propre à Growth** : écartée (trois systèmes divergents).
- **Cookie partagé sur `up.railway.app`** : impossible (Public Suffix List).
- **Cookie de session unique `Domain=nordla.app`** : possible après sous-domaines, écarté au profit d'une connexion centrale avec
  cookies `__Host-` par module (surface d'exposition plus faible).
- **Fournisseur externe (Auth0, Clerk, etc.)** : écarté pour l'instant (nouveau fournisseur, coût, données personnelles hors de
  l'infrastructure existante) ; réévaluable si Supabase Auth ne suffit pas.
- **Supabase JS dans le navigateur** : écarté (jetons dans le navigateur, dépendance, contraire au modèle actuel sans SDK).
