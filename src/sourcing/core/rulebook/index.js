import { EU_RULES, RULE_VERSION } from './eu.js';
import { BE_RULES } from './be.js';
import { AMAZON_RULES } from './amazon.js';

export const RULEBOOK = Object.freeze([...EU_RULES, ...BE_RULES, ...AMAZON_RULES]);
export { RULE_VERSION };
export { SRC, CHECKED } from './sources.js';
