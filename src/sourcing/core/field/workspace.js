// FIELD WORKSPACE: what Nordla keeps BESIDE the cases so the owner can close the application and resume exactly where he was. The cases stay the single source of truth (offers, evidence, reviews,
// notes, samples all live in them); the workspace holds only what is not a fact about one case: the saved comparisons (a definition: which cases, as of when), the recorded history of what Nordla
// RECOMMENDED / how it judged the fit / what the deal looked like at each change (append-only, so the old answer is never lost), the owner's progress through the ASK NEXT list, the supplier index
// (references to cases) and the last place he was looking at.
// It is plain JSON, every record has a content-derived id, and two copies (phone and server) MERGE without loss: nothing here is ever overwritten by a stale copy.
import { contentHash } from './offer-import.js';
import { comparisonDefinition } from '../comparison.js';
import { supplierKey } from './memory.js';

export const WORKSPACE_SCHEMA = 1;
export const SNAPSHOT_KINDS = Object.freeze(['recommendation', 'merchantFit', 'deal', 'evidenceStatus', 'askNow']);
export const SNAPSHOT_CAP = 100; // per case and kind: the newest are kept; a recommendation history longer than this is trimmed from the oldest end only
const clone = (x) => JSON.parse(JSON.stringify(x));
// chronological order of a history: by time, then by the order of recording (two records can share a timestamp), then by id so that every copy sorts the same way
const byTime = (a, b) => String(a.at).localeCompare(String(b.at)) || (a.seq ?? 0) - (b.seq ?? 0) || a.id.localeCompare(b.id);

export function newWorkspace(now = new Date()) {
  return { schema: WORKSPACE_SCHEMA, rev: 0, createdAt: now.toISOString(), updatedAt: now.toISOString(), comparisons: {}, snapshots: {}, askState: {}, suppliers: {}, views: { lastCaseId: null, lastComparisonId: null, lastScreen: null, at: null } };
}
const touch = (ws, now) => { ws.updatedAt = now.toISOString(); return ws; };
const upgrade = (ws) => { const w = ws && ws.schema ? clone(ws) : newWorkspace(); w.comparisons ??= {}; w.snapshots ??= {}; w.askState ??= {}; w.suppliers ??= {}; w.views ??= { lastCaseId: null, lastComparisonId: null, lastScreen: null, at: null }; return w; };

/** Saves (or refreshes) a comparison: the DEFINITION plus a small summary kept so the list opens instantly and offline. The set itself is always recomputed from the cases. */
export function saveComparison(ws0, set, { now = new Date(), name = null, fieldView = null } = {}) {
  const ws = upgrade(ws0); const def = comparisonDefinition(set); const prev = ws.comparisons[def.id];
  ws.comparisons[def.id] = { ...def, name: name ?? prev?.name ?? null, createdAt: prev?.createdAt ?? now.toISOString(), updatedAt: now.toISOString(), summary: { headline: fieldView?.summary?.headline ?? null, preferredCaseId: set.summary.preferredCaseId, noWinnerReason: set.summary.noWinnerReason, counts: set.summary.counts, recommendations: set.candidates.map((c) => ({ caseId: c.caseId, value: c.recommendation.value, role: c.role })), openConflicts: set.summary.openConflicts } };
  ws.views = { ...ws.views, lastComparisonId: def.id, at: now.toISOString() }; return touch(ws, now);
}
export const listComparisons = (ws) => Object.values(ws?.comparisons ?? {}).sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
export function removeComparison(ws0, id, now = new Date()) { const ws = upgrade(ws0); delete ws.comparisons[id]; if (ws.views.lastComparisonId === id) ws.views.lastComparisonId = null; ws.tombstones = { ...(ws.tombstones ?? {}), [id]: now.toISOString() }; return touch(ws, now); }

/** Appends ONE snapshot to the history of a case, unless the same inputs were already recorded (the id is derived from the content, so recording twice changes nothing). */
export function recordSnapshot(ws0, { caseId, kind, fingerprint, at, value, summary = null, extra = {} }, now = new Date()) {
  if (!SNAPSHOT_KINDS.includes(kind)) throw new Error(`unknown snapshot kind: ${kind}`);
  const ws = upgrade(ws0); const list = ((ws.snapshots[caseId] ??= {})[kind] ??= []); const id = `snap-${kind}-${contentHash(`${caseId}|${kind}|${fingerprint}`)}`;
  if (list.some((s) => s.id === id)) return { ws, recorded: false, id };
  list.push({ id, caseId, kind, fingerprint, at: at ?? now.toISOString(), recordedAt: now.toISOString(), seq: list.reduce((m, x) => Math.max(m, x.seq ?? 0), 0) + 1, value, summary, ...extra });
  list.sort(byTime); if (list.length > SNAPSHOT_CAP) list.splice(0, list.length - SNAPSHOT_CAP);
  return { ws: touch(ws, now), recorded: true, id };
}
export const history = (ws, caseId, kind) => (ws?.snapshots?.[caseId]?.[kind] ?? []).slice();
export const latestSnapshot = (ws, caseId, kind) => history(ws, caseId, kind).at(-1) ?? null;

/**
 * After refreshDerived(): records, for this case, the recommendation / fit / deal / evidence status / ask list ONLY when the inputs behind them changed since the last record.
 * The older records stay: this is how "what did Nordla say before the supplier changed the price?" keeps its answer.
 */
