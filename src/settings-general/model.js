// Paramètres -> Général: the options of this first version and the SERVER-SIDE validation of the six sections.
// Pure functions: no I/O, no default belonging to any merchant. An unknown value is "À renseigner" (null / empty), never a guess.
// Every validator returns { ok, value, errors } where errors is { "<field path>": "<message in French>" }; an invalid input changes nothing.
import { isIanaTimeZone } from '../metrics/profile.js';

export const SECTIONS = Object.freeze(['profile', 'activity', 'establishments', 'selling_modes', 'regional', 'legal', 'objectives']);
export const OTHER = 'other';
export const MAIN_ACTIVITIES = Object.freeze({ retail: 'Vente au détail', wholesale: 'Commerce de gros ou distribution', craft: 'Fabrication ou artisanat', services: 'Prestation de services', food: 'Restauration', other: 'Autre' });
export const SIDE_ACTIVITIES = Object.freeze({ personalisation: 'Personnalisation à la demande', printing: 'Impression ou marquage', craft: 'Fabrication artisanale', repair: 'Réparation ou installation', services: 'Prestation de services', b2b: 'Distribution B2B', other: 'Autre' });
export const CHANNELS = Object.freeze({ shop: 'Boutique physique', online: 'Boutique en ligne', marketplace: 'Marketplace', social: 'Réseaux sociaux ou messagerie', quote: 'Vente directe sur devis', events: 'Marchés ou événements', other: 'Autre' });
export const CLIENTELE = Object.freeze({ individuals: 'Particuliers', professionals: 'Professionnels', both: 'Les deux' });
export const PLACE_FUNCTIONS = Object.freeze({ shop: 'Boutique', workshop: 'Atelier', depot: 'Dépôt', office: 'Bureau', pickup: 'Point de retrait', other: 'Autre' });
export const SELLING_MODES = Object.freeze({ stock: 'Vente sur stock', personalised: 'Personnalisation à la demande', made_to_order: 'Fabrication à la commande', preorder: 'Précommande', service: 'Prestation de services', other: 'Autre' });
export const PRIORITIES = Object.freeze({ sales: 'Développer les ventes', traffic: 'Attirer du monde en boutique', awareness: 'Faire connaître le commerce', margin: 'Protéger la marge', clearance: 'Écouler un stock', launch: 'Lancer une offre ou un produit', retention: 'Fidéliser les clients', other: 'Autre' });
export const BUDGET_PERIODS = Object.freeze({ month: 'Par mois', campaign: 'Par campagne', total: 'Au total' });
export const VAT_STATUS = Object.freeze({ unknown: 'À renseigner', registered: 'Identifié à la TVA', none: 'Sans numéro de TVA' });
export const DAYS = Object.freeze(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']);
export const DAY_LABEL = Object.freeze({ mon: 'Lundi', tue: 'Mardi', wed: 'Mercredi', thu: 'Jeudi', fri: 'Vendredi', sat: 'Samedi', sun: 'Dimanche' });
// Legal forms offered per country; "Autre" is always possible. Extensible: a country that is not listed only gets "Autre".
export const LEGAL_FORMS = Object.freeze({ BE: ['SRL', 'SA', 'SC', 'SNC', 'SComm', 'ASBL', 'Entreprise individuelle (personne physique)'], FR: ['SAS', 'SARL', 'EURL', 'SA', 'Micro-entreprise', 'Entreprise individuelle'], LU: ['SARL', 'SA', 'Entreprise individuelle'], NL: ['BV', 'NV', 'Eenmanszaak', 'VOF'] });
export const COUNTRIES = Object.freeze({ BE: 'Belgique', FR: 'France', LU: 'Luxembourg', NL: 'Pays-Bas', DE: 'Allemagne', ES: 'Espagne', IT: 'Italie', GB: 'Royaume-Uni', CH: 'Suisse' });

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const text = (v) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : '');
const orNull = (v) => text(v) || null;
const bad = (errors, path, msg) => { errors[path] = msg; };
const done = (errors, value) => ({ ok: Object.keys(errors).length === 0, value: Object.keys(errors).length === 0 ? value : null, errors });

