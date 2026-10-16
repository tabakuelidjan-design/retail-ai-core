# Parle à Nordla (chantier A) ↔ Convergence — audit, matrice et contrat d'intégration (2026-10-16)

Destinataire : responsable de convergence. Rien ici n'a été appliqué à `integration/nordla-convergence-v1` ni à une autre branche que les miennes. Tout ce qui touche un fichier partagé est livré en **patch vérifié** (`convergence-compat.patch`) et en **branche de preuve** `feature/core-field-assistant-convergence-compat` (ma branche : fusion de la convergence + de la phase 3 + le patch).

## 1. Branches et têtes vérifiées (git fetch du jour)
| Branche | Tête | Note |
|---|---|---|
| A — `feature/core-field-assistant-phase3` (PR #14, brouillon) | voir le rapport final | UI, routage, COMPARE, refus d'actions, e2e 11/11 |
| `claude/nordla-core-p0` | `4a13fd0` | contient les phases 1-2 (PR #12, #13) |
| `integration/nordla-convergence-v1` | `9ac820e` | base P0 `92297c8` + chantier C `c4d2e3f` + montage `/api/procurement` |
| C — `feature/stock-achat-v1` | `56c3166` | a avancé après `c4d2e3f` (PG staging, écrans stock/réception) ; **n'a pas touché** `assistant.js`, `queries.js`, `core-pilot`, `sourcing` ; a touché `src/integration/procurement{,-policy,-compat}.js` (voir §6) |
| PR #11 `integration/core-postmerge-validation` | `7edfc7d` | conflit résolu avec P0 sur sa propre branche (un seul conflit : liste de branches du workflow) ; mergeable ; non fusionnée |

## 2. Matrice : ce que « Parle à Nordla » fait réellement
Légende : **Terminé** = prouvé par test (unitaire + contrat + e2e navigateur quand une interface est concernée) · **Incomplet** · **Absent** · **Bloqué**.

| Besoin du voyage | État | Preuve / limite |
|---|---|---|
| Consulter une commande fournisseur (par n° ou « commandes en attente ») | **Terminé** (code de la convergence) | `procurement-answers.js` → `open_purchase_orders` ; test `core-procurement-routing`. Données : magasin persistant (fichier) du serveur hébergé ; **PostgreSQL non branché en production** |
| Stock d'un produit / « mon stock » | **Terminé** | `stock_position` / `stock_overview` ; disponible ≠ attendu (jamais additionnés) |
| Marchandises en transit | **Terminé** | `goods_in_transit` ; valeurs par devise, jamais additionnées |
| Produits à recommander / commandes en retard | **Terminé** | `reorder_alerts` / `delayed_orders` |
| Retrouver un fournisseur (par nom) | **Absent** | **aucun outil de recherche de fournisseur** dans l'assistant Achats (15 outils) ni de liste de dossiers dans `askNordla` ; demande de contrat au chantier C : `find_supplier` (lecture seule) |
| Comparer des offres | **Incomplet (honnête)** | `procurement-compare.js` appelle `best_landed_cost_supplier` (article + quantité nommés, sinon question). **Sans taux de change ni transport/droits saisis**, le moteur ne compare que le prix de la marchandise : l'écran l'écrit (« SEULEMENT, pas le coût rendu ») ; aucun taux n'est inventé. Sur un dossier ouvert : « une offre, rien à comparer », jamais de « meilleur » inventé |
| Coût rendu documenté | **Terminé pour un dossier China Sourcing** (moteur `assess`) ; **Incomplet** côté Achats | un coût rendu Achats exige des entrées de coûts que la conversation ne fournit pas (voir plus haut). **Trois moteurs de coût rendu coexistent : un seul doit faire autorité** (décision en suspens, non prise ici) |
| Chiffres Finance et Analytics autorisés | **Terminé en code, Bloqué en données réelles** | lecteurs lecture seule testés ; branchés uniquement avec le Supabase staging non activé : « non raccordé » est dit sans chiffre |
| Ouvrir / consulter un dossier China Sourcing | **Terminé** | 16 intentions + COMPARE ; ouverture = interface (l'assistant lit le dossier ouvert) |
| Propositions en attente d'approbation | **Terminé** | `pending-approvals.js` : décisions Core à valider + bons de commande `PENDING_APPROVAL`, module non raccordé dit tel quel ; n'approuve rien |
| Voix | **Absent pour Parle à Nordla** | la voix existe pour la **saisie** des dossiers (Moonshine EN, test Xiaomi prévu le 18/10, non fait) ; l'assistant texte n'a pas de voix ; Analytics a sa propre saisie vocale (autre produit). Non testé réellement : rien n'est affirmé |
| Modèle de langage | **Absent (voulu)** | exigences documentées (`core-field-assistant-llm-needs.md`) |

Ce qui reste simulé : le test de parcours de la convergence et les miens utilisent des **données synthétiques** ; aucun fournisseur, stock ni facture réel n'a été lu.

## 3. Contrat d'intégration (ce que la convergence doit adopter)
### 3.1 Ordre de fusion
1. PR #11 (UI erreurs journal) — sa résolution est faite sur sa branche ; **un conflit d'import de 2 lignes** subsistait avec la phase 3 : **supprimé** (mon import est placé à distance du bloc d'imports ; fusion d'essai propre dans les deux ordres).
2. PR #14 (phase 3) dans P0.
3. Dans la convergence : merge de P0 (qui contient #14), puis `git apply docs/integration/convergence-compat.patch` (vérifié : applicable sur `9ac820e` + phase 3, 10/10 tests des fichiers ajoutés). Alternative : fusionner ma branche `feature/core-field-assistant-convergence-compat`.

### 3.2 Entrées de `askNordla(q, ctx)` (compatibles ascendantes)
`ctx.procurement` = l'objet `assistant` d'Achats : `{ call(tool, args) → Promise<{status,…}>, catalog[] }`. `ctx.conversation` : `undefined` = sans état ; `null` = début ; objet = état renvoyé par le serveur (validé par `validateConversation` dans `http.js`, déjà fusionné). Aucune autre entrée n'est requise.

### 3.3 Sorties
`{ status, answer, sources[], limits[] }`. Statuts : `ANSWERED`, `ASK`, `NOT_UNDERSTOOD`, `MODULE_NOT_CONNECTED` (+ `module`), `CORE_NOT_CONFIGURED`, **`ACTION_REFUSED`**. Réponses de terrain : + `intent`, `sections`, `knownTitle`, `case`, `verdict`, `orderBlocked`, `blockers[]` (+ `conversation`, `notice` si demandé). Sources Achats : `{kind:'procurement', ref:<outil>, as_of}`. Aucune réponse ne contient d'erreur brute ni de chaîne de connexion (testé).

### 3.4 Précédence de routage dans `ask.js` (la raison d'être du patch)
1. phrase vide → `ASK` · 2. **ordre d'agir** → `ACTION_REFUSED` (avant tout appel d'outil) · 3. décisions en attente / suivi (Core) · 4. modules connectés · 5. **validations en attente** (Core + Achats) · 6. **Achats** : comparaison / documents expirants **avant** le reste (une phrase « meilleur fournisseur » n'est pas une phrase de stock), puis stock, transit, commandes, réappro · 7. Achats absent + phrase Achats → `MODULE_NOT_CONNECTED` sans chiffre · 8. questions de dossier (assistant de terrain ; **se retire** — `DEFERRED` — dès qu'une ancre Achats/Finance/Analytics est présente) · 9. Finance · Analytics · 10. routeur historique.
Règles qui évitent la capture à tort : `commande`, `achète`, `signe`, `lance`, `crée` ne sont des ordres que suivis d'un objet (« commande fournisseur en cours » est un groupe nominal) ; une ancre stock/transit/commandes/PO fait toujours renvoyer la phrase à Achats même à côté d'un mot de dossier.

### 3.5 Routeur du hub (`src/integration/router.js` + `PROCUREMENT_RULES`) — constat mesuré
Avec les règles de C seules : « Mon stock », « Meilleur coût rendu », « Produits à recommander » étaient **UNROUTABLE** ; « Meilleur fournisseur » est capturé par la règle historique `compare_suppliers` (→ China Sourcing, qui **demande le produit** : sûr). Le patch **ajoute en fin de liste** 3 règles (`stock_overview`, `to_reorder`, `best_landed`) : toute phrase routée avant l'est de la même façon (test « append-only »), et chaque route possible est une lecture ou une proposition pour revue (test « jamais engageant »). **Décision laissée à la convergence** : pour que « meilleur fournisseur » aille vers Achats quand un article est nommé, il faudrait passer les règles Achats **avant** `compare_suppliers` (changement de `router.js`, non fait).
Conflit de politique à trancher : `PROCUREMENT_RULES.propose_adjust` route « ajuste/corrige le stock » vers une **proposition** ; l'assistant texte **refuse** ces verbes (`ACTION_REFUSED`). Choix prudent conservé : pour proposer, formuler « propose un ajustement » ; aucune modification de stock n'est atteignable depuis une phrase.

## 4. Fiabilité vérifiée (tests, tous lecture seule)
Source et période (`as_of`) sur chaque réponse Achats ; aucune invention (taux de change, quantité, transport, droits refusés ou demandés) ; ambiguïté → question ; isolation entre entreprises (deux mondes Achats, aucune fuite d'articles/commandes) ; refus d'agir avec Achats branché (aucun outil appelé, magasin identique octet pour octet) ; **nouvelles tentatives** : 3 répétitions de 8 questions → mêmes réponses, magasin et journal inchangés, aucun appel hors outils `READ_ONLY`, même pas `propose_*` ; UI : 3 taps rapides = **1 requête** ; module Achats en panne → réponse honnête sans texte d'erreur ni secret ; module absent → « non raccordé » ; magasins persistants : le magasin fichier du serveur hébergé est celui de `convergence-journey` (redémarrage), mes tests utilisent le magasin mémoire (même assistant).

## 5. Interface (tests réels, Edge, mobile émulé)
`nordla-ask-ui.e2e.js` **11/11** : bandeau de blocage, sections, conversation conservée, « et ensuite ? », refus d'action, HTML injecté resté du texte, nouvelle conversation, 390 px sans défilement horizontal et cibles ≥ 44 px, texte de 900 caractères sans espace, requête en échec (question conservée), hors ligne (réponses lisibles), état de chargement (boutons désactivés, 1 seule requête) et largeurs 375/390/768/1280. Limite : l'écran reste dans la section « Nordla Core » du menu (accès principal = proposition UX, sans toucher `app.js`).

## 6. Risques de conflit Git et tests manquants
- `ask.js` : le patch modifie la ligne du hook Achats et ajoute 3 lignes ; toute autre modification de cette zone par la convergence conflictera (3 hunks, lisibles).
- `src/integration/procurement.js` : C l'a modifié depuis `c4d2e3f` (`procurement-compat.js`, policy) : mon ajout est en fin de `PROCUREMENT_RULES` ; re-vérifier `git apply --check` après leur prochain merge.
- Manquants (côté C / convergence) : outil `find_supplier` ; entrées de coûts (transport, droits, taux) saisies hors conversation pour un coût rendu Achats ; test PostgreSQL du chemin `ask` ; validation des trois moteurs de coût rendu.
