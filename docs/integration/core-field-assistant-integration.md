# Core Field Assistant — raccordements restants et dépendances (préparés, rien d'appliqué hors périmètre)

## 0. État de préparation (phase 2)
| Dépendance | Livrable prêt | Où | Appliqué ? |
|---|---|---|---|
| `verdictDisplay` (sourcing) | branche isolée issue de P0, +1 champ additif dans `decide()`, 3 tests ; 693 tests sourcing/core relancés (2 échecs préexistants identiques sur P0 pur) | `origin/fix/sourcing-verdict-display` (commit `7a7ca2e`) — **sans PR**, au propriétaire de `decision.js` | non (rien fusionné) |
| Multi-tours dans `http.js` | `validateConversation` (dans `field-context.js`, testé) + patch de 3 lignes + test HTTP | `core-field-assistant-http-conversation.patch` et `.test.js` (ce dossier) ; patch vérifié (`git apply --check`), test vert avec le patch, rouge sans | non (`http.js` non modifié) |

Ordre d'adoption conseillé : (1) PR #12 ; (2) le patch `http.js` (il dépend de `validateConversation` livré par #12) ; (3) `verdictDisplay` côté sourcing, puis la couche d'affichage de `ask.js` pourra lire `decision.verdictDisplay` au lieu de le recalculer (`displayVerdict` reste valable tant que ce champ n'existe pas).

## 1. `CONDITIONAL_GO` avec un blocage dur

**Constat** (`src/sourcing/core/decision.js`, fonction `decide`) : le verdict est calculé ainsi — `NO_GO` si un blocage « no-go » ; `INSUFFICIENT_INFORMATION` si identité / légal / coût critique / économie inconnus ; sinon `CONDITIONAL_GO` s'il y a des conditions ; sinon `GO`. Un blocage dur `REQUIRED_DOCUMENT_MISSING` n'est dans aucune des deux premières listes : le verdict reste `CONDITIONAL_GO` alors que `canCommitMoney` est `false` et que `hardBlockers` n'est pas vide. Les tests `test/sourcing-products.test.js` (cas B et E) **figent** ce comportement : il est voulu côté sourcing (« les documents sont une condition avant acompte »), mais le libellé seul se lit comme un feu vert.

**Correction apportée dans ce chantier (présentation uniquement, fichiers autorisés)** : `displayVerdict()` (`field-facts.js`) ne laisse jamais `CONDITIONAL_GO` seul quand un blocage dur existe ; utilisé par « résume ce dossier », « dois-je acheter ? » (ligne *Faits*) et toutes les nouvelles réponses. Testé (`core-field-assistant-independent.test.js`).

**Correctif proposé au chantier sourcing (NON appliqué : `decision.js` et ses tests lui appartiennent)** — option non cassante : ajouter à la carte de décision un champ dérivé, sans toucher à `verdict` :
```js
// fin de decide(), dans l'objet retourné
verdictDisplay: hardBlockers.length && verdict === VERDICT.CONDITIONAL_GO ? 'CONDITIONAL_GO_BLOCKED' : verdict,
```
et faire lire `verdictDisplay` par les interfaces (PWA, carte de décision). Les tests B/E restent verts ; seul un nouveau test (`verdictDisplay === 'CONDITIONAL_GO_BLOCKED'` pour le chargeur sans documents) est à ajouter. Option cassante (à décider par ce chantier) : un verdict distinct `BLOCKED_PENDING_EVIDENCE` — impose de mettre à jour les tests B/E, `sourcing-facts.js`, le levier `orderLever` (risque) et les écrans.
Dépendance : tant que ce correctif n'existe pas, la protection est assurée uniquement par la couche d'affichage de `ask.js`.

## 2. Raccordement du contexte multi-tours à `http.js` (propriétaire : autre chantier — non modifié)

Aujourd'hui `POST /api/core/ask` appelle `askNordla({ text, caseId }, { runtime, getCase, externals, actor, … })` et renvoie le résultat tel quel (`json(res, 200, await askNordla(...))`). Les nouveaux champs (`intent`, `sections`, `sources`, `limits`, et le statut `ACTION_REFUSED`) **passent donc déjà** au client sans changement. Seul le multi-tours exige deux ajouts :

```js
// 1) lire et valider l'état envoyé par le client (ids et intentions uniquement, jamais fait confiance au marchand)
const conv = validateConversation(b.conversation); // objet {v, merchantId, caseId, caseVersion, turns[]} ou null ; taille <= 4096 octets, v === 1, turns <= 10
// 2) le passer à askNordla
json(res, 200, await askNordla({ text, caseId }, { runtime, getCase, externals, actor, conversation: conv /* null = nouvelle conversation ; undefined = mode sans état */ }));
```
- `validateConversation` : rejette (renvoie `null`) tout ce qui n'a pas la forme exacte ; ne copie que les champs attendus.
- Le serveur n'accepte l'état que d'une session authentifiée ; `merchantId` du serveur fait foi (déjà garanti : `followUpIntent` / `stepConversation` ignorent un état d'un autre marchand — testé).
- Le client conserve `response.conversation` et le renvoie avec la question suivante. Aucune persistance serveur, aucune mémoire partagée.
- Compatibilité : sans `conversation` dans le corps → comportement actuel inchangé (`conversation` reste `undefined`).
- Tests à ajouter par le propriétaire de `http.js` : corps sans état ; état valide d'un autre dossier (notice, pas de reprise) ; état d'un autre marchand (ignoré) ; état > 4 Ko ou mal formé (ignoré) ; vérifier que la réponse ne contient aucune donnée d'un autre dossier.

## 3. Compatibilité vérifiée
Buying (`buildSourcingPurchaseSubject`, `sourcingPurchaseLevers`), Sourcing (`assess`, `economicsScenario`), Socle (`decide`), Finance/Analytics (lecteurs non appelés par les questions de terrain) : lus uniquement, jamais modifiés. Suites ciblées (Buying, Socle, intégration, Core) et e2e `core-pilot` : voir le rapport.

## 4. Dépendances avec les autres chantiers
| Chantier | Dépendance | Action |
|---|---|---|
| Sourcing (`decision.js`) | libellé `CONDITIONAL_GO` | proposition §1, non appliquée |
| Core HTTP (`http.js`, propriétaire inconnu) | paramètre `conversation` | proposition §2, non appliquée |
| PR #11 (UI erreurs journal) | aucune | fichiers non touchés |
| Infra / Railway / Supabase | aucune | non touchés |
| `docs/integration/COORDINATION.md` | à consolider à la fusion autorisée | `ask.js` gagne `conversation` (opt-in) et le statut `ACTION_REFUSED` |
