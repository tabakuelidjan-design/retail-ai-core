// "Ask the supplier NOW": prioritised questions generated from what is still missing, a fixed English / Simplified Chinese phrasebook (NOT machine translation:
// the sentences are fixed and reviewed once; model numbers, standards and document names are inserted VERBATIM), and the negotiation brief.
import { effective } from './identity.js';
import { KEY_TRAITS } from './taxonomy.js';
import { fmt } from './money.js';

export const PHRASEBOOK_NOTE = {
  en: 'Fixed phrasebook, not a live translation. Model numbers, standards and document names are copied exactly. Ask a Chinese speaker to check anything that matters.',
  zh: '以下为固定用语,非机器实时翻译。型号、标准号和文件名称均原样保留。重要内容请由中文母语者再次确认。',
};

const DOC_NAMES = {
  EU_DOC: { en: 'EU Declaration of Conformity (DoC)', zh: '欧盟符合性声明(EU DoC)' },
  TEST_REPORT: { en: 'full test report from an accredited laboratory (ISO/IEC 17025)', zh: '具备 ISO/IEC 17025 认可资质实验室出具的完整检测报告' },
  CERTIFICATE: { en: 'certificate', zh: '证书' },
  SDS: { en: 'Safety Data Sheet (SDS)', zh: '安全数据表(SDS)' },
  UN383: { en: 'UN 38.3 test summary / report for the battery', zh: '电池 UN 38.3 测试报告/摘要' },
  BATTERY_DOC: { en: 'battery safety test report (e.g. IEC 62133)', zh: '电池安全检测报告(如 IEC 62133)' },
  ROHS_EVIDENCE: { en: 'RoHS test report', zh: 'RoHS 检测报告' },
  REACH_EVIDENCE: { en: 'REACH / SVHC test report or declaration', zh: 'REACH/SVHC 检测报告或声明' },
  FCM_DOC: { en: 'food contact Declaration of Compliance', zh: '食品接触材料符合性声明' },
  MATERIAL_DECL: { en: 'material declaration', zh: '材料声明' },
  LABEL_ARTWORK: { en: 'label artwork', zh: '标签设计稿' },
  PACKAGING_ARTWORK: { en: 'packaging artwork', zh: '包装设计稿' },
  MANUAL: { en: 'user manual', zh: '使用说明书' },
};

