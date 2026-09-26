// Purchase document intelligence - Phase 2: supplier matching against Contacts (fin_companies, the single contact store)
// and duplicate detection. Pure functions: no I/O, no side effect, nothing is linked or created here.
//
// Supplier matching (first tier that yields a candidate wins; a later tier is never mixed with an earlier one):
//   1. VAT         - normalised VAT number identical ("BE 0123.456.789" = "BE0123456789")               confidence 0.99
//   2. ENTERPRISE  - Belgian enterprise number identical (10 digits, mod 97 valid), including the one carried
//                    inside a Belgian VAT number (BE0123456789 <-> 0123.456.789)                          confidence 0.98
//   3. NAME        - name identical after case / whitespace / "." "," normalisation (never fuzzy)         confidence 0.80
//                    address as a SECONDARY signal only: same postal code + street -> 0.90, other postal code -> 0.60
//                    a name match is discarded when both sides carry an identifier (VAT / enterprise) that differs
//   Archived contacts are never proposed.
//   Result: recognized (one VAT / enterprise candidate) | to_confirm (one name candidate, or several candidates) | unknown.
//   Nothing is ever linked here: the person confirms, or chooses another contact.
//
// Duplicates (REJECTED documents are ignored; the document itself is excluded):
//   certain  - same file (sha256), or same supplier + same document number + same document type
//   possible - same supplier + same type + same total incl. VAT + issue dates at most 7 days apart,
//              with the number missing on one side or different. Always presented as a possibility, never as a fact.
//   "Same supplier" = same linked contact, or same VAT, or same enterprise number, or (no conflicting identifier and) same name.
//   An invoice and a credit note are never duplicates of each other (different type).

import { contactDisplayName, normalizeName, normalizeVat } from './contacts.js';
import { normalizeBelgianNumber } from './company.js';
import { documentTypeOf } from './purchase-document.js';

export const MATCH_CONFIDENCE = { VAT: 0.99, ENTERPRISE_NUMBER: 0.98, NAME: 0.8, NAME_AND_ADDRESS: 0.9, NAME_ADDRESS_DIFFERS: 0.6 };
export const PROBABLE_DUPLICATE_WINDOW_DAYS = 7;

const beDigits = (v) => { if (!v) return null; const n = normalizeBelgianNumber(v); return n.ok ? n.digits : null; };
/** The Belgian enterprise digits of a party: its enterprise number, else the one inside a Belgian VAT number. */
const enterpriseOf = (enterprise, vat) => beDigits(enterprise) ?? (/^BE/i.test(String(vat ?? '').replace(/\s+/g, '')) ? beDigits(vat) : null);
const normStreet = (s) => (s ? String(s).toUpperCase().replace(/[^A-Z0-9]/g, '') : null);
const normPostal = (s) => (s ? String(s).toUpperCase().replace(/\s+/g, '') : null);

/** Identity of the supplier as read on a purchase document. */
export function documentSupplier(r) {
  const addr = r.extraction?.provenance?.supplierAddress?.value ?? null;
  return { name: r.supplierName ?? null, vat: normalizeVat(r.supplierVatNumber), enterprise: enterpriseOf(r.supplierEnterpriseNumber, r.supplierVatNumber), iban: r.supplierIban ?? null, address: addr };
}
const contactIdentity = (c) => ({ vat: normalizeVat(c.vatNumber), enterprise: enterpriseOf(c.enterpriseNumber, c.vatNumber) });
const identifiersConflict = (a, b) => {
  const aHas = !!(a.vat || a.enterprise); const bHas = !!(b.vat || b.enterprise);
  if (!aHas || !bHas) return false;
  if (a.vat && b.vat && a.vat === b.vat) return false;
  if (a.enterprise && b.enterprise && a.enterprise === b.enterprise) return false;
  return true;
};
const candidate = (c, method, confidence, signals = []) => ({ contactId: c.id, displayName: contactDisplayName(c), method, confidence, signals, vatNumber: c.vatNumber ?? null, enterpriseNumber: c.enterpriseNumber ?? null });

