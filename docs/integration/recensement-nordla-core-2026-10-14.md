# Recensement Nordla Core — 14 octobre 2026 (référence `integration/nordla-pre-china` @ `4c07586`)

Version versionnée du recensement transmis à la session Core P0 par la session « Point de pilotage HABB ». État de chaque point au
15 octobre 2026 entre crochets ; preuves dans `docs/integration/integration-audit-2026-10-15.md`.

## Intégré et testé dans la référence
CORE (`08619d7` + `cb3976a`) ; SOCLE_DECISION V0 (`3f10482`) ; `src/integration/*` et le routeur texte Parle à Nordla ; FINANCE et
`src/finance/purchase-analysis.js` ; ANALYTICS (`3b44f19`) ; GROWTH (`f56bcc7`) ; CHINA_SOURCING (`950ebe4`, avec `f373b0e`, `4be98ec`) ;
tests `integration-contracts`, `integration-workflows`, `tools/integration-mutation.mjs`.

## Non intégré, pertinent pour le Core
- `feature/china-sourcing-mobile-ux-v2` (`933168c`, `183267d`, `90e1ecf`) [**fusionné**, `c5096f4`].
- `feature/nordla-core-resilience-v1` (`4e82918`) [**fusionné en entier**, `29b6c24` — avant réception de la décision 3 ; voir « Résilience » ci-dessous].
- `claude/blissful-babbage-z0nrt2` : plan d'hébergement [branche Infrastructure, `2b6b983` ; se fusionne sans conflit, non fusionnée].

## Superseded / à ignorer
`finance-operations`, `growth-opportunities`, `growth-overview` (superseded) ; `claude/friendly-bell-1agyp0` (audit sur un `main` périmé).

