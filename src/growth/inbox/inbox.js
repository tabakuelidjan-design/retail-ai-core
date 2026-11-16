// Développement des ventes > Demandes (lot _10): the objective "Générer des demandes qualifiées" for an Instagram or TikTok account, with or without a shop or a site.
// Pure and deterministic: the facts an inbox source provides (an import contract; see docs/GROWTH_DATA_LINEAGE.md) in, a reading + a test + its review out.
// It reads nothing, sends nothing, answers nobody. No AI writes a figure; a qualification is the MERCHANT'S (a suggestion, if one is ever added, is a separate, identifiable proposal).
//
// WHAT NORDLA CAN REALLY READ TODAY: no direct messages. Nordla has no messaging adapter (src/activation/providers publish only). The Instagram Conversations API exists (graph.instagram.com,
// /<IG_ID>/conversations, docs checked 2026-11-16; Standard Access for an account the app owns) but its permission for LISTING is documented inconsistently (the Conversations page names
// instagram_business_basic, the Messaging page also instagram_business_manage_messages) and it is NOT connected here. The journey therefore runs on a manual statement or an aggregated import
// file, with the same contract a future connector would fill. Nothing here is sent: the reply is sent by the merchant, in his own tool.
//
// DEFINITIONS (first version)
//   conversation (unique)      one thread = one id. Several messages in the same thread are ONE conversation; duplicate rows of the same id are one (and counted as dropped duplicates).
//   qualified conversation     a conversation where the customer states a concrete intention AND the merchant has what he needs to give the next useful reply (e.g. a quote for a personalised
//                              plate: the support and the quantity). A comment, an emoji or a general question can START a conversation: it stays a distinct step, never a request.
//   qualified request (unique) only when the source distinguishes requests (request_id): several qualified threads of the same request count once. Otherwise: not distinguished (null).
//   PROVENANCE of a conversation   connection (the source attributes it to a publication) | declared (the merchant attached it) | unknown (no origin): unknown stays at ACCOUNT level, never attributed.
//   GRAIN                      threads (one row per conversation) | aggregate (per-publication totals) | totals (account totals only). Grains are NEVER added or de-duplicated against each other.
//
// RULE growth-inbox.1   the reading of the account over the source's window, per provenance. A figure the source does not give is null (unavailable), a given 0 is a real zero.
// RULE growth-review-inbox.1  (below, reviewInquiry): qualification rate = qualified conversations / unique conversations OF THE SAME ATTRIBUTED SET, only with a denominator > 0.
import { addDays } from '../../metrics/windows.js';

export const INBOX_RULE = 'growth-inbox.1';
export const INBOX_REVIEW_RULE = 'growth-review-inbox.1';
export const INBOX_CONFIG = Object.freeze({ minConversations: 10, repeatRatio: 1.5, observationDays: 7 });
export const NETWORKS = Object.freeze(['instagram', 'tiktok']);
export const REQUEST_TYPES = Object.freeze(['quote', 'booking', 'other']);
export const GOAL = 'qualified_requests';
// the invitation keyword proposed for the next publication, per type of request (a proposal: the merchant words it as he wants)
export const KEYWORD = Object.freeze({ quote: 'DEVIS', booking: 'RESERVER', other: 'INFO' });

const num = (x) => (typeof x === 'number' && Number.isInteger(x) && x >= 0 ? x : null);
const isDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
const round1 = (x) => Math.round((x + Number.EPSILON) * 10) / 10;
const ATTR = ['connection', 'declared'];

