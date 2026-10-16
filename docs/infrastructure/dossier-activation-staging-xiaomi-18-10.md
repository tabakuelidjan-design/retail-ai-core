# Dossier d'activation — `sourcing-staging` (Railway) pour le test Xiaomi du 18 octobre 2026

Rédigé le 2026-10-16, **lecture seule** : rien n'a été activé, aucun appel Railway / Supabase / GitHub, aucun DNS, aucune migration, aucune
valeur secrète écrite. Tout ce qui suit vient de fichiers du dépôt (worktree `retail-ai-core-convergence-wt`, branche
`integration/nordla-convergence-v1` @ `06d096c`, locale, non poussée) ou de commits git locaux. Les états Railway sont ceux **rapportés par
la session Railway (ChatGPT) dans les documents**, jamais relus par moi : ils sont marqués « NON vérifié ».

Notation des sources : `fichier:ligne`. `P` = propriétaire, `R` = session Railway (ChatGPT, connecteur), `I` = session Infrastructure (GitHub,
Supabase staging en lecture). Les documents `controles-apres-activation.md` et `guide-proprietaire-avant-activation.md` n'existent que sur
`origin/claude/nordla-core-p0` (commit `b843bca`, absents de ce worktree) : lus par `git show`.

---

## 1. Configuration du service

| Élément | Valeur | Source |
|---|---|---|
| Projet / environnement / service | projet `app.nordla.app` (`261a1971-…`), environnement `staging` (`6b648e6b-…`), service `sourcing-staging` (`24cc9cd0-e868-4210-90ce-23487ff2e65c`) ; **pas de second service** | `docs/infrastructure/sourcing-railway-go-live.md:10` ; `railway-handoff-9e25f1d.md:4` |
| Dépôt / branche | `tabakuelidjan-design/retail-ai-core`, branche `claude/nordla-core-p0` | `ops/railway-staging/staged-corrections.json` (source) |
| Commit épinglé **à déployer** | `ab02b7791b7dd91fbc7c10e7029bef5983a0c02a` (SHA complet, jamais « dernière version »). Remplace `c2c314d` dans le lot en attente | `railway-staging-go-nogo.md:9` ; `railway-changeset-audit.md:84-92` (§5 conditions 2) |
| Constructeur | Dockerfile `deploy/sourcing/Dockerfile` (base `node:24-slim`, `npm ci --omit=dev`, copie `src config resources vendor schemas tools/sourcing-backup.mjs`) | `deploy/sourcing/Dockerfile:7-21` |
| Commande de démarrage | `/app/docker-entrypoint.sh node src/service-start.js` | `railway-changeset-audit.md:49-52` (§3 A) ; `deploy/sourcing/Dockerfile:24-28` |
| Entrypoint | démarre en root uniquement pour donner `/app/data`, `SOURCING_DATA_DIR`, `SOURCING_BACKUP_DIR` à `node`, puis `setpriv` (uid 1000, sans capacité, `no_new_privs`) ; refuse tout dossier hors `/app/data` | `deploy/sourcing/docker-entrypoint.sh:8-13` (lignes 36-41 de la lecture concaténée) |
| Choix du programme | `NORDLA_SERVICE` **obligatoire** (`sourcing` → `src/sourcing/server/index.js`) ; absent ou inconnu → `exit 1`, rien ne démarre | `src/service-start.js:16-22, 33-39` |
| Healthcheck | `GET /healthz` → `200 {"ok":true}`, répond **avant** le contrôle d'hôte et sans donnée (la sonde Railway arrive avec l'hôte `healthcheck.railway.app`) | `src/sourcing/server/app.js:145-147` |
| Réplique | 1 (Railway interdit les répliques avec volume) ; mise en veille désactivée | `railway-staging-go-nogo.md:20` (A4) ; `sourcing-railway-go-live.md:10` |
| Volume | `sourcing-staging-data` (`d2c0c874-…`), 1 Go, région Amsterdam, monté sur `/app/data` | `sourcing-railway-go-live.md:10` |
| Port | écoute `0.0.0.0:8787` ; `SOURCING_PORT` l'emporte sur `PORT` ; **port cible 8787** pour le domaine Railway | `src/sourcing/server/index.js:92` ; `procedure-activation-staging.md:21` |
| Politique de redémarrage | `ON_FAILURE`, 10 essais max (`railway.json`) | `railway.json:3-7` |
| Limites CPU / mémoire | **non réglables** sur un service avec volume (correction du 16/10, source : communauté Railway) | `railway-handoff-9e25f1d.md:150-151` |

**Écart à surveiller (NON vérifié)** : `railway.json` (racine du dépôt) et `railpack.json` fixent `startCommand = node src/service-start.js`
**sans** l'entrypoint. Si Railway applique ce fichier à la place de la commande saisie dans le service, le service tourne **en root** (il le dit au
démarrage : `uid 0 (ROOT …)`, `src/sourcing/server/index.js:113`). Le document `sourcing-railway-go-live.md:118-120` conclut que la commande fixée dans
le service est « correcte que Railway garde l'ENTRYPOINT ou non » ; la priorité réelle entre `railway.json` et le réglage du service n'est pas
documentée dans le dépôt. Le contrôle est la ligne `Process: Node 24…, uid 1000` (étape 7 ci-dessous) : `uid 0` = NO-GO.

## 2. État de déploiement connu — et ce qui n'est PAS vérifié

