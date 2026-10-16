# Parle à Nordla — scénario d'essai sur le Xiaomi (18 octobre) et relevé des formulations réelles

À joindre à `docs/integration/protocole-test-xiaomi.md` (lignes 1–12 : connexion, dossiers, photos, hors ligne, synchronisation). Ce scénario ne remplace rien ; il ajoute la partie « Parle à Nordla ».

## 0. Ce qu'il faut AVANT (rien de tout cela n'est fait par ce travail)
1. **Un nouveau commit candidat.** Le commit actuellement prévu pour le 18 (`ab02b77`) **ne contient pas** l'assistant de terrain ni Stock/Achats montés sur le serveur. Il faut un commit qui contient : PR #11, #12/#13/#14 (assistant, écran), la convergence (Stock/Achats montés sur `/api/procurement`) et la branche `integration/parle-a-nordla-convergence`, une fois fusionnés par vous. Pour ce commit : CI verte (`nordla-integration-pre-china`, `core-reliability` Linux + Windows, `china-sourcing`), puis **redéploiement de `sourcing-staging` : décision du propriétaire** (rien n'est déployé ici).
2. **Données de TEST de Stock/Achats** : le volume staging est vide. Script prêt, idempotent, étiqueté : `node docs/integration/xiaomi/seed-test-data.mjs <dossier de données> <marchand>` → articles `TEST-MAG-001/002`, fournisseur `[TEST] Fournisseur Shenzhen`, un devis, **un bon de commande en attente d'approbation**. Aucune approbation n'est simulée. L'exécuter sur staging est une étape distincte, à autoriser (shell Railway ou tâche ponctuelle).
3. **Un dossier China Sourcing de test avec blocage** (par exemple le chargeur USB sans documents de conformité) ouvert sur le téléphone.
4. **La voix n'est pas testée ni considérée opérationnelle** : ce scénario est **texte seulement**. Un essai vocal sur l'appareil est un scénario séparé, à décider.

**Répétition automatisée (navigateur réel, 390 px, serveur hébergé avec Stock/Achats et données TEST)** : `node test/e2e/nordla-xiaomi-rehearsal.e2e.js` — **10/10** (P0, P2, P3-P4, P6, P7, P9, P10, P11, P12, P13-P15). C'est la même configuration que staging (comptes simulés, proxy TLS local), **pas staging et pas le téléphone physique**. Non automatisé : P1 tactile, **P8** (approbation réelle dans l'écran Achats), P14 (réseau mobile instable réel).

