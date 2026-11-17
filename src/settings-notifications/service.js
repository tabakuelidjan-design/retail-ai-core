// Paramètres -> Notifications: business rules. No HTTP here (see src/sourcing/server/notifications-host.js), no storage (see repository.js).
//
// RIGHTS. Every member of the merchant, whatever the role (a read-only member included), manages ONLY their own choices and reads ONLY their own alerts.
//   - the merchant, the user and the role always come from the SESSION (the host passes them); nothing here trusts a request value;
//   - an alert is addressed only to an ACTIVE, not removed member whose role may view the item (canView), and is checked again when it is listed, counted, read or opened;
//   - a member whose access was removed or suspended no longer has a session, so every route refuses before reaching this service.
// IDEMPOTENCE. An event has a stable key (dedupeKey); the storage refuses a second row for the same (merchant, recipient, key), so a replay adds nothing.
import { ALERT_TYPES, DIGEST_STATE, EMAIL_STATE, MODULES, NOTE_ACCOUNT, PREF_DEFAULT, TYPE_IDS, canView, describe, isType, isWired } from './model.js';

export class NotificationsError extends Error {
  constructor(code, message, extra = {}) { super(message ?? code); this.name = 'NotificationsError'; this.code = code; Object.assign(this, extra); }
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** @param {{ repo: object }} o */
export function createNotificationsService({ repo, links = {} }) {
  const need = (v, code) => { if (!v) throw new NotificationsError(code); return v; };
  const merchantOf = (tenant) => need(tenant?.merchantId, 'TENANT_REQUIRED');
  const prefMap = async (merchantId, userId) => new Map((await repo.preferences({ merchantId, userId })).map((p) => [p.type, p.in_app]));
  const enabledFor = (map, type) => (map.has(type) ? map.get(type) === true : PREF_DEFAULT(type));

  return Object.freeze({
    /** The page: every alert this member may see, with its trigger, its channels and the member's own setting. */
    async overview({ tenant, role, actor }) {
      const merchantId = merchantOf(tenant); need(actor, 'ACTOR_REQUIRED');
      const prefs = await prefMap(merchantId, actor);
      const alerts = TYPE_IDS.filter((t) => canView(t, role)).map((id) => {
        const t = ALERT_TYPES[id]; const wired = isWired(id, links);
        return {
          id, label: t.label, module: t.module, moduleLabel: MODULES[t.module].label, trigger: t.trigger, wired,
          state: wired ? 'RACCORDEE' : 'NON_RACCORDEE', stateLabel: wired ? 'Raccordée' : 'Pas encore raccordée', reason: wired ? null : t.notWiredReason,
          channels: [
            { id: 'in_app', label: 'Dans Nordla', supported: true, available: wired, enabled: wired ? enabledFor(prefs, id) : false },
            { id: 'email', label: 'E-mail', supported: false, available: false, enabled: false },
          ],
        };
      });
      const unread = (await repo.list({ merchantId, userId: actor, unreadOnly: true, limit: 200 })).filter((r) => isType(r.type) && canView(r.type, role)).length;
      return { alerts, email: EMAIL_STATE, digest: DIGEST_STATE, accountNote: NOTE_ACCOUNT, unread, canWrite: true };
    },

    /** Personal choice, per account and per merchant. Refused for an alert that is not wired (nothing could ever arrive) or that the role cannot see. */
    async setPreference({ tenant, role, actor, type, channel, enabled }) {
      const merchantId = merchantOf(tenant); need(actor, 'ACTOR_REQUIRED');
      if (!isType(type)) throw new NotificationsError('TYPE_UNKNOWN', 'Alerte inconnue.');
      if (!canView(type, role)) throw new NotificationsError('FORBIDDEN', 'Votre rôle ne donne pas accès à cette alerte.');
      if (channel === 'email') throw new NotificationsError('CHANNEL_UNAVAILABLE', EMAIL_STATE.label);
      if (channel !== 'in_app') throw new NotificationsError('CHANNEL_UNKNOWN', 'Canal inconnu.');
      if (typeof enabled !== 'boolean') throw new NotificationsError('VALIDATION', 'Valeur invalide.');
      if (!isWired(type, links)) throw new NotificationsError('NOT_WIRED', 'Cette alerte n’est pas encore raccordée.');
      await repo.setPreference({ merchantId, userId: actor, type, inApp: enabled });
      return this.overview({ tenant, role, actor });
    },

    /** The member's own alerts, newest first, each re-checked against the CURRENT role. */
    async inbox({ tenant, role, actor, unreadOnly = false, limit = 50 }) {
      const merchantId = merchantOf(tenant); need(actor, 'ACTOR_REQUIRED');
      const rows = await repo.list({ merchantId, userId: actor, unreadOnly, limit: Math.min(200, Math.max(1, Number(limit) || 50)) });
      const items = rows.filter((r) => isType(r.type) && canView(r.type, role)).map((r) => describe(r, links));
      return { items, unread: items.filter((i) => !i.read).length };
    },

    /** Open one alert: returns its page and marks it read (only the owner of the alert can reach it; another member's id answers NOT_FOUND). */
    async open({ tenant, role, actor, id }) {
      const merchantId = merchantOf(tenant); need(actor, 'ACTOR_REQUIRED');
      if (!UUID.test(String(id ?? ''))) throw new NotificationsError('NOT_FOUND');
      const row = await repo.get({ merchantId, userId: actor, id });
      if (!row || !isType(row.type) || !canView(row.type, role)) throw new NotificationsError('NOT_FOUND');
      await repo.markRead({ merchantId, userId: actor, ids: [id] });
      const d = describe({ ...row, read_at: row.read_at ?? new Date().toISOString() }, links);
      return { item: d, link: d.link };
    },

    async markRead({ tenant, role, actor, ids }) {
      const merchantId = merchantOf(tenant); need(actor, 'ACTOR_REQUIRED');
      const list = [...new Set((Array.isArray(ids) ? ids : []).map(String))].filter((x) => UUID.test(x)).slice(0, 100);
      if (!list.length) throw new NotificationsError('VALIDATION', 'Aucune alerte indiquée.');
      const visible = (await repo.list({ merchantId, userId: actor, limit: 200 })).filter((r) => list.includes(r.id) && isType(r.type) && canView(r.type, role)).map((r) => r.id);
      const changed = visible.length ? await repo.markRead({ merchantId, userId: actor, ids: visible }) : 0;
      return { changed };
    },

    async markAllRead({ tenant, role, actor }) {
      const merchantId = merchantOf(tenant); need(actor, 'ACTOR_REQUIRED');
      const ids = (await repo.list({ merchantId, userId: actor, unreadOnly: true, limit: 200 })).filter((r) => isType(r.type) && canView(r.type, role)).map((r) => r.id);
      return { changed: ids.length ? await repo.markRead({ merchantId, userId: actor, ids }) : 0 };
    },

    /**
     * Raise one business event for a merchant. Recipients = active members whose role may view the item AND who did not switch this alert off.
     * Safe to call again with the same dedupeKey: nobody gets a second alert. Returns counts only.
     */
    async emit({ merchantId, type, dedupeKey, data = {} }) {
      need(merchantId, 'TENANT_REQUIRED');
      if (!isWired(type, links)) throw new NotificationsError('TYPE_NOT_WIRED', 'Type d’alerte non raccordé.');
      if (typeof dedupeKey !== 'string' || dedupeKey.length < 3 || dedupeKey.length > 200) throw new NotificationsError('VALIDATION', 'Clé d’événement invalide.');
      const out = { created: 0, duplicate: 0, skipped: 0 };
      for (const m of await repo.activeMembers({ merchantId })) {
        if (!canView(type, m.role)) { out.skipped += 1; continue; }
        if (!enabledFor(await prefMap(merchantId, m.userId), type)) { out.skipped += 1; continue; }
        if (await repo.insertAlert({ merchantId, userId: m.userId, type, dedupeKey, data })) out.created += 1; else out.duplicate += 1;
      }
      return out;
    },
  });
}
