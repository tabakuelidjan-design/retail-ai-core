# Fiabilité du journal de décisions du Core

Mandat du 2026-10-15 (défauts P1 à P7 de la revue de `eb73dc3`). Branche `claude/nordla-core-reliability`. Principe : **durcir maintenant, converger après le voyage**.
Architecture inchangée : `core-pilot` = façade, `SocleStore` = seule autorité de décision, `src/integration` = contrats et politiques, les modules métier gardent leurs données.

## 1. Ce que le code garantit

| Garantie | Mécanisme | Où |
|---|---|---|
| Une décision n'est enregistrée qu'**une fois** (P1, P6, P7) | validation → écriture durable → application sont **une seule opération** dans une file par runtime ; `decideHuman`, `recordResult`, `analyseCase` ; pour les campagnes et créations, le contrôle d'état et l'ajout sont une opération sous verrou de fichier | `runtime.js` (`serial`, `commit`), `campaign.js` / `creation.js` (`mutate`) |
| On n'annonce « enregistré » que si c'est **sur le disque** (P2) | `append` ne se résout qu'après écriture complète puis `datasync` sur le même descripteur ; sinon il **rejette** (HTTP 503) | `journal.js`, `durable-file.js` |
| Après un échec d'écriture, **plus aucune écriture** (P2) | état `PROTECTED` : `JOURNAL_PROTECTED` jusqu'à vérification et redémarrage contrôlé ; fichier laissé tel quel ; preuve dans `<journal>.faults.jsonl` (code, cause, séquence, tailles) | `journal.js` |
| Une tête périmée n'est **jamais** prolongée (multi-processus) | sous le verrou, la taille du fichier doit être celle que ce processus a écrite en dernier, sinon `JOURNAL_STALE` + protection | `journal.js` |
| Diagnostic exact d'un fichier abîmé (P3) | `JOURNAL_TORN_TAIL` (dernière ligne sans saut de ligne, tout ce qui précède se vérifie) ; `JOURNAL_CORRUPT` avec `diagnostic` = `CORRUPT_MIDDLE`, `CORRUPT_LAST_LINE`, `CHAIN_BROKEN`, `SEQUENCE`, `WRONG_MERCHANT` ; `line`, `offset`, `valid_events` | `journal.js` (`inspectJournalText`) |
| Aucune réparation automatique | le Core ne tronque, ne répare et ne supprime jamais ; la reprise est une procédure humaine sur copie (§4) | `journal-recovery.js`, `tools/core-journal-recover.mjs` |
| Windows et Linux (P4) | écriture en mode ajout (`'a'`) et `datasync` sur ce descripteur ; sur Windows un descripteur en lecture seule donnait `EPERM` | `durable-file.js` |
| Un historique illisible n'est **jamais** « vide » (P5) | seul `ENOENT` = historique vide ; sinon `CAMPAIGN_JOURNAL_*` / `CREATION_JOURNAL_*` (`UNREADABLE`, `TORN_TAIL`, `CORRUPT`) avec la ligne ; aucun ajout après une ligne abîmée | `durable-file.js` (`readJsonlStrict`) |
| Un journal hors volume est refusé sur Railway | `checkJournalDeployment` : le dossier de données doit être dans `RAILWAY_VOLUME_MOUNT_PATH` | `deployment-guard.js`, `src/sourcing/server/index.js` |

## 2. Ce que le code ne garantit PAS (limites)

1. **Un seul écrivain n'est pas imposé par le noyau.** Le verrou (`<journal>.lock`, création exclusive) est **coopératif** et à **bail** : il sérialise les processus qui l'utilisent ; un verrou laissé par un processus tué est repris après 15 s. Un écrivain qui l'ignore, ou une reprise de verrou pendant qu'un écrivain très lent est encore actif, laisse une **fenêtre** ; elle est alors **détectée** (taille attendue ≠ taille réelle → `JOURNAL_STALE`, protection) mais pas empêchée.
2. **Ce que Railway apporte (documenté)** : « *Replicas cannot be used with volumes* » ; un service ne peut pas avoir plusieurs déploiements actifs montés ; un redéploiement avec volume coupe brièvement le service. Un service Railway a donc **un seul écrivain**. Non documenté : qu'**un autre service** ne puisse pas monter les mêmes fichiers. Ne jamais attacher le volume ou copier le dossier `core/` dans un second service qui écrit.
3. **Un événement dont la durabilité est incertaine** (écrit, mais `datasync` ou la taille a échoué) est refusé à l'appelant (jamais « enregistré ») **mais peut exister sur le disque** : après redémarrage il est rejoué. L'interface doit demander au propriétaire de **vérifier avant de recommencer** ; une nouvelle tentative donne `ALREADY_DECIDED` (409), jamais un doublon.
4. `datasync` est une garantie du système de fichiers et du matériel ; aucun test ne peut la prouver sur un disque réel.
5. Les journaux de campagnes et de créations n'ont ni chaîne de hachage ni séquence : ils détectent les lignes abîmées et refusent d'écrire après elles, ils ne détectent pas une ligne **supprimée proprement**. Convergence après le voyage.

