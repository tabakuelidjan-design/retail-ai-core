// Held-out phrasings written AFTER the rules were tuned: they estimate how the recogniser generalises beyond the questions it was developed on.
//   node docs/integration/core-field-assistant-eval/heldout.mjs <repo-root>
import { pathToFileURL } from 'node:url';
import { resolve, join } from 'node:path';

const root = resolve(process.argv[2] ?? '.');
const { recognizeFieldIntent: recognise } = await import(pathToFileURL(join(root, 'src/core-pilot/field-intents.js')).href);
const cases = [
  ['MISSING', 'il manque quoi dans ce dossier ?'], ['MISSING', 'on a tout ce qu’il faut pour ce produit ?'], ['MISSING', 'quelles informations manquent encore ?'],
  ['DOCUMENTS', 'est-ce que les certificats sont là ?'], ['DOCUMENTS', 'les documents du fournisseur sont complets ?'], ['DOCUMENTS', 'il faut demander quels papiers au fournisseur ?'],
  ['RISKS', 'y a-t-il un danger avec ce produit ?'], ['RISKS', 'qu’est-ce qui pourrait mal tourner ?'], ['RISKS', 'ce fournisseur est risqué ?'], ['RISKS', 'quels sont les problèmes sur ce dossier ?'],
  ['MARGIN', 'je gagne combien par pièce ?'], ['MARGIN', 'c’est rentable ?'], ['MARGIN', 'quel bénéfice sur ce produit ?'],
  ['LANDED_COST', 'ça me revient à combien l’unité ?'], ['LANDED_COST', 'quel est le prix de revient ?'],
  ['ORDER_TOTAL', 'combien je dois sortir pour toute la commande ?'], ['ORDER_TOTAL', 'quel est le total de la commande ?'],
  ['CAN_ORDER', 'je peux passer commande maintenant ?'], ['CAN_ORDER', 'est-ce que je peux signer ?'], ['CAN_ORDER', 'puis-je verser un acompte ?'],
  ['NEXT_STEP', 'on fait quoi maintenant ?'], ['NEXT_STEP', 'que dois-je faire ensuite sur ce dossier ?'], ['NEXT_STEP', 'et maintenant, que vérifier ?'],
  ['SUPPLIER_QUESTIONS', 'que faut-il lui demander ?'], ['SUPPLIER_QUESTIONS', 'quelles questions pour le fournisseur ?'],
  ['PRICE_JUDGEMENT', 'ce prix est-il intéressant ?'], ['PRICE_JUDGEMENT', 'le prix proposé est trop cher ?'],
  ['MOQ_SCENARIO', 'et en prenant juste le minimum de commande ?'], ['MOQ_SCENARIO', 'si je commande la quantité minimum, ça donne quoi ?'],
  ['EXPLAIN_RECOMMENDATION', 'pourquoi tu me recommandes ça ?'], ['EXPLAIN_RECOMMENDATION', 'pourquoi l’achat complet est écarté ?'],
  ['KNOWLEDGE', 'qu’est-ce qu’on sait de fiable ?'], ['KNOWLEDGE', 'fais-moi le point sur ce fournisseur'],
  [null, 'quel temps fait-il à Shenzhen ?'], [null, 'écris un poème'], [null, 'quelle est ma trésorerie ?'], [null, 'mes ventes de la semaine'],
];
let ok = 0; const ko = [];
for (const [want, q] of cases) { const r = recognise(q); const got = r.status === 'RECOGNISED' ? r.intent : null; if (got === want) ok += 1; else ko.push(`${q}  ->  ${r.status}/${got ?? ''}${r.candidates ? ` [${r.candidates}]` : ''}  (attendu ${want})`); }
console.log(`held-out: ${ok}/${cases.length}`); for (const k of ko) console.log(`  KO ${k}`);