export function recordFromDerived(ws0, state, derived, now = new Date()) {
  let ws = upgrade(ws0); const out = []; const r = derived.results; const f = derived.fingerprints;
  const rev = (state.offers ?? []).length;
  const put = (kind, node, value, summary, extra = {}) => { if (!r[node] || !f[node]) return; const x = recordSnapshot(ws, { caseId: state.id, kind, fingerprint: f[node], at: now.toISOString(), value, summary, extra: { offers: rev, ...extra } }, now); ws = x.ws; if (x.recorded) out.push(kind); };
  if (r.recommendation) put('recommendation', 'recommendation', r.recommendation.value, `${r.recommendation.value}: ${r.recommendation.why}`, { role: r.recommendation.role, verdict: r.recommendation.verdict, evidenceCompleteness: r.evidenceStatus?.evidenceCompleteness ?? null, status: r.recommendation.status, offerId: state.offers.at(-1)?.id ?? null });
  if (r.merchantFit) put('merchantFit', 'merchantFit', r.merchantFit, `${r.merchantFit.label} (${r.merchantFit.counts.supported} supported, ${r.merchantFit.counts.unknown} unknown)`);
  if (r.deal) put('deal', 'deal', r.deal, `landed ${r.deal.landed.display ?? 'unknown'}, max ${r.deal.maxPurchasePrice.display ?? 'unknown'}`);
  if (r.evidenceStatus) put('evidenceStatus', 'evidenceStatus', r.evidenceStatus, `${r.evidenceStatus.evidenceCompleteness}: ${r.evidenceStatus.blocking.length} blocking`);
  if (r.askNow) put('askNow', 'askNow', r.askNow.items.map((i) => ({ id: i.id, kind: i.kind, state: i.state })), `${r.askNow.items.length} question(s) to ask`);
  ws.suppliers = { ...ws.suppliers }; const k = supplierKey(state.supplier?.name); if (k) ws.suppliers[k] = { key: k, names: [...new Set([...(ws.suppliers[k]?.names ?? []), state.supplier.name])].sort(), caseIds: [...new Set([...(ws.suppliers[k]?.caseIds ?? []), state.id])].sort() };
  return { ws, recorded: out };
}

export function setAskState(ws0, caseId, questionId, state, now = new Date()) {
  if (!['OPEN', 'ASKED', 'ANSWERED', 'SKIPPED'].includes(state)) throw new Error('ask state must be OPEN, ASKED, ANSWERED or SKIPPED');
  const ws = upgrade(ws0); (ws.askState[caseId] ??= {})[questionId] = { state, at: now.toISOString() }; return touch(ws, now);
}
export const askStateOf = (ws, caseId) => ws?.askState?.[caseId] ?? {};
export function setView(ws0, view, now = new Date()) { const ws = upgrade(ws0); ws.views = { ...ws.views, ...view, at: now.toISOString() }; return touch(ws, now); }

/** Merge two copies (phone / server) with no loss: comparisons and ask states keep the newest, snapshots are the union by id, suppliers the union. Commutative, associative, idempotent. */
export function mergeWorkspaces(a0, b0) {
  const a = upgrade(a0); const b = upgrade(b0); const out = newWorkspace(new Date(Math.min(Date.parse(a.createdAt) || Date.now(), Date.parse(b.createdAt) || Date.now())));
  const tomb = { ...(a.tombstones ?? {}), ...(b.tombstones ?? {}) }; for (const k of Object.keys(tomb)) tomb[k] = [a.tombstones?.[k], b.tombstones?.[k]].filter(Boolean).sort().at(-1);
  for (const id of [...new Set([...Object.keys(a.comparisons), ...Object.keys(b.comparisons)])].sort()) { const x = a.comparisons[id]; const y = b.comparisons[id]; const pick = !x ? y : !y ? x : String(x.updatedAt) >= String(y.updatedAt) ? x : y; if (!tomb[id] || String(pick.updatedAt) > tomb[id]) out.comparisons[id] = clone(pick); }
  for (const caseId of [...new Set([...Object.keys(a.snapshots), ...Object.keys(b.snapshots)])].sort()) for (const kind of SNAPSHOT_KINDS) { const m = new Map(); for (const s of [...(a.snapshots[caseId]?.[kind] ?? []), ...(b.snapshots[caseId]?.[kind] ?? [])]) if (!m.has(s.id)) m.set(s.id, clone(s)); if (m.size) { const list = [...m.values()].sort(byTime); ((out.snapshots[caseId] ??= {})[kind]) = list.slice(-SNAPSHOT_CAP); } }
  for (const caseId of [...new Set([...Object.keys(a.askState), ...Object.keys(b.askState)])].sort()) { const qs = {}; for (const q of [...new Set([...Object.keys(a.askState[caseId] ?? {}), ...Object.keys(b.askState[caseId] ?? {})])].sort()) { const x = a.askState[caseId]?.[q]; const y = b.askState[caseId]?.[q]; qs[q] = !x ? y : !y ? x : String(x.at) >= String(y.at) ? x : y; } out.askState[caseId] = qs; }
  for (const k of [...new Set([...Object.keys(a.suppliers), ...Object.keys(b.suppliers)])].sort()) { const x = a.suppliers[k]; const y = b.suppliers[k]; out.suppliers[k] = { key: k, names: [...new Set([...(x?.names ?? []), ...(y?.names ?? [])])].sort(), caseIds: [...new Set([...(x?.caseIds ?? []), ...(y?.caseIds ?? [])])].sort() }; }
  out.views = String(a.views.at ?? '') >= String(b.views.at ?? '') ? clone(a.views) : clone(b.views); if (Object.keys(tomb).length) out.tombstones = tomb;
  out.rev = Math.max(a.rev, b.rev); out.updatedAt = [a.updatedAt, b.updatedAt].sort().at(-1); return out;
}
