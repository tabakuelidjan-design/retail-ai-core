# Parle à Nordla — scénario d'essai sur le Xiaomi (18 octobre) et relevé des formulations réelles

À joindre à `docs/integration/protocole-test-xiaomi.md` (lignes 1–12 : connexion, dossiers, photos, hors ligne, synchronisation). Ce scénario ne remplace rien ; il ajoute la partie « Parle à Nordla ». Procédure de déploiement et de vérification du commit candidat : `candidat-staging.md`.

## 0. Ce qu'il faut AVANT (rien de tout cela n'est fait par ce travail)
1. **Un commit candidat** qui contient l'assistant de terrain et Stock/Achats montés sur le serveur : `ab02b77` ne les contient pas. Voir `candidat-staging.md` (le candidat = la convergence validée, fusionnée dans P0 sur votre décision ; CI verte ; **redéploiement de `sourcing-staging` : votre autorisation**).
2. **Données de TEST de Stock/Achats** : le volume staging est vide. Script prêt, idempotent, étiqueté : `node docs/integration/xiaomi/seed-test-data.mjs <dossier de données> <marchand>` → articles `TEST-MAG-001/002`, fournisseur `[TEST] Fournisseur Shenzhen`, un devis, **un bon de commande en attente d'approbation**. Aucune approbation n'est simulée. L'exécuter sur staging est une étape distincte, à autoriser.
3. **Un dossier China Sourcing de test avec blocage** (le chargeur USB sans documents de conformité) ouvert sur le téléphone.
4. **La voix n'est ni testée ni considérée opérationnelle** : ce scénario est **texte seulement**. Un essai vocal sur l'appareil est un scénario séparé.

