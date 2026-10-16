# Sauvegarde isolée et immuable (Backblaze B2, Object Lock) — préparée, NON activée

But : une copie des sauvegardes que **ni le serveur, ni la clé de service Supabase, ni une personne ayant volé l'un ou l'autre** ne peut
effacer ou modifier. Le bucket Supabase `nordla-backups` reste la copie hors serveur courante ; il n'est pas immuable (la clé de service
peut y supprimer).

## Principe (code prêt et testé : `tools/sourcing-backup.mjs`, `test/sourcing-backup-isolated.test.js`)

| Élément | Réglage | Effet |
|---|---|---|
| Bucket B2 privé, **Object Lock activé à la création** | rétention **par défaut** en mode **compliance**, 30 jours | chaque archive déposée est verrouillée 30 jours ; en mode compliance **personne** (même le titulaire du compte) ne peut la supprimer ni raccourcir le verrou avant la date |
| Clé du **serveur** (Railway) | **une seule** capacité : `writeFiles`, limitée à ce bucket | le serveur ajoute des archives ; il ne peut ni lister, ni lire, ni supprimer, ni toucher aux verrous. **Vérifié à chaque envoi** : une clé plus puissante est refusée (`ISOLATED_KEY_TOO_POWERFUL`) et rien n'est envoyé |
| Clé de **contrôle** (GitHub uniquement) | `listFiles`, `readFiles`, `readFileRetentions`, limitée à ce bucket | la restauration indépendante (`staging-backup-drill`) télécharge la dernière archive, la restaure et **vérifie qu'elle est sous verrou compliance** ; sinon le contrôle échoue |
| Archives | chiffrées (AES-256-GCM) **avant** de quitter le serveur | B2 ne voit jamais les données en clair |

Un serveur compromis peut au pire **ajouter** des fichiers (coût de stockage) ; il ne peut pas détruire l'historique verrouillé.

## Coût

Stockage B2 : environ 6 USD par To et par mois ; les 10 premiers Go sont gratuits. Les archives staging pèsent quelques Mo : **0 USD
attendu**. Création d'un compte Backblaze = **décision du propriétaire** (nouveau fournisseur).

## Mise en place (propriétaire, rien dans un chat)

1. Backblaze → créer le compte (ou utiliser l'existant).
2. *Buckets* → *Create a Bucket* : nom par ex. `nordla-staging-backups-locked`, **Private**, **Object Lock : Enable** (impossible à ajouter
   plus tard), puis *Object Lock* → *Default retention* : **Compliance**, **30 jours**.
3. *Application Keys* → *Add a New Application Key* (clé du **serveur**) : accès **à ce seul bucket**, type **Write Only** (seule capacité
   `writeFiles`) ; noter l'identifiant et la clé (affichée une seule fois).
4. Deuxième clé (**contrôle**) : ce seul bucket, **Read Only** + capacité de lecture des rétentions si l'interface la propose.
5. Railway, `sourcing-staging` : `SOURCING_BACKUP_B2_KEY_ID`, `SOURCING_BACKUP_B2_KEY` (clé serveur, secrète), `SOURCING_BACKUP_B2_BUCKET_ID`.
6. GitHub, environnement `supabase-staging` : secrets `STAGING_B2_READ_KEY_ID`, `STAGING_B2_READ_KEY` ; variables `STAGING_B2_BUCKET_ID`,
   `STAGING_B2_BUCKET_NAME`.
7. Au démarrage, le journal du service indique « isolated immutable copy ON » ; après la première sauvegarde : « Backup OK … and to the
   isolated immutable store ». Puis la restauration indépendante (`run: true`, approbation) prouve la restauration **et** le verrou.

## Limites honnêtes

- Le format exact des en-têtes d'envoi B2 n'a pas pu être relu sur la documentation officielle depuis la session de travail (site
  inaccessible) ; il est validé par le **premier envoi réel** et par le contrôle `drill-isolated` (qui échoue sinon).
- 30 jours de verrou = une archive ne peut pas être supprimée avant 30 jours, même par erreur ou pour libérer de la place : c'est voulu.
- Le premier envoi B2 qui échoue fait échouer l'exécution de sauvegarde : nouvel essai 1 h plus tard, alerte si l'échec persiste.
