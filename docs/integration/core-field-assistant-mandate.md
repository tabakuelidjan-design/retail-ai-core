# Chantier parallèle — Parle à Nordla, assistant d'achat terrain

Démarrage : 2026-10-16. Branche autonome : `feature/core-field-assistant`, créée depuis le HEAD alors courant de `claude/nordla-core-p0`. Aucun changement de production autorisé par ce document.

## But et limites

Avant les essais sur Xiaomi, améliorer **l'utilité des réponses de Parle à Nordla pour l'achat fournisseur**, avec des éléments déjà présents dans un dossier China Sourcing et les règles du Core. Ce chantier est distinct de l'intégration Railway/staging et de la PR #11 (messages des journaux). On ne promet pas un agent conversationnel général ni une autonomie décisionnelle : le moteur existant est un routeur déterministe et des réponses fondées sur des faits.

## État observé dans le code

- `src/core-pilot/ask.js` traite notamment : décisions en attente, suivis, factures/trésorerie/achats Finance, tendances Analytics, « dois-je acheter ? », résumés de dossier et demandes vers des modules non raccordés.
- `src/core-pilot/answers.js` formate les résultats Finance et Analytics en conservant période, source, limites et fraîcheur ; la lecture seule doit rester absolue.
- `src/buying/sourcing-purchase.js` prévoit déjà coût rendu, contribution unitaire, prix observé/estimé, quantités, MOQ, blocages et conditions d'approbation ; l'arbitrage reste au Socle, jamais au texte généré.
- `config/merchants/habb/core-decision.json` reste **DRAFT_FOR_OWNER_REVIEW**, avec `ownerRules: []` : aucune règle de budget ou de marge ne peut être inventée.
- Lacune ciblée : les questions terrain explicites « qu'est-ce qui manque ? », « quels risques ou blocages ? » et « quelle prochaine étape ? » n'ont pas, à ce stade, de parcours dédié, sourcé et testé dans `ask.js`.

## Lot 1 — mission exécutable de façon indépendante

1. Auditer d'abord les réponses actuelles sur dossiers synthétiques : résumé, manque documentaire / chiffres manquants, risques, prochaine action, possibilité d'acheter, inconnus.
2. Ajouter les trois intentions terrain **manques**, **risques/blocages** et **prochaine étape**, avec reconnaissance de variantes courantes en français (accents, questions naturelles) sans détourner les requêtes Finance/Analytics existantes.
3. Ne lire que les propriétés véritablement présentes dans l'état calculé du dossier et les fonctions métier existantes. Un nombre absent reste inconnu ; un risque non évalué est explicité comme non évalué. Ne jamais déclarer `GO` ni lever un blocage sans preuve du moteur.
4. Chaque réponse sur dossier doit identifier sa source (ID/version du dossier) et exposer les limitations utiles ; en cas de dossier non synchronisé ou absent, demander de l'ouvrir/synchroniser plutôt que d'inventer des faits.
5. Ces trois nouvelles intentions doivent être **sans écriture** : ni décision, ni analyse journalisée implicite, ni commande, ni paiement, ni appel réseau externe. Ne pas modifier le comportement préexistant de « dois-je acheter ? » sans proposition et validation séparées.
6. Ajouter des tests ciblés (réponses, absence de données, négation/accents, non-régression des intents existants, source/version, non-écriture).
7. Exécuter les tests ciblés puis ceux du Core, Buying et intégration ; classer les intermittences connues, documenter le résultat dans le rapport de PR.

## Périmètre de fichiers autorisés

- Principalement `src/core-pilot/ask.js`, **si besoin** un nouveau module dédié `src/core-pilot/*`, et de nouveaux tests `test/core-field-assistant*.test.js`.
- Documents propres au lot 1 sous `docs/integration/core-field-assistant-*` en évitant les sections que les autres chantiers éditent en parallèle.
- `src/core-pilot/answers.js` seulement si une défaillance démontrée le justifie ; sinon laissé inchangé.

## Fichiers et opérations interdits pour ce chantier

- **Ne pas toucher** aux fichiers de la PR #11 : `src/sourcing/ui/core-panel.js`, `src/sourcing/ui/modules-panel.js`, `src/sourcing/ui/core-journal-errors.js`, `test/core-journal-ui-errors.test.js`, `.github/workflows/core-reliability.yml`.
- Ne pas modifier `src/core-pilot/runtime.js`, `journal.js`, `http.js`, `src/sourcing/server/**`, `src/identity/**`, `src/security/**`, `tools/**`, `ops/**`, `supabase/**`, `deploy/**`, les workflows, les configurations Railway et les secrets.
- Aucun nouveau fournisseur IA, pas de données réelles, aucune modification de `main`, `claude/nordla-core-p0` ni des branches d'autres chantiers. Pas de migration, de fusion, de DNS, de déploiement ou d'activation. Aucun nouveau commit direct sur Core P0.
- Si un changement hors périmètre est indispensable, s'arrêter à une proposition écrite, sans l'exécuter.

## Livrable et décision

Une PR depuis `feature/core-field-assistant` vers `claude/nordla-core-p0` après tests, avec matrice exemples/question→résultat, preuves de non-écriture, diff audité et verdict GO/NO-GO. **Pas de fusion sans autorisation explicite du propriétaire.**

## Coordination

L'infrastructure continue uniquement sur ses propres fichiers et la PR #11 reste indépendante. Avant d'ouvrir la PR, intégrer proprement la base récente ou prouver l'absence de conflit, sans réécrire le travail d'un autre chantier. Ne pas modifier `docs/integration/COORDINATION.md` pendant les travaux parallèles : déclarer les changements de propriété dans le corps de la PR, puis consolider le journal à la fusion autorisée.