| Fait | Statut | Source / preuve |
|---|---|---|
| Service `sourcing-staging` et volume : en attente (`staged-create`), **rien n'est provisionné ni déployé** | rapporté par R le 16/10 ; **NON vérifié par moi** | `railway-changeset-audit.md:1-5` ; `bilan-2026-10-16.md:3` |
| Lot en attente : 29 lignes (premier audit) → 32 (procédure) → 33 (guide) ; **+ 5 secrets = 38** ; toutes sur `sourcing-staging` et son volume | chiffres qui dérivent d'un document à l'autre ; **à recompter par R juste avant le Deploy** | `railway-changeset-audit.md:176` ; `procedure-activation-staging.md:7` ; `guide-proprietaire-avant-activation.md:41-42` (origin) |
| Les corrections (commit `ab02b77`, `NORDLA_MERCHANT_ID` → staging, variables manquantes) sont « mises en attente, pas déployées » | rapporté | `railway-changeset-audit.md:97-101` (§5) |
| « Generate Domain » échoue tant que le service est en `staged-create` (`ServiceInstance not found`) | constaté par R le 16/10 | `procedure-activation-staging.md:15-16` |
| Supabase **staging** `fvhiammdskpcnfodsnrc` : migrations d'identité 1–5 appliquées (28 au total), marchand de test `67646dbb-5e2e-4cd7-aad6-0ab289b068cb`, 1 adhésion OWNER ACTIVE, module `sourcing` ACTIVE, bucket privé `nordla-backups` (0 objet) | fait et relu (runs `staging-db-ops` 38813124178 et 38815730509) ; **non relu par moi aujourd'hui** | `bilan-2026-10-16.md:10-11` |
| Compte de connexion : le seul compte Auth staging, créé par P | rapporté | `protocole-test-xiaomi.md:47` |
| CI verte sur `ab02b77` : core-reliability 38864695248, intégration Node 20/24 38864695260, china-sourcing 38864695251 | rapporté (non relancé ici) | `railway-staging-go-nogo.md:9` |
| Image construite en local depuis la branche, configuration staging prévue, secrets factices : démarrage ≈ 10 s, uid 1000, `/healthz` 200, 401 / 403 / 421 attendus, aucun secret journalisé | fait localement le 15/10 (code identique à `62ec977`) | `railway-handoff-9e25f1d.md:103-108` |
| Garde de projet Supabase (`NORDLA_SUPABASE_PROJECT_REF` obligatoire sur Railway, vérification en direct) | vérifié dans le code | `src/sourcing/server/hosted.js:29-46, 75-92` |
| **Secrets saisis dans Railway / GitHub** | **NON fait** (P seul) | `guide-proprietaire-avant-activation.md:16-36` (origin) |
| **DNS `app.nordla.app`** | **aucun enregistrement créé** ; état actuel du DNS illisible depuis la session (réseau bloqué) | `domaine-app-nordla-app.md:1-3` ; `sourcing-railway-go-live.md:15` |
| Sauvegarde hors serveur réelle (B2) et restauration indépendante (B3) | **impossibles avant activation** ; staging non « opérationnel » sans elles | `railway-staging-go-nogo.md:44-53` |
| Redirection `http://` → `https://` faite par Railway | **non confirmé** par la documentation officielle (source : communauté) | `bilan-2026-10-16.md:55-57` |
| Dernier run `staging-db` : un mot de passe refusé par le pooler est mentionné dans le tableau de convergence, puis « corrigé ensuite » | contradiction apparente avec `bilan` (runs verts) ; **non éclaircie ici** | `CONVERGENCE-2026-10-16.md:16` vs `bilan-2026-10-16.md:10-11` |
| Aucun service Finance / Analytics / Core existant touché | affirmé (aucun fichier de ces services modifié) ; **à constater côté Railway** (C6) | `railway-handoff-9e25f1d.md:99` |

## 3. Coût estimé et source

- Estimation : **≈ 2–4 USD/mois** (RAM 0,1–0,2 Go ≈ 1–2 $ ; CPU < 0,02 vCPU ≈ < 0,5 $ ; volume 1 Go = 0,15 $ ; sortie réseau < 0,5 $).
  Tarifs utilisés : RAM 10 $/Go/mois, CPU 20 $/vCPU/mois, volume 0,15 $/Go/mois, « vérifiés le 15/10 » par la session Railway.
  Mesure locale : 48 Mo de RAM au repos, CPU ≈ 0 %. Source : `railway-handoff-9e25f1d.md:118-129`.
