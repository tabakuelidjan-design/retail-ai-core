import { deepFreeze } from './validation.js';

// BRIEF ASSESSMENT: the first deterministic step before any model is asked. Every brief produces a valid NEXT ACTION without a crash and without an invented fact:
//   PROCEED               the brief holds what a frame needs (a product, something approved to say, a format, an asset); anything it does not state stays an explicit unknown for the framer to mark UNKNOWN
//   NEEDS_CLARIFICATION   something a frame cannot be built without is missing: the answer is a precise question, not a guess
//   USER_CONTRADICTION    the brief says two incompatible things (two different headlines, two different prices): the answer is a question, not a choice
// Nothing here judges creative quality, translates, or repairs the brief's meaning; the model is not involved, so it costs nothing.

export const BRIEF_STATUS = Object.freeze({ PROCEED: 'PROCEED', NEEDS_CLARIFICATION: 'NEEDS_CLARIFICATION', USER_CONTRADICTION: 'USER_CONTRADICTION' });

const NULL_LIKE = new Set(['', 'null', 'undefined', 'n/a', 'na', 'none', 'nil', '-', '?', 'tbd', 'todo', 'unknown', 'aucun', 'geen']);
const clean = (v) => (typeof v === 'string' ? v.normalize('NFC').replace(/[​⁠﻿]/g, '').replace(/\s+/g, ' ').trim() : '');
const present = (v) => { const t = clean(v); return t.length >= 2 && !NULL_LIKE.has(t.toLowerCase()); };
const same = (a, b) => clean(a).toLowerCase() === clean(b).toLowerCase();

function conflicts(items, roleOf, textOf, code, field, question) {
  const issues = [];
  const byRole = new Map();
  for (const item of items ?? []) { const role = roleOf(item); if (!byRole.has(role)) byRole.set(role, []); byRole.get(role).push(textOf(item)); }
  for (const [role, texts] of byRole) if (texts.some((t) => !same(t, texts[0]))) issues.push({ code, kind: 'CONTRADICTION', field: `${field}.${role}`, question: question(role) });
  return issues;
}

/** @param {object} input { brief } @returns {{ status, issues: [{ code, kind, field, question }], unknowns: string[] }} */
export function assessBrief({ brief }) {
  const missing = [];
  if (!present(brief?.public_facts?.product)) missing.push({ code: 'PRODUCT_NOT_STATED', kind: 'MISSING', field: 'public_facts.product', question: 'What is the product to show? Please describe it in a few words.' });
  if (!(brief?.approved_copy?.length) && !(brief?.claims?.length)) missing.push({ code: 'NOTHING_APPROVED_TO_SAY', kind: 'MISSING', field: 'approved_copy', question: 'What may the visual say? Please give at least one approved headline, line or claim.' });
  if (!brief?.format?.aspect_ratio) missing.push({ code: 'FORMAT_NOT_STATED', kind: 'MISSING', field: 'format', question: 'Where will the visual be published (format or channel)?' });
  if (!brief?.asset?.ref || !brief?.ids?.product_ref) missing.push({ code: 'PRODUCT_ASSET_NOT_PROVIDED', kind: 'MISSING', field: 'asset', question: 'Which photograph of the real product should be used?' });
  const contradictions = [
    ...conflicts(brief?.approved_copy, (c) => c.role, (c) => c.content, 'APPROVED_COPY_CONTRADICTS_ITSELF', 'approved_copy', (role) => `Two different texts are approved as the ${role}. Which one is the right one?`),
    ...conflicts(brief?.claims, (c) => c.role, (c) => c.wording, 'CLAIMS_CONTRADICT_EACH_OTHER', 'claims', (role) => `Two different claims are given as the ${role}. Which one is the right one?`),
  ];
  const unknowns = [];
  if (!present(brief?.public_facts?.audience)) unknowns.push('AUDIENCE_NOT_STATED');
  if (!present(brief?.public_facts?.objective)) unknowns.push('COMMERCIAL_OBJECTIVE_NOT_STATED');
  if (!present(brief?.public_facts?.occasion)) unknowns.push('OCCASION_NOT_STATED');
  if (!(brief?.claims ?? []).some((c) => c.role === 'PRICE')) unknowns.push('PRICE_NOT_STATED');
  // a missing fact is asked first; contradictions are asked when nothing is missing
  const issues = missing.length ? missing : contradictions;
  const status = missing.length ? BRIEF_STATUS.NEEDS_CLARIFICATION : contradictions.length ? BRIEF_STATUS.USER_CONTRADICTION : BRIEF_STATUS.PROCEED;
  return deepFreeze({ status, issues, unknowns });
}
