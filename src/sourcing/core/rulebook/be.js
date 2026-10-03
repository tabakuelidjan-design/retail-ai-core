// Belgian layer (authoritative Belgian sources only). Belgian rules refine the EU rules: language, producer-responsibility schemes, radio authority.
import { SRC } from './sources.js';
import { RULE_VERSION } from './eu.js';

const R = (r) => ({ jurisdiction: 'BE', ruleVersion: RULE_VERSION, instrumentRefs: [], requiresAuthorityConfirmation: false, severity: 'NORMAL', requiredEvidence: [], ...r });
const own = (id, label, requirement = 'REQUIRED', extra = {}) => ({ id, label, docType: 'COMPANY_RECORD', requirement, ...extra });

export const BE_RULES = [
  R({
    id: 'be.language', family: 'LANGUAGE', title: 'Language of instructions, labels and safety information (Belgium)',
    appliesWhen: { ctx: 'consumerSales', is: true },
    whyApplies: 'label, instructions and safety information must be in a language understandable to the average consumer, taking the linguistic region into account (Code de droit economique art. VI.8): Dutch in Flanders, French in Wallonia, both in Brussels. For a Belgium-wide offer plan Dutch AND French (conservative reading); German is explicit only for radio equipment (BIPT)',
    requiredEvidence: [{ id: 'be.lang.manual', label: 'Manual, safety information and packaging text in French and Dutch (German where sold in the German-speaking area)', docType: 'MANUAL', requirement: 'CONDITIONAL' }],
    sources: [SRC.BE_LANG, SRC.BE_GENERAL], requiresAuthorityConfirmation: true,
    notes: 'Languages for FR, DE and NL Amazon marketplaces follow each Member State: not verified here.',
  }),
  R({
    id: 'be.recupel', family: 'WEEE', title: 'Recupel registration (electrical and electronic equipment, Belgium)',
    appliesWhen: { trait: 'electrical.present', is: true },
    whyApplies: 'anyone selling electrical equipment in Belgium, physical or online (including from abroad), must register with Recupel or file an individual waste-management plan; a non-Belgian seller can appoint Recupel as authorised representative; online marketplaces must verify this since 29 Mar 2025',
    whyNot: 'no electrical or electronic function established',
    requiredEvidence: [own('be.recupel.reg', 'Recupel registration (producer or importer)', 'REQUIRED')],
    sources: [SRC.BE_RECUPEL, SRC.BE_RECUPEL_RETAIL],
  }),
  R({
    id: 'be.bebat', family: 'BATTERIES', title: 'Bebat registration (batteries, Belgium)',
    appliesWhen: { trait: 'battery.present', is: true },
    whyApplies: 'producers and importers of batteries, including batteries inside devices, are responsible for them in Belgium: they register with the three regional governments and declare batteries first placed on the market; joining Bebat is optional (individually or via Bebat). Foreign distance sellers must appoint a Belgian authorised representative',
    whyNot: 'no battery established',
    requiredEvidence: [own('be.bebat.reg', 'Regional battery registration and declaration (directly or through Bebat), Belgian authorised representative for distance sales', 'REQUIRED')],
    sources: [SRC.BE_BEBAT, SRC.BATT_BE],
  }),
  R({
    id: 'be.packaging', family: 'PACKAGING', title: 'Packaging producer responsibility (Fost Plus / Valipac, Belgium)',
    appliesWhen: { always: true },
    whyApplies: 'the importer or the first seller of packaged goods in Belgium is responsible for the packaging: Fost Plus for household packaging, Valipac for industrial packaging',
    requiredEvidence: [own('be.pack.reg', 'Fost Plus / Valipac membership or declaration', 'REQUIRED')],
    sources: [SRC.BE_FOSTPLUS, SRC.BE_VALIPAC], requiresAuthorityConfirmation: true,
  }),
  R({
    id: 'be.bipt', family: 'RED', title: 'BIPT obligations for radio equipment (Belgium)',
    appliesWhen: { trait: 'radio.present', is: true },
    whyApplies: 'radio equipment sold in Belgium: the BIPT lists the obligations of economic operators and instructions must be available in French, Dutch and German',
    whyNot: 'no radio function established',
    requiredEvidence: [{ id: 'be.bipt.manual', label: 'Instructions in French, Dutch and German', docType: 'MANUAL', requirement: 'CONDITIONAL' }],
    sources: [SRC.BE_BIPT], requiresAuthorityConfirmation: true,
  }),
  R({
    id: 'be.fcm', family: 'FCM', title: 'Food-contact materials: FASFC (Belgium)',
    appliesWhen: { trait: 'foodContact', is: true },
    whyApplies: 'in Belgium the FASFC supervises food-contact materials and a declaration of compliance is mandatory for the material or article',
    whyNot: 'not intended to touch food or drink',
    requiredEvidence: [{ id: 'be.fcm.doc', label: 'Declaration of compliance available on request', docType: 'FCM_DOC', requirement: 'REQUIRED' }],
    sources: [SRC.FCM_BE],
  }),
];
