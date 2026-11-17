// Optional bank connection of the hosted Finance service, chosen by the environment. OFF BY DEFAULT: without FINANCE_BANK_PROVIDER nothing changes (NoBankAdapter, CSV import stays the route).
// An optional integration never stops the service: an incomplete or invalid setting logs ONE line with the NAMES of what is wrong (never a value) and the service runs without a bank.
//   FINANCE_BANK_PROVIDER=enable-banking        switches the option on
//   ENABLE_BANKING_APPLICATION_ID               the application id of the Enable Banking control panel (public identifier)
//   ENABLE_BANKING_PRIVATE_KEY                  the application's private key, PEM (a one-line value with \n sequences is accepted); SECRET: platform variable only
//   ENABLE_BANKING_BANK                         a key of src/finance/bank-catalog-be.js (default: kbc, the pilot bank)
//   ENABLE_BANKING_PSU_TYPE                     business (default) | personal
//   BANK_VAULT_KEY                              32 bytes base64: encrypts the consent at rest (already required by the bank layer)
import { createPrivateKey } from 'node:crypto';
import { NoBankAdapter } from './bank.js';
import { belgianBank } from './bank-catalog-be.js';
import { createEnableBankingAdapter } from './bank-adapter-enable-banking.js';

export const PILOT_BANK = 'kbc';

/** @returns {object} the adapter to give to createFinanceApp (NoBankAdapter when the option is off or incomplete) */
export function bankAdapterFromEnv(env = process.env, { log = () => {}, fetchImpl, now } = {}) {
  const provider = String(env.FINANCE_BANK_PROVIDER ?? '').trim().toLowerCase();
  if (!provider) return NoBankAdapter;
  const off = (why) => { log(`Finance bank connection NOT enabled: ${why}`); return NoBankAdapter; };
  if (provider !== 'enable-banking') return off('FINANCE_BANK_PROVIDER has an unknown value');
  const problems = [];
  const applicationId = String(env.ENABLE_BANKING_APPLICATION_ID ?? '').trim(); if (!applicationId) problems.push('ENABLE_BANKING_APPLICATION_ID missing');
  const rawKey = String(env.ENABLE_BANKING_PRIVATE_KEY ?? '').replace(/\\n/g, '\n').trim(); let privateKeyPem = null;
  if (!rawKey) problems.push('ENABLE_BANKING_PRIVATE_KEY missing'); else { try { createPrivateKey(rawKey); privateKeyPem = rawKey; } catch { problems.push('ENABLE_BANKING_PRIVATE_KEY is not a readable PEM private key'); } }
  const bankKey = String(env.ENABLE_BANKING_BANK ?? PILOT_BANK).trim().toLowerCase(); if (!belgianBank(bankKey)) problems.push('ENABLE_BANKING_BANK is not a bank of the catalogue');
  const psuType = String(env.ENABLE_BANKING_PSU_TYPE ?? 'business').trim().toLowerCase(); if (!['business', 'personal'].includes(psuType)) problems.push('ENABLE_BANKING_PSU_TYPE must be business or personal');
  if (!String(env.BANK_VAULT_KEY ?? '').trim()) problems.push('BANK_VAULT_KEY missing (the consent could not be stored)');
  if (problems.length) return off(problems.join('; '));
  return createEnableBankingAdapter({ applicationId, privateKeyPem, bankKey, psuType, ...(fetchImpl ? { fetchImpl } : {}), ...(now ? { now } : {}) });
}
