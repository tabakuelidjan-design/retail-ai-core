# Stock / Achats (chantier C) — livraison pour la convergence

Branche : `feature/stock-achat-v1`. Base commune avec `integration/nordla-convergence-v1` : `c4d2e3f` (déjà intégré par la convergence). Ce document ne modifie rien dans la branche de convergence : il liste ce que la convergence peut reprendre, dans l'ordre, et ce qui reste ouvert. Les statuts sont ceux **mesurés**, pas ceux espérés.

## 1. Commits à reprendre (ordre chronologique, tous après `c4d2e3f`)
| # | SHA | Contenu | Fichiers partagés touchés |
|---|---|---|---|
| 1 | `7b5190d` | vues de compatibilité A↔C (plan / attendu dérivés du bon de commande), 2 commandes hub en lecture seule | `src/integration/procurement*.js` (ajoutés par C) |
| 2 | `3a471a1` | écrans téléphone : stock, réception, photos Sourcing sécurisées, état réseau, plausibilité des taux, `case-source` | `src/procurement/server/app.js` (**aussi modifié par la convergence**), `server/index.js` |
| 3 | `a97e3bd` | préparation staging PostgreSQL : migration de permissions + retour arrière, runner gardé, import fichier→PostgreSQL, procédure téléphone, enquête CI | `supabase/migrations-pending/…091000…`, `supabase/rollback/…`, `tools/procurement-staging/` |
| 4 | `56c3166` | comparateur canonique (ordre des clés, null≡absent) pour l'import | `import-file-to-pg.js` |
| 5 | `f3f5f59` | import vérifié (`validateSourceState`, `runImport`), test « pas de double comptage » A/C, textes d'erreur français (`errText` dans `ui/logic.js`) | `ui/app.js`, `ui/logic.js` |
| 6 | `04f6ac3` | preuve PostgreSQL : coexistence avec les migrations de A (deux ordres), redémarrage, sauvegarde/restauration | test uniquement |
Aucun de ces commits ne touche `package.json` (hors scripts déjà repris), `src/integration/{approval,router,index}.js` (déjà dans `c4d2e3f`), ni les fichiers des chantiers A/B.

## 2. Conflits
- **Textuels** : aucun. `git merge-tree` à blanc puis fusion réelle (sans commit) dans une copie jetable de `9ac820e` : 0 conflit. La convergence n'a changé que `server/app.js` (point d'entrée hébergé `handleApi`, paramètre `signedIn`) et ajouté `server/hosted.js` ; depuis (`e08d98d`), seule de la documentation a changé.
- **Sémantiques à connaître** (aucune n'empêche la fusion) :
  1. `hosted.js` ne passe pas de `photosDir` : les miniatures Sourcing affichent le texte honnête « photo sur le téléphone du terrain ». À brancher si le magasin de photos de A est monté côté serveur (`createProcurementApp({ sourcingPhotosDir })`).
  2. `hosted.js` donne `canApprove` au seul propriétaire : un rôle magasin (COLLABORATOR→WAREHOUSE) **ne peut donc pas réceptionner** (la réception exige un approbateur habilité). Décision de politique à prendre par le propriétaire ; rien n'a été changé.
  3. La migration de permissions (`…091000…`) n'est **pas** dans la convergence (qui n'a repris que le schéma `…090000…`). Elle doit arriver avec le schéma : sans elle, les rôles clients ne sont refusés que par RLS et les grants par défaut.
  4. Recouvrement de modèle avec A : voir §3.

## 3. Contrat A / C (pour le responsable de la convergence)
Règle posée par le mandat : **l'ordre d'achat de C est la source de vérité pour les achats ; les propositions et arrivées attendues de A sont dérivées, jamais un second ordre indépendant.**
- `PurchasePlan` (A) = un bon C en `DRAFT | PENDING_APPROVAL` (→ `PLANNED`) ou `APPROVED` (→ `APPROVED_TO_ORDER`). Dès `ORDERED`, ce n'est **plus** un plan.
- `IncomingExpectation` (A) = les lignes encore à recevoir d'un bon `ORDERED | CONFIRMED | PARTIALLY_RECEIVED` ; jamais disponible (`counted_in_available = false`). `received_qty` reste 0 (contrainte de la table de A) ; ce qui est déjà arrivé est exposé dans `procurement_received_qty`. Identifiant : formule de A (hash du `purchase_ref`) pour un bon d'une ligne ; `…#<ligne>` pour plusieurs lignes.
- `purchase_ref = nordla:purchase:<po.id>` ; produit prospect `nordla:product:prospect-<case>` ; `BUY_CANDIDATE` et `sourcing_cases` restent à A (C ne garde que des références).
- **Pas de double comptage — prouvé** (`test/integration-procurement-compat.test.js`, dernier test) : à chaque statut un bon est exactement un des {plan, attendu, rien} ; la somme des attendus = `stockPosition.incoming` ; une fois reçu, le stock est compté une seule fois (en main, plus attendu) ; un bon annulé n'est ni plan ni attendu.
- Les tables `integration_purchase_plans` / `integration_incoming_expectations` de A peuvent **coexister** avec `proc_*` (prouvé, §4) ; si elles sont alimentées, elles doivent l'être **depuis** les vues de C (lecture seule), jamais écrites indépendamment. Tant que personne ne les alimente, rien n'est dupliqué.

