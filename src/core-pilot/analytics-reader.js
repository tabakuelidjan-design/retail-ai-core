// READ-ONLY Analytics facts for Nordla Core and Parle à Nordla, through Analytics' own Tool Layer (src/analytics-premium/server/tools):
// the same deterministic engines, the same period rules, the same freshness and completeness flags, the same privacy sanitizing.
// No figure is computed here. "Why" is answered with FACTS only (which products / channels moved, by how much); a cause is never stated
// as a fact: what Analytics does not hold (traffic, advertising spend, ...) is listed as unknown, and any explanation is a hypothesis.
import { createToolLayer } from '../analytics-premium/server/tools/index.js';
import { KNOWN_GAPS } from '../analytics-premium/server/ai/contract.js';

/**
 * @param {{ reportsDir: string, now?: () => Date, source: string, staleAfterMinutes?: number }} o
 *   reportsDir = an Analytics reports directory (dataset.json written by Analytics' own report run, stamped with the merchant)
 */
export function createAnalyticsReader({ reportsDir, now = () => new Date(), source, staleAfterMinutes = 180 }) {
  const tools = createToolLayer({ reportsDir, now, staleAfterMinutes });
  const period = (p) => ({ period: p });

  /** Sales of a period vs the previous period of the same length, plus the products that grew / declined most and the channels. */
  async function salesEvolution({ periodKey = 'last_30_days' } = {}) {
    const metrics = await tools.call('get_sales_metrics', { period: period(periodKey) });
    if (!metrics.ok) return { ok: false, source, error: metrics.error?.code ?? 'DATA_UNAVAILABLE' };
    const [growth, decline, channels] = await Promise.all([
      tools.call('get_top_products', { period: period(periodKey), sort: 'growth', limit: 3 }),
      tools.call('get_top_products', { period: period(periodKey), sort: 'decline', limit: 3 }),
      tools.call('get_channels', { period: period(periodKey) }),
    ]);
    return {
      ok: true, source, period: metrics.period, freshness: metrics.freshness, completeness: metrics.completeness, currency: metrics.currency,
      values: metrics.values, comparison: metrics.comparison,
      movers: { growth: growth.ok ? growth.items ?? [] : [], decline: decline.ok ? decline.items ?? [] : [] },
      channels: channels.ok ? { items: channels.items ?? [], comparison: channels.comparison ?? null } : null,
      unknownCauses: KNOWN_GAPS.filter((g) => ['traffic', 'ad_spend', 'inventory'].includes(g)), // what Analytics cannot see: never presented as a cause
    };
  }
  return Object.freeze({ kind: 'analytics', source, salesEvolution, tools });
}
