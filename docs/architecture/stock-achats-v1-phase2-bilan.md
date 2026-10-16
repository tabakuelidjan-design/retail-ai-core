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
Modifiés : `src/procurement/{service,queries,assistant,memory-store,stock,util,index}.js`, `supabase/migrations/20261016090000_procurement_stock.sql` (jamais appliquée : +`proc_visits`, ordre d'insertion, pièces jointes, documents), son rollback, `package.json` (+3 scripts), `.github/workflows/procurement-stock-v1.yml`, `src/integration/{approval,router,index}.js` (**+8/−2 lignes, comportement par défaut inchangé**).
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
| Suite complète du dépôt (une exécution par fichier, Node 24) | voir §Suite complète |

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
