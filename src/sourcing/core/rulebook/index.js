import { EU_RULES, RULE_VERSION } from './eu.js';
import { BE_RULES } from './be.js';
import { AMAZON_RULES } from './amazon.js';
import { REVIEW } from './review.js';
import { META } from './meta.js';

export const RULEBOOK = Object.freeze([...EU_RULES, ...BE_RULES, ...AMAZON_RULES].map((rule) => ({ ...rule, requiredEvidence: rule.requiredEvidence.map((e) => ({ obligation: 'LEGAL', ...e })), review: REVIEW[rule.id], ...META[rule.id] })));
export { REVIEW, REVIEW_STATUSES, REVIEW_BLOCKING, REVIEW_MAX_AGE_DAYS } from './review.js';
export { META } from './meta.js';
export { RULE_VERSION };
export { SRC, CHECKED } from './sources.js';
