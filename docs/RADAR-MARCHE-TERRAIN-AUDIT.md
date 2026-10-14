# Radar Marché Terrain — audit des accès et architecture proposée (AVANT implémentation)

Statut : **proposition, rien n'est implémenté.** Branche `feature/china-sourcing-mobile-ux-v2`, rien n'est fusionné.
Limite de cet audit : l'environnement de travail n'a **pas d'accès sortant** vers les fournisseurs (essai de lecture des documentations officielles Amazon et bol : refusé). Les faits ci-dessous viennent de résultats de recherche (extraits) ; chaque ligne est marquée **[vu]** (vu dans un extrait officiel ou vendeur) ou **[à vérifier]**. Aucune API n'a été appelée : **aucun résultat réel n'existe encore**, et aucun résultat simulé ne sera présenté hors tests.

## 1. Deux niveaux, strictement séparés
| | Niveau A — Radar Marché Terrain | Niveau B — Étude d'importation (existant, conservé) |
|---|---|---|
| Entrées | nom, marque/modèle, prix+devise, MOQ, caractéristiques (confirmées OU proposées, étiquetées), photo | + transport, douane, documents, prix de vente, marge, fabricant |
| Moteurs | nouveau module `core/radar/` (requêtes, rapprochement, synthèse) | `assess`, `landed`, `decision`, `evidence-status`, règles UE : **inchangés** |
| Bloque ? | jamais par un coût/document manquant | oui (comme aujourd'hui) |
| Sortie | observations de marché + présélection (4 libellés) | verdict d'achat, conformité |
Règle de code : le Radar **ne lit pas** `evidenceStatus` / `hardBlockers` ; la fiche affiche le Radar en tête, et l'ancien bandeau rouge est renommé « Étude d'importation » (parcours approfondi). Une recherche n'écrit **jamais** de fait confirmé, de conformité ni de décision d'achat.

## 2. Audit des accès (ce qui est réellement utilisable)
| Source | Rôle | Accès / conditions | Prix indicatif | Verdict |
|---|---|---|---|---|
| **Détection de code-barres sur l'appareil** (BarcodeDetector, Chrome Android) | EAN/GTIN lisible sur la boîte | aucun compte, rien n'est envoyé | gratuit | **Étape 0 de toute recherche photo** [à vérifier sur le Xiaomi] |
| **Google Cloud Vision — Web Detection** | photo → entités web, pages contenant l'image, images visuellement proches, meilleure estimation | clé de projet GCP, côté serveur ; renvoie des **pages**, pas des prix | 1 000 gratuits/mois puis ≈ 3,50 $ / 1 000 images **[vu]** | **Recommandé** pour le chemin IMAGE officiel (graine de requêtes + domaines marchands) |
| Google Vision — Text/Logo detection | OCR d'étiquette, logo de marque | idem | ≈ même ordre **[à vérifier]** | recommandé, résultats OCR = **propositions** |
| **eBay Browse API** `searchByImage` | photo → annonces **avec prix** | sandbox libre ; **production soumise à approbation et contrat** ; `searchByImage` limité à US, DE, GB, AU **[vu]** (pas FR/NL) | gratuit (quotas) **[à vérifier]** | utile en complément (DE) ; accès non immédiat |
| eBay Browse (texte/GTIN) | prix annonces UE | même approbation | idem | complément |
| **Amazon** | prix Amazon BE/FR/DE/NL | **PA-API 5 retirée mi-mai 2026 → Creators API** ; compte Associés approuvé, seuil de ventes qualifiantes (≈10 / 30 j d'après un guide tiers) **[vu / à vérifier]** ; pas de recherche par image | gratuit sous conditions | **Faisable seulement si vous avez un compte Associés actif avec ventes** ; sinon via fournisseur tiers |
| **bol (NL/BE)** | prix bol | « Marketing Catalog API » réservée aux **affiliés inscrits** **[vu]** ; API Retailer = vendeurs partenaires | gratuit (affilié) **[à vérifier]** | **Faisable avec un compte affilié bol** ; recherche texte/EAN, pas image |
| **Google Lens / Shopping via tiers** (SerpApi, DataForSEO, Apify…) | photo ou texte → annonces marchandes multi-sites **avec prix, vendeur, pays** | clé du prestataire ; Google interdit le scraping, le prestataire porte le risque ; Lens ne renvoie plus l'URL directe de l'image, seulement la page **[vu]** | ≈ 0,6–2 $ / 1 000 (SERP) à ≈ 10 $ / 1 000 ou 25–75 $/mois (SerpApi) **[vu, sources divergentes]** | **Seul chemin rapide vers « mêmes produits + prix » Amazon/bol/boutiques UE** ; **décision de risque juridique pour vous** |
| Keepa (Amazon, historique par EAN/ASIN) | prix Amazon datés | abonnement payant, CGU autorisent l'usage API | €/mois **[à vérifier]** | option phase 2 |
| Icecat / GS1 / Open data | identité produit par EAN | gratuit/partiel **[à vérifier]** | — | option (preuve d'identité) |
| Scrapers de pages bol/Amazon (Apify…) | prix | contraires aux CGU des sites | — | **exclus** |

## 3. Recommandation technique
1. **Phase 0 (sans aucune clé, je peux la livrer)** : séparation A/B, modèle de données, constructeur de requêtes (6 familles), détection EAN sur l'appareil, recadrage, consentement, moteur de rapprochement déterministe, synthèse, écran Nordla, conservation hors ligne, fournisseurs **simulés réservés aux tests**. En production sans clé : état réel **« non configuré »**, jamais de faux résultat.
2. **Phase 1 (clés requises)** : Google Vision Web Detection (IMAGE) ; **un** fournisseur de résultats marchands avec prix : (a) Creators API Amazon + Marketing Catalog bol si vous avez les comptes, **ou** (b) SerpApi/DataForSEO Google Lens + Shopping si vous acceptez le risque CGU ; eBay en complément quand l'approbation arrive.
3. **Phase 2** : Keepa, Icecat/GS1, conversions datées plus fines.
Ordre d'accès par chemin : IMAGE = EAN local → Vision/Lens → annonces ; TEXTE = requêtes → catalogues ; HYBRIDE = IMAGE **puis** enrichissement TEXTE (le texte complète, ne remplace pas).

## 4. Architecture
```
téléphone (PWA)                         serveur Nordla (clés ici, jamais dans le navigateur)
 fiche → « Rechercher les prix en Europe »
 photo → recadrage → EAN local            POST /api/radar/search {runId, mode, queries, photo?}
 consentement explicite (liste exacte ─►  adaptateurs : vision | lens | amazon | bol | ebay | shopping
   de ce qui part, par fournisseur)         état par fournisseur : NOT_CONFIGURED | OK | EMPTY | UNAVAILABLE | RATE_LIMITED | UNSUPPORTED
 résultats ◄──────────────────────────── résultats normalisés + provenance {fournisseur, requestId, consultéLe, url}
 cas.radar (append-only, synchronisé, hors ligne)
```
- **Données** : `case.radar.runs[]` (entrées figées : requêtes, hash de la photo, caractéristiques *avec leur statut confirmé/proposé*, état de chaque fournisseur, résultats), `case.radar.keep[]` (annonces gardées), `case.radar.disposition` (`À approfondir | À comparer plus tard | Écarté`, décision du propriétaire, historisée). La photo originale reste dans le dossier ; le recadrage est une copie.
- **Requêtes** (toutes générées depuis le dossier, sans ressaisie) : marque+modèle exact · EAN/GTIN · nom+marque · catégorie+puissance+capacité+… · synonymes FR/NL/EN (table déterministe). L'absence de modèle ne bloque pas les requêtes « similaires ».
- **Rapprochement (déterministe, versionné, testé)** : **Même produit** = GTIN identique, ou marque+modèle exacts retrouvés dans l'annonce, sans écart technique ; **Correspondance probable** = marque/modèle partiels ou fort accord visuel + caractéristiques compatibles, identité non établie ; **Produit similaire** = même usage/caractéristiques principales, **différences listées**. Un écart sur une caractéristique clé (capacité, puissance, nombre de sorties…) **interdit** « même produit ». Chaque résultat porte : points communs, différences, niveau de fiabilité. Un résultat visuel seul n'est jamais « même produit ».
- **Synthèse de potentiel** (4 libellés) : règle explicite, seuils dans la configuration marchande (pas dans le code), justifiée par les observations (nombre, sources, dates, fourchette, prix converti à la date ECB, statut TVA). L'écart « prix fournisseur / prix de détail » est affiché comme **écart brut**, jamais comme marge. « Aucun résultat » ≠ « produit inexistant ». Résultats > N jours : marqués obsolètes ; sources contradictoires : signalées.
- **Sécurité** : clés en variables d'environnement du serveur ; le serveur n'appelle un prestataire que si le consentement du run le couvre ; journal des appels sans photo ; CSP inchangée (`connect-src 'self'`) ; Shopify/HABB intouchés.
- **Interface** : action « Rechercher les prix en Europe » (fiche) et « Rechercher avec cette photo » (après photo, et sur chaque photo du dossier) ; feuille de consentement ; recadrage ; résultats en trois sections avec photo/prix/pays/lien/date ; puces d'état par fournisseur (réel) ; Ouvrir l'annonce · Affiner · Ajouter/corriger une caractéristique · Relancer · Enregistrer ; marquage À approfondir / À comparer plus tard / Écarté. Aucun passage par « Analyses expertes ».

## 5. Plan de tests (les 12 demandés)
Fournisseurs simulés **uniquement dans `test/`** : nom+prix seuls ; prix+MOQ+puissance+capacité ; modèle précis retrouvé ; similaire mais capacité différente (jamais « même ») ; sans transport ; sans documents ; devise non confirmée (écart non calculé) ; aucun résultat ; fournisseur indisponible/limité (état affiché tel quel) ; contradictoire/obsolète ; écran Xiaomi (360–430 px) ; hors ligne (résultats et dossier conservés). Puis **test réel** sur batterie externe : photo seule, puis photo + modèle + puissance + capacité — **à exécuter sur votre machine/serveur avec vos clés** (cet environnement ne peut pas joindre les fournisseurs).

## 6. Décisions et accès dont j'ai besoin
1. **Risque CGU** : acceptez-vous un prestataire Google Lens/Shopping (SerpApi, DataForSEO…) pour obtenir rapidement les prix multi-sites ? Sinon, seul Amazon (Creators API) + bol (affilié) + eBay seront disponibles, avec moins de couverture et sans recherche par image sur Amazon/bol.
2. **Comptes existants** : Associés Amazon (BE/FR/DE/NL) actif avec ventes ? compte affilié bol ? projet Google Cloud (Vision) ? compte développeur eBay ?
3. **Budget** par recherche / par mois ; quotas à respecter.
4. **Convention TVA** pour la comparaison (prix TTC de détail vs HT) et seuils de présélection par défaut (proposés « à valider »).
5. **Exécution** : où tourne le serveur Nordla (accès sortant), pour les tests réels.
Je peux démarrer la **phase 0** immédiatement (aucune clé) ; la phase 1 dépend des réponses 1–3.
