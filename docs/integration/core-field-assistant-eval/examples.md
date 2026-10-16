# Exemples réels de réponses (données synthétiques)

Généré par `examples.mjs` : rien n’est tapé à la main. Dossier `blocked` = chargeur USB sans documents de conformité ; dossier `bare` = mug sans devis ni coûts.

## [blocked] « Qu’est-ce qu’on sait sur ce fournisseur ? »

Statut : `ANSWERED` · intention : `KNOWLEDGE`

```text
Voici l’état du dossier.
Ce que nous savons :
• produit « USB charger », verdict du moteur : GO sous conditions, mais avec un blocage dur : aucune commande possible ; le dossier n’autorise pas d’engager de l’argent
• devis fournisseur : 4,20 USD l’unité, 1000 unités, minimum 500, FOB
• coût rendu : 4,58 € l’unité, 4584,53 € au total
• marge unitaire : 16,07 €, prix de vente visé par vous, pas observé sur le marché
• Safety Gate : à jour (LIVE_VERIFIED)
Ce que nous ne savons pas :
• prix de vente non observé : visé par vous, pas observé sur le marché
• 5 document(s) obligatoire(s) manquant(s) ou inexploitable(s)
Risques :
• documents obligatoires manquants ou inexploitables — « 5 required document(s) missing or not usable, e.g. EU declaration of conformity citing Directive 2014/35/EU; Safety test report »
Pourquoi c’est important :
• tant qu’un blocage dur existe, aucune commande n’est recommandable
Prochaine vérification :
• Demander au fournisseur : « EU declaration of conformity citing Directive 2014/35/EU » ; « Safety test report (e.g. EN 62368-1 / EN 60335 family) for the exact model » ; « EU declaration of conformity citing Directive 2014/30/EU » (+ 2 autre(s)).
Sources : dossier blocked, version 2026-10-03T12:00:00.000Z, calculé le 2026-10-03 ; base de règles : à jour (2026-10-03) ; Safety Gate UE : à jour (2026-10-03) ; taux de change : à jour (2026-10-02).
```

## [blocked] « Qu’est-ce qui manque ? »

Statut : `ANSWERED` · intention : `MISSING`

```text
Le dossier n’est pas complet.
Ce que nous ne savons pas :
• document : EU declaration of conformity citing Directive 2014/35/EU
• document : Safety test report (e.g. EN 62368-1 / EN 60335 family) for the exact model
• document : EU declaration of conformity citing Directive 2014/30/EU
• document : EMC test report (e.g. EN 55032 / EN 55035 / EN 61000 family) for the exact model
• document : RoHS test report or material declaration for the exact model (EN IEC 63000 technical documentation)
• prix de vente non observé : visé par vous, pas observé sur le marché
• à demander au fournisseur : Please send the EU Declaration of Conformity (DoC) for model PD-65, citing Directive 2014/35/EU (LVD).
• à demander au fournisseur : Please send the full test report from an accredited laboratory (ISO/IEC 17025) for model PD-65.
• à demander au fournisseur : Please send the EU Declaration of Conformity (DoC) for model PD-65, citing Directive 2014/30/EU (EMC).
• à demander au fournisseur : Please send the RoHS test report for model PD-65.
Pourquoi c’est important :
• sans ces documents, la conformité ne peut pas être établie et le moteur interdit tout acompte
Prochaine vérification :
• Demander au fournisseur : « EU declaration of conformity citing Directive 2014/35/EU » ; « Safety test report (e.g. EN 62368-1 / EN 60335 family) for the exact model » ; « EU declaration of conformity citing Directive 2014/30/EU » (+ 2 autre(s)).
Sources : dossier blocked, version 2026-10-03T12:00:00.000Z, calculé le 2026-10-03 ; base de règles : à jour (2026-10-03) ; Safety Gate UE : à jour (2026-10-03) ; taux de change : à jour (2026-10-02).
```

## [blocked] « Quels sont les risques ? »

Statut : `ANSWERED` · intention : `RISKS`