## 4. Preuves réellement exécutées (poste Windows, Node 24.19 ; Node 20 via Docker pour la phase 2)
| Quoi | Résultat |
|---|---|
| Suites Stock/Achats + intégration, store mémoire (`procurement-*`, `integration-procurement*`) | 117 tests : 100 pass, 0 fail, 17 ignorés (réservés à PostgreSQL) |
| Mêmes suites, store fichier (`PROCUREMENT_STORE=file`) | 117 tests : 100 pass, 0 fail, 17 ignorés |
| Parité PostgreSQL réel (postgres:17 jetable, 15 suites `procurement-*`) | 15/15 PASS, 0 fail (dont import 7/7, pg-faults 11/11, core 18/18, invariants 3/3) |
| Coexistence migrations A+C (deux ordres), redémarrage serveur, sauvegarde/restauration (`procurement-coexistence.pg-smoke.mjs`) | 49/49 |
| Permissions / runner staging (`procurement-staging-tool.pg-smoke.mjs`) et schéma (`procurement.pg-smoke.mjs`) | 30/30 et 50/50 à la clôture de la phase 3 ; schéma et migrations inchangés depuis (rejoués dans le test de coexistence) |
| Fusion jetable convergence `9ac820e` + ma branche : `convergence-journey`, `procurement-server`, `-phase3`, `integration-procurement`, `-compat`, `procurement-core`, `-valuation` | tous verts ; `core-modules` : 1 échec « Création without a provider » = binaire natif `@resvg` absent sous Windows (même échec sans mon code, passe sous Linux) |
| Interface téléphone, navigateur intégré à 375 px, code final | l'application démarre, jeton retiré de la barre d'adresse, onglets, écran Stock sans « null », pas de défilement horizontal |
| Mutations (8 mutants des gardes de sécurité du lecteur de photos et du serveur) | 7 tués ; le survivant est la double vérification de confinement de chemin (redondante) |
| Suite complète du dépôt | **non relancée** dans cette session : une autre suite complète tournait sur la machine (consigne : ne pas en lancer une seconde). Dernière suite complète (phase 2, `e571b90`) : 346/354 fichiers, 3 791/3 814 tests ; les 8 fichiers en échec sont `sourcing-*`, identiques sur la base `f7197d5` |

## 5. Ce qui n'a PAS été fait / prouvé (ne pas le présenter comme fait)
- **Aucun téléphone réel** : ni caméra, ni HTTPS/tunnel, ni service worker (hors ligne) testés. La procédure est prête : `docs/operations/procurement-phone-test-procedure.md`.
- **Aucune base Supabase réelle** : tout PostgreSQL est un conteneur jetable avec des rôles Supabase simulés. Comportement réel (`auth.uid()`, extensions, quotas) à constater sur le staging dédié, après autorisation.
- **Paquet `pg`** non ajouté aux dépendances : `PROCUREMENT_PG_URL` exige `npm i pg` (décision du propriétaire).
- **Import** : jamais exécuté contre une vraie base ; `compareStores` prouve l'équivalence sur base jetable. Les compteurs de version de ligne repartent à 1.
- **Valorisation** : les unités en quarantaine sont encore physiques, donc valorisées au coût (limite connue).
- **CI GitHub** : voir le statut du SHA final dans le rapport de session (consulté via l'API publique ; les journaux bruts exigent une authentification).

## 6. Procédures
- **Import fichier → PostgreSQL** : `runImport({state, target, merchantId})` (essai à blanc) puis `apply: true`. Statuts : `REFUSED_SOURCE_INVALID`, `REFUSED_TARGET_NOT_EMPTY`, `DRY_RUN_OK`, `IMPORTED_VERIFIED` (seul succès), `IMPORTED_NOT_EQUIVALENT` (**jamais** un succès : ne pas utiliser la cible).
- **Retour arrière de l'import** : le fichier source n'est jamais modifié (prouvé par hachage) ; il suffit de retirer `PROCUREMENT_PG_URL` pour repartir sur le fichier. Le registre étant en ajout seul, on n'« annule » pas des lignes : on abandonne la base cible ou on exécute `supabase/rollback/*.down.sql` (voir `docs/operations/procurement-staging-migration.md` §5, export obligatoire avant toute perte).
- **Retour arrière du schéma** : permissions d'abord, puis schéma ; refusé s'il y a des lignes sans `--data-exported --accept-data-loss`.

## 7. Recommandations à reprendre par la convergence (non appliquées par moi)
1. Reprendre les 6 commits dans l'ordre ci-dessus (fusion sans conflit) ; reprendre **avec** eux la migration de permissions.
2. Décider la politique « qui peut réceptionner » côté hébergé (§2.2).
3. Brancher `photosDir` dans `hosted.js` si le magasin de photos est monté (§2.1).
4. Rendre le workflow « Creative Intelligence V1 » plus robuste (exécuter les `benchmark-*` en série) : propriétaire du workflow, hors de mon périmètre (`docs/operations/procurement-ci-investigation.md`).
