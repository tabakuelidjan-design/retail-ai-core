# Nordla Design System v1 — écran Core (`/nordla`)

Branche `claude/nordla-design-system-v1` (depuis `claude/nordla-core-p0` @ `0f83fd2`). Les visuels de référence validés sont des
**références de style** ; leurs chiffres sont illustratifs et ne sont codés nulle part. L'écran n'affiche que ce que le serveur répond.

## Ce qui est livré

| Élément | Fichier | Rôle |
|---|---|---|
| Jetons + composants CSS | `src/sourcing/nordla-ui/nordla-ds.css` | couleurs, typo Montserrat (fichiers officiels), espacements, rayons, bordures, ombres, focus, états |
| Composants | `src/sourcing/nordla-ui/nordla-ds.js` | `sidebar` (NordlaSidebar), `topbar`, `mobileNav`, `moduleCard`, `metricCard`, `statusBadge`, `activityFeed`, `chartCard`, `coreDiagram` (AgentControl), `guardianIndicator` — HTML pur, tout texte échappé |
| Modèle de vue | `src/sourcing/nordla-ui/nordla-view.js` | transforme les réponses serveur en ce qui s'affiche ; aucune E/S, aucun chiffre inventé |
| Page | `src/sourcing/nordla-ui/nordla.html`, `nordla-home.js` | AppShell : tableau de bord desktop + écrans mobile `#accueil #modules #module/<clé> #parle #recherche #plus` |
| Marque | `src/sourcing/nordla-ui/nordla-mark.svg` | le « N » existant, en bronze, sans fond |
| Routes | `src/sourcing/server/app.js` (bloc séparé, 2 lignes) | `/nordla`, `/nordla-ds.css`, `/nordla-mark.svg`, `/nordla-assets/*` (icônes et polices officielles déjà présentes dans `src/shared`) |

L'application terrain China Sourcing (`/`), son service worker et son chemin Xiaomi ne sont **pas modifiés**. Les fichiers de `/nordla`
sont **hors** du dossier de l'application terrain (`src/sourcing/nordla-ui/`, servis par une table explicite) : la liste de précache du
service worker (`/shell-manifest.json`, calculée depuis `src/sourcing/ui`) est identique à celle de la branche de base (vérifié par test).

## Palette (jetons `--nd-*`)

Validée : fond `#F5F6F8`, cartes `#FFFFFF`, barre latérale `#FAFBFC`, bronze `#95652F`, bronze clair `#C49A60` (décor uniquement,
jamais du texte), texte `#111827`, bordures `#E5E7EB`. Ajustements d'accessibilité (autorisés par la mission), mesurés par
`test/nordla-design-system.test.js` (texte ≥ 4,5:1 sur fond, carte, barre latérale et teinte associée) :

| Jeton | Validé | Utilisé | Raison |
|---|---|---|---|
| texte secondaire | `#64748B` | `#5B6678` | 4,40:1 sur le fond `#F5F6F8` (< AA) |
| succès | `#16845B` | `#137A54` | 4,33:1 sur le fond (< AA) |
| erreur | `#C24135` | `#B83A2F` | 4,46:1 sur sa teinte de badge (< AA) |

Aucun dégradé, aucun fond noir, crème, ivoire ou beige, aucun vert foncé (vérifié par test).

## Disponible / non disponible (règle : source réelle ou « Non disponible »)