export const validEmail = (v) => /^[^\s@<>()]{1,64}@[^\s@<>()]{1,255}\.[A-Za-z]{2,}$/.test(v) && v.length <= 254;
export const validHttpsUrl = (v) => { try { const u = new URL(v); return u.protocol === 'https:' && !!u.hostname.includes('.') && !u.username && !u.password && v.length <= 300; } catch { return false; } };
/** International (+32 ...) always; the national format is accepted for Belgium only (0xx...). */
export function normalisePhone(v, country) {
  const raw = text(v).replace(/[\s.\-/()]/g, ''); if (!raw) return null;
  if (/^\+[1-9]\d{6,14}$/.test(raw)) return raw;
  if (/^00[1-9]\d{6,14}$/.test(raw)) return `+${raw.slice(2)}`;
  if (country === 'BE' && /^0[1-9]\d{7,8}$/.test(raw)) return `+32${raw.slice(1)}`;
  return undefined;
}
/** Belgian enterprise number (BCE): 10 digits, first 0 or 1, the last two = 97 - (first eight mod 97). Spaces and dots are accepted, stored as 0000.000.000. */
export function normaliseBce(v) {
  const d = text(v).replace(/[\s.]/g, ''); if (!/^[01]\d{9}$/.test(d)) return undefined;
  if (97 - (Number(d.slice(0, 8)) % 97) !== Number(d.slice(8))) return undefined;
  return `${d.slice(0, 4)}.${d.slice(4, 7)}.${d.slice(7)}`;
}
export function normaliseBeVat(v) {
  const d = text(v).replace(/[\s.]/g, '').toUpperCase().replace(/^BE/, ''); const bce = normaliseBce(d); return bce ? `BE${d}` : undefined;
}

/** A choice with an optional free label: [{ value, label? }]. "other" needs its label. Duplicates are refused. */
function choices(input, options, path, errors, { max = 12, labelled = [] } = {}) {
  if (input == null) return [];
  if (!Array.isArray(input)) { bad(errors, path, 'Liste attendue.'); return []; }
  if (input.length > max) { bad(errors, path, `Au plus ${max} choix.`); return []; }
  const out = []; const seen = new Set();
  for (const item of input) {
    const value = text(isObj(item) ? item.value : item); const label = orNull(isObj(item) ? item.label : null);
    if (!Object.hasOwn(options, value)) { bad(errors, path, 'Choix inconnu.'); continue; }
    if (seen.has(value)) { bad(errors, path, 'Choix en double.'); continue; }
    if (value === OTHER && !label) { bad(errors, path, 'Précisez le libellé pour « Autre ».'); continue; }
    if (label && label.length > 60) { bad(errors, path, 'Libellé trop long (60 caractères au plus).'); continue; }
    if (label && value !== OTHER && !labelled.includes(value)) { bad(errors, path, 'Ce choix n’accepte pas de libellé.'); continue; }
    seen.add(value); out.push(label ? { value, label } : { value });
  }
  return out;
}

export function validateProfile(input, { country = null } = {}) {
  const errors = {}; const v = isObj(input) ? input : {};
  const name = text(v.name); if (!name) bad(errors, 'name', 'Le nom commercial est obligatoire.'); else if (name.length > 80) bad(errors, 'name', 'Nom trop long (80 caractères au plus).');
  const description = orNull(v.description); if (description && description.length > 280) bad(errors, 'description', 'Description trop longue (280 caractères au plus).');
  const website = orNull(v.website); if (website && !validHttpsUrl(website)) bad(errors, 'website', 'Adresse HTTPS attendue (https://exemple.be).');
  const email = orNull(v.email); if (email && !validEmail(email)) bad(errors, 'email', 'Adresse e-mail invalide.');
  const phoneIn = orNull(v.phone); const phone = phoneIn ? normalisePhone(phoneIn, country) : null; if (phoneIn && phone === undefined) bad(errors, 'phone', country === 'BE' ? 'Numéro invalide : format international (+32 81 00 00 00) ou belge (081 00 00 00).' : 'Numéro invalide : utilisez le format international (+32 …).');
  return done(errors, { name, description, website, email, phone }); // logo: not part of this version (see the capabilities in the service)
}

