# Mise à jour de `sourcing-staging` : correctif français (PR #24) — validation, avance rapide préparée, déploiement et retour arrière (2026-10-17)

**Rien n'est exécuté** : aucun push vers `release/sourcing-staging`, aucun déploiement Railway, aucune migration, aucune donnée ni variable modifiée, aucune fusion supplémentaire. Tous les contrôles ci-dessous ont été faits sur le commit exact.

## 1. Le commit
| Élément | Valeur (relevée sur le dépôt distant) |
|---|---|
| Candidate `candidate/sourcing-staging-fr-extract` | **`284648e8dd7f9fd0b13c89cc6bc64c8813ee4b19`** (fusion de la PR #24, confirmée fusionnée par GitHub) |
| Release active `release/sourcing-staging` | `a7ecccdc49d28def444bb6db0b68865372c55286` (inchangée) |
| Position | candidate **en avance de 5 commits, 0 de retard** ; la release est un ancêtre → **avance rapide possible** |
| Commits en plus | `531446e` correctif, `2cc952d` tests, `3c5920c` rapport, `ebff21e` fusion #23, `284648e` fusion #24 |
| Fichiers modifiés (release → candidate) | **exactement 10** : 2 docs (`docs/CHINA-SOURCING-*-FR-*.md`), 4 sources (`src/sourcing/core/candidate-view.js`, `conversation.js`, `extract/fr.js`, `extract/index.js`), 4 tests (`test/e2e/sourcing-french-note.e2e.js`, `test/e2e/sourcing-terrain-v2.e2e.js`, `test/sourcing-extract-fr-terms.test.js`, `test/sourcing-offered-qty-contract.test.js`) |
| `railway.json`, `deploy/`, `package.json`, `package-lock.json`, `railpack.json` | **inchangés** (aucune dépendance ajoutée) |
| Candidate contre `claude/nordla-core-p0` (`ebff21e`) | un seul fichier diffère : `railway.json` (la configuration de release, voulue) |
| `claude/nordla-core-p0` | `ebff21e`, inchangée ; `main` `a9d0e2f` inchangé |

## 2. Tests exécutés sur `284648e` (Windows, Node 24)
- **Unitaires / contrats** (317 tests : extraction française, contrat de quantité proposée, parcours convergence, Stock/Achats, intégration, routage, Parle à Nordla, modules, identité hébergée, dispatcheur) : **297 réussis, 18 ignorés (PostgreSQL / Node 24 seul), 2 échecs, tous deux connus et sans lien avec le correctif** :
  - `Création without a provider` (`ECONNRESET`) : échec déjà présent sur la base d'origine sur cette machine ; passe en CI Linux.
  - `service-start … every root deployment config starts the dispatcher` : échoue **à l'identique sur la release déjà déployée `a7ecccd`** — c'est la différence voulue du `railway.json` racine de la branche de release (documentée ; ne jamais fusionner en retour dans core-p0).
- **Navigateur (Edge, 390 px), du premier coup** : `sourcing-french-note` **5/5** (nouveau) · `sourcing-terrain-v2` **20/20** (modifié) · `nordla-xiaomi-rehearsal` **10/10** · `nordla-ask-ui` **11/11** · `core-pilot` **5/5** · `nordla-entry` **7/7**.
- **CI GitHub** : aucun workflow ne tourne sur une branche `candidate/**` (aucune exécution sur `284648e`). Preuve de substitution : l'arbre de `284648e` = celui de `ebff21e` + `railway.json`, et `ebff21e` est **vert** : `china-sourcing` (push et PR, run 39039817188 / 39039935098), `nordla-integration-pre-china` (39039817196), `core-reliability` (39039817187).
- **Image Docker construite depuis le commit exact** : se construit ; les couches de base et de dépendances (0–7) sont **identiques** à celles de la release ; seules les couches de code diffèrent. Scénarios en conteneur (secrets factices, Supabase inexistant) : démarrage, `Stock / Achats ON`, `uid 1000`, `/healthz` 200 ; redémarrage propre (SIGTERM) sans perte (fichier de données identique, md5 inchangé) ; plantage (`kill -9`) puis nouveau conteneur sur le même volume : Achats revient, données identiques ; **second conteneur vivant sur le même volume : refusé (`STORE_LOCKED`), le premier intact** ; aucune fuite de secret (0). (Les durées affichées par mon script de test ne sont pas fiables ; les durées mesurées sur les journaux sont celles de `candidat-staging-final-2026-10-17.md`.)
- **Compatibilité** : Core ON, Stock/Achats ON et ses écrans, Parle à Nordla (contrat d'outils inchangé, 10/10 répétition), identité hébergée (8/8) : aucun échec.

## 3. Avance rapide de `release/sourcing-staging` — préparée, NON exécutée
Pré-contrôles à refaire **juste avant** (tout doit être vrai, sinon arrêt) :
1. `git ls-remote origin release/sourcing-staging` = `a7ecccdc49d28def444bb6db0b68865372c55286`.
2. `git ls-remote origin candidate/sourcing-staging-fr-extract` = `284648e8dd7f9fd0b13c89cc6bc64c8813ee4b19`.
3. `git merge-base --is-ancestor a7ecccd 284648e` réussit ; `git diff --name-only a7ecccd 284648e` = les 10 fichiers ; `railway.json`, `deploy/`, `package*.json` sans différence.
Commande (sans `--force` : Git refuse tout ce qui n'est pas une avance rapide) :
`git push origin 284648e8dd7f9fd0b13c89cc6bc64c8813ee4b19:refs/heads/release/sourcing-staging`
Relecture ensuite : `git ls-remote origin release/sourcing-staging` doit donner `284648e…`.
**Attention : la branche de release est suivie par Railway.** Le service a un commit enregistré (`a7ecccd`), mais je ne peux pas garantir qu'un push sur la branche ne déclenche pas un déploiement automatique. **Traiter le push comme l'acte de déploiement** : ne l'exécuter qu'au moment où le déploiement est autorisé, et surveiller la liste des déploiements juste après.

## 4. Plan de déploiement Railway (sur autorisation explicite)
1. Pré-contrôles du §3, et base de comparaison : identifiants de déploiement des 8 autres services (staging `fa598da1`, `5065f9b5`, `7936dc81`, `619d6354` ; production `6c08f418`, `f191ceb0`, `2e59beef`, `6919c217`), déploiement actif de `sourcing-staging` = `add750ce-f54a-4272-81aa-76057c2129b1`.
2. Avance rapide de la branche (§3) ; changer le commit épinglé du service à `284648e8dd7f9fd0b13c89cc6bc64c8813ee4b19` (vous / session Railway) ; un seul déploiement du service `sourcing-staging`.
3. Impact attendu : le conteneur est remplacé ; arrêt propre → bail libéré aussitôt ; volume persistant intact ; **aucune variable, aucune migration, aucune donnée touchée** ; les sessions Nordla sont côté Supabase (elles survivent) ; une sauvegarde automatique repart 10 minutes après le démarrage.
4. Contrôles après déploiement (lecture seule) : déploiement SUCCESS au commit `284648e` ; journal : `Supabase project check … VERIFIED`, `Core ON`, `Stock / Achats ON`, `uid 1000`, 0 erreur, 0 secret ; `/healthz` 200, `/healthz/backup` OK ; `/api/core/modules` et `/api/procurement/*` en 401 sans session ; noms de variables inchangés ; déploiements des 8 autres services = la base de comparaison ; test fonctionnel par vous, connecté : une note fournisseur en français (quantité minimale, délai, quantité proposée) est lue correctement (voir `docs/CHINA-SOURCING-EXTRACT-FR-FIX.md`).
5. Arrêt à tout rouge, rien n'est supprimé.

## 5. Retour arrière vers `a7ecccdc` (sans force-push)
1. **Immédiat** : dans Railway, redéployer le déploiement précédent `add750ce-f54a-4272-81aa-76057c2129b1` (même image que la release actuelle).
2. **Durable** : repointer la source du service sur la branche **`candidate/sourcing-staging-root-config`** (pointe exactement sur `a7ecccd`, immuable) et le commit épinglé sur `a7ecccdc49d28def444bb6db0b68865372c55286`. Pas besoin de réécrire l'historique de `release/sourcing-staging` ; revenir en arrière sur cette branche exigerait un push forcé (interdit sans autorisation spécifique).
3. **Données** : rien à restaurer (aucune migration, magasin additif, volume conservé) ; en cas de doute, sauvegarde chiffrée automatique disponible, restauration indépendante prouvée.
4. **Production** : jamais concernée.

## 6. Verdict
**GO pour la mise à jour staging**, sous réserve de vos autorisations explicites pour : (a) l'avance rapide (qui peut déclencher le déploiement), (b) le changement du commit épinglé, (c) le déploiement. Aucun blocage technique : commit exact vérifié, 10 fichiers attendus, configuration et dépendances inchangées, tests verts hors deux échecs connus et identiques à la release active, scénarios en conteneur réussis, retour arrière sans force-push.
Réserves : aucune CI GitHub sur le SHA exact (substitution : arbre identique à `ebff21e` vert + exécution locale) ; le comportement exact de Railway face à un push sur la branche suivie n'est pas vérifié (§3) ; le parcours connecté (note française saisie dans l'application) reste à constater par vous.
