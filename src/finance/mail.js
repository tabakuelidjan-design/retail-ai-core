// MailDeliveryAdapter boundary. The dashboard PREPARES a message (recipient, subject, body, attachments); the merchant APPROVES it;
// only then is an adapter asked to deliver. Nothing is ever sent silently, and the recipient is merchant-local configuration.
//
//   adapter contract: {
//     name: string, label: string,
//     canSend: boolean,                       // true only when a real delivery channel is configured
//     send(message) => Promise<{ status: 'SENT', messageId }>,   // throws MailError('NOT_CONFIGURED') when canSend is false
//   }
//   message: { from, to, subject, text, attachments: [{ name, contentType, data: Buffer }] }
//
// Today: NoMailAdapter (direct sending NOT CONFIGURED) and the .eml fallback, which builds a standard message file the merchant opens in
// their own mail program and sends themselves. A future SMTP / provider adapter implements the same contract with no change elsewhere.

import { randomUUID } from 'node:crypto';

export class MailError extends Error { constructor(code, detail) { super(code); this.code = code; this.detail = detail ?? null; } }

export const NoMailAdapter = {
  name: 'none', label: 'Envoi direct non configuré', canSend: false,
  async send() { throw new MailError('DIRECT_SEND_NOT_CONFIGURED'); },
};

const cleanHeader = (s) => String(s ?? '').replace(/[\r\n]+/g, ' ').trim();
const encodeWord = (s) => (/^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${Buffer.from(s, 'utf8').toString('base64')}?=`);
const wrap = (b64) => b64.replace(/(.{76})/g, '$1\r\n');

/** A standard RFC 5322 message with attachments (a draft the merchant opens and sends themselves: no From date, unsent). */
export function buildEml({ from, to, subject, text, attachments = [] }) {
  const boundary = `----=_finance_${randomUUID()}`;
  const head = [`From: ${cleanHeader(from)}`, `To: ${cleanHeader(to)}`, `Subject: ${encodeWord(cleanHeader(subject))}`, 'MIME-Version: 1.0', 'X-Unsent: 1', `Content-Type: multipart/mixed; boundary="${boundary}"`];
  const parts = [`--${boundary}`, 'Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: base64', '', wrap(Buffer.from(String(text ?? ''), 'utf8').toString('base64'))];
  for (const a of attachments) parts.push(`--${boundary}`, `Content-Type: ${a.contentType ?? 'application/octet-stream'}; name="${cleanHeader(a.name)}"`, 'Content-Transfer-Encoding: base64', `Content-Disposition: attachment; filename="${cleanHeader(a.name)}"`, '', wrap(a.data.toString('base64')));
  parts.push(`--${boundary}--`, '');
  return Buffer.from(`${head.join('\r\n')}\r\n\r\n${parts.join('\r\n')}`, 'utf8');
}

/** The default message to the accountant, in French. The merchant sees and can rely on exactly this text before approving. */
export function accountantMessage({ merchantName, accountantName, periodLabel, zipName, completeness }) {
  const label = periodLabel.replace('_', ' ');
  return {
    subject: `${merchantName || 'Dossier comptable'} - dossier comptable ${label}`,
    text: [`Bonjour${accountantName ? ` ${accountantName}` : ''},`, '', `Veuillez trouver ci-joint le dossier comptable de ${merchantName || 'notre société'} pour la période ${label} (${zipName}).`, '',
      'Il contient : le résumé, les ventes (XLSX et CSV), la TVA par taux, les factures clients, les avoirs, les remboursements, les factures fournisseurs, le rapprochement et les anomalies.',
      completeness === 'COMPLETE' ? 'Les données de la période sont complètes.' : 'Attention : certaines données de la période sont incomplètes ; le détail figure dans le fichier « Anomalies et complétude ».', '',
      'Ce message a été préparé par notre outil de gestion financière et envoyé après validation.', '', 'Cordialement,', merchantName || ''].join('\n'),
  };
}
