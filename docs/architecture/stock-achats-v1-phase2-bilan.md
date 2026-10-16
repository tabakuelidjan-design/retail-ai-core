# Chantier C — Phase 2 : persistance, China Sourcing, mobile (2026-10-16)

Branche `feature/stock-achat-v1`. Suite de [stock-achats-v1-bilan.md](stock-achats-v1-bilan.md). Rien n'a été fusionné, déployé, appliqué sur un environnement partagé ; aucun paiement, achat réel ni écriture Shopify ; les chantiers A (Parle à Nordla) et B (Railway) n'ont pas été modifiés.

## Critère principal : démontré
« Un produit trouvé chez un fournisseur chinois peut être enregistré, comparé, transformé en commande brouillon et retrouvé après redémarrage, sans perte. »
- **Dans un navigateur réel à 375 px** (serveur local, données jetables) : visite chez deux fournisseurs (USD et CNY) → produit avec 2 photos et paliers → coupure réseau simulée (la saisie reste sur le téléphone, 1 en attente) → rechargement : envoi automatique, **un seul** produit côté serveur → même produit chez le 2ᵉ fournisseur → comparaison au coût rendu avec taux saisis → sélection → bon brouillon PO-2026-0001 → envoyé pour approbation par « terrain » (aucun bouton Approuver) → approuvé puis « commandé » par « propriétaire » → **serveur tué brutalement puis relancé** : visites, devis, photo, bon (« Commandé », 360 USD, 5000 pièces) retrouvés à l'identique.
- **En test automatisé** : `test/procurement-server.test.js` (arrêt/relance du serveur, mêmes jetons, bon byte-pour-byte identique, photo intacte, approbation qui survit au redémarrage suivant) et `test/procurement-durability.test.js` (processus tué par SIGKILL juste après sa dernière commande ; fichier corrompu refusé sans être écrasé ; verrou ; écriture disque en échec → commande annulée).