/** id -> template. {model}, {docEn}, {docZh}, {qty}, {incoterm}, {refs} are replaced; values are inserted verbatim. */
const TEMPLATES = {
  model: { en: 'What is the exact model number / type designation of this product?', zh: '请问这款产品的准确型号(Model No.)是多少?' },
  manufacturer: { en: 'What is the legal company name and full address of the factory that manufactures this product?', zh: '请问生产该产品的工厂的法定公司名称和详细地址是什么?' },
  brand: { en: 'Is this product sold under your brand, or can it be sold under our own brand (private label)? Who owns the trademark?', zh: '该产品是以贵公司品牌销售,还是可以贴我们自己的品牌(贴牌)?商标归谁所有?' },
  eu_party: { en: 'Do you have an EU authorised representative or an EU importer for this product? Please give name and address.', zh: '该产品是否有欧盟授权代表或欧盟进口商?请提供名称和地址。' },
  price: { en: 'What is your unit price for {qty} units, and what is the minimum order quantity (MOQ)?', zh: '订购 {qty} 件时的单价是多少?最小起订量(MOQ)是多少?' },
  incoterm: { en: 'Which Incoterm is the price based on (EXW, FOB, CIF, DDP...), and which port?', zh: '报价基于哪种贸易条款(EXW、FOB、CIF、DDP 等)?装运港是哪里?' },
  lead_time: { en: 'What is the production lead time, and the payment terms?', zh: '生产周期是多久?付款条件是什么?' },
  carton: { en: 'What are the carton dimensions, carton gross weight and units per carton?', zh: '外箱尺寸、外箱毛重和每箱数量是多少?' },
  battery: { en: 'Does the product contain a battery? Please state type (lithium-ion / lithium-polymer / other), capacity in Wh and mAh, and whether it is removable.', zh: '产品是否含电池?请说明电池类型(锂离子/锂聚合物/其他)、容量(Wh 和 mAh)以及是否可拆卸。' },
  radio: { en: 'Does the product have Bluetooth, Wi-Fi or any radio function? Please state the radio module and frequency bands.', zh: '产品是否有蓝牙、Wi-Fi 或其他无线功能?请说明无线模块型号和频段。' },
  voltage: { en: 'What are the rated input and output voltage and current of the product?', zh: '产品的额定输入和输出电压、电流分别是多少?' },
  mains: { en: 'Is the product connected directly to mains electricity (230 V)?', zh: '产品是否直接连接市电(230 V)?' },
  children: { en: 'What age group is the product designed for? Is it intended for children under 14 or for play?', zh: '该产品的设计适用年龄是多少?是否面向 14 岁以下儿童或用于玩耍?' },
  food: { en: 'Is the product intended to come into contact with food or drink? What materials touch the food?', zh: '该产品是否用于接触食品或饮品?与食品接触的材料是什么?' },
  materials: { en: 'What materials is the product made of (main material, coating, paint, dye)?', zh: '产品由哪些材料制成(主要材料、涂层、油漆、染料)?' },
  cosmetic: { en: 'Is this a cosmetic / personal-care product? Please send the full ingredient list (INCI).', zh: '这是化妆品/个人护理产品吗?请提供完整成分表(INCI)。' },
  medical: { en: 'Does the supplier claim any medical or therapeutic purpose for this product?', zh: '该产品是否宣称有医疗或治疗用途?' },
  hs: { en: 'Which HS code do you use to export this product from China?', zh: '贵公司出口该产品使用的海关 HS 编码是什么?' },
  sample: { en: 'Can you send a sample before we place the order? What is the sample cost and time?', zh: '下单前可以先寄样品吗?样品费用和时间是多少?' },
  doc: { en: 'Please send the {docEn} for model {model}{refs}.', zh: '请提供型号 {model} 的{docZh}{refsZh}。' },
  doc_fix: { en: 'The {docEn} you sent does not match model {model}: please send the correct document for model {model}.', zh: '您发来的{docZh}与型号 {model} 不一致:请提供型号 {model} 对应的正确文件。' },
  own_brand_docs: { en: 'If we sell this under our own brand we need the full technical file, test reports in our name or covering our model, and your agreement to supply updated documents. Is that possible?', zh: '如果我们以自有品牌销售,需要完整的技术文件、涵盖我们型号的检测报告,并且需要贵司同意持续提供更新文件。能否做到?' },
  quality_inspection: { en: 'Do you accept a third-party pre-shipment inspection before final payment?', zh: '尾款支付前,是否接受第三方出货前检验?' },
};

const REF_NAMES = { '2014/35': 'Directive 2014/35/EU (LVD)', '2014/30': 'Directive 2014/30/EU (EMC)', '2014/53': 'Directive 2014/53/EU (RED)', '2011/65': 'Directive 2011/65/EU (RoHS)', '2009/48': 'Directive 2009/48/EC (Toys)', '2016/425': 'Regulation (EU) 2016/425 (PPE)', '2023/1542': 'Regulation (EU) 2023/1542 (Batteries)', '2023/988': 'Regulation (EU) 2023/988 (GPSR)' };
const refName = (r) => REF_NAMES[r] ?? r;
const fill = (s, p) => s.replace(/\{(\w+)\}/g, (_, k) => (p[k] === undefined || p[k] === null ? '' : String(p[k])));
const Q = (id, priority, topic, why, blocks, params = {}, extra = {}) => { const t = TEMPLATES[extra.template ?? id]; return { id: extra.qid ?? id, priority, topic, why, blocks, en: fill(t.en, params).replace(/\s+([.,])/g, '$1'), zh: fill(t.zh, { ...params, refsZh: params.refsZh ?? '' }), ...(extra.docType ? { docType: extra.docType } : {}) }; };

/**
 * @param {{ identity: object, role: object, rules: object, docs: object[], landed: object|null, quote: object|null, customs: object|null, channels: string[] }} a
 * Returns questions sorted P1 -> P3, deduplicated. Everything asked is something that is MISSING in the case now.
 */
