# Banque → Finance : pilote en lecture seule avec Enable Banking — état au 2026-11-17

Document seul (aucun code, aucune inscription, aucun abonnement, aucun consentement). Sources : pages officielles d'Enable Banking, consultées le 2026-11-17.

## Ce qui est confirmé par les sources officielles
- **Lecture seule des comptes et transactions (AIS)** : l'API « Account information » existe ; l'accès pilote « mode production restreint » ne permet que de lire les comptes **que vous avez liés vous-même** à l'application ([Linked accounts](https://enablebanking.com/docs/api/linked-accounts/), [FAQ](https://enablebanking.com/docs/faq/)).
- **Mode restreint** : une application de production reste « Inactive » tant qu'un compte n'est pas lié via « Activate by linking accounts » ; elle passe alors « active en mode restreint » et ne peut lire que les comptes liés. Chaque compte doit être lié séparément.
- **Gratuit, mais à usage d'évaluation** : les Conditions disent que le Control Panel et l'API sont gratuits ; la production est limitée aux comptes liés, à l'évaluation ou à l'usage personnel de particuliers ; l'usage professionnel y est considéré comme évaluation ([Terms](https://enablebanking.com/terms/)). Le changelog de décembre 2025 indique que l'usage interne en production restreinte continue comme avant, la tarification étant discutée séparément ([changelog](https://enablebanking.com/blog/2026/01/15/enable-banking-changelog-december-2025)). Les deux sources ne disent pas exactement la même chose : **à clarifier par écrit avec Enable Banking** avant de s'appuyer sur la gratuité pour HABB.
- **Belgique** ([page marché BE](https://enablebanking.com/docs/markets/be/)) : BNP Paribas Fortis, KBC Group (KBC, CBC, KBC Brussels), Belfius, ING, Argenta, Crelan ; aussi Bank Van Breda, BBVA, Wise.
  - Authentification forte : Belfius = app Belfius Mobile, sinon itsme ou lecteur de carte ; BNP Paribas Fortis = itsme ou lecteur de carte ; ING = app ING, sinon itsme/lecteur/QR/Isabel ; Argenta = app Argenta, sinon Digipass ou itsme ; KBC = applis KBC, avec choix **privé / professionnel** sur la page web.
  - Limites utiles : KBC et Crelan ne supportent pas les cartes de crédit ; l'historique complet n'est garanti que dans les **90 jours** suivant un nouveau consentement (par défaut `/transactions` renvoie 90 jours si `dateFrom` est absent ; la page ne cite cette règle que pour Wise) ; la durée maximale du consentement n'est pas indiquée sur cette page.
- **Coûts** : la page tarifs `enablebanking.com/pricing` n'existe pas (404). Les sources disent seulement que la production complète est facturée au volume (par compte bancaire connecté et par mois, et par paiement initié) **par contrat** : **aucun tarif chiffré n'est publié, aucun coût n'est confirmé.**

## Banques belges prises en charge (catalogue `src/finance/bank-catalog-be.js`, mis à jour le 2026-11-17)
**Banque du pilote : KBC** (indiquée par le propriétaire ; l'adaptateur la prend par défaut avec `bankKey: 'kbc'`). Banques demandées, toutes listées par Enable Banking pour la Belgique ([page Belgique](https://enablebanking.com/open-banking-apis/belgium), [spécificités](https://enablebanking.com/docs/markets/be/)) :

| Banque | Clé | Remarque (source officielle) |
|---|---|---|
| KBC | `kbc` | choix privé / professionnel sur la page web ; cartes de crédit non prises en charge |
| CBC | `cbc` | idem KBC |
| (KBC Brussels) | `kbc-brussels` | idem KBC |
| Belfius | `belfius` | app Belfius Mobile, sinon itsme ou lecteur de carte ; nom exact « Belfius » ou « Belfius Bank » selon la page |
| BNP Paribas Fortis | `bnp-paribas-fortis` | itsme ou lecteur de carte |
| ING | `ing` | app ING, sinon itsme, lecteur, QR, Isabel |
| Argenta | `argenta` | app Argenta, sinon Digipass ou itsme |
| Beobank | `beobank` | listée par Enable Banking ; aucune particularité décrite |
| AXA | `axa` | **AXA Bank Belgium est devenue Crelan** : Enable Banking la liste sous « Crelan (AXA Bank) » ; connexion via Crelan ; cartes de crédit non prises en charge |

Le nom exact attendu par l'API (par exemple « Belfius » ou « Belfius Bank ») sera comparé à la liste propre d'Enable Banking au premier appel réel (`matchAspsp`) : si la banque n'y figure pas, la connexion est refusée, jamais devinée.

## Ce qui est inconnu (à fournir par vous)
- ~~Le nom de la banque de HABB~~ : **KBC** (reçu). Reste à savoir si les comptes sont professionnels (le client choisira « professionnel » sur la page KBC) et s'il y a une carte de crédit (non lisible chez KBC).
- Comptes à lier (professionnels ? carte de crédit exclue pour KBC/Crelan).
- Votre accord pour créer l'application chez Enable Banking (inscription = création de compte/identité : **non faite**).

## Ce qui est déjà prêt côté Nordla (testé, sans consentement)
Couche bancaire Finance neutre vis-à-vis du fournisseur (`src/finance/bank*.js`) : lecture seule, coffre de consentement, adaptateur factice, import atomique idempotent ; 63 tests passent (premier import, second passage sans doublon, reprise après échec, expiration du consentement, isolation entre marchands). **Adaptateur Enable Banking écrit (2026-11-17) : `src/finance/bank-adapter-enable-banking.js`**, lecture seule (JWT RS256, `POST /auth`, `POST /sessions`, soldes, transactions paginées, `DELETE /sessions`), construit d'après la documentation officielle et **testé uniquement sur doubles** (`test/finance-bank-enable-banking.test.js`, 4 tests dont le parcours complet dans l'application Finance réelle : connexion, consentement, premier import, second passage sans doublon, reprise après échec, aucun jeton dans les réponses). Les formes de réponse réelles restent à revérifier au premier vrai consentement. Il n'est branché sur aucun service : pour l'activer il faut une application Enable Banking (identifiant + clé privée), le nom de la banque et un consentement.

## Pas à pas pour le pilote (rien n'est fait)
1. Vous : choisir le fournisseur (ou en demander un second devis) ; créer le compte développeur et l'application « production » sur le Control Panel d'Enable Banking ; télécharger la clé privée (jamais dans Git ni dans le chat) ; indiquer le nom de la banque.
2. Vous : « Activate by linking accounts » : consentement bancaire (itsme / app de la banque) — **uniquement vous**.
3. Moi ensuite : adaptateur + tests sur doubles, branchement Finance en lecture seule, premier import, second passage sans doublon, reprise après échec, rapprochement avec un document de test distinct de PO-2026-0001.
4. Décision tarifaire : avant tout passage au-delà du restreint, obtenir le tarif écrit (par compte et par mois).
