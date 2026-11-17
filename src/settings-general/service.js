// Paramètres -> Général: the service the modules and the page go through. ONE service per deployment, the merchant is always the SESSION's merchant (tenant.merchantId).
// RIGHTS: read = any session of the merchant (the legal section: OWNER / ADMIN only); write = OWNER / ADMIN. Checked here, again in the host.
// A save is per section, validated on the server, refused on a stale version (CONFLICT, with the current value) and never half applied. An invalid input changes nothing.
import * as M from './model.js';

export const WRITER_ROLES = new Set(['OWNER', 'ADMIN']);
const LEGAL_READERS = WRITER_ROLES;
export class GeneralError extends Error { constructor(code, message, extra = {}) { super(message ?? code); this.name = 'GeneralError'; this.code = code; Object.assign(this, extra); } }

export const SECTION_META = Object.freeze({
  profile: { label: 'Profil du commerce', slug: 'profil' }, activity: { label: 'Activité et canaux de vente', slug: 'activite' }, establishments: { label: 'Établissements et horaires', slug: 'etablissements' },
  selling_modes: { label: 'Mode de vente et de production', slug: 'modes-de-vente' }, regional: { label: 'Devise et fuseau horaire', slug: 'devise-fuseau' }, legal: { label: 'Informations légales et facturation', slug: 'legal' },
});
// What reads Général today and what is still to be connected: shown as such in the page (never a promise).
export const CONSUMERS = Object.freeze([
  { module: 'Core', reads: ['Nom commercial'], state: 'READS', note: 'Lit déjà le nom du commerce (merchants.name).' },
  { module: 'Analyses et Growth', reads: ['Fuseau horaire', 'Devise'], state: 'READS', note: 'Lisent déjà le fuseau et la devise (merchant_profile), sans changement de code.' },
  { module: 'Marketing', reads: ['Nom', 'Site', 'Coordonnées publiques', 'Horaires'], state: 'TO_CONNECT', note: 'À raccorder : les brouillons ne lisent pas encore Général.' },
  { module: 'Finance', reads: ['Identité légale', 'Adresse de facturation'], state: 'TO_CONNECT', note: 'À raccorder : Finance garde son profil vendeur versionné ; un écart éventuel sera remonté, jamais écrasé.' },
  { module: 'Stock et Sourcing', reads: ['Mode de vente'], state: 'TO_CONNECT', note: 'À raccorder (contexte uniquement : aucun stock ni délai n’en est déduit).' },
  { module: 'Connexions', reads: ['Établissements'], state: 'TO_CONNECT', note: 'À raccorder : association des lieux du fournisseur à l’identifiant Nordla du lieu.' },
]);

const isoDate = (d) => d.toISOString();
const blank = (v) => v == null || v === '' || (Array.isArray(v) && !v.length);