export function validateActivity(input) {
  const errors = {}; const v = isObj(input) ? input : {};
  const mainValue = orNull(isObj(v.main) ? v.main.value : v.main); const mainLabel = orNull(isObj(v.main) ? v.main.label : null);
  let main = null;
  if (mainValue) { if (!Object.hasOwn(MAIN_ACTIVITIES, mainValue)) bad(errors, 'main', 'Activité inconnue.'); else if (mainValue === OTHER && !mainLabel) bad(errors, 'main', 'Précisez le libellé pour « Autre ».'); else main = mainLabel ? { value: mainValue, label: mainLabel } : { value: mainValue }; }
  const complementary = choices(v.complementary, SIDE_ACTIVITIES, 'complementary', errors, { labelled: ['printing', 'personalisation', 'craft', 'repair', 'services'] });
  const channels = choices(v.channels, CHANNELS, 'channels', errors);
  const clientele = orNull(v.clientele); if (clientele && !Object.hasOwn(CLIENTELE, clientele)) bad(errors, 'clientele', 'Clientèle inconnue.');
  return done(errors, { main, complementary, channels, clientele });
}

export function validateSellingModes(input, { catalogueFamilies = [] } = {}) {
  const errors = {}; const v = isObj(input) ? input : {};
  const modes = choices(v.modes, SELLING_MODES, 'modes', errors, { max: 6 });
  // a precision per family exists ONLY for families that are already in the catalogue
  const byFamily = {};
  if (v.by_family != null) {
    if (!isObj(v.by_family)) bad(errors, 'by_family', 'Objet attendu.');
    else for (const [family, list] of Object.entries(v.by_family)) {
      if (!catalogueFamilies.includes(family)) { bad(errors, `by_family.${family}`, 'Cette famille n’existe pas dans le catalogue.'); continue; }
      byFamily[family] = choices(list, SELLING_MODES, `by_family.${family}`, errors, { max: 6 });
    }
  }
  return done(errors, { modes, by_family: byFamily });
}

/** @param {{ now?: Date }} o `now` only for the preview in the UI; the validation itself is date free */
export function validateRegional(input) {
  const errors = {}; const v = isObj(input) ? input : {};
  const currency = text(v.currency).toUpperCase(); const known = new Set(Intl.supportedValuesOf('currency'));
  if (!currency) bad(errors, 'currency', 'La devise de référence est obligatoire.'); else if (!known.has(currency)) bad(errors, 'currency', 'Code de devise ISO 4217 inconnu.');
  const timezone = text(v.timezone); if (!timezone) bad(errors, 'timezone', 'Le fuseau horaire est obligatoire.'); else if (!isIanaTimeZone(timezone)) bad(errors, 'timezone', 'Fuseau horaire inconnu (exemple : Europe/Brussels).');
  return done(errors, { currency, timezone });
}