/** @returns {{ inbox: object|null, errors: string[] }} */
export function normalizeInbox(raw) {
  const errors = [];
  if (!raw || typeof raw !== 'object') return { inbox: null, errors: ['inbox facts must be a JSON object'] };
  if (!NETWORKS.includes(raw.network)) errors.push('network: instagram or tiktok');
  if (!raw.account || !raw.account.id) errors.push('account.id: required');
  if (!raw.source_system) errors.push('source_system: required');
  const w = raw.window; if (!w || !isDate(w.start) || !isDate(w.end) || w.end <= w.start) errors.push('window: { start, end } as YYYY-MM-DD, end exclusive');
  if (errors.length) return { inbox: null, errors };
  // THREADS: one conversation per id. A duplicate row never creates a second conversation; a disagreement on the origin removes the attribution (unknown), never picks a side.
  const byId = new Map(); let duplicates = 0; let conflicts = 0;
  for (const c of (Array.isArray(raw.conversations) ? raw.conversations : [])) {
    if (!c || !c.id) continue;
    const id = String(c.id).slice(0, 80);
    const origin = c.origin && c.origin.kind === 'post' && c.origin.post_id && ATTR.includes(c.origin.attribution) ? { kind: 'post', postId: String(c.origin.post_id), attribution: c.origin.attribution } : { kind: 'unknown' };
    const row = { id, startedAt: isDate(c.started_at) ? c.started_at : null, messages: num(c.messages), origin, source: ['qualified', 'not_qualified'].includes(c.qualified) ? c.qualified : null, requestId: c.request_id ? String(c.request_id).slice(0, 80) : null };
    const prev = byId.get(id);
    if (!prev) { byId.set(id, row); continue; }
    duplicates += 1;
    const same = prev.origin.kind === row.origin.kind && prev.origin.postId === row.origin.postId;
    if (!same) { prev.origin = { kind: 'unknown' }; conflicts += 1; }
    if (prev.source !== row.source) prev.source = null; // two sources disagree on the qualification: it is the merchant's to decide
    prev.messages = prev.messages === null ? row.messages : row.messages === null ? prev.messages : Math.max(prev.messages, row.messages);
    prev.startedAt = prev.startedAt ?? row.startedAt; prev.requestId = prev.requestId ?? row.requestId;
  }
  const t = raw.account_totals ?? null;
  const pubs = (Array.isArray(raw.publications) ? raw.publications : []).filter((p) => p && p.post_id).map((p) => ({ postId: String(p.post_id), url: p.url ?? null, attribution: ATTR.includes(p.attribution) ? p.attribution : 'connection', observationDays: num(p.observation_days),
    conversations: num(p.conversations_unique), qualified: num(p.qualified_conversations), requests: num(p.qualified_requests) }));
  return { errors, inbox: { source: raw.source_system, method: raw.method ?? null, network: raw.network, account: { id: String(raw.account.id), handle: raw.account.handle ?? null }, market: raw.market ?? null, timeZone: raw.time_zone ?? null,
    window: { start: w.start, end: w.end }, retrievedAt: raw.retrieved_at ?? null, merchantRef: typeof raw.merchant_ref === 'string' && /^[a-f0-9]{64}$/.test(raw.merchant_ref) ? raw.merchant_ref : null, requestType: REQUEST_TYPES.includes(raw.request_type) ? raw.request_type : null, complete: raw.complete === true,
    threads: [...byId.values()], duplicatesDropped: duplicates, originConflicts: conflicts, publications: pubs,
    totals: t ? { conversations: num(t.conversations_unique), qualified: num(t.qualified_conversations), requests: num(t.qualified_requests) } : null } };
}

const inWindow = (c, from, to) => c.startedAt !== null && c.startedAt >= from && c.startedAt < to;
export const grainOf = (inbox) => (inbox.threads.length ? 'threads' : inbox.publications.length ? 'aggregate' : inbox.totals ? 'totals' : null);

/** The reading of the account over the source's window: what it provides, per provenance and per grain. Source states only (the merchant's confirmations live in the follow-up). */
export function readInbox(inbox) {
  const grain = grainOf(inbox); const base = { network: inbox.network, accountId: inbox.account.id, handle: inbox.account.handle, window: inbox.window, source: inbox.source, market: inbox.market, requestType: inbox.requestType, grain, duplicatesDropped: inbox.duplicatesDropped, originConflicts: inbox.originConflicts };
  if (grain === 'threads') {
    const ts = inbox.threads; const attributed = ts.filter((c) => c.origin.kind === 'post'); const q = ts.filter((c) => c.source === 'qualified'); const rq = new Set(q.map((c) => c.requestId).filter(Boolean));
    return { ...base, conversations: ts.length, attributed: attributed.length, unknownOrigin: ts.length - attributed.length, byPost: [...attributed.reduce((m, c) => m.set(c.origin.postId, (m.get(c.origin.postId) ?? 0) + 1), new Map())].map(([postId, n]) => ({ postId, conversations: n })),
      qualifiedBySource: q.length, unreviewedBySource: ts.filter((c) => c.source === null).length, requests: q.some((c) => c.requestId) ? rq.size : null, multiMessage: ts.filter((c) => (c.messages ?? 0) > 1).length };
  }
  if (grain === 'aggregate') {
    return { ...base, conversations: null, attributed: inbox.publications.reduce((a, p) => a + (p.conversations ?? 0), 0), unknownOrigin: null, byPost: inbox.publications.map((p) => ({ postId: p.postId, conversations: p.conversations, qualified: p.qualified, requests: p.requests, observationDays: p.observationDays })),
      totals: inbox.totals };
  }
  if (grain === 'totals') return { ...base, conversations: inbox.totals.conversations, attributed: null, unknownOrigin: null, byPost: [], qualifiedBySource: inbox.totals.qualified, requests: inbox.totals.requests };
  return { ...base, conversations: null, attributed: null, unknownOrigin: null, byPost: [] };
}

