# Nordla Cloud — audit, hébergement, migration, sécurité (plan)

Statut : **proposition pour décision**. Aucun serveur, abonnement, secret ou migration n'a été créé. Rien n'est fusionné dans `main`.
Date : 2026-10-14. Les prix sont des **estimations tirées de sources tierces, à vérifier sur les pages officielles** avant toute souscription.

## 1. Audit de l'existant (Mission 1)

### Ce que l'audit a pu établir
| Élément | État constaté | Source |
|---|---|---|
| Dépôt `retail-ai-core` | Node ≥ 20 (testé en 22), 1 dépendance (`pdfkit`), CLI uniquement : aucun serveur HTTP, aucune UI, aucune PWA | `package.json`, `src/` |
| Finance (devis, factures, TVA, PDF, pack comptable) | Code dans `src/finance/`, persistance Supabase (`supabase-store.js`) ou mémoire. Rien n'est transmis à l'extérieur en V1 | `docs/architecture/finance-operations.md` |
| Supabase `nordla-finance-staging` (eu-west-1, PG 17) | **Déjà hébergé.** 66 documents, 320 factures fournisseurs, 420 transactions bancaires, 278 événements, 40 paiements, 12 mouvements de caisse | MCP Supabase (lecture seule) |
| Supabase `retail-ai-core-dev` (eu-west-1, PG 17) | **Déjà hébergé.** Données Shopify synchronisées (108 commandes, 175 produits, 8 156 snapshots d'inventaire, 1 821 `sync_runs`) | idem |
| Sécurité Supabase | RLS activé sur les 27 tables, **zéro policy** (accès uniquement par clé `service_role`) ; 6 fonctions `fin_*` sans `search_path` fixé (WARN) | advisors |
| Secrets requis | `SHOPIFY_CLIENT_ID/SECRET`, `SUPABASE_SERVICE_ROLE_KEY`, `CUSTOMER_HASH_KEY` : variables d'environnement locales `.env`, non versionnées | `.env.example` |
| Stockage fichiers | Aucun bucket. Les PDF et exports CSV sont générés localement (`reports/`, gitignoré) | code |

### Ce que l'audit n'a PAS pu établir (absent du dépôt et inaccessible d'ici)
Le dépôt ne contient **aucune trace** de : China Sourcing, Radar Marché, de la PWA, du serveur PowerShell, du tunnel Cloudflare temporaire, ni du traitement vocal Xiaomi. Je n'ai pas accès à votre PC Windows ni au Xiaomi. Je ne déduis donc rien sur eux.

**Informations à fournir (ou inventaire à lancer par vous sur le PC) avant tout déplacement :**
1. Emplacement du code de China Sourcing, Radar Marché et du serveur local (autre dépôt ? dossier Windows ?).
2. Où vivent aujourd'hui dossiers, conversations, transcriptions, corrections, fournisseurs, photos, documents : fichiers JSON/SQLite sur Windows ? IndexedDB/OPFS du navigateur Xiaomi ? Taille totale approximative.
3. Liste des ports, tâches planifiées PowerShell, variables d'environnement et jetons utilisés.
4. Existence de sauvegardes (où, quand, restaurées au moins une fois ?).
5. Plan/abonnement actuel des deux projets Supabase (Free ou Pro ; sauvegardes quotidiennes/PITR actives ?).

Principe : **aucun service n'est déplacé tant que ses connexions (données, secrets, ports, clients) ne sont pas cartographiées.**

## 2. Choix de l'hébergement (Mission 2)

### Comparatif
| Critère | Hetzner Cloud (UE) | Railway |
|---|---|---|
| Coût indicatif | VPS CX23 ≈ 4 €/mois, CX33 ≈ 6,5 €/mois (+ ≈ 0,50 € IPv4), hors TVA. Hausse de ≈ 30 % en avril 2026 ; certains modèles ont été signalés indisponibles | Pro 20 $/mois (crédit d'usage inclus) + usage (≈ 20 $/vCPU, 10 $/Go RAM, volumes 0,15–0,25 $/Go, sortie ≈ 0,05 $/Go selon sources) |
| Régions | Allemagne/Finlande (UE) — résidence des données claire | Régions US/EU/Asie ; choix UE à confirmer |
| Maintenance | **Vous** : OS, mises à jour, pare-feu, Docker | Gérée (build, déploiement, TLS) |
| Persistance | Disque du VPS + volumes ; tout est à configurer | Volumes managés, limites de taille/IO |
| Sauvegarde / reprise | À construire (c'est de toute façon requis ici, voir §4) | Sauvegardes de volume limitées ; export externe à construire quand même |
| Contrôle sécurité | Total (pare-feu, SSH, fail2ban, journaux) | Plus limité, dépend du fournisseur |
| Risque de verrouillage | Faible (Docker Compose portable) | Moyen |

### Recommandation
**Hetzner Cloud en UE (Allemagne), un seul VPS en préproduction puis production, Docker Compose + reverse proxy Caddy (HTTPS automatique).** Railway reste l'alternative si vous préférez zéro maintenance serveur, au prix d'un coût variable moins prévisible et d'un contrôle moindre.

**Base de données :** conserver Supabase (déjà en UE, déjà utilisé par Finance) pour Finance et le noyau retail. Ne pas migrer Finance sans nécessité. Les nouvelles données Nordla (dossiers, notes, sync mobile) peuvent soit utiliser Postgres dans le même projet Supabase, soit un Postgres sur le VPS ; **décision à prendre** (voir §7).

### Architecture modulaire
```
Internet ── HTTPS ── Caddy (TLS, en-têtes de sécurité, limitation de débit)
                      ├── nordla-gateway   (auth passkeys, sessions, API de sync)  Node 24
                      ├── nordla-pwa       (fichiers statiques PWA)
                      ├── china-sourcing   (Node 24)
                      ├── radar-marche     (module)
                      ├── finance          (src/finance, exposé via la gateway)
                      └── <futur module>   (nouveau conteneur + une route, rien d'autre à reconstruire)
Données :  Postgres (Supabase UE ou VPS) · stockage objets chiffré (photos/documents)
Hors serveur : sauvegardes chiffrées immuables (§4), supervision externe
```
Règles : un conteneur par module, secrets injectés côté serveur uniquement, un contrat d'API versionné par module, Node 24 pour China Sourcing (le dépôt actuel exige `>=20` : l'alignement sur 24 est à tester avant déploiement).

### Budget mensuel réaliste (hors TVA, estimation à valider)
| Poste | Hetzner (recommandé) |
|---|---|
| VPS CX33 + IPv4 | ≈ 7 € |
| Sauvegardes automatiques du VPS (≈ 20 %) | ≈ 1,5 € |
| Stockage objets pour photos/documents + sauvegardes immuables (compte séparé) | ≈ 6,5–10 € |
| Domaine | ≈ 1–2 € |
| Supabase | 0 € (Free) ou ≈ 25 $ (Pro, sauvegardes/PITR) — selon plan actuel |
| Supervision externe | 0 € (offre gratuite) |
| **Total** | **≈ 15–25 €/mois**, ≈ 40–50 € avec Supabase Pro |
Railway : ≈ 25–40 $/mois pour une charge comparable, variable. **Aucun achat sans votre accord.**

## 3. Migration sans perte de données (Mission 3)

Principes : copier, jamais déplacer ; l'ancien système reste intact et fonctionnel jusqu'à validation écrite.

1. **Inventaire** (lecture seule) de toutes les sources : Windows, serveur local, stockage du navigateur Xiaomi, sauvegardes. Pour chaque source : chemin, taille, nombre d'objets, date de dernière modification.
2. **Sauvegarde de référence** de chaque source, avant tout transfert, puis **vérification** : somme SHA-256 par fichier, comptage, ouverture d'un échantillon. Sauvegarde du Xiaomi par export depuis l'application (le stockage navigateur ne se copie pas comme un dossier).
3. **Manifeste** : un fichier listant chaque objet (id, type, taille, SHA-256, version).
4. **Import en préproduction** par script idempotent (ré-exécutable sans doublons). **Les identifiants de dossiers sont conservés tels quels** ; les nouveaux objets utilisent des UUID générés côté client.
5. **Vérification après import** : comptes par type, SHA-256 des fichiers, diff manifeste ↔ base, contrôle manuel d'un échantillon de dossiers, photos et transcriptions.
6. **Rejeu** : l'import peut être refait depuis les sauvegardes à tout moment.
7. **Aucune suppression** de l'ancien environnement avant : validation de la plateforme, ≥ 30 jours de fonctionnement, une restauration réussie.

Versions et conflits : chaque enregistrement porte `id`, `rev` (entier incrémenté), `base_rev` (version sur laquelle la modification a été faite), `updated_at`, `device_id`, `deleted_at` (suppression logique). Le serveur accepte une écriture si `base_rev` = `rev` courant ; sinon **les deux versions sont conservées** et marquées en conflit. Les notes et brouillons texte ne sont jamais écrasés silencieusement (fusion ou choix humain). Champs indépendants fusionnés automatiquement ; le même champ modifié des deux côtés = conflit présenté à l'utilisateur.

## 4. Sécurité et cyber-résilience (Mission 4)

**Authentification**
- Passkeys (WebAuthn) liées au téléphone : déverrouillage biométrique, résistant à l'hameçonnage. Code TOTP en secours ; codes de récupération imprimés, stockés hors ligne.
- Un compte par personne ; appareils enregistrés et révocables ; sessions courtes avec renouvellement ; cookie `HttpOnly`/`Secure`/`SameSite`.
- Opérations administratives : ré-authentification récente exigée, rôle séparé, journal d'audit.
- Le lien avec jeton permanent est supprimé comme mécanisme de production (toléré en développement uniquement).

**Réseau et système** : HTTPS partout (HSTS), pare-feu par défaut « tout fermé » sauf 80/443, SSH par clé uniquement, hors du port par défaut ou via VPN, fail2ban, mises à jour de sécurité automatiques, conteneurs non-root, limitation de débit et CORS stricts (dette déjà notée dans `docs/security/baseline.md`, à traiter avant toute exposition publique).

**Secrets** : uniquement côté serveur (fichier chiffré ou gestionnaire de secrets), jamais dans le dépôt ni le navigateur ; rotation planifiée. À corriger avant exposition : policies RLS explicites et `search_path` des 6 fonctions `fin_*`, et clé `service_role` jamais envoyée au client.

**Journalisation et alertes** : journaux applicatifs et d'authentification, supervision d'accessibilité depuis un service externe, alertes (e-mail/notification) sur disponibilité, échecs de connexion répétés, espace disque, échec de sauvegarde.

**Sauvegardes (règle 3-2-1, chiffrées, immuables)**
- Outil type restic/Borg : chiffrement côté serveur avant envoi, déduplication, versions multiples.
- Destination sur un **compte fournisseur distinct** du serveur, avec **verrouillage d'objets (object lock) / rétention immuable** ; le serveur ne dispose que d'une clé « écriture seule », sans droit de suppression ni de modification de la rétention.
- La clé de chiffrement et le mot de passe du dépôt sont conservés **hors serveur** (gestionnaire de mots de passe + copie papier).
- Fréquence : base toutes les heures/jours selon le volume, fichiers quotidiens ; rétention quotidienne 30 j, hebdomadaire 12 sem., mensuelle 12 mois.
- Les snapshots du VPS sont un complément, pas la sauvegarde.
- **Test de restauration réel** avant mise en production, puis trimestriel : restauration sur un VPS vierge, comparaison au manifeste, mesure du temps (RTO) et de la perte maximale (RPO).
- **Runbook de reconstruction après compromission totale** : serveur considéré perdu, recréation par script (cloud-init + Compose versionnés), rotation de tous les secrets et sessions, restauration depuis l'immuable, vérification d'intégrité.

## 5. Xiaomi et déplacements (Mission 5)

- PWA installable depuis une adresse HTTPS stable (manifeste + service worker) ; cache de l'application pour démarrer sans réseau.
- Hors ligne : IndexedDB pour notes, conversations, brouillons ; photos en file d'attente (taille réduite, envoi reprenable par blocs). File d'envoi persistante (« outbox ») avec reprise automatique.
- Retour du réseau : synchronisation par versions (§3), jamais d'écrasement silencieux ; écran de résolution des conflits.
- Demander le stockage persistant (`navigator.storage.persist()`) pour limiter l'éviction des données par Android. Limite connue : Android peut vider les données d'un site peu utilisé ; la sync régulière reste la vraie protection.
- Traitement vocal local sur Xiaomi : conservé tel quel ; seule la sortie (transcription) entre dans la file de sync.
- **Belgique / Chine** : mesures réelles, pas de promesse. Plan de test : accès (DNS, TLS, latence, débit, taux d'échec) depuis réseaux belges fixe/4G/5G, puis depuis la Chine (cartes SIM locales/itinérance, Wi-Fi hôtel) avec répétition à plusieurs moments. Les adresses d'hébergeurs européens peuvent être lentes ou instables en Chine, parfois bloquées ; le mode hors ligne est la mitigation principale. Un CDN ou un domaine alternatif ne sera étudié qu'après mesure.

## 6. Validation et déploiement par étapes (Mission 6)

| Étape | Contenu | Critère de sortie |
|---|---|---|
| 0 | Réponses aux questions du §1, décisions du §7 | Inventaire complet signé |
| 1 | Sauvegardes de référence vérifiées | SHA-256 + échantillon restauré |
| 2 | Préproduction (VPS, domaine de test, Caddy, auth, sauvegarde immuable) | Scan de sécurité propre, alertes testées |
| 3 | Import des données (copie) | Manifeste = base, échantillon validé |
| 4 | Tests Xiaomi 4G/5G, **PC Windows éteint** | Ouverture, saisie, photos OK |
| 5 | Tests de résilience : coupure réseau, conflits, redémarrage serveur, **restauration complète** | Données intactes, RTO/RPO mesurés |
| 6 | Tests d'accès Belgique puis Chine (mesures) | Rapport chiffré, sans promesse |
| 7 | Bascule en production avec accord explicite ; ancien environnement conservé en lecture/rollback ≥ 30 j | Aucune perte, retour arrière testé |

**Retour arrière** : l'environnement existant reste intact et démarrable ; la bascule ne change que l'adresse utilisée ; les écritures de la période de test sont exportables vers l'ancien système.

### Risques principaux
| Risque | Mitigation |
|---|---|
| Sources de données non identifiées (stockage navigateur Xiaomi, services hors dépôt) | Inventaire obligatoire en étape 0 |
| Perte de données par conflit de sync | Versions, conservation des deux copies, tests dédiés |
| Compromission du serveur | Passkeys, durcissement, sauvegardes immuables isolées, runbook testé |
| Accès instable depuis la Chine | Hors ligne d'abord, mesures réelles |
| Éviction du stockage par Android | Persistance demandée, sync fréquente |
| Hausses de prix / indisponibilité des modèles Hetzner | Compose portable, plan B Railway |
| Exposition de tables sans policies RLS | Policies explicites avant exposition |

## 7. Décisions attendues de vous
1. Hetzner (recommandé) ou Railway ?
2. Nouvelles données Nordla : dans Supabase, ou Postgres sur le VPS ?
3. Autoriser la création d'un compte Hetzner et d'un second compte de stockage pour les sauvegardes immuables (budget ≈ 15–25 €/mois) ?
4. Fournir les informations du §1 (emplacement du code et des données de China Sourcing, Radar Marché, serveur local).
5. Domaine à utiliser (ou à acheter).
