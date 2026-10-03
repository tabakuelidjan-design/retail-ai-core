// Amazon READINESS rules (channel-gated: evaluated only when 'amazon' is a target channel). They describe what Amazon asks sellers to hold: they are NOT legal
// marketability and nothing here ever says "Amazon approved". Fees are NOT here (explicit user inputs only).
import { SRC } from './sources.js';
import { RULE_VERSION } from './eu.js';

const R = (r) => ({ jurisdiction: 'AMAZON', channel: 'amazon', ruleVersion: RULE_VERSION, instrumentRefs: [], requiresAuthorityConfirmation: true, severity: 'NORMAL', requiredEvidence: [], ...r });

export const AMAZON_RULES = [
  R({
    id: 'amazon.gpsr_listing', family: 'AMAZON_GPSR', title: 'Amazon: GPSR information per listing',
    appliesWhen: { always: true },
    whyApplies: 'Amazon requires, per listing, the manufacturer details, the EU responsible person (when the manufacturer is outside the EU) and safety information, as the GPSR requires of online offers',
    requiredEvidence: [{ id: 'az.gpsr.label', label: 'Label artwork with manufacturer / responsible person details and a product picture for the listing', docType: 'LABEL_ARTWORK', requirement: 'REQUIRED' }, { id: 'az.gpsr.rp', label: 'Name the EU responsible person for each marketplace', docType: 'COMPANY_RECORD', requirement: 'REQUIRED' }],
    sources: [SRC.AMAZON_GPSR, SRC.GPSR],
  }),
  R({
    id: 'amazon.category_documents', family: 'AMAZON_COMPLIANCE', title: 'Amazon: compliance documents for regulated product areas',
    appliesWhen: { any: [{ trait: 'electrical.present', is: true }, { trait: 'battery.present', is: true }, { trait: 'toy', is: true }, { trait: 'cosmetic', is: true }, { trait: 'foodContact', is: true }, { trait: 'ppe', is: true }, { trait: 'textile', is: true }] },
    whyApplies: 'Amazon can ask for the EU declaration of conformity, test reports, certificates or other proof for regulated product areas before or after a listing goes live. Have them ready under the exact model name',
    whyNot: 'no regulated product area established',
    requiredEvidence: [{ id: 'az.cat.doc', label: 'EU declaration of conformity / compliance declaration for the category', docType: 'EU_DOC', docTypes: ['EU_DOC', 'FCM_DOC'], requirement: 'CONDITIONAL' }, { id: 'az.cat.test', label: 'Laboratory test report for the category', docType: 'TEST_REPORT', requirement: 'CONDITIONAL' }],
    sources: [SRC.AMAZON_COMPLIANCE],
    notes: 'The exact list of documents Amazon asks for depends on the marketplace, the category and the product: Seller Central is authoritative. A document set that looks complete is never an Amazon approval.',
  }),
  R({
    id: 'amazon.dangerous_goods', family: 'AMAZON_DG', title: 'Amazon: dangerous-goods review (batteries and chemicals)',
    appliesWhen: { any: [{ trait: 'battery.present', is: true }, { trait: 'chemicalMixture', is: true }] },
    whyApplies: 'products with lithium batteries or hazardous chemicals go through Amazon\'s dangerous-goods classification, which asks for safety data and UN 38.3 information and changes fulfilment fees and eligibility',
    whyNot: 'no battery or chemical mixture established',
    requiredEvidence: [{ id: 'az.dg.un383', label: 'UN 38.3 summary for lithium batteries', docType: 'UN383', requirement: 'CONDITIONAL', when: { trait: 'battery.present', is: true } }, { id: 'az.dg.sds', label: 'Safety data sheet', docType: 'SDS', requirement: 'CONDITIONAL' }],
    sources: [SRC.AMAZON_COMPLIANCE, SRC.AMAZON_FBA_RATES],
  }),
];
