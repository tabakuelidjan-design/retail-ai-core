# Nordla — audit d'intégration et transmission (nuit du 15 octobre 2026)

Branche de référence consolidée : `claude/nordla-core-p0`. Aucun merge dans `main`, aucun déploiement, aucune migration appliquée.
Ce document constate ; il ne décide rien. Les preuves (commits, exécutions CI) sont citées.

## 1. Git : une seule référence

| Point | Constat vérifié |
|---|---|
| `integration/nordla-pre-china` | HEAD `f7197d5`. Ses commits absents de `claude/nordla-core-p0` étaient exactement trois, tous dans `.github/workflows/nordla-integration-pre-china.yml` : `27814b8`, `8f8d140`, `f7197d5`. |
| Reprise | Cherry-pick `-x` (pas de merge global, pas de réécriture) : `577ba8c`, `b18846a`, `83278fb`. Le workflow est désormais identique à la référence, sauf le déclencheur qui inclut `claude/nordla-core-p0`. |
| `f7197d5` vs `5334e2d` | `f7197d5` n'était PAS ancêtre de `5334e2d` ; `5334e2d` contenait déjà 15 des 18 commits concernés. Après reprise, le contenu de `f7197d5` est entièrement présent (diff de fichiers vide hors déclencheur). |
| `claude/blissful-babbage-z0nrt2` (Infrastructure) | HEAD `2b6b983`, non fusionné ici (coordination requise). Il **se fusionne sans conflit** dans la référence (`git merge-tree`), après le déplacement de mon document hors de `docs/infrastructure/`. |
| `docs/integration/COORDINATION.md`, `docs/integration/recensement-nordla-core-2026-10-14.md` | **Absents de toutes les branches d'origin** vérifiées. Ils peuvent exister localement dans une autre session : non créés ici pour ne pas entrer en collision. |

## 2. Intégration fonctionnelle par module (ce que le code prouve)

Légende : **Relié** = appelé par un service en fonctionnement ou par un autre module en production ; **Bibliothèque testée** = code + tests, mais aucun appelant en fonctionnement.