- Fixe : aucun abonnement ajouté (plan Hobby supposé : 5 $/mois incluant 5 $ d'usage tous services confondus). Ce service ne coûte réellement
  que si l'usage total de l'espace dépasse l'inclus. Source : `railway-handoff-9e25f1d.md:146-149`.
- Décision du P (16/10) : budget cible 2–4 USD/mois. Source : `railway-staging-go-nogo.md:3-4`.
- **NON vérifié** : le plan réel du compte, l'usage actuel de l'espace, l'exactitude des tarifs (non relus sur railway.com par moi). L'estimation est
  à confirmer après une semaine dans l'onglet *Usage*.
- Garde-fou : alerte e-mail à 8 USD (*Workspace → Usage → Usage Limits*). Limite stricte (minimum 10 USD) **seulement** si l'usage actuel laisse de la
  marge : elle met **tous** les services de l'espace hors ligne et n'est pas un plafond absolu. Source : `procedure-activation-staging.md:11-13`.
- Coûts hors Railway : Supabase staging (quota Storage gratuit 1 Go : se remplira avec les archives, 3 copies locales + historique dans le bucket,
  `sourcing-railway-go-live.md:128-130`) ; Backblaze B2 prévu à 0 $ (10 Go gratuits) mais **non créé** (`railway-staging-go-nogo.md:62`).

## 4. Variables — liste complète

### 4.1 Non secrètes (valeurs exactes, à avoir dans le lot)

Source de la liste : `ops/railway-staging/staged-corrections.json` + `railway-staging-go-nogo.md:43-47` (D) + `sourcing-railway-go-live.md:62-64`.

| Variable | Valeur | Rôle / source du comportement |
|---|---|---|
| `NORDLA_SERVICE` | `sourcing` | choisit le programme (`src/service-start.js:16-22`) |
| `SOURCING_HOSTED` | `1` | mode hébergé : connexion par l'identité Core, jeton de développement interdit (`hosted.js:50`) |
| `NODE_ENV` | `production` | |
| `NORDLA_SUPABASE_PROJECT_REF` | `fvhiammdskpcnfodsnrc` | **obligatoire sur Railway** ; `SUPABASE_URL` doit être exactement `https://<ref>.supabase.co` ; clé JWT d'un autre projet refusée (`hosted.js:29-46`) |
| `SUPABASE_URL` | `https://fvhiammdskpcnfodsnrc.supabase.co` | projet **staging** (jamais `xbtzjabbseclmqfozjeo` = production) |
| `NORDLA_MERCHANT_ID` | `67646dbb-5e2e-4cd7-aad6-0ab289b068cb` | marchand de test staging ; **change** la valeur d'origine du patch (id de production `36b1a1a7-…`, à ne plus jamais voir dans le lot) (`railway-handoff-9e25f1d.md:136-142`) |
| `SOURCING_MERCHANT_ID` | `habb` | profil Sourcing (règles, polices) ; ou `SOURCING_MERCHANT_PROFILE` (`hosted.js:63`) |
| `MERCHANT_TIMEZONE` | `Europe/Brussels` | |
| `SOURCING_PUBLIC_ORIGIN` | `https://app.nordla.app` (choix du P) — ou, plan B sans DNS, `https://<adresse générée>.up.railway.app` | **une seule** origine https exacte, sans port ni chemin ; son hôte est le seul accepté (`hosted.js:56-59`) |
| `SOURCING_DATA_DIR` | `/app/data/sourcing` | **doit être sous le volume** ; sinon `Nordla Core OFF (JOURNAL_NOT_ON_A_VOLUME)` (`src/core-pilot/deployment-guard.js:5,18`) |
| `SOURCING_BACKUP_DIR` | `/app/data/sourcing-backups` | hors de `SOURCING_DATA_DIR` (pas d'auto-inclusion) mais sur le même volume |
| `SOURCING_BACKUP_KEEP` | `3` | copies locales gardées |
| `SOURCING_BACKUP_BUCKET` | `nordla-backups` | bucket privé Supabase **staging** ; sans lui (ou sans passphrase) : `Backups: NOT scheduled` (`index.js:127`) |
| `SOURCING_HOST` | `0.0.0.0` | |
| `PORT` / `SOURCING_PORT` | `8787` / `8787` | |

Fournies par Railway (ne pas les poser) : `RAILWAY_SERVICE_ID`, `RAILWAY_ENVIRONMENT_ID`, `RAILWAY_PROJECT_ID`, `RAILWAY_VOLUME_MOUNT_PATH`
(détection « sur Railway » : `hosted.js:22` ; garde du volume : `deployment-guard.js:18`).

### 4.2 Optionnelles (défauts acceptables, ne rien poser)

`NORDLA_DATA_LABEL` (libellé de source ; sinon « Supabase <ref> »), `ANALYTICS_REPORTS_DIR` (défaut `/app/data/analytics-reports`),
`ANALYTICS_REFRESH_HOURS` (3), `SOURCING_SAFETY_REPORTS` (26), `SOURCING_ALLOWED_HOSTS`, `SOURCING_VOICE_DIR`, `NORDLA_CORE_CONFIG`
(sources : `railway-handoff-9e25f1d.md:74-75` ; `grep env.` sur `src/sourcing/server/index.js`).

### 4.3 Doivent rester ABSENTES

`ANTHROPIC_API_KEY`, `SOURCING_VISION_PROVIDER`, `SOURCING_TOKEN` (`staged-corrections.json`, `must_be_absent`) ; `SOURCING_BACKUP_B2_KEY_ID`,
`SOURCING_BACKUP_B2_KEY`, `SOURCING_BACKUP_B2_BUCKET_ID` (B2 non créé, chantier séparé : `index.js:149` affiche « isolated immutable copy OFF ») ;
`PROCUREMENT_PG_URL`, `PROCUREMENT_USERS`, `PROCUREMENT_ALLOWED_HOSTS`, `SOURCING_CASES_DIR` (voir §9) ; **toute variable partagée (`shared`) ou référence `${{…}}` vers un autre service** ;
toute valeur contenant `xbtzjabbseclmqfozjeo` ou `36b1a1a7-2a48-416a-9dfe-ce66fe1ec2a5` (`railway-changeset-audit.md:63-66`).

### 4.4 Secrets (nom + qui + format) — jamais de valeur dans un chat, un document ou un journal

Saisis **par P seul**, Railway → `sourcing-staging` → *Variables* → *New Variable*, puis **⋮ → Seal** (illisible partout, fournie quand même au
service). Ne **pas** cliquer *Deploy* à ce stade. Source : `procedure-activation-staging.md:29-42` ; `guide-proprietaire-avant-activation.md:16-30` (origin).

| Nom | Où | Format |
|---|---|---|
| `SUPABASE_SERVICE_ROLE_KEY` | Railway | clé `service_role` (Legacy, JWT) ou `sb_secret_…` du projet **nordla-finance-staging** `fvhiammdskpcnfodsnrc` ; vérifier que l'adresse de la page contient `fvhiammdskpcnfodsnrc` |
| `SUPABASE_ANON_KEY` | Railway | clé `anon` (Legacy) ou `sb_publishable_…`, **même projet** |
| `NORDLA_IDENTITY_RATE_LIMIT_KEY` | Railway | 64 caractères (hex via `openssl rand -hex 32` ou générateur du gestionnaire), ≥ 32 octets ; **différente** de la suivante (`hosted.js:7-10`) |
| `NORDLA_CSRF_KEY` | Railway | idem, **autre** valeur |
| `SOURCING_BACKUP_PASSPHRASE` | Railway | ≥ 16 caractères, **enregistrée d'abord** dans le gestionnaire de mots de passe + papier : sans elle aucune archive ne se relit |
| `STAGING_SERVICE_ROLE_KEY` | GitHub, environnement `supabase-staging` | la **même** clé service staging (restauration indépendante) |
| `STAGING_SOURCING_BACKUP_PASSPHRASE` | GitHub, environnement `supabase-staging` | **exactement** la même phrase que `SOURCING_BACKUP_PASSPHRASE` |

Si une clé de production est collée par erreur : le service refuse de démarrer (`HOSTED_SUPABASE_KEY_MISMATCH` / `HOSTED_SUPABASE_KEY_REJECTED`), rien n'est abîmé.

## 5. Sécurité et authentification

**Identité (mode hébergé)** : un Compte Supabase Auth + **adhésion ACTIVE** au marchand `NORDLA_MERCHANT_ID` + module `sourcing` ACTIVE → session Nordla
(`src/sourcing/server/hosted.js:4-6`, `session-gate.js`). Aucun jeton de développement. Le marchand n'est **jamais** pris dans une requête. La
configuration incomplète empêche le démarrage, chaque manque avec son code (`HOSTED_MERCHANT_REQUIRED`, `HOSTED_ORIGIN_REQUIRED`,
`HOSTED_IDENTITY_REQUIRED`, `HOSTED_PROFILE_REQUIRED`, `HOSTED_SUPABASE_PROJECT_REQUIRED/INVALID/MISMATCH/KEY_MISMATCH` : `hosted.js:33-63`).

**Vérification au démarrage** (`verifyPinnedProject`, `hosted.js:75-92`) : requêtes **uniquement** vers `https://fvhiammdskpcnfodsnrc.supabase.co` ;
clé refusée (401/403) → refus de démarrer ; marchand absent du projet → `HOSTED_MERCHANT_NOT_IN_PROJECT` ; projet injoignable →
`UNVERIFIED_UNREACHABLE` (le service démarre, connexion fermée). Relevé réel des connexions sortantes dans l'image : ce projet + `ec.europa.eu`
(Safety Gate), rien d'autre (`railway-staging-go-nogo.md:58`, F1).

**Origines / hôtes** : `SOURCING_PUBLIC_ORIGIN` unique ; seul son hôte est servi. Tout le reste → **421** (sauf `/healthz`). Tant que l'origine n'est
pas la bonne (ex. adresse `*.up.railway.app` avec origine `https://app.nordla.app`), personne ne peut se connecter : fermé par défaut
(`procedure-activation-staging.md:18-20`). Origine étrangère → 403.

**En-têtes du proxy** : en production le service exige `X-Real-IP`, `X-Forwarded-Proto: https`, `X-Forwarded-Host`, chacun une fois, bien formés
(`src/security/request.js:4-9, 64-65`). Absents → toute API répond 400 « Requête invalide » : premier diagnostic (`railway-handoff-9e25f1d.md:101`).

**Cookies / CSRF / HSTS / CSP** : cookies `__Host-` (Secure, sans `Domain`, liés à l'hôte exact) + CSRF ; HSTS `max-age=31536000` ; CSP stricte,
`X-Frame-Options: DENY`, `nosniff`, `no-referrer` (`domaine-app-nordla-app.md:8-12` ; `railway-handoff-9e25f1d.md:107-108`).
Conséquence : changer d'origine = reconnexion **et** stockage du téléphone (localStorage, IndexedDB, cache du service worker) vide ; le serveur
n'est pas touché (`domaine-app-nordla-app.md:12-15`).

**Sans session** : `/api/core/modules` et `/api/cases` → 401 ; POST sans session / CSRF → 401. **Données** : écriture du journal non durable → 503,
jamais une décision « enregistrée » à tort (`railway-staging-go-nogo.md:21`, A5).

**Surface Achats** : non exposée par `ab02b77` ; montage en cours non commité, voir §9 (même session, même hôte, même CSRF).

## 6. Tests de santé (commandes précises)

`$O` = origine servie. Avant le DNS (origine réglée sur `app.nordla.app`), l'adresse Railway ne répond que `/healthz` ; tout le reste = 421, **voulu**.

| # | Contrôle | Commande | Attendu | Si faux |
|---|---|---|---|---|
| H1 | Vivant | `curl -sS -i $O/healthz` | `200` `{"ok":true}` | déploiement refusé : lire la 1re ligne d'erreur des journaux |
| H2 | Hôte strict | `curl -sS -o /dev/null -w '%{http_code}\n' https://<cible>.up.railway.app/api/core/modules` (après bascule vers `app.nordla.app`) | `421` | origine mal réglée |
| H3 | Sans session | `curl -sS -o /dev/null -w '%{http_code}\n' $O/api/core/modules` | `401` | `400` = en-têtes proxy absents |
| H4 | Origine étrangère | `curl -sS -o /dev/null -w '%{http_code}\n' -H 'Origin: https://exemple.invalid' -X POST $O/api/auth/login` | `403` (ou `401` sans session) — jamais `200` | arrêt |
| H5 | En-têtes | `curl -sI $O/` | `strict-transport-security`, `content-security-policy`, `x-frame-options: DENY` | arrêt |
| H6 | http → https | `curl -sI http://<hôte>/healthz` | 301/308 vers `https://` ; sinon **arrêt** (le service ne doit pas servir la page de connexion en clair) | non confirmé par la doc officielle |
| H7 | Sauvegarde (avant 1re exécution) | `curl -sS $O/healthz/backup` | `PENDING_FIRST_RUN` | |
| H8 | Sauvegarde (+10 min et après) | `curl -sS -i $O/healthz/backup` | `200` `OK` ; `503` `FAILING` après deux échecs ou > 26 h sans copie hors serveur (`app.js:150`) | diagnostic avant tout test |
| H9 | DNS | `nslookup app.nordla.app` | CNAME vers la cible Railway | |
| H10 | Certificat | `openssl s_client -connect app.nordla.app:443 -servername app.nordla.app </dev/null 2>/dev/null \| openssl x509 -noout -issuer -subject -dates` | émetteur Let's Encrypt, sujet `app.nordla.app`, dates valides | `domaine-app-nordla-app.md:52-69` |

Journaux de démarrage attendus (lecture R ; contrôles C1–C7 de `controles-apres-activation.md`, origin) :

| Ligne | Source du texte | Si absente / autre |
|---|---|---|
| `Supabase project check (fvhiammdskpcnfodsnrc): VERIFIED` | `index.js:96` | `HOSTED_SUPABASE_KEY_REJECTED` → clé fausse / d'un autre projet ; `HOSTED_MERCHANT_NOT_IN_PROJECT` → mauvais `NORDLA_MERCHANT_ID` ; `UNVERIFIED_UNREACHABLE` → **un seul** redémarrage, sinon arrêt |
| `HOSTED for https://app.nordla.app … merchant 67646dbb-… Supabase project fvhiammdskpcnfodsnrc` | `index.js:110` | `HOSTED_*_REQUIRED` → variable manquante nommée |
| `Nordla Core ON for merchant 67646dbb-…` | `index.js:66` | `Nordla Core OFF (JOURNAL_NOT_ON_A_VOLUME)` → volume non monté sur `/app/data` : arrêt |
| `Process: Node 24…, uid 1000` | `index.js:113` | `uid 0 (ROOT …)` → entrypoint contourné : arrêt |
| `Backups: every 24 h, first in 10 min … bucket nordla-backups` | `index.js:149` | `NOT scheduled` → passphrase ou bucket manquant |
| aucun secret, mot de passe, adresse de base | C7 : 0 occurrence de `eyJ`, `sb_secret_`, `sb_publishable_`, `postgres://`, `postgresql://` | arrêt, rotation de la clé concernée |

Post-activation sur staging (lecture seule, I) : Q1 marchand / OWNER / module, Q2 objets `sourcing-*.nsb` de `nordla-backups`, Q3 `identity_events`
après le test 1 du Xiaomi (requêtes SQL dans `controles-apres-activation.md:22-24`, origin). C6 : comparer identifiants et dates de déploiement de **chaque autre
service** au relevé noté avant le Deploy.

## 7. Séquence d'activation, avec points d'arrêt et critères GO / NO-GO

Calendrier visé : tout jusqu'à l'étape 7 le **16–17/10** ; DNS au plus tard le **17/10** (`domaine-app-nordla-app.md:71`). Une condition non remplie = arrêt.

| # | Étape | Qui | Critère GO | Critère NO-GO (arrêt) |
|---|---|---|---|---|
| 0 | **Décider le commit** (voir §9 et question Q1). Par défaut : `ab02b77` | P | commit unique choisi, CI verte sur ce SHA | tout commit sans CI complète verte |
| 1 | Budget : noter l'usage du mois de l'espace ; alerte e-mail 8 USD ; limite stricte seulement si marge | P | alerte enregistrée | usage actuel déjà proche de la limite |
| 2 | Saisir les 5 secrets Railway + sceller ; 2 secrets GitHub (`supabase-staging`) | P | 5 noms avec cadenas ; 2 noms GitHub datés du jour | une valeur collée dans un chat → la régénérer à la source |
| 3 | **Audit du lot** par R (lecture) : nombre de lignes, « 0 ligne hors service », commit = SHA complet, `NORDLA_MERCHANT_ID` = `67646dbb-…`, aucune valeur `36b1a1a7` / `xbtzjabbseclmqfozjeo`, variables du §4.1 exactes, §4.3 absentes, aucune variable partagée | R | toutes les lignes en classe **A** (service + volume de `sourcing-staging` seulement), attendu 33 + 5 = **38** à confirmer | une ligne B (autre service, variable partagée, suppression, domaine ailleurs, 2e service/volume, prod) ou C non justifiée (`railway-changeset-audit.md:47-66`) |
| 4 | Noter, pour chaque autre service de l'espace, id + date du dernier déploiement (référence du C6) | R | relevé fait | — |
| 5 | **Autorisation écrite** : « J'autorise le Deploy du lot staging de sourcing-staging » | P | phrase exacte reçue dans le chat | toute autre formulation / autorisation sans l'étape 3 verte |
| 6 | **Deploy** (bouton du bandeau « changements » ; un redéploiement GitHub n'applique **pas** le lot) | R ou P | déploiement « réussi » | échec healthcheck : le déploiement est marqué en échec, aucun autre service touché ; lire la 1re ligne d'erreur, corriger la variable, redéployer |
| 7 | Lecture des journaux (tableau §6) + H1 sur l'adresse | R lit, I interprète | les 5 lignes attendues, 0 fuite (C1–C3, C7) | `uid 0`, `JOURNAL_NOT_ON_A_VOLUME`, `*_REJECTED`, `NOT scheduled`, secret visible |
| 8 | Générer le domaine Railway (**port cible 8787**) ; si DNS autorisé : domaine personnalisé `app.nordla.app` + `CNAME app → <cible>` (TTL 600) **et** `TXT _railway-verify.app → <jeton>` chez Porkbun ; ne pas supprimer / recréer le domaine plusieurs fois (limite Let's Encrypt). Origine déjà `https://app.nordla.app` : **aucune variable à changer** | P (Porkbun) + R | H9, H10 verts ; avant ça : aucun enregistrement `app` existant, CAA autorisant `letsencrypt.org`, DNSSEC cohérent | enregistrement `app` préexistant (le noter, ne pas écraser) ; certificat bloqué (TXT manquant) |
| 8b | **Plan B sans DNS** : `SOURCING_PUBLIC_ORIGIN=https://<adresse générée>` en attente → Deploy (seul `sourcing-staging` redémarre) | R | — | le téléphone ne doit utiliser **que** l'adresse finale : export « N photo(s) sur N » avant tout changement d'adresse |
| 9 | Sécurité depuis un ordinateur : H1–H6 sur l'adresse servie | I | tous conformes | `200` sur un POST sans session, en-tête manquant, http servi en clair |
| 10 | Sauvegarde : +10 min `Backup OK: … copied off-server as sourcing-<date>.nsb` ; I vérifie l'objet (Q2) ; H8 `OK` | I | objet présent dans `nordla-backups` | `Backup FAILED (<code>)` : nouvel essai auto à +1 h ; staging **non opérationnel** tant que ce n'est pas vert |
| 11 | **Restauration indépendante** (C5) : P écrit « run: true restauration autorisé » → I met `ops/staging-backup/request.json` `"run": true` → P approuve *Review deployments* → I lit le rapport (`ok: true`, `archive` = l'objet du C10, `files` ≥ 1) → I remet `"run": false` | P + I | rapport conforme | passphrase différente entre Railway et GitHub, archive illisible → staging **non opérationnel** |
| 12 | C6 : aucun autre service redéployé ; C3 : redémarrage et décision encore là (après le test 10 du Xiaomi, accord P) | R | identifiants / dates inchangés | un autre service a été redéployé |
| 13 | **Test Xiaomi du 18** : `docs/integration/protocole-test-xiaomi.md` (fiche, lignes 1–12) ; données de test uniquement | P | 1–12 réussis | photo / note perdue, déconnexion inexpliquée, réponse sans source, erreur silencieuse (`protocole-test-xiaomi.md:30-31`) |

**GO global pour donner l'adresse au téléphone** : étapes 7, 9, 10 vertes **et** 11 verte (B2 + B3 de la grille : une sauvegarde locale seule ne suffit pas,
`railway-staging-go-nogo.md:53`). Si l'étape 11 n'est pas jouable avant le 18 : décision explicite de P de tester quand même, en sachant que staging n'est
alors pas « opérationnel ».

## 8. Stratégie de retour arrière

| Situation | Action | Effet |
|---|---|---|
| Échec au démarrage / healthcheck | rien à défaire (aucun autre service touché) ; corriger la variable, redéployer | — (`procedure-activation-staging.md:83-86`) |
| Service actif mais douteux | *Settings* → *Remove* du déploiement actif, ou **0 instance** | le **volume et ses données restent** ; base staging non modifiée par l'activation ; production jamais concernée |
| Mauvais commit | redéployer le déploiement Railway précédent ; `ab02b77` → `c2c314d` n'a pas de changement de schéma ; les fichiers ajoutés sur le volume (`core/brand-approved.json`, `core/campaigns.jsonl`, `core/creations/`) sont **additifs** et ignorés par l'ancienne version | rien n'est supprimé ni réécrit (`railway-handoff-9e25f1d.md:112-116`) |
| Domaine | retirer le domaine dans Railway ; supprimer `CNAME app` et `TXT _railway-verify.app` chez Porkbun ; remettre `SOURCING_PUBLIC_ORIGIN` sur l'adresse Railway | aucune donnée serveur touchée ; les données d'un téléphone restent sur l'origine où elles ont été saisies (`domaine-app-nordla-app.md:75-77`) |
| Secret exposé | le régénérer à la source (Supabase / gestionnaire) et le remplacer dans Railway **et** GitHub (même valeur côté passphrase) | |
| Données de test sur le volume | elles portent l'id du marchand de test ; **ne deviennent pas** des données HABB réelles. Le passage à l'identité de production est une étape distincte (migrations production + 3 variables) | `railway-handoff-9e25f1d.md:37-39` |
| Perte du volume | restaurer depuis `nordla-backups` : `node tools/sourcing-backup.mjs fetch <archive> <dossier>` puis `restore <archive> <dossier vide>` (jamais d'écrasement) | `sourcing-railway-go-live.md:89-91` |
| Convergence | jeter la branche `integration/nordla-convergence-v1` (aucune branche source modifiée) | `CONVERGENCE-2026-10-16.md:116` |

Dernière version connue-bonne côté code : `ab02b77`. Côté Railway : **aucun déploiement précédent n'existe** pour ce service (premier déploiement) — le « retour » est donc
l'arrêt (0 instance / Remove), pas un redéploiement antérieur.

## 9. Impact de la branche de convergence (Achats / Stock)

**Constat vérifié (git, ce jour, deux états)** :
- **Commité** (`06d096c`) : `f88e225` fusionne `feature/stock-achat-v1` @ `c4d2e3f`, mais `git diff --stat ab02b77 HEAD -- src` ne liste aucun fichier de `src/sourcing/server/` : les routes `/api/procurement` ne sont **pas** montées (c'est le plan « vague 1 » : `CONVERGENCE-2026-10-16.md:35-42, 44-51`).
- **Non commité, en cours dans l'arbre de travail** (lu par `git diff` / `git status` à la rédaction ; une autre session y travaille, état mouvant) : `src/sourcing/server/app.js` (route `/api/procurement/*` servie après authentification), `src/sourcing/server/index.js` (`buildHostedProcurement`, ligne de journal `Stock / Achats ON|OFF`), nouveau `src/procurement/server/hosted.js`, `src/procurement/server/app.js` modifié, `src/core-pilot/{ask,http}.js` modifiés, nouveau `src/core-pilot/procurement-answers.js`. **Aucun test relancé par moi** ; non commité, non poussé : **absent de tout commit déployable**.

**Ce que ce montage (tel que lu) exige et change pour le service** :

| Sujet | Constat dans le code lu | Conséquence pour l'activation |
|---|---|---|
| Dossier de données Achats | `<SOURCING_DATA_DIR>/procurement/procurement.json` + `uploads/` (`src/procurement/server/hosted.js`, `buildHostedProcurement`) = `/app/data/sourcing/procurement` : **sous le volume ET sous le dossier sauvegardé** (`tools/sourcing-backup.mjs:36-39, 90` parcourt récursivement) | **aucune variable nouvelle**, aucun second volume ; les données Achats entrent dans l'archive chiffrée et dans la copie hors serveur ; la restauration indépendante (étape 11) devra être rejouée pour **prouver** qu'elles reviennent |
| Dossiers Sourcing lus par le pont | `join(dir, 'cases')` = le dossier que le serveur écrit (`/app/data/sourcing/cases`) | `SOURCING_CASES_DIR` inutile en hébergé : ne pas la poser |
| Authentification | pas de login propre : `procurementUserFor(actor)` construit l'utilisateur depuis l'acteur authentifié ; rôles Core → Achats : OWNER→OWNER (seul à approuver / commander), ADMIN→BUYER, COLLABORATOR→WAREHOUSE, VIEWER et ACCOUNTANT→VIEWER ; autre rôle → 403 ; `users: []` | ne **pas** poser `PROCUREMENT_USERS`, `PROCUREMENT_ALLOWED_HOSTS`, `PROCUREMENT_HOST/PORT` ; hôte, session et CSRF restent ceux du serveur hébergé |
| Marchand | `buildHostedProcurement({ merchantId })` reçoit l'id hébergé (`67646dbb-…` en staging) | pas de `merchant-id.txt` aléatoire |
| Stockage | magasin fichier uniquement ; `PROCUREMENT_PG_URL` n'est pas utilisée par ce montage ; le paquet `pg` n'est pas installé | `PROCUREMENT_PG_URL` **absente** ; migration PG de C (`supabase/migrations-pending`) **non appliquée**, décisions en attente (`CONVERGENCE-2026-10-16.md:64`) |
| Isolation des pannes | si le magasin ne s'ouvre pas : `Stock / Achats: NOT mounted (…)` / `Stock / Achats OFF`, le reste de Nordla continue | nouvelle ligne à lire à l'étape 7 : `Stock / Achats ON (/app/data/sourcing/procurement/procurement.json)` ; `OFF` ne bloque pas le test du 18 mais doit être expliqué |
| Un seul écrivain | un processus, une réplique | aucune réplique supplémentaire |
| Capacité du volume | photos Achats (≤ 8 Mo chacune, `src/procurement/server/app.js:40`) dans `uploads/` et archives locales (3) sur le même volume de 1 Go ; `BACKUP_LOW_SPACE` si l'espace manque | surveiller l'espace ; envisager de remonter le volume (décision P) avant un usage réel |
| Nouvelle surface | `/api/procurement/*` + nouveau chemin de lecture pour Parle à Nordla | tests 401 sans session et 403 pour un rôle sans accès, CSRF sur les écritures, avant toute ouverture |
| Redéploiement | tout changement de code = nouveau SHA = nouvelle CI + nouvel audit du lot | jamais le jour du test |

**Ce que la convergence commitée change dans l'image par rapport à `ab02b77`** (`git diff --stat ab02b77 HEAD`, 37 fichiers, +3 236 lignes) :
- `src/core-pilot/*` (assistant de terrain « Parle à Nordla » : `field-intents.js`, `field-answers.js`, `field-context.js`, `field-facts.js`, `ask.js`, `http.js`) et `src/sourcing/core/decision.js` ;
- `src/integration/*` (3 fichiers Achats) et `src/procurement/**` ;
- `package.json` : 3 scripts (`procurement`, `procurement:phone`, `procurement:parity`) ;
- **inchangés** : `deploy/sourcing/Dockerfile`, `docker-entrypoint.sh`, `railway.json`, `railpack.json`, `package-lock.json`, `tools/sourcing-backup.mjs`, `config`, `resources`, `vendor`, `schemas`.

**Important pour le 18** : l'assistant de terrain (PR #12/#13) est absent de `ab02b77` (fusionné ensuite : `92297c8`) ; le protocole mis à jour dit de **ne pas le tester le 18 sur `ab02b77`** (`protocole-test-xiaomi.md`, diff des commits `b843bca` / `4a13fd0` sur `origin/claude/nordla-core-p0`). Déployer la convergence à la place de `ab02b77` demanderait : valider puis commiter le montage Achats en cours, pousser la branche (non fait, accord P), CI complète Node 20 + 24 sur le nouveau SHA, ré-épinglage, **nouvel audit du lot**, et prouver la restauration avec les données Achats. Recommandation : **`ab02b77` pour le 18** (image déjà auditée, Achats hors test), convergence après.

## 10. Risques

1. **Priorité `railway.json` vs commande du service** : possible démarrage en root (§1). Détecté par `uid` au journal ; non vérifiable avant le Deploy.
2. **Lot en attente qui dérive** (29 → 32 → 33 lignes) et règle « Deploy applique TOUT le lot » : une ligne parasite serait appliquée avec le reste. Audit ligne par ligne obligatoire juste avant l'autorisation.
3. **DNS tardif** : sans `app.nordla.app` au plus tard le 17/10, le 18 se fait sur l'adresse Railway et le téléphone changera d'adresse (export « N photo(s) sur N » obligatoire, stockage vide à la nouvelle origine, rien migré automatiquement). Certificat : Let's Encrypt, TXT de vérification requis ; pas d'essais répétés.
4. **Sauvegarde non prouvée avant l'activation** : B2 + B3 impossibles avant ; staging non « opérationnel » sans elles ; le bucket Supabase n'est pas immuable face à la clé de service (B2 Object Lock : chantier séparé, non créé).
5. **Budget** : estimation 2–4 $ non confirmée ; limite stricte = arrêt de tous les services de l'espace.
6. **Redirection http → https** de Railway non confirmée officiellement ; HSTS d'un an une fois `app.nordla.app` servi.
7. **Données staging** : Finance / Analytics diront « données indisponibles » (marchand de test sans ventes) — normal, à ne pas prendre pour une panne.
8. **Divergence de branches** : `ab02b77` ne contient pas l'assistant de terrain ; la convergence est locale et non poussée ; ne pas mélanger les deux le jour du test.
9. **Limites non réglables** (CPU / mémoire) sur un service avec volume : le seul plafond de dépense est la limite d'usage du compte.
10. **Non testé sur matériel réel** : Xiaomi physique, réseau mobile, appareil photo (`railway-staging-go-nogo.md:64`, F5) ; 8 tests Sourcing échouent sous Windows (chemin `C:\C:\`), identiques sur la base d'origine, passent sous Linux / CI (`CONVERGENCE-2026-10-16.md:198`).

## 11. Questions pour le propriétaire (6)

1. **Commit du 18** : `ab02b77` (CI verte, sans assistant de terrain, recommandé) ou un nouveau commit de convergence (assistant de terrain inclus, mais push + CI + nouvel audit du lot, et Achats toujours non monté) ?
2. **DNS** : autorisez-vous `CNAME app` + `TXT _railway-verify.app` chez Porkbun avant le 17/10, sinon le test se fait sur l'adresse Railway (un changement de variable + Deploy) ?
3. **Budget** : quel est l'usage actuel de l'espace Railway, et confirmez-vous l'alerte à 8 USD sans limite stricte ?
4. **Achats / Stock** : confirmez-vous qu'ils sont **hors** du test du 18 sur le serveur hébergé (non montés), et qu'on les teste, si besoin, sur l'app autonome du PC ?
5. **Sauvegarde** : le 18 est-il conditionné à la restauration indépendante (étape 11) verte, ou acceptez-vous de tester avec une sauvegarde locale + hors-serveur non encore restaurée ?
6. **Secrets** : confirmez que vous saisissez vous-même les 5 secrets Railway (scellés) et les 2 secrets GitHub, avec la même phrase de passe des deux côtés, conservée dans votre gestionnaire (+ papier).

---

## Résumé (≤ 12 lignes)

- Service `sourcing-staging` : Dockerfile `deploy/sourcing/Dockerfile`, entrypoint + `service-start.js`, healthcheck `/healthz`, 1 réplique, volume 1 Go sur `/app/data`, port 8787 ; commit à déployer `ab02b77` (CI verte rapportée).
- Rien n'est déployé (`staged-create`, rapporté par R, non revérifié) ; secrets, DNS et sauvegarde B2/restauration restent à faire.
- Coût estimé 2–4 USD/mois (RAM 48 Mo mesurée, tarifs Railway du 15/10 non revérifiés) ; alerte 8 USD, pas de limite stricte sauf marge.
- 16 variables non secrètes exactes (staging : projet `fvhiammdskpcnfodsnrc`, marchand `67646dbb-…`, origine `https://app.nordla.app`) ; 5 secrets Railway + 2 GitHub saisis par le propriétaire seul.
- Sécurité : identité Core (Auth + adhésion + module), origine unique (421 sinon), en-têtes proxy exigés, cookies `__Host-`, HSTS/CSP, garde de projet Supabase au démarrage.
- Séquence en 13 étapes avec GO/NO-GO ; adresse servie seulement après sauvegarde hors serveur et restauration indépendante vertes.
- Retour arrière : 0 instance / Remove (volume et base intacts), retrait CNAME/TXT ; aucun déploiement antérieur n'existe.
- Convergence : au commit `06d096c` les routes `/api/procurement` ne sont **pas** montées ; un montage non commité est en cours dans l'arbre (données sous `/app/data/sourcing/procurement` donc sur le volume et sauvegardées, aucune variable nouvelle, auth par la session Nordla, panne isolée) : absent de `ab02b77`, comme l'assistant de terrain.
- Risques majeurs : priorité `railway.json` (root possible), dérive du lot (29/32/33), DNS avant le 17, sauvegarde non prouvée avant activation. 6 questions au §11.