| Zone | Source | Affichage sans source |
|---|---|---|
| État opérationnel | `GET /api/core/status` + `/healthz/backup` | « Opérationnel (vérifié à HH:MM UTC) » **seulement** si Core actif ET sauvegarde hors serveur `OK` ; sinon « Partiellement vérifié » avec le contrôle manquant, « Core inactif », « État non vérifié », « Hors ligne » |
| Indicateurs | `awaiting_human`, `in_follow_up`, nombre d'analyses du journal, âge de la dernière sauvegarde | « Non disponible » + raison |
| Dépenses IA et modèles | **aucun compteur côté serveur** | « Non disponible » (jamais estimé) |
| Diagramme central | modules et connexions réels | Agents IA et Règles : pas de lien (aucune destination) ; Données et Outils → `#modules` |
| Mes modules | `GET /api/core/modules` (état serveur tel quel) | état inconnu = badge neutre, jamais vert |
| Activité | journal Core (`GET /api/core/decisions`) | « Activité non disponible » / « Aucune activité encore » |
| Guardian / confidentialité | `GET /api/auth/session` | n'énonce que des contrôles appliqués par le serveur (session, origine, CSRF) |
| Parle à Nordla | `POST /api/core/ask` (inchangé) | réponse, sources, limites ; refus d'action par le serveur |
| Navigation : Ventes & CRM, Produits, Fournisseurs, Conformité | aucun module serveur | entrée désactivée « bientôt » (pas de lien mort) |
| Voix | inchangée, dans l'application terrain | lien « Dictée vocale (application terrain) » ; aucun nouveau code micro |

## Écarts assumés et points à décider

- **Icônes officielles** (PNG marine + terracotta) affichées telles quelles sur tuile bronze clair : elles ne sont pas recolorées.
  Les icônes listées `DEFECTIVE` dans `src/shared/nordla-icon.js` ne sont jamais utilisées (test).
- **Branding et Création** n'ont pas d'icône officielle dans le pack : une initiale est affichée. **Logo officiel** absent du dépôt :
  le « N » existant sert de marque. À fournir par le propriétaire si un fichier officiel existe.
- **Module Finance desktop complet** (Vue d'ensemble / Transactions / Factures / Paiements / Analyses / Paramètres) : **non fait**.
  Finance est un service séparé ; ses écrans existants ne sont pas modifiés (calculs, Peppol, rapprochement, export comptable
  intacts). Dans `/nordla`, Finance montre son état réel et ses questions en lecture seule. Appliquer les jetons au service Finance
  est une étape suivante, à faire module par module.
- **Stock & Achats, China Sourcing** : état réel + lien vers l'application terrain ; persistance et parcours terrain inchangés.
- **Aucun accès direct** depuis l'application terrain vers `/nordla` n'est ajouté (pour ne pas toucher au chemin Xiaomi du 18/10) :
  l'adresse est `https://<origine>/nordla`.

## Risques / conflits

- `src/sourcing/server/app.js` est aussi modifié par les branches Stock & Achats (wave 2) et convergence : le changement ici est un
  bloc isolé de quelques lignes (import + table `NORDLA_PAGES` + 2 lignes dans le routeur) pour limiter les conflits.
- Rien n'est déployé : le candidat staging reste `ab02b77`.

## Tests

- `test/nordla-design-system.test.js` (8) : honnêteté de l'état, indicateurs, modules, activité, navigation, échappement, icônes,
  contrastes et couleurs interdites.
- `test/e2e/nordla-design.e2e.js` (`npm run nordla:design:e2e`, 7 contrôles, Chromium réel, serveur hébergé + proxy TLS type
  Railway, données de test isolées) : état non « Opérationnel » sans sauvegarde vérifiée, indicateurs = champs serveur, modules =
  `/api/core/modules`, Parle à Nordla avec source + refus d'action, 360/390/430 px sans débordement horizontal ni barre latérale avec
  barre basse à 5 entrées (Parle au centre), 1440 px avec barre latérale, icônes chargées, noms accessibles et focus visible au
  clavier, aucune clé dans la page, déconnexion → « Connexion requise ».
- Captures (moteur Chromium, **pas** le Xiaomi physique) : `docs/design/nordla-design-system-v1/*.png`. Dans les captures pleine
  page mobile, la barre basse apparaît au milieu : c'est un effet de capture d'un élément `position: fixed`, pas la mise en page.
