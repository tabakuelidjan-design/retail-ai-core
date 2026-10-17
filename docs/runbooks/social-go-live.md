# Passer en publication automatique réelle (Instagram · Facebook) — procédure d'activation

**Rien de ceci n'a été fait.** Chaque étape qui touche un compte, un secret, un hébergement ou de l'argent est **à vous**, après votre accord explicite. Je n'ai créé aucune app Meta, aucun jeton, aucun hébergement.
Ne collez **jamais** un jeton dans une conversation, un ticket ou un fichier suivi par Git.

État attendu à l'arrivée : `SOCIAL_MODE=live`, la vue **Connexions** montre « Connecté (réel) », le bouton **Tester les connexions** répond OK, et un premier post de test est publié puis vérifié puis supprimé sur une Page de test.

## 1. Prérequis côté Meta (vous, dans vos comptes)

1. **Instagram** : compte **professionnel** (Business ou Créateur). Si la Page Facebook liée exige la *Page Publishing Authorization* (PPA), la terminer — sinon la publication API est impossible (doc Meta 2026-06-30).
2. **Facebook** : une Page HABB sur laquelle vous avez les tâches `CREATE_CONTENT`, `MANAGE`, `MODERATE`.
3. Une **app Meta** créée par vous (developers.facebook.com), vous-même administrateur, avec les cas d'usage *Instagram API with Instagram Login* et *Pages API*.
4. **À vérifier dans le tableau de bord (je ne l'ai pas pu)** : pour publier sur **votre propre** compte, le mode développement avec votre rôle suffit-il, ou faut-il l'accès avancé / la revue d'app ? Tant que ce point n'est pas tranché, ne planifiez pas de dépendance dessus.

## 2. Jetons (vous) — puis variables d'environnement (jamais dans le dépôt)

| Variable | Contenu |
|---|---|
| `SOCIAL_INSTAGRAM_TOKEN` | jeton utilisateur Instagram (permissions `instagram_business_basic`, `instagram_business_content_publish`) |
| `SOCIAL_INSTAGRAM_ACCOUNT_ID` | identifiant du compte professionnel (celui que renvoie `/me`) |
| `SOCIAL_INSTAGRAM_TOKEN_EXPIRES_AT` | date d'expiration ISO du jeton (Nordla avertit à 7 jours) |
| `SOCIAL_FACEBOOK_PAGE_TOKEN` | jeton **de Page** (permissions `pages_manage_posts`, `pages_read_engagement`, …) |
| `SOCIAL_FACEBOOK_PAGE_ID` | identifiant de la Page |
| `SOCIAL_FACEBOOK_TOKEN_EXPIRES_AT` | expiration si connue |
| `SOCIAL_GRAPH_VERSION` | version de l'API, ex. `v25.0` (**configuration, aucune valeur par défaut** ; la doc actuelle montre `v26.0`) |
| `SOCIAL_MEDIA_BASE_URL` | dossier public HTTPS des médias (§3) |
| `SOCIAL_MODE` | `live` (sinon `none` ou `simulate`) |

Placez-les dans l'environnement de la machine qui lance Nordla (ou un fichier `.env` **non suivi par Git**). Nordla ne les affiche, ne les journalise et ne les enregistre nulle part ; la vue Connexions ne montre que « configuré / expire dans N jours ».
Quand l'OAuth et le coffre de `provider-connections` seront activés (chantier convergence), le port `credentials.js` sera remplacé par eux sans toucher au reste.

## 3. Médias : l'URL publique (décision requise)

Meta télécharge l'image **depuis une URL publique** au moment de l'essai. Nordla attend un dossier HTTPS dont les fichiers se nomment **`<sha256>.<ext>`** (ex. `…/3f2a….jpg`) : avant chaque envoi il **télécharge ce que le serveur sert, recalcule l'empreinte et refuse si ce n'est pas le fichier approuvé**.

Options (à décider, avec leur coût éventuel) : un petit stockage objet public (type bucket avec domaine), un dossier statique sur l'hébergement qui portera Nordla, ou le CDN de la boutique. **Ne mettez dans ce dossier que des visuels approuvés** (ils deviennent accessibles à quiconque a le lien ; le nom est l'empreinte, donc non devinable). Les fichiers viennent de la bibliothèque `data/local/social/assets/files/`. *Je n'ai pas téléversé de fichier et n'ai touché ni Shopify ni aucun hébergement.*

## 4. Séquence de validation (chaque étape : votre accord)

1. `npm run social` avec `SOCIAL_MODE=simulate` : tout fonctionne, étiquette « SIMULÉ ». *(Prouve l'app, pas Meta.)*
2. `SOCIAL_MODE=live` → **Connexions → Tester les connexions** : lecture seule du compte. Attendu : OK pour chaque plateforme configurée, sinon la raison (`ACCOUNT_NOT_PROFESSIONAL`, `ACCOUNT_MISMATCH`, `AUTH_INVALID`…).
3. **Page Facebook de test** : un post texte approuvé, publié maintenant, **vérifié** (lecture LIVE), puis supprimé à la main. Puis une **programmation native** à +20 min : confirme (ou infirme) le paramétrage photo non vérifié (§ architecture 5).
4. **Compte Instagram de test** (pro) : une image JPEG, conteneur → publication → vérification → suppression.
5. Seulement ensuite, **un** vrai post HABB (Facebook d'abord), à une heure normale, post par post.

À chaque échec : noter le code renvoyé (jamais le jeton), corriger, recommencer sur le compte de test.

## 5. Hébergement de Nordla (décision requise)

- **Facebook** programme lui-même : une fois « armé », le post part même si Nordla est éteint.
- **Instagram** : l'API ne programme pas ; Nordla publie à l'heure dite, donc **Nordla doit tourner et pouvoir sortir sur Internet à ce moment-là**. Un PC de bureau éteint ou sans réseau = publication manquée (alors `MISSED_WINDOW` après 6 h, jamais d'envoi tardif silencieux).
- L'accès à l'app depuis votre téléphone suppose un hébergement ou un tunnel : **non fait, non décidé** (chantier B / Railway ; aucun déploiement par moi). Tant que ce n'est pas fait, utilisez `social-manual-fallback-and-china.md` §B.

## 6. Retour arrière

`SOCIAL_MODE=none` : plus aucun appel plateforme. Les posts déjà programmés **chez Facebook** restent programmés (supprimez-les dans Meta Business Suite ou retirez l'approbation dans Nordla, qui les supprime). Les données sont des fichiers dans `data/local/social/` (sauvegarde : copier ce dossier).

## Jeton d'accès du propriétaire

Le jeton n'est **plus** stocké en clair dans le dossier de données. Il est dans `owner.token` du dossier de clés (`SOCIAL_KEY_DIR`, hors du dossier de données, droits propriétaire seul), ou fourni par `SOCIAL_TOKEN` (24 caractères minimum) depuis le coffre de secrets de l'hébergeur ; dans ce cas rien n'est écrit. Un ancien `token.txt` est migré une fois (même valeur) puis retiré du dossier de données. Il n'est jamais affiché ni journalisé. Limite : un programme exécuté sous le même utilisateur système peut lire le dossier de clés.
