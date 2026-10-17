# Bilan du déploiement `sourcing-staging` — correctif français (2026-10-17)

Opération autorisée explicitement par le propriétaire ; un seul déploiement ; rien d'autre modifié.

| Élément | Valeur |
|---|---|
| Commit réellement déployé | `284648e8dd7f9fd0b13c89cc6bc64c8813ee4b19` (branche `release/sourcing-staging`), relevé dans les métadonnées du déploiement |
| Déploiement | `060aa3d6-6b25-4699-807b-90cf97312c09`, SUCCESS, 2026-10-17 17:54 +02:00 ; précédent `add750ce-…` (REMOVED, sur `a7ecccd`) |
| URL de staging | https://sourcing-staging-staging.up.railway.app |
| Avance rapide | `a7ecccd` → `284648e` à 15:48:50 UTC, sans force-push ; aucun déploiement automatique (observé 2 min : la liste des déploiements n'a pas bougé) |
| Déclenchement | `railway redeploy --from-source` (une seule fois) ; le CLI n'a pas pu modifier le champ `source.commitSha` (« No changes to apply ») : il reste `a7ecccd` dans la configuration, sans effet sur le déploiement (le commit construit est bien `284648e`). À aligner dans le tableau de bord si souhaité |
| Retour arrière | prêt, non utilisé : (1) tableau de bord Railway : redéployer `add750ce` si l'option est offerte ; (2) sans force-push : commit local non poussé `c6a30414b2f3ccdff915c94631437cc597aa7705` (fils de `284648e`, arbre identique à `a7ecccd`) à pousser en avance rapide puis `railway redeploy --from-source` |

Contrôles après déploiement (tous PASS) : journaux (Supabase VERIFIED, Core ON, Stock / Achats ON, uid 1000, 0 erreur, 0 secret, 1 démarrage) · `/healthz` 200 · `/healthz/backup` PENDING_FIRST_RUN puis OK (28 fichiers copiés hors serveur à 16:04:57 UTC) · accès : 401 sans session sur `/api/core/modules`, `/api/procurement/*`, `/api/cases`, `/api/core/ask`, 403 sur un POST sans session/CSRF, hôte étranger 404, http→https 301, 5/5 en-têtes de sécurité · correctif français : les 4 fichiers `core/extract/fr.js`, `extract/index.js`, `conversation.js`, `candidate-view.js` servis par staging sont identiques à ceux du commit ; la note de régression de staging donne MOQ 100, délai 15 jours, quantité proposée 100, prix 5 EUR ; contrôle anglais inchangé · variables : mêmes 20 noms, aucun identifiant de production, variables interdites absentes · configuration : empreinte de chaque service et volume (staging et production) identique avant/après · les 8 autres services : mêmes identifiants de déploiement · `main` `a9d0e2f`, `claude/nordla-core-p0` `ebff21e`, `candidate/sourcing-staging-root-config` `a7ecccd` inchangés.
Non vérifié (exige votre connexion) : le parcours connecté, notamment la note française saisie dans l'application, et Finance / Analytics (non raccordés : `MERCHANT_TIMEZONE` absente, voulu).
