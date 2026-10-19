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
Couverture Google Shopping uniquement (Amazon et bol n'y figurent pas forcément) ; TVA non précisée par la source ; ni transport, ni droits, ni frais d'import ; résultats variables d'une minute à l'autre ; heuristiques de lots / accessoires / capacités perfectibles (elles signalent, ne suppriment pas) ; cache en mémoire (perdu au redémarrage) ; marché BE par défaut (FR, DE, NL prévus) ; **recherche par texte seulement**.

## Pour la recherche à partir de la photo (non activée)
Le service accepte déjà un champ `identification` (`{ source, bestGuess[], models[], eans[], logos[] }`) qui ne remplit que ce que le dossier ne sait pas et garde la source. Il manque : (1) l'adaptateur Google Vision côté serveur, (2) la route `/api/market/identify` avec consentement explicite pour la photo (celui du chemin `/api/ai/describe` existant sert de modèle ; la région CN est bloquée pour les fournisseurs d'IA), (3) le raccordement du bouton photo à ces deux appels, (4) un test avec de vraies photos sur le Xiaomi. Rien n'est envoyé à un service externe sans autorisation spécifique.

## Pour déployer (décision séparée du propriétaire)
Poser les deux variables sur Railway ; relever `CACHE` de `src/sourcing/ui/sw.js` (le shell hors ligne change) et revoir le test qui l'épingle ; recette sur le Xiaomi ; accès Railway depuis la Chine non vérifié ; **ne pas fusionner en bloc** vers la ligne release (piège `railway.json`, voir NORDLA-MASTER-STATUS.md).