/**
 * Status of the source for the objective:
 *   NO_DATA              the source has nothing for the window (no thread, no aggregate, no total) and does not state that it covers it: UNAVAILABLE, never a zero
 *   ZERO                 the source states it covers the window (complete) or gives 0 totals: a REAL zero conversation
 *   ATTRIBUTION_UNAVAILABLE  conversations exist but none is attributed to a publication (or only account totals): account level only, manual review
 *   ATTRIBUTED           at least one publication has conversations attributed to it
 */
export function diagnoseInbox({ inbox, config = INBOX_CONFIG }) {
  const cfg = { ...INBOX_CONFIG, ...config }; const reading = readInbox(inbox); const g = reading.grain;
  const base = { rule: INBOX_RULE, goal: GOAL, reading, missing: [] };
  if (!g) return { ...base, status: inbox.complete ? 'ZERO' : 'NO_DATA' };
  const total = g === 'threads' ? reading.conversations : g === 'totals' ? reading.conversations : null;
  if (g === 'threads' && reading.conversations === 0) return { ...base, status: inbox.complete ? 'ZERO' : 'NO_DATA' };
  if (g === 'totals') return { ...base, status: total === 0 ? 'ZERO' : 'ATTRIBUTION_UNAVAILABLE', missing: ['attributionPerPublication'] };
  const any = (reading.byPost ?? []).some((p) => (p.conversations ?? 0) > 0);
  if (!any) return { ...base, status: g === 'threads' ? 'ATTRIBUTION_UNAVAILABLE' : 'ZERO', missing: g === 'threads' ? ['attributionPerPublication'] : [] };
  return { ...base, status: 'ATTRIBUTED', lowVolume: (reading.attributed ?? 0) < cfg.minConversations };
}

/**
 * The review of the test: the conversations attributed to the declared publication during its observation window.
 * @param {{ inbox: object|null, plan: { network, accountId, observationDays, requestType? }, postId: string, from: string, qualification?: { qualified?: string[], notQualified?: string[], declared?: string[] }, now: Date, config?: object }} p
 *   from = the REAL publication day (the observation window is [from, from + observationDays)); qualification = the merchant's own confirmations (ids), applied over the source's states
 */
