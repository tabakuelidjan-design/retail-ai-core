# Pilote Finance : approbation d'une facture sur rôles PostgreSQL limités

## 1. État actuel (2026-11-20, unique et à jour)

- **Branche** : `pilot/finance-narrow-role-20261120`. Dernier commit de ce lot : `57580f27` (précédent : `1c515786`). Base : `release/finance-staging` @ `361c06f5`, inchangée. Rien n'est fusionné dans une branche release, rien n'est déployé.
- **Périmètre couvert par les rôles limités** : tout ce qui se passe avant l'émission dans `service.decide(APPROVE)` :
  - lecture de la facture (`getDocument`) : rôle d'émission ;
  - vérification de liaison (`listDocuments` des factures du marchand) : rôle de lecture ;
  - chargement du ledger (`loadRetail` → `loadDataset`, mêmes tables, même calcul) : rôle de lecture ;
  - émission (`issueDocument` → `fin_issue_document`) : rôle d'émission.
- **Hors lot** (volontairement) : hooks après émission (archive légale, stock), `resettle` des avoirs, paiements, rapprochement, Peppol, réglages, sociétés.
- **Mode** : désactivé par défaut. `FINANCE_RUNTIME_DB=narrow-pilot` active le mode au démarrage de `createRuntime` (serveur et CLI). Toute erreur d'identité, de TLS ou de configuration arrête le démarrage. Toute erreur de connexion pendant une opération la refuse. Aucun repli vers `service_role`.
- **Staging** (projet d'essai `fvhiammdskpcnfodsnrc`, entreprises fictives A et B uniquement) : migrations v4 et v5 appliquées (§4). Aucun marchand réel, aucune donnée réelle, le marchand partagé du staging n'a pas été modifié.

## 2. Preuves LOCALES (PostgreSQL 17 jetable, deux marchands synthétiques, vrais logins)

| Suite | Tests | Résultat |
|---|---|---|
| `test/pg/98` parcours fonctionnel (émission, croisements, SET/RESET ROLE, pool, politique permissive, panne, rollback) | 8 | vert |
| `test/pg/99` identités (non liée, désactivée, privilégiée, non membre, liaison immuable) | 4 | vert |
| `test/pg/100` audit exact du rôle d'émission | 6 | vert |
| `test/pg/101` connexion (TLS, paramètres SSL refusés, identité au démarrage) | 6 | vert |
| `test/pg/102` matrice EXECUTE rôles × fonctions `extensions` (avant / après / rollback) | 1 | vert |
| `test/pg/103` PUBLIC SELECT sur une relation `extensions` | 1 | vert |
| `test/pg/104` démarrage `createRuntime` en mode limité, panne, mode service | 4 | vert |
| `test/pg/105` `service.decide(APPROVE)` : nominal, données étrangères, absence de liaison, panne | 4 | vert |
| `test/pg/106` audit du rôle de lecture ; le rôle d'émission ne gagne rien | 2 | vert |
| `test/finance-narrow-config.test.js` configuration de démarrage | 4 | vert |

Total : 40 tests locaux verts. Les quatre suites `finance-pack` en échec ne sont pas liées au pilote (échec identique sur `361c06f5`).

## 3. Preuves STAGING (fictif uniquement, pooleur `aws-1-eu-west-1`, TLS strict avec le CA officiel)

Exécuté avec `createRuntime` et `service.decide` (le service Finance réel), login de test lié à l'entreprise fictive A, client Supabase de substitution (la clé de service n'est pas disponible sur ce poste) :

