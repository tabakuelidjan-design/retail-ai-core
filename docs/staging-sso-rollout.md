# Déploiement staging — SSO Core → Finance / Analyses (clés dédiées)

Statut : **proposition, non appliquée**. Aucun déploiement, aucune variable Railway modifiée à ce stade.

## 1. Branches et SHA (état vérifié le 19/11/2026)

| Service staging | Branche release (suivie par Railway) | Tip actuel (distant) | Intégration proposée (locale, non poussée) | Fusion |
|---|---|---|---|---|
| Core / Sourcing | `release/sourcing-staging` | `ded968e5` | `integration/sourcing-sso-candidate` | propre |
| Finance | `release/finance-staging` | `ff3c597b` (commits d'autres sessions) | `integration/finance-sso-candidate` | 2 conflits résolus (ligne SSO de `finance/server/index.js` ; `test/finance-sso.test.js` = version de la branche SSO) |
| Analyses | `release/analytics-staging` | `2c3e92a4` | `integration/analytics-sso-candidate` | propre |

Branche source des changements : `feature/nordla-sso-contract-phase2` @ `7bad1318` (poussée).

## 2. Variables et correspondance (noms uniquement)

| Module | Côté service qui vérifie | Côté Core qui signe | Règle |
|---|---|---|---|
| Finance | `FINANCE_SSO_KEY` (service Finance) | `FINANCE_SSO_SECRET` (service Sourcing/Core) : **référence** à `FINANCE_SSO_KEY` | même valeur, distincte du jeton tableau de bord |
| Analyses | `ANALYTICS_SSO_KEY` (service Analyses) | `ANALYTICS_SSO_SECRET` (service Sourcing/Core) : **référence** à `ANALYTICS_SSO_KEY` | même valeur, distincte de tout jeton, distincte de la clé Finance |

Génération : `node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"` (43 caractères). Une clé différente par module.

**Nom de variable côté Analyses** : le service lit désormais `ANALYTICS_SSO_KEY`. L'ancien `ANALYTICS_SSO_SECRET` côté service n'est plus lu ; il reste utilisé côté Core.

## 3. État actuel des clés (vérification)

- Je n'ai pas accès à Railway : **les valeurs actuelles n'ont pas été lues**. Statut : **non vérifié**.
- Pour vérifier sans afficher la valeur, sur un shell disposant de la variable (ou d'une copie privée) :
  `node scripts/check-sso-key.mjs FINANCE_SSO_KEY` (et de même pour les autres). Réponse attendue : `OK`.
  Toute autre réponse (`SSO_KEY_MISSING`, `SSO_KEY_TOO_SHORT`, `SSO_KEY_BAD_ENCODING`) = clé à régénérer.
- Une clé existante issue de l'ancienne règle (24 caractères, ou égale au jeton) **ne passe pas** : SSO reste désactivé jusqu'à régénération.

## 4. Ordre de déploiement (fenêtre courte, SSO indisponible entre les étapes, sans risque pour le tableau de bord)

1. Générer deux clés distinctes (Finance, Analyses) hors dépôt. Ne pas les écrire dans le dépôt ni dans le chat.
2. Service Finance : créer `FINANCE_SSO_KEY`. Déployer `release/finance-staging` au SHA `integration/finance-sso-candidate` (après relecture).
3. Service Analyses : créer `ANALYTICS_SSO_KEY`. Connecter le dépôt/branche `release/analytics-staging` (aujourd'hui bloqué côté Railway : popup GitHub) puis déployer le candidat.
4. Service Sourcing/Core : `FINANCE_SSO_SECRET` = référence à `FINANCE_SSO_KEY` du service Finance (remplace la référence au jeton tableau de bord) ; `ANALYTICS_SSO_SECRET` = référence à `ANALYTICS_SSO_KEY`. Déployer `release/sourcing-staging` au SHA candidat.
5. Vérifier les SHA déployés sur chaque service (Railway : déploiement actif).

Tant que l'étape 4 n'est pas faite, Core signe avec l'ancienne valeur : les tickets sont refusés (échec fermé, pas de contournement).

## 5. Parcours à valider sur staging (avec comptes de test uniquement)

1. OWNER actif : ouvre Finance depuis Core, puis Analyses, sans nouvelle connexion ; données du bon marchand.
2. ADMIN / ACCOUNTANT / VIEWER : droits conformes (VIEWER refusé sur Finance et Analyses).
3. Membre suspendu (session déjà ouverte) : refus immédiat à la requête suivante, Finance et Analyses.
4. Membre retiré : même refus.
5. Jeton du tableau de bord seul : `/sso` refusé ; le tableau de bord fonctionne toujours avec son jeton.
6. Clé manquante, clé trop courte, clé égale au jeton, mauvais marchand, module sans entitlement : refus nommés.

**Non réalisable à ce jour** : aucun compte de test dans la session, aucun accès Railway. Ces étapes restent à exécuter.

## 6. Retour arrière

- Chaque service : redéployer le SHA précédent (Railway garde l'historique) :
  - Finance `ff3c597b` ; Analyses `2c3e92a4` ; Core `ded968e5`.
- Variables : restaurer `FINANCE_SSO_SECRET` vers l'ancienne référence **uniquement si** l'ancien code Finance est aussi restauré (sinon les deux côtés ne se comprennent plus). Ne pas laisser un Core avec une référence vers une clé que le service ne lit pas.
- Dans tous les cas, le tableau de bord (jeton) reste utilisable : le retour arrière ne touche pas à la connexion directe.

## 7. Hors périmètre

- Production : aucune action.
- Growth : hors contrat (son minimum de 24 caractères et son ticket restent inchangés).