```text
Le moteur établit 1 blocage(s) dur(s) : l’achat ne peut pas être engagé.
Risques :
• Bloquant établi par le moteur : documents obligatoires manquants ou inexploitables — « 5 required document(s) missing or not usable, e.g. EU declaration of conformity citing Directive 2014/35/EU; Safety test report »
• Alerte : obtenir les documents obligatoires AVANT tout acompte
• Pas évalué / à revérifier : couverture réglementaire PARTIAL : l’absence de règle trouvée ne prouve pas l’absence d’obligation
• Pas évalué / à revérifier : preuves fournisseur insuffisantes
Pourquoi c’est important :
• un blocage dur retire l’option « commander » avant toute comparaison
Prochaine vérification :
• Demander au fournisseur : « EU declaration of conformity citing Directive 2014/35/EU » ; « Safety test report (e.g. EN 62368-1 / EN 60335 family) for the exact model » ; « EU declaration of conformity citing Directive 2014/30/EU » (+ 2 autre(s)).
Sources : dossier blocked, version 2026-10-03T12:00:00.000Z, calculé le 2026-10-03 ; base de règles : à jour (2026-10-03) ; Safety Gate UE : à jour (2026-10-03) ; taux de change : à jour (2026-10-02).
```

## [blocked] « Quelle est la marge estimée ? »

Statut : `ANSWERED` · intention : `MARGIN`

```text
Marge unitaire estimée : 16,07 € (77,8 % du chiffre d’affaires net).
Ce que nous savons :
• prix de vente visé par vous, pas observé sur le marché : 24,99 € TTC
• 16070,00 € si les 1000 unités se vendaient toutes au prix saisi (hypothèse, pas une prévision)
Ce que nous ne savons pas :
• prix de vente non observé : visé par vous, pas observé sur le marché
Risques :
• blocage(s) dur(s) : documents obligatoires manquants ou inexploitables — les chiffres ci-dessus ne rendent pas la commande possible
Pourquoi c’est important :
• la marge ne vaut que ce que vaut le prix de vente supposé
Prochaine vérification :
• Demander au fournisseur : « EU declaration of conformity citing Directive 2014/35/EU » ; « Safety test report (e.g. EN 62368-1 / EN 60335 family) for the exact model » ; « EU declaration of conformity citing Directive 2014/30/EU » (+ 2 autre(s)).
Sources : dossier blocked, version 2026-10-03T12:00:00.000Z, calculé le 2026-10-03 ; base de règles : à jour (2026-10-03) ; Safety Gate UE : à jour (2026-10-03) ; taux de change : à jour (2026-10-02).
```

## [blocked] « Est-ce que je peux commander ce produit ? »

Statut : `ANSWERED` · intention : `CAN_ORDER`

```text
Pas à ce stade : le verdict du moteur est « GO sous conditions, mais avec un blocage dur : aucune commande possible » et il ne permet pas d’engager de l’argent.
Ce que nous savons :
• verdict du moteur : GO sous conditions, mais avec un blocage dur : aucune commande possible
• argent engageable selon le moteur : non
Ce que nous ne savons pas :
• prix de vente non observé : visé par vous, pas observé sur le marché
Risques :
• documents obligatoires manquants ou inexploitables — « 5 required document(s) missing or not usable, e.g. EU declaration of conformity citing Directive 2014/35/EU; Safety test report »
• Condition : obtenir les documents obligatoires AVANT tout acompte
Pourquoi c’est important :
• un blocage dur élimine l’option « commander » avant toute comparaison
• Aucune règle propriétaire (budget, marge minimale, trésorerie) n’est définie : aucune ne peut être appliquée ni supposée.
Prochaine vérification :
• Demander au fournisseur : « EU declaration of conformity citing Directive 2014/35/EU » ; « Safety test report (e.g. EN 62368-1 / EN 60335 family) for the exact model » ; « EU declaration of conformity citing Directive 2014/30/EU » (+ 2 autre(s)).
Sources : dossier blocked, version 2026-10-03T12:00:00.000Z, calculé le 2026-10-03 ; base de règles : à jour (2026-10-03) ; Safety Gate UE : à jour (2026-10-03) ; taux de change : à jour (2026-10-02).
```

## [blocked] « Et si j’achète seulement la quantité minimale ? »

Statut : `ANSWERED` · intention : `MOQ_SCENARIO`

