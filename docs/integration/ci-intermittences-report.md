# Intermittences de la CI : `creative-refine` RF-2, `growth-browser`, `creative-e2e-parity` — constats et rapport pour les chantiers responsables (2026-10-16)

**Aucun test n'a été désactivé, aucune couverture réduite, aucun fichier Création/Growth modifié.** Une réussite après relance **ne prouve pas** que le défaut a disparu : elle prouve qu'il est intermittent. Les causes ci-dessous sont des **hypothèses** classées par ce que les journaux CI montrent réellement.

## 1. Occurrences observées (journaux CI de cette journée)
| Test | Échecs observés (commit · workflow) | Le même code a réussi… |
|---|---|---|
| `creative-refine` RF-2 (Node 24, Linux) | `03f6e2d` (PR #14) · `7edfc7d` (PR #11, avant mes changements de cette branche) · `ab0ec10` (PR #14) · `7b2f95f` (intégration) | à la relance de `03f6e2d` et de `ab0ec10` ; dans `nordla-integration-pre-china` sur `7b2f95f` ; 29/29 deux fois en local |
| `growth-browser` (exit 124 = plafond de 1500 s par fichier) | `b7ef3f7` (**P0**, commit documentaire d'un autre chantier) · `03f6e2d` · `c7bc401` · `7b2f95f` (tous `core-reliability` Linux) | dans `nordla-integration-pre-china` sur les mêmes commits ; `c7bc401` à la 3ᵉ tentative |
| `creative-e2e-parity` « Legacy non-regression… » | `e08d98d` (**tête actuelle de la convergence, avant la PR #15**) · `3bb8a78` · `c7bc401` | 4/4 en local ; relances suivantes |
Ces échecs touchent aussi des commits **ne contenant aucun fichier de ces modules** (P0 `b7ef3f7`, convergence `e08d98d`) : ils ne sont donc pas causés par les travaux de Parle à Nordla.

## 2. Ce que les journaux montrent (faits)
- **`growth-browser`** : le test échoue **à 10 s** (« 6 pages × 1440/1280/…/320 », 10 193 ms), puis le fichier **reste vivant jusqu'au plafond de 1500 s** (« test/growth-browser.test.js 1500s (exit 124) »). La fin du job signale « Terminate orphan process : chrome ». Donc : (1) un échec réel et rapide ; (2) **le navigateur n'est pas arrêté sur le chemin d'échec**, ce qui transforme un échec de 10 s en 25 minutes de CI.
- **Durées** : RF-2 s'exécute en 131 s dans son fichier, d'autres fichiers Création en 100–236 s : ces fichiers sont très chargés en calcul d'image et tournent **4 à la fois** (`xargs -P`) sur le même exécuteur.
- **Mesure locale (même fichier, machine partagée avec d'autres chantiers)** : `creative-refine.test.js` = **645 s** pour 29/29 réussis, contre **131 s** en CI : la durée varie d'un facteur ≈ 5 selon la charge, ce qui est cohérent avec une sensibilité à la contention (hypothèse 3), sans la démontrer.
- Le workflow n'imprime que le **titre** du test en échec, pas son message d'assertion : la cause exacte n'est pas observable dans la CI actuelle.

## 3. Causes possibles (hypothèses, à tester)
1. **`growth-browser` — port de débogage aléatoire** : `9400 + Math.floor(Math.random() * 400)` (ligne ~38 du test). Deux navigateurs lancés en parallèle par d'autres fichiers, ou un navigateur résiduel, peuvent occuper le même port : le test lit alors la liste `/json` d'un **autre** navigateur et pilote la mauvaise page. Les autres tests de navigateur du dépôt utilisent un port libre garanti (`freePort()`).
2. **`growth-browser` — nettoyage absent sur échec** : si la fermeture du navigateur n'est pas dans un `finally`, un échec laisse le processus (et donc le fichier) vivant jusqu'au plafond.
3. **Création (RF-2, parity) — contention de ressources** : tests déterministes en théorie (hachages d'images), qui échouent seulement sous charge ; possibilités : mémoire/threads du moteur d'image sous 4 fichiers lourds en parallèle, dépendance à l'ordre ou au temps dans la construction des fixtures asynchrones. **Non démontré.**
4. **Défaut d'observabilité** : sans message d'assertion en CI, on ne distingue pas un vrai écart de hachage d'un délai dépassé.

## 4. Expériences proposées (pour les chantiers Création et Growth ; rien n'est modifié ici)
1. **Mesurer le taux d'échec** : boucle de 20 exécutions de chaque fichier, une fois seul (`-P1`) et une fois avec 3 autres fichiers lourds en parallèle (`-P4`), via `workflow_dispatch` ; comparer. Une différence nette confirme la contention (hypothèse 3).
2. **Rendre l'échec lisible** : faire imprimer par le workflow les 40 premières lignes de la sortie du fichier en échec (fichier de workflow : chantier A) ; conserver la sortie complète en artefact.
3. **Growth** : port libre garanti (`freePort()`), fermeture du navigateur dans un `finally`, plafond de fichier court pour ce test. Vérifier par 50 exécutions sans échec ni orphelin.
4. **Création** : à la première reproduction, noter la valeur attendue et la valeur obtenue du hachage ; si elle varie d'une exécution à l'autre, chercher la source de non-déterminisme (concurrence, ordre de résolution, horloge).
5. Critère de clôture proposé : **0 échec sur 50 exécutions sous charge**, pas « vert après relance ».

## 5. Effet sur les décisions de fusion de cette journée
Les fusions ont été décidées sur les workflows **du commit exact**, avec relance du job en échec lorsque l'échec nommait uniquement l'un de ces tests, et seulement après avoir vérifié que le diff ne contenait aucun fichier de ces modules. Ce n'est pas une garantie : c'est une dette de fiabilité à rembourser (§4).
