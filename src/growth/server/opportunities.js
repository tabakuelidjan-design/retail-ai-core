// Growth > Opportunités - no Nordla engine produces an opportunity pipeline today (priorities, potential revenue, confidence,
// effort, approvals, wins): the page states it instead of showing demonstration figures (owner decision 2026-09-28).
// The real engines already emit opportunity CONTRACTS (Produits Potentiels, Audience, Croissance magasin); feeding this page from
// them is a separate, future task. A connected payload example lives in test/fixtures/growth-opportunities-sample.js.

export function buildOpportunities(now = new Date()) {
  return { connected: false, currency: 'EUR', generatedAt: now.toISOString() };
}