## Incomplets (§6 du document d'intégration)
1. Persistance des objets d'intégration et du ledger [contrats + migrations **préparées non appliquées** ; propriété des migrations : Infrastructure].
2. Pas de PO ni de stock entrant réel [inchangé].
3. Sourcing mono-marchand, fichiers [mode hébergé préparé ; table `sourcing_cases` avec `merchant_id` préparée].
4. Trois moteurs de landed cost [**contrat canonique défini** : `docs/integration/landed-cost-contract.md` ; adaptateurs à écrire].
5. Growth en UTC par défaut [**corrigé**, `9e2ae6c`, `0eaa3f9`].
6. 7 tests Windows [**corrigés** avec `fileURLToPath`, `90e88a9` ; non rejoués sous Windows d'ici].
7. Parle à Nordla texte seulement [inchangé, hors P0].

## Blocages Xiaomi
Aucun serveur hébergé [préparé, non déployé] ; pas d'authentification réelle [à faire par Infrastructure, modèle Analytics] ; RLS sans policy et
`fin_*` sans `search_path` [migrations préparées] ; versions Node incohérentes [Sourcing garde Node 24 ; `engines` reste `>=20`, passage proposé
à Infrastructure] ; pas de sauvegarde testée [outil préparé et testé, propriété Infrastructure] ; accès Chine non mesuré [inchangé] ;
CI China Sourcing jamais lue [**lue** : verte, run 38655597331].

## Décisions propriétaire 2026-10-14
1. **Hébergement** : Railway en priorité, Hetzner seulement si Railway ne satisfait pas les besoins techniques ou de sécurité ; cible
   `app.nordla.app` (domaines `nordla.app` et `nordla.eu` chez Porkbun) ; aucune dépense ni mise en production sans accord (périmètre Infrastructure).
2. **Données** : Supabase reste l'option principale, pas de second PostgreSQL ; migrations réversibles, compatibles avec l'existant, testées
   seulement en environnement isolé ; aucune modification de la production ; isolation des marchands, authentification et RLS obligatoires avant
   toute exposition. Core P0 fournit les contrats de persistance ; Infrastructure écrit les migrations.
3. **Creative / résilience** : ré-attestation Creative autorisée seulement si des fichiers ou contrats Creative sont modifiés ; ne pas forcer le
   merge de toute la branche résilience si elle introduit des régressions ; isoler les corrections indispensables et documenter les reports.
4. **Node** : Node 24 requis pour China Sourcing ; aucun changement global sans vérifier Finance, Analytics, Growth et les déploiements ; si un
   changement est proposé, Infrastructure l'applique à la configuration de déploiement ; chaque échec CI résolu ou caractérisé, jamais de test
   désactivé.
5. **Hors ligne** : ne pas reconstruire le service worker, le stockage local ni la sync ; les adapter à `app.nordla.app` ; conserver les dossiers
   et photos du Xiaomi ; prouver le chemin d'export / migration / resynchronisation par un test.
6. **Coût rendu** : Finance est l'autorité du calcul économique final ; contrat canonique entre Sourcing, Buying et Finance ; le Radar Marché
   Terrain reste indépendant de Finance.
7. **Preuves** : commits, tests, intégration, puis fonctionnement réel sur Xiaomi ; jamais READY sur la seule foi des tests unitaires ; test
   décisif PC éteint, Xiaomi en 4G/5G, `app.nordla.app` ; les dernières 24 h avant le départ réservées aux validations.
8. **Interdits** : pas de merge dans `main`, pas de migration de production, pas de ressource payante ; Marketing et nouveaux agents après le retour.

### Application par Core P0
| Décision | Ce qui a été fait |
|---|---|
| 3 — résilience | La branche était déjà fusionnée en entier quand la décision est arrivée. Aucune régression constatée : suite complète Node 24 3847 tests / 0 échec ; tests core-resilience et benchmark chaos verts en CI Node 20 (run 38659540324). Rien n'est reporté. Les 3 codes Creative ajoutés par la référence ont été mappés (`29b6c24`). |
| 3 — ré-attestation | Autorisée (le fichier Creative `src/creative-brain/model-port.js` a changé) mais **non faite** : la preuve exigée (CI verte) n'est pas obtenue tant que le masque produit n'est pas déterministe (CI Creative rouge intermittente, run 38659540142). Préparation : `docs/architecture/creative-readiness-reattestation-pending.md`. |
| 4 — Node | `engines >=24` et `.nvmrc` retirés de la branche (`54af219`) ; proposés à Infrastructure (voir `COORDINATION.md`). CI : les workflows qui lançaient la suite complète sous Node 20 la lancent sous Node 24 (pas de test désactivé). |
| 5 — hors ligne | Rien reconstruit. Preuve de migration d'origine : `test/e2e/sourcing-origin-migration.e2e.js`, 7/7. Écart déclaré : la sync serveur ne porte pas les photos. |
| 6 — coût rendu | `docs/integration/landed-cost-contract.md`. |
| 2 — données | Les fichiers préparés par Core P0 dans `supabase/migrations-pending/` sont transmis à Infrastructure (propriétaire). |

## Directive commune — échéance 20 octobre
Transmise par la session « Point de pilotage HABB » (routine du 14 octobre 2026, 23:23 UTC), recopiée telle quelle.

1. **Calendrier** : 15–17 octobre finaliser l'intégration Core P0, l'infrastructure indispensable, l'authentification, le stockage et la
   synchronisation ; 18 octobre tests réels sur Xiaomi, avec et sans connexion ; 19 octobre gel fonctionnel (corrections bloquantes, sauvegardes,
   validation finale) ; 20 octobre départ, système utilisable sans l'ordinateur personnel. Si le calendrier devient irréaliste, réduire le
   périmètre ; ne jamais supprimer de contrôle de sécurité ni annoncer une disponibilité non démontrée.
2. **Données Xiaomi** : ne jamais supposer qu'elles seront accessibles depuis `app.nordla.app`. Avant toute bascule : identifier où elles
   résident ; préparer export / transfert / resynchronisation fiable ; vérifier l'intégrité des dossiers et photos après transfert ; prouver
   l'absence de perte ; garder l'ancienne installation jusqu'à validation. Ne pas effacer le stockage local ni remplacer le service worker sans
   stratégie de conservation démontrée.
3. **Responsabilités** : Core P0 = intégration et corrections fonctionnelles, contrats communs, adaptation du hors ligne existant, tests
   fonctionnels et de non-régression, documentation des reports, intégration contrôlée des travaux Infrastructure. Infrastructure = inventaire
   Railway et Supabase en lecture seule, déploiement permanent et domaine, authentification, isolation des marchands et RLS, stockage durable des
   dossiers et photos, sauvegarde et restauration vérifiables, migrations réversibles et retour arrière. La branche Infrastructure se réaligne
   sur la référence Core P0 sans perdre son travail ; fichiers partagés coordonnés dans `docs/integration/COORDINATION.md`.
4. **Test décisif sur le Xiaomi physique** : PC complètement éteint ; Wi-Fi coupé, 4G/5G ; Nordla sur son adresse permanente ; connexion avec
   une authentification réelle ; dossiers et photos existants retrouvés ; création ou modification d'un dossier ; enregistrement vérifié côté
   serveur ; fermeture et réouverture ; modifications retrouvées ; coupure réseau puis reprise de la synchronisation ; aucune perte ni duplication.
   Preuves, résultats et échecs documentés ; les tests automatisés ne remplacent pas cette validation.
5. **Interdictions** (sauf autorisation explicite) : merge dans `main`, migration de production, dépense ou ressource payante, changement DNS,
   effacement des données locales du Xiaomi, désactivation de test, déclaration « prêt pour la Chine » sans preuve terrain.
6. **Rapport de chaque session** : branche et HEAD ; terminé et prouvé ; indispensable avant le 18 octobre ; blocages et dépendances ; risques de
   perte de données ou de sécurité ; reportable après le voyage ; décisions ou autorisations nécessaires.
