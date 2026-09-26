// Structural validation of cases.json: the exact distribution requested (30 cases), languages, allowed values. Pure, no provider.

import { KNOWN_GAPS } from '../../../src/analytics-premium/server/ai/contract.js';
import { premiseProblem } from '../../../src/analytics-premium/server/ai/premise.js';

export const CATEGORIES = { simple: 4, quantitative: 4, multi_tool: 4, premise: 6, clarification: 3, conversation: 3, refusal: 3, trap: 3 };
export const LANGUAGES = { fr: 24, nl: 3, en: 3 };
export const STATUSES = ['OK', 'CLARIFICATION', 'CANNOT_ANSWER', 'PREMISE_CONTRADICTED', 'PREMISE_UNVERIFIABLE', 'FACTS_ONLY'];
export const TOOL_NAMES = ['get_sales_metrics', 'compare_sales', 'get_top_products', 'get_product_metrics', 'get_customers', 'get_customer_metrics', 'get_channels', 'get_categories', 'get_discounts', 'get_refunds', 'get_shipping', 'get_vat', 'find_product'];
const QUANTITY_KINDS = ['money', 'count', 'percent', 'days', 'date'];
const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** @returns {string[]} the problems found (empty = valid) */
export function validateCases(cases) {
  const errors = []; const err = (id, msg) => errors.push(`${id}: ${msg}`);
  if (!Array.isArray(cases)) return ['cases must be an array'];
  const ids = new Set(); const cat = {}; const lang = {};
  for (const c of cases) {
    const id = c.id ?? '(no id)';
    if (!/^[A-Z]\d{2}$/.test(c.id ?? '')) err(id, 'id must look like S01'); if (ids.has(c.id)) err(id, 'duplicate id'); ids.add(c.id);
    if (!(c.category in CATEGORIES)) err(id, `unknown category ${c.category}`); cat[c.category] = (cat[c.category] ?? 0) + 1;
    if (!(c.language in LANGUAGES)) err(id, `unknown language ${c.language}`); lang[c.language] = (lang[c.language] ?? 0) + 1;
    if (typeof c.notes !== 'string' || c.notes.length < 10) err(id, 'notes required');
    if (c.selectedPeriod !== null && typeof c.selectedPeriod?.period !== 'string') err(id, 'selectedPeriod must be null or {period}');
    if (!Array.isArray(c.turns) || c.turns.length < 1 || c.turns.length > 3) { err(id, 'turns: 1 to 3'); continue; }
    c.turns.forEach((t, i) => { if (typeof t.user !== 'string' || t.user.length < 3) err(id, `turn ${i + 1} needs a user text`); if (t.expected && t.expected.status?.some((s) => !STATUSES.includes(s))) err(id, `turn ${i + 1}: bad status`); });
    if (c.turns.slice(0, -1).some((t) => !t.expected?.status)) err(id, 'every non-final turn needs expected.status');
    if (c.category === 'conversation' && c.turns.length < 2) err(id, 'a conversation case needs 2 or 3 turns'); if (c.category !== 'conversation' && c.turns.length > 1) err(id, 'only conversation cases are multi-turn');
    const e = c.expected; if (!e) { err(id, 'expected missing'); continue; }
    for (const k of ['premises', 'verdict', 'status', 'clarification', 'tools', 'periods', 'gaps', 'limitations', 'caveats', 'quantities', 'forbiddenQuantities', 'labels', 'hypotheses', 'privacy', 'unknownToolCalls', 'honestRefusal']) if (!(k in e)) err(id, `expected.${k} missing`);
    if (!Array.isArray(e.status) || !e.status.length || e.status.some((s) => !STATUSES.includes(s))) err(id, 'expected.status must be a non-empty list of known statuses');
    for (const p of e.premises ?? []) { const problem = premiseProblem({ ...p, ...(p.kind === 'ranking' ? { subject: p.subject ?? 'x' } : {}) }); if (problem) err(id, `premise: ${problem}`); }
    if (![null, 'supported', 'contradicted', 'unknown'].includes(e.verdict)) err(id, 'bad verdict'); if ((e.premises?.length ?? 0) > 0 && e.verdict === null) err(id, 'a case with an expected premise needs an expected verdict');
    const t = e.tools ?? {};
    for (const n of [...(t.required ?? []).flatMap((x) => x.split('|')), ...(t.forbidden ?? []).filter((x) => x !== '*')]) if (!TOOL_NAMES.includes(n)) err(id, `unknown tool ${n}`);
    if (!Number.isInteger(t.minDistinct) || t.minDistinct < 0) err(id, 'tools.minDistinct');
    for (const p of e.periods ?? []) if (!DATE.test(p.from) || !DATE.test(p.to) || p.from > p.to) err(id, `bad period ${JSON.stringify(p)}`);
    for (const g of e.gaps ?? []) if (!KNOWN_GAPS.includes(g)) err(id, `unknown gap ${g}`);
    for (const q of e.quantities ?? []) { if (!QUANTITY_KINDS.includes(q.kind) || q.value === undefined || !q.source?.tool || !q.source?.path) err(id, `bad quantity ${JSON.stringify(q).slice(0, 60)}`); if (q.source?.tool && !TOOL_NAMES.includes(q.source.tool)) err(id, `unknown source tool ${q.source.tool}`); }
    for (const q of e.forbiddenQuantities ?? []) if (!QUANTITY_KINDS.includes(q.kind) || typeof q.value !== 'number') err(id, 'bad forbiddenQuantity');
    if (!['none', 'allowed'].includes(e.hypotheses)) err(id, 'hypotheses: none | allowed');
    if (!Array.isArray(e.privacy?.mustNotReachProvider)) err(id, 'privacy.mustNotReachProvider'); if (typeof e.clarification !== 'boolean') err(id, 'clarification must be a boolean');
    if (e.clarification && !e.status.includes('CLARIFICATION')) err(id, 'clarification:true needs status CLARIFICATION');
  }
  for (const [k, n] of Object.entries(CATEGORIES)) if ((cat[k] ?? 0) !== n) errors.push(`category ${k}: ${cat[k] ?? 0} cases, expected ${n}`);
  for (const [k, n] of Object.entries(LANGUAGES)) if ((lang[k] ?? 0) !== n) errors.push(`language ${k}: ${lang[k] ?? 0} cases, expected ${n}`);
  if (cases.length !== 30) errors.push(`${cases.length} cases, expected exactly 30`);
  return errors;
}
