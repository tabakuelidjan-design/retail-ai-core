# Nordla Growth — parcours des données, de la source à la décision, à l'action et au résultat

Valide par `test/growth-lineage.test.js` (LN-1 chaîne complète, LN-2 changement en amont), sur le chemin serveur réel avec une base en mémoire en lecture seule.

## Hiérarchie

```
données synchronisées (commandes, remboursements, stocks, coûts)        [Core -> base]
  -> moteurs (Produits Potentiels, Audience, Croissance magasin, Contenu)  [décident un statut + preuves]
  -> priorités (buildPriorities)                                           [un candidat par constat]
  -> serveur (createPrioritiesSource): measurement, preparedAction, target, prerequisites, weekly
  -> marchand (écran Opportunités): plan -> prérequis -> application      [décide, historique local versionné]
  -> résultat (serveur /api/growth/review): unités nettes avant / après    [enregistré avec l'action]
```

## Identité conservée à chaque passage

| Élément | Porté par | Conservé jusqu'à |
|---|---|---|
| Cible | `item.id` (`product:<id>`, `segment:<clé>`, `store:<jour>`), `target.variantId`, `target.location` | plan, application, revue |
| Période | `measurement.start/end` (fenêtre du moteur), `variant.since/until` ; avant/après : `localStart/localEnd` | revue enregistrée (`computed`) |
| Source | `evidence.source`, règle `growth-weekly.1`, `growth-review.1`, instantané de stock daté | plan (`snapshot`), revue (`computed.rule`) |
| Version | `plan.at` (révision strictement croissante) ; l'application porte `planAt` | application, prérequis, revue |
| Marchand | fixé par le contexte serveur ; historique local clé = hash du périmètre + id | aucun paramètre marchand dans l'API |

## Par option

| Option | Reçoit | Fournisseur | Décide | Transmet | Utilisé ensuite par |
|---|---|---|---|---|---|
| Produit / variante à pousser | ventes nettes par variante (fenêtre 8 semaines pleines), stock daté, coût vérifié | Produits Potentiels (`variantRowsFromDataset`, `chooseVariant`) | moteur : statut `push` ; serveur : variante leader (fenêtres égales, stock vérifié, leader unique, couverture ≥ 4 sem.) sinon raison de refus | `preparedAction` (variante, unités nettes, stock, fenêtre), `target` | classement hebdo, plan marchand, revue |
| Réassort | couverture (stock / rythme) + délai fournisseur | Produits Potentiels | moteur : `restock` ; classement : prérequis « délai fournisseur » | action « commander », prérequis | plan, application |
| Action magasin (jour de semaine) | ventes par jour de semaine, volume suffisant | Croissance magasin | moteur : jour retenu | `target.location`, jour | plan, revue (unités du magasin) |
| Campagne e-mail (réactivation / fidélisation) | clients identifiés, commandes de référence, jours d'inactivité | Audience | règle de segment (min. 30 clients), sinon aucun segment validé | `campaign` (objectif, clients, jours, raison), `eligible:null` | brouillon, « marquée envoyée », revue campagne |
| Classement hebdomadaire | priorités + `measurement`/`target`/`prerequisites` | `rankWeeklyActions` | éligibilité (blocages), paliers, faisabilité ; 3 max, même type comparé seulement par ampleur | rang + raison (`rankReason`) | écran (lignes), plan |
| À revoir | application (date), plan (date de revue, valeur de départ) | historique local + `/api/growth/review` | le marchand clôt ; le serveur calcule avant/après | `computed` (fenêtres, unités, règle) + valeur du marchand séparée | historique |

## Ce qui est réévalué quand une donnée en amont change

- Statut du moteur, variante choisie, couverture, classement, blocages, prérequis : **recalculés à chaque lecture** (LN-2a : un coût non vérifié fait sortir le produit des actions validées).
- Prérequis cochés : **invalidés** si l'action, la métrique, le produit, l'URL ou le segment de la campagne change.
- Calcul avant/après d'une revue **non enregistrée** : recalculé (LN-2b : un remboursement synchronisé plus tard est déduit une fois, dans la fenêtre de la vente).

