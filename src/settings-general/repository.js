// Storage of Paramètres -> Général. Two implementations of ONE interface: Supabase (service role, PostgREST) and memory (tests).
// Canonical places: merchants.name (name), merchant_profile (time zone, currency: their readers do not change), merchant_general_sections (profile, activity, selling_modes, legal), merchant_establishments.
// Every write is a compare-and-swap on a version token, so a stale save is REFUSED (never replaces silently): the result is { ok:false, conflict:true }.
//   version token of a section / an establishment: its integer `version`;  of regional: the `updated_at` of merchant_profile ('' when no row yet).
import { randomUUID } from 'node:crypto';

const eq = (v) => `eq.${v}`;
const isDuplicate = (e) => /23505|duplicate key|409/.test(String(e?.message ?? e));

export function createSupabaseGeneralRepository({ supabase, now = () => new Date() }) {
  return Object.freeze({
    async merchantName(merchantId) { const r = await supabase.select('merchants', { id: eq(merchantId), select: 'name', limit: '1' }); return r?.[0]?.name ?? null; },
    async regional(merchantId) { const r = await supabase.select('merchant_profile', { merchant_id: eq(merchantId), select: 'timezone,currency,country,updated_at', limit: '1' }); return r?.[0] ?? null; },
    async getSection(merchantId, section) { const r = await supabase.select('merchant_general_sections', { merchant_id: eq(merchantId), section: eq(section), select: 'data,version,updated_at,updated_by', limit: '1' }); return r?.[0] ?? null; },
    async saveSection(merchantId, section, data, expected, actor, { name } = {}) {
      const at = now().toISOString(); let version;
      if (expected == null) {
        try { const r = await supabase.insert('merchant_general_sections', [{ merchant_id: merchantId, section, data, version: 1, updated_at: at, updated_by: actor }]); version = r?.[0]?.version ?? 1; }
        catch (e) { if (isDuplicate(e)) return { ok: false, conflict: true }; throw e; }
      } else {
        const r = await supabase.update('merchant_general_sections', { merchant_id: eq(merchantId), section: eq(section), version: eq(expected) }, { data, version: expected + 1, updated_at: at, updated_by: actor });
        if (!r?.length) return { ok: false, conflict: true };
        version = r[0].version;
      }
      if (name !== undefined) await supabase.update('merchants', { id: eq(merchantId) }, { name }); // the commercial name stays where every module already reads it
      return { ok: true, version };
    },
    async saveRegional(merchantId, value, expectedToken, actor) {
      if (!expectedToken) {
        try { const r = await supabase.insert('merchant_profile', [{ merchant_id: merchantId, timezone: value.timezone, currency: value.currency }]); return { ok: true, version: r?.[0]?.updated_at ?? '' }; }
        catch (e) { if (isDuplicate(e)) return { ok: false, conflict: true }; throw e; }
      }
      const r = await supabase.update('merchant_profile', { merchant_id: eq(merchantId), updated_at: eq(expectedToken) }, { timezone: value.timezone, currency: value.currency });
      return r?.length ? { ok: true, version: r[0].updated_at } : { ok: false, conflict: true };
    },
    async listEstablishments(merchantId) { return supabase.select('merchant_establishments', { merchant_id: eq(merchantId), select: 'id,data,is_primary,archived_at,version,updated_at', order: 'created_at.asc' }); },
    async createEstablishment(merchantId, data, { primary, actor }) {
      try { const r = await supabase.insert('merchant_establishments', [{ id: randomUUID(), merchant_id: merchantId, data, is_primary: primary, updated_by: actor }]); return { ok: true, row: r[0] }; }
      catch (e) { if (isDuplicate(e)) return { ok: false, conflict: true }; throw e; }
    },
    async updateEstablishment(merchantId, id, patch, expected, actor) {
      const r = await supabase.update('merchant_establishments', { merchant_id: eq(merchantId), id: eq(id), version: eq(expected) }, { ...patch, version: expected + 1, updated_at: now().toISOString(), updated_by: actor });
      return r?.length ? { ok: true, row: r[0] } : { ok: false, conflict: true };
    },
  });
}

/** Same interface, in memory. Used by the tests and by a local preview. */
export function createMemoryGeneralRepository({ merchants = {}, now = () => new Date() } = {}) {
  const m = new Map(Object.entries(merchants).map(([id, name]) => [id, { name }])); const sections = new Map(); const regionals = new Map(); const places = new Map();
  let tick = 0;
  const key = (a, b) => `${a}|${b}`;
  const clone = (x) => (x == null ? x : structuredClone(x));
  return Object.freeze({
    _dump: () => ({ merchants: clone([...m]), sections: clone([...sections]), regionals: clone([...regionals]) }),
    async merchantName(id) { return m.get(id)?.name ?? null; },
    async regional(id) { return clone(regionals.get(id) ?? null); },
    seedRegional(id, row) { regionals.set(id, { ...row, updated_at: `t${++tick}` }); },
    async getSection(id, s) { return clone(sections.get(key(id, s)) ?? null); },
    async saveSection(id, s, data, expected, actor, { name } = {}) {
      const cur = sections.get(key(id, s)); if ((cur?.version ?? null) !== (expected ?? null)) return { ok: false, conflict: true };
      const version = (cur?.version ?? 0) + 1; sections.set(key(id, s), { data: clone(data), version, updated_at: now().toISOString(), updated_by: actor });
      if (name !== undefined) m.set(id, { ...m.get(id), name });
      return { ok: true, version };
    },
    async saveRegional(id, value, expected, actor) {
      const cur = regionals.get(id); if ((cur?.updated_at ?? '') !== (expected ?? '')) return { ok: false, conflict: true };
      const row = { ...(cur ?? { country: null }), ...value, updated_at: `t${++tick}` }; regionals.set(id, row); return { ok: true, version: row.updated_at };
    },
    async listEstablishments(id) { return clone([...places.values()].filter((p) => p.merchant_id === id)); },
    async createEstablishment(id, data, { primary, actor }) {
      if (primary && [...places.values()].some((p) => p.merchant_id === id && p.is_primary && !p.archived_at)) return { ok: false, conflict: true };
      const row = { id: randomUUID(), merchant_id: id, data: clone(data), is_primary: primary, archived_at: null, version: 1, updated_at: now().toISOString(), updated_by: actor }; places.set(row.id, row); return { ok: true, row: clone(row) };
    },
    async updateEstablishment(id, pid, patch, expected, actor) {
      const cur = places.get(pid); if (!cur || cur.merchant_id !== id || cur.version !== expected) return { ok: false, conflict: true };
      if (patch.is_primary && [...places.values()].some((p) => p.merchant_id === id && p.id !== pid && p.is_primary && !p.archived_at)) return { ok: false, conflict: true };
      const row = { ...cur, ...clone(patch), version: expected + 1, updated_at: now().toISOString(), updated_by: actor }; places.set(pid, row); return { ok: true, row: clone(row) };
    },
  });
}
