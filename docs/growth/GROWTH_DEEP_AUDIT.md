# Growth — audit approfondi (bugs, cohérence, visuels, éléments manquants)

- Branche : `feature/growth-platform`, HEAD `f4aa4ab` (après correctif du menu mobile Plus). Arbre propre. Aucun correctif appliqué pendant cet audit.
- Date : 2026-09-28.
- Méthode : lecture du code (`src/growth/**`, moteurs partagés utilisés par Growth) + exécution locale (serveur Growth en boucle locale) sur trois jeux :
  - **staging** : copie JSON du snapshot staging `snap-8B-final-pre.json` servie par un faux Supabase en mémoire. Aucune connexion à staging ni à la production ;
  - **synthétique** : jeux de test de `test/fixtures`, au-dessus de tous les seuils ;
  - **sans tenant** : routes en `503 TENANT_NOT_CONFIGURED`.
- Navigateur : Chrome headless piloté par DevTools Protocol (émulation réelle de largeur), sonde automatique sur 7 pages × 5 largeurs (1440/1280/1024/768/390) × 2 jeux de données, et 7 pages × 4 largeurs × 3 langues pour les traductions.
- Tests : 1215/1215 au moment de l'audit.

---

## 1. Executive summary

Growth est **globalement sain côté moteurs réels** (Produits Potentiels, Audience, Contenu, Croissance magasin) :
- aucune fuite tenant, aucun `undefined`/`NaN`/clé brute à l'écran, aucune erreur console, aucune image cassée ;
- les garde-fous « inconnu ≠ 0 » tiennent partout où ils ont été testés ;
- la navigation mobile (5 + Plus) fonctionne : accès à toutes les pages, état actif, Échap, retour navigateur.

Mais **deux vérités coexistent encore** dans le module, ce que le cadrage interdit :