## Ce qui reste figé dans l'historique

- Le plan (révision `at`), sa valeur de départ saisie, sa date de revue.
- L'application (`date`, `planAt`, prérequis cochés, destinataires).
- La revue enregistrée : seul un calcul `COMPARABLE` est conservé, avec fenêtres, unités, règle ; il n'est jamais recalculé à la réouverture (LN-2b : 3 reste 3 après un remboursement ultérieur). La valeur saisie par le marchand est toujours affichée à part.
- Une revue ne remplace jamais l'application : elle pointe sur `planAt`.

## Ajouts postérieurs (campagne e-mail, dossier de correction)

- **Campagne** : la date d'envoi déclarée (`applied.date`, liée à `planAt`) devient la borne de la revue. La période de mesure ne peut pas commencer avant elle, la revue prévue du plan doit la suivre, et une correction de date qui contredit une revue enregistrée est refusée (historique intact). Segment (clients analysés), destinataires ciblés (saisis) et e-mails délivrés (mesure) sont trois nombres distincts, jamais substitués. Tests CA-9 à CA-11.
- **Dossier de correction** : lecture seule, produit à la demande à partir des mêmes faits (Contenu, Produits Potentiels). Il porte l'identifiant stable Shopify, le module détecteur, la preuve datée et la prochaine étape ; il n'écrit rien et n'est pas un historique. Tests DC-1 à DC-7.

## Site indépendant (lot _07) — page de devis

