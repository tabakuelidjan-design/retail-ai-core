// Storage of Paramètres -> Notifications. Two implementations of ONE interface: Supabase (service role, PostgREST) and memory (tests).
// Every method takes the merchant explicitly and filters on it: nothing here can read another merchant's rows.
import { randomUUID } from 'node:crypto';

const eq = (v) => `eq.${v}`;
const isDuplicate = (e) => /23505|duplicate key|409/.test(String(e?.message ?? e));
const COLS = 'id,type,data,created_at,read_at';

export function createSupabaseNotificationsRepository({ supabase, now = () => new Date() }) {
  return Object.freeze({
    /** Insert one alert; false when this (merchant, recipient, event) already exists (a replay). */
    async insertAlert({ merchantId, userId, type, dedupeKey, data }) {
      try { await supabase.insert('notifications', [{ id: randomUUID(), merchant_id: merchantId, recipient_user_id: userId, type, dedupe_key: dedupeKey, data, created_at: now().toISOString() }]); return true; }
      catch (e) { if (isDuplicate(e)) return false; throw e; }
    },
    async list({ merchantId, userId, unreadOnly = false, limit = 50 }) {
      return (await supabase.select('notifications', { merchant_id: eq(merchantId), recipient_user_id: eq(userId), select: COLS, ...(unreadOnly ? { read_at: 'is.null' } : {}), order: 'created_at.desc,id.desc', limit: String(limit) })) ?? [];
    },
    async get({ merchantId, userId, id }) { return (await supabase.select('notifications', { merchant_id: eq(merchantId), recipient_user_id: eq(userId), id: eq(id), select: COLS, limit: '1' }))?.[0] ?? null; },
    async markRead({ merchantId, userId, ids }) {
      const r = await supabase.update('notifications', { merchant_id: eq(merchantId), recipient_user_id: eq(userId), read_at: 'is.null', id: `in.(${ids.join(',')})` }, { read_at: now().toISOString() });
      return r?.length ?? 0;
    },
    async preferences({ merchantId, userId }) { return (await supabase.select('notification_preferences', { merchant_id: eq(merchantId), user_id: eq(userId), select: 'type,in_app,updated_at' })) ?? []; },
    async setPreference({ merchantId, userId, type, inApp }) {
      await supabase.upsert('notification_preferences', [{ merchant_id: merchantId, user_id: userId, type, in_app: inApp, updated_at: now().toISOString() }], { onConflict: 'merchant_id,user_id,type' });
    },
    /** Active, not removed members of the merchant: the only people an alert may be addressed to. */
    async activeMembers({ merchantId }) {
      return ((await supabase.select('merchant_members', { merchant_id: eq(merchantId), status: eq('ACTIVE'), removed_at: 'is.null', select: 'user_id,role' })) ?? []).map((m) => ({ userId: m.user_id, role: m.role }));
    },
  });
}

/** Same interface, in memory. `members` = [{ merchantId, userId, role, active }], mutable through setMember (tests). */
export function createMemoryNotificationsRepository({ members = [], now = () => new Date() } = {}) {
  const rows = []; const prefs = new Map(); const mem = members.map((m) => ({ active: true, ...m }));
  const clone = (x) => structuredClone(x);
  const pick = (r) => ({ id: r.id, type: r.type, data: clone(r.data), created_at: r.created_at, read_at: r.read_at });
  return Object.freeze({
    _rows: rows,
    setMember(merchantId, userId, patch) { const m = mem.find((x) => x.merchantId === merchantId && x.userId === userId); if (m) Object.assign(m, patch); else mem.push({ active: true, merchantId, userId, ...patch }); },
    async insertAlert({ merchantId, userId, type, dedupeKey, data }) {
      if (rows.some((r) => r.merchant_id === merchantId && r.recipient_user_id === userId && r.dedupe_key === dedupeKey)) return false;
      rows.push({ id: randomUUID(), merchant_id: merchantId, recipient_user_id: userId, type, dedupe_key: dedupeKey, data: clone(data), created_at: now().toISOString(), read_at: null }); return true;
    },
    async list({ merchantId, userId, unreadOnly = false, limit = 50 }) {
      return rows.filter((r) => r.merchant_id === merchantId && r.recipient_user_id === userId && (!unreadOnly || r.read_at == null)).sort((a, b) => (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : 0)).slice(0, limit).map(pick);
    },
    async get({ merchantId, userId, id }) { const r = rows.find((x) => x.merchant_id === merchantId && x.recipient_user_id === userId && x.id === id); return r ? pick(r) : null; },
    async markRead({ merchantId, userId, ids }) { let n = 0; for (const r of rows) if (r.merchant_id === merchantId && r.recipient_user_id === userId && ids.includes(r.id) && r.read_at == null) { r.read_at = now().toISOString(); n += 1; } return n; },
    async preferences({ merchantId, userId }) { return [...prefs].filter(([k]) => k.startsWith(`${merchantId}|${userId}|`)).map(([k, v]) => ({ type: k.split('|')[2], in_app: v })); },
    async setPreference({ merchantId, userId, type, inApp }) { prefs.set(`${merchantId}|${userId}|${type}`, inApp); },
    async activeMembers({ merchantId }) { return mem.filter((m) => m.merchantId === merchantId && m.active).map((m) => ({ userId: m.userId, role: m.role })); },
  });
}
