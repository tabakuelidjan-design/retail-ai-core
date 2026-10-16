# Procédure finale — activer `sourcing-staging` (commit `ab02b77`)

**P** = propriétaire (seul pour les secrets, le budget et l'autorisation) · **R** = ChatGPT avec le connecteur Railway ·
**I** = cette session (GitHub, Supabase staging en lecture, vérifications). Une condition non remplie = arrêt.

Commit : `ab02b7791b7dd91fbc7c10e7029bef5983a0c02a` (CI verte : core-reliability 38864695248 Linux + vrai disque + Windows,
intégration 38864695260 Node 20/24, china-sourcing 38864695251). Lot en attente audité : 32 lignes, toutes A (service + volume).
Comportement Railway (documentation) : **Deploy applique tout le lot en attente** de l'environnement et redéploie les services touchés ;
les changements **réseau** (adresse générée, domaine) ne sont **pas** mis en attente : ils s'appliquent immédiatement.

## 1. Budget (P, 2 min)
*Workspace → Usage* : noter l'usage du mois de tout l'espace. *Usage Limits* : **alerte e-mail 8 USD**. Limite stricte 10 USD seulement
si l'usage actuel laisse de la marge (elle arrête **tous** les services de l'espace et n'est pas un plafond absolu).

## 2. Adresse publique (R, gratuit, avant les secrets)
`sourcing-staging` → *Settings* → *Networking* → *Generate Domain* (appliqué immédiatement) → mettre en attente
`SOURCING_PUBLIC_ORIGIN=https://<adresse générée>` (sans `/` final). **C'est la seule variable encore manquante : sans elle le service
refuse de démarrer** (`HOSTED_ORIGIN_REQUIRED`). Si Railway refuse de générer l'adresse avant le premier déploiement : mettre
`SOURCING_PUBLIC_ORIGIN=https://app.nordla.app` (le service démarre ; seul `/healthz` répondra sur l'adresse Railway), puis corriger
après le §6 (un second « Deploy » de ce seul changement).

## 3. Secrets (P seul — jamais dans un chat, un document ou un journal)
Dans Railway, `sourcing-staging` → *Variables* → *New Variable*, puis **⋮ → Seal** sur chacune (scellée = illisible dans l'interface et
par l'API, connecteur compris ; toujours fournie au service) :

| Nom | Où trouver / comment créer |
|---|---|
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase → projet **nordla-finance-staging** (`fvhiammdskpcnfodsnrc`) → *Project Settings* → *API Keys* → clé `service_role` (onglet *Legacy*) ou `sb_secret_…` |
| `SUPABASE_ANON_KEY` | même page, **même projet staging** : `anon` (Legacy) ou `sb_publishable_…` |
| `NORDLA_IDENTITY_RATE_LIMIT_KEY` | générateur du gestionnaire de mots de passe : 64 caractères hexadécimaux (ou `openssl rand -hex 32` dans un terminal) |
| `NORDLA_CSRF_KEY` | idem, **une autre** valeur |
| `SOURCING_BACKUP_PASSPHRASE` | phrase ≥ 16 caractères, **enregistrée d'abord** dans le gestionnaire de mots de passe (+ papier) |

Dans GitHub → *Settings* → *Environments* → `supabase-staging` → *Add environment secret* :
`STAGING_SERVICE_ROLE_KEY` (la même clé service **staging**) et `STAGING_SOURCING_BACKUP_PASSPHRASE` (**la même** phrase que ci-dessus).

## 4. Dernière vérification du lot (R, lecture)
Le lot = les 32 lignes A déjà auditées **+** 5 secrets **+** `SOURCING_PUBLIC_ORIGIN`, rien d'autre ; aucune ligne hors `sourcing-staging`.
Réponse attendue : nombre de lignes et « 0 ligne hors service » (sans aucune valeur).

## 5. Autorisation (P)
Écrire explicitement : « J'autorise le Deploy du lot staging de `sourcing-staging` ».

## 6. Activation (P ou R, après §5)
Bouton **Deploy** du bandeau des changements (pas de redéploiement GitHub : il n'applique pas le lot).

## 7. Démarrage (R lit les journaux ; I interprète)
| Ligne attendue | Si absente / autre |
|---|---|
| `Supabase project check (fvhiammdskpcnfodsnrc): VERIFIED` | `HOSTED_SUPABASE_KEY_REJECTED` = clé d'un autre projet ou fausse → corriger la clé ; `HOSTED_MERCHANT_NOT_IN_PROJECT` = mauvais marchand ; `UNVERIFIED_UNREACHABLE` = Supabase injoignable → un seul redémarrage, sinon arrêt |
| `HOSTED for https://… merchant 67646dbb-… Supabase project fvhiammdskpcnfodsnrc` | `HOSTED_*_REQUIRED` = variable manquante (nommée dans le message) |
| `Nordla Core ON for merchant 67646dbb-…` | `JOURNAL_NOT_ON_A_VOLUME` = volume non monté → arrêt |
| `Process: Node 24…, uid 1000` | `ROOT` = commande de démarrage incorrecte |
| `Backups: every 24 h, first in 10 min … bucket nordla-backups` | `NOT scheduled` = phrase de passe ou bucket manquant |
| aucun secret, mot de passe ou adresse de base visible | arrêt, rotation de la clé concernée |
Échec du healthcheck : le déploiement est marqué en échec, aucun autre service n'est touché ; lire la première ligne d'erreur.

## 8. Sauvegarde distante (I)
+10 min : journal `Backup OK: … copied off-server as sourcing-<date>.nsb` ; I vérifie l'objet dans `nordla-backups` (métadonnées) ;
`GET /healthz/backup` → `OK`. Échec : `Backup FAILED (<code>)`, nouvel essai automatique 1 h plus tard ; `/healthz/backup` passe à
`FAILING` après deux échecs. Staging n'est **pas** opérationnel tant que ce point n'est pas vert.

## 9. Restauration indépendante (P autorise, I exécute)
P écrit « run: true restauration autorisé » → I pousse `ops/staging-backup/request.json` `"run": true` → P approuve dans GitHub
(*Review deployments*) → I lit le rapport (archive restaurée sur un runner GitHub, fichiers et journal vérifiés) → I remet `"run": false`.
Échec (clé, phrase de passe, archive illisible) : rien n'est modifié nulle part ; staging reste « non opérationnel » jusqu'à correction.

## 10. Sécurité puis Xiaomi (I, depuis un ordinateur)
`/healthz` 200 · `/api/core/modules` 401 · `http://` → `https://` · en-têtes HSTS / CSP / `X-Frame-Options: DENY` · origine étrangère 403.
Puis `docs/integration/protocole-test-xiaomi.md` (fiche du 18/10). `app.nordla.app` : accord DNS séparé (`domaine-app-nordla-app.md`).

## Chantiers séparés (accords distincts, hors de cette activation)
Coffre Backblaze B2 Object Lock **Compliance** 30 jours (`sauvegarde-isolee-b2.md`, aucun compte créé) · alerte GitHub planifiée
(`staging-backup-monitor.yml`, PR sur `main`).

## Retour arrière
Échec au démarrage : rien à faire (aucun autre service touché) ; corriger la variable et redéployer. Après activation : *Settings* →
*Remove* du déploiement actif (ou 0 instance) — le volume et ses données restent, la base staging n'est pas modifiée par l'activation, la
production n'est jamais concernée. Secret exposé par erreur : le régénérer à la source (Supabase / gestionnaire) et le remplacer.
