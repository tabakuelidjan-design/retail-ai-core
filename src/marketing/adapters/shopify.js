// Shopify adapter: the ONLY place that knows Shopify's order attribution shapes.
// It turns Order.channelInformation / Order.customerJourneySummary into generic,
// platform-neutral rows. Privacy: referrers become a HOST, landing pages a PATH;
// query strings and fragments are dropped (they can hold personal data or click
// identifiers), and no customer identity is read at all.

const clean = (v, max = 200) => {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  return s === '' ? null : s.slice(0, max);
};

export function hostOf(url) {
  const s = clean(url, 500);
  if (!s) return null;
  try { return new URL(s).host.toLowerCase() || null; } catch { return null; }
}

export function pathOf(url) {
  const s = clean(url, 500);
  if (!s) return null;
  try {
    return new URL(s).pathname || '/';
  } catch {
    return s.startsWith('/') ? s.split(/[?#]/)[0] : null;
  }
}

/** Channel columns stored on the order row itself. */
export function normalizeOrderChannel(node) {
  const def = node.channelInformation?.channelDefinition;
  const j = node.customerJourneySummary;
  return {
    source_name: clean(node.sourceName, 60),
    channel_handle: clean(def?.handle, 60),
    channel_name: clean(def?.channelName, 80),
    sub_channel_name: clean(def?.subChannelName, 80),
    customer_order_index: Number.isInteger(j?.customerOrderIndex) ? j.customerOrderIndex : null,
    journey_ready: typeof j?.ready === 'boolean' ? j.ready : null,
    days_to_conversion: typeof j?.daysToConversion === 'number' ? j.daysToConversion : null,
  };
}

function visitRow(visit, touch, orderId, merchantId) {
  if (!visit) return null;
  const utm = visit.utmParameters ?? {};
  const row = {
    merchant_id: merchantId, order_id: orderId, source_system: 'shopify', touch,
    occurred_at: visit.occurredAt ?? null,
    source: clean(visit.source, 120), source_type: clean(visit.sourceType, 40), source_description: clean(visit.sourceDescription, 120),
    referrer_host: hostOf(visit.referrerUrl), landing_path: pathOf(visit.landingPage),
    utm_source: clean(utm.source), utm_medium: clean(utm.medium), utm_campaign: clean(utm.campaign), utm_content: clean(utm.content), utm_term: clean(utm.term),
  };
  const informative = ['source', 'source_type', 'referrer_host', 'landing_path', 'utm_source', 'utm_medium', 'utm_campaign'].some((k) => row[k]);
  return informative ? row : null;
}

/** 0-2 rows (first/last visit) for an order; none when Shopify recorded no visit. */
export function normalizeOrderAttribution(node, orderId, merchantId) {
  const j = node.customerJourneySummary;
  if (!j) return [];
  return [visitRow(j.firstVisit, 'first_visit', orderId, merchantId), visitRow(j.lastVisit, 'last_visit', orderId, merchantId)].filter(Boolean);
}
