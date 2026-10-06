// "Nordla a compris": which proposed facts may be confirmed TOGETHER with one deliberate tap, and which must stay in front of the owner one by one. Pure and deterministic.
// A fact joins the group only when it is HIGH confidence, unambiguous, not calculated by Nordla, not in conflict with the case or with another proposal, and not a document statement.
// Document statements ("we have CE") have their own separate tap and are only ever recorded as the supplier's claims. Provenance is unchanged: the reducer still confirms each fact one by one.
import { findCandidateConflict } from './conflicts.js';
import { describeCandidate } from './candidate-view.js';

const CALCULATED = new Set(['DERIVED', 'WAN_CONVERTED', 'EU_NUMBER_FORMAT']);
const DOC = { CE: 'CE', UN383: 'UN 38.3', ROHS: 'RoHS', REACH: 'REACH', FCC: 'FCC', SDS: 'SDS', IEC62133: 'IEC 62133', TEST_REPORT: "rapport d'essai" };

/** @returns {{ group: object[], attention: {candidate: object, reason: string}[], claims: object[] }} */
export function classifyCandidates(state) {
  const proposed = state.candidates.filter((c) => c.state === 'PROPOSED');
  const byKey = new Map(); for (const c of proposed) { const k = `${c.key}|${c.context}`; byKey.set(k, [...(byKey.get(k) ?? []), c]); }
  const dup = (c) => { const same = byKey.get(`${c.key}|${c.context}`); return same.length > 1 && new Set(same.map((x) => JSON.stringify(x.value))).size > 1; };
  const out = { group: [], attention: [], claims: [] };
  for (const c of proposed) {
    const value = c.correctedValue ?? c.value; const flags = c.flags ?? [];
    if (c.key.startsWith('docClaim.')) { const f = findCandidateConflict(state, c, value); if (f) out.attention.push({ candidate: c, reason: 'CONFLICT' }); else out.claims.push(c); continue; }
    if (c.needsCorrection || flags.includes('AMBIGUOUS_NUMBER')) { out.attention.push({ candidate: c, reason: 'AMBIGUOUS' }); continue; }
    if (flags.includes('DUPLICATE_THRESHOLD') || dup(c)) { out.attention.push({ candidate: c, reason: 'DUPLICATE' }); continue; }
    if (findCandidateConflict(state, c, value)) { out.attention.push({ candidate: c, reason: 'CONFLICT' }); continue; }
    if (flags.some((f) => CALCULATED.has(f))) { out.attention.push({ candidate: c, reason: 'CALCULATED' }); continue; }
    if (c.confidence !== 'HIGH') { out.attention.push({ candidate: c, reason: 'LOW_CONFIDENCE' }); continue; }
    out.group.push(c);
  }
  return out;
}

const T = {
  fr: { moq: (v) => `MOQ ${v}`, dep: (v) => `${v} % d'acompte`, bal: (v, due) => `${v} % ${due ?? 'au solde'}`, due: { 'before shipment': 'avant expédition', 'before delivery': 'avant livraison', 'before loading': 'avant chargement', 'against B/L': 'contre le connaissement', 'after inspection': 'après inspection', 'on delivery': 'à la livraison', 'at shipment': "à l'expédition" }, colours: (n, l) => `${n} couleur${n > 1 ? 's' : ''} : ${l}`, mix: 'mélange possible', nomix: 'pas de mélange', perColour: (v) => `min. ${v} par couleur`, days: (min, max) => (min === max ? `${min} jours` : `${min} à ${max} jours`), claims: ' : le fournisseur dit les avoir ou les envoyer, aucun document reçu', no: (l) => `${l} : le fournisseur dit ne pas l'avoir` },
  en: { moq: (v) => `MOQ ${v}`, dep: (v) => `${v}% deposit`, bal: (v, due) => `${v}% ${due ?? 'balance'}`, due: {}, colours: (n, l) => `${n} colour${n > 1 ? 's' : ''}: ${l}`, mix: 'mixing allowed', nomix: 'no mixing', perColour: (v) => `min. ${v} per colour`, days: (min, max) => (min === max ? `${min} days` : `${min} to ${max} days`), claims: ': the supplier says they have them or will send them, no document received', no: (l) => `${l}: the supplier says they do not have it` },
};

