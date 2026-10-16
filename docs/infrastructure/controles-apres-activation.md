# Contrôles après activation de `sourcing-staging` (préparés, à lancer seulement après le Deploy autorisé)

**R** = ChatGPT (connecteur Railway, lecture des journaux et de l'état) · **I** = Claude (GitHub, Supabase staging en lecture seule) ·
**P** = propriétaire. Aucun contrôle n'affiche une valeur secrète. Un contrôle rouge = arrêt et diagnostic, rien n'est supprimé.

Avant le Deploy, R note pour **chaque autre service** de l'espace : identifiant et date du dernier déploiement (point de comparaison du C6).

| # | Ce qu'on prouve | Comment | Attendu |
|---|---|---|---|
| C1 | Bon projet Supabase | R : journaux de démarrage du déploiement | `Supabase project check (fvhiammdskpcnfodsnrc): VERIFIED` et `HOSTED for https://app.nordla.app … Supabase project fvhiammdskpcnfodsnrc` |
| C2 | Bon marchand | R : journaux · I : requête de lecture sur staging (ci-dessous, Q1) | `Nordla Core ON for merchant 67646dbb-5e2e-4cd7-aad6-0ab289b068cb` ; Q1 : le marchand de test existe, 1 OWNER ACTIVE, module `sourcing` ACTIVE |
| C3 | Journal Core persistant | R : journaux (`Nordla Core ON`, jamais `JOURNAL_NOT_ON_A_VOLUME`) ; après le test 10 du Xiaomi, R fait **Restart** du service (accord P) ; P rouvre la décision | la décision et sa raison sont toujours là après redémarrage (le journal est sur le volume `/app/data`) |
| C4 | Première sauvegarde hors serveur | R : journaux à +10 min · I : Q2 | `Backup OK: … copied off-server as sourcing-<date>.nsb` ; Q2 : 1 objet `sourcing-*.nsb` dans `nordla-backups` |
| C5 | Restauration indépendante | P écrit l'accord → I met `ops/staging-backup/request.json` à `"run": true` → P approuve *Review deployments* dans GitHub → I lit le rapport → I remet `"run": false` | rapport `ok: true`, `archive` = l'objet du C4, `files` ≥ 1 ; échec = staging **non opérationnel** |
| C6 | Aucun impact ailleurs | R : comparer chaque autre service au relevé d'avant | mêmes identifiants et dates de déploiement ; aucun redémarrage |
| C7 | Aucune fuite | R : rechercher dans les journaux du service les motifs `eyJ`, `sb_secret_`, `sb_publishable_`, `postgres://`, `postgresql://`, `@` suivi de `supabase` · I : même recherche dans le journal GitHub du C5 | **0** résultat (les journaux masquent adresses et e-mails ; les erreurs ne contiennent jamais une clé) |

Tant que `app.nordla.app` n'est pas branché (DNS), l'adresse Railway répond **421** à tout sauf `/healthz` : c'est voulu. Les contrôles
de sécurité HTTP (401 sans session, en-têtes, `/healthz/backup`) se font sur l'adresse servie, après le DNS ou la bascule d'adresse.

Requêtes de lecture (I, outil Supabase, projet `fvhiammdskpcnfodsnrc` uniquement) :
- **Q1** `select (select name from merchants where id='67646dbb-5e2e-4cd7-aad6-0ab289b068cb'), (select count(*) from merchant_members where merchant_id='67646dbb-5e2e-4cd7-aad6-0ab289b068cb' and role='OWNER' and status='ACTIVE'), (select status from module_entitlements where merchant_id='67646dbb-5e2e-4cd7-aad6-0ab289b068cb' and module_code='sourcing');`
- **Q2** `select name, created_at, metadata->>'size' as bytes from storage.objects where bucket_id='nordla-backups' order by created_at desc limit 3;`
- **Q3** (après le test 1 du Xiaomi) `select event_type, created_at from identity_events where merchant_id='67646dbb-5e2e-4cd7-aad6-0ab289b068cb' order by created_at desc limit 5;` → une ouverture de session récente.

Échecs prévus et réponse :
| Signe | Cause | Réponse |
|---|---|---|
| `HOSTED_SUPABASE_KEY_REJECTED` | clé d'un autre projet ou fausse | P remplace la clé (staging) ; R redéploie |
| `HOSTED_MERCHANT_NOT_IN_PROJECT` | mauvais `NORDLA_MERCHANT_ID` | R corrige la variable |
| `HOSTED_*_REQUIRED` | variable absente (nommée) | R ou P l'ajoute |
| `UNVERIFIED_UNREACHABLE` | Supabase injoignable | un seul redémarrage ; sinon arrêt |
| `Nordla Core OFF (JOURNAL_NOT_ON_A_VOLUME)` | volume non monté | arrêt ; R vérifie le montage `/app/data` |
| `Backup FAILED (<code>)` | bucket, clé ou place | nouvel essai automatique 1 h plus tard ; si deux échecs : diagnostic avant tout test |
| C5 rouge | phrase de passe différente entre Railway et GitHub, archive illisible | P ressaisit la phrase côté GitHub ; nouvelle exécution sur accord |
Retour arrière : R retire le déploiement actif (ou 0 instance) ; volume, base staging et production intacts.
