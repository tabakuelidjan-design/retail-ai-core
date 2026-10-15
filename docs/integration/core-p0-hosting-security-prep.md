# Core P0 — préparation hébergement et sécurité de China Sourcing

> **Lire d'abord.** Le plan d'hébergement de référence appartient à la session Infrastructure :
> `docs/infrastructure/nordla-cloud-plan.md` sur `claude/blissful-babbage-z0nrt2` (`2b6b983`). Il enregistre les décisions du propriétaire :
> **Railway en priorité** (Hetzner seulement avec justification écrite), cible `app.nordla.app`, **Supabase reste la seule base**.
> Ce document-ci ne décide rien : il décrit ce que la branche `claude/nordla-core-p0` a préparé dans le code. Ce fichier s'appelait
> `docs/infrastructure/nordla-cloud-plan.md` dans les commits `77e06b6`..`7681aa2` ; il a été déplacé pour ne pas entrer en conflit
> avec le fichier réservé à Infrastructure. Là où le texte ci-dessous recommande Hetzner ou propose « Postgres sur le VPS », il est
> **remplacé** par les décisions ci-dessus.
>
> Conséquence pour Railway : `deploy/sourcing/` (Compose + Caddy) reste une variante. Sur Railway il n'y a pas de Caddy devant le
> service ; la première couche d'authentification doit alors être dans l'application (le modèle existe déjà : mode hébergé
> d'Analytics, `src/analytics-premium/server/hosting.js` : hôtes autorisés, jeton, limitation de débit, HSTS) et `sourcing` doit
> être ajouté à `src/service-start.js`. Ces deux points sont à faire par Core P0 / Infrastructure, après accord.

Statut : **préparé, en attente des décisions du propriétaire**. Aucun compte, serveur, domaine, abonnement ou secret n'a été créé ;
aucune migration n'a été appliquée. Reprend uniquement la partie hébergement / sécurité du plan du 2026-10-14
(branche `claude/blissful-babbage-z0nrt2`), avec un état de l'existant corrigé. Les prix sont des estimations à vérifier sur les pages
officielles avant toute souscription.

## 1. Existant (état réel, branche `claude/nordla-core-p0`)

| Élément | État |
|---|---|
| Runtime | China Sourcing exige Node 24 (garde `src/sourcing/runtime.js`, image `deploy/sourcing/Dockerfile` `node:24-slim`). `engines` du dépôt reste `>=20` (décision 2026-10-14 : changement global réservé à Infrastructure après vérification des déploiements). |
| China Sourcing | Dans ce dépôt (`src/sourcing/`) : serveur HTTP + PWA hors ligne. Aujourd'hui sur le PC Windows (`npm run sourcing:phone`, tunnel Cloudflare temporaire, jeton de jumelage, écoute en loopback). Données en fichiers JSON (`data/local/sourcing/`), mono-marchand. |
| Mode hébergé | Prêt dans le code : `SOURCING_HOSTED=1` (configuration complète exigée, refus codés), `/healthz`, `deploy/sourcing/` (Compose + Caddy), testé localement. |
| Sauvegarde | `tools/sourcing-backup.mjs` : archive chiffrée (AES-256-GCM), vérifiée à l'écriture, restauration testée, rétention. Copie hors serveur immuable : à décider. |
| Téléphone hors ligne | File d'envoi persistante existante (dossiers « à envoyer », renvoi automatique au retour du réseau, conflits conservés des deux côtés). Ajout : demande de stockage persistant (`navigator.storage.persist()`) contre l'éviction Android. |
| Supabase | RLS activée partout, aucune policy ; 6 fonctions `fin_*` sans `search_path` sur le projet réel (33 dans les migrations du dépôt). Migrations correctrices **préparées** dans `supabase/migrations-pending/` (non appliquées). |
| Persistance des objets d'intégration et des cas Sourcing | Tables préparées (même dossier), avec `merchant_id`. Le serveur Sourcing utilise encore les fichiers tant que la base n'est pas choisie et la migration autorisée. |
| Authentification | Couche 1 : mot de passe du propriétaire au niveau de Caddy (hash bcrypt). Couche 2 : jeton applicatif (≥ 32 caractères) sur chaque `/api`. Cible ultérieure : passkeys (WebAuthn) + appareils révocables. |

## 2. Hébergement

| Critère | Hetzner Cloud (UE) — recommandé | Railway |
|---|---|---|
| Coût indicatif | VPS CX22/CX23 ≈ 4–7 €/mois + IPv4 ; total réaliste avec stockage de sauvegarde et domaine ≈ 15–25 €/mois | ≈ 20 $/mois + usage, variable |
| Données | Allemagne/Finlande, résidence UE claire | Région UE à choisir |
| Maintenance | À notre charge (OS, pare-feu, Docker) | Gérée |
| Authentification devant l'app | Caddy (inclus dans `deploy/sourcing/`) | Pas de proxy à nous : il faut une autre couche (ex. Cloudflare Access) |
| Portabilité | Docker Compose, aucune dépendance | Moyenne |

Architecture cible (un conteneur par module, ajoutés au fur et à mesure) :
```
Internet ── HTTPS ── Caddy (TLS, HSTS, mot de passe propriétaire)
                      ├── sourcing   (Node 24, SOURCING_HOSTED=1)          ← prêt
                      ├── finance / analytics / core  (src/service-start.js, NORDLA_SERVICE)   ← image prête, à brancher
Données : Supabase (UE, déjà utilisé) ou Postgres sur le VPS — décision
Hors serveur : sauvegardes chiffrées immuables (compte séparé), supervision externe
```

## 3. Sécurité

- **Réseau / système** : pare-feu tout fermé sauf 80/443 (+ SSH par clé, limité à l'IP du propriétaire ou via VPN), mises à jour automatiques,
  conteneurs non-root, `read_only`, `cap_drop: ALL`, `no-new-privileges` ; seul Caddy publie des ports.
- **Hôte** : le serveur refuse tout nom d'hôte autre que `SOURCING_ALLOWED_HOSTS` (anti DNS-rebinding) ; HSTS.
- **Secrets** : uniquement dans `deploy/sourcing/.env` sur le serveur (ignoré par Git) ; jamais dans l'image, le dépôt ou le navigateur ;
  phrase de sauvegarde conservée aussi hors serveur. Rotation : changer le jeton ou le hash puis `docker compose up -d`.
- **Limite connue** : derrière Caddy, le compteur d'essais de jeton (8/min) voit l'adresse de Caddy, pas celle du client ; le mot de passe
  en amont empêche un inconnu d'atteindre `/api`. À revoir avec les passkeys.
- **Base** : appliquer les policies RLS explicites et le `search_path` des `fin_*` (migrations préparées) avant toute exposition d'une clé
  autre que `service_role` ; la clé `service_role` reste côté serveur.
- **Sauvegardes** : quotidiennes, chiffrées, 30 versions locales + copie hors serveur à rétention immuable (clé d'écriture seule) ;
  **test de restauration avant mise en service**, puis trimestriel.
- **Journalisation / alertes** : journaux JSON de Caddy, `healthcheck` du conteneur, supervision externe de `/healthz`.

## 4. Mise en service par étapes

| Étape | Critère de sortie |
|---|---|
| 0. Décisions (hébergeur, budget, base, domaine, migrations) | Réponses écrites du propriétaire |
| 1. Sauvegarde de référence des données du PC (`tools/sourcing-backup.mjs`) | Vérifiée + restaurée une fois |
| 2. Serveur + domaine + Caddy | Certificat réel, 401 sans mot de passe, 200 avec |
| 3. Import des données (copie) | Comptes et SHA-256 identiques |
| 4. Xiaomi en 4G, **PC éteint** | Installation PWA, saisie, hors ligne, renvoi automatique |
| 5. Restauration complète sur une machine vierge | Données intactes, temps mesuré |
| 6. Mesures d'accès Belgique puis Chine | Rapport chiffré, sans promesse |
| 7. Bascule ; le PC garde sa copie ≥ 30 jours | Aucune perte |

## 5. Décisions attendues

1. Hetzner ou Railway, et budget (≈ 15–25 €/mois).
2. Base : Supabase ou Postgres sur le serveur.
3. Domaine.
4. Autorisation d'appliquer les migrations préparées.