export function validateLegal(input) {
  const errors = {}; const v = isObj(input) ? input : {};
  const legalName = orNull(v.legal_name); if (legalName && legalName.length > 120) bad(errors, 'legal_name', 'Raison sociale trop longue (120 caractères au plus).');
  const country = orNull(v.country)?.toUpperCase() ?? null; if (country && !Object.hasOwn(COUNTRIES, country)) bad(errors, 'country', 'Pays inconnu.');
  const formIn = orNull(isObj(v.legal_form) ? v.legal_form.value : v.legal_form); const formLabel = orNull(isObj(v.legal_form) ? v.legal_form.label : null);
  let legalForm = null;
  if (formIn) { const list = LEGAL_FORMS[country] ?? []; if (formIn === OTHER) { if (!formLabel) bad(errors, 'legal_form', 'Précisez la forme juridique.'); else legalForm = { value: OTHER, label: formLabel }; } else if (!list.includes(formIn)) bad(errors, 'legal_form', 'Forme juridique inconnue pour ce pays.'); else legalForm = { value: formIn }; }
  let enterprise = orNull(v.enterprise_number);
  if (enterprise) { if (country === 'BE') { const n = normaliseBce(enterprise); if (n) enterprise = n; else bad(errors, 'enterprise_number', 'Numéro d’entreprise (BCE) invalide : 10 chiffres, clé de contrôle comprise.'); } else if (enterprise.length > 30 || !/^[A-Za-z0-9 .\-/]+$/.test(enterprise)) bad(errors, 'enterprise_number', 'Identifiant invalide.'); }
  const vatStatus = orNull(v.vat_status) ?? 'unknown'; if (!Object.hasOwn(VAT_STATUS, vatStatus)) bad(errors, 'vat_status', 'Statut TVA inconnu.');
  let vatNumber = orNull(v.vat_number);
  if (vatStatus !== 'registered' && vatNumber) bad(errors, 'vat_number', 'Un numéro de TVA ne s’indique que pour un commerce identifié à la TVA.');
  else if (vatStatus === 'registered') { if (!vatNumber) bad(errors, 'vat_number', 'Indiquez le numéro de TVA.'); else if (country === 'BE') { const n = normaliseBeVat(vatNumber); if (n) vatNumber = n; else bad(errors, 'vat_number', 'Numéro de TVA belge invalide (BE + 10 chiffres, clé de contrôle comprise).'); } else if (!/^[A-Za-z]{2}[A-Za-z0-9]{2,12}$/.test(vatNumber.replace(/[\s.]/g, ''))) bad(errors, 'vat_number', 'Numéro de TVA invalide.'); else vatNumber = vatNumber.replace(/[\s.]/g, '').toUpperCase(); }
  const billing = isObj(v.billing) ? v.billing : {}; const usePrimary = billing.use_primary !== false && !(billing.street || billing.postal_code || billing.city);
  let billingOut = { use_primary: true };
  if (!usePrimary) {
    const a = address(billing, 'billing', errors); billingOut = { use_primary: false, ...a };
  }
  const email = orNull(v.email); if (email && !validEmail(email)) bad(errors, 'email', 'Adresse e-mail invalide.');
  return done(errors, { legal_name: legalName, country, legal_form: legalForm, enterprise_number: enterprise, vat_status: vatStatus, vat_number: vatStatus === 'registered' ? vatNumber : null, billing: billingOut, email });
}

function address(a, prefix, errors, { required = true } = {}) {
  const street = orNull(a.street); const complement = orNull(a.complement); const postal = orNull(a.postal_code); const city = orNull(a.city); const country = orNull(a.country)?.toUpperCase() ?? null;
  if (required) { if (!street) bad(errors, `${prefix}.street`, 'Adresse obligatoire.'); if (!postal) bad(errors, `${prefix}.postal_code`, 'Code postal obligatoire.'); if (!city) bad(errors, `${prefix}.city`, 'Ville obligatoire.'); if (!country) bad(errors, `${prefix}.country`, 'Pays obligatoire.'); }
  if (country && !Object.hasOwn(COUNTRIES, country)) bad(errors, `${prefix}.country`, 'Pays inconnu.');
  for (const [k, val, max] of [['street', street, 120], ['complement', complement, 80], ['postal_code', postal, 12], ['city', city, 80]]) if (val && val.length > max) bad(errors, `${prefix}.${k}`, `Trop long (${max} caractères au plus).`);
  return { street, complement, postal_code: postal, city, country };
}