/**
 * Propose the supplier contact of a purchase document. Never links.
 * @returns {{ status: 'linked'|'recognized'|'to_confirm'|'unknown', proposal: object|null, candidates: object[], createPrefill: object|null }}
 */
export function matchSupplier(r, companies) {
  const doc = documentSupplier(r);
  const active = companies.filter((c) => !c.archivedAt);
  if (r.supplierCompanyId) {
    const c = companies.find((x) => x.id === r.supplierCompanyId);
    return { status: 'linked', proposal: null, candidates: c ? [candidate(c, 'LINKED', 1)] : [], createPrefill: null };
  }
  let tier = [];
  if (doc.vat) tier = active.filter((c) => contactIdentity(c).vat === doc.vat).map((c) => candidate(c, 'VAT', MATCH_CONFIDENCE.VAT));
  if (!tier.length && doc.enterprise) tier = active.filter((c) => contactIdentity(c).enterprise === doc.enterprise).map((c) => candidate(c, 'ENTERPRISE_NUMBER', MATCH_CONFIDENCE.ENTERPRISE_NUMBER));
  if (!tier.length && normalizeName(doc.name)) {
    const n = normalizeName(doc.name);
    tier = active.filter((c) => (normalizeName(c.name) === n || normalizeName(contactDisplayName(c)) === n) && !identifiersConflict(doc, contactIdentity(c))).map((c) => {
      const a = c.address ?? {}; const d = doc.address ?? {};
      if (normPostal(d.postalCode) && normPostal(a.postalCode)) {
        if (normPostal(d.postalCode) !== normPostal(a.postalCode)) return candidate(c, 'NAME', MATCH_CONFIDENCE.NAME_ADDRESS_DIFFERS, ['ADDRESS_DIFFERS']);
        if (normStreet(d.street) && normStreet(d.street) === normStreet(a.street)) return candidate(c, 'NAME', MATCH_CONFIDENCE.NAME_AND_ADDRESS, ['ADDRESS_MATCHES']);
      }
      return candidate(c, 'NAME', MATCH_CONFIDENCE.NAME);
    });
  }
  if (!tier.length) {
    const hasSomething = doc.name || doc.vat || doc.enterprise;
    return { status: 'unknown', proposal: null, candidates: [], createPrefill: hasSomething ? createPrefillOf(r) : null };
  }
  tier.sort((a, b) => b.confidence - a.confidence);
  if (tier.length === 1) return { status: tier[0].method === 'NAME' ? 'to_confirm' : 'recognized', proposal: tier[0], candidates: tier, createPrefill: null };
  return { status: 'to_confirm', proposal: null, candidates: tier, createPrefill: null }; // ambiguous: the person chooses
}

/** Fields to prefill "Create this supplier" with - only what the document carries (a Supplier, business contact). */
export function createPrefillOf(r) {
  const addr = r.extraction?.provenance?.supplierAddress?.value ?? {};
  const ent = normalizeBelgianNumber(r.supplierEnterpriseNumber ?? '');
  const vatEnt = /^BE/i.test(String(r.supplierVatNumber ?? '')) ? normalizeBelgianNumber(r.supplierVatNumber) : { ok: false };
  return { kind: 'business', role: 'supplier', name: r.supplierName ?? '', vatNumber: r.supplierVatNumber ?? '',
    enterpriseNumber: ent.ok ? ent.enterpriseNumber : vatEnt.ok ? vatEnt.enterpriseNumber : (r.supplierEnterpriseNumber ?? ''), iban: r.supplierIban ?? '',
    street: addr.street ?? '', postalCode: addr.postalCode ?? '', city: addr.city ?? '', countryCode: addr.countryCode ?? (vatEnt.ok ? 'BE' : '') };
}

