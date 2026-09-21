// Channel classification. Rules are CONFIGURATION (config.marketing.taxonomy), applied in a fixed
// precedence; every result names the rule that fired and what kind of evidence it rests on.
// Nothing here knows any platform: adapters hand over neutral fields.

const lc = (v) => (v == null ? null : String(v).trim().toLowerCase() || null);
const hostMatches = (value, patterns) => {
  const v = lc(value);
  return v !== null && patterns.some((p) => v.includes(p));
};

export const CHANNELS = ['pos', 'other_channel', 'unattributed', 'paid_search', 'paid_social', 'paid_display', 'affiliate', 'email', 'organic_search', 'organic_social', 'ai_assistant', 'referral', 'direct', 'campaign_unclassified', 'unknown'];

/**
 * @param {{channel_handle: string|null, source_name: string|null}} order
 * @param {{first_visit?: object, last_visit?: object}} touches
 * @returns {{channel: string, sub_channel: string|null, rule: string, evidence_kind: string, touch: string|null, campaign: string|null, issues: string[]}}
 */
export function classifyOrder(order, touches, cfg) {
  const m = cfg.marketing;
  const t = m.taxonomy;
  const handle = lc(order.channel_handle) ?? lc(order.source_name);
  const base = { sub_channel: null, touch: null, campaign: null, issues: [] };

  if (handle && m.posChannelHandles.includes(handle)) {
    const issues = touches?.last_visit ? ['POS_ORDER_HAS_VISIT_DATA'] : [];
    return { ...base, channel: 'pos', rule: 'order_channel:pos', evidence_kind: 'observed', issues };
  }
  if (handle && !m.onlineChannelHandles.includes(handle)) {
    return { ...base, channel: 'other_channel', sub_channel: handle, rule: 'order_channel:other', evidence_kind: 'observed' };
  }
  const visit = touches?.last_visit;
  if (!visit) return { ...base, channel: 'unattributed', rule: 'no_recorded_visit', evidence_kind: 'unavailable' };

  const medium = lc(visit.utm_medium);
  const utmSource = lc(visit.utm_source);
  const source = lc(visit.source);
  const host = lc(visit.referrer_host);
  const campaign = visit.utm_campaign ? String(visit.utm_campaign).trim() : null;
  const issues = [];
  if (utmSource && (!medium || !campaign)) issues.push('UTM_INCOMPLETE');
  const out = (channel, rule, evidence_kind, sub = null) => ({ channel, sub_channel: sub, rule, evidence_kind, touch: 'last_visit', campaign, issues });

  if (medium && t.mediumMap[medium]) {
    const ch = t.mediumMap[medium];
    const contradicts = ch.startsWith('paid_') && lc(visit.source_type) === 'seo';
    return { ...out(ch, 'utm_medium', 'attributed', medium), issues: contradicts ? [...issues, 'PAID_MEDIUM_BUT_SEO_SOURCE_TYPE'] : issues };
  }
  const st = visit.source_type ? t.sourceTypeMap[String(visit.source_type).toUpperCase()] : null;
  if (st) return out(st, 'source_type', 'attributed', source);
  const labels = [utmSource, source, host];
  if (labels.some((l) => hostMatches(l, t.aiAssistantHosts))) return out('ai_assistant', 'ai_assistant_host_list', 'inferred', utmSource ?? source ?? host);
  if (labels.some((l) => hostMatches(l, t.searchHosts))) return out('organic_search', 'search_host_list', 'inferred', utmSource ?? source ?? host);
  if (labels.some((l) => hostMatches(l, t.socialHosts))) return out('organic_social', 'social_host_list', 'inferred', utmSource ?? source ?? host);
  if (host && m.ownHosts.some((o) => host === lc(o) || host.endsWith(`.${lc(o)}`))) return out('direct', 'own_host_referrer', 'inferred', 'internal');
  if (source === 'direct' || (!utmSource && !source && !host)) return out('direct', 'recorded_direct', 'attributed');
  if (utmSource || medium || campaign) return out('campaign_unclassified', 'tagged_but_unmapped', 'inferred', utmSource ?? medium);
  if (host) return out('referral', 'referrer_host', 'inferred', host);
  return out('unknown', 'no_rule_matched', 'unavailable');
}

/** A rule matches a lower-cased, trimmed query. Rules are explicit merchant data: { type: 'contains' | 'equals' | 'starts_with', value }. */
export function matchesRule(query, rule) {
  const q = lc(query);
  const v = lc(rule?.value);
  if (!q || !v) return false;
  if (rule.type === 'equals') return q === v;
  if (rule.type === 'starts_with') return q.startsWith(v);
  return q.includes(v);
}

/** Only an explicit merchant rule can call a search query branded; without rules everything is 'unclassified'. */
export function classifyQuery(query, brandRules) {
  if (!brandRules || brandRules.length === 0) return 'unclassified';
  return brandRules.some((r) => matchesRule(query, r)) ? 'branded' : 'non_branded';
}

/**
 * Intent exists only through explicit rules (no model, no guessing). A query can match several intents;
 * `intent` is the first match in the configured precedence order, or 'unclassified' when no rule matches
 * (or none are configured - then `configured` is false and the intent split is gated).
 */
export function classifyIntent(query, searchCfg) {
  const rules = searchCfg.intentRules ?? {};
  const configured = Object.values(rules).some((r) => Array.isArray(r) && r.length > 0);
  const intents = Object.keys(rules).filter((k) => (rules[k] ?? []).some((r) => matchesRule(query, r)));
  const intent = (searchCfg.intentPrecedence ?? Object.keys(rules)).find((k) => intents.includes(k)) ?? 'unclassified';
  return { intents, intent, configured };
}
