import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  activationCategoryOf, BRAIN_CAUSE_MAP, CREATIVE_ACTIONS, CREATIVE_CODE_TABLE, CREATIVE_DEPENDENCIES, CREATIVE_POLICY, financeCategoryOf, FINANCE_POLICY, RUNTIME_CAUSE_MAP,
} from './adapters/index.js';
import { ACT_ERROR, PROVIDER_ERROR } from '../activation/constants.js';
import { CORE_CODE_TABLE } from './core-codes.js';
import {
  authorizedActions, CORE_POLICY, DEFAULT_LIMITS, FORBIDDEN, RECOVERY_ACTION, TERMINAL_ACTIONS, TERMINAL_STATE,
} from './recovery.js';
import { CATEGORY_DEFAULTS, CATEGORIES } from './taxonomy.js';
import { PROTOCOL_SUBCODE } from './structured-output.js';
import { PROVIDER_SUBCODE } from './provider.js';

// THE MACHINE-READABLE RECOVERY MATRIX: generated from the real policy, never edited by hand (a test fails when the committed file is not what this produces).

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function* sourceFiles(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* sourceFiles(full); else if (entry.name.endsWith('.js')) yield full;
  }
}

/** Every FinanceError code the finance source can raise (read from the source, so a new code cannot escape the mapping unnoticed). */
export function financeCodesInSource(root = ROOT) {
  const codes = new Set();
  for (const file of sourceFiles(path.join(root, 'src', 'finance'))) for (const m of readFileSync(file, 'utf8').matchAll(/new FinanceError\('([A-Z_]+)'/g)) codes.add(m[1]);
  return [...codes].sort();
}

const sorted = (o) => Object.fromEntries(Object.entries(o).sort(([a], [b]) => (a < b ? -1 : 1)));

export function buildRecoveryMatrix(root = ROOT) {
  const categories = {};
  for (const category of CATEGORIES) {
    categories[category] = {
      recoverable_default: CATEGORY_DEFAULTS[category].recoverable,
      core_authorized_actions: [...CORE_POLICY[category]],
      never_allowed_even_by_a_module: [...(FORBIDDEN[category] ?? [])],
      effective: { creative: authorizedActions(category, CREATIVE_POLICY), finance: authorizedActions(category, FINANCE_POLICY) },
    };
  }
  return {
    schema: 'nordla-core-resilience-matrix@1',
    categories,
    recovery_actions: Object.values(RECOVERY_ACTION),
    terminal_actions: [...TERMINAL_ACTIONS],
    terminal_states: Object.values(TERMINAL_STATE),
    default_recovery_limits: Object.fromEntries(Object.entries(DEFAULT_LIMITS).map(([k, v]) => [k, v === Infinity ? 'UNLIMITED' : v])),
    protocol_subcodes: sorted(Object.fromEntries(Object.entries(PROTOCOL_SUBCODE).map(([k, v]) => [k, { reask: v.reask, normalize: v.normalize }]))),
    provider_subcodes: sorted(Object.fromEntries(Object.entries(PROVIDER_SUBCODE).map(([k, v]) => [k, { transient: v.transient }]))),
    core_code_table: sorted(Object.fromEntries(Object.entries(CORE_CODE_TABLE).map(([k, v]) => [k, v.category]))),
    modules: {
      creative: {
        contract_codes: sorted(Object.fromEntries(Object.entries(CREATIVE_CODE_TABLE).map(([k, v]) => [k, v.category]))),
        brain_causes: sorted({ ...BRAIN_CAUSE_MAP }),
        runtime_causes: sorted({ ...RUNTIME_CAUSE_MAP }),
        domain_actions: Object.fromEntries(Object.entries(CREATIVE_ACTIONS).map(([k, v]) => [k, { core: v.core, scope: v.scope }])),
        dependencies: CREATIVE_DEPENDENCIES.stages.map((s) => ({ stage: s.name, reads: [...s.reads] })),
      },
      finance: { codes: sorted(Object.fromEntries(financeCodesInSource(root).map((c) => [c, financeCategoryOf(c)]))) },
      activation: { codes: sorted(Object.fromEntries([...Object.values(PROVIDER_ERROR), ...Object.values(ACT_ERROR)].map((c) => [c, activationCategoryOf(c)]))) },
    },
  };
}
