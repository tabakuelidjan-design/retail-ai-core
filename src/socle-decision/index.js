// Socle Decision V0 - public surface.
// Entreprise -> Sujets -> Leviers -> Décisions -> Suivi. Deterministic, in-memory, no I/O.
export * from './constants.js';
export { SocleError } from './util.js';
export { createSubject, triageSubject, transitionSubject, getFact, factNumber } from './subject.js';
export { createLever, createDoNothingLever, createTestSmallLever, checkEligibility, combineLevers } from './lever.js';
export { createRule, createRuleSet, evaluateRule, evaluateRules } from './rules.js';
export { assertGateConfig, passesMateriality, selectPriorities, evaluateCooldown } from './gates.js';
export { decide } from './decision.js';
export { DEFAULT_PROFILES, resolveProfile } from './compare.js';
export { createLogEntry, applyHumanDecision, applyResult } from './ledger.js';
export { SocleStore } from './store.js';
export { buildDormantInventorySubject, inventoryLevers } from './domains/dormant-inventory.js';
export { buildCashFloorRiskSubject, cashLevers } from './domains/cash-floor-risk.js';
export { buildFootfallDeclineSubject, footfallLevers } from './domains/footfall-decline.js';