// ---------- duplicates ----------
const normNumber = (s) => (s ? String(s).toUpperCase().replace(/\s+/g, '') : null);
const dayDiff = (a, b) => Math.abs(Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86400000;
const isDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`));

/** Same supplier on two purchase documents (see the header for the exact rule). */
export function sameSupplier(a, b) {
  if (a.supplierCompanyId && b.supplierCompanyId) return a.supplierCompanyId === b.supplierCompanyId;
  const x = documentSupplier(a); const y = documentSupplier(b);
  if (x.vat && y.vat && x.vat === y.vat) return true;
  if (x.enterprise && y.enterprise && x.enterprise === y.enterprise) return true;
  if (identifiersConflict(x, y)) return false;
  const n = normalizeName(x.name); return !!n && n === normalizeName(y.name);
}

const DIFF_KEYS = ['invoiceNumber', 'issueDate', 'dueDate', 'netCents', 'vatCents', 'grossCents', 'currency', 'supplierVatNumber', 'fileName', 'source', 'status'];
/** The fields that differ between two documents, for the person to decide. */
export const differencesOf = (a, b) => DIFF_KEYS.filter((k) => (a[k] ?? null) !== (b[k] ?? null)).map((k) => ({ field: k, thisValue: a[k] ?? null, otherValue: b[k] ?? null }));

/**
 * Duplicates of `r` among `others`. Decisions already taken by the person (extraction.duplicateDecisions) are applied to
 * possible duplicates only: a certain duplicate cannot be dismissed.
 * @returns {{ level: 'none'|'possible'|'certain', items: Array<{id, level, reasons, differences, dismissed}> }}
 */
export function findDuplicates(r, others, { windowDays = PROBABLE_DUPLICATE_WINDOW_DAYS } = {}) {
  const decisions = r.extraction?.duplicateDecisions ?? {};
  const items = [];
  for (const o of others) {
    if (o.id === r.id || o.status === 'REJECTED') continue;
    if (r.sha256 && o.sha256 && r.sha256 === o.sha256) { items.push({ id: o.id, level: 'certain', reasons: ['SAME_FILE'] }); continue; }
    if (documentTypeOf(o) !== documentTypeOf(r) || !sameSupplier(r, o)) continue;
    const a = normNumber(r.invoiceNumber); const b = normNumber(o.invoiceNumber);
    if (a && b && a === b) { items.push({ id: o.id, level: 'certain', reasons: ['SAME_SUPPLIER', 'SAME_NUMBER', 'SAME_TYPE'] }); continue; }
    if (!Number.isInteger(r.grossCents) || r.grossCents !== o.grossCents || !isDate(r.issueDate) || !isDate(o.issueDate)) continue;
    const days = dayDiff(r.issueDate, o.issueDate); if (days > windowDays) continue;
    items.push({ id: o.id, level: 'possible', reasons: ['SAME_SUPPLIER', 'SAME_TYPE', 'SAME_TOTAL', days === 0 ? 'SAME_DATE' : 'CLOSE_DATE', !a || !b ? 'NUMBER_MISSING' : 'NUMBER_DIFFERENT'], days });
  }
  const byId = new Map(others.map((o) => [o.id, o]));
  // a "not a duplicate" decision is about the PAIR: taken on either document, it applies to both
  const setAside = (o) => decisions[o.id]?.decision === 'not_duplicate' || (r.id && o.extraction?.duplicateDecisions?.[r.id]?.decision === 'not_duplicate');
  for (const it of items) { const o = byId.get(it.id); it.differences = differencesOf(r, o); it.dismissed = it.level === 'possible' && setAside(o); }
  const live = items.filter((i) => !i.dismissed);
  return { level: live.some((i) => i.level === 'certain') ? 'certain' : live.length ? 'possible' : 'none', items };
}

// ---------- private storage: which files are still referenced ----------
/** Every attachment reference a purchase record points to (the served document, a capture original, an attached receipt). */
export const refsOf = (r) => [r.attachmentRef, r.extraction?.capture?.original?.ref, r.extraction?.capture?.pdf?.ref, r.extraction?.receipt?.original?.ref, r.extraction?.receipt?.pdf?.ref].filter(Boolean);
/** True when any record still points to `ref`: such a file must never be deleted. */
export const isReferenced = (ref, rows) => rows.some((r) => refsOf(r).includes(ref));
