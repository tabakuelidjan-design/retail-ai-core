// Développement des ventes > Abonnés (lot _08): the objective "Gagner des abonnés" for an Instagram or TikTok account, with or without a shop or a site.
// Pure and deterministic: the facts a social source provides (an import contract; see docs/GROWTH_DATA_LINEAGE.md) in, a reading + a test direction + a Creator brief out.
// It reads nothing and publishes nothing. No AI writes a figure, a link or a trend: the ranking and the statuses are the rules below.
//
// WHAT NORDLA CAN REALLY READ TODAY: nothing from Instagram or TikTok. Nordla has publishing adapters (src/activation/providers) but no insights / analytics reading; the
// contract below is what an Instagram / TikTok insights export (or a future connector) provides. Without it the block says NOT_CONNECTED; the preview uses a simulation.
//
// THE FACTS (each with its source, window and network):
//   followers            two comparable totals (start_total, end_total) -> NET VARIATION of the account (end - start). Gained and lost exist only when the source gives them
//                        (null = unavailable; 0 = observed zero). Never derived from the totals.
//   funnel               account-level totals (reach, profile visits, follows): independent totals, NOT a proof that the same people followed the three steps (linked:false).
//   posts                id, url, date, format, organic / sponsored / unknown, hook, topic, structure, and metrics observed at an age: reach, attributed follows (null = unavailable).
//   public_examples      posts of other accounts supplied by the merchant or a connected source, kept with link, network, date, format, hook, topic, structure, metric, window, group, market.
//
// RULE growth-social.1
//   RATE      attributed follows per 1 000 accounts reached = follows / reach * 1000, ONLY when the source gives both on the same perimeter (the post) and reach > 0. Otherwise the rate is
//             unavailable and the account-level net variation stays an account observation.
//   COMPARABLE the same network, the same format, the same paid status (organic only for a direction; sponsored and unknown are listed apart, never mixed) AND the same observation age.
//   SIGNAL    the best organic post of a group beats the pooled rate of the OTHER comparable posts by `signalRatio` (2x) with at least `minReach` accounts reached: an ISOLATED SIGNAL.
//   TREND     only with >= `minTrendExamples` (3) recent concordant examples from >= 2 accounts (own posts + public examples). Otherwise the direction is an IDEA TO TEST and says what is missing.
//   LIMITS    fewer than `minComparable` comparable posts, or attribution missing -> LIMITED: no direction, the account-level reading stays.
export const SOCIAL_RULE = 'growth-social.1';
export const SOCIAL_CONFIG = Object.freeze({ signalRatio: 2, minReach: 500, minComparable: 2, minTrendExamples: 3, minTrendAccounts: 2, observationDays: 7, repeatRatio: 1.5 });
export const NETWORKS = Object.freeze(['instagram', 'tiktok']);
export const NETWORK_NAMES = Object.freeze({ instagram: 'Instagram', tiktok: 'TikTok' });
export const GOAL = 'gain_followers';

const num = (x) => (typeof x === 'number' && Number.isFinite(x) && x >= 0 ? x : null);
const isDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
const round2 = (x) => Math.round((x + Number.EPSILON) * 100) / 100;
const median = (a) => { const s = a.slice().sort((x, y) => x - y); const m = Math.floor(s.length / 2); return s.length ? (s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2) : null; };

