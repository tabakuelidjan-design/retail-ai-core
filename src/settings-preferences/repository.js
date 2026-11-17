// Storage of Paramètres -> Préférences. Two implementations of ONE interface: Supabase (service role, PostgREST) and memory (tests).
// EVERY call takes (merchantId, userId) and filters on BOTH: a row of another person or another merchant can neither be read nor written, whatever id the caller passes.
import { randomUUID } from 'node:crypto';

const eq = (v) => `eq.${v}`;
const VIEW_COLS = 'id,module,name,filters,is_default,is_favorite,created_at,updated_at';

export function createSupabasePreferencesRepository({ supabase, now = () => new Date() }) {
  const own = (m, u) => ({ merchant_id: eq(m), user_id: eq(u) });
  return Object.freeze({
    async getPrefs(m, u) { const r = await supabase.select('member_preferences', { ...own(m, u), select: 'language,region,updated_at', limit: '1' }); return r?.[0] ?? null; },
    async savePrefs(m, u, patch) { const r = await supabase.upsert('member_preferences', [{ merchant_id: m, user_id: u, ...patch, updated_at: now().toISOString() }], { onConflict: 'merchant_id,user_id' }); return r?.[0] ?? null; },
    async listViews(m, u) { return (await supabase.select('member_saved_views', { ...own(m, u), select: VIEW_COLS, order: 'created_at.asc' })) ?? []; },
    async getView(m, u, id) { const r = await supabase.select('member_saved_views', { ...own(m, u), id: eq(id), select: VIEW_COLS, limit: '1' }); return r?.[0] ?? null; },
    async insertView(m, u, view) { const r = await supabase.insert('member_saved_views', [{ id: randomUUID(), merchant_id: m, user_id: u, ...view }]); return r?.[0] ?? null; },
    async updateView(m, u, id, patch) { const r = await supabase.update('member_saved_views', { ...own(m, u), id: eq(id) }, { ...patch, updated_at: now().toISOString() }); return r?.[0] ?? null; },
    async clearDefault(m, u, module) { await supabase.update('member_saved_views', { ...own(m, u), module: eq(module), is_default: 'eq.true' }, { is_default: false, updated_at: now().toISOString() }); },
    async deleteView(m, u, id) { const r = await supabase.delete('member_saved_views', { ...own(m, u), id: eq(id) }); return (r?.length ?? 0) > 0; },
  });
}

/** Same interface, in memory. Used by the tests and by a local preview. */
export function createMemoryPreferencesRepository({ now = () => new Date() } = {}) {
  const prefs = new Map(); const views = new Map();
  const clone = (x) => (x == null ? x : structuredClone(x));
  const key = (m, u) => `${m}|${u}`;
  const mine = (m, u, id) => { const v = views.get(id); return v && v.merchant_id === m && v.user_id === u ? v : null; };
  const out = (v) => { if (!v) return null; const { merchant_id, user_id, ...rest } = v; return clone(rest); };
  return Object.freeze({
    _dump: () => ({ prefs: clone([...prefs]), views: clone([...views.values()]) }),
    async getPrefs(m, u) { return clone(prefs.get(key(m, u)) ?? null); },
    async savePrefs(m, u, patch) { const cur = prefs.get(key(m, u)) ?? { language: null, region: null }; const row = { ...cur, ...clone(patch), updated_at: now().toISOString() }; prefs.set(key(m, u), row); return clone(row); },
    async listViews(m, u) { return [...views.values()].filter((v) => v.merchant_id === m && v.user_id === u).map(out); },
    async getView(m, u, id) { return out(mine(m, u, id)); },
    async insertView(m, u, view) {
      const row = { id: randomUUID(), merchant_id: m, user_id: u, is_default: false, is_favorite: false, ...clone(view), created_at: now().toISOString(), updated_at: now().toISOString() };
      if (row.is_default && [...views.values()].some((v) => v.merchant_id === m && v.user_id === u && v.module === row.module && v.is_default)) throw new Error('duplicate key value violates unique constraint member_saved_views_one_default (23505)');
      views.set(row.id, row); return out(row);
    },
    async updateView(m, u, id, patch) {
      const cur = mine(m, u, id); if (!cur) return null;
      if (patch.is_default && [...views.values()].some((v) => v.merchant_id === m && v.user_id === u && v.module === cur.module && v.is_default && v.id !== id)) throw new Error('duplicate key value violates unique constraint member_saved_views_one_default (23505)');
      const row = { ...cur, ...clone(patch), updated_at: now().toISOString() }; views.set(id, row); return out(row);
    },
    async clearDefault(m, u, module) { for (const v of views.values()) if (v.merchant_id === m && v.user_id === u && v.module === module && v.is_default) v.is_default = false; },
    async deleteView(m, u, id) { return mine(m, u, id) ? views.delete(id) : false; },
  });
}
