// Turns tool results into the FACT store: every value the provider may talk about gets a stable reference, and only those references can justify a claim.
//
//   c1.period.from / .to / .days            the period of call c1
//   c1.values.<key>                         a scalar of the result (net_sales_ex_tax, order_count, ...)
//   c1.comparison.<key>.current|previous|delta_abs|delta_pct   the comparison rows; c1.comparison.reference.from|to
//   c1.items.<i>.label                      the i-th item's label (a product title, a pseudonymous "#A4B7", a channel...)
//   c1.items.<i>.<key>                      its figures
//
// The provider payload is built here, from these facts only, and passed through the privacy sanitizer once more (defence in depth: the tools already
// sanitize their results).

import { sanitize } from '../tools/contract.js';

const CURRENCY = /^[A-Z]{3}$/;

// How serious each limitation is for the reader, and which figures of its detail the message needs (aggregates only). The wording lives in the UI dictionary.
const SEVERITY = { PERIOD_INCLUDES_TODAY: 'info', PRODUCT_PARTIAL: 'info' };
function paramsOf(reason) {
  const d = reason.detail; const p = {};
  if (reason.code === 'PERIOD_STARTS_BEFORE_HISTORY') p.historyStart = d?.historyStart ?? null;
  if (reason.code === 'COMPARISON_HISTORY_INSUFFICIENT') p.historyStart = d?.history_start ?? null;
  if (reason.code === 'COSTS_PARTIAL') p.costCoverage = d?.costCoverage ?? null;
  if (reason.code === 'CUSTOMERS_PARTIALLY_IDENTIFIED') p.identifiedShare = d?.identifiedShare ?? null;
  return p;
}

/** @returns {{ list: object[], byRef: Map<string, object>, calls: object[], notices: object[] }} */
export function buildFacts(callResults) {
  const list = []; const calls = []; const notices = [];
  const add = (callId, tool, ref, value, unit, description) => { if (value === null || value === undefined) return; list.push({ ref, value, unit, callId, tool, description }); };
  callResults.forEach((entry, idx) => {
    const id = `c${idx + 1}`; const r = entry.result;
    if (!r.ok) {
      calls.push({ id, tool: entry.tool, args: entry.args, ok: false, errorCode: r.error.code });
      notices.push({ callId: id, tool: entry.tool, code: r.error.code, severity: 'blocking', params: { ...(r.historyStart ? { historyStart: r.historyStart } : {}), ...(r.reason ? { reason: r.reason } : {}) } });
      return;
    }
    const where = `${r.tool} ${r.period.from}..${r.period.to}`;
    add(id, r.tool, `${id}.period.from`, r.period.from, 'date', `${where}: period start`);
    add(id, r.tool, `${id}.period.to`, r.period.to, 'date', `${where}: period end`);
    add(id, r.tool, `${id}.period.days`, r.period.days, 'days', `${where}: number of days`);
    for (const v of r.values) add(id, r.tool, `${id}.values.${v.key}`, v.value, v.unit, `${where}: ${v.key}`);
    if (r.comparison) {
      const c = r.comparison;
      add(id, r.tool, `${id}.comparison.reference.from`, c.reference?.from, 'date', `${where}: reference period start`);
      add(id, r.tool, `${id}.comparison.reference.to`, c.reference?.to, 'date', `${where}: reference period end`);
      for (const row of c.rows ?? []) {
        add(id, r.tool, `${id}.comparison.${row.key}.current`, row.current, row.unit, `${where}: ${row.key}, current period`);
        add(id, r.tool, `${id}.comparison.${row.key}.previous`, row.previous, row.unit, `${where}: ${row.key}, reference period`);
        add(id, r.tool, `${id}.comparison.${row.key}.delta_abs`, row.delta_abs, row.unit, `${where}: ${row.key}, absolute change`);
        add(id, r.tool, `${id}.comparison.${row.key}.delta_pct`, row.delta_pct, 'ratio', `${where}: ${row.key}, relative change (ratio)`);
      }
    }
    (r.items ?? []).forEach((item, i) => {
      add(id, r.tool, `${id}.items.${i}.label`, item.label, 'text', `${where}: item ${i + 1} label`);
      for (const v of item.values ?? []) add(id, r.tool, `${id}.items.${i}.${v.key}`, v.value, v.unit, `${where}: item ${i + 1} (${item.label ?? 'no label'}) ${v.key}`);
    });
    calls.push({ id, tool: r.tool, args: entry.args, ok: true, period: r.period, completeness: { status: r.completeness.status, reasons: r.completeness.reasons.map((x) => x.code), missing: r.completeness.missing }, freshness: { dataAsOf: r.freshness.dataAsOf, stale: r.freshness.stale } });
    for (const reason of r.completeness.reasons) notices.push({ callId: id, tool: r.tool, code: reason.code, severity: SEVERITY[reason.code] ?? 'warning', params: paramsOf(reason), ...(reason.affects ? { affects: reason.affects } : {}) });
    for (const m of r.completeness.missing) notices.push({ callId: id, tool: r.tool, code: 'VALUE_MISSING', severity: 'warning', params: { metric: m }, affects: [m] });
    if (r.freshness.stale) notices.push({ callId: id, tool: r.tool, code: 'DATA_STALE', severity: 'warning', params: { ageMinutes: r.freshness.ageMinutes } });
  });
  return { list, byRef: new Map(list.map((f) => [f.ref, f])), calls, notices };
}

/** What `explain` receives: facts and call summaries, sanitized. Never anything else. */
export function explainPayload({ question, lang, facts, rules }) {
  const { value } = sanitize({
    question, lang,
    facts: facts.list.map((f) => ({ ref: f.ref, value: f.value, unit: f.unit, description: f.description })),
    calls: facts.calls, rules,
  });
  return value;
}

/** Every date the answer may mention: dates that are facts. Used by the verifier for dates written with month names. */
export const dateFacts = (facts) => facts.list.filter((f) => f.unit === 'date' && typeof f.value === 'string').map((f) => f.value);

export const isCurrency = (unit) => CURRENCY.test(unit ?? '');

/** For each fact reference: the limitations that affect it (a limitation lists the metrics it affects), so a claim quoting an affected figure carries the caveat. */
export function caveatsFor(refs, notices) {
  const codes = new Set();
  for (const ref of refs) {
    const m = ref.match(/^(c\d+)\.(?:values|items\.\d+)\.(.+)$/); if (!m) continue;
    for (const n of notices) if (n.callId === m[1] && n.affects?.includes(m[2])) codes.add(n.code);
  }
  return [...codes];
}
