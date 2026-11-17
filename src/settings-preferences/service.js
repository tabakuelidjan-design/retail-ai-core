// Paramètres -> Préférences: the SERVICE. Personal settings of the signed-in person for ONE merchant.
//
// IDENTITY. `userId` and the merchant come from the SESSION (the host passes them); this service never accepts an identity from a request body and every repository call filters on both.
// RIGHTS. Every role, Lecture seule included, may read and change its OWN preferences. Nothing here reads or changes a role, a permission or a business rule: a preference grants nothing.
// MONEY / TIME. The regional format is presentation only. The merchant's currency and time zone are read from Général (the source) and are returned unchanged for the formatters to USE; no amount is converted here.
import { APPLICATION, DEFAULT_LANGUAGE, DEFAULT_REGION, LANGUAGES, REGIONS, VIEW_MODULES, PreferencesError, cleanFilters, validateName, validatePreferences, validateViewInput } from './model.js';

const MAX_VIEWS = 50;
const isDuplicate = (e) => /23505|duplicate key|409/.test(String(e?.message ?? e));

/**
 * @param {{ repo: object, merchantRef?: (tenant, role) => Promise<{currency:string|null,timezone:string|null}|null>, moduleAccess?: (moduleId:string, role:string) => boolean }} deps
 *   merchantRef = Général's regional section (the SOURCE of currency and time zone). moduleAccess = can this role open that module (default: the catalogue's own role list).
 */
