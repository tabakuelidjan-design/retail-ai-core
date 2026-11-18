// SEPA Credit Transfer QR payload, EPC069-12 (version 002, UTF-8). Scanned by Belgian banking apps to pre-fill a transfer:
// beneficiary, IBAN, BIC, amount and the communication. Pure string builder, no I/O.
//
// Belgian structured communication (+++xxx/xxxx/xxxxx+++) goes in the UNSTRUCTURED remittance line, the place Belgian banks
// read it from; the same string is printed on the invoice and written as PaymentID in the Peppol XML.
// Only invoices get a QR code: a quote is not a payment request and a credit note is a refund, not a transfer to the seller.

import QRCode from 'qrcode';

const MAX_AMOUNT_CENTS = 99999999999n; // EUR 999 999 999.99
const MAX_BYTES = 331; // EPC limit for the whole payload
const clean = (v) => String(v ?? '').replace(/[\r\n]/g, ' ').trim();

/**
 * @param {{name: string, iban: string, bic?: string|null, amountCents: number, communication?: string|null}} p
 * @returns {{payload: string|null, errors: string[]}}
 */
export function buildEpcPayload({ name, iban, bic = null, amountCents, communication = null }) {
  const errors = [];
  const ibanClean = clean(iban).replace(/\s/g, '').toUpperCase();
  if (!/^BE\d{14}$/.test(ibanClean)) errors.push('IBAN_NOT_BELGIAN_FORMAT');
  const benef = clean(name).slice(0, 70);
  if (!benef) errors.push('BENEFICIARY_NAME_MISSING');
  const cents = BigInt(Number.isInteger(amountCents) ? amountCents : -1);
  if (cents <= 0n) errors.push('AMOUNT_MUST_BE_POSITIVE');
  if (cents > MAX_AMOUNT_CENTS) errors.push('AMOUNT_TOO_LARGE');
  const comm = clean(communication).slice(0, 140);
  if (errors.length) return { payload: null, errors };
  const amount = `${cents / 100n}.${String(cents % 100n).padStart(2, '0')}`;
  const lines = [
    'BCD', // service tag
    '002', // version
    '1', // character set: UTF-8
    'SCT', // SEPA credit transfer
    clean(bic).toUpperCase(), // BIC (optional in v002, kept when known)
    benef,
    ibanClean,
    `EUR${amount}`,
    '', // purpose (optional)
    '', // structured remittance reference (not used: Belgian structured communication goes below)
    comm, // unstructured remittance information
    '', // beneficiary-to-originator information
  ];
  const payload = lines.join('\n');
  if (Buffer.byteLength(payload, 'utf8') > MAX_BYTES) return { payload: null, errors: ['PAYLOAD_TOO_LONG'] };
  return { payload, errors: [] };
}

/** PNG buffer of the QR code, error correction M (robust to print and scan). */
export async function epcQrPng(payload, { width = 220 } = {}) {
  return QRCode.toBuffer(payload, { type: 'png', errorCorrectionLevel: 'M', margin: 1, width, color: { dark: '#000000', light: '#ffffff' } });
}
