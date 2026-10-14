// Product-case persistence. V0 (field mode) = local files, one JSON per case, written atomically (temp file + rename): no database, no migration, nothing shared.
// The case state is plain JSON with an append-only event log, so it can later be loaded into the planned Supabase tables
// (sourcing_cases / sourcing_evidence / sourcing_documents / sourcing_decisions) without conversion. `supplier` and `quotes` are shaped to link to "Achats & Fournisseurs".
import { mkdir, readFile, readdir, rename, writeFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';

export class StoreError extends Error { constructor(code, msg, extra = {}) { super(msg ?? code); this.code = code; Object.assign(this, extra); } }
const SAFE_ID = /^[A-Za-z0-9_-]{1,80}$/;
const assertId = (id) => { if (!SAFE_ID.test(String(id))) throw new StoreError('CASE_ID_INVALID', 'case id must be letters, digits, - or _'); return id; };

const summary = (s) => ({ id: s.id, name: s.identity?.workingName ?? '', updatedAt: s.updatedAt, createdAt: s.createdAt, rev: s.rev ?? 0, supplier: s.supplier?.name ?? null, lastVerdict: s.decisions?.at(-1)?.verdict ?? null, documents: s.documents?.length ?? 0 });

/** Optimistic concurrency: save({ ...state, rev }) fails with CONFLICT when the stored rev moved on (two devices edited the same case). */
function check(prev, next) { if (prev && (next.rev ?? 0) !== (prev.rev ?? 0)) throw new StoreError('CONFLICT', 'the case was changed elsewhere', { server: prev }); }

export function createMemoryStore() {
  const m = new Map();
  return {
    async list() { return [...m.values()].map(summary).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)); },
    async get(id) { const s = m.get(assertId(id)); return s ? JSON.parse(JSON.stringify(s)) : null; },
    async save(state) { assertId(state.id); const prev = m.get(state.id); check(prev, state); const next = { ...JSON.parse(JSON.stringify(state)), rev: (prev?.rev ?? 0) + 1 }; m.set(state.id, next); return JSON.parse(JSON.stringify(next)); },
    async remove(id) { return m.delete(assertId(id)); },
  };
}

export function createFileStore(dir) {
  const fileOf = (id) => join(dir, `${assertId(id)}.json`);
  const read = async (id) => { try { return JSON.parse(await readFile(fileOf(id), 'utf8')); } catch (e) { if (e.code === 'ENOENT') return null; throw e; } };
  return {
    async list() {
      await mkdir(dir, { recursive: true });
      const out = []; for (const f of await readdir(dir)) if (/^[A-Za-z0-9_-]+\.json$/.test(f)) { try { out.push(summary(JSON.parse(await readFile(join(dir, f), 'utf8')))); } catch { /* a corrupt file is skipped, never deleted */ } }
      return out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    },
    get: read,
    async save(state) {
      await mkdir(dir, { recursive: true }); assertId(state.id); const prev = await read(state.id); check(prev, state);
      const next = { ...state, rev: (prev?.rev ?? 0) + 1 }; const tmp = `${fileOf(state.id)}.${process.pid}.tmp`;
      await writeFile(tmp, JSON.stringify(next, null, 1)); await rename(tmp, fileOf(state.id)); return next;
    },
    async remove(id) { try { await unlink(fileOf(id)); return true; } catch (e) { if (e.code === 'ENOENT') return false; throw e; } },
  };
}
