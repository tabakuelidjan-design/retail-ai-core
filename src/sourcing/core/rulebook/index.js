import { EU_RULES, RULE_VERSION } from './eu.js';
import { BE_RULES } from './be.js';
import { AMAZON_RULES } from './amazon.js';

import { REVIEW } from './review.js';

export const RULEBOOK = Object.freeze([...EU_RULES, ...BE_RULES, ...AMAZON_RULES].map((rule) => ({ ...rule, review: REVIEW[rule.id] })));
export { REVIEW, REVIEW_STATUSES } from './review.js';
export { RULE_VERSION };
export { SRC, CHECKED } from './sources.js';
