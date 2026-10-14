// SUPPLIER MEMORY. How a supplier has behaved over time, read from what is ALREADY recorded: the offer revisions, the evidence ledger, the conflicts, the document statements, the question log
// and the sample records. Nothing is copied into a second store: every line carries a reference (case, offer, ledger entry) so the authoritative record is one tap away.
// "Behaviour" here is descriptive (what changed, what was promised and not delivered), never a judgement about the person.
import { offerRevisions, movementOf, termsDiff } from './revisions.js';
import { documentStatusOf } from '../provenance.js';
import { documentModelConflicts } from '../conflicts.js';
import { sampleState } from './external-evidence.js';

export const supplierKey = (name) => String(name ?? '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/\b(co|ltd|limited|company|inc|corp|trading|factory|llc)\b\.?/g, ' ').replace(/[^a-z0-9一-鿿]+/g, ' ').trim();
const ref = (state, extra = {}) => ({ caseId: state.id, ...extra });

/** The behaviour of the supplier in ONE case. @param {object} state the case @param {object} a its assessment */
export function behaviourMemory(state, a) {
  const revs = offerRevisions(state); const moves = movementOf(state); const byField = (f) => moves.find((m) => m.field === f) ?? null;
  const changes = []; for (let i = 1; i < revs.length; i += 1) for (const c of termsDiff(revs[i - 1].terms, revs[i].terms)) if (c.kind === 'CHANGED') changes.push({ ...c, fromRevision: revs[i - 1].n, toRevision: revs[i].n, at: revs[i].at, ref: ref(state, { offerId: revs[i].offerId }) });
  const sup = state.ledger.filter((e) => e.supersedes === true).map((e) => ({ key: e.key, from: e.previousValue, to: e.value, at: e.confirmedAt, ref: ref(state, { ledgerId: e.id, offerId: e.offerId ?? null }) }));
  // material: every statement, and every disagreement
  const materials = state.ledger.filter((e) => e.key === 'spec.material').map((e) => ({ value: e.value, status: e.status, at: e.confirmedAt, ref: ref(state, { ledgerId: e.id, offerId: e.offerId ?? null }) }));
  const matConflicts = state.conflicts.filter((c) => c.key === 'spec.material');
  const materialChanged = new Set(materials.map((m) => String(m.value))).size > 1 || matConflicts.length > 0;
  // certificates: said / promised vs received
  const claimKeys = [...new Set([...(state.documentLedger ?? []).map((d) => d.claim)])]; const certificates = claimKeys.map((claim) => {
    const hist = state.documentLedger.filter((d) => d.claim === claim); const st = documentStatusOf(state, claim); const statedIn = new Set(hist.map((d) => d.source?.candidateId && state.candidates.find((c) => c.id === d.source.candidateId)?.offerId).filter(Boolean));
    const open = ['CLAIMED', 'PROMISED', 'NONE', 'NOT_AVAILABLE'].includes(st.status);
    return { claim, statements: hist.length, offers: statedIn.size, current: st.status, received: st.received, matched: st.matched, repeatedWithoutDocument: open && st.received === 0 && (hist.length >= 2 || statedIn.size >= 2), ref: ref(state, { claim }) };
  });
  const contradictory = { open: state.conflicts.filter((c) => c.state === 'OPEN').map((c) => ({ key: c.key, entries: c.entries.map((e) => ({ value: e.value, from: e.from })), ref: ref(state, { conflictId: c.id }) })), resolved: state.conflicts.filter((c) => c.state === 'RESOLVED').length, documents: documentModelConflicts(state).map((d) => ({ docId: d.docId, docModels: d.docModels, caseModel: d.caseModel, result: d.result, ref: ref(state, { docId: d.docId }) })) };
  // questions asked and still unanswered (the engine regenerates a question only while the information is still missing)
  const shown = new Set(state.questionLog.filter((e) => e.kind === 'SHOWN').map((e) => e.questionId)); const stillOpen = (a?.questions ?? []).filter((q) => shown.has(q.id));
  const unanswered = stillOpen.map((q) => ({ questionId: q.id, priority: q.priority, topic: q.topic, timesShown: state.questionLog.filter((e) => e.kind === 'SHOWN' && e.questionId === q.id).length, ref: ref(state, { questionId: q.id }) }));
  const reviews = { confirmed: state.candidates.filter((c) => c.state === 'CONFIRMED').length, corrected: state.candidates.filter((c) => c.state === 'CORRECTED').length, rejected: state.candidates.filter((c) => c.state === 'REJECTED').length, pending: state.candidates.filter((c) => c.state === 'PROPOSED').length, conflicts: state.candidates.filter((c) => c.state === 'CONFLICT').length };
  const notes = [];
  if (byField('moq')) notes.push(`MOQ changed ${byField('moq').times} time(s): ${byField('moq').values.join(' -> ')}`);
  if (byField('priceAtQty') || byField('tiers')) notes.push(`price moved ${(byField('priceAtQty')?.times ?? 0) + (byField('tiers')?.times ?? 0)} time(s)`);
  if (materialChanged) notes.push('the material was stated differently');
  if (certificates.some((c) => c.repeatedWithoutDocument)) notes.push(`certificate claimed repeatedly without a document: ${certificates.filter((c) => c.repeatedWithoutDocument).map((c) => c.claim).join(', ')}`);
  if (contradictory.open.length) notes.push(`${contradictory.open.length} contradictory statement(s) not resolved`);
  if (unanswered.some((u) => u.priority === 'P1')) notes.push(`${unanswered.filter((u) => u.priority === 'P1').length} important question(s) asked and still unanswered`);
  return { type: 'BehaviourMemory', caseId: state.id, revisions: revs.length, changes, changedMoq: byField('moq'), changedPrice: byField('priceAtQty') ?? byField('tiers'), changedLeadTime: byField('leadDays'), changedMaterial: materialChanged ? { statements: materials, conflicts: matConflicts.map((c) => ({ id: c.id, state: c.state })) } : null, supersededTerms: sup,
    certificates, missingCertificateRepeatedly: certificates.filter((c) => c.repeatedWithoutDocument).map((c) => c.claim), contradictory, unansweredCritical: unanswered.filter((u) => u.priority === 'P1'), unansweredOther: unanswered.filter((u) => u.priority !== 'P1'), reviews, sample: sampleState(state), notes, descriptive: true };
}

/**
 * Everything on record about one SUPPLIER across the cases that name it (the same supplier can have several products). References, not copies.
 * @param {object[]} cases  @param {{ recommendations?: object[] }} extra recommendation snapshots from the workspace (they are history Nordla recorded at the time)
 */
export function supplierHistory(cases, { recommendations = [] } = {}) {
  const groups = new Map(); for (const c of cases) { const k = supplierKey(c.supplier?.name); if (!k) continue; (groups.get(k) ?? groups.set(k, []).get(k)).push(c); }
  return [...groups.entries()].sort(([x], [y]) => x.localeCompare(y)).map(([key, list]) => {
    const offers = list.flatMap((c) => (c.offers ?? []).map((o) => ({ caseId: c.id, offerId: o.id, seq: o.seq, kind: o.kind, source: o.source, at: o.importedAt })));
    const mem = list.map((c) => ({ caseId: c.id, memory: behaviourMemory(c, null) }));
    return { type: 'SupplierHistory', key, names: [...new Set(list.map((c) => c.supplier.name))], cases: list.map((c) => ({ caseId: c.id, product: c.identity?.workingName ?? '', model: c.identity?.identifiers?.model ?? null })), offers: offers.sort((p, q) => String(p.at).localeCompare(String(q.at))),
      priceChanges: mem.flatMap((m) => (m.memory.changedPrice ? [{ caseId: m.caseId, ...m.memory.changedPrice }] : [])), moqChanges: mem.flatMap((m) => (m.memory.changedMoq ? [{ caseId: m.caseId, ...m.memory.changedMoq }] : [])), materialChanges: mem.flatMap((m) => (m.memory.changedMaterial ? [{ caseId: m.caseId, ...m.memory.changedMaterial }] : [])),
      promisedCertificates: mem.flatMap((m) => m.memory.certificates.map((c) => ({ caseId: m.caseId, claim: c.claim, current: c.current, matched: c.matched, ref: c.ref }))), missingDocuments: mem.flatMap((m) => m.memory.missingCertificateRepeatedly.map((claim) => ({ caseId: m.caseId, claim }))),
      samples: list.map((c) => ({ caseId: c.id, ...sampleState(c) })).filter((s) => s.status !== 'NONE'), reviewOutcomes: mem.reduce((acc, m) => { for (const k of Object.keys(m.memory.reviews)) acc[k] = (acc[k] ?? 0) + m.memory.reviews[k]; return acc; }, {}),
      previousRecommendations: recommendations.filter((r) => list.some((c) => c.id === r.caseId)).map((r) => ({ caseId: r.caseId, value: r.value, at: r.at, fingerprint: r.fingerprint, ref: { caseId: r.caseId, snapshotId: r.id } })), notes: mem.flatMap((m) => m.memory.notes.map((n) => `${m.caseId}: ${n}`)), authoritative: 'cases', duplicatesNothing: true };
  });
}