```text
À la quantité minimale (500 unités) : coût rendu 2600,36 €, marge unitaire 15,45 €.
Ce que nous savons :
• 7725,00 € si les 500 unités se vendaient toutes au prix saisi (hypothèse, pas une prévision)
• pour comparaison, au devis (1000 unités) : coût rendu 4584,53 €
Ce que nous ne savons pas :
• prix de vente non observé : visé par vous, pas observé sur le marché
Risques :
• blocage(s) dur(s) : documents obligatoires manquants ou inexploitables — les chiffres ci-dessus ne rendent pas la commande possible
Pourquoi c’est important :
• le prix unitaire du devis est supposé inchangé à cette quantité ; seul le fournisseur peut confirmer un autre prix
Prochaine vérification :
• Demander au fournisseur : « EU declaration of conformity citing Directive 2014/35/EU » ; « Safety test report (e.g. EN 62368-1 / EN 60335 family) for the exact model » ; « EU declaration of conformity citing Directive 2014/30/EU » (+ 2 autre(s)).
Sources : dossier blocked, version 2026-10-03T12:00:00.000Z, calculé le 2026-10-03 ; base de règles : à jour (2026-10-03) ; Safety Gate UE : à jour (2026-10-03) ; taux de change : à jour (2026-10-02).
```

## [blocked] « Est-ce que ce prix est bon ? »

Statut : `ANSWERED` · intention : `PRICE_JUDGEMENT`

```text
Le prix du devis (4,20 USD) est sous le prix unitaire maximum calculé par le moteur (14,64 USD).
Ce que nous savons :
• maximum calculé avec un prix de vente visé par vous, pas observé sur le marché
Ce que nous ne savons pas :
• aucun prix de marché ou de concurrent n’est lu ici : « bon » signifie seulement « sous le maximum de rentabilité du dossier »
Risques :
• un blocage dur reste ouvert : un bon prix ne rend pas la commande possible
Pourquoi c’est important :
• le prix maximum dépend du prix de vente supposé
Prochaine vérification :
• Demander au fournisseur : « EU declaration of conformity citing Directive 2014/35/EU » ; « Safety test report (e.g. EN 62368-1 / EN 60335 family) for the exact model » ; « EU declaration of conformity citing Directive 2014/30/EU » (+ 2 autre(s)).
Sources : dossier blocked, version 2026-10-03T12:00:00.000Z, calculé le 2026-10-03 ; base de règles : à jour (2026-10-03) ; Safety Gate UE : à jour (2026-10-03) ; taux de change : à jour (2026-10-02).
```

## [blocked] « Quelles questions dois-je poser avant de signer ? »

Statut : `ANSWERED` · intention : `SUPPLIER_QUESTIONS`

```text
Questions à poser au fournisseur (liste du moteur, 4 prioritaire(s)) :
À demander (anglais / chinois) :
• Please send the EU Declaration of Conformity (DoC) for model PD-65, citing Directive 2014/35/EU (LVD). / 请提供型号 PD-65 的欧盟符合性声明(EU DoC),并列明适用法规 Directive 2014/35/EU (LVD)。
• Please send the full test report from an accredited laboratory (ISO/IEC 17025) for model PD-65. / 请提供型号 PD-65 的具备 ISO/IEC 17025 认可资质实验室出具的完整检测报告。
• Please send the EU Declaration of Conformity (DoC) for model PD-65, citing Directive 2014/30/EU (EMC). / 请提供型号 PD-65 的欧盟符合性声明(EU DoC),并列明适用法规 Directive 2014/30/EU (EMC)。
• Please send the RoHS test report for model PD-65. / 请提供型号 PD-65 的RoHS 检测报告。
Pourquoi c’est important :
• chaque question a été posée parce qu’une règle ou un coût ne peut pas être tranché sans la réponse
Prochaine vérification :
• Demander aussi les documents manquants (en anglais) : Please send: EU declaration of conformity citing Directive 2014/35/EU ; Please send: Safety test report (e.g. EN 62368-1 / EN 60335 family) for the exact model ; Please send: EU declaration of conformity citing Directive 2014/30/EU ; Please send: EMC test report (e.g. EN 55032 / EN 55035 / EN 61000 family) for the exact model
Sources : dossier blocked, version 2026-10-03T12:00:00.000Z, calculé le 2026-10-03 ; base de règles : à jour (2026-10-03) ; Safety Gate UE : à jour (2026-10-03) ; taux de change : à jour (2026-10-02).
```

