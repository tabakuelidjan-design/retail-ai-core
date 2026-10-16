# Commit candidat unique pour le test Xiaomi du 18 octobre — définition, vérifications, déploiement contrôlé (préparé, **rien n'est déployé**)

## 1. Définition du candidat (une seule, reproductible)
| Élément | Valeur |
|---|---|
| Contenu | la convergence validée : `claude/nordla-core-p0` (PR #11, #12, #13, #14) + chantier C (Stock/Achats, `b3d4161`) + PR #15 (Parle à Nordla × Stock/Achats) |
| Où il est aujourd'hui | `integration/nordla-convergence-v1` @ `4fd4c2d` (fusion de #15), **pas dans `claude/nordla-core-p0`** |
| Pour devenir déployable | **votre autorisation** de fusionner la convergence dans `claude/nordla-core-p0` (la branche que déploie `sourcing-staging`) ; le commit de fusion devient *le* candidat ; sa CI complète (china-sourcing, nordla-integration-pre-china, core-reliability Linux + Windows) doit être verte **sur ce commit** |
| Commit actuellement prévu | `ab02b77` : **ne contient pas** l'assistant de terrain ni Stock/Achats montés ; ne pas tester Parle à Nordla dessus |
| Vérification reproductible | `node docs/integration/xiaomi/verify-candidate.mjs --baseline ab02b77` (arbre propre, sur le commit exact) : variables d'environnement nouvelles, syntaxe, 19 fichiers de tests (contrats, sécurité, routage, conversation, confidentialité, Achats), graine TEST idempotente, 4 scénarios navigateur dont la répétition du 18 |

## 2. Variables d'environnement et connexions
- **Aucune variable obligatoire nouvelle pour le chemin hébergé.** Nouvelles variables lues par le code depuis `ab02b77` : `PROCUREMENT_ALLOWED_HOSTS, PROCUREMENT_DATA_DIR, PROCUREMENT_DEV, PROCUREMENT_HOST, PROCUREMENT_PG_URL, PROCUREMENT_PORT, PROCUREMENT_USERS` (serveur Achats **autonome**, non utilisé quand Achats est monté sur le serveur Nordla) et `SOURCING_CASES_DIR, SOURCING_PHOTOS_DIR` (déjà dérivées du dossier de données). Ne **pas** les définir sur `sourcing-staging`.
- Stock/Achats hébergé : magasin **fichier** sous `<SOURCING_DATA_DIR>/procurement/procurement.json` (le volume `/app/data` déjà sauvegardé) ; si le magasin ne s'ouvre pas, Nordla démarre sans Achats et l'indique (« Stock / Achats OFF »).
- Variables de la procédure existante inchangées : `SOURCING_HOSTED`, `NORDLA_MERCHANT_ID`, `SOURCING_PUBLIC_ORIGIN`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_ANON_KEY`, `NORDLA_IDENTITY_RATE_LIMIT_KEY`, `NORDLA_CSRF_KEY`, `NORDLA_SUPABASE_PROJECT_REF`, `SOURCING_DATA_DIR`, sauvegarde… (voir `procedure-activation-staging.md`).
- Authentification et droits : l'identité vient de la session serveur (jamais de la requête) ; rôles → Achats : OWNER→OWNER (seul à approuver), ADMIN→BUYER, COLLABORATOR→WAREHOUSE, VIEWER/ACCOUNTANT→VIEWER ; Parle à Nordla n'affiche conditions et fiabilité d'un fournisseur qu'à OWNER/ADMIN. Testé : `core-procurement-routing`, `convergence-journey`, répétition navigateur.

## 3. Migrations — **aucune pour ce candidat**
- Le candidat n'utilise **pas** PostgreSQL pour Stock/Achats (magasin fichier). Les migrations préparées par le chantier C (`supabase/migrations-pending/20261016090000_procurement_stock.sql` et `…091000_procurement_permissions.sql`) **ne doivent pas être appliquées** pour le 18.
- Dry-run exécuté (aucun contact base) : `node tools/procurement-staging/run.mjs plan` → liste l'ordre d'application et de retour arrière (`supabase/rollback/…permissions.down.sql` puis `…stock.down.sql`), indique `PROCUREMENT_STAGING_URL : NOT SET`, `PROCUREMENT_OWNER_AUTHORIZATION : NOT SET`. Toute application exigerait l'autorisation du propriétaire et une base non productive (garde-fous du script) ; **non prévue ici**.
- Retour arrière des données : le dossier `procurement/` du volume est **additif** ; l'ancienne version l'ignore ; le supprimer n'est pas nécessaire pour revenir en arrière.

## 4. Procédure de déploiement contrôlée (à exécuter seulement sur votre autorisation explicite)
**R** = ChatGPT (Railway) · **I** = Claude · **P** = propriétaire.
1. **P** autorise : (a) la fusion de la convergence dans `claude/nordla-core-p0` ; (b) le redéploiement de `sourcing-staging` sur le commit de fusion ; (c) l'exécution du script de données TEST (séparément).
2. **I** : fusion ; attendre la CI verte du commit de fusion ; lancer `verify-candidate.mjs` sur ce commit ; fournir le SHA exact à **R**.
3. **R** : relever les identifiants/dates de déploiement des autres services (point de comparaison C6) ; **Deploy** de `sourcing-staging` sur ce SHA ; aucune variable ajoutée.
4. Contrôles C1–C7 (`controles-apres-activation.md`) inchangés, **plus** :
   - **C8** — journaux : `Stock / Achats ON (…/procurement/procurement.json)` (jamais `OFF`) ;
   - **C9** — `GET /api/core/modules` : ligne « Stock / Achats » = `DISPONIBLE` ; Finance / Analytics = `NON RACCORDÉ` si pas de Supabase de données ;
   - **C10** — après la graine TEST : « Mon stock » → articles `TEST-…` ; « Commandes en attente » → 1 bon `PENDING_APPROVAL` ;
   - **C11** — « passe la commande… » → `Action refusée`, aucun changement dans Achats ;
   - **C12** — redémarrage du service : le stock et le bon de test sont toujours là (fichier sur le volume), la conversation est vide.
5. **R** exécute la graine TEST sur le volume (étape séparée, journalisée) ; **P** déroule `scenario-parle-a-nordla-18-octobre.md`.
6. Critère d'arrêt : tout contrôle rouge = arrêt et diagnostic, rien n'est supprimé.

## 5. Retour arrière
1. **R** redéploie le commit précédent (`ab02b77`) ou met le service à 0 instance ; variables inchangées.
2. Volume, base staging et production **intacts** ; `procurement/` reste sur le volume sans effet pour l'ancienne version.
3. Les données de TEST sont étiquetées `[TEST]` / `TEST-…` : elles se distinguent de toute donnée réelle et se suppriment en retirant le dossier `procurement/` **après** accord du propriétaire.

## 6. Ce que le candidat ne contient pas
La voix (aucun essai sur appareil), les données réelles de Finance et d'Analytics (Supabase de données non activé), PostgreSQL pour Stock/Achats, un modèle de langage, un moteur de coût rendu unifié.
