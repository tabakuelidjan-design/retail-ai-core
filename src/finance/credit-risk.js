// Credit risk / solvency: EXPLICITLY DEFERRED. This file is only the architectural placeholder.
// Future flow:  company -> external risk provider -> payment-term policy.
// Nothing in the finance core imports this file. No provider is subscribed to, no external service is called, and no
// scoring is implemented. A future module would implement CREDIT_RISK_PROVIDER_CONTRACT and feed a payment-term policy.

export const CREDIT_RISK_PROVIDER_CONTRACT = {
  name: 'string',
  assess: 'async (company: { enterpriseNumber, vatNumber, name }) => { status, provider, retrievedAt, ... }',
  note: 'Provider-specific fields and licensing terms stay inside the provider adapter, like the Peppol Access Point adapter.',
};

export const NullCreditRiskProvider = {
  name: 'none',
  async assess() { return { status: 'NOT_CONFIGURED', provider: null, reason: 'Credit-risk checking is a future optional module and is not implemented.' }; },
};