## [blocked] « Quelle est la prochaine étape ? »

Statut : `ANSWERED` · intention : `NEXT_STEP`

```text
La prochaine vérification utile :
Ce que nous savons :
• le moteur indique (texte original, en anglais) : « Continue the conversation, but do NOT pay a deposit until the conditions below are cleared. Ask for the missing documents and a sample now. »
Prochaine vérification :
• Demander au fournisseur : « EU declaration of conformity citing Directive 2014/35/EU » ; « Safety test report (e.g. EN 62368-1 / EN 60335 family) for the exact model » ; « EU declaration of conformity citing Directive 2014/30/EU » (+ 2 autre(s)).
Sources : dossier blocked, version 2026-10-03T12:00:00.000Z, calculé le 2026-10-03 ; base de règles : à jour (2026-10-03) ; Safety Gate UE : à jour (2026-10-03) ; taux de change : à jour (2026-10-02).
```

## [blocked] « Pourquoi cette recommandation ? »

Statut : `ANSWERED` · intention : `EXPLAIN_RECOMMENDATION`

```text
Aucune recommandation du Core n’est enregistrée pour ce dossier ; voici ce que le moteur du dossier établit déjà.
Ce que nous savons :
• verdict du moteur : GO sous conditions, mais avec un blocage dur : aucune commande possible
Ce que nous ne savons pas :
• pas encore d’analyse Core journalisée pour ce dossier
Risques :
• documents obligatoires manquants ou inexploitables — « 5 required document(s) missing or not usable, e.g. EU declaration of conformity citing Directive 2014/35/EU; Safety test report »
• Condition : obtenir les documents obligatoires AVANT tout acompte
Prochaine vérification :
• Demandez « dois-je acheter ce produit ? » : cela lance l’analyse du Core (journalisée, sans aucune commande) ; je ne la lance pas moi-même pour répondre à une question d’explication.
Sources : dossier blocked, version 2026-10-03T12:00:00.000Z, calculé le 2026-10-03 ; base de règles : à jour (2026-10-03) ; Safety Gate UE : à jour (2026-10-03) ; taux de change : à jour (2026-10-02).
```

## [blocked] « Dois-je acheter ce produit ? »

Statut : `ANSWERED`

```text
Recommandation Nordla Core : « Tester petit » (TEST_SMALL).
Pourquoi : No eligible action survived eligibility and rules: a small test is the only informative step.
Écarté : Commander 1000 unités (quantité du devis) — CONDITION_NOT_MET:can_commit_money eq true (actual false) ; CONDITION_NOT_MET:hard_blockers eq 0 (actual 1)
Écarté : Commander 500 unités seulement (minimum fournisseur) — CONDITION_NOT_MET:can_commit_money eq true (actual false) ; CONDITION_NOT_MET:hard_blockers eq 0 (actual 1)
Faits : verdict sourcing CONDITIONAL_GO, coût rendu total 4584,53 €, marge unitaire 16,07 €, prix de vente TARGET.
Manque : observed_selling_price — selling price is TARGET, not observed on the market
Rien n’est commandé ni payé par Nordla : c’est à vous de décider (bouton Valider / Rejeter).
```

## [blocked] « Pourquoi cette recommandation ? »

Statut : `ANSWERED` · intention : `EXPLAIN_RECOMMENDATION`