const MIN = /^([01]\d|2[0-3]):[0-5]\d$/;
const minutes = (t) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3));
/** Slots of one day: each { from, to } "HH:MM", from < to, sorted, no overlap. [] = closed. */
function slotsOf(list, path, errors) {
  if (list == null) return [];
  if (!Array.isArray(list)) { bad(errors, path, 'Liste de créneaux attendue.'); return []; }
  if (list.length > 4) { bad(errors, path, 'Au plus 4 créneaux par jour.'); return []; }
  const slots = [];
  for (const s of list) {
    const from = text(s?.from); const to = text(s?.to);
    if (!MIN.test(from) || !MIN.test(to)) { bad(errors, path, 'Heures au format HH:MM.'); return []; }
    if (minutes(from) >= minutes(to)) { bad(errors, path, 'L’heure de fin doit suivre l’heure de début.'); return []; }
    slots.push({ from, to });
  }
  slots.sort((a, b) => minutes(a.from) - minutes(b.from));
  for (let i = 1; i < slots.length; i += 1) if (minutes(slots[i].from) < minutes(slots[i - 1].to)) { bad(errors, path, 'Les créneaux ne doivent pas se chevaucher.'); return []; }
  return slots;
}
const validDate = (d) => /^\d{4}-\d{2}-\d{2}$/.test(d) && !Number.isNaN(Date.parse(`${d}T00:00:00Z`)) && new Date(`${d}T00:00:00Z`).toISOString().startsWith(d);

/** One establishment. Returns { value } without the id / primary flag (those belong to the service). */
export function validateEstablishment(input) {
  const errors = {}; const v = isObj(input) ? input : {};
  const name = text(v.name); if (!name) bad(errors, 'name', 'Le nom du lieu est obligatoire.'); else if (name.length > 80) bad(errors, 'name', 'Nom trop long (80 caractères au plus).');
  const functions = choices(v.functions, PLACE_FUNCTIONS, 'functions', errors, { max: 6 }); if (!functions.length && !errors.functions) bad(errors, 'functions', 'Choisissez au moins une fonction.');
  const addr = address(isObj(v.address) ? v.address : {}, 'address', errors);
  const phoneIn = orNull(v.phone); const phone = phoneIn ? normalisePhone(phoneIn, addr.country) : null; if (phoneIn && phone === undefined) bad(errors, 'phone', 'Numéro invalide : format international (+32 …).');
  const email = orNull(v.email); if (email && !validEmail(email)) bad(errors, 'email', 'Adresse e-mail invalide.');
  const visibility = orNull(v.visibility) ?? 'internal'; if (!['public', 'internal'].includes(visibility)) bad(errors, 'visibility', 'Visibilité inconnue.');
  const publishContact = v.publish_contact === true; if (publishContact && visibility !== 'public') bad(errors, 'publish_contact', 'Un lieu interne ne fournit pas ses coordonnées aux brouillons publics.');
  const hours = {}; const hin = isObj(v.hours) ? v.hours : {};
  for (const d of DAYS) hours[d] = slotsOf(hin[d], `hours.${d}`, errors);
  const exceptions = [];
  if (v.exceptions != null) {
    if (!Array.isArray(v.exceptions)) bad(errors, 'exceptions', 'Liste attendue.');
    else if (v.exceptions.length > 200) bad(errors, 'exceptions', 'Trop d’horaires exceptionnels.');
    else { const seen = new Set(); v.exceptions.forEach((e, i) => {
      const date = text(e?.date); const p = `exceptions.${i}`;
      if (!validDate(date)) { bad(errors, `${p}.date`, 'Date invalide (AAAA-MM-JJ).'); return; }
      if (seen.has(date)) { bad(errors, `${p}.date`, 'Cette date est déjà renseignée.'); return; }
      seen.add(date); const closed = e.closed === true; const slots = closed ? [] : slotsOf(e.slots, `${p}.slots`, errors);
      if (!closed && !slots.length && !errors[`${p}.slots`]) bad(errors, `${p}.slots`, 'Indiquez des créneaux ou cochez « Fermé ».');
      const reason = orNull(e.reason); if (reason && reason.length > 80) bad(errors, `${p}.reason`, 'Motif trop long.');
      exceptions.push({ date, closed, slots, reason });
    }); exceptions.sort((a, b) => a.date.localeCompare(b.date)); }
  }
  return done(errors, { name, functions, address: addr, phone, email, visibility, publish_contact: publishContact, hours, exceptions });
}

