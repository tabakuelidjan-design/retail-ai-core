// Persists detected data-quality flags idempotently into data_quality_flags.
// - A condition already open (or deliberately ignored by a human) is never duplicated.
// - A previously open flag whose condition no longer holds is marked resolved, not deleted.
// - A resolved flag whose condition returns is opened again as a new row.

import { RULE_CODES } from './rules.js';

const keyOf = (f) => `${f.rule_code}|${f.entity_type}|${f.entity_id}`;

export async function syncQualityFlags({ supabase }, { merchantId, detected, now, evaluatedRules = RULE_CODES }) {
  const existing = await supabase.selectAll('data_quality_flags', { merchant_id: `eq.${merchantId}` });
  const blocking = new Map();
  for (const row of existing) {
    if (row.status === 'open' || row.status === 'ignored') blocking.set(keyOf(row), row);
  }

  const detectedKeys = new Set(detected.map(keyOf));
  const toCreate = detected.filter((f) => !blocking.has(keyOf(f)));
  const summary = { created: 0, alreadyOpen: 0, keptIgnored: 0, resolved: 0, byRule: {} };

  for (const f of detected) {
    const row = blocking.get(keyOf(f));
    if (row?.status === 'open') summary.alreadyOpen += 1;
    if (row?.status === 'ignored') summary.keptIgnored += 1;
  }

  if (toCreate.length > 0) {
    await supabase.insert('data_quality_flags', toCreate.map((f) => ({
      merchant_id: merchantId, entity_type: f.entity_type, entity_id: f.entity_id, rule_code: f.rule_code,
      severity: f.severity, status: 'open', detected_at: now.toISOString(), details: f.details,
    })));
    summary.created = toCreate.length;
  }

  for (const row of blocking.values()) {
    if (row.status !== 'open' || !evaluatedRules.includes(row.rule_code) || detectedKeys.has(keyOf(row))) continue;
    await supabase.update('data_quality_flags', { id: `eq.${row.id}` }, { status: 'resolved', resolved_at: now.toISOString() });
    summary.resolved += 1;
  }

  for (const f of detected) summary.byRule[f.rule_code] = (summary.byRule[f.rule_code] ?? 0) + 1;
  return summary;
}