```text
Voici pourquoi le Core a formulé cette recommandation.
Ce que nous savons :
• recommandation du Core : « Tester petit » (TEST_SMALL)
• raison : No eligible action survived eligibility and rules: a small test is the only informative step.
• fait déterminant : verdict = CONDITIONAL_GO
• fait déterminant : can_commit_money = false
• fait déterminant : hard_blockers = 1 count
• fait déterminant : landed_total = 4584.53 EUR
• fait déterminant : contribution_per_unit = 16.07 EUR
• fait déterminant : price_basis = TARGET
• écartée : Commander 1000 unités (quantité du devis) — le dossier n’autorise pas d’engager de l’argent (verdict sourcing) ; 1 blocage(s) dur(s) dans le dossier
• écartée : Commander 500 unités seulement (minimum fournisseur) — le dossier n’autorise pas d’engager de l’argent (verdict sourcing) ; 1 blocage(s) dur(s) dans le dossier
• règles propriétaire appliquées : aucune. Aucune règle propriétaire (budget, marge minimale, trésorerie) n’est définie : aucune ne peut être appliquée ni supposée.
• aucune décision humaine enregistrée : rien n’est approuvé
Pourquoi c’est important :
• ce qui pourrait changer : lever les blocages (documents obligatoires manquants ou inexploitables) rendrait de nouveau les options de commande examinables — sans qu’aucune ne soit recommandée d’office
• ce qui pourrait changer : observer un vrai prix de vente peut changer l’attrait économique
Prochaine vérification :
• Demander au fournisseur : « EU declaration of conformity citing Directive 2014/35/EU » ; « Safety test report (e.g. EN 62368-1 / EN 60335 family) for the exact model » ; « EU declaration of conformity citing Directive 2014/30/EU » (+ 2 autre(s)).
Sources : dossier blocked, version 2026-10-03T12:00:00.000Z, calculé le 2026-10-03 ; base de règles : à jour (2026-10-03) ; Safety Gate UE : à jour (2026-10-03) ; taux de change : à jour (2026-10-02).
```

## [bare] « Quelle est la marge estimée ? »

Statut : `ANSWERED` · intention : `MARGIN`

```text
La marge ne peut pas être calculée avec le dossier actuel.
Ce que nous ne savons pas :
• coût rendu incalculable : il manque prix unitaire fournisseur, transport, droits de douane
• marge incalculable (selling price or VAT rate not entered)
• prix de vente non observé : visé par vous, pas observé sur le marché
Risques :
• blocage(s) dur(s) : exigence légale pas encore tranchée, coût indispensable encore inconnu — les chiffres ci-dessus ne rendent pas la commande possible
Pourquoi c’est important :
• sans coût rendu complet et prix de vente, toute marge annoncée serait inventée
Prochaine vérification :
• Préciser le produit avec le fournisseur : « Is the product intended to come into contact with food or drink? » ; « Is this product sold under your brand, or can it be sold under our own brand (private label)? » ; « Do you have an EU authorised representative or an EU importer for this product? ».
• Saisir les coûts indispensables encore inconnus : prix unitaire fournisseur, transport, droits de douane.
Sources : dossier bare, version 2026-10-03T12:00:00.000Z, calculé le 2026-10-03 ; base de règles : à jour (2026-10-03) ; Safety Gate UE : à jour (2026-10-03) ; taux de change : non vérifié.
```

## [bare] « Quel prix manque pour calculer la rentabilité ? »

Statut : `ANSWERED` · intention : `PRICE_GAP`

```text
Il manque, pour calculer la rentabilité :
Ce que nous ne savons pas :
• prix unitaire fournisseur
• transport
• droits de douane
• selling price or VAT rate not entered
• prix de vente (et taux de TVA) non saisis
Risques :
• blocage(s) dur(s) : exigence légale pas encore tranchée, coût indispensable encore inconnu — les chiffres ci-dessus ne rendent pas la commande possible
Prochaine vérification :
• Préciser le produit avec le fournisseur : « Is the product intended to come into contact with food or drink? » ; « Is this product sold under your brand, or can it be sold under our own brand (private label)? » ; « Do you have an EU authorised representative or an EU importer for this product? ».
• Saisir les coûts indispensables encore inconnus : prix unitaire fournisseur, transport, droits de douane.
Sources : dossier bare, version 2026-10-03T12:00:00.000Z, calculé le 2026-10-03 ; base de règles : à jour (2026-10-03) ; Safety Gate UE : à jour (2026-10-03) ; taux de change : non vérifié.
```

## [blocked] « Quelle est la marge de ce fournisseur sur mes ventes ? »

Statut : `ASK`

```text
Parlez-vous du dossier ouvert (fournisseur, produit, devis) ou de chiffres Finance / Analyses (factures, trésorerie, ventes) ? Précisez, je ne devine pas.
```