export function reviewInquiry({ inbox, plan, postId, from, qualification = {}, now, config = INBOX_CONFIG }) {
  const cfg = { ...INBOX_CONFIG, ...config };
  const to = isDate(from) ? addDays(from, plan.observationDays) : null;
  const base = { rule: INBOX_REVIEW_RULE, metric: 'qualificationRate', calculatedAt: new Date(now).toISOString(), target: { type: 'post', id: postId }, plan: { network: plan.network, accountId: plan.accountId, observationDays: plan.observationDays, requestType: plan.requestType ?? null }, window: to ? { start: from, end: to } : null };
  const limited = (limits, extra = {}) => ({ ...base, state: 'LIMITED', limits, counts: null, rate: null, baseline: null, difference: null, accountLevel: null, next: { code: 'wait', reason: limits[0] }, ...extra });
  if (!inbox) return limited(['SOURCE_UNAVAILABLE']);
  if (inbox.network !== plan.network || inbox.account.id !== plan.accountId) return limited(['TARGET_MISMATCH']);
  if (!to) return limited(['PUBLICATION_DATE_MISSING']);
  if (!(inbox.window.end >= to)) return limited(['WINDOW_NOT_COMPLETE'], { sourceWindow: { start: inbox.window.start, end: inbox.window.end } });
  if (new Date(now).toISOString().slice(0, 10) < to) return limited(['WINDOW_NOT_COMPLETE'], { sourceWindow: { start: inbox.window.start, end: inbox.window.end } });
  const grain = grainOf(inbox); const q = new Set(qualification.qualified ?? []); const nq = new Set(qualification.notQualified ?? []); const dec = new Set(qualification.declared ?? []);
  const src = { source: inbox.source, sourceWindow: { start: inbox.window.start, end: inbox.window.end }, grain };
  let counts = null; let accountLevel = null; let limits = [];
  if (grain === 'threads') {
    const ts = inbox.threads.filter((c) => inWindow(c, from, to));
    const provenance = (c) => (c.origin.kind === 'post' && c.origin.postId === postId ? c.origin.attribution : c.origin.kind === 'unknown' && dec.has(c.id) ? 'declared' : c.origin.kind === 'post' ? 'other' : 'unknown');
    const mine = ts.filter((c) => ATTR.includes(provenance(c)));
    const state = (c) => (q.has(c.id) ? 'qualified' : nq.has(c.id) ? 'not_qualified' : c.source ?? 'unreviewed');
    const qual = mine.filter((c) => state(c) === 'qualified'); const rq = new Set(qual.map((c) => c.requestId).filter(Boolean));
    counts = { unique: mine.length, qualified: qual.length, unreviewed: mine.filter((c) => state(c) === 'unreviewed').length, requests: qual.some((c) => c.requestId) ? rq.size : null,
      byProvenance: { connection: mine.filter((c) => provenance(c) === 'connection').length, declared: mine.filter((c) => provenance(c) === 'declared').length },
      qualifiedByProvenance: { connection: qual.filter((c) => provenance(c) === 'connection').length, declared: qual.filter((c) => provenance(c) === 'declared').length }, multiMessage: mine.filter((c) => (c.messages ?? 0) > 1).length };
    accountLevel = { conversations: ts.length, unknownOrigin: ts.filter((c) => provenance(c) === 'unknown').length, otherPublications: ts.filter((c) => provenance(c) === 'other').length, duplicatesDropped: inbox.duplicatesDropped, originConflicts: inbox.originConflicts };
    if (!mine.length && ts.length && !ts.some((c) => c.origin.kind === 'post') && !dec.size) limits.push('ATTRIBUTION_UNAVAILABLE');
  } else if (grain === 'aggregate') {
    const p = inbox.publications.find((x) => x.postId === postId);
    if (!p) limits.push('POST_NOT_IN_SOURCE'); else if (p.conversations === null) limits.push('CONVERSATIONS_UNAVAILABLE');
    else if (p.qualified !== null && p.qualified > p.conversations) limits.push('INCONSISTENT_COUNTS');
    else counts = { unique: p.conversations, qualified: p.qualified, unreviewed: null, requests: p.requests, byProvenance: { connection: p.attribution === 'connection' ? p.conversations : 0, declared: p.attribution === 'declared' ? p.conversations : 0 }, qualifiedByProvenance: null, multiMessage: null };
    accountLevel = inbox.totals ? { conversations: inbox.totals.conversations, qualified: inbox.totals.qualified, requests: inbox.totals.requests, unknownOrigin: null, note: 'aggregate grain: not de-duplicated against publications' } : null;
  } else { limits.push('ATTRIBUTION_UNAVAILABLE'); accountLevel = inbox.totals ? { conversations: inbox.totals.conversations, qualified: inbox.totals.qualified, requests: inbox.totals.requests, unknownOrigin: null } : null; }
  if (limits.length) return limited(limits, { ...src, accountLevel });
  const rate = counts.unique > 0 && counts.qualified !== null ? round1((counts.qualified / counts.unique) * 100) : null;
  const zero = counts.unique === 0; // a REAL zero: the source covers the window and attributes nothing to this publication
  // BASELINE: other publications that the source observed over the SAME number of days (aggregate rows); threads alone give no comparable period
  const others = inbox.publications.filter((p) => p.postId !== postId && p.observationDays === plan.observationDays && p.conversations > 0 && p.qualified !== null);
  const pooled = others.reduce((a, p) => ({ u: a.u + p.conversations, q: a.q + p.qualified }), { u: 0, q: 0 });
  const baseline = others.length && pooled.u > 0 ? { n: others.length, unique: pooled.u, qualified: pooled.q, rate: round1((pooled.q / pooled.u) * 100), posts: others.map((p) => p.postId) } : null;
  const difference = rate !== null && baseline ? { points: round1(rate - baseline.rate), ratio: baseline.rate > 0 ? Math.round((rate / baseline.rate + Number.EPSILON) * 100) / 100 : null } : null;
  const lowVolume = !zero && counts.unique < cfg.minConversations; const incomplete = counts.unreviewed !== null && counts.unreviewed > 0;
  const next = zero ? { code: 'wait', reason: 'ZERO_CONVERSATIONS' } : counts.qualified === null ? { code: 'wait', reason: 'QUALIFICATION_UNAVAILABLE' } : incomplete ? { code: 'wait', reason: 'QUALIFICATION_INCOMPLETE' } : lowVolume ? { code: 'wait', reason: 'LOW_VOLUME' }
    : !baseline ? { code: 'wait', reason: 'NO_BASELINE' } : baseline.rate > 0 && rate >= baseline.rate * cfg.repeatRatio ? { code: 'repeat', reason: 'ABOVE_BASELINE' } : rate < baseline.rate ? { code: 'adjust', reason: 'BELOW_BASELINE' } : { code: 'wait', reason: 'NOT_DISTINCT' };
  return { ...base, ...src, state: zero ? 'ZERO' : counts.qualified === null ? 'LIMITED' : 'COMPARABLE', limits: counts.qualified === null ? ['QUALIFICATION_UNAVAILABLE'] : [], counts, rate, lowVolume, incomplete, baseline, difference, accountLevel, next };
}

