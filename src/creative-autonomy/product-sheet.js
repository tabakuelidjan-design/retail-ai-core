// THE PRODUCT SHEET (lot A, subject 1, 2026-11-07): what Creator may SAY and may ASSERT about a product, with the STATUS of each item and where it comes from.
// It sits between the Shopify snapshot (read-only), the owner's confirmations, the measured examination of the photo and the invariants (what must never change in the image).
// Rules, all deterministic:
//   - a fact read from Shopify must quote an EXCERPT that really occurs in the named snapshot (title or description): a quote that does not occur is refused;
//   - an OWNER confirmation is kept with its date, its statement and what it contradicts (the Shopify listing is NEVER modified: it is reported as to be corrected by the owner);
//   - two sources that disagree make the fact CONFLICTING; a fact the photo cannot show or nobody confirmed is PENDING_CONFIRMATION;
//   - only SHOPIFY_READ and OWNER_CONFIRMED facts can back a PROMISE (a headline, an information line). CONFLICTING and PENDING facts are kept ON HOLD, with the reason;
//   - invariants (marks, ports, cables, colours) are PENDING_CONFIRMATION until the owner confirms them: they come from a reading of the photo, never from the pipeline's own certainty.
// Pure module: no network, no file written.
import { createHash } from 'node:crypto';

export const FACT_STATUS = Object.freeze({ SHOPIFY_READ: 'SHOPIFY_READ', OWNER_CONFIRMED: 'OWNER_CONFIRMED', CONFLICTING: 'CONFLICTING', PENDING: 'PENDING_CONFIRMATION' });
const BACKS_A_PROMISE = new Set([FACT_STATUS.SHOPIFY_READ, FACT_STATUS.OWNER_CONFIRMED]);

const norm = (s) => String(s ?? '').normalize('NFC').replace(/[  ]/g, ' ').replace(/[‘’]/g, "'").replace(/\s+/g, ' ').toLowerCase().trim();
/** The text a quote must occur in: the title and the description of a Shopify product snapshot (either file shape). */
export const textOfSnapshot = (snapshot) => { const p = snapshot?.product ?? snapshot ?? {}; return norm(`${p.title ?? ''} . ${p.description ?? ''}`); };
const fail = (code, message) => { throw Object.assign(new Error(`${code}: ${message}`), { code }); };

/**
 * @param {{ definition: object, snapshots: Record<string, object>, exam?: object|null }} input
 *   definition  the product's sheet definition (test/fixtures/creative-autonomy/product-sheets/*.json)
 *   snapshots   { fileName: parsed Shopify snapshot } for every snapshot the definition names
 *   exam        the examen.json of the photo (tonality, lit side, hanging part), when the photo was examined
 */