/** The hours that apply on a date: an exceptional entry wins over the regular plan. dayOfWeek is derived from the civil date itself (no time zone involved). */
export function hoursOn(establishment, date) {
  const exc = (establishment.exceptions ?? []).find((e) => e.date === date);
  if (exc) return { source: 'exception', closed: exc.closed || !exc.slots.length, slots: exc.slots, reason: exc.reason ?? null };
  const dow = DAYS[(new Date(`${date}T00:00:00Z`).getUTCDay() + 6) % 7]; const slots = establishment.hours?.[dow] ?? [];
  return { source: 'regular', closed: !slots.length, slots, reason: null };
}

/** Objectifs et priorités: what the merchant wants NOW. A context for the modules, not an order: it proves no stock, delay or budget by itself. */
export function validateObjectives(input) {
  const errors = {}; const v = isObj(input) ? input : {};
  const pv = orNull(isObj(v.priority) ? v.priority.value : v.priority); const pl = orNull(isObj(v.priority) ? v.priority.label : null); const pn = orNull(isObj(v.priority) ? v.priority.note : null);
  let priority = null;
  if (pv) { if (!Object.hasOwn(PRIORITIES, pv)) bad(errors, 'priority', 'Priorité inconnue.'); else if (pv === OTHER && !pl) bad(errors, 'priority', 'Précisez la priorité pour « Autre ».'); else if (pl && pl.length > 80) bad(errors, 'priority', 'Libellé trop long (80 caractères au plus).'); else if (pn && pn.length > 200) bad(errors, 'priority', 'Précision trop longue (200 caractères au plus).'); else priority = { value: pv, ...(pl && pv === OTHER ? { label: pl } : {}), ...(pn ? { note: pn } : {}) }; }
  const expected = orNull(v.expected_result); if (expected && expected.length > 200) bad(errors, 'expected_result', 'Résultat attendu trop long (200 caractères au plus).');
  const deadline = orNull(v.deadline); if (deadline && !validDate(deadline)) bad(errors, 'deadline', 'Date invalide (AAAA-MM-JJ).');
  const offers = [];
  if (v.featured_offers != null) {
    if (!Array.isArray(v.featured_offers)) bad(errors, 'featured_offers', 'Liste attendue.');
    else if (v.featured_offers.length > 10) bad(errors, 'featured_offers', 'Au plus 10 offres.');
    else { const seen = new Set(); for (const o of v.featured_offers) { const label = text(isObj(o) ? o.label : o); if (!label) { bad(errors, 'featured_offers', 'Une offre ne peut pas être vide.'); break; } if (label.length > 80) { bad(errors, 'featured_offers', 'Offre trop longue (80 caractères au plus).'); break; } if (seen.has(label.toLowerCase())) { bad(errors, 'featured_offers', 'Offre en double.'); break; } seen.add(label.toLowerCase()); offers.push({ label }); } }
  }
  const c = isObj(v.constraints) ? v.constraints : {}; const b = isObj(c.budget) ? c.budget : {};
  const note = (x, path) => { const t = orNull(x); if (t && t.length > 200) bad(errors, path, 'Trop long (200 caractères au plus).'); return t; };
  let amount = null; if (b.amount !== undefined && b.amount !== null && b.amount !== '') { const n = Number(b.amount); if (!Number.isFinite(n) || n < 0 || n > 1e9) bad(errors, 'constraints.budget.amount', 'Montant invalide (nombre positif).'); else amount = Math.round(n * 100) / 100; }
  const period = orNull(b.period); if (period && !Object.hasOwn(BUDGET_PERIODS, period)) bad(errors, 'constraints.budget.period', 'Période inconnue.'); else if (amount !== null && !period) bad(errors, 'constraints.budget.period', 'Indiquez la période du budget.');
  const constraints = { budget: { amount, period: period || null, note: note(b.note, 'constraints.budget.note') }, time: { note: note(c.time?.note, 'constraints.time.note') }, stock: { note: note(c.stock?.note, 'constraints.stock.note') }, production: { note: note(c.production?.note, 'constraints.production.note') } };
  return done(errors, { priority, expected_result: expected, deadline, featured_offers: offers, constraints });
}
