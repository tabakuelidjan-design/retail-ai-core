// Nordla Growth - privacy checks on the AI path: the merchant's free question (before the provider), the model's answer (before a draft is kept),
// and the web addresses of public examples (before they reach the provider). Detection is for HIGH-CONFIDENCE formats only. It cannot find a
// person's name: names are not detected reliably and are NOT protected by these checks (the interface says so).

import { createHash } from 'node:crypto';

export const PERSONAL_KINDS = Object.freeze(['email', 'phone', 'iban', 'urlParams']);

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/;
const PHONE_INTL = /\+\d{1,3}[\s.-]?\(?\d{1,4}\)?(?:[\s.-]?\d{2,4}){2,5}/;
const PHONE_NATIONAL = /(?<![\d.,])0\d(?:[\s.-]?\d{2}){4}(?![\d.,])/; // 0470 12 34 56 and similar (ten digits)
const IBAN = /\b[A-Z]{2}\d{2}(?: ?[A-Z0-9]{4}){3,7}(?: ?[A-Z0-9]{1,3})?\b/;
const URL_WITH_PARAMS = /https?:\/\/[^\s<>"']+\?[^\s<>"']+/i;

/** The kinds of high-confidence personal data found in a text. Returns kind names only, never the value. */
export function detectPersonalData(text) {
  const s = String(text ?? '');
  const kinds = [];
  if (EMAIL.test(s)) kinds.push('email');
  if (PHONE_INTL.test(s) || PHONE_NATIONAL.test(s)) kinds.push('phone');
  if (IBAN.test(s)) kinds.push('iban');
  if (URL_WITH_PARAMS.test(s)) kinds.push('urlParams');
  return kinds;
}

const URL_KEYS = new Set(['url', 'link', 'links', 'permalink', 'href', 'postUrl', 'destination']);

/**
 * A web address reduced to what the agent needs and what an internal proof needs: the host (without www) and an opaque reference of the full
 * address. The path, the query and any account name in them never leave the server. A value that is not an absolute address becomes null.
 */
export function reduceUrl(value) {
  if (Array.isArray(value)) return value.map(reduceUrl);
  if (typeof value !== 'string') return null;
  let host = null;
  try { host = new URL(value).hostname.replace(/^www\./, '') || null; } catch { return null; }
  if (!host) return null;
  return { host, ref: `url:${createHash('sha256').update(value).digest('hex').slice(0, 12)}` };
}

/** Is this key one whose value is a web address (reduced, never sent whole)? */
export const isUrlKey = (k) => URL_KEYS.has(k);

const URL_ANY = /https?:\/\/[^\s<>"']+/gi;
/**
 * Free text inside an agent context: each high-confidence personal format is replaced by a neutral tag, the rest of the text is kept.
 * Applied to every string of every context, so a note that happens to hold an e-mail, a phone number, an IBAN or a link never reaches the provider as it is.
 */
export function maskPersonal(text) {
  let s = String(text);
  s = s.replace(URL_ANY, '[lien]');
  s = s.replace(new RegExp(EMAIL.source, 'g'), '[courriel]');
  s = s.replace(new RegExp(IBAN.source, 'g'), '[iban]');
  s = s.replace(new RegExp(PHONE_INTL.source, 'g'), '[téléphone]');
  s = s.replace(new RegExp(PHONE_NATIONAL.source, 'g'), '[téléphone]');
  return s;
}