export function buildQuestions({ identity, role, rules, docs, landed, quote, channels = [] }) {
  const out = []; const model = identity.identifiers?.model ?? effective(identity, 'model').value ?? null; const modelLabel = model ?? '(model number not yet known)';
  const add = (q) => { if (!out.some((o) => o.id === q.id)) out.push(q); };
  if (!model) add(Q('model', 'P1', 'Identity', 'Nothing can be tied to a product without its exact model number', ['IDENTITY', 'IMPORT', 'AMAZON']));
  if (!(identity.identifiers?.manufacturer ?? effective(identity, 'manufacturer').value)) add(Q('manufacturer', 'P1', 'Identity', 'The legal manufacturer must appear on documents and labels, and documents must match it', ['IDENTITY', 'IMPORT']));
  const unresolved = KEY_TRAITS.filter((t) => !effective(identity, t).known);
  const traitQ = { 'battery.present': 'battery', 'radio.present': 'radio', 'electrical.present': 'voltage', childrenUse: 'children', foodContact: 'food', cosmetic: 'cosmetic', medical: 'medical', textile: 'materials', chemicalMixture: 'materials', ppe: 'materials' };
  for (const t of unresolved) if (traitQ[t]) add(Q(traitQ[t], 'P1', 'Identity', `"${t}" is not established: the rules that depend on it cannot be decided`, ['IDENTITY', 'IMPORT']));
  const mains = effective(identity, 'electrical.mainsConnected');
  if (effective(identity, 'electrical.present').value === true && !mains.known) add(Q('mains', 'P2', 'Identity', 'mains connection decides whether the Low Voltage Directive applies', ['IMPORT']));
  for (const u of role.unresolved ?? []) add(Q(u.code === 'OWN_BRAND_UNKNOWN' ? 'brand' : 'eu_party', 'P1', 'Role', u.question, ['IMPORT']));
  if (role.ownBrand === true) add(Q('own_brand_docs', 'P1', 'Role', 'Own brand makes you the manufacturer: you need the technical file', ['IMPORT', 'AMAZON']));
  // commercial
  const unk = new Set(landed?.criticalUnknown ?? []);
  if (!quote || unk.has('supplier.unitPrice') || !quote.moq) add(Q('price', 'P1', 'Price', 'No supplier price / MOQ yet: nothing can be calculated', ['PRICE'], { qty: quote?.qty ?? quote?.moq ?? '' }));
  if (!quote?.incoterm) add(Q('incoterm', 'P1', 'Price', 'The Incoterm decides which costs are already in the price', ['PRICE']));
  if (unk.has('costs.freight') || !quote?.carton) add(Q('carton', 'P2', 'Price', 'Carton data is needed to estimate freight', ['PRICE']));
  if (!quote?.leadTimeDays) add(Q('lead_time', 'P3', 'Price', 'Lead time and payment terms are needed before committing', ['PRICE']));
  add(Q('hs', 'P3', 'Customs', 'The supplier\'s export HS code is a HINT for the customs classification (not a classification)', ['IMPORT']));
  // documents: from missing evidence of the rules that apply or may apply
  const seen = new Set();
  for (const r of rules.results ?? []) {
    if (r.status === 'NOT_APPLICABLE') continue;
    for (const m of r.missingEvidence ?? []) {
      if (!m.docType || m.docType === 'COMPANY_RECORD' || m.requirement === 'RECOMMENDED') continue;
      const key = `${m.docType}:${m.coverage.status}`; if (seen.has(`${m.docType}:${r.ruleId}`)) continue; seen.add(`${m.docType}:${r.ruleId}`); void key;
      const names = DOC_NAMES[m.docType] ?? DOC_NAMES.TEST_REPORT;
      const refs = (r.instrumentRefs ?? []).filter((x) => x !== '2019/1020'); const refsEn = refs.length && m.docType === 'EU_DOC' ? `, citing ${refs.map(refName).join(', ')}` : ''; const refsZh = refs.length && m.docType === 'EU_DOC' ? `,并列明适用法规 ${refs.map(refName).join('、')}` : '';
      const mismatch = m.coverage.status === 'PRESENT_WITH_CONCERNS' || m.coverage.status === 'DOES_NOT_COVER_THIS_REGULATION';
      const id = `doc:${m.docType}${m.docType === 'EU_DOC' ? `:${refs[0] ?? 'any'}` : ''}${mismatch ? ':fix' : ''}`;
      const pri = m.requirement === 'REQUIRED' && r.status === 'APPLIES' ? 'P1' : 'P2';
      add(Q(id, pri, mismatch ? 'Document problem' : 'Documents', `${r.title}: ${m.label}${mismatch ? ` (what was supplied: ${m.coverage.status})` : ''}`, ['IMPORT', ...(channels.includes('amazon') ? ['AMAZON'] : [])],
        { model: modelLabel, docEn: names.en, docZh: names.zh, refs: refsEn, refsZh }, { template: mismatch ? 'doc_fix' : 'doc', docType: m.docType, qid: id }));
    }
  }
  if (docs.some((d) => d.inspection && ['INCONSISTENT', 'SUSPICIOUS'].includes(d.inspection.consistency))) add(Q('quality_inspection', 'P2', 'Verification', 'a supplied document shows inconsistencies: ask for independent verification', ['IMPORT']));
  add(Q('sample', 'P2', 'Verification', 'a sample lets you check the product and have it tested before a deposit', ['IMPORT']));
  const ord = { P1: 0, P2: 1, P3: 2 };
  return out.sort((a, b) => ord[a.priority] - ord[b.priority]);
}

