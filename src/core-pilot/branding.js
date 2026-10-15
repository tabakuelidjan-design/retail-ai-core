// Branding in Nordla Core, with Branding's OWN lifecycle (src/branding): proposal -> owner approval -> Brand Guardian. Nothing new is decided
// here. The merchant's proposal is DATA (config/merchants/<id>/brand-proposal.json). Until the OWNER approves it (role from the Nordla
// session, recorded), a check says RULES_NOT_APPROVED: the proposed rules are shown as an indicative preview, never as a verdict.
// After approval the Guardian (pure, deterministic) gives the verdict; nothing is published or executed (Guardian never decides).
import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  approveBrandCore, approveBrandMemory, buildBrandContext, buildBrandCoreProposal, buildBrandIdentity, buildBrandMemoryDraft,
  evaluateBrandGuardian, normalizeBrandSnapshot, submitBrandMemoryForReview,
} from '../branding/index.js';
import { normalizeMatchText } from '../branding/candidate-manifest.js';

const uuidFrom = (s) => { const h = createHash('sha256').update(s).digest('hex'); return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`; };

export async function loadBrandProposal(env = {}, root = process.cwd()) {
  const id = String(env.SOURCING_MERCHANT_ID ?? '').trim();
  if (!/^[a-z0-9][a-z0-9_-]{0,40}$/.test(id)) return null;
  try { return JSON.parse(await readFile(join(root, 'config', 'merchants', id, 'brand-proposal.json'), 'utf8')); } catch { return null; }
}

/**
 * @param {{ merchantId: string, proposal: object|null, file: string, now?: () => string }} o
 *   file = where the approved Core + Memory are kept (the server's volume), written only by approve()
 */
export function createBrandingService({ merchantId, proposal, file, now = () => new Date().toISOString() }) {
  const tenant = { merchantId, source: 'env' };
  const created = '2026-10-15T12:00:00.000Z'; // the proposal's own date: same inputs = same documents
  const brand = proposal ? buildBrandIdentity({ tenant, brandId: uuidFrom(`brand:${merchantId}:${proposal.brandName}`), name: proposal.brandName, createdAt: created, defaultLocale: proposal.locale, supportedLocales: proposal.supportedLocales }) : null;
  const snapshot = proposal ? normalizeBrandSnapshot({
    id: `snapshot-${proposal.merchantId}-1`, merchant_id: merchantId, brand_id: brand.brand_id, version: 1, status: 'READY', created_at: created, observed_at: created,
    evidence: proposal.evidence.map((e) => ({ id: e.id, provenance: 'observed', statement: e.statement, completeness: 'COMPLETE', source: { system: e.source, observed_at: created, kind: 'MERCHANT_PROVIDED' } })),
  }) : null;
  const coreProposal = proposal ? buildBrandCoreProposal({ id: `core-${proposal.merchantId}-v1`, tenant, brand, createdAt: created, snapshot, decisions: proposal.decisions }).core : null;
  const rules = proposal ? proposal.hard_rules.map(({ why, ...r }) => ({ ...r, source_ref: `brand-core://core-${proposal.merchantId}-v1` })) : [];
  let approved = null; let loaded = false;

  async function state() {
    if (!loaded) { try { approved = JSON.parse(await readFile(file, 'utf8')); } catch { approved = null; } loaded = true; }
    return approved;
  }

  async function status() {
    if (!proposal) return { status: 'NO_PROPOSAL', note: 'Aucune proposition de règles de marque pour ce marchand.' };
    const a = await state();
    return {
      status: a ? 'APPROVED' : 'PROPOSED_NOT_APPROVED', approvedAt: a?.approvedAt ?? null, approvedBy: a?.approvedBy ?? null,
      positioning: proposal.decisions.positioning, voice: proposal.decisions.voice, exclusions: proposal.decisions.exclusions,
      rules: proposal.hard_rules.map((r) => ({ id: r.id, forbidden: r.value, severity: r.severity, why: r.why })),
      questions: proposal.questions_for_owner, evidence: proposal.evidence.map((e) => e.source),
    };
  }

  /** The OWNER approves the proposal: Branding's own approveBrandCore / approveBrandMemory, with the signed-in person as approver. */
  async function approve(actor) {
    if (!proposal) throw Object.assign(new Error('Aucune proposition à approuver.'), { code: 'NO_PROPOSAL', status: 404 });
    if (actor?.role !== 'OWNER' || !actor.userId) throw Object.assign(new Error('Seul le propriétaire connecté peut approuver les règles de marque.'), { code: 'APPROVAL_ROLE_REQUIRED', status: 403 });
    if (await state()) throw Object.assign(new Error('Les règles sont déjà approuvées.'), { code: 'ALREADY_APPROVED', status: 409 });
    const at = now(); const resolvedActor = { user_id: actor.userId, role: 'OWNER', merchant_id: merchantId };
    const core = approveBrandCore({ proposal: coreProposal, snapshot, tenant, brand, resolvedActor, activeCore: null, approvedAt: at }).approvedCore;
    const draft = buildBrandMemoryDraft({ tenant, brand, id: `memory-${proposal.merchantId}-v1`, createdAt: at, core, content: { hard_rules: rules } }).memory;
    const memory = approveBrandMemory({ memory: submitBrandMemoryForReview({ memory: draft, core, tenant, brand }), core, tenant, brand, resolvedActor, approvedAt: at }).approvedMemory;
    const doc = { approvedAt: at, approvedBy: `user:${actor.userId}`, core, memory };
    await mkdir(dirname(file), { recursive: true }); await writeFile(`${file}.tmp`, JSON.stringify(doc), { mode: 0o600 }); await rename(`${file}.tmp`, file);
    approved = doc; return status();
  }

  /** Check a text (campaign copy, caption...). Approved rules -> the Guardian's verdict. Otherwise an indicative preview, labelled as such. */
  async function checkText(text) {
    const fragments = String(text ?? '').split(/\n+/).map((s) => s.trim()).filter(Boolean);
    if (!proposal) return { status: 'NO_PROPOSAL', official: false, findings: [] };
    const a = await state();
    if (!a) {
      const t = normalizeMatchText(fragments.join(' '));
      const findings = proposal.hard_rules.filter((r) => t.includes(normalizeMatchText(r.value))).map((r) => ({ rule: r.id, forbidden: r.value, severity: r.severity, why: r.why }));
      return { status: 'RULES_NOT_APPROVED', official: false, preview: findings.length ? 'WOULD_FLAG' : 'NOTHING_FLAGGED', findings, note: 'Aperçu indicatif : les règles de marque HABB ne sont pas encore approuvées par le propriétaire.' };
    }
    const context = buildBrandContext({ tenant, brand, core: a.core, memory: a.memory, snapshot });
    const report = evaluateBrandGuardian({ tenant, brandContext: context, candidateManifest: { content_kind: 'TEXT', text: [{ subject: 'body', coverage: 'COMPLETE', values: fragments, evidence_refs: [] }] }, targetRef: `text://${createHash('sha256').update(fragments.join('\n')).digest('hex').slice(0, 16)}`, evaluatedAt: now() });
    return { status: 'CHECKED', official: true, outcome: report.outcome, findings: report.rule_results.filter((r) => r.outcome !== 'PASS').map((r) => ({ rule: r.rule_id, outcome: r.outcome, reason: r.reason })), report_ref: report.report_id ?? null };
  }

  return Object.freeze({ status, approve, checkText, approvedClaims: () => [] /* no product claim is approved until the catalogue provides them */ });
}
