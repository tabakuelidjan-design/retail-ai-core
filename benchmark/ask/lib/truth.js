// The pinned truth of the benchmark. Every expected quantity of cases.json names its SOURCE (a Nordla tool call + a path in its result) and a pinned value.
// `verifyTruth` resolves each source with the real Tool Layer over the fixed dataset and compares: if the data or the engine ever drifts, the benchmark says so
// instead of silently scoring against stale expectations.

const round2 = (x) => Math.round((x + Number.EPSILON) * 100) / 100;

/** What a raw engine value looks like in an answer, per quantity kind (percent: ratio -> percentage points, 2 decimals). */
export function displayValue(kind, raw) {
  if (kind === 'percent') return Math.round(raw * 10000) / 100;
  if (kind === 'money') return round2(raw);
  return raw;
}

/** path: values.<key> | period.<from|to|days> | comparison.<key>.<field> | items.<i>.<key|label> */
export async function resolveSource(tools, { tool, args, path }) {
  const r = await tools.call(tool, args);
  if (!r.ok) throw new Error(`source ${tool} failed: ${r.error.code}`);
  const [head, a, b] = path.split('.');
  if (head === 'values') return r.values.find((v) => v.key === a)?.value;
  if (head === 'period') return r.period[a];
  if (head === 'comparison') return r.comparison?.rows.find((x) => x.key === a)?.[b];
  if (head === 'items') { const item = r.items?.[Number(a)]; return b === 'label' ? item?.label : item?.values.find((v) => v.key === b)?.value; }
  throw new Error(`unknown path ${path}`);
}

/** @returns {Promise<{ checked: number, drift: {caseId, kind, pinned, actual}[] }>} */
export async function verifyTruth(cases, tools) {
  const drift = []; let checked = 0;
  for (const c of cases) {
    for (const q of c.expected.quantities ?? []) {
      checked += 1;
      const raw = await resolveSource(tools, q.source);
      const actual = displayValue(q.kind, raw);
      if (actual !== q.value) drift.push({ caseId: c.id, kind: q.kind, pinned: q.value, actual });
    }
  }
  return { checked, drift };
}