## Fonctions réellement utilisables
| Priorité | Livré | Où |
|---|---|---|
| P0 | Adaptateur PostgreSQL (pool `pg` injecté), transactions réelles, verrou sur le bon de commande, verrou consultatif sur la clé d'idempotence, erreurs normalisées, nouvelle tentative sûre (même clé) sur panne réseau, échec de COMMIT à issue inconnue géré par rejeu | `src/procurement/pg-store.js`, `service.js` |
| P0 | Magasin fichier durable (écriture atomique + fsync, verrou, refus de démarrer sur fichier corrompu) | `file-store.js` |
| P0 | Parité : **les mêmes suites** sur mémoire, fichier et PostgreSQL réel jetable ; pannes réseau (connexion refusée, coupure au BEGIN, **ACK de COMMIT perdu** → rejeu sans doublon), courses (retraits concurrents, réceptions concurrentes, clés identiques, numéros de BC, approbation unique) | `test/postgres/procurement-parity.mjs`, `test/procurement-pg-faults.test.js` |
| Décision 3 | Valorisation en **moyenne pondérée mobile** (les sorties partent au coût moyen ; un coût inconnu n'est jamais inventé : PARTIAL/UNKNOWN) ; lots de réception conservés pour un FIFO ultérieur | `stock.js` (`valuationOf`, `receiptLots`) |
| Décision 4 | Séparation des tâches : on n'approuve pas ce qu'on a préparé/soumis (BC) ni ce qu'on a posté (ajustement, inventaire) ; dérogation « propriétaire seul » explicite, journalisée `separationWaived` | `service.js` (`DEFAULT_POLICY`) |
| P1 | Import China Sourcing sans ressaisie : fournisseur (apparié par nom normalisé, ambigu = refusé), produit PROSPECT (SKU `SRC-<id>` ou code-barres), photos, un devis par révision, **idempotent**, sans doublon ; illisible = signalé et ignoré, jamais deviné ; bon brouillon (jamais en double) | `sourcing-bridge.js` |
| P1/P2 | Entité **visite** + saisie d'un produit en une opération atomique et idempotente (clé = identifiant de saisie du téléphone) | `service.js` (`startVisit`, `captureProduct`, `closeVisit`) |
| P2 | Serveur mobile (jeton personnel, verrouillage après 8 échecs, Host autorisé, CSP, approbations **construites par le serveur** à partir de l'utilisateur authentifié) + application française : visites, produit + photos redimensionnées, comparaison, sélection, bon brouillon, achats en attente, import Sourcing, file d'envoi locale | `src/procurement/server/*`, `src/procurement/ui/*` |
| P3 | Branchement **additif et optionnel** des **15** outils dans `src/integration` : politique (13 lectures READ_ONLY, 2 propositions OWNER_REVIEW), adaptateurs `proc_*`, 11 règles de routage ajoutées **après** les existantes ; détection de dérive catalogue/politique | `src/integration/procurement*.js` + 3 lignes dans `approval.js`, `router.js`, `index.js` |

## Fichiers (phase 2)
Créés : `src/procurement/{pg-store,file-store,sourcing-bridge}.js`, `src/procurement/server/{app,index,phone}.js`, `src/procurement/ui/*` (9 fichiers), `src/integration/procurement{,-policy}.js`, `test/procurement-{pg-faults,durability,child-writer,server,ui-logic,visits,bridge,valuation}*`, `test/integration-procurement.test.js`, `test/postgres/procurement-parity.mjs`, `docs/operations/procurement-{field-guide,staging-migration}.md`, ce document.
Modifiés : `src/procurement/{service,queries,assistant,memory-store,stock,util,index}.js`, `supabase/migrations-pending/20261016090000_procurement_stock.sql` (jamais appliquée : +`proc_visits`, ordre d'insertion, pièces jointes, documents), son rollback, `package.json` (+3 scripts), `.github/workflows/procurement-stock-v1.yml`, `src/integration/{approval,router,index}.js` (**+8/−2 lignes, comportement par défaut inchangé**).
Vérification des modifications concurrentes du chantier A : sur `origin/feature/core-field-assistant`, `src/integration` ne diffère de la base que par une ligne de `module-map.js` (note de dette Growth) ; je n'ai pas modifié `module-map.js`.

## Tests exécutés et résultats réels
| Vérification | Résultat |
|---|---|
| Suites du chantier C + intégration, Node 24.19, magasins mémoire **et** fichier | 77/77 chacun |
| Parité PostgreSQL 17 jetable (12 suites, dont pannes réseau et concurrence), code final | 12/12 suites passent |
| Schéma SQL (`procurement.pg-smoke.mjs`) | 50/50 (exécuté avant ajout de `proc_visits` ; rejoué en CI, vert) |
| Node 20.20.2 (Docker) : 71/74 tests locaux ; les 3 fichiers `integration-*` échouent **localement uniquement** : binaire natif Windows `@resvg` introuvable sous Linux (artefact d'environnement) | ces fichiers passent en CI Linux Node 20 |
| **CI GitHub, commit dae712c**, workflow `procurement-stock-v1` : Node 20 et 24 × mémoire et fichier + PostgreSQL 17 (schéma + parité) | **succès** (5 jobs) |
| Parcours complet dans un navigateur réel (375 px), coupure réseau simulée, redémarrage brutal du serveur | réussi (voir plus haut) |
| Suite complète du dépôt, Node 24, Windows, un processus par fichier (352 fichiers) | 341 passent, 11 échecs, **aucun causé par ce chantier** (voir ci-dessous) |

### Suite complète : les 11 fichiers en échec
- `core-product-images` : **causé par ce chantier** (garde « seul `src/sync` écrit les tables commerce » détectant la collection `locations`) ; corrigé (collection renommée), le fichier passe (10/10).
- 8 fichiers `sourcing-*` : échouent **à l'identique sur la base intacte** `integration/nordla-pre-china` (chemins Windows `C:\C:\…` et assertions de fichiers) ; non liés.
- `remaining-tenant-decoupling` : échec intermittent (« no B data », test de fuite sur UUID aléatoire, flake déjà connu) ; repasse 28/28 seul, et passe sur la base.
- `test/benchmark-*` exécutés ; `procurement-pg-faults` exclu de cette exécution (nécessite PostgreSQL, couvert par la parité).
- **CI GitHub, workflow « Creative Intelligence V1 » (Node 24) en échec** sur dae712c : déclenché par mon push (chemin `package.json`), étape « Focused Creative Intelligence tests ». Les journaux exigent une authentification que je n'ai pas : **cause non vérifiée**. Éléments : aucun de ces tests n'importe le module Stock/Achats ni les fichiers d'intégration modifiés ; tous ces fichiers passent en local ; la mémoire du projet note déjà un flake Node 24 non expliqué sur ce pipeline. À relancer pour confirmer. Les autres workflows déclenchés (Marketing, Activation, Provider) ont été annulés par le push suivant, pas échoués.

Défauts réels trouvés et corrigés pendant la phase : un test de garde du dépôt (« seul `src/sync` écrit les tables commerce ») détectait la collection `locations` du module → renommée `stockLocations` ; photos : `append(null)` affichait « null » dans l'interface (trouvé dans le navigateur) ; un article relu en base ne pouvait pas être mis à jour avec ses propres pièces jointes (`sha256: null`) ; la valorisation ignorait les sorties (non conforme à la décision 3).
**Correction d'une erreur de ma part** : le bilan de la phase 1 annonçait 16 outils assistant ; il y en a **15** (13 lectures, 2 propositions).

## Limites et blocages (honnêtes)
1. **PostgreSQL non branché en production** : l'adaptateur est prouvé sur base jetable, mais le serveur mobile utilise le fichier local tant que `PROCUREMENT_PG_URL` n'est pas défini, et ce chemin exige d'ajouter `pg` aux dépendances (décision). Aucune migration fichier → PostgreSQL n'existe.
2. **Service worker non vérifié** : écrit, mais le navigateur intégré ne l'enregistre pas ; à tester sur un vrai téléphone. **Aucune promesse hors-ligne** : seule la file d'envoi des saisies est garantie ; démarrer une visite et les étapes engageantes exigent le serveur.
3. **Pas testé sur un vrai téléphone ni via le tunnel cloudflared** (`procurement:phone` est écrit sur le modèle du mode téléphone de Sourcing, non lancé). L'appareil photo (`capture=environment`) n'a été exercé qu'avec une image injectée.
4. Le coût rendu de Finance arrondit au centime par pièce : l'application affiche le **total** et le dit ; pour des pièces à quelques centimes, le classement par pièce peut être grossier.
5. Précédence du routage : les phrases déjà revendiquées par une règle existante (ex. « le stock de … », « meilleur fournisseur ») restent routées comme avant (compatibilité) ; « meilleur fournisseur au coût rendu » va donc encore vers China Sourcing et non vers `proc_best_landed_cost_supplier`. Décision de priorité à prendre avec le chantier A.
6. Le plan d'achat en mémoire de `integration/index.js` est **conservé** ; aucun pont automatique BUY_CANDIDATE → bon persistant (l'import Sourcing passe par le dossier, pas par le verdict).
7. Rôles : le serveur mobile fixe le rôle par jeton ; non branché sur le module Identity.
8. Pas d'écran mobile pour réception, ajustement, inventaire (le module les gère).
9. Le port par défaut 8975 était déjà occupé sur cette machine pendant les essais (autre processus) ; `PROCUREMENT_PORT` le change.

## Retour arrière
Chaque commit est indépendant et réversible. Intégration : retirer `procurement` de `createIntegration` / `extraRules` de `routeUtterance` (ou `git revert c9045d3`) restaure exactement le comportement antérieur. Base : le rollback SQL retire les seules tables `proc_*`. Données de terrain : copier `data/local/procurement/`.

## Décisions à prendre
1. Ajouter `pg` aux dépendances et brancher un staging **dédié** (procédure : `docs/operations/procurement-staging-migration.md`, non exécutée).
2. Priorité de routage entre règles existantes et règles Stock/Achats (point 5) — avec le chantier A.
3. Faut-il un export/import fichier → PostgreSQL avant le voyage si la base doit devenir la source de vérité ?
4. Qui reçoit un accès « peut approuver » à côté du propriétaire (la séparation des tâches l'exige pour tout bon préparé par le propriétaire).

## Prochaines étapes avant le voyage
1. **Essai réel sur téléphone** : tunnel HTTPS, installation de l'application, vraie photo, coupure du réseau — et vérification du service worker (REQUIS avant de compter dessus).
2. Sauvegarde quotidienne du dossier de données (procédure du guide terrain).
3. Écran de réception des marchandises (le module est prêt).
4. Branchement PostgreSQL staging si la décision 1 est prise.

---

# Clôture de la phase 2 (vérifications finales, code figé sur `e571b90`)

## 1. Suite complète du dépôt (Node 24.19, Windows, un processus par fichier, `e571b90`)
**354 fichiers : 346 passent, 8 échouent. 3 814 tests : 3 791 passent, 9 échouent, 14 ignorés.**
Les 8 fichiers en échec : `sourcing-case-recovery`, `sourcing-field-v1-merchant-profile`, `sourcing-field-v1-phone-ui`, `sourcing-field-v1-server`, `sourcing-field-v1-three-modes`, `sourcing-price-currency`, `sourcing-terrain-v2`, `sourcing-xiaomi-sonny`.
Ils échouent **à l'identique sur la base intacte** `integration/nordla-pre-china` (f7197d5), rejoués côté base : chemins Windows (`C:\C:\…` introuvable pour `src/sourcing/core/money.js`) et assertions sur des fichiers servis. Non causés par ce chantier ; je ne les ai pas modifiés (ils relèvent du chantier China Sourcing).
La première exécution (avant corrections) avait en plus `core-product-images` (causé par moi, corrigé) et `remaining-tenant-decoupling` (intermittent connu : il passe cette fois). Aucun échec masqué.

## 2. Persistance China Sourcing → Buying après redémarrage
`test/procurement-sourcing-real.test.js` (Node 24) : des dossiers **construits par le vrai réducteur Sourcing** (`newCase`/`dispatch`) et enregistrés par le **vrai magasin fichier Sourcing**, lus sur disque par le serveur Stock/Achats, importés par HTTP (virgule décimale, deux devises, deux révisions de devis, photo) avec bon brouillon, **serveur arrêté puis relancé** : bon identique, 2 devis conservés, aucun fournisseur/produit/devis/bon/emplacement en double après réimport ; un devis ajouté ensuite dans Sourcing crée exactement une révision (aussi après redémarrage). 2/2.
Limite constatée : la référence photo d'un dossier Sourcing est conservée comme **référence** (`photo://…`) ; l'écran mobile n'affiche pas de miniature pour elle (seules les photos envoyées depuis le téléphone, `upload://`, s'affichent).

## 3. Interface mobile : fonctionnement et limites (navigateur réel, 375 px, code final)
Les quatre onglets se chargent sans erreur et sans défilement horizontal ; emplacements par défaut recréés au démarrage ; parcours complet déjà joué (voir plus haut). Limites : service worker non enregistrable dans le navigateur intégré (non vérifié) ; pas d'essai sur un vrai téléphone, ni tunnel cloudflared, ni vraie caméra ; démarrer une visite et approuver/commander exigent le serveur ; pas d'écran de réception/ajustement ; miniatures Sourcing absentes (point 2).

## 4. `assistant.js` et `queries.js` : différences et risque de conflit avec le chantier A
Depuis la première version : les deux sont devenus **asynchrones** (le magasin peut être mémoire, fichier ou PostgreSQL) ; `queries.js` gagne `quote(s)`, `visit(s)`, `receiptLots`, `plannedMargin`, `targetUnitPrice`, `expiringDocuments`, `landedTotal`, `currentQuote`, la valorisation en moyenne mobile et la collection `stockLocations` ; `assistant.js` gagne `target_price` et `expiring_supplier_documents` (15 outils : 13 lectures, 2 propositions). Ils sont construits sur la lecture seule : aucun accès aux commandes.
**Risque de conflit avec A : nul sur ces fichiers** : `src/procurement/` n'existe pas sur `origin/feature/core-field-assistant`. Sur les fichiers partagés que j'ai modifiés (`src/integration/{approval,router,index}.js`), A n'a rien changé depuis la base. Fusion à blanc (`git merge-tree`, rien fusionné) de ma branche avec la branche A : un seul conflit, `.github/workflows/nordla-integration-pre-china.yml`, qui **existe déjà entre la base et A** (je ne l'ai pas touché) ; `package.json` fusionne désormais sans conflit (mes 3 scripts sont placés loin des lignes éditées par A).
Défaut corrigé : ma migration était dans `supabase/migrations/`, alors que la convention du chantier A place les migrations préparées et non appliquées dans `supabase/migrations-pending/` (sinon `supabase db push` ou le banc CI les prennent) → déplacée. À noter : A prépare des tables pour BUY_CANDIDATE/PurchasePlan/IncomingExpectation (`20261015090000_integration_objects_and_sourcing_cases.sql`) qui recoupent en partie ce module ; **recouvrement à arbitrer avant toute application de l'un ou l'autre**.

## 5. Compatibilité avec les contrats d'intégration existants
`integration-contracts` + `integration-workflows` : 38/38 inchangés, passent ; `integration-procurement` : 6/6 (13 lectures `READ_ONLY`, 2 propositions `OWNER_REVIEW`, rien d'engageant atteignable, dérive catalogue/politique détectée, 8 phrases existantes routées à l'identique avec et sans règles supplémentaires, plan d'achat en mémoire intact). Sans l'option `procurement`, le comportement est identique à la base.

## 6. Défauts trouvés pendant la clôture et corrigés (ma branche uniquement)
1. Migration dans le mauvais dossier (point 4).
2. **Perte silencieuse de données lors d'un changement de format** : un fichier écrit avant le renommage de la collection `locations` perdait ses emplacements au chargement, puis le démarrage le réécrivait sans eux. Correctif : alias de la clé héritée ; toute clé inconnue est **refusée** au lieu d'être ignorée ; test dédié. (Dans le dossier de démonstration jetable, l'écrasement avait déjà eu lieu avant le correctif ; aucune donnée réelle n'était concernée.)
3. Les emplacements par défaut ne se recréaient pas s'ils avaient disparu (le démarrage s'appuyait sur le rejeu d'une commande idempotente) → création conditionnelle.
4. Tests qui ne libéraient pas le serveur en cas d'échec (blocage) → nettoyage garanti.
Re-testés après correctifs : durabilité 7/7, serveur + Sourcing réel 9/9, suite complète relancée en entier.
