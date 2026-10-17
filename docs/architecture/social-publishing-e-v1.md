# Chantier E — Social Publishing / Activation V1 (Instagram · Facebook)

- **Branche :** `feature/social-publishing-e` (base `integration/nordla-pre-china` f7197d5). **Code :** `src/social/` · **Tests :** `test/social-*.test.js` · **Lancer :** `npm run social` (app) · `npm run social:cli` (import / statut / calendrier).
- **Mandat :** permettre à HABB de reprendre ses publications pendant le voyage, avec validation humaine et sans perdre le contrôle des comptes.
- **Aucune fusion, aucun déploiement, aucune dépense, aucun secret touché, aucune publication réelle.** Les branches A, B, C, D et Convergence ne sont pas modifiées (fusion à blanc vérifiée : 0 conflit avec chacune).

```text
CONCLUSION
  Module Nordla (workflow, approbation, calendrier, publication, app mobile, secours manuel) ... PRÊT POUR CONVERGENCE
  Publication AUTOMATIQUE réelle sur Instagram / Facebook ........................... NON VÉRIFIÉE (jamais appelée sur un vrai compte)
  Publication À LA MAIN avec approbation de la version exacte (pack manuel) ......... OPÉRATIONNELLE et testée
```

« Prêt pour convergence » veut dire : le module est additif, isolé, testé contre de faux serveurs, et se fusionne sans conflit. Cela **ne veut pas dire** que HABB publie déjà automatiquement : voir §9 (blocages) et §10 (autorisations).

---

## 1. État réel de l'existant (audit, 2026-10-16)

| Composant | Où | Réel / simulé / absent | Preuve |
|---|---|---|---|
| Couche d'exécution Activation (Instagram, TikTok, Google Business) | `feature/activation-channel-execution-v1` (dans la base) | **Code complet, testé contre des FAUX** (HTTP, identifiants, média). Aucun compte réel. Se déclare lui-même `ADAPTER_READY`, **pas** `PRODUCTION_READY`. | `docs/architecture/activation-channel-execution-v1.md` §0, §10 |
| Provider Provisioning & Live Connections (OAuth, coffre, Connection Center backend) | `feature/provider-live-connections-v1` (dans la base) | **Backend complet, testé contre des faux** + smoke PostgreSQL/Vault. **Aucun compte connecté, aucune app Meta/TikTok/Google créée**, pas d'UI. | `provider-provisioning-live-connections-v1.md` : « REAL MERCHANT ACCOUNTS CONNECTED = NO · LIVE PUBLISHING ENABLED = NO » |
| Marketing V1 (M1→M4) | branches `feature/marketing-*` | Prépare des manifestes / autorisations Socle ; **ne publie pas**. | docs M3/M4 |
| **Facebook** | — | **Absent** de l'Activation (seulement Instagram, TikTok, Google). Ajouté ici. | `src/activation/constants.js` |
| Calendrier éditorial, file d'approbation du propriétaire, app téléphone, historique de publication | — | **Absents.** Ajoutés ici. | — |
| Notifications d'approbation | `src/finance/mail.js` seulement | **Aucune capacité utilisable** : le seul code d'e-mail (Finance) prépare un brouillon `.eml` à envoyer soi-même, envoi direct « NON CONFIGURÉ » ; aucun push. Remplacé par le compteur « À examiner » dans l'app. | `src/finance/mail.js` (NoMailAdapter) ; recherche dans `src/` |
| Jeton / compte Instagram ou Facebook | `.env` du dépôt principal | **Aucun** (seules les *variables* `INSTAGRAM_*` existent dans `.env.example`, sans valeur). Je n'ai lu aucune valeur de secret. | `.env.example` l.53-56 |

**CI** (API GitHub non authentifiée, 2026-10-16) — à ne pas confondre avec une publication réelle réussie : sur `integration/nordla-convergence-v1`, *Activation & Channel Execution V1* = succès, *Marketing V1* = succès, **mais *Provider Provisioning & Live Connections V1* = échec** (11:35) ; sur `feature/stock-achat-v1`, *Activation* et *Provider* = **annulés** (timeouts de job, cause inexpliquée de ma part) ; sur `feature/core-field-assistant-convergence-compat`, *Marketing V1* = annulé. Je n'ai pas pu lire les journaux (authentification requise). **Un workflow vert ne prouve aucune publication** : ces suites n'appellent jamais une vraie plateforme.