function linesOf(group, state, locale) {
  const t = T[locale] ?? T.fr; const f = (key, ctx = 'product') => group.find((c) => c.key === key && c.context === ctx); const v = (c) => (c ? c.correctedValue ?? c.value : null);
  const cur = v(f('quote.currency')) ?? state.quotes.at(-1)?.currency ?? ''; const lines = [];
  const a = [v(f('identifier.model')), v(f('identifier.brand')), v(f('identifier.manufacturer')), f('quote.moq') && t.moq(v(f('quote.moq'))), f('quote.unitPrice') && `${v(f('quote.unitPrice'))} ${cur}`.trim()].filter(Boolean); if (a.length) lines.push(a.join(' · '));
  const tiers = v(f('quote.tiers')); if (tiers) lines.push(`${tiers.map((x) => `${x.minQty} = ${x.unitPrice}`).join(' · ')}${cur ? ` (${cur})` : ''}`);
  const b = [f('quote.incoterm') && `${v(f('quote.incoterm'))}${f('quote.port') ? ` ${v(f('quote.port'))}` : ''}`, !f('quote.incoterm') && f('quote.port') && v(f('quote.port')), f('payment.depositPct') && t.dep(v(f('payment.depositPct'))), f('payment.balancePct') && t.bal(v(f('payment.balancePct')), f('payment.balanceDue') && (t.due[v(f('payment.balanceDue'))] ?? v(f('payment.balanceDue'))))].filter(Boolean); if (b.length) lines.push(b.join(' · '));
  const col = v(f('variant.colours')); const c = [col && t.colours(col.length, col.join(', ')), f('moq.mixedColours') && (v(f('moq.mixedColours')) ? t.mix : t.nomix), f('moq.perColour') && t.perColour(v(f('moq.perColour'))), f('quote.leadTime') && t.days(v(f('quote.leadTime')).min, v(f('quote.leadTime')).max)].filter(Boolean); if (c.length) lines.push(c.join(' · '));
  const known = new Set(['identifier.model', 'identifier.brand', 'identifier.manufacturer', 'quote.moq', 'quote.unitPrice', 'quote.currency', 'quote.tiers', 'quote.incoterm', 'quote.port', 'payment.depositPct', 'payment.balancePct', 'payment.balanceDue', 'variant.colours', 'moq.mixedColours', 'moq.perColour', 'quote.leadTime']);
  const rest = group.filter((x) => !(known.has(x.key) && x.context === 'product')).map((x) => { const d = describeCandidate(x, locale); return `${d.label} : ${d.valueText}`; }); if (rest.length) lines.push(rest.join(' · '));
  return lines;
}
function claimsLineOf(claims, locale) {
  const t = T[locale] ?? T.fr; const yes = claims.filter((c) => c.value !== 'NOT_AVAILABLE').map((c) => DOC[c.key.slice(9)] ?? c.key.slice(9)); const no = claims.filter((c) => c.value === 'NOT_AVAILABLE').map((c) => DOC[c.key.slice(9)] ?? c.key.slice(9));
  return { claimsLine: yes.length ? `${yes.join(' · ')}${t.claims}` : null, noLine: no.length ? t.no(no.join(' · ')) : null };
}

/** @param {object} state the case @param {{ locale?: 'fr'|'en' }} opts */
export function groupUnderstanding(state, { locale = 'fr' } = {}) {
  const c = classifyCandidates(state); const rows = c.group.map((x) => describeCandidate(x, locale));
  return { ...c, rows, lines: linesOf(c.group, state, locale), ...claimsLineOf(c.claims, locale), claimRows: c.claims.map((x) => describeCandidate(x, locale)), attentionRows: c.attention.map((a) => ({ reason: a.reason, ...describeCandidate(a.candidate, locale) })), hasGroup: c.group.length > 0 };
}
