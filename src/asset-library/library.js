import { APPROVAL_STATUS, AssetLibraryError, LIBRARY_ERROR as E, ORIGIN_CLASS, RIGHTS_STATUS } from './constants.js';
import { normalizeEntry, publishability } from './entry.js';

const sortBy = (a, b) => (a.asset_id < b.asset_id ? -1 : a.asset_id > b.asset_id ? 1 : a.version - b.version);

/**
 * In-memory catalogue of asset entries. Pure: no file access, no network. Decisions (rights, approval) are recorded by `record*` with a named
 * human reference and produce a NEW entry version; nothing here can mark an asset published.
 */
export function createAssetLibrary(initial = []) {
  const byId = new Map(); // asset_id -> latest entry
  const history = []; // every version, in order

  const put = (entry) => { byId.set(entry.asset_id, entry); history.push(entry); return entry; };
  for (const e of initial) {
    const n = normalizeEntry(e);
    if (byId.has(n.asset_id)) throw new AssetLibraryError(E.DUPLICATE_ID, 'duplicate asset_id', { asset_id: n.asset_id });
    put(n);
  }

  const need = (id) => {
    const e = byId.get(id);
    if (!e) throw new AssetLibraryError(E.UNKNOWN_ASSET, 'unknown asset', { asset_id: id });
    return e;
  };
  const bump = (id, patch) => put(normalizeEntry({ ...need(id), ...patch, version: need(id).version + 1 }));
  const human = (ref, field) => {
    if (typeof ref !== 'string' || !/^(approval|evidence):\/\/[A-Za-z0-9._:/-]+$/.test(ref)) throw new AssetLibraryError(E.INVALID_ENTRY, `${field} must be an approval:// or evidence:// reference naming the human decision`, { field });
    return ref;
  };

  return {
    get: need,
    has: (id) => byId.has(id),
    list: () => [...byId.values()].sort(sortBy),
    history: () => history.slice(),
    add(entry) {
      const n = normalizeEntry(entry);
      if (byId.has(n.asset_id)) throw new AssetLibraryError(E.DUPLICATE_ID, 'duplicate asset_id', { asset_id: n.asset_id });
      return put(n);
    },
    /** A named human states the rights position. Only a human reference is accepted. */
    recordRights(id, status, evidenceRef) {
      if (!Object.values(RIGHTS_STATUS).includes(status) || status === RIGHTS_STATUS.UNVERIFIED) throw new AssetLibraryError(E.INVALID_ENTRY, 'rights status must be OWNER_CONFIRMED or RESTRICTED', { field: 'rights_status' });
      return bump(id, { rights_status: status, rights_evidence_ref: human(evidenceRef, 'rights_evidence_ref') });
    },
    recordApproval(id, status, approvalRef) {
      if (![APPROVAL_STATUS.APPROVED, APPROVAL_STATUS.REJECTED].includes(status)) throw new AssetLibraryError(E.INVALID_ENTRY, 'approval status must be APPROVED or REJECTED', { field: 'approval_status' });
      return bump(id, { approval_status: status, approval_ref: human(approvalRef, 'approval_ref') });
    },
    /** Re-classify what the indexer guessed (a person looked at the image). Never touches rights or approval. */
    reclassify(id, originClass) {
      if (!Object.values(ORIGIN_CLASS).includes(originClass)) throw new AssetLibraryError(E.INVALID_ENTRY, 'unknown origin class', { field: 'origin_class' });
      return bump(id, { origin_class: originClass });
    },
    publishability: (id) => publishability(need(id)),
    /** Throws NOT_PUBLISHABLE unless every id is a genuine, rights-confirmed, approved HABB asset. */
    assertPublishable(ids) {
      const blocked = [];
      for (const id of ids) {
        const r = publishability(need(id));
        if (!r.publishable) blocked.push({ asset_id: id, reasons: r.reasons });
      }
      if (blocked.length) throw new AssetLibraryError(E.NOT_PUBLISHABLE, 'some assets cannot be published', { blocked });
      return true;
    },
    forProduct: (productRef) => [...byId.values()].filter((e) => e.product_refs.includes(productRef)).sort(sortBy),
    summary() {
      const out = { total: byId.size, by_origin_class: {}, by_rights_status: {}, by_approval_status: {}, publishable: 0 };
      for (const e of byId.values()) {
        out.by_origin_class[e.origin_class] = (out.by_origin_class[e.origin_class] ?? 0) + 1;
        out.by_rights_status[e.rights_status] = (out.by_rights_status[e.rights_status] ?? 0) + 1;
        out.by_approval_status[e.approval_status] = (out.by_approval_status[e.approval_status] ?? 0) + 1;
        if (publishability(e).publishable) out.publishable += 1;
      }
      return out;
    },
  };
}
