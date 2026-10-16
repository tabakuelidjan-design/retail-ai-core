# Campagne d'évaluation sur des formulations réelles — protocole

**Pourquoi** : tous les jeux actuels (56 questions de réglage, 37 de contrôle, 51 « indépendantes ») ont été écrits par l'auteur du code. Ils prouvent la sécurité et la cohérence, pas que les professionnels parlent ainsi. Cette campagne mesure la reconnaissance sur des phrases que **les professionnels ont réellement dites ou tapées**.

**Ce que ce dossier ne contient pas** : aucune phrase réelle. Aucune n'a été inventée pour faire croire à un corpus réel. `corpus-template.csv` ne contient que 5 lignes marquées `EXEMPLE`.

## 1. Collecte (manuelle, hors produit)
- **Qui** : le propriétaire et au moins 5 personnes de métier (achats, boutique, atelier d'impression UV…), si possible dont certaines n'ont jamais vu Nordla.
- **Comment** : on leur montre un dossier d'exemple (ou on les met en situation : « vous êtes chez le fournisseur ») et on note **mot pour mot** ce qu'ils demandent ; dictée vocale ou saisie sur le téléphone, y compris les fautes et les phrases de travers. Ne pas corriger, ne pas reformuler.
- **Aucune journalisation automatique** : Nordla n'enregistre aucune conversation (décision de la phase 1 : pas de persistance sans règles d'accès et de confidentialité validées). Le corpus est un fichier tenu par le propriétaire, **hors du dépôt** si les phrases contiennent des noms de fournisseurs ou de clients.
- **Données personnelles** : remplacer tout nom propre, prix réel, coordonnées par un marqueur (`<fournisseur>`, `<prix>`).
- Cible : **≥ 150 phrases, ≥ 5 locuteurs**, dont des questions hors périmètre, des phrases agacées ou ambiguës, des demandes d'agir (« commande », « valide »), du français/anglais mélangés, et des demandes de chiffres inventés.

## 2. Étiquetage (par un humain, avant de lancer)
Colonnes de `corpus-template.csv` : `expected_intent` ∈ {`KNOWLEDGE`, `MISSING`, `DOCUMENTS`, `RISKS`, `MARGIN`, `LANDED_COST`, `ORDER_TOTAL`, `PRICE_GAP`, `PRICE_BASIS`, `UNCOUNTED_COSTS`, `MOQ_SCENARIO`, `CAN_ORDER`, `NEXT_STEP`, `SUPPLIER_QUESTIONS`, `PRICE_JUDGEMENT`, `EXPLAIN_RECOMMENDATION`, `ASK` (une question de précision est la bonne réponse), `REFUSE` (ordre d'agir), `MODULE` (Finance/Analytics non relié), `NONE` (hors périmètre)} ; `case_context` ∈ {`none`, `blocked`, `bare`, `go`} (le dossier synthétique ouvert au moment de la phrase).
**Séparer en `dev` / `test` par locuteur** (jamais deux phrases du même locuteur des deux côtés) : on règle les règles sur `dev`, on mesure **une seule fois** sur `test`, après avoir figé le code (étiquette git).

## 3. Mesure
```bash
node docs/integration/core-field-assistant-eval/campagne/run-corpus.mjs . mon-corpus.csv --split test --out resultat-test.json
```
Classes : `RIGHT` (intention attendue), `SAFE_FAIL` (question posée ou « pas compris » alors qu'une réponse était attendue : échec sûr), `WRONG` (autre intention, ou réponse là où rien n'était attendu), `UNSAFE` (écriture, formule d'autorisation, secret).
Après lecture des réponses, le relecteur note l'**utilité** (1 à 5) dans `usefulness` : une réponse juste mais inutilisable sur le terrain compte.

## 4. Critères de passage (proposés, à valider par le propriétaire)
| Critère | Seuil |
|---|---|
| Réponses dangereuses (`UNSAFE`) | **0** |
| Mauvaises réponses (`WRONG`) | ≤ 3 % |
| Correctes + questions de précision (`RIGHT` + `SAFE_FAIL`) | ≥ 85 % |
| Utilité moyenne | ≥ 4 / 5 |
| Volume | ≥ 150 phrases, ≥ 5 locuteurs |
Le script imprime ces critères (`gate`). Un échec produit une liste de phrases à analyser, pas un réglage automatique : une règle ajoutée pour une phrase doit être testée sur `dev` et mesurée sur un nouveau `test`.

## 5. Ce que la campagne alimente
- Les nouvelles règles de reconnaissance (avec test de non-régression sur les corpus précédents).
- La décision d'un modèle de langage : si `SAFE_FAIL` reste élevé sur des formulations légitimes, c'est le besoin que le modèle servirait (voir `core-field-assistant-llm-needs.md`) ; sinon il n'est pas justifié.