## 3. Contrat d'événements (compatibilité)

- **Format inchangé** : `{ seq, at, merchant_id, kind, actor, payload, prev, hash }`, une ligne JSON par événement. Les journaux écrits par le code d'origine (`f721e49`) se relisent à l'identique (test `compat`, journal de référence produit par l'ancien code, `test/fixtures/core-journal-v1/`).
- Le hachage couvre `seq, at, merchant_id, kind, actor, payload, prev`. **Tout champ ajouté à l'enveloppe ne serait pas protégé** : un nouveau champ va dans `payload` (avec un `payload.v` de version si nécessaire).
- `applyEvent` refuse un `kind` inconnu (`JOURNAL_UNKNOWN_EVENT`) : un journal contenant de **nouveaux** types d'événements ne se relit pas avec une **ancienne** version du Core (retour arrière). **Aucun nouveau type d'événement n'est introduit dans ce mandat.** Avant d'en ajouter (traces inter-modules, `TRACE.*`), décider d'une politique « type inconnu vérifié dans la chaîne mais sans effet sur l'état » **et** la livrer dans le code d'abord, avant d'écrire le premier événement de ce type.
- Une migration future vers Supabase se fait par **rejeu** du JSONL (même ordre, mêmes hachages) : aucun champ de ce mandat n'y fait obstacle.

## 4. Reprise d'un journal dont la dernière ligne est tronquée

Symptôme : le Core est « OFF » avec `JOURNAL_TORN_TAIL`. **Le fichier n'a pas été touché.** Service **arrêté** :

```bash
node tools/core-journal-recover.mjs diagnose <journal.jsonl> <merchantId>
node tools/core-journal-recover.mjs prepare  <journal.jsonl> <merchantId> <nouveauDossier>
node tools/core-journal-recover.mjs verify   <nouveauDossier> <merchantId>      # affiche le code de confirmation
node tools/core-journal-recover.mjs apply    <journal.jsonl> <nouveauDossier> <merchantId> --confirm <code>
```

`prepare` copie l'original octet pour octet, met la fin tronquée en quarantaine, écrit un journal candidat **entièrement vérifié** et un `manifest.json` (empreintes, événements conservés, code de confirmation). `apply` exige le code, refuse si le journal vivant a changé depuis `prepare` ou si un verrou récent existe, garde une copie (`<journal>.replaced-<heure>`), puis remplace par **un seul renommage atomique**. La décision éventuellement perdue dans l'écriture tronquée doit être **redemandée au propriétaire**. Toute autre corruption (ligne au milieu, chaîne brisée, autre marchand) n'est **pas** préparée automatiquement : enquête humaine, sur une copie.

## 5. Sauvegardes (voir aussi `docs/infrastructure/`)

- `tools/sourcing-backup.mjs` **vérifie le journal dans l'archive** (chaîne, ordre, marchand) à la sauvegarde, à `verify` et avant toute restauration.
- Une sauvegarde prise pendant une écriture peut contenir une dernière ligne coupée : **la copie** (jamais le fichier vivant) est ramenée au dernier événement complet, et la coupure est consignée dans l'archive (`adjustments`).
- Un journal incohérent dans l'archive : l'archive est quand même créée (dossiers et photos protégés) mais `restorable: false`, `verify` répond `ok: false`, `restore` refuse **avant d'écrire** (`RESTORE_JOURNAL_INCONSISTENT`) ; `allowInconsistentJournal` existe pour une enquête et le dit.
- Les fichiers `*.lock` ne sont pas des données (ignorés) ; `*.faults.jsonl` (preuves) sont sauvegardés.
- **Railway** : le volume n'est pas une sauvegarde. Railway rattache un volume à **un** service (« Each service can only have a single volume ») et ne documente aucun montage partagé : la sauvegarde s'exécute **dans le même service** (déjà le cas : sauvegarde quotidienne du serveur). Une copie hors serveur et un essai de restauration restent la condition d'une vraie sauvegarde.

## 6. Reporté après le voyage

Journal unique et durable en base (événements append-only, rejeu du JSONL) ; chaîne et séquence pour les journaux de campagnes et de créations ; clés d'idempotence côté HTTP ; écriture des traces inter-modules dans le journal (ou retrait du ledger du hub, inactif en production) ; tests de volume et de rejeu ; politique « type d'événement inconnu » avant tout nouveau type.
