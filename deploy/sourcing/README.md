# China Sourcing hébergé (sans PC Windows) — préparé, pas déployé

Rien n'a été créé : ni compte, ni serveur, ni domaine, ni dépense. Ce dossier contient tout ce qu'il faut pour le faire **après** les
décisions du propriétaire (hébergeur, budget, domaine). Plan complet : `docs/infrastructure/nordla-cloud-plan.md`.

```
Téléphone (PWA) ──HTTPS──> Caddy : certificat TLS du domaine + mot de passe du propriétaire
                                └─ réseau privé ─> sourcing (Node 24, SOURCING_HOSTED=1) : jeton applicatif sur chaque /api
                                                    └─ volume sourcing-data (dossiers, cache Safety Gate)
Sauvegarde : docker compose run --rm backup  ->  ./backups/sourcing-<date>.nsb (chiffré, vérifié à l'écriture)
```

## Ce qui a été vérifié (localement, sans Internet)

- `docker compose config` valide ; `caddy validate` (2.8.4) valide.
- Chaîne réelle Caddy → serveur en mode hébergé : manifeste et icônes publics ; application et API refusées sans mot de passe (401) ;
  API refusée avec le mot de passe mais sans jeton (401) ; acceptée avec les deux (200) ; un autre nom d'hôte est refusé (421).
- Le serveur refuse de démarrer si la configuration est incomplète (`HOSTED_TOKEN_REQUIRED`, `HOSTED_ALLOWED_HOSTS_REQUIRED`,
  `HOSTED_ALLOWED_HOSTS_INVALID`, `HOSTED_MERCHANT_REQUIRED`) et n'écrit jamais de fichier de jeton.
- Sauvegarde → vérification → restauration octet pour octet ; mauvaise phrase secrète ou archive modifiée refusées ; la restauration
  n'écrase jamais (`test/sourcing-hosted-backup.test.js`).

**Pas encore vérifié** (nécessite le vrai serveur et le Xiaomi) : certificat Let's Encrypt réel, installation de la PWA derrière le mot de
passe sur Android, fonctionnement hors ligne après installation, accès depuis la Chine.

## Mise en route (Hetzner, recommandé) — après accord

1. Créer le VPS (UE), clé SSH uniquement, pare-feu : 22 (IP du propriétaire), 80, 443.
2. Installer Docker ; cloner ce dépôt sur la branche validée.
3. Pointer le domaine (enregistrement A/AAAA) vers le VPS.
4. `cp deploy/sourcing/.env.example deploy/sourcing/.env` puis remplir (jeton aléatoire, hash du mot de passe, phrase de sauvegarde).
5. `cd deploy/sourcing && docker compose up -d --build`
6. Sur le Xiaomi : ouvrir `https://<domaine>/`, se connecter (mot de passe), saisir le jeton une fois, « Ajouter à l'écran d'accueil ».
7. Sauvegarde quotidienne (cron de l'hôte) :
   `15 3 * * * cd /srv/retail-ai-core/deploy/sourcing && docker compose run --rm backup >> backups/backup.log 2>&1`
   puis copie hors serveur (compte de stockage séparé, rétention immuable) — décision propriétaire.
8. **Test de restauration avant usage réel** :
   `docker compose run --rm --entrypoint node -v $PWD/restore-test:/restore backup tools/sourcing-backup.mjs restore /backups/<fichier>.nsb /restore/data`

Railway reste possible (service Docker + volume), mais Railway ne place pas Caddy devant : il faudrait un autre premier niveau
d'authentification (par exemple Cloudflare Access). C'est une raison de plus de préférer Hetzner pour ce module.

## Migration des données du PC Windows

Copier, jamais déplacer : arrêter `sourcing:phone`, faire une sauvegarde du dossier `data/local/sourcing` du PC avec
`node tools/sourcing-backup.mjs backup data/local/sourcing <dossier>` (Node 24), la vérifier, la restaurer dans le volume du serveur,
comparer, puis seulement basculer le téléphone. Le PC garde sa copie au moins 30 jours.
