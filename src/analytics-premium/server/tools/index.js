// Nordla Tool Layer entry point. Provider-neutral: it knows nothing about any AI provider.
//
//   const tools = createToolLayer({ reportsDir });
//   tools.catalog()                    -> [{ name, description, inputSchema }]   what a planner may choose from (JSON Schema, no code, no data)
//   await tools.call(name, args)       -> the common result contract (contract.js), validated and privacy-sanitized
//
// Phase 2 plugs the AI provider on top:  provider.plan(question, catalog) -> tool calls -> tools.call(...) -> facts -> provider.explain(facts).

import { ANALYTICS_TOOLS } from './analytics-tools.js';
import { EXTRA_ANALYTICS_TOOLS } from './analytics-tools-extra.js';
import { PRIVACY, fail, freshnessOf, sanitize, validate } from './contract.js';

export const MAX_TOOL_CALLS_PER_QUESTION = 4;

export function createToolLayer({ reportsDir, now = () => new Date(), staleAfterMinutes = 180, tools = [...ANALYTICS_TOOLS, ...EXTRA_ANALYTICS_TOOLS] } = {}) {
  const byName = new Map(tools.map((t) => [t.name, t]));
  return {
    catalog: () => tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
    has: (name) => byName.has(name),
    async call(name, args = {}) {
      const tool = byName.get(name);
      if (!tool) return fail(String(name), args, 'UNKNOWN_TOOL', 'This tool does not exist.');
      const problem = validate(tool.inputSchema, args ?? {});
      if (problem) return fail(name, args, 'INVALID_ARGUMENT', problem);
      const at = now();
      const ctx = { reportsDir, now: at, freshness: (generatedAt, includesToday) => freshnessOf(generatedAt, { now: at, staleAfterMinutes, includesToday }) };
      let result;
      try { result = await tool.run(ctx, args ?? {}); } catch (e) { return fail(name, args, 'INTERNAL_ERROR', 'The tool failed.'); }
      const { value, redactions } = sanitize(result);
      return { ...value, privacy: PRIVACY(redactions) };
    },
  };
}