/** @returns {{ social: object|null, errors: string[] }} */
export function normalizeSocial(raw) {
  const errors = [];
  if (!raw || typeof raw !== 'object') return { social: null, errors: ['social facts must be a JSON object'] };
  if (!NETWORKS.includes(raw.network)) errors.push('network: instagram or tiktok');
  if (!raw.account || !raw.account.id) errors.push('account.id: required');
  if (!raw.source_system) errors.push('source_system: required');
  const w = raw.window; if (!w || !isDate(w.start) || !isDate(w.end) || w.end <= w.start) errors.push('window: { start, end } as YYYY-MM-DD, end exclusive');
  if (errors.length) return { social: null, errors };
  const f = raw.followers ?? {};
  const posts = (Array.isArray(raw.posts) ? raw.posts : []).filter((p) => p && p.id).map((p) => ({
    id: String(p.id), url: p.url ?? null, network: p.network ?? raw.network, accountId: String(p.account_id ?? raw.account.id), postedAt: p.posted_at ?? null, format: p.format ?? null,
    paid: ['organic', 'sponsored'].includes(p.paid) ? p.paid : 'unknown', hook: p.hook ?? null, topic: p.topic ?? null, structure: p.structure ?? null,
    observed: p.observed ? { ageDays: num(p.observed.age_days), reach: num(p.observed.reach), follows: num(p.observed.follows_attributed), views: num(p.observed.views), interactions: num(p.observed.interactions) } : null }));
  const examples = (Array.isArray(raw.public_examples) ? raw.public_examples : []).filter((e) => e && e.id && e.url).map((e) => ({ id: String(e.id), url: e.url, network: e.network ?? raw.network, account: e.account ?? null, postedAt: e.posted_at ?? null, format: e.format ?? null, hook: e.hook ?? null, topic: e.topic ?? null, structure: e.structure ?? null,
    metric: e.metric ?? null, window: e.window ?? null, group: e.group ?? null, market: e.market ?? null, rate: num(e.follows_per_1000_reach), source: e.source ?? 'merchant' }));
  return { errors, social: { source: raw.source_system, method: raw.method ?? null, network: raw.network, account: { id: String(raw.account.id), handle: raw.account.handle ?? null }, market: raw.market ?? null, timeZone: raw.time_zone ?? null,
    window: { start: w.start, end: w.end }, retrievedAt: raw.retrieved_at ?? null, brand: raw.brand ?? null, capabilities: { trialReels: raw.capabilities?.trial_reels === true },
    followers: { startTotal: num(f.start_total), endTotal: num(f.end_total), gained: num(f.gained), lost: num(f.lost) },
    funnel: raw.funnel ? { reach: num(raw.funnel.reach), profileVisits: num(raw.funnel.profile_visits), follows: num(raw.funnel.follows) } : null, posts, examples, benchmark: raw.benchmark ?? null } };
}

/** The reading of the account: the net variation from two comparable totals; gained / lost only if given; the funnel as independent totals. */
export function readAccount(social) {
  const f = social.followers; const net = f.startTotal !== null && f.endTotal !== null ? f.endTotal - f.startTotal : null;
  return { network: social.network, accountId: social.account.id, handle: social.account.handle, window: social.window, source: social.source, market: social.market,
    netVariation: net, startTotal: f.startTotal, endTotal: f.endTotal, gained: f.gained, lost: f.lost, grossAvailable: f.gained !== null && f.lost !== null,
    funnel: social.funnel ? { ...social.funnel, linked: false } : null };
}

/** attributed follows per 1 000 accounts reached, or null (never from account totals) */
export function ratePer1000(p) { const o = p.observed; return o && o.follows !== null && o.reach !== null && o.reach > 0 ? round2((o.follows / o.reach) * 1000) : null; }
const pooled = (posts) => { const r = posts.reduce((a, p) => a + p.observed.reach, 0); const f = posts.reduce((a, p) => a + p.observed.follows, 0); return { n: posts.length, reach: r, follows: f, rate: r > 0 ? round2((f / r) * 1000) : null }; };
const hasRate = (p) => ratePer1000(p) !== null;
/** posts of the same network, format and paid status observed at the same age */
export const comparableTo = (post, posts) => posts.filter((q) => q.id !== post.id && q.network === post.network && q.format === post.format && q.paid === post.paid && q.observed && post.observed && q.observed.ageDays === post.observed.ageDays && hasRate(q));

/**
 * The diagnosis of the account for the objective "Gagner des abonnés".
 * @returns {{ rule, goal, account, status, posts: object[], groups: object[], direction: object|null, missing: string[] }}
 *   status: NO_POSTS | ATTRIBUTION_UNAVAILABLE | LOW_VOLUME | NO_SIGNAL | SIGNAL (isolated) | TREND
 */
