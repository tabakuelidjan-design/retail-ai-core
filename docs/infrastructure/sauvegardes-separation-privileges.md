# Sauvegardes Nordla (Sourcing + Core) — couverture prouvée et séparation des privilèges (proposition)

## 1. Ce qui est couvert (prouvé par test)

L'archive quotidienne (`tools/sourcing-backup.mjs`, planifiée par le serveur) contient **tout le répertoire de données** :

| Donnée | Emplacement | Preuve de restauration |
|---|---|---|
| Dossiers China Sourcing | `cases/` | `test/sourcing-backup-full-restore.test.js` |
| Photos et pièces jointes | `photos/` | idem (octet pour octet, empreinte revérifiée) |
| Journal de décisions Core (chaîné) | `core/decision-journal.jsonl` | idem (chaîne revérifiée au redémarrage) |
| Approbation Branding | `core/brand-approved.json` | `test/core-backup-restore.test.js` (verdicts officiels après restauration) |
| Propositions et décisions Marketing | `core/campaigns.jsonl` | idem |
| Visuels Création + décisions | `core/creations/` (journal + PNG) | idem (PNG octet pour octet) |

Non couvert : rapports Analytics (`/app/data/analytics-reports`, **régénérés** depuis la base) ; données Supabase (identité, Finance) :
sauvegardes Supabase + canal `staging-db-ops`.

Propriétés : chiffrement AES-256-GCM (clé dérivée de `SOURCING_BACKUP_PASSPHRASE`, hors serveur aussi) ; empreinte SHA-256 de chaque
fichier vérifiée avant toute écriture ; un octet modifié = archive refusée ; restauration **uniquement** dans un dossier vide ; 3
copies locales (`SOURCING_BACKUP_KEEP`) ; garde « espace faible » avant écriture ; un échec est journalisé, n'arrête pas le service.

## 2. Le point faible actuel (à corriger avant de compter dessus)

- Les copies locales sont **sur le même volume** Railway : elles ne protègent pas d'une perte du volume.
- La copie hors serveur va dans le bucket Supabase `nordla-backups` avec la **clé `service_role`** que le serveur détient déjà pour
  l'identité. Un serveur compromis pourrait donc aussi **supprimer ou remplacer** ces copies : elles ne sont pas immuables.

## 3. Options sans dépense (à décider)

| Option | Principe | Immuable vis-à-vis du serveur ? | Coût | Effort |
|---|---|---|---|---|
| **A. Récupération par le propriétaire** (recommandée pour le départ) | Chaque semaine, vous téléchargez la dernière archive chiffrée depuis le tableau de bord Supabase (*Storage* → `nordla-backups`) vers votre stockage personnel (Google Drive / disque). Aucun bouton Nordla n'existe pour cela aujourd'hui | Oui : copie hors de portée du serveur | 0 € | faible |
| B. Utilisateur « dépôt seul » | Un compte Supabase Auth dédié, politique Storage `INSERT` seulement sur `nordla-backups` (ni `UPDATE` ni `DELETE`) ; le serveur dépose avec ce compte | **Non** tant que le serveur garde la clé `service_role` (elle contourne les politiques) | 0 € | moyen |
| C. Second fournisseur à verrouillage d'objets | Backblaze B2 (offre gratuite ≤ 10 Go) avec *Object Lock* et une clé « écriture seule » | Oui (rétention verrouillée) | 0 € dans l'offre gratuite ; **nouveau compte = votre accord** | moyen |

Recommandation : **A** avant le 20 octobre (simple, vérifiable par vous), puis **C** après la Chine si vous l'acceptez. B seul ne suffit
pas tant que la clé `service_role` est sur le serveur.

## 4. Restauration (procédure, déjà testée en local et en conteneur)

1. `fetch <archive>` (ou fichier téléchargé) → `verify` : vérifie sans rien écrire.
2. `restore <archive> <dossier-vide>` : refuse un dossier non vide ; vérifie ce qu'il a écrit.
3. L'opérateur bascule le service sur le dossier restauré **après** contrôle ; l'ancien n'est pas supprimé.
Reste à faire : la même restauration **sur Railway réel** après activation (contrôle 7 de `railway-handoff-9e25f1d.md`).
