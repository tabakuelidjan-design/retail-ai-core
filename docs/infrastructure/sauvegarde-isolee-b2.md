# Sauvegarde isolée et immuable (Backblaze B2, Object Lock) — préparée, NON créée

But : une copie des sauvegardes que **ni le serveur, ni la clé de service Supabase, ni quelqu'un qui les aurait volés** ne peut effacer
ou modifier. Le bucket Supabase `nordla-backups` reste la copie hors serveur courante ; il n'est pas immuable (la clé de service peut y
supprimer). Code prêt et testé : `tools/sourcing-backup.mjs` (copie isolée + `drill-isolated`), `test/sourcing-backup-isolated.test.js`.

## Principe

| Élément | Réglage | Effet |
|---|---|---|
| Bucket B2 **privé**, Object Lock **activé**, rétention **par défaut** en mode **Compliance**, **30 jours** | réglé par le propriétaire | chaque archive **déposée après** ce réglage est verrouillée 30 jours ; en mode Compliance personne (titulaire du compte compris) ne peut supprimer une version verrouillée ni raccourcir son verrou |
| Clé du **serveur** (Railway) : type console **Write Only**, limitée à ce bucket | capacités `writeFiles` (+ `listBuckets`, `listAllBucketNames` que la console ajoute : métadonnées de bucket seulement) | le serveur **ajoute** des archives. **Vérifié à chaque envoi** : toute autre capacité (`deleteFiles`, `readFiles`, `listFiles`, `*Retentions`, `bypassGovernance`…) → envoi refusé (`ISOLATED_KEY_TOO_POWERFUL`) |
| Clé de **contrôle** (GitHub uniquement, jamais sur le serveur) : limitée à ce bucket | `listFiles`, `readFiles`, **`readFileRetentions`** | la restauration indépendante lit **toutes les versions** (masquées comprises), télécharge la plus récente **par identifiant**, la restaure, **vérifie son verrou Compliance** et échoue si une archive a été masquée |
| Archives | chiffrées (AES-256-GCM) **avant** de quitter le serveur | B2 ne voit jamais les données en clair |

Ce qu'un serveur compromis peut encore faire avec `writeFiles` : **ajouter** des fichiers (coût) et **masquer** un nom de fichier (marqueur
« hide ») — sans effacer la version verrouillée. Le contrôle lit les versions, retrouve l'archive et **signale** le masquage.

## Corrections par rapport à la version précédente de cette fiche

- Object Lock **peut** être activé sur un bucket **existant** (irréversible) ; il ne protège **pas** les fichiers déjà présents : l'activer
  **avant** le premier envoi.
- La clé « Write Only » de la console contient aussi `listBuckets` et `listAllBucketNames` ; le code les accepte désormais (il les refusait).
- Le verrou se lit avec la capacité `readFileRetentions` : si la clé de contrôle ne l'a pas, le contrôle échoue avec
  `ISOLATED_RETENTION_UNREADABLE` (le verrou n'est jamais supposé).

## Coût

Stockage B2 : environ 6 USD par To et par mois, 10 premiers Go gratuits ; les archives staging pèsent quelques Mo : **0 USD attendu**.
Les versions verrouillées ne peuvent pas être supprimées avant 30 jours (voulu).

## Mise en place (propriétaire ; rien dans un chat)

1. Créer le compte Backblaze (décision : nouveau fournisseur).
2. *Buckets* → *Create a Bucket* : `nordla-staging-backups-locked` (ou autre nom), **Private**, **Object Lock : Enable** ; puis *Object Lock*
   → *Default Retention Policy* : **Compliance**, **30 jours**. Noter l'**identifiant du bucket** (Bucket ID).
3. *Application Keys* → *Add a New Application Key* — clé **serveur** : *Allow access to* = ce bucket, *Type of Access* = **Write Only**.
4. Clé **contrôle** : ce bucket, **Read Only**. Si l'interface ne propose pas `readFileRetentions`, la créer avec l'outil en ligne de
   commande B2 (`b2 key create --bucket <nom> <nom-de-clé> listFiles,readFiles,readFileRetentions`) ; sans elle le contrôle échoue (voulu).
5. Railway (`sourcing-staging`) : `SOURCING_BACKUP_B2_KEY_ID`, `SOURCING_BACKUP_B2_KEY` (clé serveur), `SOURCING_BACKUP_B2_BUCKET_ID`.
6. GitHub, environnement `supabase-staging` : secrets `STAGING_B2_READ_KEY_ID`, `STAGING_B2_READ_KEY` (clé contrôle) ; variable
   `STAGING_B2_BUCKET_ID`.
7. Contrôles : journal « isolated immutable copy ON » au démarrage ; « Backup OK … and to the isolated immutable store » après la
   première sauvegarde ; puis la restauration indépendante (`staging-backup-drill`) : `retention.locked_now = true`, `hidden_markers = 0`.

## Limites honnêtes

- La documentation officielle B2 n'a pas pu être lue directement depuis la session (site inaccessible) ; les noms d'API viennent des pages
  Backblaze vues par recherche. Le **premier envoi réel** et le contrôle `drill-isolated` les valident ; un écart fait échouer la
  sauvegarde (alerte) ou le contrôle, jamais en silence.
- Un premier envoi B2 en échec fait échouer l'exécution de sauvegarde (nouvel essai 1 h plus tard, alerte si l'échec persiste) : activer
  B2 **après** que la sauvegarde Supabase a été vue réussie, pour isoler un éventuel problème.