- Démarrage : `session_user` vérifié, liaison à A, TLS vérifié, rôles d'émission et de lecture vérifiés.
- **Approbation nominale** : facture fictive A approuvée → `ISSUED`, numéro `INV-2026-0003`.
- **Appels reçus par le client de substitution pendant l'approbation : aucun** (lecture de la facture, liaison, ledger et émission passent par les rôles limités).
- Données étrangères : approbation de la facture fictive de B par le runtime de A → `DOCUMENT_NOT_FOUND`.
- Réapprobation de la facture déjà émise → `INVALID_TRANSITION` (règle métier).
- Démarrage avec le marchand B alors que le login est lié à A → refus (`FIN_PILOT_MERCHANT_MISMATCH`).
- Panne de connexion après démarrage → approbation refusée (`NARROW_CONNECTION_FAILED`), rien émis.
- Panne au démarrage (mauvais port) → démarrage refusé.
- Limite : les cas « absence de liaison » et « données étrangères liées à une commande » ont été exécutés localement (test 105), pas sur staging, parce que la clé de service n'est pas disponible pour créer les commandes fictives ; et le brouillon fictif de B a été inséré avec une version de corps dont les totaux par ligne ont été simplifiés (les totaux de documents sont corrects).
- Nettoyage : login supprimé, liaison désactivée, brouillon fictif de B supprimé. Restent sur staging : les entreprises fictives A et B, trois factures fictives émises pour A (`FACT-2026-0001`, `FACT-2026-0002`, `INV-2026-0003`, immuables par conception), les migrations v4 et v5.

## 4. Migrations sur staging

- v4 `20261120110000_fin_issuer_narrow_role.sql` (commit `f9c7c48e`).
- v5 `20261120120000_fin_reader_narrow_role.sql` (commit `57580f27`) : rôle de lecture, politiques par entreprise, audit exact (échec fermé), redéfinition de l'entrée d'identité `fin_pilot_assert` (même sens, accepte aussi le rôle de lecture).
- Rollbacks : `supabase/rollback/20261120110000_…down.sql` et `20261120120000_…down.sql`.

## 5. Accès administratifs encore utilisés dans l'approbation (`service_role`)

Liste exacte, d'après le code (`src/finance/service.js` et `src/finance/server/app.js`) :

| Moment | Accès | Où dans le code | Statut |
|---|---|---|---|
| Démarrage | `merchants` (résolution du tenant) | `src/tenant/index.js`, `runtime.js` | `service_role` (client Supabase conservé pour le reste du serveur) |
| Démarrage | connecteurs du marchand | `runtime.js` (`createConnectorRepository`) | `service_role` |
| Après émission | archive légale (`hooks.onIssued` → `legalServices.archiveIssued`) | `server/app.js` | `service_role`, s'exécute à chaque approbation |
| Après émission | stock (`hooks.afterIssue`), uniquement si le mode stock n'est pas `off` | `server/app.js` | `service_role` |
| Avoirs seulement | `restockDecisionNeeded`, `resettle` (paiements d'avoir) | `service.js`, `server/app.js` | `service_role` |
| Échec d'un hook | journal `appendEvent` | `service.js` | `service_role` |

Avant l'émission : **aucun** accès administratif dans le cas d'une facture standalone, lecture comprise.

## 6. Plateforme : six fonctions de `extensions` (lecture seule sur staging)

Toutes sont `returns event_trigger`, `SECURITY INVOKER`, `search_path=""`, propriété `supabase_admin`. Elles s'exécutent comme déclencheurs d'événements. PostgreSQL refuse leur appel direct (`0A000`). Elles restent des exceptions explicites de l'audit.

## 7. Risques de déploiement (non traités ici)

1. La clé de service reste chargée par le serveur tant que les accès du §5 existent : elle reste donc disponible au processus, même si le chemin d'approbation avant émission ne l'utilise plus.
2. `service_role` garde BYPASSRLS : tant que les accès du §5 existent, la protection reste contournable par ces chemins.
3. Configuration hors dépôt : `FINANCE_PILOT_DATABASE_URL` (login du pooleur), `FINANCE_PILOT_CA_FILE` (PEM officiel), `FINANCE_PILOT_SERVER_NAME` si besoin.
4. Rollback : `DROP ROLE` est cluster-wide ; la suppression des rôles suit sur toutes les bases.

## 8. Prochaine portion à sécuriser

Hooks après émission : archive légale (le plus critique : il écrit en base et dans le stockage) puis stock. Puis les avoirs (`resettle`). Ensuite seulement les autres chemins (paiements, rapprochement).