| Module | Code / tests | Relié aux services communs ? | Manques constatés |
|---|---|---|---|
| Core (tenant, sync) | `src/tenant`, `src/sync` ; tests tenant/sync | **Relié** : `service-start.js` (core, core-once), utilisé par 13 fichiers d'autres modules | — |
| Identity (sessions, rôles) | `src/identity` ; 7 fichiers de test | **Non relié** : aucun serveur (Finance, Analytics, Growth, Sourcing) ne l'importe ; seul `src/security` le référence | La carte des modules dit `IDENTITY_READY_FOR_FINANCE_ANALYTICS_GROWTH` : prêt comme bibliothèque, pas branché |
| Security | `src/security` ; 1 fichier de test | **Non relié** : aucun module ne l'importe | Chaque serveur a ses propres en-têtes / jetons |
| Socle Decision | `src/socle-decision` (V0 mémoire) ; 1 fichier de test | **Non relié** : aucun module ne l'appelle. Marketing a son propre « package de décision » (`src/marketing/socle-decision-package.js`), qui n'utilise pas le Socle | **NDR-004 (arbitrage unique par le Socle) n'est pas opérationnel dans le code en fonctionnement** |
| Couche d'intégration (`src/integration`, hub, handoffs, ledger, routeur Parle à Nordla) | 2 fichiers de test + 49 mutants (48 tués, 1 équivalent) | **Non relié** : `createIntegration` n'est appelé que par les tests ; aucun serveur ne l'expose | Persistance préparée seulement (`supabase/migrations-pending/`) |
| Finance | `src/finance` ; 63 fichiers de test + banc PG17 | **Relié** : service `finance` (Railway) | Landed cost : 3 moteurs (décision propriétaire) |
| Analytics | `src/analytics-premium` ; 18 fichiers | **Relié** : service `analytics`, mode hébergé avec hôtes autorisés + jeton | — |
| Growth | `src/growth` ; 13 fichiers | Serveur autonome en boucle locale (`npm run growth`), **pas dans `service-start.js`**, pas dans le hub | Fuseau du marchand désormais exigé |
| Marketing | `src/marketing` ; 12 fichiers | Contrats + passage vers Creative/Activation ; pas de serveur | Brief M3 et brief Creative : deux formes non reliées (§6.4 du document d'intégration) |
| Branding / Creative | 6 + 101 fichiers | Bibliothèques ; Creative appelé par le hub (tests) et par ses scripts | Readiness Creative NOT_READY (attestation à refaire, décision propriétaire) ; **non-déterminisme du masque produit, voir §4** |
| China Sourcing | `src/sourcing` ; 54 fichiers + 8 jobs E2E | Serveur autonome (PC Windows + tunnel) ; relié au hub seulement dans les tests | Mono-marchand, fichiers ; mode hébergé préparé ; photos non synchronisées (§3) |
| Provider connections / Activation | 10 + 7 fichiers + 2 smokes PostgreSQL | Bibliothèques (Activation importée par Provider et core-resilience) ; pas de service | Niveau CONTRACT/ADAPTER, pas production |
| Core resilience | 3 fichiers + benchmark chaos (143 scénarios) | Utilisé par Creative Brain uniquement | Les autres modules n'y sont reliés que par les tables d'adaptateurs |

Conclusion honnête : les services **réellement en fonctionnement** sont Core sync, Finance, Analytics (Railway) et China Sourcing (PC). Les autres
modules sont des bibliothèques testées. La chaîne « Entreprise → Sujets → Leviers → Décisions → Suivi » existe en contrats et en tests,
pas encore dans un service.

## 3. China Sourcing et les données du Xiaomi (audit, aucune action sur le téléphone)

| Élément | Constat dans le code |
|---|---|
| Dossiers | `localStorage` clé `nordla.sourcing.cases` (quota ~5 Mo par origine). Liste des dossiers à envoyer : `nordla.sourcing.dirty` (persistée). |
| Photos (produit, documents) | **IndexedDB** `nordla-sourcing` / `blobs`, clés `photo:<id>.<n>` et `docphoto:<id>.<doc>` ; repli en `localStorage` si IndexedDB indisponible. |
| Synchronisation | `PUT /api/cases/:id` envoie **le JSON du dossier seulement**. **Les photos ne sont jamais envoyées au serveur.** La récupération depuis le serveur (`recover`) ramène les dossiers avec `photos: {}`. |
| Export / import | L'export JSON d'un dossier **contient ses photos** (base64). Import limité à **8 Mo** par fichier (`MAX_IMPORT_BYTES`) : un dossier riche en photos de documents (1600 px) peut dépasser cette limite. |
| Service worker | Cache `nordla-sourcing-terrain-v2-1`, réseau d'abord (3 s) puis cache ; `/api` jamais en cache ; les anciens caches sont supprimés à l'activation (le cache, pas les données). Non modifié par mobile-ux-v2. |
| mobile-ux-v2 | Ne touche ni au stockage, ni au SW, ni à l'export/import, ni au serveur. Ajoute un champ `revisions` aux phrases (rétro-compatible). |
| P0 (cette branche) | Ajoute seulement `navigator.storage.persist()` (demande de non-éviction) et rapporte le résultat ; ne migre ni n'efface rien. |

Risques :
1. **Le stockage est par navigateur ET par origine.** Firefox, le navigateur intégré de Messenger et Chrome ont chacun leur propre stockage :
   ce que montre Firefox n'existe pas dans Messenger. C'est le comportement attendu, pas une perte. Ne jamais ouvrir l'application de
   travail depuis un lien Messenger.
2. **Chaque tunnel rapide Cloudflare a une adresse nouvelle = une origine nouvelle = un stockage vide.** Les dossiers saisis sous une
   ancienne adresse restent dans le navigateur sous cette ancienne adresse.
3. **Le passage à `app.nordla.app` (ou tout domaine stable) sera une nouvelle origine** : rien n'est transféré automatiquement. Seuls
   chemins : l'export JSON par dossier (avec photos) puis l'import, ou la sync serveur (sans photos).
4. **Les photos n'existent que sur le téléphone** (et dans les exports). Une éviction Android ou un effacement des données du site les perd.
5. Un export de plus de 8 Mo ne se réimporte pas.

Recommandation de procédure (à valider, rien n'a été exécuté) : avant tout changement d'adresse, dans **Firefox sur le Xiaomi**, exporter
chaque dossier (menu → Exporter) et copier les fichiers hors du téléphone ; vérifier qu'un export s'ouvre ; ne rien effacer.

À transmettre :
- **Core P0** : synchronisation des photos (contrat d'envoi + stockage serveur), import au-delà de 8 Mo ou par morceaux, procédure
  d'export groupé avant migration d'origine.
- **Infrastructure** : adresse stable (`app.nordla.app`) avant le départ, pour que l'origine ne change plus ensuite ; sauvegarde serveur.

## 4. CI : état, causes trouvées, corrections

| Workflow | Avant | Cause observée | Correction |
|---|---|---|---|
| china-sourcing | `e2e terrain v2` rouge (run 38655597331) | Chrome n'a pas démarré sur le runner, avant tout test | Relance unique → 8/8 jobs verts. E2E terrain 20/20 en local. |
| Marketing / Activation / Provider | annulés (limite 15/20 min), déjà sur la référence | `npm test` complet sous Node 20, impossible depuis Node ≥ 24 | Node 24 (`24cb0f6`) → verts (runs 38657902305, 38657902220, 38657902169) |
| Creative Intelligence | Node 20 annulé à 30 min | même cause (`npm test` sous Node 20) | Suite complète Node 24 seulement ; Node 20 garde les étapes Creative (`7681aa2`) → Node 20 vert (run 38659540142) |
| nordla-integration-pre-china | — | trois correctifs de la référence manquants | repris (§1) |
| Nordla Core Resilience | Node 24 annulé à 30 min (run 38659540324) | `growth-browser` : tous les tests passent puis le processus ne se termine pas (Chrome orphelin) | Teardown corrigé (`d309790`) |
| Tests benchmark | conflit de dossier partagé | `benchmark-ask` écrivait dans `benchmark/ask/results/` que `benchmark-preflight` compte | rapport dans un dossier temporaire (`cf0509e`) |
| **Creative Intelligence Node 24 / creative-refine** | rouge intermittent (run 38659540142 : PM-6) | **`buildProductMask` peut donner un masque différent pour une entrée identique**, sous charge CPU. Reproduit localement (2 à 4 sur 14 exécutions concurrentes) : mêmes empreintes que la CI (`96d2f81b…` attendu / `fe46f8d3…`). Le rendu (resvg) et la découpe sont stables ; c'est le calcul du masque. Isolé au moteur : 0/28 écart sans JIT optimisant (`--max-opt=0`), 0/28 avec Maglev au maximum (`--max-opt=2`), 2/28 avec TurboFan (défaut) ; remplacer `** 2` par des multiplications ne suffit pas (1/28). Reproduction : `tools/creative-mask-determinism-repro.mjs`. Diagnostic antérieur non intégré : `feature/creative-mask-determinism-diagnostic` `b817611`. | **Non corrigé** (code Creative, cause racine non isolée). Assertion non assouplie. À traiter par la session Creative. |

Tests ignorés (14 dans la suite locale) : 11 `growth-browser` faute de Chrome dans le conteneur → **exécutés à part : 11/11** ; 2 tests
d'identité produit sur un asset privé absent (normal) ; 1 garde de périmètre Growth volontairement suspendue à l'intégration.

## 5. Coordination

Fichiers sensibles ou partagés : `.github/workflows/*`, `package.json` / `package-lock.json` (`engines` remis à `>=20` : le passage à 24 est proposé, appliqué par Infrastructure), `src/creative-brain/model-port.js`
(conflit résolu), `docs/architecture/creative-readiness*.json` (non modifiés), `docs/infrastructure/nordla-cloud-plan.md` (Infrastructure),
`supabase/migrations*`, `railway.json` / `railpack.json` (non modifiés).

| Pour | À faire |
|---|---|
| Core P0 | sync des photos ; import > 8 Mo ; première couche d'auth dans l'application pour Railway (modèle : `src/analytics-premium/server/hosting.js`) et entrée `sourcing` dans `service-start.js` ; brancher Identity sur les serveurs ; décider du branchement du Socle Decision |
| Infrastructure | fusionner sa branche après relecture (sans conflit) ; caractériser Finance/Analytics/Growth sur Railway en Node 24, puis appliquer (ou non) `engines >=24` et `.nvmrc`, proposés par Core P0 ; adresse stable ; sauvegarde |
| Creative | non-déterminisme du masque (§4) ; ré-attestation (décision propriétaire) |
