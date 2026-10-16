# Procédure finale — lancer Nordla staging (`sourcing-staging`, commit `50c865c`)

Qui : **P** = propriétaire (ou la session Railway, sous son contrôle) ; **I** = Infrastructure (cette session : vérifications
sans secret). Chaque étape a sa condition d'arrêt : **une condition non remplie = on s'arrête, rien de plus n'est fait.**
Aucune étape ne touche la production, le DNS ou un secret en dehors de ce que P saisit lui-même.

## 1. Constats Railway (P, lecture seule, avant tout)

Service `sourcing-staging`, environnement **staging** du projet `app.nordla.app` :

| À constater | Où | Attendu | Si non |
|---|---|---|---|
| Volume | *Settings* → *Volumes* | `sourcing-staging-data` monté sur **`/app/data`** | arrêt |
| Une seule instance | *Settings* → *Deploy* → *Replicas* | **1** (Railway n'autorise pas plusieurs répliques avec un volume) | arrêt |
| Commande / santé | *Settings* → *Deploy* | démarrage `/app/docker-entrypoint.sh node src/service-start.js`, healthcheck `/healthz` | corriger |
| Isolation | *Variables* du service | **aucune** référence `${{shared.…}}` ni `${{AutreService.…}}` pour `SUPABASE_*`, aucune valeur contenant `xbtzjabbseclmqfozjeo` | arrêt |
| Absentes | *Variables* | `ANTHROPIC_API_KEY`, `SOURCING_VISION_PROVIDER`, `SOURCING_TOKEN` **absentes** (aucune photo vers une IA pendant ce test) | supprimer avant |
| Autres services | vue du projet | Finance / Analytics existants **non modifiés** ; pas de second service Sourcing | arrêt |

Limites CPU / mémoire : d'après la communauté Railway, elles **ne se règlent pas** sur un service avec volume. Le coût est donc borné par
la limite d'usage (§2) et par la mesure : 48 Mo au repos.

## 2. Budget (P)

*Workspace* → *Usage* : lire d'abord **l'usage du mois en cours de tout l'espace** (les services existants comptent).
- **Alerte e-mail** (sans effet sur les services) : **8 USD**.
- **Limite stricte** (*hard limit*) **10 USD** : à ne poser que si l'usage actuel laisse de la marge. Atteinte, elle **met hors ligne
  tous les services de l'espace**, y compris Finance / Analytics s'ils y sont ; ce n'est pas un plafond absolu (le volume reste facturé).
  Minimum accepté par Railway : 10 USD (réponse de l'équipe Railway sur son forum).

## 3. Variables

Non secrètes (P les colle telles quelles) :

```
NORDLA_SERVICE=sourcing
SOURCING_HOSTED=1
NODE_ENV=production
NORDLA_SUPABASE_PROJECT_REF=fvhiammdskpcnfodsnrc
SUPABASE_URL=https://fvhiammdskpcnfodsnrc.supabase.co
NORDLA_MERCHANT_ID=67646dbb-5e2e-4cd7-aad6-0ab289b068cb
SOURCING_MERCHANT_ID=habb
MERCHANT_TIMEZONE=Europe/Brussels
SOURCING_PUBLIC_ORIGIN=https://<adresse générée>.up.railway.app
SOURCING_DATA_DIR=/app/data/sourcing
SOURCING_BACKUP_DIR=/app/data/sourcing-backups
SOURCING_BACKUP_KEEP=3
SOURCING_BACKUP_BUCKET=nordla-backups
SOURCING_HOST=0.0.0.0
SOURCING_PORT=8787
PORT=8787
```

Secrets — **P les saisit lui-même**, jamais dans un chat :

| Où | Nom | Valeur |
|---|---|---|
| Railway | `SUPABASE_SERVICE_ROLE_KEY` | clé service du projet **staging** (`fvhiammdskpcnfodsnrc`) |
| Railway | `SUPABASE_ANON_KEY` | clé publique du projet **staging** |
| Railway | `NORDLA_IDENTITY_RATE_LIMIT_KEY` | 32 octets aléatoires (`openssl rand -hex 32`) |
| Railway | `NORDLA_CSRF_KEY` | 32 octets aléatoires, **différents** du précédent |
| Railway | `SOURCING_BACKUP_PASSPHRASE` | ≥ 16 caractères ; aussi dans le gestionnaire de mots de passe + papier |
| GitHub `supabase-staging` | `STAGING_SERVICE_ROLE_KEY` | la même clé service **staging** |
| GitHub `supabase-staging` | `STAGING_SOURCING_BACKUP_PASSPHRASE` | **la même** phrase que `SOURCING_BACKUP_PASSPHRASE` |

`RAILWAY_*` (dont `RAILWAY_VOLUME_MOUNT_PATH`) sont posés par Railway : ne rien saisir.

## 4. Activation (P — étape payante, sur confirmation explicite)

Déployer le patch du service épinglé sur **`50c865cdf33184f873f6f905e4b4897753325c86`**.

## 5. Contrôles de démarrage (P lit les journaux ; I interprète si besoin)

Le journal doit contenir, dans cet ordre :
1. `Supabase project check (fvhiammdskpcnfodsnrc): VERIFIED` — sinon **arrêt** (`HOSTED_SUPABASE_*` = mauvaise clé, mauvais projet ou
   marchand absent ; `UNVERIFIED_UNREACHABLE` = attendre et redémarrer une fois).
2. `HOSTED for https://… merchant 67646dbb-… Supabase project fvhiammdskpcnfodsnrc`
3. `Nordla Core ON for merchant 67646dbb-…` — `Nordla Core OFF (JOURNAL_NOT_ON_A_VOLUME)` = volume absent : **arrêt**.
4. `Process: Node 24…, uid 1000` (pas `ROOT`).
5. `Backups: every 24 h, first in 10 min, … off-server bucket nordla-backups`.
6. **Aucun** secret, mot de passe ou adresse de base visible.

## 6. Contrôles de sécurité (I, depuis un ordinateur, sans le téléphone)

| Requête | Attendu |
|---|---|
| `GET https://<adresse>/healthz` | `{"ok":true}` |
| `GET https://<adresse>/api/core/modules` | 401 |
| `GET http://<adresse>/healthz` | redirection vers `https://` |
| `GET https://<adresse>/` | `strict-transport-security`, `content-security-policy`, `x-frame-options: DENY` |
| `POST /api/core/creation` avec `Origin: https://evil.example` | 403 |
| `GET https://<adresse>/healthz/backup` | `PENDING_FIRST_RUN` (200) |

## 7. Sauvegarde et restauration (staging « opérationnel » seulement après ce point)

1. +10 min : journal `Backup OK: … copied off-server as sourcing-<date>.nsb` ; `/healthz/backup` → `OK`.
2. I vérifie la présence de l'objet dans `nordla-backups` (métadonnées seulement).
3. P autorise `ops/staging-backup/request.json` `"run": true` ; I pousse ; P approuve `staging-backup-drill` ; I lit le rapport
   (archive restaurée sur un runner GitHub, fichiers vérifiés) ; I remet `"run": false`.
4. Ensuite seulement (option, accord séparé) : coffre B2 immuable, `docs/infrastructure/sauvegarde-isolee-b2.md`.
5. Alerte : ajout de `staging-backup-monitor.yml` sur `main` (PR à fusionner par P) puis `ops/staging-monitor/target.json` `"enabled": true`.

## 8. Domaine puis Xiaomi

`app.nordla.app` sur autorisation DNS séparée (`docs/infrastructure/domaine-app-nordla-app.md`) ; après bascule de
`SOURCING_PUBLIC_ORIGIN`, refaire §6 sur `https://app.nordla.app`. Puis `docs/integration/protocole-test-xiaomi.md` le 18/10.

## Retour arrière

Mettre le service à 0 instance ou redéployer le déploiement précédent ; le volume et la base staging restent intacts ; la production
n'est jamais concernée. Domaine : retirer CNAME et TXT.
