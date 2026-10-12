// REGULATORY COVERAGE of the rulebook for THIS product: a pure, deterministic guard. The rulebook covers a fixed set of product families; a product outside them
// has NO applicable rule, and "no applicable rule" must never be read as "nothing applies". It adds no regulatory rule: it only says when the rulebook does not speak.
//   OUT_OF_COVERAGE  HARD       the name points at a family with no rule at all (magnets, lighters, e-mobility, lasers, machinery, furniture, footwear, child-care articles, fireworks, vapes)
//   OUT_OF_COVERAGE  CONDITION  no category chosen, or a general category: the rules were evaluated on assumed traits only
//   PARTIAL                     covered, but the energy label / ecodesign are not assessed (lamps, small appliances, chargers)
//   COVERED                     nothing to flag (this is NOT a conformity statement)
const UNCOVERED = Object.freeze([
  ['magnets', /\b(magnet\w*|aimant\w*|neodymium|n52)\b|磁/i],
  ['lighters', /\b(lighter|briquet|zippo)\b|打火机/i],
  ['e-mobility', /\b(e-?bike|e-?scooter|electric scooter|trottinette|hoverboard|segway|vélo électrique)\b|电动车|滑板车/i],
  ['lasers', /\b(laser)\b|激光/i],
  ['machinery / power tools', /\b(power tool|drill|perceuse|grinder|meuleuse|chainsaw|tronçonneuse|3d printer|cnc|machine)\b|电动工具/i],
  ['furniture', /\b(furniture|meuble|chair|chaise|stool|tabouret|bunk bed|crib|cot|shelf unit)\b|家具/i],
  ['footwear / leather', /\b(shoe|shoes|sneaker|boot|boots|chaussure\w*|sandal\w*|leather|cuir)\b|鞋|皮革/i],
  ['child-care articles', /\b(stroller|pushchair|poussette|car seat|baby carrier|pacifier|soother|tétine|teether|baby bottle|biberon|walker)\b|婴儿车|奶嘴/i],
  ['fireworks / pyrotechnics', /\b(firework\w*|feu d.artifice|sparkler|pyrotechn\w*)\b|烟花/i],
  ['e-cigarettes', /\b(vape|e-?cig\w*|e-?liquid)\b|电子烟/i],
]);
const GENERAL = new Set(['household_general', 'gift_decor_generic']);
const ENERGY_PARTIAL = new Set(['led_lamp_mains', 'small_appliance_mains', 'usb_charger']);

/** @param {{ category?: string|null, name?: string|null, assumedTraits?: number }} p  `assumedTraits`: key traits only ASSUMED from the category (not stated by the owner or a document) */
export function regulatoryCoverage({ category = null, name = '', assumedTraits = 0 } = {}) {
  const text = String(name ?? ''); const hits = UNCOVERED.filter(([, re]) => re.test(text)).map(([label]) => label); const FR = {"magnets":"aimants","lighters":"briquets","e-mobility":"mobilité électrique","lasers":"lasers","machinery / power tools":"machines / outils électriques","furniture":"meubles","footwear / leather":"chaussures / cuir","child-care articles":"articles de puériculture","fireworks / pyrotechnics":"feux d’artifice","e-cigarettes":"cigarettes électroniques"};
  const out = (status, severity, reasons, notes = [], reasonsFr = []) => ({ status, severity, reasons, reasonsFr, notes, banner: status === 'OUT_OF_COVERAGE' ? 'Hors couverture — ne pas conclure' : null, impliesCompliance: false });
  if (hits.length) return out('OUT_OF_COVERAGE', 'HARD', [`the rulebook has NO rule for: ${hits.join(', ')}`], [], [`Aucune règle de Nordla pour : ${hits.map((h) => FR[h] ?? h).join(', ')}.`]);
  if (!category) return out('OUT_OF_COVERAGE', 'CONDITION', ['no product category is chosen: no rule family was evaluated'], [], ['Aucune catégorie de produit choisie : aucune famille de règles n’a été évaluée.']);
  if (GENERAL.has(category) && assumedTraits > 0) return out('OUT_OF_COVERAGE', 'CONDITION', [`"${category}" is a general category: only generic obligations were evaluated, on traits assumed from that category (not stated by you or a document)`], [], ['Catégorie générale : seules les obligations générales ont été évaluées, sur des caractéristiques supposées (ni confirmées par vous, ni par un document).']);
  if (ENERGY_PARTIAL.has(category)) return out('PARTIAL', null, [], ['energy label and ecodesign requirements are NOT assessed by Nordla']);
  return out('COVERED', null, [], ['"covered" means a rule family was evaluated, never that the product is compliant']);
}
