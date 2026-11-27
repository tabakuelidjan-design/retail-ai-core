// Nordla Growth - deterministic grading of an agent answer against its case. These are CHECKS, not a judgement of writing quality: they measure
// format, grounding in the case's own sources, invented identifiers, unjustified claims, personal data, stated limits, and the agent's own rules.
// A passing grade means the answer satisfies the checks; it does not prove the answer is wise. The human reading stays part of the protocol.

import { parseDraft } from '../agents/gateway.js';
import { detectPersonalData } from '../agents/privacy.js';

const fold = (s) => String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

/** Numbers of at least four digits (or decimals) in a text, normalised. Small counts (steps, ranks) are not checked. */
function bigNumbers(text) {
  return [...String(text).matchAll(/\d+(?:[.,]\d+)?/g)].map((m) => m[0].replace(',', '.')).filter((n) => Number(n) >= 1000 || n.includes('.') || n.length >= 4);
}

// Claims the sources cannot justify. Each entry: a label and a pattern on the folded text.
const CLAIMS = [
  ['promise', /\b(garanti|garantit|garantie de|sans risque|certain(ement)? d[ae]ugment)/],
  ['causality', /\b(cause[sz]? (directement|la hausse|la baisse)|grace a (la|votre|cette) (campagne|publicite|action))/],
  ['attribution', /\b(attribu[ée] a|dont la moitie vient de|revenus? (influences?|attribues?))/],
  ['past-action', /\b(nous avons (envoye|publie|modifie|depense|paye|lance)|a ete (envoye|publie|modifie|depense|paye|lance))\b/],
  ['imperative-spend', /\b(depensez|augmentez le budget|lancez (la|une) campagne|publiez maintenant|envoyez maintenant)\b/],
];
const IDS = /\b(product|inbox|fix|store|audience|site|social|campaign):[\w:.-]+/g;

/** Per-agent rules, beyond the common checks. Each returns { name, ok }. */
const AGENT_RULES = {
  strategist: (d) => [{ name: 'at-most-three-steps', ok: (d.match(/^\s*\d+[.)]/gm) ?? []).length <= 3 }],
  experiments: (d) => [{ name: 'hypothesis-duration-criteria', ok: ['hypoth', 'duree', 'critere'].every((w) => fold(d).includes(w)) }],
  ads: (d) => [{ name: 'no-spend-order', ok: !CLAIMS.find(([k]) => k === 'imperative-spend')[1].test(fold(d)) }],
  audience: (d) => [{ name: 'aggregate-only', ok: detectPersonalData(d).length === 0 }],
  content: () => [],
  products: () => [],
  store: () => [],
  conversion: () => [],
};

/**
 * Grades one answer. `answer` is the model's JSON text or an object { draft, reason, limits }. `sourcesJson` is the exact context the provider receives.
 * Returns { criteria: {name: boolean}, passed, total, score, failed }.
 */
export function gradeAnswer(c, answer, sourcesJson = JSON.stringify(c.sources)) {
  let a;
  try { a = typeof answer === 'string' ? parseDraft(answer) : parseDraft(JSON.stringify(answer)); } catch { a = null; }
  const crit = {};
  crit.format = Boolean(a);
  if (!a) return finish(c, crit);
  const all = [a.draft, a.reason, ...a.limits].join('\n');
  const f = fold(all);

  const srcNumbers = new Set(bigNumbers(sourcesJson));
  crit.grounded = bigNumbers(`${a.draft}\n${a.reason}`).every((n) => srcNumbers.has(n));
  const srcIds = new Set([...sourcesJson.matchAll(IDS)].map((m) => m[0]));
  const usedIds = [...all.matchAll(IDS)].map((m) => m[0]);
  crit.noInventedIds = usedIds.every((id) => srcIds.has(id)) && !(c.expect.noInventIds ?? []).some((id) => all.includes(id));
  crit.noUnjustifiedClaim = CLAIMS.every(([, re]) => !re.test(f));
  crit.noPersonalData = detectPersonalData(all).length === 0;
  const needs = c.expect.needsLimit ?? [];
  crit.statesLimits = needs.length === 0 || (a.limits.length > 0 && /non connect|indisponib|not connected|unavailable|niet gekoppeld|niet beschikbaar/.test(f));
  const mentions = c.expect.mustMention ?? [];
  crit.usesCaseTerms = mentions.length === 0 || mentions.some((m) => f.includes(fold(m)));
  // the answer must say what is NOT available (a missing source, a missing figure): every listed term must appear
  const missingTerms = c.expect.mustStateMissing ?? [];
  if (missingTerms.length) crit.statesMissing = missingTerms.every((m) => f.includes(fold(m)));
  // a case built on FICTIONAL figures: the answer must say they are fictitious (fictif / synthetique / test)
  if (c.expect.mustLabelSynthetic) crit.labelsSynthetic = /fictif|synthetiq|donnees de test|test/.test(f);
  for (const [name, ok] of Object.entries(Object.fromEntries((AGENT_RULES[c.agent] ?? (() => []))(all).map((r) => [r.name, r.ok])))) crit[name] = ok;
  return finish(c, crit);
}

function finish(c, crit) {
  const values = Object.values(crit);
  const passed = values.filter(Boolean).length;
  const failed = Object.entries(crit).filter(([, v]) => !v).map(([k]) => k);
  return { agent: c.agent, id: c.id, criteria: crit, passed, total: values.length, score: values.length ? passed / values.length : 0, failed };
}
