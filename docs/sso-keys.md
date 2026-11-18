# Clés SSO Nordla (Core → Finance, Core → Analyses)

Ce document est la référence des clés qui signent et vérifient les tickets de connexion unique.

## Règle

- Une clé par module, jamais le jeton du tableau de bord, jamais réutilisée entre modules.
- Format : base64url **sans remplissage**, **43 caractères**, qui décode en **32 octets aléatoires**.
- Génération (à faire une fois, hors dépôt) :
  `node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"`
- Une longueur de texte n'est pas une preuve d'entropie : le service vérifie le décodage et la forme canonique.

## Variables

| Module | Service qui vérifie (ticket) | Core qui signe (même valeur) | Effet si absente ou refusée |
|---|---|---|---|
| Finance | `FINANCE_SSO_KEY` (service Finance, hébergé, SSO activé par `FINANCE_SSO_ENABLED=1`) | `FINANCE_SSO_SECRET` (service Sourcing/Core, référence sur `FINANCE_SSO_KEY`) | `/sso` n'existe pas ; aucun lien de connexion côté Core |
| Analyses | `ANALYTICS_SSO_KEY` (service Analyses, hébergé) | `ANALYTICS_SSO_SECRET` (service Sourcing/Core, référence sur `ANALYTICS_SSO_KEY`) | `/sso` n'existe pas ; lien simple (jeton demandé) côté Core |

Les noms côté Core sont ceux déjà utilisés. Côté services, Analyses lit désormais `ANALYTICS_SSO_KEY` (et non plus `ANALYTICS_SSO_SECRET`).

## Refus (noms exacts, dans les journaux)

- `SSO_KEY_MISSING` : variable absente ou vide.
- `SSO_KEY_TOO_SHORT` : moins de 32 octets décodés (par exemple une clé de 24 caractères).
- `SSO_KEY_BAD_ENCODING` : espaces, remplissage `=`, caractères base64 standard (`+`, `/`), mauvaise longueur.
- `DASHBOARD_TOKEN_REUSED` : la clé est égale au jeton du tableau de bord ; SSO désactivé, sans repli.
- `OTHER_MODULE_KEY` : Finance et Analyses partagent la même valeur côté Core ; les deux liens sont désactivés.

## Ce qui n'est pas dans ce document

- Le jeton du tableau de bord (`FINANCE_DASHBOARD_TOKEN`, `ANALYTICS_ACCESS_TOKEN`) : il sert à la connexion directe au tableau de bord, jamais à signer un ticket.
- Growth : son mécanisme (`GROWTH_SSO_SECRET`, `identity/handoff.js`) a son propre minimum de 24 caractères. Il n'est pas aligné sur cette règle dans cette phase.

## Rotation

Changer une clé = changer la valeur sur les deux côtés (service et Core) puis redéployer. Les tickets déjà émis (60 secondes) expirent seuls.