**Sources réellement accessibles (vérifié dans le dépôt) :** aucun connecteur GA4 ni Search Console. Nordla n'a que des contrats d'import (`src/marketing/traffic.js` : sessions par page d'entrée, parcours *achat* ; `src/marketing/search.js` : pages, requêtes, impressions, clics) et aucun contrat pour les événements de formulaire. Le lot définit donc un contrat d'import GA4 (`site-funnel`, `src/growth/site/site.js`) : jour par jour, par page, sessions / sessions ayant démarré le formulaire / ayant envoyé / ayant démarré puis envoyé (rapport d'entonnoir GA4 ou BigQuery ; absent = totaux séparés), événements configurés (`confirms`, `page_attributable`, `changed_on`) et, en option, des lignes Search Console. Lu depuis `data/local/marketing/site-funnel.json` (hors dépôt) ; absent = **NOT_CONNECTED**. Aucun site réel n'est connecté : le parcours est validé en simulation (`scripts/growth-sim.mjs`).

| Étape | Fournit | Décide | Transmet |
|---|---|---|---|
| Faits | GA4 : sessions, démarrages, envois (jour, page, fuseau de reporting, filtres, fraîcheur) ; Search Console : impressions, clics, requêtes de la page (définitions distinctes, jamais en numérateur/dénominateur avec GA4) | — | Propriété ↔ site ↔ page vérifiés (host, chemin normalisé) ; fuseau différent du marchand = pas de conclusion |
| Diagnostic `growth-site.1` | — | Période finie et ≥ 95 % de jours ; événements configurés, envoi **confirmé** (pas un clic), liés à la page ; volume (100 sessions existantes, 30 démarrages) ; taux = sessions démarrées **puis** envoyées / sessions démarrées (mêmes sessions) | Statut + chiffres + période + source ; sans figure séquentielle : totaux séparés, aucun abandon déduit ; vrai 0 ≠ indisponible (null) |
| Opportunités | — | Page exacte, motif, modification à tester (relire le formulaire) ou mesure à compléter (étape nommée) | Action `siteForm`, cible = page (URL), `targetRef` = `{page, chemin}` |
| Plan → application | Marchand (dans son site) | Valeur de départ, cible, date de revue, date d'application | Version du plan (`planAt`), date, page, événement |
| Revue `growth-review-rate.1` | Même contrat, jours des deux fenêtres | Deux fenêtres complètes de même durée (règle de revue existante : jour d'application exclu, semaines entières) ; COMPARABLE seulement si ≥ 95 % de jours, figure séquentielle présente, aucune reconfiguration d'événement entre les périodes, ≥ 30 démarrages de chaque côté | `12/60 → 18/60 · +10 points`, dates, effectifs, taux ; écart observé, jamais une cause |

**Réévalué quand la donnée amont change :** diagnostic, statut, action proposée, effectifs, comparaison non enregistrée. **Figé :** le plan, l'application (page, événement, date, version), la revue enregistrée (seul un calcul COMPARABLE est conservé avec ses fenêtres et effectifs) et la revue manuelle. Une opportunité sortie de la liste reste accessible dans « À revoir ». Agrégats uniquement ; le marchand est celui du contexte serveur.

## Abonnés Instagram / TikTok (lot _08) — « Gagner des abonnés »

**Sources réellement accessibles (vérifié dans le dépôt) :** Nordla n'a **aucune lecture** des statistiques Instagram ou TikTok (abonnés, portée, abonnements par publication). Il a seulement des adaptateurs de *publication* (`src/activation/providers`, capacités vérifiées le 2026-10-09) ; ils ne lisent pas de résultats. Le lot définit donc un contrat d'import (`src/growth/social/social.js`, fichier `data/local/marketing/social-<réseau>.json`, hors dépôt) : totaux d'abonnés début/fin (gagnés et perdus si la source les fournit), totaux de parcours du compte, publications (id, lien, date, format, organique/sponsorisée/inconnue, accroche, sujet, structure, portée et abonnements attribués à un âge donné), exemples publics fournis par le marchand ou une source connectée, option Trial Reels (déclarée par la source). Sans fichier : **NOT_CONNECTED**. Aucun compte réel n'est connecté : le parcours est validé en simulation (`scripts/growth-sim.mjs`, Instagram avec attribution, TikTok sans). Creator : son brief part d'un produit, d'un objectif, d'une marque et d'un format (`src/creative-autonomy/brief.js`) et le *handoff* Marketing exige un contexte gouverné (`src/marketing/creative-handoff.js`) ; aucun n'accepte un brief social : le brief est un export structuré et copiable avec sa provenance (`receivedBy: none`), l'intégration manquante est nommée dans le brief.

| Étape | Fournit | Décide | Transmet |
|---|---|---|---|
| Faits | Insights du compte et des publications (réseau, compte, période, source, marché) | — | Variation nette = fin − début (deux totaux comparables) ; gagnés/perdus seulement s'ils sont fournis (0 observé ≠ indisponible) ; parcours = totaux indépendants (`linked:false`) |
| Diagnostic `growth-social.1` | — | Abonnements attribués pour 1 000 comptes atteints = abonnements / portée de **la même publication** ; comparables = même réseau, même format, même statut, **même âge** ; seules les organiques servent de direction ; signal isolé si ≥ 2× les autres comparables (≥ 500 comptes) ; **tendance** seulement avec ≥ 3 exemples récents concordants de ≥ 2 comptes, sinon « idée à tester » + ce qui manque | Direction (élément testé = structure), preuves (lien, date, métrique, fenêtre, source) |
| Opportunités | — | Piste à tester ou test au niveau du compte (sans attribution par publication) | Action `socialTest`, brief **versionné** (id lié compte + réseau + opportunité + preuves), indicateur et âge d'observation **définis avant publication** |
| Creator | Brief structuré (format, accroche, plans, à montrer, ton, appel, indicateur, preuves) | Création adaptée à la marque | Aujourd'hui : export copiable ; rien n'est transmis automatiquement |
| Plan → publication | Marchand (dans son outil) | Lien de la publication réellement publiée, date ; association **déclarée** (réseau du lien vérifié côté écran) | `applied.post` = {id, lien, réseau, compte, `declared: manual`} + version du plan |
| Revue `growth-review-social.1` | Même contrat, publication retrouvée par id | La publication doit appartenir au compte et au réseau du plan, être observée à l'âge prévu, et se comparer aux autres publications du compte (réseau, format, statut, âge) | Taux, effectifs, source, décision suivante (refaire / ajuster / attendre) ; le solde net du compte reste une observation **distincte** ; revue manuelle si l'attribution manque |

**Réévalué quand la donnée change :** diagnostic, statut (signal/tendance), brief proposé, comparaison non enregistrée. **Figé :** le brief tel que testé (version et preuves, dans le suivi), le plan, la publication déclarée, la revue enregistrée (taux, effectifs, source, groupe de comparaison). Agrégats et identifiants publics uniquement ; le marchand est celui du contexte serveur. Rien n'est publié, aucun compte n'est modifié, aucune génération payante.

### Suite du lot _08 — réception par Creator et lecture Instagram (2026-11-16)

| Étape | Propriétaire | Identifiant qui relie à la suivante |
|---|---|---|
| Brief (Growth) | Growth : opportunité, version, indicateur | `briefId` = hash(réseau, compte, opportunité, version, direction, ids des preuves, **`merchant.ref`** = sha256 du marchand) ; le marchand n'apparaît jamais en clair |
| Réception (Creator) | Creator : `POST /api/creator/social-briefs` (`src/creative-autonomy/creator/social-brief.js`) | Recalcule `briefId` (fichier modifié → `BRIEF_ID_MISMATCH`) et compare `merchant.ref` au marchand **du serveur** (jamais celui de la requête) : autre boutique `MERCHANT_MISMATCH`, brief sans boutique `MERCHANT_UNKNOWN` ; sans contexte marchand (démo locale) : accepté avec l'avertissement « non vérifiable ». Aucun produit, aucune production, aucun appel payant. |
| Lecture Instagram | `src/growth/server/instagram-insights.js` (GET seul, `graph.instagram.com`) | Même contrat `normalizeSocial` : le diagnostic, le brief et la revue ne changent pas |

Faits de la source (docs Meta, 2026-11-15) : les statistiques exigent `instagram_business_basic` **et** `instagram_business_manage_insights` (ce dernier n'est pas dans les scopes de publication de Nordla ; demandé à part via `withInsights`) ; `follows` par publication n'existe **pas pour les Reels** (taux indisponible à la source) ; Instagram ne donne que le total **actuel** d'abonnés (le total de début vient de nos propres relevés, `data/local/marketing/instagram-followers.json`) ; le statut organique/sponsorisé n'est pas exposé (`unknown`).

## Du brief au calendrier de publication (lot _09, 2026-11-16)

Une étape = un propriétaire = un identifiant qui la relie à la suivante.

| Étape | Propriétaire | Identifiant (vers la suivante) | Règle |
|---|---|---|---|
| Test et brief | **Growth** (`src/growth/social/test.js`) | `growth_test_id` = id de l'opportunité (`social:<réseau>:<compte>`), `brief_id` + `brief_version`, `merchant.ref` | Growth garde l'opportunité, la version du brief et l'indicateur (taux pour 1 000 comptes atteints, âge d'observation fixé avant publication). |
| Création | **Creator** | `creation_id` + `creation_version` | Aujourd'hui Creator **reçoit et affiche** le brief ; il ne produit pas. La création du parcours est **simulée et marquée** (`scripts/lib/social-creation-sim.mjs` : producteur `creator-SIMULATED`, actif `asset://SIMULATION/…`, légende « SIMULATION », `links.simulated: true`). |
| Proposition | Contrat `social-post-proposal.v1` (`src/social/intake.js`) | `proposal_id` = `growth-<brief_id>` (stable : une nouvelle **version de création** modifie le même brouillon ; une nouvelle **version de brief** est une nouvelle proposition) | `origin.links` (optionnel, additif) relie la proposition au test, au brief, à la création, à `merchant_ref` (sha256, jamais l'id), au compte exact `{réseau, id}` et à la fenêtre d'observation. Les liens ne font **pas** partie du hash du contenu : relier ne retire aucune validation. Une proposition sans `links` s'importe comme avant. |
| Contrôle à l'import | **Publication sociale** | `account_ref` du post = `links.account.id` | Marchand : `links.merchant_ref` = marchand de l'installation (`NORDLA_MERCHANT_ID`, haché) sinon `MERCHANT_MISMATCH`. Compte : même réseau, `account_ref` obligatoire et égal au compte du test, et égal au compte connecté (`SOCIAL_INSTAGRAM_ACCOUNT_ID`) sinon `ACCOUNT_*`. |
| Brouillon → validation → calendrier | **Publication sociale** (états existants, signature de l'approbation, fuseau Europe/Brussels) | id du post (`post_<hash(proposal_id, plateforme, format)>`) | Contenu modifié ou nouvelle version de création : retour en brouillon, validation annulée, **date du propriétaire conservée**. Date changée : validation annulée. Post figé (publié, inconnu, annulé) : lien intact. |
| Publication | **Publication sociale** | `publication.post_id` = id **du réseau**, `permalink`, `published_at` | Confirmée = état PUBLISHED / VERIFIED **avec** date réelle et identifiant ou lien du réseau, et **pas** un éditeur simulé (sauf la simulation : `acceptSimulated`). |
| Lecture par Growth | **Growth** (`src/growth/server/social-publication.js`, lecture seule du dossier `posts/`) | `growth_test_id` + marchand + réseau + compte | Les posts d'un autre marchand, compte ou réseau sont ignorés (comptés). Aucune légende, aucun jeton, aucune approbation n'est renvoyé. L'état est relu à chaque appel (pas de cache). |
| Mesure et revue | **Growth** (revue du lot _08) | id du post du réseau = id de la publication dans la source des statistiques | Échéance = **jour réel de publication (Bruxelles) + fenêtre du brief**. Une date prévue, un état planifié, une publication en cours, incertaine, en erreur ou annulée **ne démarre rien**. « Rapprocher la publication confirmée » enregistre `applied` avec la date **réelle** et `declared: calendar` (+ versions de brief et de création) ; l'association manuelle (`declared: manual`) reste pour les publications faites hors Nordla. |

États affichés dans Opportunités (ligne compacte, détail à la demande) : brief préparé (aucun post) · brouillon · contenu validé · planifié · publication incertaine · publication confirmée · publication simulée · erreur · annulé. La date prévue est affichée à côté de la date réelle. Si le plan a été fait avec une autre version de brief que celle du post, l'écart est signalé.

**Ce qui attend encore** : un Creator réel qui produit un contenu à partir d'un brief social (la version simulée respecte le contrat) ; la connexion Instagram avec `instagram_business_manage_insights` (sans elle, aucune statistique réelle, donc aucune revue réelle) ; un lien exact vers un post dans l'app Publication sociale (elle n'a pas d'ancre par post : le lien ouvre son calendrier).

## Des conversations aux demandes qualifiées (lot _10, 2026-11-16) — « Générer des demandes qualifiées »

Objectif distinct de « Gagner des abonnés ». Le marchand choisit le type de demande à suivre (devis, réservation, autre demande explicite). **Aucun message n'est envoyé par Nordla** : la première réponse est un brouillon que le marchand envoie lui-même.

**Capacités réelles (vérifié dans la documentation Meta le 2026-11-16) :** Nordla n'a **aucune lecture de messagerie** (`src/activation/providers` ne publie que). L'API Conversations d'Instagram (`graph.instagram.com`, `/<IG_ID>/conversations`) existe, mais la permission pour **lister** est documentée de façon incohérente (la page Conversations cite `instagram_business_basic`, la page Messaging ajoute `instagram_business_manage_messages`), l'accès Standard suffit pour un compte possédé, et les conversations du dossier « Demandes » inactives depuis 30 jours ne sont pas renvoyées. **Non connecté ici.** TikTok : même contrat, aucune capacité de messagerie vérifiée. Manychat (référence fonctionnelle) : site inaccessible depuis cet environnement (HTTP 403), ses capacités ne sont pas déclarées. Le premier parcours fonctionne donc avec un **relevé manuel ou un import agrégé** (`data/local/marketing/inbox-<réseau>.json`).

| Étape | Propriétaire | Identifiant qui relie à la suivante | Règle |
|---|---|---|---|
| Source des conversations | Marchand (relevé manuel / import) ou, plus tard, une connexion | `account.id` + réseau + fenêtre ; `conversations[].id` (opaque) | Trois grains, jamais additionnés ni dédupliqués entre eux : **threads** (une ligne par conversation), **aggregate** (totaux par publication), **totals** (totaux du compte). Plusieurs messages d'un même fil = **une** conversation ; une ligne en double = écartée et comptée ; deux lignes qui se contredisent sur l'origine → origine « inconnue ». Un 0 fourni est un vrai zéro ; absent = indisponible ; un export vide n'est un zéro que s'il déclare couvrir la période (`complete`). Aucun texte de message, aucun nom : identifiants opaques et agrégats. |
| Test (Growth) | Growth (`src/growth/inbox/inbox.js`) | `inbox:<réseau>:<compte>` ; `linkedTestId` = test du lot _08 (`social:…`) | Invitation (mot-clé DEVIS / RESERVER / INFO selon le type), brouillon de première réponse, fenêtre d'observation (7 jours) fixés **avant** le test ; le type choisi est enregistré avec le plan (version testée). Proposé même sans source (relevé manuel). |
| Publication | Publication sociale (lot _09) ou association manuelle (parcours déjà prévu) | id du post côté réseau = `applied.post.id` ; date réelle = début de la période | Le rapprochement avec la publication confirmée du lot _09 réutilise « Rapprocher la publication confirmée » ; hors Nordla : « Rattacher la publication ». |
| Provenance | Source / marchand | `origin.attribution` | **connection** (attribuée par la source) · **declared** (rattachée par le marchand, événement `attribute`) · **unknown** (reste au niveau du compte, jamais attribuée sur indice faible). |
| Qualification | **Marchand** | événement `qualify` {conversation, publication, état} dans l'historique du test | Qualifiée = intention concrète + de quoi donner la prochaine réponse utile. Commentaire, emoji, question générale : une conversation, pas une demande. La décision du marchand l'emporte sur l'état de la source. Une suggestion automatique, si elle est ajoutée, devra rester une proposition identifiable. |
| Revue `growth-review-inbox.1` | Growth | `GET /api/growth/review?type=inbox` (publication, jour réel, type, ids qualifiés / non qualifiés / rattachés) | Conversations **de la période d'observation** [jour réel, +fenêtre) attribuées à la publication. **Taux = qualifiées / uniques du même ensemble**, seulement si le dénominateur > 0 ; « demandes uniques » seulement si la source distingue les demandes (`request_id`), sinon « non distinguées ». Comparaison seulement avec d'autres publications observées sur la **même durée** (lignes agrégées) ; sinon pas de comparaison, décision « refaire un test ». Volume < 10 : lecture indicative. Conversations non qualifiées restantes : taux **provisoire**, décision « qualifier les restantes », rien n'est figé comme calculé. Sans attribution par publication : niveau compte seulement, revue manuelle, raison affichée. |

**Figé dans l'historique :** le plan avec le type de demande, la publication, les qualifications (une ligne par décision, « par vous »), la revue enregistrée avec ses effectifs, sa provenance, sa source et sa période (calculée seulement si comparable et complète).

**Dépendances restantes :** une connexion de messagerie (permission à vérifier pour le listing), la prise en compte d'une suite commerciale (devis accepté, réservation confirmée, vente) qui restera un résultat distinct, une éventuelle suggestion automatique de qualification, l'envoi automatisé (extension distincte, hors de ce lot).

### Clôture du lot _10 — origine marchande d'un import (2026-11-16)

Un fichier de conversations (`inbox-<réseau>.json`) peut porter `merchant_ref` (sha256 de l'identifiant du marchand, jamais l'identifiant). Quand le serveur a un contexte marchand (`merchantId`), un fichier dont `merchant_ref` désigne **un autre marchand** est refusé (`MERCHANT_MISMATCH`) et un fichier **sans preuve** l'est aussi (`MERCHANT_UNKNOWN`), sauf si le contexte renonce explicitement à la preuve (`requireMerchantProof: false`, relevé local). Un fichier refusé ne livre aucune conversation, aucun item, aucune revue. Côté navigateur, le suivi est rangé par portée marchande (`nordla.growth.follow-up.v1:<portée>:…`, `nordla.growth.pipeline.v1:<portée>`) : deux marchands qui ont le même identifiant de conversation ont deux historiques séparés.

## Du lead qualifié à l'issue commerciale (lot _11, 2026-11-16)

Qui **qualifie** : le marchand (lot _10, événement `qualify`) ; une source qui fournit l'état ne fait que le proposer. Qui **enregistre une issue** : le marchand, à la main (devis envoyé, réservation confirmée, vente conclue, fermée sans suite) ; aucun CRM n'est connecté, un CRM pourra fournir états et références fiables plus tard (étapes inspirées d'un pipeline classique de type HubSpot : contrat/devis envoyé, gagné, perdu ; sans probabilités ni synchronisation).

| Étape | Propriétaire | Identifiant qui relie à la suivante | Règle |
|---|---|---|---|
| Demande qualifiée | Marchand (qualification) | `req:<test>:<conversation>` (une demande par conversation qualifiée : granularité de la source conservée) ; `req:<test>:m<n>` pour une demande saisie à la main | Identité stable dans la portée du marchand. Origine, canal, date et provenance conservés avec la demande : **connection** (source) · **declared** (lien confirmé par le marchand) · **unknown**. Un total de formulaires du lot _07 **ne crée aucune demande** ; une demande de page du site n'existe que si le marchand la déclare (page + rapprochement manuel). |
| Événements commerciaux | Marchand | `requestId` + `ev_<horodatage>_<n>` | Append-only, datés, avec référence externe et note facultatives ; montant et devise facultatifs pour une vente seulement (non renseigné = inconnu ; une vente déclarée n'est pas un paiement encaissé). Date : pas avant la demande, pas dans le futur, un résultat pas avant le devis déjà enregistré. Double enregistrement refusé (même étape, date, référence, note, montant). Correction = nouvel événement qui **remplace** l'ancien (conservé, marqué, non compté) ; retrait = événement `void`. |
| Résultat dans Growth | Growth | même portée marchande | **Demandes qualifiées, devis envoyés, réservations confirmées, ventes conclues affichés séparément**, par **demandes distinctes** : une demande figure une fois par étape atteinte (un devis puis une vente = « devis » et « ventes », jamais deux fois dans la même ligne). Taux seulement sur le **même groupe** de demandes, période explicite (la période d'observation du test), dénominateur > 0. Trois groupes : rattachées à la publication du test · issues d'une page du site (déclarée) · origine inconnue (conservées au niveau du marchand). **Aucune attribution à une publication ou à une campagne n'est déduite d'une date.** |
| Prochaine décision | Growth | — | Réutilise la revue du lot _10 (taux de qualification) et ces comptes ; une issue enregistrée reste lisible même si l'opportunité sort de la liste (la demande et ses événements sont dans le registre local). |

**Persistance (première version) : le navigateur seulement**, par portée marchande, dit dans l'interface (« Historique conservé dans ce navigateur uniquement »). Non partagé, non sauvegardé ; un store serveur ou un CRM pourra le remplacer sans changer le contrat des événements.

**Figé dans l'historique :** la demande (origine, date, provenance), chaque événement avec sa date de saisie, les corrections et retraits (jamais effacés), le plan et la revue du test.

**Dépendances restantes :** un CRM ou un registre serveur pour des états fiables et partagés ; la connexion de messagerie (lot _10) ; le rapprochement automatique d'une vente de boutique (le lien entre une commande et une demande reste déclaré par le marchand) ; l'encaissement (non suivi).

## Limites connues

- L'historique est local au navigateur (clé par périmètre marchand) ; il n'est pas partagé entre appareils.
- Aucune attribution : unités nettes avant/après ≠ effet causal ; les commandes attribuées à une campagne ne sont pas des ventes incrémentales.