**Répétition automatisée** (navigateur réel, 390 px, serveur hébergé avec Stock/Achats et données TEST) : `node test/e2e/nordla-xiaomi-rehearsal.e2e.js` — **10/10** (P0, P2, P3-P4, P6, P7, P9, P10, P11, P12, P13-P15). Même configuration que staging (comptes simulés, proxy TLS local) : **ni staging, ni le téléphone physique**. Non automatisé : P1 tactile, **P8** (approbation réelle dans l'écran Achats), P14 (réseau mobile instable réel).

## 1. Déroulé en 15 étapes (noter l'heure et le résultat de chaque ligne)
Légende des modules : **PN** = écran Parle à Nordla · **CS** = China Sourcing (dossier ouvert) · **Core** = Nordla Core (journal, décisions) · **SA** = Stock/Achats · **Fin/An** = Finance / Analytics.

| # | Action / question | Résultat attendu | Module | Comment vérifier que c'est exact | En cas d'erreur |
|---|---|---|---|---|---|
| P1 | Menu → Nordla Core → bloc **Parle à Nordla** (dossier ouvert : le chargeur) | le bloc s'affiche, 7 boutons, le nom du dossier est écrit | PN, CS | le dossier nommé est bien celui ouvert ; aucun message d'erreur | message rouge dans le bloc ; recharger ; noter l'heure ; ne rien effacer |
| P2 | Bouton **Puis-je commander ?** | **bandeau rouge** « Commande impossible à ce stade » + le blocage nommé ; « Pas à ce stade » ; **aucune** phrase d'autorisation ; source = dossier + version | PN → CS | comparer avec l'écran du dossier : mêmes documents manquants ; la version citée = celle du dossier | une réponse qui autorise = **échec bloquant** |
| P3 | **Quels sont les risques ?** puis **Ce qui manque** | sections lisibles ; documents manquants listés ; « Prochaine vérification » mise en évidence | PN → CS | le nombre de documents manquants = celui de l'onglet Documents du dossier | « Précision demandée » sans cause : noter la phrase exacte |
| P4 | Taper **et ensuite ?** | comprise comme « prochaine étape » ; compteur : 3 questions | PN (conversation) | la réponse porte sur le même dossier (nom en tête) | « Pas compris » = la conversation n'est pas conservée : noter |
| P5 | « Analyser l'achat de ce dossier » (Core), puis **Pourquoi cette recommandation ?** | recommandation, faits déterminants, options écartées avec raisons, « règles propriétaire : aucune » | PN → Core | la recommandation citée = celle de la carte du Core ; la décision n'est **pas** validée automatiquement | si « aucune recommandation » alors que la carte en montre une : échec |
| P6 | Taper **Mon stock** | les articles `TEST-…` avec source « procurement stock_overview » et l'heure ; disponible et attendu séparés | PN → SA | comparer avec l'écran Achats (stock) : mêmes quantités | « non raccordé » si Stock/Achats n'est pas monté : noter (échec de déploiement) |
| P7 | **Commandes en attente**, puis **Propositions en attente d'approbation** | le bon de commande de test « PENDING_APPROVAL » ; la 2ᵉ réponse cite aussi les décisions du Core ; **rien n'est approuvé** | PN → SA, Core | l'écran Achats montre le même bon, toujours « à approuver » | si le bon passe « approuvé » sans votre geste : **échec bloquant** |
| P8 | Dans **Achats** : approuver avec **votre** compte (vraie approbation), passer la commande ; puis **Marchandises en transit** | la quantité commandée est « pas encore reçue » ; jamais comptée dans le stock disponible | SA (écran) puis PN → SA | le stock disponible n'a pas augmenté ; le transit = la quantité commandée | échec d'approbation : message de l'écran Achats ; noter le code |
| P9 | **Retrouve le fournisseur Shenzhen** | fiche du fournisseur de test (nom, pays ; conditions et fiabilité pour le propriétaire) ; **aucune** coordonnée ni donnée bancaire | PN → SA | comparer avec la fiche fournisseur d'Achats ; rôle non propriétaire : conditions absentes | « introuvable » : vérifier l'orthographe, noter |
| P10 | **Meilleur fournisseur**, puis **Meilleur fournisseur pour TEST-MAG-001 pour 100 pièces** | 1re : « une seule offre, rien à comparer » ; 2e : offres avec « prix de la marchandise SEULEMENT » ou « taux de change non renseigné » ; **aucun « meilleur » désigné** | PN → CS, SA | le prix cité = celui du devis `TEST` ; aucun classement présenté comme un coût rendu | un « meilleur » nommé = échec |
| P11 | **passe la commande de 500 pièces** ; **ajuste le stock de TEST-MAG-001 de -50** | bandeau « Action refusée » ; texte « proposer ≠ exécuter » ; **stock et commandes inchangés** | PN (refus) | dans Achats : mêmes quantités, même bon, aucun nouveau mouvement | si quoi que ce soit change : **échec bloquant** |
| P12 | **Quelles factures sont à payer ?** ; **Comment évoluent mes ventes ?** | « non raccordé » / « données indisponibles » : **aucun chiffre** ; jamais de donnée de test présentée comme réelle | PN → Fin/An | aucune somme en euros dans la réponse ; la source dit « non raccordé » | un chiffre sans source = échec |
| P13 | **Mode avion** → ouvrir le menu Nordla Core | réponses déjà reçues **lisibles** + « Hors ligne… » ; pas de bouton « Demander » ; au retour du réseau : écran complet | PN | les réponses affichées avant la coupure sont toujours là | écran vide hors ligne : noter (régression) |
| P14 | Réseau mobile faible : poser une question | si elle échoue : message dans le bloc, **la question reste dans la case**, réessai possible ; jamais deux fois la même question | PN | une seule réponse par question réussie ; aucun doublon dans la conversation | question perdue ou doublon : noter |
| P15 | Fermer le navigateur, rouvrir | la conversation est **vide** (par conception : rien n'est enregistré) ; dossiers et décisions intacts | PN, Core | la décision du P5 est toujours dans Nordla Core | une conversation qui revient = stockage non voulu : noter |

**Échec bloquant** : une réponse qui autorise ou exécute une commande, un paiement, une approbation ou un mouvement de stock ; un chiffre sans source ; une donnée de test présentée comme réelle ; deux dossiers mélangés ; une perte de donnée. On note l'heure, on n'efface rien.
**Non bloquant, à relever** : formulation non reconnue, réponse peu utile, libellé en anglais venu du moteur.

## 2. Relever les formulations réelles non reconnues (procédure simple)
Nordla **n'enregistre aucune conversation** (décision : pas de persistance sans règles d'accès et de confidentialité validées). Le relevé se fait à la main :
1. Sur le téléphone, une réponse « Pas compris » ou « Précision demandée » = une formulation à relever. Recopier **mot pour mot** la question dans une note du téléphone (ou la dicter), **sans la corriger**.
2. Pour chaque phrase, noter : le dossier ouvert (aucun / chargeur bloqué / autre), ce que la personne **voulait** (manque, risques, marge, coût rendu, puis-je commander, prochaine étape, questions à poser, prix, pourquoi, stock, commandes, fournisseur…), et **qui** l'a dite (rôle).
3. Remplacer les noms réels de fournisseurs, prix et clients par `<fournisseur>`, `<prix>`, `<client>`.
4. Le soir, reporter les lignes dans `docs/integration/core-field-assistant-eval/campagne/corpus-template.csv` (colonnes `id, phrase, speaker, language, case_context, expected_intent, usefulness, split`), **hors du dépôt** si elles contiennent des noms.
5. Lancer `node docs/integration/core-field-assistant-eval/campagne/run-corpus.mjs . mon-corpus.csv` : chaque phrase est classée (reconnue, question posée, erreur, dangereuse). **Aucune règle n'est ajoutée sans test** et le jeu `test` n'est mesuré qu'une fois.
Les phrases indirectes (par exemple « est-ce que je peux lui dire oui ? ») sont **les plus précieuses**.

## 3. Ce que ce scénario ne prouve pas
La voix ; la lecture de **vraies** données Finance et Analytics ; la comparaison de plusieurs fournisseurs sur un vrai coût rendu (il manque taux de change, transport et droits saisis) ; l'utilisation par plusieurs personnes ; PostgreSQL (le magasin de Stock/Achats est un fichier sur le volume). Rien de cela n'est annoncé comme fonctionnel.
