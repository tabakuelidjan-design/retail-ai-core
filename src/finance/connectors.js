// Replaceable connector boundaries. They are CONTRACTS plus NOT CONFIGURED defaults: nothing here talks to an accounting package, a bank or a
// customer portal. Each future provider implements the contract without any change in the finance core, and no provider is hard-coded.
//
// AccountingExportAdapter
//   Sends (or hands over) a period's accounting data to the accountant's software: sales, purchases, bank transactions, VAT codes,
//   customer / supplier records and attachments.
//     name, label, configured: boolean
//     capabilities(): { sales, purchases, bankTransactions, vatCodes, contacts, attachments }   (booleans)
//     export({ period, sales: [...], purchases: [...], contacts: [...], vatCodes: [...], attachments: [...] }) => { status: 'EXPORTED', reference }
//   The provider-neutral V1 is the ZIP package (accountant-package.js).
//
// BankReconciliationAdapter
//   Matches bank transactions with invoices / supplier invoices. NO paid bank integration exists yet.
//     name, label, configured
//     transactions({ from, to }) => [{ id, date, amountCents, currency, counterpartyName?, reference? }]
//     suggestMatches(transactions, { invoices, supplierInvoices }) => [{ transactionId, documentId, kind: 'invoice'|'supplier_invoice', confidence }]
//   Suggestions are never applied automatically: a person confirms each match, exactly like a manual payment today.
//
// CustomerPortalAdapter (extension point)
//   A customer-facing view: invoices, quotes, quote acceptance, PDF download, payment status, later online payment.
//     name, label, configured
//     publish(document) => { url, expiresAt }     // a signed, expiring link: never a guessable public URL

export const NOT_CONFIGURED = 'NOT_CONFIGURED';

export const NoAccountingExport = {
  name: 'none', label: 'Export comptable direct non configuré (le dossier ZIP reste disponible)', configured: false,
  capabilities: () => ({ sales: false, purchases: false, bankTransactions: false, vatCodes: false, contacts: false, attachments: false }),
  async export() { throw Object.assign(new Error(NOT_CONFIGURED), { code: NOT_CONFIGURED }); },
};
export const NoBankReconciliation = {
  name: 'none', label: 'Rapprochement bancaire non configuré (les paiements se saisissent à la main)', configured: false,
  async transactions() { throw Object.assign(new Error(NOT_CONFIGURED), { code: NOT_CONFIGURED }); },
  async suggestMatches() { return []; },
};
export const NoCustomerPortal = {
  name: 'none', label: 'Portail client non configuré', configured: false,
  async publish() { throw Object.assign(new Error(NOT_CONFIGURED), { code: NOT_CONFIGURED }); },
};

/** Fail fast when an adapter does not honour its contract (used when a provider is registered). */
export function assertAdapter(kind, a) {
  const need = { accountingExport: ['name', 'label', 'configured', 'capabilities', 'export'], bankReconciliation: ['name', 'label', 'configured', 'transactions', 'suggestMatches'], customerPortal: ['name', 'label', 'configured', 'publish'] }[kind];
  if (!need) throw new Error(`unknown adapter kind ${kind}`);
  const missing = need.filter((k) => !(k in (a ?? {})));
  if (missing.length) throw new Error(`${kind} adapter is missing: ${missing.join(', ')}`);
  return a;
}

/** What the dashboard shows in Settings: every boundary with its state. */
export function connectorStatus({ accountingExport = NoAccountingExport, bankReconciliation = NoBankReconciliation, customerPortal = NoCustomerPortal, mail, accessPoint, inbox = [] } = {}) {
  return [
    { kind: 'accountingExport', name: accountingExport.name, label: accountingExport.label, configured: !!accountingExport.configured },
    { kind: 'bankReconciliation', name: bankReconciliation.name, label: bankReconciliation.label, configured: !!bankReconciliation.configured },
    { kind: 'customerPortal', name: customerPortal.name, label: customerPortal.label, configured: !!customerPortal.configured },
    ...(mail ? [{ kind: 'mailDelivery', name: mail.name, label: mail.label, configured: !!mail.canSend }] : []),
    ...(accessPoint ? [{ kind: 'peppolAccessPoint', name: accessPoint.name, label: accessPoint.name === 'none' ? 'Point d\'accès Peppol non configuré' : accessPoint.name, configured: accessPoint.name !== 'none' }] : []),
    ...inbox.map((i) => ({ kind: 'inbox', name: i.name, label: i.label, configured: !!i.configured })),
  ];
}