export function diagnoseSocial({ social, config = SOCIAL_CONFIG }) {
  const cfg = { ...SOCIAL_CONFIG, ...config }; const account = readAccount(social);
  const base = { rule: SOCIAL_RULE, goal: GOAL, account, posts: social.posts, groups: [], direction: null, missing: [] };
  if (!social.posts.length) return { ...base, status: 'NO_POSTS' };
  const rated = social.posts.filter((p) => p.observed && p.observed.ageDays !== null && hasRate(p));
  const listed = social.posts.map((p) => ({ id: p.id, url: p.url, format: p.format, paid: p.paid, structure: p.structure, ageDays: p.observed ? p.observed.ageDays : null, reach: p.observed ? p.observed.reach : null, follows: p.observed ? p.observed.follows : null, rate: ratePer1000(p) }));
  if (!rated.length) return { ...base, posts: listed, status: 'ATTRIBUTION_UNAVAILABLE', missing: ['attributedFollows'] };
  const organic = rated.filter((p) => p.paid === 'organic');
  const key = (p) => `${p.network}|${p.format}|${p.observed.ageDays}`; const byKey = new Map();
  for (const p of organic) (byKey.get(key(p)) ?? byKey.set(key(p), []).get(key(p))).push(p);
  const groups = [...byKey.entries()].map(([k, ps]) => ({ key: k, network: ps[0].network, format: ps[0].format, ageDays: ps[0].observed.ageDays, paid: 'organic', ...pooled(ps), posts: ps.map((p) => p.id) })).sort((a, b) => b.n - a.n || a.key.localeCompare(b.key));
  const other = { sponsored: rated.filter((p) => p.paid === 'sponsored').length, unknown: rated.filter((p) => p.paid === 'unknown').length };
  const out = { ...base, posts: listed, groups, otherStatuses: other };
  const group = groups.find((g) => g.n >= cfg.minComparable);
  if (!group) return { ...out, status: 'LOW_VOLUME', missing: ['comparablePosts'] };
  const ps = organic.filter((p) => key(p) === group.key).sort((a, b) => ratePer1000(b) - ratePer1000(a) || a.id.localeCompare(b.id));
  const top = ps[0]; const rest = ps.slice(1); const baseline = pooled(rest);
  if (!(top.observed.reach >= cfg.minReach) || baseline.rate === null || baseline.rate <= 0 && ratePer1000(top) <= 0) return { ...out, status: 'NO_SIGNAL', baseline };
  const ratio = baseline.rate > 0 ? round2(ratePer1000(top) / baseline.rate) : null;
  if (ratio === null || ratio < cfg.signalRatio) return { ...out, status: 'NO_SIGNAL', baseline, topPost: top.id, ratio };
  // trend: recent concordant examples from several accounts (own posts at the same structure + public examples that beat their own group)
  const concordantOwn = ps.filter((p) => p.structure && p.structure === top.structure && ratePer1000(p) >= baseline.rate * cfg.signalRatio);
  const concordantPublic = social.examples.filter((e) => e.structure && e.structure === top.structure && e.format === top.format && e.network === top.network);
  const accounts = new Set([social.account.id, ...concordantPublic.map((e) => e.account).filter(Boolean)]);
  const trend = concordantOwn.length + concordantPublic.length >= cfg.minTrendExamples && accounts.size >= cfg.minTrendAccounts;
  const missing = trend ? [] : [...(concordantOwn.length + concordantPublic.length < cfg.minTrendExamples ? ['moreConcordantExamples'] : []), ...(accounts.size < cfg.minTrendAccounts ? ['otherAccounts'] : [])];
  return { ...out, status: trend ? 'TREND' : 'SIGNAL', baseline, ratio, topPost: top.id, missing,
    direction: { kind: trend ? 'trend' : 'idea', network: top.network, format: top.format, structure: top.structure, topic: top.topic, hook: top.hook, evidencePosts: [top.id, ...rest.map((p) => p.id)], group: { key: group.key, n: group.n, ageDays: group.ageDays }, ratio, rate: ratePer1000(top), baselineRate: baseline.rate, publicExamples: concordantPublic.map((e) => e.id) } };
}