/** @param {{ repo: object, catalogueFamilies?: (merchantId) => Promise<string[]>, now?: () => Date }} deps */
export function createGeneralService({ repo, catalogueFamilies = async () => [], now = () => new Date() }) {
  const canWrite = (role) => WRITER_ROLES.has(role);
  const merchantOf = (tenant) => { const id = tenant?.merchantId; if (!id) throw new GeneralError('TENANT_REQUIRED'); return id; };
  const needWrite = (role) => { if (!canWrite(role)) throw new GeneralError('FORBIDDEN_ROLE', 'Réservé au propriétaire ou à un administrateur.'); };
  const needLegalRead = (role) => { if (!LEGAL_READERS.has(role)) throw new GeneralError('FORBIDDEN_ROLE', 'Les informations légales sont réservées au propriétaire et aux administrateurs.'); };
  const profileCountry = async (merchantId) => (await repo.regional(merchantId))?.country ?? ((await repo.getSection(merchantId, 'legal'))?.data?.country ?? null);

  async function readProfile(id) { const name = await repo.merchantName(id); const s = await repo.getSection(id, 'profile'); const d = s?.data ?? {}; return { version: s?.version ?? null, data: { name: name ?? '', description: d.description ?? null, website: d.website ?? null, email: d.email ?? null, phone: d.phone ?? null }, logo: { available: false, reason: 'Aucun stockage média n’est encore relié à Nordla : le logo se règle plus tard.' } }; }
  async function readSimple(id, section, empty) { const s = await repo.getSection(id, section); return { version: s?.version ?? null, data: { ...empty, ...(s?.data ?? {}) } }; }
  async function readRegional(id) { const r = await repo.regional(id); return { version: r?.updated_at ?? '', data: { currency: r?.currency ?? null, timezone: r?.timezone ?? null } }; }
  async function readEstablishments(id) {
    const rows = await repo.listEstablishments(id);
    return { version: null, data: { establishments: rows.map((r) => ({ id: r.id, version: r.version, isPrimary: !!r.is_primary, archived: !!r.archived_at, ...r.data })) } };
  }

  const READERS = {
    profile: readProfile, activity: (id) => readSimple(id, 'activity', { main: null, complementary: [], channels: [], clientele: null }),
    establishments: readEstablishments, selling_modes: (id) => readSimple(id, 'selling_modes', { modes: [], by_family: {} }), regional: readRegional,
    legal: (id) => readSimple(id, 'legal', { legal_name: null, country: null, legal_form: null, enterprise_number: null, vat_status: 'unknown', vat_number: null, billing: { use_primary: true }, email: null }),
  };
  const FILLED = {
    profile: (d) => !blank(d.name) && [d.description, d.website, d.email, d.phone].some((v) => !blank(v)), activity: (d) => !!d.main || d.channels.length > 0, establishments: (d) => d.establishments.some((e) => !e.archived),
    selling_modes: (d) => d.modes.length > 0, regional: (d) => !!d.currency && !!d.timezone, legal: (d) => !blank(d.legal_name) || !blank(d.enterprise_number) || d.vat_status !== 'unknown',
  };

  return Object.freeze({
    WRITER_ROLES, SECTION_META,
    /** The six entries of the list, with where each stands ("À renseigner" or "Renseigné") and what reads it. */
    async overview({ tenant, role }) {
      const id = merchantOf(tenant); const out = [];
      for (const section of M.SECTIONS) {
        if (section === 'legal' && !LEGAL_READERS.has(role)) { out.push({ id: section, ...SECTION_META[section], locked: true, filled: null }); continue; }
        const r = await READERS[section](id); out.push({ id: section, ...SECTION_META[section], locked: false, filled: !!FILLED[section](r.data) });
      }
      return { sections: out, canWrite: canWrite(role), consumers: CONSUMERS };
    },
    /** The value of one section plus the option lists the form needs. A section that does not exist yet reads as "À renseigner" (empty), never as a default of another merchant. */
    async read({ tenant, role, section }) {
      const id = merchantOf(tenant); if (!M.SECTIONS.includes(section)) throw new GeneralError('SECTION_UNKNOWN');
      if (section === 'legal') needLegalRead(role);
      const r = await READERS[section](id);
      const extra = section === 'selling_modes' ? { catalogueFamilies: await catalogueFamilies(id) } : {};
      return { section, ...r, ...extra, canWrite: canWrite(role) };
    },
    /** Saves ONE section. `expectedVersion` is the version the form was loaded with (null while the section never existed). */
    async save({ tenant, role, actor, section, data, expectedVersion = null }) {
      const id = merchantOf(tenant); needWrite(role);
      if (!M.SECTIONS.includes(section) || section === 'establishments') throw new GeneralError('SECTION_UNKNOWN');
      if (section === 'legal') needLegalRead(role);
      let checked;
      if (section === 'profile') checked = M.validateProfile(data, { country: await profileCountry(id) });
      else if (section === 'activity') checked = M.validateActivity(data);
      else if (section === 'selling_modes') checked = M.validateSellingModes(data, { catalogueFamilies: await catalogueFamilies(id) });
      else if (section === 'regional') checked = M.validateRegional(data);
      else checked = M.validateLegal(data);
      if (!checked.ok) throw new GeneralError('VALIDATION', 'Des champs sont invalides ; rien n’a été enregistré.', { errors: checked.errors });
      let result;
      if (section === 'regional') result = await repo.saveRegional(id, checked.value, expectedVersion ? String(expectedVersion) : '', actor);
      else if (section === 'profile') { const { name, ...rest } = checked.value; result = await repo.saveSection(id, 'profile', rest, expectedVersion ?? null, actor, { name }); }
      else result = await repo.saveSection(id, section, checked.value, expectedVersion ?? null, actor);
      if (!result.ok) throw new GeneralError('CONFLICT', 'Cette rubrique a été modifiée entre-temps ; rien n’a été remplacé.', { current: await READERS[section](id) });
      return { ok: true, section, ...(await READERS[section](id)) };
    },

    // ---- establishments ----
    async saveEstablishment({ tenant, role, actor, establishment, expectedVersion = null }) {
      const id = merchantOf(tenant); needWrite(role);
      const checked = M.validateEstablishment(establishment); if (!checked.ok) throw new GeneralError('VALIDATION', 'Des champs sont invalides ; rien n’a été enregistré.', { errors: checked.errors });
      const rows = await repo.listEstablishments(id);
      if (!establishment?.id) {
        const primary = !rows.some((r) => r.is_primary && !r.archived_at); // the first active place becomes the main one
        const made = await repo.createEstablishment(id, checked.value, { primary, actor }); if (!made.ok) throw new GeneralError('CONFLICT', 'Un établissement principal existe déjà.');
        return { ok: true, ...(await readEstablishments(id)), id: made.row.id };
      }
      const cur = rows.find((r) => r.id === establishment.id); if (!cur) throw new GeneralError('NOT_FOUND', 'Établissement inconnu.');
      if (cur.archived_at) throw new GeneralError('ARCHIVED', 'Un établissement archivé ne se modifie pas : restaurez-le d’abord.');
      const upd = await repo.updateEstablishment(id, cur.id, { data: checked.value }, expectedVersion ?? cur.version, actor);
      if (!upd.ok) throw new GeneralError('CONFLICT', 'Cet établissement a été modifié entre-temps ; rien n’a été remplacé.', { current: await readEstablishments(id) });
      return { ok: true, ...(await readEstablishments(id)), id: cur.id };
    },
    /** Archiving keeps the row (and its id): the sales and stock references of the past stay valid. The main place cannot be archived while others are active without naming another one first. */
    async archiveEstablishment({ tenant, role, actor, establishmentId, restore = false }) {
      const id = merchantOf(tenant); needWrite(role); const rows = await repo.listEstablishments(id); const cur = rows.find((r) => r.id === establishmentId);
      if (!cur) throw new GeneralError('NOT_FOUND', 'Établissement inconnu.');
      if (!restore && cur.is_primary && rows.some((r) => r.id !== cur.id && !r.archived_at)) throw new GeneralError('PRIMARY_REQUIRED', 'Désignez d’abord un autre établissement principal.');
      if (restore && !cur.archived_at) return { ok: true, ...(await readEstablishments(id)) };
      const upd = await repo.updateEstablishment(id, cur.id, { archived_at: restore ? null : isoDate(now()), ...(restore ? { is_primary: false } : { is_primary: false }) }, cur.version, actor);
      if (!upd.ok) throw new GeneralError('CONFLICT', 'Cet établissement a été modifié entre-temps.');
      return { ok: true, ...(await readEstablishments(id)) };
    },
    async makePrimary({ tenant, role, actor, establishmentId }) {
      const id = merchantOf(tenant); needWrite(role); const rows = await repo.listEstablishments(id); const cur = rows.find((r) => r.id === establishmentId);
      if (!cur || cur.archived_at) throw new GeneralError('NOT_FOUND', 'Établissement inconnu ou archivé.');
      if (cur.is_primary) return { ok: true, ...(await readEstablishments(id)) };
      const old = rows.find((r) => r.is_primary && !r.archived_at);
      if (old) { const a = await repo.updateEstablishment(id, old.id, { is_primary: false }, old.version, actor); if (!a.ok) throw new GeneralError('CONFLICT', 'L’établissement principal a changé entre-temps.'); }
      const b = await repo.updateEstablishment(id, cur.id, { is_primary: true }, cur.version, actor);
      if (!b.ok) { if (old) await repo.updateEstablishment(id, old.id, { is_primary: true }, old.version + 1, actor); throw new GeneralError('CONFLICT', 'Cet établissement a été modifié entre-temps.'); }
      return { ok: true, ...(await readEstablishments(id)) };
    },
  });
}
