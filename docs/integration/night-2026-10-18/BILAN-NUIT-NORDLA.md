# BILAN DE LA NUIT — audit et durcissement de Nordla (2026-10-18)

Branche de travail : `hardening/nordla-night-2026-10-18` @ `340f9b2` — **locale, non poussée, non fusionnée**. Elle contient le candidat de convergence (core-p0 `ebff21e` + PR #19, #21, #22 fusionnées localement, #22 à sa dernière tête `0b32cde`) + 4 commits de la nuit.
Respecté : aucun déploiement ; Supabase (staging et production) et Railway **non touchés** ; aucun merge dans une branche principale ; **aucun appel à une IA externe** (les « fournisseurs » des tests sont des doublures en mémoire, le réseau est espionné et bloqué) ; aucune fonctionnalité ajoutée ; les branches des autres chantiers ne sont pas modifiées (les correctifs sont des commits de cette branche seule).
Rien n'est présenté comme « sécurisé » sans preuve : chaque ligne ci-dessous renvoie à un test ou à une lecture de code.

## 1. Problèmes découverts

| # | Problème (confirmé par un test qui échouait avant le correctif) | Gravité | Corrigé ? |
|---|---|---|---|
| V1 | Un **VIEWER ou ACCOUNTANT pouvait créer des propositions de campagne et des visuels** (`POST /api/core/campaigns`, `/api/core/creation`) : écriture dans le journal/volume par un rôle lecture seule | moyenne | **oui** (`FORBIDDEN_ROLE`, 403) — `src/core-pilot/http.js` |
| V2 | **Pertes silencieuses de notes fournisseur** : 8 sauvegardes simultanées du même dossier depuis la même révision → 4 « réussissaient » avec la **même** révision (3 notes perdues sans erreur) et 4 échouaient en `ENOENT` (fichier temporaire commun). Scénario réel : synchronisation du téléphone + nouvelle tentative, ou deux appareils | **élevée** (donnée terrain) | **oui** — sauvegarde sérialisée par dossier + fichier temporaire unique ; un client en retard reçoit `CONFLICT` (409) et fusionne — `src/sourcing/store/file-store.js` |
| V3 | Même défaut pour les **photos** (deux photos différentes sous la même clé pouvaient être « STORED » toutes les deux ; `EPERM` sur les nouvelles tentatives identiques) | moyenne | **oui** — `src/sourcing/store/photo-store.js` |
| V4 | Sur Chrome **sans services Google** (téléphone vendu en Chine, Google bloqué), l'erreur `service-not-allowed` était affichée « micro refusé : changez un réglage » : message **faux** | moyenne (Chine) | **oui** — message exact : le service de dictée du navigateur (Google) peut être injoignable en Chine ; clavier / touche micro du clavier — `src/sourcing/ui/nordla-voice.js` |
| V5 | Sur Windows, le test de marque de PR #22 échoue : le SVG officiel est converti en CRLF par `core.autocrlf` (hachage différent). **Aucun défaut de code** ; Linux/CI non concernés | faible | **non** : proposition = ajouter `src/shared/assets/nordla/** -text` à `.gitattributes` (une ligne, à votre accord) |
| V6 | Deux écrans « Parle à Nordla » : la dictée (PR #19) n'existe que dans le panneau de l'app terrain, **pas sur l'écran `/nordla`** (PR #22) | écart d'intégration | non (nouvelle fonctionnalité) |
| V7 | Image de déploiement : les fichiers du moteur vocal local (Moonshine, ~65 Mo, git-ignorés) sont **absents** d'une image propre : la voix de l'app terrain dira « Voix indisponible » sauf volume `SOURCING_VOICE_DIR` | moyenne (terrain) | non (configuration) |

**Constats déjà présents (non corrigés, décisions plus bas)** : RLS activée **sans aucune politique** + clé service role partout (isolation applicative seulement) ; Finance : jeton partagé, pas de double contrôle, écriture du stock vers Shopify sans garde, acteur d'audit codé en dur ; Stock/Achats : approbations hors Guardian/journal Core ; mode jeton local = OWNER ; staging Supabase : 8 migrations manquantes et **données de boutique réelles** ; `pg` absent de `package.json`.

**Hypothèses de départ infirmées** (preuves) : accès entre commerçants **refusé et sans rejeu de session** (NS-2 + 25 tests `tenant-isolation` existants) ; **aucun appel sortant** depuis Core, Parle, Branding, Marketing, Création, documents (NS-3, réseau espionné) ; la lecture d'image par IA exige fournisseur activé **et** consentement par image **et** un rôle d'écriture, et n'envoie **que** l'image (NS-3) ; plafond de corps de requête 16 Mo (413) ; aucun CDN ni police Google dans l'application terrain ; les CLI Gemini et MiniMax sont bornés (1 sortie, source d'image HTTPS publique sans identifiants, coût affiché).

## 2. Preuves (tests écrits cette nuit, tous verts sur la branche)
- **NS-1** matrice de permissions (HTTP, serveur hébergé) : anonymes, VIEWER, ACCOUNTANT, COLLABORATOR, ADMIN, OWNER × toutes les opérations sensibles Core/Sourcing/Achats ; CSRF faux/absent refusé ; journal = événements réels et acteurs réels.
- **NS-2** accès entre commerçants : membre d'un autre commerçant refusé ; session de A rejouée sur B (et inversement) = 401 ; données de A invisibles sur B.
- **NS-3** audit des sorties : réseau espionné (fetch, http(s), sockets) : **zéro appel** sur Parle, Marque, Campagnes, documents ; IA désactivée = rien ne part ; IA activée = refus 428 sans consentement, 403 pour un rôle lecture seule, un seul envoi (l'image) sans fournisseur/prix/IBAN/texte.
- **NS-4** Parle ne peut pas être poussé à agir : 26 formulations (français, anglais, remplisseurs oraux, injections « ignore les instructions », faux propriétaire) → aucune écriture, aucune décision humaine, aucune réponse « c'est fait ».
- **NS-5** un rôle lecture seule n'obtient aucune analyse journalisée.
- **NS-6** identité et rôle viennent de la session seule : corps/en-têtes/cookies prétendant « OWNER » sans effet.
- **NS-7** notes fournisseurs et photos intactes après redémarrage ; sauvegarde périmée = 409 ; rôle lecture seule ne peut rien altérer.
- **SC-1..5** concurrence des dossiers et photos (échouaient avant le correctif).
- Existants repris : `procurement-hosted` (approbation/commande/réception par rôle), `sourcing-hosted-identity`, `core-pilot`, `tenant-isolation`, `social-core`/`integrity` (approbations signées), `integration-social` (le hub BLOQUE approve/schedule/publish).
- Navigateur réel (Edge headless) : `nordla-voice` 9/9, `nordla-entry` 7/7, `nordla-design` 7/7 sur la branche durcie.
- Groupes ciblés (Windows, Node 24) : Core/intégration/identité/sécurité 520/522 (0 échec, 2 sautés) ; Finance/Analyses 1072/1073 (1 test de **performance** sensible à la charge, passe seul) ; Sourcing/Achats 833/853 (2 échecs **identiques sur core-p0** : chemin Windows, 18 sautés PostgreSQL) ; Parle 108/109 (1 = V5, CRLF Windows) ; Marque/Marketing/Création 1270/1272 (0 échec) ; Social/Activation/Providers 217/218. La suite complète du dépôt n'a pas été terminée (la Création seule dure plus de 25 min).

## 3. Risques restants
1. **Isolation des marchands = code applicatif seulement** (service role, RLS sans politique) : un bug de filtre = fuite entre marchands. Les politiques RESTRICTIVES préparées existent (non appliquées).
2. **Finance** (hors navigation unifiée et hors service Xiaomi) : écritures sensibles sans double contrôle ni rôle ; Peppol/PSD2 réels absents — ne pas annoncer la conformité.
3. **Achats** : approbations hors Guardian ; mono-processus (PostgreSQL inutilisable sans `pg`) ; blocage jusqu'à ~70 s au redéploiement (bail de verrou).
4. **Dictée** : Chrome → Google (inaccessible en Chine) ; moteur local anglais seulement, expérimental, jamais essayé sur appareil, modèle absent d'une image propre.
5. **Staging Supabase** contient des données de boutique réelles ; migrations en retard (8).
6. Les correctifs V1–V4 n'ont **pas** été éprouvés sur le service actif (non déployés) ; en CI Linux/Node 20, non rejoués.
7. Alibaba (CI, annulé à 20 min) et Creative Intelligence Node 24 (intermittent) : points de suivi inchangés.

## 4. Décisions qui nécessitent votre accord
1. **Embarquer V1–V4 dans le service actif ?** (commits `c102c05`, `9e2aafb`, `340f9b2`) : ils touchent le serveur China Sourcing ; recommandation : oui, **après** le test Xiaomi, via la voie habituelle (branche `release/sourcing-staging` par Convergence). Rien n'est fait sans vous.
2. Épingler les assets Nordla dans `.gitattributes` (V5).
3. Relier la dictée à l'écran `/nordla` (V6) ; moteur de dictée sans Google pour la Chine.
4. Appliquer, par vous, sur le staging Supabase : les 8 migrations manquantes puis les politiques RLS (voir `PREPARE-NON-EXECUTE.md`).
5. Gardes Finance (stock → Shopify, paiements, banque, réglages) et identité Core à la place du jeton partagé (voir `PREPARE-NON-EXECUTE.md`).
6. Autoriser ou non l'envoi d'images à une IA externe (aujourd'hui désactivé ; si activé : consentement à un niveau propriétaire, pas seulement par appel).
7. PostgreSQL pour Achats (ajout de `pg` + migrations `proc_*`).

## 5. Reprise propre
- Branche `hardening/nordla-night-2026-10-18` (locale) ; worktree `C:\Users\etaba\Desktop\retail-ai-core-unified-wt`. Pour annuler : supprimer la branche (rien n'est déployé ni poussé).
- Documents : ce bilan, `PREPARE-NON-EXECUTE.md` (opérations préparées non exécutées), `docs/integration/convergence-2026-10-17/` (rapport de convergence et annexes d'audit).
- Données : aucune donnée réelle lue ou modifiée ; tous les tests utilisent des dossiers temporaires et des données synthétiques.
