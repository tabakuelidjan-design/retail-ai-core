// Développement des ventes > Demandes - server sources for ONE tenant (the merchant is fixed by the server context). One entry per social account (Instagram, TikTok).
// The facts come from an injectable `load()` per network (today: a manual statement / aggregated import file data/local/marketing/inbox-<network>.json; later a messaging connector). READ ONLY:
// nothing is sent, no conversation is answered, no account is changed. Only conversation ids (opaque) and aggregates are kept: no message text, no customer name.
//   - no loader / no file: NOT_CONNECTED for that network, and the test is STILL offered (the merchant can state the conversations himself)
//   - facts failing the contract: INVALID;  unreadable: UNAVAILABLE;  otherwise OK: the reading, the status and the item.
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { normalizeInbox, diagnoseInbox, inboxItems, reviewInquiry, INBOX_CONFIG, INBOX_RULE, NETWORKS } from '../inbox/inbox.js';

export const inboxFile = (network) => `data/local/marketing/inbox-${network}.json`;
export const fileInboxLoader = (network, path = inboxFile(network)) => async () => { try { return JSON.parse(await readFile(path, 'utf8')); } catch (e) { if (e?.code === 'ENOENT') return null; throw e; } };

export const merchantRefOf = (merchantId) => createHash('sha256').update(String(merchantId)).digest('hex');
// THE MERCHANT OF AN IMPORT. When the server has a merchant context, a file that names ANOTHER merchant (merchant_ref) is refused (MERCHANT_MISMATCH), and a file that names none is refused too when the
// context requires proof (MERCHANT_UNKNOWN: its origin cannot be established). Nothing of a refused file is read further: no conversation, no qualification, no item.
async function read(load, network, ctx = {}) {
  if (typeof load !== 'function') return { state: 'NOT_CONNECTED' };
  let raw = null; try { raw = await load(); } catch (e) { const reason = typeof e?.code === 'string' && /^[A-Z_]+$/.test(e.code) ? e.code : null; console.error(`growth inbox (${network}): source unavailable:`, reason ?? 'unreadable'); return { state: 'UNAVAILABLE', reason }; }
  if (!raw) return { state: 'NOT_CONNECTED' };
  const { inbox, errors } = normalizeInbox(raw);
  if (!inbox) return { state: 'INVALID', errors };
  if (inbox.network !== network) return { state: 'INVALID', errors: [`network: expected ${network}`] };
  if (ctx.merchantRef) {
    if (inbox.merchantRef && inbox.merchantRef !== ctx.merchantRef) return { state: 'INVALID', errors: ['MERCHANT_MISMATCH'] };
    if (!inbox.merchantRef && ctx.requireProof) return { state: 'INVALID', errors: ['MERCHANT_UNKNOWN'] };
  }
  return { state: 'OK', inbox };
}

/**
 * @param {{ loaders?: Record<string, Function>, accounts?: () => Promise<Array<{ network: string, id: string, handle?: string|null, linkedTestId?: string|null }>>, now?: () => Date, config?: object, cacheMs?: number }} p
 *   accounts: the social accounts known to Growth (lot _08), so the test is offered even when no inbox file exists; a file carrying its own account is used as well.
 */