/** Text the owner can show on the phone: both languages, side by side, numbered. */
export function supplierSheet(questions, { lang = 'both', priorities = ['P1', 'P2'] } = {}) {
  const qs = questions.filter((q) => priorities.includes(q.priority));
  return { note: PHRASEBOOK_NOTE, lang, items: qs.map((q, i) => ({ n: i + 1, id: q.id, priority: q.priority, ...(lang !== 'zh' ? { en: q.en } : {}), ...(lang !== 'en' ? { zh: q.zh } : {}) })) };
}

/**
 * Negotiation brief. The walk-away price is the MAXIMUM PURCHASE PRICE computed by the engine; the target price is the walk-away minus an EXPLICIT negotiation margin
 * (default 15%, an editable Nordla default - not a market fact). Nothing here predicts what the supplier will accept.
 */
export function negotiationBrief({ maxPrice, quote, rules, role, targetDiscountPct = 15, currency = 'USD' }) {
  const walk = maxPrice?.maxUnitPriceMinor ?? null;
  const target = walk === null ? null : Math.round(walk * (1 - targetDiscountPct / 100));
  const docsBeforeDeposit = (rules.results ?? []).filter((r) => r.status !== 'NOT_APPLICABLE').flatMap((r) => (r.missingEvidence ?? []).filter((m) => m.requirement === 'REQUIRED' && m.docType && m.docType !== 'COMPANY_RECORD').map((m) => m.label));
  return {
    walkAwayUnitPrice: walk === null ? null : { minor: walk, currency, display: fmt(walk, currency), basis: maxPrice.upperBound ? 'UPPER_BOUND (some fees unknown)' : 'CALCULATED' },
    targetUnitPrice: target === null ? null : { minor: target, currency, display: fmt(target, currency), basis: `walk-away minus ${targetDiscountPct}% negotiation margin (editable default)` },
    quotedUnitPrice: quote?.unitPrice ?? null, moq: quote?.moq ?? null, incoterm: quote?.incoterm ?? null,
    moqNote: quote?.moq && quote?.qty && quote.qty < quote.moq ? `you plan ${quote.qty} but the MOQ is ${quote.moq}: the calculation uses the quantity you plan to buy` : null,
    documentsBeforeDeposit: [...new Set(docsBeforeDeposit)],
    sample: 'ask for a sample and have it tested or at least checked against the documents before any deposit',
    inspection: 'agree a third-party pre-shipment inspection before final payment',
    incotermAdvice: quote?.incoterm ? `price is based on ${quote.incoterm}: check what is NOT included (see the landed-cost lines)` : 'get the Incoterm in writing: without it the landed cost is incomplete',
    ownBrandWarning: role?.ownBrand === true ? 'own brand: you carry the manufacturer duties; do not pay a deposit before the technical file is agreed' : null,
    nothingPredicted: 'Nordla does not predict what the supplier will accept: the target price is arithmetic, not a market forecast.',
  };
}