export function createPreferencesService({ repo, merchantRef = async () => null, moduleAccess = (moduleId, role) => (VIEW_MODULES[moduleId]?.roles ?? []).includes(role) }) {
  const merchantOf = (tenant) => { const id = tenant?.merchantId; if (!id) throw new PreferencesError('TENANT_REQUIRED', 'Commerce inconnu.'); return id; };
  const personOf = (userId) => { if (!userId || typeof userId !== 'string') throw new PreferencesError('TENANT_REQUIRED', 'Personne inconnue.'); return userId; };

  async function merchantInfo(tenant, role) {
    let r = null; try { r = await merchantRef(tenant, role); } catch { r = null; }
    return { currency: r?.currency ?? null, timezone: r?.timezone ?? null, source: r?.currency || r?.timezone ? 'general' : 'unset' };
  }
  const viewOut = (v, role) => {
    const def = VIEW_MODULES[v.module];
    const { dropped } = cleanFilters(v.module, v.filters);
    const accessible = Boolean(def) && moduleAccess(v.module, role);
    const reason = !def ? 'MODULE_REMOVED' : !accessible ? 'MODULE_INACCESSIBLE' : dropped.length ? 'FILTER_REMOVED' : null;
    return { id: v.id, module: v.module, moduleLabel: def?.module ?? v.module, screenLabel: def?.screen ?? null, name: v.name, filters: v.filters, isDefault: v.is_default === true, isFavorite: v.is_favorite === true, href: def?.href ?? null, status: reason ? 'UNAVAILABLE' : 'OK', reason, createdAt: v.created_at, updatedAt: v.updated_at };
  };
  const prefsOut = (row) => ({ language: { value: row?.language ?? DEFAULT_LANGUAGE, saved: row?.language ?? null, default: DEFAULT_LANGUAGE }, region: { value: row?.region ?? DEFAULT_REGION, saved: row?.region ?? null, default: DEFAULT_REGION }, updatedAt: row?.updated_at ?? null });

  return Object.freeze({
    /** The whole page for the signed-in person. */
    async overview({ tenant, userId, role }) {
      const m = merchantOf(tenant); const u = personOf(userId);
      const [prefs, views, merchant] = await Promise.all([repo.getPrefs(m, u), repo.listViews(m, u), merchantInfo(tenant, role)]);
      return { personal: true, ...prefsOut(prefs), languages: LANGUAGES, regions: REGIONS, applies: APPLICATION, merchant, views: views.map((v) => viewOut(v, role)), viewModules: Object.values(VIEW_MODULES).map((d) => ({ id: d.id, module: d.module, screen: d.screen, filters: Object.entries(d.filters).map(([k, f]) => ({ id: k, label: f.label })), accessible: moduleAccess(d.id, role) })) };
    },
    /** What the screens need on load: language, region and the merchant's currency / time zone. Small and cacheable per session. */
    async effective({ tenant, userId, role }) {
      const m = merchantOf(tenant); const u = personOf(userId);
      const [prefs, merchant] = await Promise.all([repo.getPrefs(m, u), merchantInfo(tenant, role)]);
      const o = prefsOut(prefs); return { language: o.language.value, region: o.region.value, languageSaved: o.language.saved !== null, regionSaved: o.region.saved !== null, merchant };
    },
    /** Language only (the hub asks for it): null when the person never chose one. */
    async languageOf({ tenant, userId }) { const row = await repo.getPrefs(merchantOf(tenant), personOf(userId)); return row?.language ?? null; },
    async save({ tenant, userId, role, input }) {
      const m = merchantOf(tenant); const u = personOf(userId); const patch = validatePreferences(input);
      const row = await repo.savePrefs(m, u, patch);
      return { ...prefsOut(row), merchant: await merchantInfo(tenant, role) };
    },

    // ---------------------------------------------------------------- saved views
    async listViews({ tenant, userId, role, module: moduleId = null }) {
      const rows = await repo.listViews(merchantOf(tenant), personOf(userId));
      return { views: rows.filter((v) => !moduleId || v.module === moduleId).map((v) => viewOut(v, role)) };
    },
    async createView({ tenant, userId, role, input, makeDefault = false }) {
      const m = merchantOf(tenant); const u = personOf(userId); const v = validateViewInput(input ?? {});
      if (!moduleAccess(v.module, role)) throw new PreferencesError('FORBIDDEN_MODULE', 'Ce module n’est pas accessible avec votre rôle.');
      const existing = await repo.listViews(m, u);
      if (existing.length >= MAX_VIEWS) throw new PreferencesError('TOO_MANY', `Vous avez atteint ${MAX_VIEWS} vues enregistrées.`);
      if (existing.some((x) => x.module === v.module && x.name.toLowerCase() === v.name.toLowerCase())) throw new PreferencesError('NAME_TAKEN', 'Une vue porte déjà ce nom pour cet écran.', { errors: { name: 'NAME_TAKEN' } });
      if (makeDefault) await repo.clearDefault(m, u, v.module);
      let row; try { row = await repo.insertView(m, u, { ...v, is_default: makeDefault === true }); } catch (e) { if (isDuplicate(e)) throw new PreferencesError('CONFLICT', 'Une autre vue par défaut vient d’être enregistrée. Réessayez.'); throw e; }
      return viewOut(row, role);
    },
    async updateView({ tenant, userId, role, id, patch }) {
      const m = merchantOf(tenant); const u = personOf(userId);
      const cur = await repo.getView(m, u, id); if (!cur) throw new PreferencesError('NOT_FOUND', 'Vue introuvable.');
      const allowed = {};
      if (patch && 'name' in patch) {
        allowed.name = validateName(patch.name);
        if ((await repo.listViews(m, u)).some((x) => x.id !== id && x.module === cur.module && x.name.toLowerCase() === allowed.name.toLowerCase())) throw new PreferencesError('NAME_TAKEN', 'Une vue porte déjà ce nom pour cet écran.', { errors: { name: 'NAME_TAKEN' } });
      }
      if (patch && 'isFavorite' in patch) { if (typeof patch.isFavorite !== 'boolean') throw new PreferencesError('VALIDATION', 'Valeur invalide.', { errors: { isFavorite: 'BOOLEAN_EXPECTED' } }); allowed.is_favorite = patch.isFavorite; }
      if (patch && 'isDefault' in patch) {
        if (typeof patch.isDefault !== 'boolean') throw new PreferencesError('VALIDATION', 'Valeur invalide.', { errors: { isDefault: 'BOOLEAN_EXPECTED' } });
        if (patch.isDefault) { if (!moduleAccess(cur.module, role)) throw new PreferencesError('FORBIDDEN_MODULE', 'Ce module n’est pas accessible avec votre rôle.'); await repo.clearDefault(m, u, cur.module); }
        allowed.is_default = patch.isDefault;
      }
      if (!Object.keys(allowed).length) throw new PreferencesError('VALIDATION', 'Rien à modifier.', { errors: { _: 'EMPTY' } });
      let row; try { row = await repo.updateView(m, u, id, allowed); } catch (e) { if (isDuplicate(e)) throw new PreferencesError('CONFLICT', 'Une autre vue par défaut vient d’être enregistrée. Réessayez.'); throw e; }
      if (!row) throw new PreferencesError('NOT_FOUND', 'Vue introuvable.');
      return viewOut(row, role);
    },
    async removeView({ tenant, userId, id }) { const ok = await repo.deleteView(merchantOf(tenant), personOf(userId), id); if (!ok) throw new PreferencesError('NOT_FOUND', 'Vue introuvable.'); return { removed: true }; },
    /**
     * What a screen opens with: the person's default view for that screen, or the standard view with the REASON why a saved default no longer applies.
     * { view: null, reason: null } = no default set (standard view, nothing to say).
     */
    async resolveDefault({ tenant, userId, role, module: moduleId }) {
      const m = merchantOf(tenant); const u = personOf(userId);
      if (!VIEW_MODULES[moduleId]) throw new PreferencesError('VALIDATION', 'Écran inconnu.', { errors: { module: 'MODULE_UNKNOWN' } });
      const def = (await repo.listViews(m, u)).find((v) => v.module === moduleId && v.is_default);
      if (!def) return { view: null, reason: null };
      const v = viewOut(def, role);
      if (v.status !== 'OK') return { view: null, reason: v.reason, viewName: v.name, viewId: v.id };
      return { view: { id: v.id, name: v.name, filters: v.filters }, reason: null };
    },
  });
}
