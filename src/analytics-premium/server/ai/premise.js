// False-premise detection. A question often takes something for granted ("why did my sales DROP?"). The provider states that assumption as a STRUCTURED
// premise (never as text to match), and Nordla checks it against its own tools BEFORE any analysis is built on it:
//
//   premise (trend | ranking | level)  ->  evidence from the Tool Layer  ->  supported | contradicted | unknown
//
//   contradicted -> Nordla corrects the premise with the facts and produces no causal hypothesis about it (no analysis, no explanation request);
//   unknown      -> Nordla says it cannot verify the statement with the data it has;
//   supported    -> the analysis goes on normally.
//
// Nothing here matches user wording: the mapping is metric key -> (tool, fact key), and the verdict comes from comparing engine figures.

import { validate } from '../tools/contract.js';

/** metric -> the tool that holds it and the fact key inside that tool's result (the engine's own figure). */
export const PREMISE_METRICS = {
  sales: { tool: 'get_sales_metrics', key: 'net_sales_ex_tax' },
  orders: { tool: 'get_sales_metrics', key: 'order_count' },
  units: { tool: 'get_sales_metrics', key: 'units_sold' },
  aov: { tool: 'get_sales_metrics', key: 'aov_ex_tax' },
  refunds: { tool: 'get_refunds', key: 'refunds_total' },
  discounts: { tool: 'get_discounts', key: 'discounts' },
  vat: { tool: 'get_vat', key: 'vat_total' },
  shipping: { tool: 'get_shipping', key: 'shipping_net_ex_tax' },
};
export const PREMISE_KINDS = ['trend', 'ranking', 'level'];
export const MAX_PREMISES = 2;

const PERIOD_ARG = { type: 'object' };
/** The premise as the provider states it. Kind-specific requirements are checked by `premiseProblem`. */
export const PREMISE_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['kind'],
  properties: {
    kind: { type: 'string', enum: PREMISE_KINDS },
    metric: { type: 'string', enum: Object.keys(PREMISE_METRICS) },
    direction: { type: 'string', enum: ['increase', 'decrease'] },       // trend: what the question says happened
    level: { type: 'string', enum: ['zero'] },                            // level: what the question says the value is
    scope: { type: 'string', enum: ['product', 'channel', 'category'] },  // ranking: what is said to be the best
    subject: { type: 'string', minLength: 1, maxLength: 80 },             // ranking: the thing said to be the best
    period: PERIOD_ARG,
  },
};

/** null when the premise is well formed for its kind, else a reason. */
export function premiseProblem(p) {
  const shape = validate(PREMISE_SCHEMA, p, 'premise'); if (shape) return shape;
  if (p.kind === 'trend' && !(p.metric && p.direction)) return 'a trend premise needs metric and direction';
  if (p.kind === 'level' && !(p.metric && p.level)) return 'a level premise needs metric and level';
  if (p.kind === 'ranking' && !(p.scope && p.subject)) return 'a ranking premise needs scope and subject';
  return null;
}

const norm = (x) => String(x ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const sign = (n) => (n > 0 ? 'increase' : n < 0 ? 'decrease' : 'unchanged');

/**
 * @param {{ premise, run: (tool, args) => Promise<{result, id: string}|null>, periodArg: object|undefined }} ctx
 *   `run` executes (or re-uses) a tool call and returns null when the call budget is used up.
 * @returns {{ kind, metric?, direction?, level?, scope?, subject?, verdict: 'supported'|'contradicted'|'unknown', reason?: string, actual?: object, callIds: string[] }}
 */
export async function checkPremise({ premise, run, periodArg }) {
  const out = { kind: premise.kind, ...(premise.metric ? { metric: premise.metric } : {}), ...(premise.direction ? { direction: premise.direction } : {}), ...(premise.level ? { level: premise.level } : {}), ...(premise.scope ? { scope: premise.scope } : {}), ...(premise.subject ? { subject: premise.subject } : {}), callIds: [] };
  const base = periodArg ? { period: periodArg } : {};
  const call = async (tool, args) => { const r = await run(tool, args); if (r) out.callIds.push(r.id); return r; };
  const unknown = (reason) => ({ ...out, verdict: 'unknown', reason });

  if (premise.kind === 'trend') {
    const m = PREMISE_METRICS[premise.metric];
    const s1 = await call('get_sales_metrics', base); if (!s1) return unknown('CALL_BUDGET');
    if (!s1.result.ok) return unknown(s1.result.error.code);
    let row = null;
    if (m.tool === 'get_sales_metrics') row = s1.result.comparison?.rows.find((r) => r.key === m.key) ?? null;
    else {
      const ref = s1.result.comparison?.reference;
      if (ref) { const s2 = await call(m.tool, { ...base, compareTo: { period: 'custom', from: ref.from, to: ref.to } }); if (!s2) return unknown('CALL_BUDGET'); row = s2.result.ok ? s2.result.comparison?.rows.find((r) => r.key === m.key) ?? null : null; }
    }
    if (!row || row.delta_abs == null) return unknown('COMPARISON_UNAVAILABLE');
    const actual = sign(row.delta_abs);
    return { ...out, verdict: actual === premise.direction ? 'supported' : 'contradicted', actual: { direction: actual, delta_pct: row.delta_pct, delta_abs: row.delta_abs, current: row.current, previous: row.previous, unit: row.unit, reference: s1.result.comparison.reference } };
  }

  if (premise.kind === 'level') {
    const m = PREMISE_METRICS[premise.metric];
    const r = await call(m.tool, base); if (!r) return unknown('CALL_BUDGET');
    if (!r.result.ok) return unknown(r.result.error.code);
    const v = r.result.values.find((x) => x.key === m.key);
    if (!v || v.value == null) return unknown('VALUE_UNAVAILABLE');
    return { ...out, verdict: v.value === 0 ? 'supported' : 'contradicted', actual: { value: v.value, unit: v.unit } };
  }

  // ranking: is `subject` the best product / channel / category of the period?
  if (premise.scope === 'product') {
    const top = await call('get_top_products', { ...base, limit: 1 }); if (!top) return unknown('CALL_BUDGET');
    const found = await call('find_product', { ...base, query: premise.subject }); if (!found) return unknown('CALL_BUDGET');
    if (!found.result.ok) return unknown(found.result.reason ?? found.result.error.code);      // the subject is not a product Nordla knows
    if (!top.result.ok) return unknown(top.result.error.code);
    const best = top.result.items[0];
    return { ...out, verdict: found.result.items.some((i) => i.ref === best.ref) ? 'supported' : 'contradicted', actual: { top: best.label } };
  }
  const list = await call(premise.scope === 'channel' ? 'get_channels' : 'get_categories', base); if (!list) return unknown('CALL_BUDGET');
  if (!list.result.ok) return unknown(list.result.error.code);
  const best = list.result.items[0];
  if (best.label == null) return unknown('LABEL_UNAVAILABLE');
  const words = norm(premise.subject).split(' ').filter(Boolean); const top = norm(best.label);
  return { ...out, verdict: words.length && words.every((w) => top.includes(w)) ? 'supported' : 'contradicted', actual: { top: best.label } };
}
