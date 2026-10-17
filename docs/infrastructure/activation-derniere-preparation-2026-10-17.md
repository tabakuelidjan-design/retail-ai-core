# `sourcing-staging` — dernière préparation avant activation (2026-10-17)

> **MISE À JOUR (GO du propriétaire, 2026-10-17)** — `release/sourcing-staging` a été avancée par fast-forward de `0f83fd2` à **`a7ecccdc49d28def444bb6db0b68865372c55286`** (HEAD distant relevé juste avant : `0f83fd2` ; seul `railway.json` diffère ; pas de force-push ; `claude/nordla-core-p0` reste `0f83fd2`, `main` reste `a9d0e2f`). **Le commit à épingler dans Railway est désormais `a7ecccd…`** ; `0f83fd2` reste le code validé par la CI (même contenu d'image : 16 couches identiques). Voir `config-as-code-staged-create-2026-10-17.md`. Partout ci-dessous, « épingler `0f83fd2` » se lit « épingler `a7ecccd…` ».


**Rien n'est déployé, rien n'est appliqué dans Railway, la production n'est pas touchée.** Ce document remplace les chiffres approximatifs (« 29 → ≈ 31 lignes ») de `activation-sourcing-staging-prete-2026-10-17.md` par l'inventaire réel relevé par le propriétaire.

## 1. Inventaire réel (relevé par le propriétaire)
**31 changements en attente = 28 (création de `sourcing-staging`) + 3 (création de son volume 1 Go), aucune opération destructive.** Le commit enregistré est `ab02b77` ; le candidat validé est `0f83fd2b28f7114ba2919557fc9d32d031104cc4` (fusion dans `claude/nordla-core-p0`, 5 workflows verts sur ce SHA). « Config as code » et la règle de déploiement automatique ne figurent pas explicitement dans le lot.

## 2. Corrections préparées (fichier `ops/railway-staging/staged-corrections.json`, **non appliquées**)
| # | Demande | Correction préparée | Nature |
|---|---|---|---|
| 1 | Épingler `0f83fd2…` | commit `ab02b77` → `0f83fd2b28f7114ba2919557fc9d32d031104cc4` (SHA complet, jamais « dernier commit ») | modification d'une ligne existante |
| 2 | Imposer `/deploy/sourcing/railway.json` | réglage « Config as code » = `/deploy/sourcing/railway.json` (sans lui, le `railway.json` racine passe devant : commande sans l'entrée Docker, pas de Dockerfile = **processus root**, volume non préparé) | 1 ligne nouvelle |
| 3 | Éviter les redéploiements non autorisés | **branche dédiée `release/sourcing-staging`, créée et poussée par moi au SHA `0f83fd2`** (aucun chantier n'y pousse : une poussée ailleurs ne peut plus redéployer staging) ; la source du service passe de `claude/nordla-core-p0` à cette branche ; en plus, interrupteur « déploiement automatique » sur OFF si l'interface le propose. Le Deploy reste un acte manuel | modification de la source + 0 ou 1 ligne |
Lot attendu après correction : **32 ou 33 lignes**. Toute autre ligne nouvelle doit être une variable listée dans le fichier ; tout service autre que `sourcing-staging`, toute variable partagée, suppression, domaine ou changement de l'environnement production = **arrêt**.
Pour avancer la branche plus tard (nouveau candidat) : fast-forward explicite de `release/sourcing-staging`, sur autorisation, jamais automatique.

## 3. Identifiants et séparation staging / production (vérifiés, lecture seule)
| Élément | Valeur attendue | Vérification |
|---|---|---|
| Projet Railway | `app.nordla.app` `261a1971-15da-432b-9bdd-0cde6a1e8815` | CLI |
| Environnement cible | `staging` `6b648e6b-c685-45cb-abc8-db7dbe5357de` | CLI |
| Environnement à ne jamais toucher | `production` `cb5eb0e7-b2ed-46ef-860a-26dd862ea5aa` | CLI ; aucun changement du lot ne doit le citer |
| Supabase staging | `fvhiammdskpcnfodsnrc` « nordla-finance-staging » | liste des projets |
| Supabase production (données réelles) | `xbtzjabbseclmqfozjeo` « retail-ai-core-dev » | ne doit apparaître dans **aucune** valeur du lot |
| Marchands dans la base staging | exactement 2 : « Nordla Staging Retail (synthetic) » et **« HABB (test staging) » `67646dbb-5e2e-4cd7-aad6-0ab289b068cb`** ; l'identifiant de production `36b1a1a7…` est **absent** | requête en lecture seule (noms et identifiants, aucune donnée personnelle) |
| Marchand de test | 1 membre, **1 propriétaire ACTIVE**, module `sourcing` ACTIVE | comptages en lecture seule |
| Garde-fous du code (testés) | sur Railway `NORDLA_SUPABASE_PROJECT_REF` est obligatoire ; `SUPABASE_URL` doit valoir exactement `https://<ref>.supabase.co` ; une clé JWT d'un autre projet est refusée ; si le marchand n'existe pas dans le projet, **le service refuse de démarrer** (`HOSTED_MERCHANT_NOT_IN_PROJECT`) ; aucune clé n'est imprimée | `hosted.js`, `test/sourcing-hosted-project-pin.test.js` |
Conséquence : même une valeur erronée collée dans Railway ne peut pas faire écrire le service dans la production — il ne démarre pas.

Base de comparaison (déploiements des **autres** services, avant toute activation ; ils doivent rester identiques après) :
`staging` : finance-staging `fa598da1…` (09-29 12:03), core-staging `5065f9b5…` (09-29 12:00), shopify-stub-staging `7936dc81…` (09-27 18:18), analytics-staging `619d6354…` (09-29 12:08) · `production` : Analytics `6c08f418…` (09-26 02:21), Core `f191ceb0…` (09-29 13:37), Finance `2e59beef…` (09-26 22:27), nordla `6919c217…` (09-25, en veille).

## 4. Saisie sécurisée des secrets (par le propriétaire uniquement ; rien ne passe par le chat)
Cinq secrets, dans Railway → `sourcing-staging` → Variables, **environnement staging** :
| Variable | Origine | Règle |
|---|---|---|
| `SUPABASE_SERVICE_ROLE_KEY` | tableau de bord Supabase du projet **nordla-finance-staging** → API | **avant de copier : l'adresse de la page contient `fvhiammdskpcnfodsnrc`** (jamais `xbtzjabbseclmqfozjeo`) |
| `SUPABASE_ANON_KEY` | même page, clé « anon / publishable » | idem |
| `NORDLA_IDENTITY_RATE_LIMIT_KEY` | générée sur votre PC : `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` | 64 caractères, **différente** de la suivante |
| `NORDLA_CSRF_KEY` | même commande, **une seconde exécution** | ne pas réutiliser la première (le service refuse de démarrer sinon) |
| `SOURCING_BACKUP_PASSPHRASE` | phrase longue de votre choix | à conserver dans votre gestionnaire de mots de passe : sans elle, aucune sauvegarde n'est restaurable ; la **même** valeur sert au secret GitHub de la restauration indépendante |
Procédure : (1) saisir chaque valeur directement dans Railway (copier-coller), jamais dans un message, un fichier du dépôt ou une capture ; (2) après enregistrement, utiliser l'option « sceller » (Seal) de Railway si elle est proposée ; (3) ne pas coller de valeur dans `SOURCING_PUBLIC_ORIGIN` avant la génération du domaine ; (4) me prévenir : je ne lis que les **noms** de variables (`railway variables … --json` filtré sur les noms, jamais les valeurs) pour confirmer que les cinq sont présentes et que `ANTHROPIC_API_KEY`, `SOURCING_TOKEN`, `SOURCING_VISION_PROVIDER`, `PROCUREMENT_USERS`, `PROCUREMENT_PG_URL`, `SOURCING_CASES_DIR` sont absentes. Les secrets GitHub (`supabase-staging`) sont saisis séparément dans GitHub.

## 5. Contrôle final avant activation (« porte » : tout doit être vrai, sinon pas de Deploy)
1. Lot exporté : **32 ou 33 lignes, toutes dans `sourcing-staging` et son volume**, 0 hors périmètre, 0 suppression, 0 variable partagée, 0 domaine, 0 changement de `production`.
2. Source : branche `release/sourcing-staging`, commit `0f83fd2b28f7114ba2919557fc9d32d031104cc4` ; « Config as code » = `/deploy/sourcing/railway.json`.
3. Dockerfile `deploy/sourcing/Dockerfile`, commande `/app/docker-entrypoint.sh node src/service-start.js`, healthcheck `/healthz`, 1 réplique, pas de veille, volume 1 Go monté sur `/app/data`.
4. Variables non secrètes = valeurs du fichier de corrections (aucune ne contient `xbtzjabbseclmqfozjeo`, `36b1a1a7`, `cb5eb0e7`) ; `SOURCING_PUBLIC_ORIGIN` absente à ce stade.
5. Les cinq secrets présents (noms relevés par moi), les variables interdites absentes.
6. Les déploiements des autres services sont ceux de la base de comparaison du §3.
Après le **premier** Deploy : journal `Supabase project check (fvhiammdskpcnfodsnrc): VERIFIED`, `Core ON for merchant 67646dbb-…`, `Stock / Achats ON`, **`uid 1000`** (`uid 0` = arrêt), `/healthz` 200, `/api/core/modules` 401 sans session ; puis adresse générée → `SOURCING_PUBLIC_ORIGIN` → second Deploy ; puis les contrôles C1–C12 (`controles-apres-activation.md`). Arrêt à tout rouge ; rien n'est supprimé. Retour arrière : service à 0 instance ou épingle sur `ab02b77`.

## 6. Ce qui demande votre autorisation (et rien d'autre)
1. **Appliquer** les corrections 1–3 dans le lot Railway (par la session Railway, qui a la main sur l'interface).
2. **Saisir les 5 secrets** (vous seul), puis les secrets GitHub.
3. **Deploy** de `sourcing-staging`, puis second Deploy avec l'adresse générée.
4. **Graine de données de TEST**, sur le volume (séparée).
5. Plus tard : DNS `app.nordla.app`, migrations, tout avancement de `release/sourcing-staging`.