1. **P1 — Datation des remboursements différente selon les pages.** Sur la même fenêtre de 8 semaines :
   - Produits Potentiels et Contenu datent un remboursement **à sa date de remboursement** (règle d'Explorer / Analytics) ;
   - Croissance magasin (et Audience) le rattachent **à la date de la commande d'origine**.

   Reproduit : une commande de la période précédente remboursée pendant la période donne **300 €** sur Croissance magasin contre **200 €** sur Contenu et Produits Potentiels.
2. **P1 — Les pages de démonstration contredisent les pages réelles.** Vue d'ensemble, Opportunités et Campagnes sont 100 % démo (badge « Données de démonstration »), mais leurs chiffres contredisent le reste du module :
   - la carte « Croissance magasin » de Vue d'ensemble affiche **4 860 visiteurs et 21,4 % de conversion**, alors que la page Croissance magasin affirme, à juste titre, que la fréquentation n'est pas connectée ;
   - « Campagnes actives : 5 » sur Vue d'ensemble contre 8 campagnes « en cours » sur Campagnes.

À corriger aussi avant d'empiler une nouvelle page :
- **P2 :** overflow horizontal de **Contenu à 1024 px** (largeur jamais contrôlée jusqu'ici) ;
- **P2 :** l'état de chargement affiche « Données indisponibles » ;
- **P2 :** l'état d'erreur est générique et la pastille de période y retombe sur « 30 derniers jours » ;
- **P2 :** les panneaux de détail ne gèrent pas le focus clavier.

**Verdict : CORRECTIONS REQUISES** (détail et liste exacte à la fin).

---

## 2. État global Growth

| Page | Données | État | Remarques principales |
|---|---|---|---|
| Vue d'ensemble | **Démo** (`/api/growth/overview`, badge démo) | Validée visuellement, non branchée | Métriques non calculables par Nordla (visiteurs, conversion, ROAS, CA influencé) ; cartes non reliées aux pages réelles |
| Opportunités | **Démo** | Validée visuellement | Actions et « Approuver » désactivés (avec explication) ; aucun lien avec les signaux réels |
| Campagnes | **Démo** | Validée visuellement | « + Nouvelle campagne » désactivé ; compte de campagnes incohérent avec Vue d'ensemble |
| Produits Potentiels | Réelles | Poussée (`b6e3a14`) | Moteur correct ; datation des remboursements = Explorer |
| Audience | Réelles (niveau client pseudonymisé ou agrégé) | Poussée (`4f067cc`/`47059ae`) | Remboursements datés commande ; staging = mode agrégé (aucune `customer_key`) |
| Contenu | Réelles | Poussée (`fe6878c`/`56b4c36`) | Overflow à 1024 px ; « Sans image » / « Hors collection » jamais vérifiables en production (dette de provenance Core) |
| Croissance magasin | Réelles (ventes uniquement) | Locale (`5ec46e3`/`f4aa4ab`) | Remboursements datés commande (≠ Produits Potentiels / Contenu) |
| Expériences | — | Désactivée (« Bientôt disponible ») | Rail desktop + panneau Plus |
| Nordla AI | — | Désactivé | Rail desktop + panneau Plus |
| Paramètres / Sources de données | — | Paramètres désactivé ; aucune page « Sources de données » | — |

---

## 3. Bugs classés

Format : **ID — page — fichier — problème**, puis reproduction, cause probable, correction recommandée, effort, risque.

### P0 — BLOQUANT
Aucun. Pas de fuite tenant, pas de corruption, pas de page inutilisable.

### P1 — IMPORTANT

**P1-1 — Croissance magasin / Audience vs Produits Potentiels / Contenu — `src/growth/store/facts.js`, `src/growth/audience/facts.js` vs `src/metrics/products.js` (via Produits Potentiels), `src/growth/content/facts.js` — deux datations des remboursements.**
- Reproduction : commande magasin de 100 € passée pendant les 8 semaines précédentes, remboursée pendant la période courante. Résultat sur la période courante : Croissance magasin 300 €, Contenu 200 €, Produits Potentiels 200 € (script d'audit, jeu `store-sample`).
- Cause : `storeFacts` / `audienceFacts` agrègent chaque commande avec **tous** ses remboursements, datés par la commande. `buildProductPerformance` et `windowFacts` (Contenu) datent le remboursement **par sa date**.
- Correction : choisir **une** règle Growth. Recommandation : la règle Explorer / Analytics (ligne datée par la commande, remboursement daté par le remboursement), pour Croissance magasin et pour les montants de fenêtre d'Audience. Garder « valeur observée par client » (historique) séparée et nommée. Ajouter un test transverse qui compare les 4 pages sur un même jeu avec remboursements à cheval.
- Effort : M (2 facts + tests). Risque : moyen (les KPI magasin et Audience changent légèrement ; les seuils ne bougent pas).

**P1-2 — Vue d'ensemble — `src/growth/server/demo-overview.js`, `src/growth/ui/app.js` (storeCard, pulse « Visiteurs magasin ») — la démo montre fréquentation et conversion magasin.**
- Reproduction : ouvrir `#/`. La carte « Croissance magasin » affiche Trafic 4 860, Conversion 21,4 %, et le sélecteur du Growth Pulse propose « Visiteurs magasin ». Sur `#/storeGrowth`, un bandeau dit que la fréquentation n'est pas connectée.
- Cause : Vue d'ensemble est la maquette de démo validée d'avant le branchement réel.
- Correction (décision propriétaire, page validée) : au minimum, retirer de la démo les métriques que Nordla ne peut pas calculer (visiteurs, conversion, ROAS, CA influencé) ou les afficher comme « non connectées ». Idéalement, brancher Vue d'ensemble sur les moteurs réels (voir P1-3).
- Effort : S (neutraliser) à L (brancher). Risque : faible à moyen (page validée pixel par pixel).

**P1-3 — Vue d'ensemble / Opportunités / Campagnes — `src/growth/server/demo-*.js` — trois pages démo à côté de quatre pages réelles, avec des chiffres qui se contredisent.**
- Reproduction : « Campagnes actives 5 » (Vue d'ensemble) contre 12 campagnes dont 8 « en cours » (Campagnes). Les « Opportunités actives 8 » de Vue d'ensemble et le pipeline d'Opportunités ne dérivent d'aucun signal réel (Produits Potentiels, Audience, Magasin exposent déjà des contrats d'opportunité inutilisés).
- Cause : démos indépendantes, non dérivées l'une de l'autre ni des moteurs réels. Les endpoints démo ne dépendent d'aucun tenant et servent la même démo à tous.
- Correction : décision propriétaire requise. Soit (a) les garder explicitement démo mais cohérentes entre elles (une seule source démo pour les comptages partagés), soit (b) planifier leur branchement. Au minimum, aligner les comptages communs démo.
- Effort : S (a) / L (b). Risque : faible (a).

### P2 — À CORRIGER

| ID | Page | Fichier | Problème | Reproduction | Cause probable | Correction | Effort | Risque |
|---|---|---|---|---|---|---|---|---|
| P2-1 | Contenu | `growth.css` (`.gr-ct-row`) | Scroll horizontal de page à **1024 px** (`scrollWidth` 1045) ; colonne `…` hors écran | `#/content` à 1024 px | Somme des `minmax()` de la grille > largeur disponible ; passage en cartes seulement ≤ 1023 px | Passer en cartes jusqu'à ~1100 px, ou réduire les minima (Problèmes / Action) | S | Faible |
| P2-2 | Toutes | `ui/app.js` `render()` l.438 | Pendant le chargement, la carte affiche **« Données indisponibles »** | Tout premier affichage d'une page, avant réponse API | Même branche que l'état d'erreur | Vrai état « Chargement… » distinct de « indisponible » | S | Faible |
| P2-3 | Pages réelles | `ui/app.js` `route()` / `render()` | Erreur API = message générique ; `TENANT_NOT_CONFIGURED` et `DATA_UNAVAILABLE` non distingués ; pas de réessai | Serveur sans `NORDLA_MERCHANT_ID` | `loadFailed` est un booléen, le code d'erreur est ignoré | Mémoriser le code, message dédié, bouton Réessayer | S | Faible |
| P2-4 | Pages réelles | `ui/app.js` `topbar()` | En chargement / erreur, la pastille affiche **« 30 derniers jours »** sur des pages à 8 semaines ou 90 jours | `#/potential` sans tenant | Libellé dérivé du payload, absent en erreur | Déclarer la fenêtre dans la définition de page (`PAGES`) | S | Faible |
| P2-5 | Produits Potentiels, Audience, Contenu | `ui/potential.js`, `ui/audience.js`, `ui/content.js` | Panneau de détail : le focus ne va pas dans le dialogue, retombe sur `<body>` à l'ouverture et à la fermeture | Tab jusqu'à une ligne, Entrée, Échap | Re-render complet, aucune gestion de focus | Focus sur le bouton Fermer à l'ouverture, retour sur la ligne à la fermeture, piège Tab | S | Faible |
| P2-6 | Toutes (réelles) | — | **Aucune indication de fraîcheur** (dernière synchro Core) : des données arrêtées depuis des jours s'affichent sans avertissement (seul Produits Potentiels mentionne l'âge du stock) | Snapshot staging arrêté au 29/08 | Pas de lecture de `sync_runs` dans Growth | Afficher la date de dernière synchro réussie (comme Analytics) et un état « données obsolètes » | M | Faible |
| P2-7 | Serveur | `server/*.js` | Chaque source recharge **indépendamment** 400 jours de données (4 chargements par tenant) et Croissance magasin recalcule tout le moteur Produits Potentiels | Visiter les 4 pages réelles | Sources isolées, cache par source | Un seul chargement partagé par tenant et par TTL, ou réutiliser la source Produits Potentiels dans Magasin | M | Faible |
| P2-8 | Contenu, Produits Potentiels | payload + DOM | Pas de pagination : tout le catalogue actif est envoyé et rendu (56 Ko pour 158 produits en staging, ~1,8 Mo et des milliers de nœuds DOM pour 5 000 produits) | Gros catalogue | Liste complète | Pagination serveur ou virtualisation (au moins un plafond + « afficher plus ») | M | Faible |

### P3 — COSMÉTIQUE / mineur

| ID | Page | Problème | Correction |
|---|---|---|---|
| P3-1 | Audience | Tableau « Segments prioritaires » avec défilement interne à 1024 px | Ajuster les colonnes à 1024 |
| P3-2 | Toutes | ~15 textes avec un compte venant des données qui cassent au singulier : « 1 produits affichés », « 1 commandes magasin », « (1 clients) », « 1 acheteurs répétés »… (`gr.pp.list.foot`, `gr.pp.byStatus.foot`, `gr.au.dist.foot`, `gr.au.act.target`, `gr.au.d.same`, `gr.au.d.previous`, `gr.au.list.foot`, `gr.au.sig.reactivation.title`, `gr.au.sig.coverage.text`, `gr.ct.kpi.toImproveNote`, `gr.ct.prio.foot`, `gr.ct.list.foot`, `gr.st.days.foot`, `gr.st.sig.none`, `gr.op.byStatus.count`) | Petite fonction de pluriel (clé `…1` / `…N`, comme déjà fait pour les unités) |
| P3-3 | Vue d'ensemble | « Growth Pulse » reste en anglais dans le texte FR | Traduire ou assumer comme nom propre |
| P3-4 | Croissance magasin | Clé morte `gr.st.loc.aov` (colonne retirée) | Supprimer |
| P3-5 | Toutes | Titres H1 → H3 sans H2 (sauf panneaux de détail) | Structurer les titres de cartes en H2, ou `aria-level` |
| P3-6 | Produits Potentiels, Audience, Contenu | Lignes cliquables = `<button>` contenant des `<div>` (modèle de contenu HTML invalide) ; conteneur `role="list"` sans `listitem` | Ligne `div role="row"` + bouton « Voir » dédié, ou `span` internes |
| P3-7 | Menu Plus | `aria-modal` sans piège de focus : Tab quitte le panneau | Piège Tab dans le panneau |
| P3-8 | Toutes | Avertissement `ResizeObserver loop completed with undelivered notifications` (préexistant, vient des graphiques partagés) | Différer le redraw dans `requestAnimationFrame` (fichier partagé : hors Growth, à signaler) |
| P3-9 | Contenu | Cartes KPI avec et sans icône sur la même ligne (4 icônes manquantes) | Produire les icônes (§ 8) |
| P3-10 | Toutes | Montants en euros entiers, y compris les paniers moyens (38 € au lieu de 38,40 €) | Décimales pour les paniers moyens seulement |
| P3-11 | Code | Couplages entre fichiers de page : Contenu utilise `opPctRound` et Produits Potentiels / Audience / Contenu utilisent `opDots` (définis dans `opportunities.js`) ; Magasin utilise des clés Audience (`gr.au.pts`, `gr.au.act.toTest`) et la classe `.gr-au-banner` ; Magasin utilise `gr.pp.u1/uN` | Déplacer ces utilitaires dans le shell |
| P3-12 | Chaque page | Données chargées une seule fois par session côté navigateur (pas de rafraîchissement sans recharger) | Rafraîchissement au retour sur la page si TTL dépassé |
| P3-13 | Toutes | Les 13 scripts, dont les 3 dictionnaires (~150 Ko), sont chargés sur chaque page | Acceptable aujourd'hui ; à surveiller |
| P3-14 | docs | `docs/growth/growth-overview-*.png` datent de l'ancienne Vue d'ensemble | Régénérer ou retirer |
| P3-15 | Payloads | IDs internes (UUID produit, emplacement) exposés dans les réponses | Nécessaires au panneau de détail ; acceptable, à documenter |

---

## 4. Audit par page

### Vue d'ensemble (démo)
- Fonctionnel : aucun bouton actif hors langue ; les actions de « Nécessite votre attention » sont désactivées avec un titre explicatif. Le sélecteur du Growth Pulse fonctionne.
- Données : 100 % démo, badge visible. Métriques impossibles pour Nordla : CA influencé, ROAS, visiteurs magasin, conversion (P1-2).
- Aucune carte n'est reliée à sa page (Opportunités, Campagnes, Croissance magasin, Contenu) : tout doit passer par le menu.
- 390 px : le tableau « Performance par canal » défile dans sa carte (pas de débordement de page).

### Opportunités (démo)
- Filtres source / statut / tri : fonctionnels (testés).
- Menu `…` et « Approuver » désactivés, avec titre.
- 768 / 390 px : pipeline en tableau à défilement interne (voulu).
- Les contrats d'opportunité produits par les pages réelles (`opportunity: { kind, … }`) ne sont consommés nulle part.

### Campagnes (démo)
- Recherche et filtres fonctionnels. « + Nouvelle campagne » désactivé avec explication.
- Compte de campagnes incohérent avec Vue d'ensemble (P1-3).
- 768 / 390 px : tableau à défilement interne.

### Produits Potentiels
- Ordre des règles (vérifié en test et en relecture) : insufficient > retours > marge faible (coût fiable) > baisse > réassort > à pousser > à surveiller > top vente > stable.
- Top vente relatif (20 %, 1..10, égalités incluses).
- Stock inutilisable ⇒ couverture masquée.
- Coût absent ⇒ `—`, jamais 0 %.
- Filtres, recherche, tri et panneau de détail fonctionnels. Échap ferme.
- Focus non géré (P2-5). Pluriels du pied de liste (P3-2).
- Remboursements datés par remboursement (règle Explorer) : cohérent avec Contenu, pas avec Magasin (P1-1).

### Audience
- Segments exclusifs.
- Règles v1 90 jours / 30 clients documentées et exposées.
- Confidentialité : aucune clé ni libellé client dans la réponse (testé).
- Mode agrégé honnête sans `customer_key` : c'est le cas du staging, où aucun segment n'est fabriqué.
- Remboursements datés par la commande d'origine pour le CA de fenêtre (P1-1).
- Tableau « Segments prioritaires » à défilement interne à 1024 px (P3-1).
- Focus du panneau (P2-5).

### Contenu
- Contrôles réels :
  - image présente ⇒ texte alternatif vérifiable ;
  - « Sans image » et « Hors collection » seulement avec une preuve par produit, donc jamais en production aujourd'hui (dette Core de provenance, déjà enregistrée) ;
  - catégorie = `product_type` ;
  - SKU manquant ;
  - nom en double.
- Produits non ACTIVE exclus. 2 produits vendus sur la période mais en brouillon ou archivés n'apparaissent pas ; la règle est dite dans le pied de liste, sans compte des produits concernés.
- **Overflow à 1024 px** (P2-1).
- Focus du panneau (P2-5).
- Bouton « Améliorer ce produit » désactivé avec explication.

### Croissance magasin
- `pos` et `point_of_sale` sont identiques (testé).
- Ventes ≠ fréquentation : bandeau, aucune métrique visiteur (testé).
- Emplacements : « Tous les magasins » + détail par emplacement, et groupe « sans emplacement » visible.
- Seuil de 30 commandes pour signaux et actions ; règles v1 ×2 avec au moins 3 commandes pour le signal produit.
- Garde-fous repris de Produits Potentiels. Staging : 8 commandes magasin, donc aucun signal (honnête).
- Remboursements datés commande (P1-1).
- Graphique : comparaison semaine à semaine, ou courbe seule si l'historique ne couvre pas la période précédente.

### Expériences / Nordla AI / Paramètres
Désactivés partout (rail desktop et panneau Plus), avec « Bientôt disponible ». Aucune page « Sources de données » n'existe dans Growth : les capacités futures sont listées dans Croissance magasin (« Pour aller plus loin ») et, par page, dans les états « non vérifiable ».

---

## 5. Audit navigation

| Élément | Résultat |
|---|---|
| Rail desktop | 8 entrées Growth + Nordla AI + Paramètres. Pages construites en liens, les autres désactivées. État actif correct sur les 7 pages |
| Barre mobile | 6 emplacements : Vue d'ensemble, Opportunités, Campagnes, Produits Potentiels, Audience, Plus. Libellés à 9 px identiques |
| Plus | Bouton natif, `aria-expanded`/`aria-controls`, actif sur Contenu et Croissance magasin uniquement. Focus envoyé dans le panneau ; Échap ferme et rend le focus ; clic extérieur ferme ; toute navigation ferme ; **retour navigateur** : panneau fermé, page et état actif corrects (vérifiés en navigateur réel) |
| Plus — manques | Pas de piège Tab (P3-7) ; icône de points dessinée en SVG en ligne, pas une icône du pack (§ 8) |
| Accès mobile | Depuis chacune des 7 pages, les 7 pages construites sont accessibles (barre ou Plus) — testé |
| Changement de langue | Instantané, sans rechargement ni perte de filtre |
| Période | Pastille « Fixe » : 30 j (démo), 8 semaines (Produits Potentiels, Contenu, Magasin), 90 jours (Audience). Fausse en chargement / erreur (P2-4) |
| Prêt pour la suite | Oui : ajouter Expériences = `href` + `more: true` (ou promotion dans la barre en retirant une entrée). Nordla AI : même mécanisme |

---

## 6. Audit données / métier

| Règle | Vérification | Résultat |
|---|---|---|
| Aucune métrique inventée (pages réelles) | Relecture + tests | OK. Démo : non (P1-2, P1-3) |
| Inconnu ≠ 0 | Tests Produits Potentiels, Audience, Contenu, Magasin + contrôle d'écran (`—`, « Non vérifiable », « Pas de période comparable ») | OK |
| Pourcentage sans dénominateur valide | `share()` renvoie `null` si dénominateur 0 ; variations seulement si précédent > 0 | OK |
| Corrélation présentée comme causalité | Signaux au format fait → comparaison ; test anti-« parce que / because / visiteur » sur Magasin | OK |
| Impact financier non démontré | Aucun montant de potentiel ni d'uplift dans les pages réelles (tests) | OK. Démo : « Revenu potentiel 14 800 € » (Opportunités), « CA influencé » (Vue d'ensemble) |
| Mélange réel / démo | Démo signalée par badge, mais les chiffres se contredisent entre pages | **P1-3** |
| Même donnée = même résultat | Fenêtre 8 semaines identique sur Produits Potentiels, Contenu et Magasin (vérifié) ; unités et CA par produit identiques entre Produits Potentiels et Contenu (15/15) ; statut produit identique entre Produits Potentiels et Magasin (le Magasin appelle le même moteur) | OK, **sauf datation des remboursements (P1-1)** |
| Canal magasin | `src/metrics/channels.js` partagé par clients, marketing, Audience et Magasin | OK dans Growth. Finance (dossier comptable) hors normalisation : dette séparée enregistrée |
| Notion client / récence | Audience réutilise `customer_order_index`/`journey_ready` et les seuils du moteur clients | OK |

---

## 7. Audit multi-tenant et sécurité

| Contrôle | Résultat |
|---|---|
| Tenant fixé par `NORDLA_MERCHANT_ID` au démarrage (`serve.js` → `resolveToolTenant`) | OK |
| `merchantId` / `merchant_id` / `tenant` (query et en-tête) ignorés | OK : testé pour `/api/growth/products`, `audience`, `content`, `store` |
| Isolation A/B | OK : tests à deux marchands pour les 4 sources |
| Premier marchand / création automatique / Shopify pour identifier le tenant | Aucun (résolveur partagé, validé à l'étape 5) |
| Endpoints démo | Indépendants du tenant (même démo pour tous) : pas une fuite, mais voir P1-3 |
| Authentification | **Aucune** : serveur limité à `127.0.0.1` (préversion locale). Acceptable aujourd'hui ; **bloquant avant tout hébergement** (PLUS TARD, mais obligatoire avant déploiement) |
| Logs | `console.error` du seul message d'erreur, sans secret ni donnée client |
| Données clients brutes | Aucune (nom, e-mail, téléphone, adresse jamais lus) ; clé pseudonymisée jamais émise (testé) |
| IDs internes exposés | UUID produit et emplacement (P3-15) |
| Test de démarrage `serve.js` Growth avec tenant réel | **Absent** (§ 15) |

---

## 8. Audit icônes — inventaire

Sources :
- **pack Growth** : 31 PNG dans `src/growth/ui/assets/icons/`, tous référencés, aucun orphelin ;
- **icônes officielles** : `NordlaIcon.semantic`, fichiers `official-icons/*.png` ;
- **logos de canaux** : 5 PNG dans `assets/channels/`.

Aucune référence cassée : un test par page vérifie l'existence de chaque icône et l'absence d'icône « défectueuse ».

| Page | Emplacement | Icône / fichier | Rôle | État |
|---|---|---|---|---|
| Shell | Menu : Vue d'ensemble, Opportunités, Campagnes, Contenu, Croissance magasin, Audience, Expériences, Paramètres | pack `growth-overview`, `opportunities`, `campaigns`, `content`, `store-growth`, `audience`, `experiments`, `settings` | Navigation | OK |
| Shell | Menu : Produits Potentiels | officielle `01_navigation_modules_produits.png` | Navigation | **PLACEHOLDER** (icône Growth dédiée manquante) |
| Shell | Menu : Nordla AI | `NordlaIcon.parle` | Navigation | OK |
| Shell | Bouton **Plus** | SVG en ligne (3 points) | Menu mobile | **MANQUANTE** / STYLE INCOHÉRENT (pas une icône du pack) |
| Shell | Panneau Plus : Nordla AI | `parle('onTerracotta')` sur fond gris | Entrée désactivée | STYLE INCOHÉRENT (contraste faible) |
| Shell | Pastille période | officielle `calendrier` | Période | OK |
| Vue d'ensemble | KPI CA influencé / Growth Pulse / Performance par canal / ROAS | officielles `chiffre_affaires` et `croissance` (3 usages) | KPI / titres | **DOUBLON**, MAUVAISE SÉMANTIQUE (ROAS ≠ croissance) |
| Vue d'ensemble | Performance du contenu | officielle `meilleur_produit` | Titre | **MAUVAISE SÉMANTIQUE** |
| Vue d'ensemble | Miniatures de contenu | logo de canal dans une vignette neutre | Vignette | **PLACEHOLDER** (marqué dans le code) |
| Opportunités | KPI « En cours » | officielle `synchronisation` | KPI | MAUVAISE SÉMANTIQUE |
| Opportunités | Gains récents (KPI + carte) | officielle `meilleur_produit` | Titre | DOUBLON |
| Opportunités | Sources / segments / priorité / confiance / effort / impact / statuts | pack dédié (`priority-high`, `confidence`, `effort`, `impact-effort`, `pipeline-status`, `revenue-by-source`, `students`, `gifts`, `local`, `business`, `returning-customers`) | Détails | OK |
| Campagnes | Thèmes de campagne (12) | pack dédié (un par thème) | Vignettes | OK |
| Produits Potentiels | KPI Produits actifs / À pousser / À surveiller / Réassort avant promotion | `produits`, `produit_en_hausse`, pack `needs-attention`, officielle `stock` | KPI | OK ; « Réassort avant promotion » = `stock` générique (**MANQUANTE** dédiée) |
| Produits Potentiels | Carte **À protéger / ne pas pousser** | aucune | Titre | **MANQUANTE** |
| Produits Potentiels | Vignette produit sans image | `produits` | Fallback | OK (placeholder assumé) |
| Audience | KPI (5), segments (7), signaux, actions | `clients`, `nouveau_client`, `client_fidele`, `client_dormant`, `segment_client`, `panier_moyen`, `commandes`, `chiffre_affaires`, pack `returning-customers`, `bundle`, `retargeting`, `loyalty`, `gifts`, `priority-high`, `audience`, `data_health` | Divers | OK |
| Audience | Deux segments « nouveaux » partagent `nouveau_client` ; « Occasionnels » et « Offre ciblée » partagent `segment_client` | — | Segments | DOUBLON (acceptable) |
| Audience | Carte **Actions recommandées** | aucune (officielle `actionRecommandee` défectueuse) | Titre | **MANQUANTE / CASSÉE** (réexport requis) |
| Audience | Priorité, données partielles, opportunité | remplacées par pack `priority-high`, `data_health`, `segment_client` (officielles `priorite`, `donneesPartielles`, `opportunite` **défectueuses**) | Titres / icônes | CASSÉE (source), contournée |
| Contenu | KPI **Sans image, Sans texte alternatif, Sans catégorie, SKU manquant** | aucune | KPI | **MANQUANTE** ×4 |
| Contenu | Chevron de ligne | caractère `›` | Détail | STYLE INCOHÉRENT (P3) |
| Croissance magasin | KPI Part du magasin | pack `local` | KPI | MAUVAISE SÉMANTIQUE (légère) |
| Croissance magasin | KPI Magasins actifs, cartes « Tous les magasins » / Signaux | pack `store-growth` (= icône de menu) | KPI / titres | DOUBLON |
| Croissance magasin | Carte **Actions locales recommandées** | aucune | Titre | **MANQUANTE** |
| Toutes | Boutons Fermer (`×`), flèches `→` (SVG en ligne), menu `…` (SVG en ligne) | caractères / SVG | Contrôles | OK fonctionnellement ; hors pack |

---

## 9. Audit graphiques

| Page | Graphique | Données | Classement | Remarques |
|---|---|---|---|---|
| Vue d'ensemble | Growth Pulse (courbes CA / CA influencé ; courbe visiteurs) | Démo | À AMÉLIORER | Visiteurs et CA influencé impossibles avec les données réelles (P1-2) |
| Vue d'ensemble | Mini-courbes « Croissance magasin » | Démo | DÉCORATIF (en l'état) | Trafic et conversion inexistants |
| Opportunités | Mini-courbes KPI, donut par source, barres par statut, matrice impact / effort, barres segments | Démo | UTILE (en démo) | Donut limité à 4 sources + « Autres » (palette de 5) |
| Campagnes | Revenu vs dépense (courbes), barres par canal | Démo | UTILE (en démo) | — |
| Produits Potentiels | Barres « Produits par statut Growth » | Réel | UTILE | Libellés longs gérés (sans retour à la ligne) |
| Audience | Barre empilée des segments | Réel | UTILE | Partition 100 % garantie ; en mode agrégé, masquée quand l'ordre d'achat est inconnu (pas de barre « 100 % inconnu ») |
| Contenu | Donut par priorité | Réel | UTILE | Total = produits analysés (testé) |
| Contenu | Barres principaux problèmes | Réel | UTILE | Au plus 5 |
| Croissance magasin | Barres semaine courante / précédente, ou courbe seule | Réel | UTILE | Repli en courbe si pas de période comparable. Semaines à 0 vente : barres absentes, axe correct. Pas d'info-bulle (seul `<title>` SVG) |
| Croissance magasin | Magasin vs online (courbes) | Réel | UTILE | Proposé seulement s'il y a des ventes online |
| Croissance magasin | Activité par jour (barres) | Réel | UTILE | Un CA de jour négatif (remboursements > ventes) donne une barre de largeur 0 avec montant négatif affiché : acceptable, non signalé |

Contrôles transverses :
- tous les graphiques SVG ont `role="img"` + `aria-label` ; les valeurs exactes restent lisibles en texte à côté (légendes, montants) ;
- responsive : aucun graphique écrasé ou débordant sur 5 largeurs ;
- avertissement ResizeObserver préexistant (P3-8) ;
- **MANQUANT** : aucun graphique réellement nécessaire ne manque aux pages actuelles.

---

## 10. Audit images / assets

- Images produit :
  - URL Shopify CDN autorisées par la CSP (`img-src https://cdn.shopify.com`) ;
  - `object-fit: cover`, ratios fixes (32 / 40 / 56 px) ;
  - `loading="lazy"`, `referrerpolicy="no-referrer"` ;
  - en cas d'erreur de chargement, remplacement par la vignette « produits » ;
  - `alt=""` justifié : le nom du produit est écrit à côté.
- Aucune image cassée détectée. Le staging n'a **aucune image produit** : vignettes de repli partout, ce qui est honnête mais visuellement pauvre.
- Absence d'image : jamais présentée comme confirmée dans Contenu (contrôle non vérifiable sans preuve). Dans Produits Potentiels et Magasin, la vignette de repli n'affirme rien (titre « Pas d'image synchronisée »). OK.
- Assets à produire réellement : voir § 17.

---

## 11. Audit responsive

Sonde automatique (7 pages × 1440/1280/1024/768/390 × 2 jeux) :

| Problème | Page | Largeur |
|---|---|---|
| **Scroll horizontal de page** | Contenu | **1024** (P2-1) |
| Tableau à défilement interne (voulu) | Vue d'ensemble « Performance par canal » | 390 |
| Tableau à défilement interne (voulu) | Opportunités pipeline, Campagnes tableau | 768, 390 |
| Tableau à défilement interne (non voulu) | Audience « Segments prioritaires » | 1024 (P3-1) |

Aucun texte coupé visible : les seuls éléments « rognés » détectés sont des libellés pour lecteur d'écran, masqués volontairement. Aucun bouton hors écran (hors P2-1). Panneaux de détail en plein écran ≤ 560 px. Menu Plus sans débordement à 390 px.

---

## 12. Audit accessibilité

| Point | Résultat |
|---|---|
| Navigation clavier | Liens et boutons natifs partout ; lignes cliquables = `<button>` |
| Focus visible | Styles `:focus-visible` sur lignes, filtres, Plus, Fermer |
| Panneaux de détail | **Focus non géré** (P2-5) ; `role="dialog"`, `aria-modal`, `aria-label` présents |
| Menu Plus | Focus envoyé et rendu ; pas de piège Tab (P3-7) |
| Boutons sans texte | Tous ont un `aria-label` (sonde : 0 manquant) |
| Contraste | Chips « mute » et texte ardoise sur gris clair ≈ limite AA en petite taille ; Nordla AI dans le panneau Plus peu contrasté |
| Titres | H1 puis H3 (P3-5) |
| Tableaux | Vrais `<table>` pour Opportunités, Campagnes, Audience (prioritaires), Magasin ; listes en grille pour Produits Potentiels, Audience, Contenu (`role="list"` sans `listitem`, P3-6) |
| Graphiques | `role="img"` + `aria-label` ; pas de table alternative (valeurs lisibles en texte) |
| Formulaires | Recherches et sélecteurs avec `aria-label` |

---

## 13. Audit FR / NL / EN

- 762 clés `gr.*` : **0 manquante** en NL et en EN. Aucune clé brute affichée sur les 7 pages × 4 largeurs × 3 langues.
- Mots anglais en FR : « Growth Pulse » (P3-3). « Audience », « Conversion », « Source », « Effort », « Actions » sont des mots français.
- NL identique à EN (14 cas) : « Status », « Product », « Online », « Content », « Demo », « Video » sont des mots néerlandais usuels. OK.
- Pluriels : P3-2 (≈ 15 textes).
- Cohérence terminologique :
  - « Produits Potentiels » (verrouillé), « Croissance magasin » / « Winkelgroei » / « Store Growth » (EN = libellé du menu), « Audience » / « Doelgroep » / « Audience » : cohérents ;
  - statuts « À surveiller » / « Données insuffisantes » : même libellé sur toutes les pages ;
  - « Prioritaire » existe en Audience (segment) et en Contenu (produit) avec deux sens proches.
- Aucun débordement de texte lié à une langue (NL, le plus long, contrôlé à 390 px).

---

## 14. Audit performance

| Mesure | Valeur | Verdict |
|---|---|---|
| JS Growth (7 fichiers de page + shell) | ~135 Ko non minifiés | OK |
| Dictionnaires (3 langues chargées) | ~148 Ko | P3-13 |
| CSS Growth | 41 Ko | OK |
| Requêtes API par page | 1 (la sienne), vérifié par Resource Timing | OK : aucun endpoint inutile ni dupliqué |
| Charge serveur | 4 chargements de 400 jours par tenant + moteur Produits Potentiels recalculé par Magasin | **P2-7** |
| Taille des réponses | Produits Potentiels 12,6 Ko, Contenu 56 Ko (158 produits), autres < 10 Ko | P2-8 pour les gros catalogues |
| Écouteurs | `keydown` document (shell + 3 pages) et `hashchange` ajoutés une seule fois au chargement | OK : pas de doublon |
| Graphiques | Recréés à chaque rendu (changement de filtre ou de langue) : coût négligeable à cette taille | OK |
| Fuite mémoire | Aucune observée (DOM remplacé, pas d'écouteurs par ligne persistants) | OK |

---

## 15. Audit des tests

Suite : 1215 tests verts, dont 107 Growth. Ce qu'elle **ne** couvre **pas** :

1. **Cohérence entre pages** : aucun test ne compare le CA / les unités d'un même produit entre Produits Potentiels, Contenu, Magasin et Audience. Il aurait détecté P1-1.
2. **Responsive réel** : tous les tests DOM tournent sur un faux DOM sans mise en page. Les débordements ne sont détectés que par des passes manuelles ou d'audit (P2-1 a échappé à la validation, faute de contrôle à 1024 px).
3. **États de chargement et d'erreur** : pas de test pour un `fetch` rejeté, un 503 `DATA_UNAVAILABLE`, ou l'affichage pendant le chargement (P2-2, P2-3, P2-4).
4. **Accessibilité des panneaux** : focus à l'ouverture et à la fermeture, piège Tab (P2-5, P3-7).
5. **Menu Plus au clavier** : Échap, clic extérieur, retour du focus, retour navigateur. Vérifiés seulement en navigateur manuel ; les tests couvrent l'ouverture, la fermeture après navigation et l'état actif.
6. **Mocks permissifs** : les graphiques sont simulés par des `div` vides. Un `NaN` ou une série vide passée à un graphique ne ferait échouer aucun test.
7. **Démarrage `serve.js` Growth** : pas de test avec `NORDLA_MERCHANT_ID` (tenant inconnu ⇒ refus, tenant valide ⇒ 4 sources).
8. **Cache des sources** (TTL 5 min) : non testé.
9. **Singulier / pluriel** : non testé.
10. **Démo cohérente** : les tests démo vérifient la cohérence interne de chaque page, pas les comptages partagés entre Vue d'ensemble, Opportunités et Campagnes (P1-3).

---

## 16. Code mort et placeholders

| Élément | Emplacement | Décision |
|---|---|---|
| Données démo | `server/demo-overview.js`, `demo-opportunities.js`, `demo-campaigns.js` | **Rester** jusqu'au branchement réel (décision propriétaire, P1-3) |
| Vignettes de contenu placeholder | `ui/app.js` (carte Performance du contenu) | **Rester** (marqué `PLACEHOLDER`), implémenter plus tard |
| Clé `gr.st.loc.aov` | `lang-*.js` | **Supprimer** |
| Boutons désactivés « Bientôt disponible » : Approuver, `…` Opportunités, + Nouvelle campagne, + Nouveau segment, Créer une opportunité, Améliorer ce produit, Expériences, Nordla AI, Paramètres | divers | **Rester** (implémenter plus tard) ; tous ont une explication (sonde : 0 bouton désactivé sans titre) |
| Contrats d'opportunité (`opportunity`, `opportunities`) dans les réponses des pages réelles | moteurs | **Rester** : contrat pour Opportunités, non consommé aujourd'hui |
| Drapeaux de preuve `image_sync_confirmed` / `collections_sync_confirmed` | `content/content.js` | **Rester** : contrat en attente de Core |
| Utilitaires partagés logés dans des fichiers de page | `opPctRound`, `opDots` (Opportunités), classes `.gr-au-banner`, clés `gr.au.*` / `gr.pp.*` réutilisées | **Déplacer** plus tard dans le shell (P3-11) |
| Captures `docs/growth/*.png` | docs | **Régénérer** ou supprimer (P3-14) |
| CSS inutilisé | — | Aucun (les 4 classes non trouvées sont construites dynamiquement) |
| Assets inutilisés | — | Aucun (31/31 icônes et 5/5 logos référencés) |
| TODO / FIXME | — | Aucun |

---

## 17. Éléments manquants

### Icônes manquantes (liste exacte, style du pack Growth)
1. Produits Potentiels (menu)
2. À protéger / ne pas pousser
3. Réassort avant promotion
4. Actions recommandées (Audience) — et le réexport de l'officielle `actionRecommandee`
5. Actions locales recommandées (Croissance magasin), qui peut être la même icône « actions recommandées » que la n° 4
6. Contenu — Sans image
7. Contenu — Texte alternatif
8. Contenu — Catégorie
9. Contenu — SKU
10. Plus (menu mobile)
11. Réexport des icônes officielles défectueuses : `priorite`, `donneesPartielles`, `opportunite` (en plus de `actionRecommandee`)

### Graphiques manquants
Aucun nécessaire pour les pages actuelles.

### Images / assets manquants
- Icônes ci-dessus.
- Vignettes réelles de contenu (Vue d'ensemble) : dépendent d'une source de contenu, PLUS TARD.
- Captures de documentation `docs/growth` à jour.

### États UX manquants
- Chargement distinct de l'indisponibilité (P2-2).
- Erreur typée + réessai (P2-3).
- Période correcte en chargement / erreur (P2-4).
- Données obsolètes / date de dernière synchro (P2-6).

### Fonctions manquantes (strictement nécessaires à la cohérence actuelle)
- Une règle unique de datation des remboursements pour tous les montants de fenêtre Growth (P1-1).
- Des chiffres démo non contradictoires avec les pages réelles, ou le branchement réel (P1-2, P1-3 ; décision propriétaire).

---

## 18. Recommandations

### À faire avant Expériences
Voir le verdict ci-dessous.

### Après, sans urgence
- P2-6 : fraîcheur des données.
- P2-7 : chargement partagé par tenant.
- P2-8 : pagination.
- Tous les P3.

### PLUS TARD (produit, non requis pour le fonctionnement actuel)
- Brancher Vue d'ensemble, Opportunités et Campagnes sur les moteurs réels, avec consommation des contrats d'opportunité des pages réelles.
- Authentification et mode hébergé du serveur Growth (**obligatoire avant tout déploiement**).
- Provenance de synchro image / collections dans Core (dette enregistrée).
- Normalisation `pos` / `point_of_sale` dans le dossier comptable Finance (dette enregistrée, Finance gelé).
- Analyse horaire en magasin, fréquentation, Google Business Profile.
- Rendre configurables les règles v1 (Audience 90 j / 30 clients ; Magasin ×2 ; Top vente 20 %).
- Liens depuis les cartes de Vue d'ensemble vers les pages.

---

## Verdict avant Expériences

**CORRECTIONS REQUISES**

Points à corriger avant de commencer Expériences :

1. **P1-1** — Unifier la datation des remboursements des montants de fenêtre (Croissance magasin et Audience alignés sur la règle Explorer utilisée par Produits Potentiels et Contenu), avec un test transverse de cohérence entre pages.
2. **P1-2 / P1-3** — Décision propriétaire, puis correction minimale :
   - les pages démo ne doivent plus afficher de métriques que Nordla ne peut pas calculer (visiteurs, conversion magasin, et au minimum leur retrait ou leur marquage « non connecté » sur Vue d'ensemble) ;
   - leurs comptages communs (campagnes, opportunités) doivent être cohérents entre Vue d'ensemble, Opportunités et Campagnes.
3. **P2-1** — Supprimer le scroll horizontal de Contenu à 1024 px, et ajouter 1024 px aux contrôles responsive systématiques.
4. **P2-2 / P2-3 / P2-4** — États partagés du shell :
   - vrai état « Chargement » ;
   - erreur typée (tenant non configuré / données indisponibles) avec réessai ;
   - bonne pastille de période en chargement et en erreur.

   Expériences en héritera directement.
5. **P2-5** — Gestion du focus des panneaux de détail (ouverture, fermeture, piège Tab), composant qu'Expériences réutilisera.

---

## Statut des corrections (2026-09-28, passe « bloqueurs avant Expériences »)

| Point | Statut | Correction |
|---|---|---|
| P1-1 datation des remboursements | **Corrigé** | Sémantique commune `src/metrics/net-sales.js` (A : ventes datées par la commande, nettes de tous leurs remboursements ; B : activité de remboursement datée par le remboursement). Produits Potentiels, Contenu, Audience et Croissance magasin l'utilisent. Doc : `docs/growth/SALES_SEMANTICS.md`. Test transverse : `test/growth-sales-semantics.test.js` |
| P1-2 démo : fréquentation, conversion | **Corrigé** | Vue d'ensemble : trafic et conversion « Non connecté », vue « Visiteurs magasin » = « Fréquentation non connectée », CA magasin = chiffre réel du moteur Croissance magasin (sinon « Donnée indisponible »), insight trafic retiré ; Opportunités : texte « problème de trafic détecté » reformulé |
| P1-3 démo : comptages contradictoires | **Corrigé** | Mis à jour par `fc4f859` : Campagnes est la seule source des chiffres de campagnes (Vue d'ensemble les dérive, badge « Démo ») ; tout autre chiffre démo de Vue d'ensemble et Opportunités est remplacé par « Source non connectée » (générateurs démo déplacés dans `test/fixtures/`) ; Expériences : aucune expérience affichée (« bientôt disponible ») |
| P2-1 Contenu à 1024 px | **Corrigé** | Entre 1024 et 1180 px, la colonne Action est masquée (la ligne ouvre le même panneau). Matrice permanente 1440/1280/1024/768/390 : `test/growth-browser.test.js` |
| P2-2 chargement | **Corrigé** | État « Chargement des données… » distinct |
| P2-3 erreur | **Corrigé** | Erreur typée sûre (boutique non configurée / données indisponibles / serveur injoignable / inattendue) + « Réessayer » |
| P2-4 période | **Corrigé** | Période déclarée dans `PAGES` : identique en chargement, erreur, vide et normal |
| P2-5 focus des panneaux | **Corrigé** | Focus déplacé dans le panneau, Tab / Maj+Tab piégés, Échap, retour du focus au déclencheur ; également pour le menu Plus (P3-7) |
| P2-6 fraîcheur, P2-7 chargement 400 j, P2-8 pagination | Ouvert (PLUS TARD) | — |
| P3 (pluriels, H2, utilitaires, icônes, etc.) | Ouvert, sauf P3-7 | — |

---

## Post-fix verification (2026-09-28)

Vérification de l'état réel du code, pas des descriptions. Branche `feature/growth-platform`, base `fc4f859` (non poussé) + commit de vérification au-dessus.

### Emplacement réel des corrections

| Commit | Contenu |
|---|---|
| `3c7c2cd` | P1-1 (`src/metrics/net-sales.js`, les 4 `facts.js`, `SALES_SEMANTICS.md`, test transverse), P1-2 / P1-3 première passe, P2-1, P2-2 / P2-3 / P2-4 (états du shell, période dans `PAGES`), P2-5 (focus), test navigateur |
| `a441cac` | Tests navigateur : attente de l'état prêt au lieu d'un délai fixe |
| `fc4f859` | Pages démo : Vue d'ensemble / Opportunités honnêtes, Campagnes = source unique, preuves `test/growth-demo-honesty.test.js` |
| commit de vérification | Garde-fou « aucune donnée démo sans badge Démo », garde statique « aucune définition concurrente des ventes nettes », tests navigateur post-fix |

Le working tree était propre avant cette passe : aucune correction n'était restée non commitée.

### Statut des anciens points

| Point | Statut | Preuve |
|---|---|---|
| P0 | Aucun (inchangé) | — |
| P1-1 datation des remboursements | **CORRIGÉ** | `src/metrics/net-sales.js` présent. Test transverse `test/growth-sales-semantics.test.js`, 4 cas (commande avant période + remboursement dans période ; commande et remboursement dans période ; remboursement après période ; aucun remboursement) : Produits Potentiels, Contenu et Croissance magasin donnent le même montant par produit (160 / 160 / 160 / 260 €, total 740 €) ; Audience = montant canonique exact sur sa fenêtre de 90 jours. Activité de remboursement (B) datée par le remboursement : 2 lignes, 200 € (A et B, pas C). Garde statique : aucun moteur Growth n'importe `metrics/sales.js` ni ne recalcule un net ou une datation de remboursement |
| P1-2 démo : fréquentation, conversion | **CORRIGÉ** | Aucun champ visiteurs / fréquentation / trafic / conversion dans les données de Vue d'ensemble ; « Non connecté » pour trafic et conversion dans les 3 cas (ventes réelles, pas de magasin, indisponible) ; Growth Pulse vue trafic : ni chiffre ni courbe (navigateur réel) |
| P1-3 démo : comptages contradictoires | **CORRIGÉ** | Un seul compteur : KPI « Campagnes actives » = puce de la carte Campagnes = lignes « En cours » de Campagnes = données Campagnes (8). Chaque nombre de Vue d'ensemble vient de Campagnes et lui est égal (liste blanche testée) ; Opportunités ne reçoit aucun nombre. **Garde-fou Démo** : le badge suit la définition de page ET tout payload `demo: true` (une page qui oublie son drapeau reçoit quand même le badge, testé par mutation) ; les générateurs démo ne sont importés que par les deux modules dont le payload est marqué `demo: true` |
| P2-1 Contenu à 1024 px | **CORRIGÉ** | Navigateur réel 1440 / 1280 / 1180 / 1024 / 768 / 390 : `scrollWidth <= clientWidth` pour la page et la liste ; aucun contenu textuel rogné par `overflow: hidden` ; aucune zone de défilement interne cachée ; aucune cellule hors de la liste ; la ligne (focusable) ouvre le panneau là où la colonne Action est masquée. Vérifié aussi sur le snapshot staging (158 produits réels), FR / NL / EN × 6 largeurs |
| P2-2 chargement | **CORRIGÉ** | Pour Produits Potentiels, Audience, Contenu et Croissance magasin : vrai état `role="status"`, distinct de l'erreur |
| P2-3 erreur | **CORRIGÉ** | État `role="alert"` distinct, message sûr (aucun détail interne malgré une erreur contenant `token` / `stack`), bouton « Réessayer » qui relance réellement la requête (compteur d'appels +1), puis état vide rendu |
| P2-4 période | **CORRIGÉ** | Même pastille dans les états chargement / erreur / vide / normal : 8 semaines (Produits Potentiels, Contenu, Croissance magasin), 90 jours (Audience), 30 jours déclarés (Vue d'ensemble, Opportunités, Campagnes) |
| P2-5 focus des panneaux | **CORRIGÉ** | Produits Potentiels, Audience, Contenu (tous les panneaux du helper) : `role="dialog"`, `aria-modal="true"`, `aria-label` = titre du panneau ; focus entre à l'ouverture ; Tab et Maj+Tab piégés ; fermeture par Échap, bouton Fermer et clic sur le fond (contrat existant) ; focus rendu exactement au déclencheur ; 6 ouvertures / fermetures sans aucun écouteur `document` / `window` ajouté |
| P2-6 fraîcheur des données | **TOUJOURS OUVERT**, non bloquant | Classé « Après, sans urgence » par l'audit ; hors périmètre de cette passe |
| P2-7 chargement 400 j par source | **TOUJOURS OUVERT**, non bloquant | Idem (performance, sans erreur fonctionnelle) |
| P2-8 pagination | **TOUJOURS OUVERT**, non bloquant | Idem (gros catalogues ; staging 158 produits OK) |
| P3 | Non traités dans cette passe (P3-7 corrigé précédemment) | — |

### Navigation Plus (390 px)
FR / NL / EN : Contenu et Croissance magasin accessibles depuis Plus ; Plus actif (`aria-current="page"`) sur ces pages et inactif ailleurs ; focus dans le menu à l'ouverture ; Échap ferme et rend le focus à Plus ; retour navigateur Croissance magasin → Contenu → Vue d'ensemble correct ; pas de scroll horizontal.

### Icônes / graphiques / assets
Rien créé. Inventaire inchangé (§ 8, § 17) : 10 icônes manquantes, 4 icônes officielles à réexporter (`actionRecommandee`, `priorite`, `donneesPartielles`, `opportunite`), placeholders (menu Produits Potentiels, vignettes de contenu de Vue d'ensemble). Aucun graphique réellement manquant. Aucun nouvel asset cassé : 78 requêtes distinctes sur les 7 pages (1440 et 390, panneaux et menu Plus ouverts), aucune réponse ≥ 400 ni échec de chargement.

### Tests
Suite complète 1241 / 1241 (0 échec, 0 ignoré, tests navigateur inclus) ; tests navigateur 9 / 9 ; tests transverses 15 / 15 ; multi-tenant 114 / 114 + 13 tests tenant Growth.

### Verdict post-fix
**PRÊT POUR EXPÉRIENCES** — aucun P0, P1 ou P2 bloquant ouvert. Restent ouverts et non bloquants : P2-6, P2-7, P2-8 et les P3.

---

## Inventaire exact des pages (correction du 2026-09-28)

Une entrée grisée « Bientôt disponible » n'est **pas** une page. Développement des ventes compte **7 pages construites**, dont 4 sur données réelles.

| Élément | Page construite | Données réelles | Données démo | Simple entrée désactivée | Route / API |
|---|---|---|---|---|---|
| Vue d'ensemble | Oui | Oui (ventes magasin) | Oui (chiffres Campagnes, badge « Démo ») ; le reste « Source non connectée » | Non | `#/` · `GET /api/growth/overview` |
| Opportunités | Oui | Non | Non (aucune source : « Source non connectée ») | Non | `#/opportunities` · `GET /api/growth/opportunities` |
| Campagnes | Oui | Non | Oui (100 %, badge « Démo ») | Non | `#/campaigns` · `GET /api/growth/campaigns` |
| Produits Potentiels | Oui | Oui | Non | Non | `#/potential` · `GET /api/growth/products` |
| Audience | Oui | Oui | Non | Non | `#/audience` · `GET /api/growth/audience` |
| Contenu | Oui | Oui | Non | Non | `#/content` · `GET /api/growth/content` |
| Croissance magasin | Oui | Oui | Non | Non | `#/storeGrowth` · `GET /api/growth/store` |
| Expériences | **Non** | — | — | **Oui** | Aucune (URL directe → Vue d'ensemble ; `/api/growth/experiments` → 404) |
| Nordla AI | **Non** | — | — | **Oui** | Aucune (URL directe → Vue d'ensemble ; `/api/growth/ai` → 404) |
| Paramètres | **Non** | — | — | **Oui** | Aucune (URL directe → Vue d'ensemble ; `/api/growth/settings` → 404) |

Pour Expériences, Nordla AI et Paramètres : aucun fichier de page, aucune définition dans `PAGES`, aucune route, aucun endpoint, aucun code métier. Seuls existent l'entrée de menu désactivée (`aria-disabled`, sans lien), son libellé et son icône de menu. Sur Vue d'ensemble, la tuile « Expériences en cours » et la carte « Expériences » affichent seulement « Bientôt disponible ». Test : `test/growth-unbuilt-entries.test.js`.

Fonctions totalement absentes, prévues plus tard (boutons désactivés ou états « non connecté », aucun code) : moteur d'expériences, recommandations Nordla AI, paramètres Growth, circuit de validation des opportunités, création de campagne / segment / opportunité, attribution du CA influencé, fréquentation et conversion magasin, performance du contenu social, authentification de Développement des ventes.