## 2. Architecture

```text
 chantier D ──(social-post-proposal.v1)──►  import idempotent ──►  POST (DRAFT)
                                                                        │ submit (agent)
 propriétaire (téléphone) ◄── READY_FOR_REVIEW ◄────────────────────────┘
        │ approve(content_hash vu à l'écran)     │ request_changes / reject
        ▼                                        ▼
     APPROVED ──schedule──► SCHEDULED ──(Nordla à l'heure | Facebook natif)──► PUBLISHING ──► PUBLISHED ──lecture LIVE──► VERIFIED
        │ revoke / edit / cancel : approbation annulée, copie plateforme retirée, jamais d'envoi
        ├── secours : pack manuel → « je l'ai programmé dans Meta » (Nordla ne publiera JAMAIS ce post : pas de doublon)
        └── secours : … → « j'ai publié à la main » (lien) → PUBLISHED(MANUAL) → « j'ai vérifié » → VERIFIED
```

- `workflow.js` : machine d'états pure. **Seul le propriétaire** approuve, refuse, programme, révoque, relance, rapproche ou atteste ; le publisher n'a que des actions système ; un agent (D) ne peut qu'éditer et proposer.
- `post.js` : le contenu approuvé et son empreinte (`content_hash`) ; contrôle des promesses commerciales.
- `store.js` : fichiers atomiques (ou mémoire) + journal d'audit en ajout seul. Tout enregistrement est scanné : un jeton ou une URL signée est refusé.
- `publisher.js` : envoi **une seule fois** (réservation durable `SCHEDULED→PUBLISHING`), reprise de conteneur Instagram, résultat inconnu jamais rejoué, lecture LIVE pour vérifier.
- `providers/meta.js` : Instagram (réutilise l'adaptateur Activation) et Facebook Page (nouveau). `providers/simulated.js` : démo, jamais confondu avec du réel.
- `calendar.js` : Europe/Brussels ↔ UTC (changement d'heure du 25 octobre inclus), seaux « programmable / à approuver / à corriger / visuel manquant / publié », proposition de dates.
- `server/` + `ui/` : API à jeton + app mobile en français (`À examiner · Calendrier · Programmés · Publiés · Connexions`).

## 3. Contrat d'intégration avec le chantier D (`social-post-proposal.v1`)

D **possède** la création et les assets ; E **possède** le calendrier, l'approbation et la publication. D ne publie, ne programme et n'approuve jamais.

```jsonc
{
  "schema": "social-post-proposal.v1",
  "proposal_id": "stable par décision créative",        // identifiant unique ; post id dérivé de (proposal_id, plateforme, format)
  "producer": "chantier-d",
  "subject": { "kind": "product|campaign|brand|store", "ref": "…", "label": "…" },   // produit ou campagne
  "asset":  { "ref": "asset://…", "version": 1, "sha256": "64 hex", "content_type": "image/jpeg",
              "width": 1080, "height": 1350, "ai_generated": false, "alt_text": "…" },   // asset final + version immuable + empreinte
  "assets": [ /* 2 à 10, uniquement pour un CAROUSEL */ ],
  "caption": "…", "hashtags": ["Namur"],                // texte et hashtags
  "targets": [ { "platform": "instagram|facebook", "format": "IMAGE|REEL|TEXT|CAROUSEL|STORY" } ],   // plateforme + format
  "suggested_date": "ISO avec fuseau",                  // date proposée : une SUGGESTION, jamais imposée
  "notes": "…"
}
```

Chaque post conserve : statut, **auteur de la validation** (`approval.approved_by`), **historique complet** (`history[]` : acteur, action, de→vers, empreinte, note) et la date proposée.

Règles garanties par les tests :
- Livrer **le même contenu** = aucun effet (`UNCHANGED`). Livrer **une nouvelle version d'asset ou un autre texte** = le post est modifié, **repasse en brouillon et l'approbation est annulée** (D ne peut pas changer en silence ce que vous avez approuvé).
- Un post déjà publié / en cours de publication est **intouchable** (`REFUSED_FROZEN`) : un nouveau `proposal_id` est requis.
- La date choisie par le propriétaire n'est jamais écrasée par `suggested_date`.
- **L'asset doit être un fichier précis** : empreinte vérifiée à l'aperçu, au téléchargement et à l'envoi (`ASSET_CHANGED` si le fichier servi n'est plus celui approuvé).
- Un asset peut manquer (brief seulement) : le post est conservé, marqué « visuel manquant », non soumettable.
- Adaptateur fourni pour le format réel de D (`reports/editorial-14j/posts.json`, v1) : `src/social/adapters/habb-editorial.js` — lecture seule, visuels copiés et empreints dans la bibliothèque de Nordla.

**Demandes à D** : (1) livrer des **JPEG** pour tout visuel Instagram destiné à l'envoi automatique ; (2) un `proposal_id` stable ; (3) `ai_generated` renseigné (Meta propose une déclaration `is_ai_generated`, déjà transmise si vrai) ; (4) une **nouvelle version** d'asset à chaque retouche, jamais un écrasement.

## 4. Workflow d'approbation — états

`Brouillon → À examiner → Approuvé → Programmé → Publié → Vérifié`, plus `Refusé`, `À corriger`, `Erreur`, `Annulé` (exigés), et deux états internes nécessaires : `Publication en cours` (réservation) et `Résultat inconnu — à vérifier` (un appel créateur a peut-être abouti : jamais rejoué, jamais déclaré échoué, jamais vérifié ; le propriétaire rapproche avec un lien comme preuve).

- **Autorisation sur la version exacte.** Approuver / programmer exige l'empreinte vue à l'écran ; si le contenu a changé entre-temps → `409` « regardez la nouvelle version ». L'empreinte couvre : asset (réf + version + sha256), texte, hashtags, plateforme, format, compte, sujet **et l'heure de publication**.
- **Modifier un contenu approuvé** (même programmé) → retour en brouillon, approbation effacée, mention dans l'historique ; si Facebook détenait une copie programmée, sa suppression est enregistrée **dans la même écriture** puis réessayée jusqu'à confirmation (alerte rouge sinon ; reprogrammer est bloqué tant que la copie n'est pas confirmée supprimée).
- **Défense en profondeur.** Même si un enregistrement est falsifié (état `SCHEDULED` mais texte différent), le publisher refuse (`NO_VALID_APPROVAL`) : l'approbation est recalculée contre le contenu courant.
- **Promesses non confirmées bloquées** (prix, remise, délai, garantie, urgence) à la soumission **et** à l'approbation. Les faits confirmés par le propriétaire sont dans `confirmed-facts.json` (un seul : coque 25 €, lié au mot « coque »). Un client ne peut pas fournir son propre registre.
- **Retard.** Un post en retard de plus de 6 h n'est pas envoyé en silence : `Erreur: MISSED_WINDOW`, à relancer par le propriétaire.

## 5. Connexions : ce qui existe, ce qui manque

| | Instagram | Facebook (Page) |
|---|---|---|
| **Connexion réelle aujourd'hui** | **Aucune** | **Aucune** |
| Authentification visée | Jeton utilisateur Instagram (« API with Instagram Login ») — via `SOCIAL_INSTAGRAM_TOKEN` (provisoire) ou OAuth + coffre (provider-connections, non activé) | Jeton de **Page** (Facebook Login) — `SOCIAL_FACEBOOK_PAGE_TOKEN` |
| Permissions | `instagram_business_basic`, `instagram_business_content_publish` ✔ doc 2026-06-30 | `pages_manage_posts`, `pages_read_engagement` (+ `pages_manage_engagement`, `pages_read_user_engagement`) ✔ doc 2026-04-17 |
| Compte | **Pro** (Business/Creator) obligatoire ; si la Page liée exige PPA (*Page Publishing Authorization*), publication impossible tant qu'elle n'est pas faite ✔ | Tâches `CREATE_CONTENT`, `MANAGE`, `MODERATE` sur la Page ✔ |
| Publier maintenant | Oui (conteneur → `media_publish`) — **non éprouvé en réel** | Oui (`/feed`, `/photos`) — **non éprouvé en réel** |
| **Programmer** | **Non par l'API** : c'est Nordla qui publie à l'heure ⇒ **Nordla doit être allumé et joignable** | **Oui, natif** (`published=false` + `scheduled_publish_time`, entre 10 min et 30 jours ✔ doc) ⇒ part même si Nordla est éteint. *Programmation d'une photo via `/photos` : paramètres non confirmés par la doc, à vérifier au premier essai.* |
| Médias | Image **JPEG uniquement** ✔ ; vidéo (Reel). **URL publique** requise au moment de l'essai ✔ ; carrousel/story : non automatisés ici | Photo par URL, texte seul ; carrousel : manuel ici |
| Limites | 100 publications API / 24 h ✔ (non appliquée côté Nordla : très au-dessus du besoin) | — |
| Expiration / erreurs | `AUTH_INVALID` → **Erreur : RECONNECT_REQUIRED** (pas de boucle de retry) ; `RATE_LIMITED`, 5xx, timeout avant création → nouvel essai avec délai 1→5→15→60 min (4 essais max) ; `SCOPE_MISSING`, `INVALID_PAYLOAD` → erreur finale ; expiration du jeton lue dans `SOCIAL_*_TOKEN_EXPIRES_AT` (avertit à 7 jours) | idem ; suppression d'une copie programmée : 404/code 100 = déjà supprimée |
| Journal | `audit.jsonl` (append-only) + `history[]` par post | idem |

**Secrets** : jamais affichés, journalisés, ni enregistrés (testé : ni jeton ni URL média éphémère dans le store, l'audit, les journaux, les requêtes enregistrées). La vue « Connexions » n'affiche que présence et expiration.

**Rien de ceci n'a été appelé sur une vraie plateforme.** Pour passer en réel : `docs/runbooks/social-go-live.md`.

## 6. Fiabilité opérationnelle — résultats

`npm test` ciblé : **54 tests, 54 réussis** (`social-core`, `social-calendar-intake`, `social-server-import`). Chaque ligne de la demande :

| Exigence | Preuve (test) |
|---|---|
| Publication unique, sans doublon après nouvelle tentative | 3 workers concurrents → 1 seul `POST /media_publish` ; relances successives → toujours 1 ; erreur `429` puis succès → **un seul conteneur** (repris) ; timeout sur `media_publish` → `Résultat inconnu`, **aucun second essai** même 24 h plus tard |
| Programmation en Europe/Brussels | 18:00 reste 18:00 de part et d'autre du 25 octobre ; heure inexistante (28 mars 02:30) refusée ; heure ambiguë → première occurrence ; l'API accepte l'heure locale et stocke en UTC |
| État réel renvoyé par la plateforme | `VERIFIED` uniquement après une **lecture LIVE** (permalien) ; une simulation ne peut **jamais** être vérifiée ; une vérification négative est consignée, sans changer l'état |
| Gestion des échecs | jeton invalide, compte personnel, média modifié, fenêtre manquée, retries épuisés, travailleur mort en plein appel (conteneur existant → reprise ; sinon → inconnu) |
| Révocation avant publication | post programmé puis approbation retirée → aucun appel plateforme à l'heure dite ; copie Facebook supprimée, ou « en attente » réessayée |
| Modification et annulation | modifier un post approuvé efface l'approbation ; `cancel`/`unschedule` ; pas d'annulation pendant `PUBLISHING` |
| Historique des actions | séquence `submit → approve → schedule → claim → … → mark_verified` avec acteur et rôle |
| Notifications d'approbation | **aucune capacité existante** → compteur « À examiner » dans l'app (voir §1) |
| Mode de secours manuel | pack (texte exact + fichier vérifié + étapes) → « programmé dans Meta » (Nordla s'interdit de publier ce post, testé) → attestation avec lien → vérification par le propriétaire ; exige l'approbation de la version exacte ; révoquer/modifier un post programmé à la main chez Meta lève une alerte rouge jusqu'à confirmation de suppression de la copie Meta |

**Échecs / limites constatés pendant le développement (corrigés) :** (1) l'identifiant de conteneur Instagram n'était pas conservé si la publication échouait après sa création → un nouvel essai en aurait recréé un (corrigé, testé) ; (2) la contrainte JPEG d'Instagram bloquait à tort l'**approbation** de tous les visuels de D (PNG) → déplacée vers « jamais envoyé par la machine, publié à la main ».

**Non testé** : tout appel réseau réel ; Facebook et Instagram contre un compte de test ; un vrai téléphone et un vrai réseau ; le service worker/hors-ligne (non fourni) ; la charge ; l'exécution sous Node 20 (testé sous Node 24.19) ; aucune CI dédiée n'a encore tourné sur cette branche.

## 7. Expérience pendant le voyage

Depuis le téléphone (`npm run social`, jeton de 48 caractères généré au premier lancement, **boucle locale par défaut**) : voir les propositions (visuel + texte exact + plateforme + date de Bruxelles), approuver *cette version*, demander une correction, refuser, voir les programmés, voir ce qui est **réellement** publié (étiquettes : « Publié sur la plateforme » / « Publié à la main (attesté) » / « SIMULÉ — rien n'a été publié »).

**L'app doit être joignable depuis votre téléphone** : aujourd'hui elle tourne sur un PC et n'est pas hébergée (décision et autorisation requises, §10). Voir `docs/runbooks/social-manual-fallback-and-china.md` pour le plan de secours réseau.

## 8. Fichiers

Créés : `src/social/{constants,post,workflow,store,service,publisher,calendar,intake,assets,credentials,cli}.js` · `src/social/providers/{meta,simulated}.js` · `src/social/adapters/habb-editorial.js` · `src/social/server/{app,index}.js` · `src/social/ui/{index.html,app.css,app.js}` · `test/social-{fixtures.js,core.test.js,calendar-intake.test.js,server-import.test.js}` · `docs/architecture/social-publishing-e-v1.md` · `docs/runbooks/social-go-live.md` · `docs/runbooks/social-manual-fallback-and-china.md` · `docs/operations/social-calendar-2026-10-19.md`.
Modifié : `package.json` (+2 scripts `social`, `social:cli`). **Aucun fichier existant d'Activation, Provider, Marketing, Finance, D, C ou Convergence n'est modifié** (le module *réutilise* `src/activation/*` en import).

## 9. Blocages

1. **Aucun compte Meta connecté** : pas d'app Meta créée/configurée, pas de jeton, pas de Page/compte Pro confirmé. Bloque toute publication automatique.
2. **Hébergement des médias** : Instagram et Facebook doivent télécharger l'image sur une **URL publique**. Il n'existe aucun service. Il faut un dossier HTTPS public adressé par empreinte (`<base>/<sha256>.<ext>`), non décidé (voir runbook).
3. **Nordla doit tourner à l'heure dite** pour Instagram (pas de programmation côté Instagram). Pas d'hébergement décidé (Railway est le chantier B).
4. **Visuels en PNG** : Instagram n'accepte que le JPEG par l'API → publication manuelle jusqu'à livraison de JPEG par D.
5. **22 contenus sans visuel** (brief seulement) ; **0 contenu approuvé**.
6. **Carrousels et stories** : publiés à la main dans cette V1.
7. **Faits non vérifiés** : programmation d'une photo Facebook via `/photos` ; niveau d'accès Instagram pour votre propre compte ; PPA de la Page.
8. **Réseau en Chine** : Instagram/Facebook peuvent être inaccessibles depuis la Chine continentale sans itinérance ou VPN ; **je ne l'ai pas testé** (voir runbook).

## 10. Autorisations nécessaires (rien n'a été fait sans elles)

- Créer / configurer l'app Meta et générer les jetons (action du propriétaire, dans son compte).
- Choisir et autoriser l'hébergement public des médias (coût possible) et l'hébergement de Nordla (Railway = chantier B).
- Autoriser le premier envoi **réel** de test (sur un compte/Page de test, puis sur le compte HABB), post par post.
- Valider : registre A/B, rythme, fait « coque 25 € », demande de JPEG à D.
- Toute fusion dans `main` / Convergence reste à votre décision.

## 11. Dettes et recommandations (non implémentées)

- **PLUS TARD** : carrousels et stories (API Instagram documentée pour les carrousels ; Facebook = pièces jointes), vérification du quota 100/24 h, webhooks, notifications push/e-mail, remplacement du port `credentials` par le coffre de `provider-connections` (OAuth), UI de connexion.
- **RECOMMANDÉ** : une CI dédiée `social-publishing-e` (Node 20 + 24) ; un essai réel sur une Page Facebook de test avant tout compte réel.