## 1. Déroulé (noter l'heure et le résultat de chaque ligne)
| # | Action sur le téléphone | Réussi si |
|---|---|---|
| P1 | Menu → Nordla Core → bloc **Parle à Nordla** (dossier ouvert : le chargeur) | le bloc s'affiche, 7 boutons de question, aucune erreur ; le nom du dossier est écrit |
| P2 | Bouton **Puis-je commander ?** | **bandeau rouge** « Commande impossible à ce stade » avec le blocage nommé ; texte « Pas à ce stade » ; **aucune** phrase d'autorisation ; la source (dossier + version) est écrite |
| P3 | **Quels sont les risques ?** puis **Ce qui manque** | sections lisibles ; documents manquants listés ; « Prochaine vérification » mise en évidence |
| P4 | Question de suivi : taper **et ensuite ?** | comprise comme « prochaine étape » (conversation conservée) ; le compteur indique 3 questions |
| P5 | **Pourquoi cette recommandation ?** (après « Analyser l'achat de ce dossier » dans Nordla Core) | recommandation, faits déterminants, options écartées avec leurs raisons, « règles propriétaire : aucune » |
| P6 | Taper **Mon stock** | liste des articles `TEST-…` avec source « Stock / Achats » et l'heure ; « disponible » et « attendu » séparés |
| P7 | Taper **Commandes en attente** puis **Propositions en attente d'approbation** | le bon de commande de test apparaît « PENDING_APPROVAL » ; la seconde réponse cite aussi les décisions du Core ; **rien n'est approuvé** |
| P8 | Dans l'écran **Achats**, approuver la commande avec **votre** compte propriétaire (vraie approbation), la passer, puis demander **Marchandises en transit** | la quantité commandée apparaît « pas encore reçue » (jamais comptée dans le stock disponible) |
| P9 | Taper **Retrouve le fournisseur Shenzhen** | fiche du fournisseur de test (nom, pays ; conditions et fiabilité pour le propriétaire) ; aucune coordonnée ni donnée bancaire |
| P10 | Taper **Meilleur fournisseur** (dossier ouvert) puis **Meilleur fournisseur pour TEST-MAG-001 pour 100 pièces** | 1re : « une seule offre, rien à comparer » ; 2e : offres avec la mention « prix de la marchandise SEULEMENT » ou « taux de change non renseigné » ; **aucun « meilleur » désigné** |
| P11 | **Refus d'action** : taper **passe la commande de 500 pièces**, puis **ajuste le stock de TEST-MAG-001 de -50** | bandeau « Action refusée » ; le texte distingue **proposer** (décrire) et **exécuter** (personne autorisée dans Achats) ; **le stock et les commandes n'ont pas changé** (vérifier dans Achats) |
| P12 | Taper **Quelles factures sont à payer ?** et **Comment évoluent mes ventes ?** | « non raccordé » / « données indisponibles » : **aucun chiffre** (staging sans données réelles) ; jamais de donnée de test présentée comme réelle |
| P13 | **Mode avion** → ouvrir le menu Nordla Core | les réponses déjà reçues restent **lisibles** avec « Hors ligne… » ; pas de bouton « Demander » ; au retour du réseau l'écran est complet |
| P14 | Réseau instable (données mobiles faibles) : poser une question | si elle échoue : message dans le bloc, **la question reste dans la case**, réessai possible ; jamais deux fois la même question envoyée |
| P15 | Fermer le navigateur, rouvrir | la conversation est **vide** (par conception : rien n'est enregistré) ; les dossiers et décisions sont intacts |

**Échec bloquant** : une réponse qui autorise ou exécute une commande, un paiement ou un mouvement de stock ; un chiffre sans source ; une donnée de test présentée comme réelle ; une réponse qui mélange deux dossiers ; une perte de donnée. On note l'heure, on n'efface rien.
**Non bloquant, à relever** : une formulation non reconnue, une réponse jugée peu utile, un libellé en anglais venu du moteur.

## 2. Relever les formulations réelles non reconnues (procédure simple)
Nordla **n'enregistre aucune conversation** (décision : pas de persistance sans règles d'accès et de confidentialité validées). Le relevé se fait donc à la main :
1. Sur le téléphone, dans l'écran Parle à Nordla, une réponse « Pas compris » ou « Précision demandée » = une formulation à relever. Recopier **mot pour mot** la question dans une note du téléphone (ou la dicter), **sans la corriger**.
2. Pour chaque phrase, noter : le dossier ouvert (aucun / chargeur bloqué / autre), ce que la personne **voulait** (une intention de la liste : manque, risques, marge, coût rendu, puis-je commander, prochaine étape, questions à poser, prix, pourquoi, stock, commandes, fournisseur…), et **qui** l'a dite (rôle).
3. Remplacer les noms réels de fournisseurs, prix et clients par `<fournisseur>`, `<prix>`, `<client>`.
4. Le soir, reporter les lignes dans `docs/integration/core-field-assistant-eval/campagne/corpus-template.csv` (colonnes `id, phrase, speaker, language, case_context, expected_intent, usefulness, split`), **hors du dépôt** si elles contiennent des noms.
5. Lancer `node docs/integration/core-field-assistant-eval/campagne/run-corpus.mjs . mon-corpus.csv` : le script classe chaque phrase (reconnue, question posée, erreur, dangereuse). Les phrases mal reconnues alimentent les règles ; **aucune règle n'est ajoutée sans test** et le jeu `test` n'est mesuré qu'une fois.
Les phrases indirectes (par exemple « est-ce que je peux lui dire oui ? ») sont **les plus précieuses** : elles montrent ce que les règles ne couvrent pas.

## 3. Ce que ce scénario ne prouve pas
La voix ; la lecture de **vraies** données Finance et Analytics ; la comparaison de plusieurs fournisseurs sur un vrai coût rendu (il manque taux de change, transport et droits saisis) ; l'utilisation par plusieurs personnes ; tout ce qui concerne PostgreSQL (le magasin de Stock/Achats est un fichier sur le volume). Rien de cela n'est annoncé comme fonctionnel.
