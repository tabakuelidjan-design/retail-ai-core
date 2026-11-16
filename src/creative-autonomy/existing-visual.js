// THE "EXISTING HABB VISUAL" PATH (2026-11-15) of "Propose-moi la prochaine publicité HABB": when the subject is something HABB already has a visual for (a personalisation example, for instance), Creator presents that visual
// with its headline and caption as a DRAFT ready for the owner's decision, instead of generating an image. NOTHING is generated here and no provider is contacted: the registry holds a file, the text that Creator already wrote
// (archived with its request, its answer and its cost) and the label that the image carries. Everything is VERIFIED on every opening (file hash, archived request hash, the answer that says what the registry says, the text
// rules), and the cost of the archived call is reconciled into the spend ledger ONCE: the run id is derived from the archived request hash, so opening the draft again, restarting the server or running the command again never counts it twice.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join, dirname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const EXISTING_VISUAL_ORIGIN = 'EXISTING_VISUAL';
export const EXISTING_VISUALS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'config', 'creator', 'existing-visuals');
const sha = (b) => createHash('sha256').update(b).digest('hex');
const r4 = (x) => Math.round(x * 10000) / 10000;

/** The rules of a headline and a caption written for an EXISTING visual: the price only when it is the verified one, no phone brand or model, no delay, stock or promise, the customer's own photo and the "example" said. */
export function montageTextViolations({ headline, caption }, { price = '25' } = {}) {
  const out = []; const h = String(headline ?? '').trim(); const c = String(caption ?? '').trim();
  if (!h || !c) return ['TEXT_MISSING'];
  if (h.length > 60 || h.split(/\s+/).length > 8) out.push('HEADLINE_TOO_LONG');
  if (/\d|!/.test(h)) out.push('HEADLINE_HAS_FIGURE_OR_EXCLAMATION');
  if (c.length > 600) out.push('CAPTION_TOO_LONG');
  const priceRe = new RegExp(`(?<!\\d)${price}(?:[.,]00)?\\s?(€|euros?)`, 'i'); if (!priceRe.test(c)) out.push(`CAPTION_WITHOUT_THE_PRICE_${price}`);
  const figs = (c.replace(/#\S+/g, '').match(/\d[\d.,]*/g) ?? []).filter((n) => !new RegExp(`^${price}([.,]00)?$`).test(n)); if (figs.length) out.push(`CAPTION_FIGURE_NOT_VERIFIED: ${figs.join(' ')}`);
  if (/(iphone|apple|samsung|galaxy|pixel|google|xiaomi|redmi|oppo|reno|\bpro max\b)/i.test(`${h} ${c}`)) out.push('PHONE_BRAND_OR_MODEL_NAMED');
  if (/(d[ée]lai|livraison|livr[ée]e?s?|stock|rapide|express|\bjours?\b|\bheures?\b|minutes?|garanti|garantie|imm[ée]diat|promo|remise|solde|offert|gratuit)/i.test(`${h} ${c}`)) out.push('DELAY_STOCK_OR_PROMISE_WORDS');
  if (!/photo/i.test(c)) out.push('CAPTION_DOES_NOT_SAY_THE_CUSTOMERS_OWN_PHOTO');
  if (!/exemple/i.test(c)) out.push('CAPTION_DOES_NOT_SAY_IT_IS_AN_EXAMPLE');
  const tags = c.match(/#[\p{L}\p{N}_]+/gu) ?? []; if (tags.length > 4 || (tags[0] ?? '').toLowerCase() !== '#habb') out.push('HASHTAGS_NOT_AS_ASKED');
  if (/\p{Extended_Pictographic}/u.test(`${h}${c}`)) out.push('EMOJI');
  return out;
}

/** The registry: read when asked (never cached across calls), every path confined to the registry folder. */
export function loadExistingVisuals({ dir = EXISTING_VISUALS_DIR } = {}) {
  const file = join(dir, 'registry.json'); const reg = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : { visuals: [] };
  const inside = (rel) => { const p = resolve(dir, rel); if (!(p === resolve(dir) || p.startsWith(resolve(dir) + sep))) throw new Error(`EXISTING_VISUAL_PATH_OUTSIDE_THE_REGISTRY: ${rel}`); return p; };
  return Object.freeze({ dir, visuals: reg.visuals ?? [], find: (id) => (reg.visuals ?? []).find((v) => v.id === id) ?? null, forSubject: (tag) => (reg.visuals ?? []).filter((v) => v.subject_tag === tag), path: inside });
}

/** Everything that must be true for the draft to be shown. Never throws: the problems are the answer. */
export function verifyExistingVisual(entry, registry) {
  const problems = []; let imagePath = null; let call = null;
  try {
    imagePath = registry.path(entry.image);
    if (!existsSync(imagePath)) problems.push('IMAGE_FILE_MISSING');
    else if (sha(readFileSync(imagePath)) !== entry.image_sha256) problems.push('IMAGE_HASH_DIFFERS_FROM_THE_REGISTRY');
    // every format of the visual (Instagram/Facebook, TikTok...) is the SAME starting element, a file with its own hash
    for (const f of entry.formats ?? []) { const fp = registry.path(f.image); if (!existsSync(fp)) problems.push(`FORMAT_FILE_MISSING: ${f.platform}`); else if (sha(readFileSync(fp)) !== f.image_sha256) problems.push(`FORMAT_HASH_DIFFERS: ${f.platform}`);
      if (f.export) { const ep = registry.path(f.export.image); if (!existsSync(ep)) problems.push(`EXPORT_FILE_MISSING: ${f.platform}`); else if (sha(readFileSync(ep)) !== f.export.image_sha256) problems.push(`EXPORT_HASH_DIFFERS: ${f.platform}`); } }
    const a = entry.archived_call ?? {}; const base = registry.path(a.dir ?? '');
    const req = JSON.parse(readFileSync(join(base, 'request.json'), 'utf8')); const resp = readFileSync(join(base, 'response.txt'), 'utf8'); const res = JSON.parse(readFileSync(join(base, 'result.json'), 'utf8'));
    const reqSha = sha(`${req.system}\u0000${req.user}`);
    if (reqSha !== a.request_sha256) problems.push('ARCHIVED_REQUEST_HASH_DIFFERS');
    let answer = null; try { answer = JSON.parse(resp.replace(/^```(?:json)?|```$/g, '').trim()); } catch { problems.push('ARCHIVED_ANSWER_UNREADABLE'); }
    if (answer && (answer.headline !== entry.headline || answer.caption !== entry.caption)) problems.push('TEXT_DIFFERS_FROM_THE_ARCHIVED_ANSWER');
    if (r4(res.cost_eur_settled) !== a.settled_eur) problems.push('ARCHIVED_COST_DIFFERS_FROM_THE_REGISTRY');
    if (res.calls !== 1) problems.push('ARCHIVED_CALLS_NOT_ONE');
    call = { request_sha256: reqSha, model: res.model ?? null, settled_eur: a.settled_eur, ceiling_eur: res.ceiling_eur ?? null };
    for (const v of montageTextViolations(entry, { price: entry.price_eur })) problems.push(v);
  } catch (e) { problems.push(`REGISTRY_ENTRY_UNREADABLE: ${String(e.message).slice(0, 120)}`); }
  const formats = problems.length ? [] : ((entry.formats ?? []).length ? entry.formats : [{ platform: 'INSTAGRAM_FACEBOOK', label: 'Instagram et Facebook', image: entry.image, caption_source: 'CREATOR_TEXT' }]).map((f) => ({ platform: f.platform, label: f.label, imagePath: registry.path(f.image), caption_source: f.caption_source ?? 'CREATOR_TEXT', layout: f.layout ?? null, unverified: f.unverified ?? null, ...(f.export ? { exportPath: registry.path(f.export.image), exportFormat: f.export.format, exportNote: f.export.note ?? null } : {}) }));
  return { ok: problems.length === 0, problems, imagePath, formats, call };
}

/** The cost of the archived call goes into the ledger ONCE. The run id comes from the archived request hash: the same call is the same run, whatever the number of openings. */
export async function reconcileArchivedCall({ ledger, merchantId, policyId, entry, call, now = new Date() }) {
  const runId = `ext-${call.request_sha256.slice(0, 12)}`; const basis = `EXTERNAL_ARCHIVED_CALL:${call.request_sha256}`;
  const pol = await ledger.currentPolicy({ merchantId, policyId }); if (!pol) return { status: 'POLICY_NOT_IN_FORCE', run_id: runId };
  const reserved = await ledger.reserve({ merchantId, runId, policyId, policyVersion: pol.version, ceilingEur: call.settled_eur, now });
  if (!['RESERVED', 'ALREADY_RESERVED'].includes(reserved.status)) return { status: `RESERVE_${reserved.status}`, run_id: runId, reason: reserved.reason ?? null };
  const settled = await ledger.settle({ merchantId, runId, settledEur: call.settled_eur, basis, now });
  if (!['SETTLED', 'ALREADY_SETTLED'].includes(settled.status)) return { status: `SETTLE_${settled.status}`, run_id: runId, reason: settled.reason ?? null };
  return { status: reserved.status === 'RESERVED' && settled.status === 'SETTLED' ? 'RECONCILED_NOW' : 'ALREADY_RECONCILED', run_id: runId, settled_eur: call.settled_eur, basis };
}

/** The port the Creator app uses: list the visuals, open ONE as a draft (verified, reconciled once, nothing generated, nothing paid). */
export function createExistingVisualPort({ ledger, merchantId, policyId, now = () => new Date(), dir = EXISTING_VISUALS_DIR }) {
  return Object.freeze({
    list: () => loadExistingVisuals({ dir }).visuals.map((v) => ({ id: v.id, subject_tag: v.subject_tag, subject_label: v.subject_label, mention: v.mention })),
    open: async (id) => {
      const reg = loadExistingVisuals({ dir }); const entry = reg.find(id); if (!entry) return { ok: false, code: 'EXISTING_VISUAL_NOT_FOUND' };
      const v = verifyExistingVisual(entry, reg); if (!v.ok) return { ok: false, code: 'EXISTING_VISUAL_NOT_VERIFIED', problems: v.problems };
      const rec = await reconcileArchivedCall({ ledger, merchantId, policyId, entry, call: v.call, now: now() });
      if (!/RECONCILED/.test(rec.status)) return { ok: false, code: 'EXISTING_VISUAL_COST_NOT_RECONCILED', reconciliation: rec };
      return { ok: true, entry, imagePath: v.imagePath, formats: v.formats, call: v.call, reconciliation: rec };
    },
  });
}