export function buildProductSheet({ definition, snapshots, exam = null }) {
  const d = definition; if (!d?.product_key) fail('SHEET_DEFINITION_INVALID', 'product_key is required');
  const facts = [];
  for (const f of d.facts ?? []) {
    const text = textOfSnapshot(snapshots?.[f.source?.snapshot]);
    if (!text.trim()) fail('SNAPSHOT_MISSING', `${f.id}: snapshot ${f.source?.snapshot} is not provided`);
    if (!text.includes(norm(f.source.excerpt))) fail('EXCERPT_NOT_IN_SNAPSHOT', `${f.id}: "${f.source.excerpt}" does not occur in ${f.source.snapshot}`);
    facts.push({ id: f.id, claim: f.claim, status: FACT_STATUS.SHOPIFY_READ, sources: [{ kind: 'SHOPIFY', snapshot: f.source.snapshot, excerpt: f.source.excerpt }] });
  }
  const listing_corrections = [];
  for (const c of d.confirmations ?? []) {
    if (!c.statement || !c.confirmed_on || c.source !== 'OWNER_CONFIRMED_IN_CHAT') fail('CONFIRMATION_INCOMPLETE', `${c.id}: statement, confirmed_on and source OWNER_CONFIRMED_IN_CHAT are required`);
    if (c.contradicts) {
      const text = textOfSnapshot(snapshots?.[c.contradicts.snapshot]);
      if (!text.includes(norm(c.contradicts.excerpt))) fail('EXCERPT_NOT_IN_SNAPSHOT', `${c.id}: contradicted excerpt "${c.contradicts.excerpt}" does not occur in ${c.contradicts.snapshot}`);
      listing_corrections.push({ id: c.id, listing_says: c.contradicts.excerpt, owner_confirmed: c.claim, snapshot: c.contradicts.snapshot, action: 'À corriger par le propriétaire dans Shopify (lecture seule ici : rien n\'est modifié).' });
    }
    facts.push({ id: c.id, claim: c.claim, status: FACT_STATUS.OWNER_CONFIRMED, check_on_photo: c.check_on_photo === true, sources: [{ kind: 'OWNER', confirmed_on: c.confirmed_on, statement: c.statement }, ...(c.contradicts ? [{ kind: 'SUPERSEDES_SHOPIFY', ...c.contradicts }] : [])] });
  }
  const conflicts = [];
  for (const c of d.conflicts ?? []) {
    if ((c.observations ?? []).length < 2) fail('CONFLICT_NEEDS_TWO_SOURCES', c.id);
    for (const o of c.observations) if (o.snapshot) { const text = textOfSnapshot(snapshots?.[o.snapshot]); if (!text.includes(norm(o.excerpt))) fail('EXCERPT_NOT_IN_SNAPSHOT', `${c.id}: "${o.excerpt}" does not occur in ${o.snapshot}`); }
    conflicts.push({ id: c.id, claim: c.claim, observations: c.observations, held: c.held ?? [], what_to_confirm: c.what_to_confirm });
    facts.push({ id: c.id, claim: c.claim, status: FACT_STATUS.CONFLICTING, sources: c.observations });
  }
  for (const p of d.pending ?? []) facts.push({ id: p.id, claim: p.claim, status: FACT_STATUS.PENDING, sources: p.sources ?? [], why: p.why });
  const allowed = facts.filter((f) => BACKS_A_PROMISE.has(f.status)).map((f) => ({ id: f.id, claim: f.claim, status: f.status }));
  const onHold = facts.filter((f) => !BACKS_A_PROMISE.has(f.status)).map((f) => ({ id: f.id, claim: f.claim, status: f.status, reason: f.why ?? conflicts.find((c) => c.id === f.id)?.what_to_confirm ?? 'à confirmer' }));
  // wording that must NOT be used while it is on hold (a conflict lists the competing wordings)
  const held_wordings = [...new Set([...(d.held_wordings ?? []), ...conflicts.flatMap((c) => c.held)])];
  const invariants = (d.invariants ?? []).map((i) => ({ id: i.id, kind: i.kind, item: i.item, status: i.status ?? FACT_STATUS.PENDING, basis: i.basis ?? 'lecture de la photo (Claude, 2026-11-07), à confirmer' }));
  const sheet = {
    product_key: d.product_key, title: d.title ?? null, product_nouns: d.product_nouns ?? [],
    photo: d.photo ?? { status: 'UNKNOWN' },
    facts, promises: { allowed, on_hold: onHold, held_wordings }, conflicts, listing_corrections,
    invariants: { confirmed: invariants.filter((i) => i.status === FACT_STATUS.OWNER_CONFIRMED), pending: invariants.filter((i) => i.status !== FACT_STATUS.OWNER_CONFIRMED) },
    measured: exam ? { tonal_class: exam.tonal_class ?? null, luminance: exam.luminance ?? null, lit_side: exam.lit_side ?? null, hanging_part_share_of_height: exam.ground_contact?.drop ?? null, is_dark_object: exam.is_dark_object ?? null } : null,
    coverage_missing: d.coverage_missing ?? [],
  };
  return Object.freeze({ ...sheet, sheet_sha256: createHash('sha256').update(JSON.stringify(sheet)).digest('hex') });
}

/** May this fact back a promise (a headline, an information line)? Held and unknown facts: no. */
export const promiseAllowed = (sheet, id) => sheet.promises.allowed.some((f) => f.id === id);
