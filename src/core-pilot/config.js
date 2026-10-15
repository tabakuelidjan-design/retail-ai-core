// The merchant's Core decision configuration is DATA (config/merchants/<id>/core-decision.json), never code: the generic Core knows no
// merchant by name. Without it the Core says CORE_NOT_CONFIGURED and decides nothing (no hidden default threshold or owner rule).
//   { schema: 1, merchantId, currency: 'EUR', gates: { materialityThreshold, maxPrioritySubjects, cooldownDays, aggravationFactor },
//     testSmall?: { budget: number|null, time_to_effect_days?: number|null }, ownerRules: [ Socle rules: MAX_BUDGET, MIN_CASH, ... ] }
// ownerRules may be empty: the answer then says plainly that no owner constraint is configured (every option still needs a human).
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { assertGateConfig } from '../socle-decision/gates.js';
import { createRuleSet } from '../socle-decision/rules.js';

const ID = /^[a-z0-9][a-z0-9_-]{0,40}$/;

export function validateCoreConfig(c) {
  if (!c || c.schema !== 1 || typeof c.merchantId !== 'string') throw new Error('core-decision: schema 1 and merchantId are required');
  if (!/^[A-Z]{3}$/.test(String(c.currency ?? ''))) throw new Error('core-decision: currency (ISO 4217) is required');
  assertGateConfig({ ...c.gates, currency: c.currency });
  if (!Array.isArray(c.ownerRules)) throw new Error('core-decision: ownerRules must be a list (may be empty)');
  createRuleSet('validation', c.ownerRules); // every rule must be valid
  if (c.testSmall && c.testSmall.budget !== null && !Number.isFinite(c.testSmall.budget)) throw new Error('core-decision: testSmall.budget must be a number or null');
  return c;
}

/** @returns {{ config: object|null, path: string|null, error?: string }} */
export async function loadCoreConfig(env = {}, root = process.cwd()) {
  const file = String(env.NORDLA_CORE_CONFIG ?? '').trim(); const id = String(env.SOURCING_MERCHANT_ID ?? '').trim();
  const path = file ? resolve(file) : ID.test(id) ? join(root, 'config', 'merchants', id, 'core-decision.json') : null;
  if (!path) return { config: null, path: null, error: 'no merchant chosen (SOURCING_MERCHANT_ID or NORDLA_CORE_CONFIG)' };
  try { return { config: validateCoreConfig(JSON.parse(await readFile(path, 'utf8'))), path }; }
  catch (e) { return { config: null, path, error: e.code === 'ENOENT' ? 'core-decision.json not found' : e.message }; }
}