// ---------- the test ----------
const DRAFT = Object.freeze({ quote: 'quoteFirstReply', booking: 'bookingFirstReply', other: 'otherFirstReply' });
/** Items for Opportunités: ONE test per account: invite to a private message in the next Reel, with a first-reply draft the merchant sends HIMSELF. Present even without a connected inbox (manual statement). */
export function inboxItems({ account, inbox = null, diagnosis = null, linkedTestId = null, version = 1 }) {
  const requestType = (inbox && inbox.requestType) || 'quote'; const status = diagnosis ? diagnosis.status : 'NOT_CONNECTED';
  const id = `inbox:${account.network}:${account.id}`; const reading = diagnosis ? diagnosis.reading : null;
  return [{
    id, category: 'inbox', kind: 'inquiryTest', sourcePage: 'inbox', title: { code: 'inbox.title', params: {} }, explanation: { code: `inbox.${status}.why`, params: {} },
    entity: { type: 'socialAccount', id: account.id, title: account.handle ?? account.id },
    evidence: { status, network: account.network, accountId: account.id, handle: account.handle ?? null, goal: GOAL, requestType, grain: reading ? reading.grain : null, source: reading ? reading.source : null, window: reading ? reading.window : null,
      conversations: reading ? reading.conversations : null, attributed: reading ? reading.attributed : null, unknownOrigin: reading ? reading.unknownOrigin : null, qualifiedBySource: reading && reading.qualifiedBySource !== undefined ? reading.qualifiedBySource : null,
      duplicatesDropped: reading ? reading.duplicatesDropped : null, linkedTestId, missing: diagnosis ? diagnosis.missing : ['INBOX_SOURCE'] },
    reliability: 'limited', measurement: reading ? { start: reading.window.start, end: reading.window.end } : null,
    preparedAction: { code: 'inquiryTest', change: 'dmKeyword', network: account.network, accountId: account.id, requestType, keyword: KEYWORD[requestType], draft: { code: DRAFT[requestType] }, observationDays: INBOX_CONFIG.observationDays, linkedTestId, version },
    target: { type: 'socialAccount', available: false, id: account.id }, prerequisites: [], dataBlocker: null }];
}
export { DRAFT as DRAFT_CODE };
