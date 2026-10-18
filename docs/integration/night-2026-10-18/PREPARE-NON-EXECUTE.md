# Opérations préparées, NON exécutées (nuit du 2026-10-18)

Rien de ce qui suit n'a été appliqué. Chaque point dit ce qu'il faudrait faire, pourquoi, et comment revenir en arrière. Les décisions sont au propriétaire.

## A. Garde sur l'écriture du stock Finance vers Shopify (`POST /api/stock/apply`, `src/finance/server/app.js` ~l.1295)
- **Constat** : `stock.applyPending()` écrit dans Shopify (source de vérité du stock) avec une session + un jeton CSRF seulement. Aucune confirmation, aucun aperçu du nombre de mouvements, aucun rôle (Finance n'a pas de rôles).
- **Correctif proposé** (minimal) : le corps doit contenir `{ confirm: 'APPLY', expected: <nombre de mouvements en attente> }` ; le serveur compare au nombre réel (`stock.status().pending`) et refuse (409) si différent ; l'écran Finance affiche d'abord le nombre. Test : sans confirmation → 400 ; mauvais nombre → 409 ; bon nombre → applique.
- **Pourquoi pas appliqué** : modifie le comportement et l'écran Finance (autre chantier) ; Finance n'est pas dans la navigation unifiée ni dans le service Xiaomi.
- **Retour arrière** : retirer la vérification (une ligne).

## B. Mêmes gardes pour les écritures Finance non gardées (paiements, rapprochement bancaire, réglages/profil vendeur)
- **Constat** : `app.js` ~553-594 (paiements), 868-905 (banque), 1378 (réglages avec IBAN/TVA) = session + CSRF.
- **Correctif proposé** : (1) identité Core à la place du jeton partagé (acteur par personne dans `fin_events`, aujourd'hui codé en dur `dashboard`) ; (2) rôles OWNER/ADMIN pour ces routes ; (3) double contrôle (créateur ≠ approbateur) pour émission/envoi/paiement. C'est un travail d'architecture Finance (donc hors raccordement) : à planifier séparément.

## C. Politiques RLS du staging Supabase
- **Constat** : 33 tables RLS activées sans politique (refus total pour anon/authenticated ; l'accès passe par la clé service role, donc l'isolation des marchands est applicative). Les politiques RESTRICTIVES préparées (`supabase/migrations-pending/20261015091000…`) « n'ouvrent rien » et ajoutent un garde-fou de base de données.
- **À faire (par vous)** : appliquer d'abord sur une copie/branche Supabase, rejouer `test/postgres/*`, puis staging. Ne rien appliquer sur la production sans test.
- **Retour arrière** : `DROP POLICY` des politiques nommées `nordla_*`.

## D. Les 8 migrations du dépôt absentes du staging
`analyses_truth_foundation`, `channel_execution_jobs`, `finance_belgium_peppol`, `finance_essential_bank`, `finance_essential_payments`, `finance_integrity_p0`, `merchants_deprecate_legacy_identity`, `provider_connections`. Le code Finance/Analyses de `core-p0` les suppose. À appliquer **avant** toute activation Finance/Analyses sur le staging, dans l'ordre des dates du dépôt, par vous.

## E. Dictée vocale en Chine (Parle à Nordla, PR #19)
- **Fait dans la branche** (isolée, non déployée) : message exact quand le service de reconnaissance du navigateur est injoignable (Chrome sans services Google : l'erreur `service-not-allowed` n'est plus présentée comme « micro refusé »).
- **Non fait (nouvelle fonctionnalité)** : un moteur de dictée qui ne dépend pas de Google. Pistes : (1) la touche micro du clavier du téléphone (aucun code Nordla ; fonctionne partout où le clavier a sa propre dictée) ; (2) le moteur local Moonshine déjà dans l'app terrain (anglais seulement, expérimental, modèle de ~65 Mo absent d'une image propre : `SOURCING_VOICE_DIR` à fournir sur le volume).
- **Écran `/nordla`** : n'a pas de micro (la voix n'est que dans le panneau Nordla de l'app terrain) : à relier si vous le souhaitez.

## F. Staging Xiaomi
Non touché : `release/sourcing-staging` (`284648e` = core-p0 `ebff21e` + `railway.json` racine, fusion de la PR #24) et le service Railway restent tels que la session Convergence les a laissés. Les correctifs de cette nuit ne sont dans aucune branche suivie par Railway.
