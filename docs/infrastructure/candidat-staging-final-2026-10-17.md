# Candidat staging final — verrou, CI exacte, compatibilité Stock/Achats, lot Railway, GO / NO-GO (2026-10-17)

Branche : `integration/staging-candidate-final` (poussée, **non fusionnée**), tête du **code** **`ca345f82739271572331daf209ae3f374b4b845d`** (les commits suivants de la branche ne changent que de la documentation) = `claude/nordla-core-p0` `5a57d0b` + fusion de `feature/stock-achats-v1-finalisation` `8e46bfb` (chantier 2, fusion propre, aucun conflit) + 1 commit de correction. Complète `convergence-staging-audit-2026-10-16.md` (dont la section 3 est remplacée par ce qui suit). Aucune variable, aucun secret, aucun déploiement, aucune production touchée.

## 1. Priorité 1 — le verrou de `procurement.json`
**Le correctif de `18acd04` (suppression inconditionnelle du fichier de verrou) n'est pas repris.** Il pouvait, en théorie, retirer le verrou d'un processus encore actif (deux déploiements qui se chevauchent) ; sa justification reposait sur une hypothèse Railway non vérifiée.

Remplacement (`src/procurement/file-store.js`, option `lease`, **désactivée par défaut** : le comportement par numéro de processus du chantier 2 est inchangé) :
- le verrou est un **bail** : son propriétaire en rafraîchit la date de modification toutes les 5 s ; un verrou n'est repris que s'il n'a **pas été rafraîchi depuis 60 s** (propriétaire mort ou gelé) — jamais sur la foi d'un numéro de processus ;
- un verrou récent est **attendu** (jusqu'à 70 s : l'ancien conteneur s'arrête), puis refusé (`STORE_LOCKED`) : un propriétaire vivant ne peut pas être délogé ;
- avant **chaque écriture**, le propriétaire vérifie que le verrou est encore le sien, sinon il refuse d'écrire (`STORE_LOCK_LOST`) : deux écrivains ne peuvent pas valider tous les deux ;
- la reprise ne vise que le fichier jugé périmé (revérifié juste avant un renommage atomique) ;
- arrêt propre : `SIGTERM`/`SIGINT` ferment le magasin et libèrent le bail immédiatement ; `close()` ne supprime jamais un verrou qui n'est pas le sien ;
- activé par `hosted.js` sur un volume Railway (`RAILWAY_VOLUME_MOUNT_PATH`) ou `PROCUREMENT_LOCK_LEASE=1`.

Tests (`test/procurement-file-lease.test.js`, **7/7, répété 3 fois**, vrais processus enfants et vrais fichiers) : reprise après `kill -9` avec conservation des données · **un écrivain vivant n'est jamais délogé** (son verrou n'est ni supprimé ni remplacé, son bail continue d'être rafraîchi) · 4 démarrages simultanés = 1 seul gagnant, 3 refus · verrou perdu = aucune écriture, et la fermeture ne supprime pas le verrou d'autrui · arrêt propre sans attente · sans bail : comportement d'origine inchangé · montage hébergé complet.

Preuves en **conteneur** (image construite depuis le commit exact, volume Docker, secrets factices ; horodatages des journaux du conteneur) :
| Scénario | Résultat |
|---|---|
| démarrage à vide | `Stock / Achats ON`, en 2–3 s, uid 1000, `/healthz` 200 |
| `docker stop` (SIGTERM) | arrêt en 2 s, **verrou libéré** (le volume ne contient plus que `procurement.json`) ; redémarrage : ON, fichier de données identique (md5 inchangé), marqueur du volume conservé |
| crash (`kill -9`, verrou laissé) puis nouveau conteneur | `Stock / Achats ON` ≈ 51 s après le démarrage (bail expiré), **données identiques** (md5) |
| **second conteneur vivant sur le même volume** | `NOT mounted (STORE_LOCKED … held by a live writer, refreshed 5 s ago)` après 70 s ; le premier reste ON, son fichier et son verrou intacts |
| fuite de secret dans les journaux | 0 |
Conséquence à connaître : après un **plantage** (pas un arrêt propre) le démarrage peut attendre jusqu'à ≈ 60–70 s avant d'ouvrir Achats ; le serveur n'écoute qu'ensuite. C'est sous le délai du healthcheck (120 s), mais c'est la marge.
Note de méthode : le minuteur de mon script de test affichait 230–260 s ; les horodatages des journaux du conteneur (autoritaires) donnent les durées ci-dessus. Le démarrage à vide de l'image prend 2–3 s.
Limite : le bail protège contre deux écrivains **sur le même volume**. Un volume n'étant pas partagé entre services, le risque restant est un double déploiement du même service ; c'est ce que le bail empêche.

## 2. Priorité 2 — CI exacte (aucun résultat de `5a57d0b` n'est repris)
SHA **`ca345f8`** (API GitHub, `head_sha`) : `nordla-integration-pre-china` run 38974881389 **success** — `full suite (node 24)` success, `full suite (node 20)` success · `Activation & Channel Execution V1` 38974881425 success · `Provider Provisioning & Live Connections V1` 38974881472 success (c'est le workflow `npm test` rouge de l'audit précédent : **vert** sur ce SHA).
**Non déclenchés** par le nom de cette branche : `core-reliability` et `china-sourcing` (uniquement sur `claude/nordla-core-p0`, `feature/china-sourcing-**` ou lancement manuel) et `procurement-stock-v1` (branches `feature/stock-achat*`). Ils tourneront sur le commit de fusion dans core-p0 ; à lancer manuellement sur ce SHA si vous préférez les avoir avant la fusion (je n'ai pas de jeton GitHub pour déclencher un workflow).
Local (Windows) sur la ligne finale : procurement + parcours + routage + intégration + modules = 169 tests, 149 réussis, 19 ignorés (PostgreSQL / Node 24-only), **1 échec** : `Création without a provider` (`ECONNRESET`, déjà en échec sur la base d'origine sur cette machine, passe en CI Linux).

## 3. Priorité 3 — compatibilité avec la dernière livraison Stock/Achats (`8e46bfb`)
- Fusion dans la ligne du candidat : **propre**, aucun conflit (leur base `2c8871d` est ancêtre de core-p0) ; rien de leur travail n'est écrasé.
- `hosted.js` : leur version (rôles + `PROCUREMENT_GRANTS`, politique `SERVER_POLICY`, PostgreSQL optionnel jamais en repli) est **conservée** ; mes ajouts : bail, libération sur signal, `close()` du fichier, message d'échec détaillé. Leurs tests `procurement-hosted`, `procurement-server-v1`, `procurement-stock-requests`, `procurement-assistant-contract` passent.
- Patch n° 2 de leur transmission (une ligne dans `src/sourcing/server/app.js` : écrans Stock/Achats servis sur `/procurement/`) : **appliqué** ; `test/procurement-mounted-ui.test.js` (qui l'attendait) passe, ainsi que `sourcing-hosted-identity` (8/8).
- Non appliqués (décisions du propriétaire) : patch `pg` (inutile tant que le fichier sert de stockage), scission de la migration d'A, migrations Stock/Achats.
- Le contrat des outils lus par Parle à Nordla est inchangé (`procurement-assistant-contract`).

## 4. Priorité 4 — les 29 changements Railway en attente (rien n'est appliqué)
**Limite** : le lot en attente de `sourcing-staging` n'est lisible ni par la CLI ni par l'API que j'ai ; la liste ligne à ligne vient de l'audit de la session Railway (`railway-changeset-audit.md` : 29 lignes, 26 création du service, 3 volume, 0 hors périmètre). Je les classe par nature, sans prétendre avoir relu les 29 lignes dans Railway. Pour une vérification réelle : export du tableau par la session Railway, ou `railway setup agent` (outillage Railway que la CLI signale comme absent).
| Classe | Éléments | Verdict |
|---|---|---|
| **Nécessaires** | création du service ; dépôt `retail-ai-core` ; Dockerfile `deploy/sourcing/Dockerfile` ; commande `/app/docker-entrypoint.sh node src/service-start.js` ; healthcheck `/healthz` ; 1 réplique ; mise en veille désactivée ; région ; volume 1 Go `sourcing-staging-data` monté sur `/app/data` ; variables listées dans `ops/railway-staging/staged-corrections.json` | à garder |
| **Obsolètes (à remplacer avant tout Deploy)** | commit épinglé `c2c314d` (et `ab02b77` du fichier de corrections) → le SHA du candidat finalement fusionné ; toute valeur `NORDLA_MERCHANT_ID` de production (`36b1a1a7-…`) → `67646dbb-5e2e-4cd7-aad6-0ab289b068cb` | **à corriger** |
| **Risqués** | (1) « Deploy » applique **tout** le lot d'un coup ; (2) **fichier de configuration** : le `railway.json` racine (commande sans entrée Docker, pas de Dockerfile) prend le pas sur les réglages du tableau de bord ; il faut « Config as code » = `deploy/sourcing/railway.json` (PR #18) **dans le lot** — à constater ; sinon service en root (`uid 0` = NO-GO) ; (3) **déploiement automatique** : si le service suit la branche `claude/nordla-core-p0`, chaque poussée d'un chantier redéploie staging sans contrôle → désactiver / épingler ; (4) bail : un plantage retarde l'ouverture d'Achats jusqu'à ≈ 70 s (healthcheck 120 s) ; (5) volume 1 Go : données + 3 sauvegardes locales ; la garde de place existe | à traiter avant activation |
| **Bloquants** | secrets absents (clés Supabase staging, deux clés de 32 octets, phrase de sauvegarde) — **saisis par vous** ; `SOURCING_PUBLIC_ORIGIN` connue seulement après génération du domaine (donc un second déploiement) ; secrets GitHub `supabase-staging` pour la restauration indépendante ; DNS `app.nordla.app` non autorisé | à obtenir |
Interdits à retirer s'ils apparaissent (inchangé) : tout autre service, variable partagée, suppression, domaine, environnement `production`, valeur contenant `xbtzjabbseclmqfozjeo`. Ne pas définir : `PROCUREMENT_USERS`, `PROCUREMENT_PG_URL`, `SOURCING_CASES_DIR`, `ANTHROPIC_API_KEY`, `SOURCING_TOKEN`.

## 5. Rollback
1. Service : redéployer le commit précédent (`ab02b77`) ou mettre à 0 instance ; variables inchangées.
2. Données : `procurement/` est additif (l'ancienne version l'ignore) ; volume, base staging et production intacts ; le bail n'écrit qu'un fichier `procurement.json.lock` (supprimable sans effet une fois le service arrêté).
3. Code : supprimer `integration/staging-candidate-final` ; core-p0 n'est pas touchée tant qu'il n'y a pas d'accord.
4. Sauvegarde chiffrée de staging : artefact conservé jusqu'au 14/11, restauration prouvée.

## 6. Verdict
- **Code du candidat : GO.** Fusion propre du chantier 2, verrou sécurisé et prouvé (tests + conteneur), CI exacte verte (Node 20 + 24 + 2 workflows), image qui démarre en 2–3 s, uid 1000, aucun secret dans les journaux, redémarrage / plantage / démarrage concurrent traités sans perte.
- **Activation de `sourcing-staging` : NO-GO tant que** (dans cet ordre) : (a) vous autorisez la fusion de `integration/staging-candidate-final` dans `claude/nordla-core-p0` (nouveau SHA, puis `core-reliability` + `china-sourcing` verts sur ce SHA) ; (b) le lot Railway est re-trié avec les lignes obsolètes remplacées et « Config as code » + déploiement automatique contrôlés ; (c) vous saisissez les secrets ; (d) vous autorisez le déploiement (puis les contrôles C1–C12 de `controles-apres-activation.md`).
- Réserves ouvertes : `nordla-entry.e2e` intermittent en local ; 8 migrations du dépôt non appliquées sur Supabase staging (sans effet sur Sourcing/Core/Achats, réponses Finance possiblement « données indisponibles ») ; PR #17 (Chantier E) non intégrée ; la sortie de crash (≈ 70 s) est la marge la plus fine du healthcheck.