export function createInboxSource({ loaders = {}, accounts = async () => [], now = () => new Date(), config = INBOX_CONFIG, cacheMs = 5 * 60_000, publications = null, merchantId = null, requireMerchantProof = Boolean(merchantId) } = {}) {
  const ctx = { merchantRef: merchantId ? merchantRefOf(merchantId) : null, requireProof: requireMerchantProof };
  let cached = null; let cachedAt = 0;
  // the state of the LINKED social test in Publication sociale (lot _09), read fresh: the publication the conversations are attributed to, its real day, its versions
  const withPublications = async (c) => { if (!publications) return c; const linked = c.items.filter((i) => i.evidence.linkedTestId).map((i) => ({ ...i, id: i.evidence.linkedTestId })); if (!linked.length) return c; const m = await publications(linked); return { ...c, items: c.items.map((i) => (i.evidence.linkedTestId && m.has(i.evidence.linkedTestId) ? { ...i, publication: m.get(i.evidence.linkedTestId) } : i)) }; };
  return async function inbox() {
    const t = now(); if (cached && t.getTime() - cachedAt < cacheMs) return withPublications(cached);
    let known = []; try { known = await accounts(); } catch { known = []; }
    const out = []; const items = [];
    for (const network of NETWORKS) {
      const r = await read(loaders[network], network, ctx); const k = known.find((a) => a.network === network) ?? (network === 'instagram' && r.state !== 'INVALID' ? { id: 'manual', handle: null, linkedTestId: null } : null); // no Instagram account known and no import: the test is still offered, for a manual statement (the account is stated by the merchant, nothing is read)
      if (r.state !== 'OK') {
        out.push({ network, state: r.state, ...(r.reason ? { reason: r.reason } : {}), ...(r.errors ? { errors: r.errors } : {}), ...(r.state === 'NOT_CONNECTED' ? { missing: ['INBOX_CONNECTION'] } : {}), ...(k ? { accountId: k.id, handle: k.handle ?? null } : {}) });
        if (k && r.state !== 'INVALID') items.push(...inboxItems({ account: { network, id: k.id, handle: k.handle ?? null }, linkedTestId: k.linkedTestId ?? null }));
        continue;
      }
      const d = diagnoseInbox({ inbox: r.inbox, config });
      out.push({ network, state: 'OK', accountId: r.inbox.account.id, handle: r.inbox.account.handle, source: r.inbox.source, market: r.inbox.market, window: r.inbox.window, retrievedAt: r.inbox.retrievedAt, diagnosis: d, threads: threadsView(r.inbox) });
      items.push(...inboxItems({ account: { network, id: r.inbox.account.id, handle: r.inbox.account.handle }, inbox: r.inbox, diagnosis: d, linkedTestId: k?.linkedTestId ?? null }));
    }
    cached = { rule: INBOX_RULE, generatedAt: t.toISOString(), state: out.some((a) => a.state === 'OK') ? 'OK' : 'NOT_CONNECTED', accounts: out, items };
    cachedAt = t.getTime(); return withPublications(cached);
  };
}

// what the screen needs to let the merchant qualify: the opaque id, the day, the number of messages, the provenance and the SOURCE's own state (no text, no name)
const threadsView = (inbox) => inbox.threads.slice(0, 200).map((c) => ({ id: c.id, startedAt: c.startedAt, messages: c.messages, origin: c.origin.kind === 'post' ? { postId: c.origin.postId, attribution: c.origin.attribution } : null, source: c.source, requestId: c.requestId }));

const ids = (s) => (typeof s === 'string' && s ? s.split(',').filter((x) => /^[\w.:-]{1,80}$/.test(x)).slice(0, 200) : []);
/** GET /api/growth/review?type=inbox: the review of the test (declared publication id, real publication day, planned network / account / days / type, the merchant's qualifications as id lists). */
export function createInboxReviewSource({ loaders = {}, now = () => new Date(), config = INBOX_CONFIG, merchantId = null, requireMerchantProof = Boolean(merchantId) } = {}) {
  const ctx = { merchantRef: merchantId ? merchantRefOf(merchantId) : null, requireProof: requireMerchantProof };
  return async function inboxReview({ id, network, account, days, from, type, qualified, notQualified, declared }) {
    const r = await read(loaders[network], network, ctx);
    return reviewInquiry({ inbox: r.state === 'OK' ? r.inbox : null, plan: { network, accountId: account, observationDays: Number(days), requestType: type ?? null }, postId: id, from, now: now(), config,
      qualification: { qualified: ids(qualified), notQualified: ids(notQualified), declared: ids(declared) } });
  };
}
