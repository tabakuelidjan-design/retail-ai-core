# Market radar — « Rechercher les prix en Europe » (China Sourcing)

Branche isolée `feature/market-radar-proof-v0`. **Non déployé, non fusionné.** A0 (`284648e8`) est inchangé.

## Ce que fait la fonction
Depuis un dossier produit, Nordla interroge lui-même Google Shopping (marché belge) via DataForSEO et présente : vendeur, titre, prix, devise, source, date du relevé et lien. Il compare ensuite au prix fournisseur converti au taux BCE du jour. Les preuves sont conservées dans le dossier (`marketSearches[].evidence` + `.radar`), lisibles hors ligne.

Parcours : fiche > « Prix en Europe » > écran Marché > **Rechercher les prix en Europe** (et, en interface héritée, la feuille « Rechercher sur le marché »).

## Fichiers
| Fichier | Rôle |
|---|---|
| `src/sourcing/adapters/market-dataforseo.js` | appel du fournisseur (serveur seulement), erreurs nommées, jamais d'identifiant dans un message |
| `src/sourcing/adapters/market-radar.js` | requêtes depuis le dossier, classement exact / probable / similaire, drapeaux, comparaison BCE (pur, sans réseau) |
| `src/sourcing/server/market-radar-service.js` | point d'entrée contrôlé : plafonds, cache, une recherche à la fois, codes d'erreur |
| `src/sourcing/server/app.js` | routes `GET /api/market/status`, `POST /api/market/search` (mêmes jeton / session / CSRF que le reste ; en mode hébergé, rôle d'écriture requis) |
| `src/sourcing/ui/screens/market-radar-view.js`, `market.js`, `nx.js`, `fieldfirst.js`, `app.js`, `field.css` | écran téléphone |
| `src/sourcing/core/market-search.js` | le dossier garde l'objet `radar` ; les annonces écartées n'entrent jamais dans une fourchette de prix |
| `test/market-radar.test.js` (22), `test/e2e/sourcing-market-radar.e2e.js` (11, navigateur 390 px, fournisseur simulé), `test/e2e/sourcing-market-radar-live.e2e.js` (manuel, fournisseur RÉEL, dépense le crédit d'essai) | preuves |

## Configuration (variables du serveur, jamais dans Git ni dans le navigateur)
`DATAFORSEO_LOGIN`, `DATAFORSEO_PASSWORD` (sans elles : « non configuré », rien n'est envoyé). Optionnelles : `MARKET_MAX_QUERIES` (2), `MARKET_MAX_COST_USD` (0,05), `MARKET_DAILY_MAX` (20), `MARKET_MIN_INTERVAL_SEC` (10), `MARKET_CACHE_HOURS` (24).

## Contrôles de coût et d'abus
Au plus 2 requêtes par recherche ; estimation pessimiste (0,01 $ par requête) comparée au plafond et au solde (appel gratuit) ; solde illisible = refus ; plafond quotidien ; une recherche à la fois ; intervalle minimal ; cache 24 h (la même recherche n'est pas payée deux fois, et l'écran le dit) ; aucune nouvelle tentative automatique (elle serait facturée) ; aucun chemin de rechargement n'existe.

## Rigueur des résultats
- Une annonce sans lien est écartée. Un prix n'existe que s'il est positif avec une devise ISO.
- **EXACT** seulement avec le modèle exact dans le titre (et la marque si connue). **PROBABLE** : mots distinctifs du nom (marque exclue) à 75-100 %. Sinon **SIMILAIRE**. Une ressemblance n'est jamais EXACT.
- Drapeaux, annonces **gardées mais écartées de la fourchette** : lot ou pack (« 5 st. », « 50st. », « 2x »), article promotionnel ou personnalisé (« bedrukken »), accessoire, capacité différente (marge de 12 %), prix aberrant (n ≥ 5, > 2,5 × ou < 0,4 × la médiane des autres). « Capacité non indiquée » est signalée sans écarter.
- Les liens sont étiquetés : **page Google Shopping**, jamais présentée comme un lien direct vers Amazon ou bol.com. Amazon.be / bol.com sont détectés par le **vendeur** nommé, et rapportés séparément (« trouvé dans cette recherche » ou « absent de ces résultats », jamais « non vendu »).
- Calibré sur de **vrais titres** belges du 19/10/2026 (lots néerlandais « 5 st. », collaborations « 1913 x FARM Rio », « avec anse », « met Rietje »).

## Limites connues
Couverture Google Shopping uniquement (Amazon et bol n'y figurent pas forcément) ; TVA non précisée par la source ; ni transport, ni droits, ni frais d'import ; résultats variables d'une minute à l'autre ; heuristiques de lots / accessoires / capacités perfectibles (elles signalent, ne suppriment pas) ; cache en mémoire (perdu au redémarrage) ; marché BE par défaut (FR, DE, NL prévus) ; recherche par texte ou à partir de la photo (voir plus bas).

## Recherche à partir d'une photo du dossier (préparée, isolée, aucune photo envoyée par défaut)

Parcours : fiche > « Prix en Europe » > vignette de la photo > Nordla identifie > recherche automatique > résultats dans la fiche (et conservés dans le dossier avec leur provenance).

### Ce que Nordla fait, dans l'ordre
1. **Code-barres lu sur le téléphone** (`ui/barcode-local.js`) : `BarcodeDetector` du navigateur s'il existe (Chrome Android), sinon un décodeur EAN-13 / UPC-A en JavaScript pur (4 orientations). Un numéro n'est accepté qu'avec une clé de contrôle valide : une lecture douteuse est rejetée, jamais « corrigée ». **Aucune photo ne part.**
2. **Nom du produit à partir du code-barres** (`adapters/gtin-lookup.js`) : bases ouvertes Open Food Facts / Open Products Facts / Open Beauty Facts (gratuites, sans clé). Seul le **numéro** est envoyé. Une fiche trouvée est une proposition sourcée (« ce code-barres est enregistré comme… »), pas la preuve que l'objet photographié est ce produit. Beaucoup de produits non alimentaires n'y figurent pas : « non trouvé » est dit, jamais comblé.
3. **Sans code-barres : Google Cloud Vision** (`adapters/market-vision.js`, désactivé par défaut). Lit le texte de l'étiquette, les logos et propose un nom d'objet. Il **n'identifie pas un produit précis** : un nom « insulated water bottle » est une catégorie, un modèle lu par OCR peut être faux. Tout est étiqueté « proposé par une machine, à confirmer ».
4. **Confiance** : ÉLEVÉE (code-barres valide), MOYENNE (marque et modèle lus), FAIBLE (nom de catégorie : une confirmation en une touche est demandée et la recherche ne cherche que des produits **comparables**), AUCUNE (rien n'est inventé, aucune recherche).
5. Recherche DataForSEO construite automatiquement (marque + modèle, ou nom + quantité, ou code-barres seul en dernier recours) et même classement exact / probable / similaire. Une annonce sans **aucun mot** en commun avec la recherche est signalée « sans rapport » et n'entre dans aucune fourchette ; si rien ne peut être rattaché, **aucune fourchette n'est donnée**.

### Consentement et protection de la photo
- Google Cloud Vision n'est joignable que si le serveur a `GOOGLE_VISION_API_KEY` **et** `MARKET_PHOTO_ENABLED=1`.
- **Propriétaire seulement** (rôle OWNER, vérifié par le serveur).
- Une carte d'accord s'affiche **avant tout envoi**, pour **cette** photo : destination (Google Cloud Vision, États-Unis), taille, coût maximal, empreinte SHA-256. Le serveur recalcule l'empreinte de l'image reçue et **refuse** si elle diffère de l'accord (« CONSENT_MISMATCH »). « Non » n'envoie rien.
- La photo est réduite à 1024 px côté téléphone, jamais conservée ni journalisée par le serveur ; le dossier ne garde que la provenance (source, date de l'accord, empreinte, moteur), jamais les pixels.
- Plafonds : `MARKET_PHOTO_DAILY_MAX` (5), `MARKET_PHOTO_MIN_INTERVAL_SEC` (5), `MARKET_PHOTO_MAX_COST_USD` (0,02 ; estimation 0,0065 $ par photo), une photo à la fois, aucune nouvelle tentative automatique.
- Le serveur nettoie toute identification reçue d'un téléphone : source en liste blanche, numéro de code-barres à clé valide, textes bornés.

### Tests
`test/market-photo.test.js` (decodeur sur pixels, adaptateur Vision, consentement lié à l'image, rôle, plafonds, base ouverte), `test/e2e/sourcing-market-photo.e2e.js` (navigateur 390 px : code-barres, code-barres inconnu, étiquette marque + modèle, produit générique, rien reconnu, erreur Vision, Vision désactivé), `test/e2e/sourcing-market-photo-live.e2e.js` (démonstration manuelle réelle : image de code-barres **synthétique**, lecture locale réelle, recherche DataForSEO réelle, aucune photo envoyée, Vision interdit dans le script). **Google Vision n'a jamais été appelé pour de vrai** (pas de clé) : ses réponses sont simulées dans les tests et étiquetées comme telles.

### Ce qui reste pour une démonstration Vision réelle
Une clé Google Cloud Vision (voir le rapport) et l'autorisation du propriétaire pour envoyer **une photo précise** ; un test avec de vraies photos de fournisseur sur le Xiaomi (le décodeur JS est testé sur des images nettes, pas sur des photos floues ou en perspective).

## Confirmation du modèle ou de la taille (M1) — comparer ce qui est vraiment comparable

Objectif : après la photo et **au plus une** confirmation, Nordla affiche des prix pour des produits réellement comparables, ou dit honnêtement qu'il n'en a pas trouvé. Aucune valeur n'est inventée ni présélectionnée.

### Ce que Nordla utilise automatiquement (sans rien demander)
Photo (code-barres lu sur le téléphone, étiquette, marque, modèle lus par Vision après accord), nom/marque/modèle/caractéristiques du dossier, fiche du code-barres (base ouverte), taille écrite sur l'étiquette **si toutes les tailles trouvées concordent** (40 oz = 1,18 L), et les annonces elles-mêmes. Un modèle lu sur l'étiquette n'est repris automatiquement que s'il n'y en a **qu'un** ; deux modèles différents deviennent une question, jamais « le premier ».

### La question (une seule, `src/sourcing/adapters/market-refine.js`)
- **Taille d'abord** (c'est elle qui déplace le plus le prix), sinon **modèle**. Jamais deux questions.
- Posée seulement si les preuves montrent **au moins deux** tailles (étiquette, ou ≥ 2 annonces par taille) ou **au moins deux** modèles lus. Une taille vue une seule fois n'est pas une preuve suffisante.
- Chaque choix indique sa preuve (« lu sur l'étiquette », « vu dans 7 annonce(s) »). Aucun choix n'est présélectionné. « Je ne sais pas » existe toujours et ne change rien.
- Tant que la question est en attente, **aucune médiane** n'est affichée (les tailles sont mélangées) ; la comparaison avec le prix fournisseur est aussi masquée.

### Après la réponse — comparabilité stricte
Route `POST /api/market/refine` (même authentification, même CSRF ; en hébergé, rôle d'écriture requis) : relecture **locale** des annonces déjà relevées, **zéro appel au fournisseur, zéro coût, aucune photo, aucun identifiant nécessaire** (testé avec un espion réseau). Une annonce est **écartée de la médiane mais reste consultable avec sa raison** si : taille différente ou non indiquée, modèle absent du titre, autre marque ou marque absente, lot/pack, accessoire, promotionnel/personnalisé, prix aberrant. Le résultat est enregistré comme une nouvelle entrée du dossier qui **remplace** la précédente dans les totaux (jamais comptée deux fois) ; l'ancienne reste dans l'historique.

### « Prix de référence non fiable »
La médiane n'est calculée **qu'à partir d'au moins 3 annonces vraiment comparables** (exactes ou probables). En dessous : « Prix de référence non fiable », pas de médiane, les prix comparables listés un par un, et la comparaison avec le prix fournisseur indique qu'elle n'est pas faite. (Ce changement s'applique aussi aux recherches sans confirmation : avant, une seule annonce exacte pouvait fixer « la » médiane, et des produits seulement similaires donnaient une fourchette.)

### Coût
Répondre à la question : **0 $**. Une nouvelle recherche payante n'est proposée (bouton explicite « Chercher avec cette précision (payant) ») que si la réponse n'est pas déjà dans les requêtes et que les résultats restent non fiables ; elle suit les plafonds habituels (`MARKET_MAX_COST_USD`, plafond quotidien, intervalle, cache 24 h). Aucune photo n'est renvoyée.

### Tests
`test/market-refine.test.js` (15), `test/e2e/sourcing-market-refine.e2e.js` (8, navigateur 390 px, fournisseur simulé qui compte ses appels), non-régression `market-radar`, `market-photo`, `market-proof`, e2e `sourcing-market-radar` (11) et `sourcing-market-photo` (10). Limites : fournisseur simulé ; titres et tailles réels à valider sur le Xiaomi (voir `docs/MARKET-RADAR-M1-VALIDATION-XIAOMI.md`). Le modèle n'est pas déduit des annonces (seulement lu sur l'étiquette ou saisi).

## M1 final — variantes génériques, « Autre », groupes homogènes, EXACT vérifié

Ajouts après l'audit indépendant de `e50260f` (aucune règle propre à une marque : les tests synthétiques utilisent « ACME », les tests réels 53 annonces Hydro Flask du 19/10/2026 réduites dans `test/fixtures/market-hydroflask-53.json`).

- **Facettes de question (au plus 2 questions en tout, une à la fois)** : taille, puis **variante**, puis modèle. La variante est **lue dans les titres réellement observés** : mots qui s'excluent mutuellement (aucun titre n'en porte deux), vus dans ≥ 2 annonces dans le périmètre (hors lots, accessoires, promos, sans rapport), dont les groupes diffèrent de **plus de 10 % en prix médian**. Les couleurs échouent au test du prix et ne sont jamais demandées. Chaque facette n'est demandée que si elle change le prix.
- **« Autre » et saisie libre** pour chaque question (taille : « 64 oz », « 1,89 L » ; variante : quelques mots ; modèle : référence). Une taille saisie doit porter son unité et être sans ambiguïté, sinon elle est refusée avec un message et rien n'est enregistré. **« Je ne sais pas »** est mémorisé : la même facette n'est plus jamais redemandée, et aucun filtre n'est ajouté.
- **PROBABLE avec un nom de catégorie** : une marque connue + une taille vérifiée + le même type de produit suffisent (les mots de catégorie — bottle, fles, bidon, gourde, flask… — sont des synonymes, pas des identifiants). Une taille confirmée se compare à ±4 % (946 ml n'est pas 1 L).
- **Statistiques séparées par classe ET par groupe homogène** (une taille, une variante) : exactes et probables ne sont jamais mélangées ; un prix de référence unique n'existe que s'il y a exactement **un** groupe fiable dans la meilleure classe ; plusieurs groupes fiables = un prix **par groupe**, pas de médiane globale. Seuil inchangé : **3 annonces comparables minimum par groupe**, sinon « Prix de référence non fiable » et les annonces/prix présentés un par un.
- **EXACT** uniquement avec le modèle dans le titre (+ la marque si connue) ; une variante que le titre énonce et que le propriétaire n'a pas confirmée ramène l'annonce à PROBABLE (« variante non confirmée »). Sans marque reconnue : jamais EXACT sans modèle. « **Aucun produit exact trouvé** » est affiché explicitement.
- **Exclusions des prix de référence, toujours listées avec leur raison** : accessoires (groupe « Accessoires — exclus des prix »), lots/packs (groupe « Lots et packs — hors prix de référence » avec un **prix à la pièce estimé**, marqué estimation), autres marques, autres tailles/variantes, promotions personnalisées, prix aberrants.
- **Chaque annonce** : « relevé le … sur Google Shopping · **disponibilité non vérifiée** ».
- **Stockage** : 60 annonces gardées dans le dossier (une recherche réelle en renvoie ~53) ; l'étape de réponse relit **toutes** les annonces stockées.
- **Coût** : répondre, saisir « Autre » ou dire « Je ne sais pas » = 0 $ (zéro appel au fournisseur, vérifié par espion). Une nouvelle recherche payante reste un bouton explicite, plafonné, mis en cache à paramètres identiques.
- **Limites** : le modèle n'est pas déduit des annonces (étiquette ou saisie) ; une facette « variante » peut être un faux positif (ex. une gamme de produits) : la réponse « Je ne sais pas » est toujours possible ; avec moins de 6 annonces dans le périmètre aucune variante n'est détectée.
- **Tests** : `test/market-m1-final.test.js` (19, dont les 8 scénarios et les 53 annonces réelles), `test/market-refine.test.js`, e2e 390 px `sourcing-market-refine` (11).

## M1 correctifs G1 / G2 / G4

- **G1 — titres incomplets** : une annonce sans nom de contenant (« Hydro Flask Wide Mouth 710 ml ») devient PROBABLE dès qu'une **marque connue** est dans le titre **et** qu'une **taille ou un poids vérifié** (ou une **variante confirmée**) y figure, sans type contradictoire. Confiance **LOW** et raison « type de produit non précisé dans le titre (prudence) » quand le titre ne dit pas le type. Jamais EXACT sans le modèle. Un nom de cas réduit à la marque seule n'identifie rien : il ne rend plus « probable » toute annonce de cette marque.
- **G2 — types de produit génériques** (`TYPE_FAMILIES` dans `market-radar.js`) : gourde / bouteille (bottle, fles, bidon, gourde…), gobelet de voyage (tumbler, beker, gobelet, mug…), cruche / carafe. Les mots de la marque sont retirés d'abord (« Hydro Flask » n'est pas une « flask »). Un titre qui nomme deux familles ou aucune a un type **indéterminé** : jamais exclu pour son type, jamais présumé identique. Si le type du produit est connu (nom du cas ou réponse), une annonce d'un **autre type** est écartée des prix (« autre type de produit », listée). Si le type est inconnu, les statistiques sont **par type** (jamais de médiane commune) et une question « De quel type de produit s'agit-il ? » est posée seulement si deux types ont chacun ≥ 2 annonces et des prix médians qui diffèrent de plus de 10 %.
- **Variante** : une valeur doit être vue dans **au moins 3 annonces** (un groupe de moins de 3 ne donnerait jamais de prix), il faut **au moins 6 annonces** dans le périmètre, et les valeurs doivent être des **alternatives du même emplacement** (un mot voisin commun, ex. « wide **mouth** » / « standard **mouth** » ; « mouth » contre « flex » est rejeté). Les noms de pièces (cap, lid, straw…) ne sont jamais une variante.
- **Ordre des questions** (2 au plus) : taille, type, variante, modèle.
- **G4 — extraction technique** : les gestionnaires photo / Market Radar de `ui/app.js` sont déplacés **sans changement de comportement** dans `ui/market-controller.js` (mêmes clés d'état `S.market*`, mêmes routes, mêmes événements `MARKET_SEARCH`, même flux de consentement). `app.js` repasse sous la garde de 520 lignes (519 avec le retour final ; marge d'une ligne).

## M1 correctifs H1 / H2 / H3

- **H1** : la phrase « si la bonne n'y est pas, écrivez-la dans « Autre » » n'apparaît que pour une question qui a réellement un champ « Autre » (la question de type, liste fermée, n'en a pas et ne le promet plus).
- **H2 — « Préciser » permanent** : dès qu'un résultat existe, une section repliable « Préciser la taille, le modèle ou la variante » (trois champs libres) permet de saisir ces valeurs même sans question automatique. Mêmes validations serveur que « Autre » (taille avec unité et sans ambiguïté ; modèle ; mots de variante), **relecture locale gratuite** des annonces déjà relevées (aucun appel payant, aucune photo), aucune question consommée (la limite de 2 questions automatiques reste entière), une valeur nouvellement saisie remplace la précédente pour la même facette, une valeur non comprise est refusée avec le nom de la valeur concernée et rien n'est enregistré.
- **H3 — prix indicatifs** : une annonce n'est **jamais** promue « probable » sur la seule base de la marque et du type. À la place, les annonces **similaires** encore dans le périmètre sont résumées **par famille de type** (au moins 3 par famille ; jamais de mélange entre familles) sous « Prix indicatifs par famille — pas un prix de référence » (min – médiane – max, « similaires », « pas le même produit »). Ce n'est **jamais** un prix de référence : il n'alimente ni la comparaison avec le prix fournisseur ni les groupes exact / probable ; il ne s'affiche pas quand les annonces sont comparables. La carte de la question de type annonce désormais exactement ce que la réponse montrera (« 4 annonce(s) retenue(s) · prix médian indicatif 42,68 € », calculé après les mêmes exclusions : lots, accessoires, autres types, prix aberrants). Le prix de référence réel reste soumis au minimum de **3 annonces homogènes**.

## Pour déployer (décision séparée du propriétaire)
Poser les deux variables sur Railway ; relever `CACHE` de `src/sourcing/ui/sw.js` (le shell hors ligne change) et revoir le test qui l'épingle ; recette sur le Xiaomi ; accès Railway depuis la Chine non vérifié ; **ne pas fusionner en bloc** vers la ligne release (piège `railway.json`, voir NORDLA-MASTER-STATUS.md).
