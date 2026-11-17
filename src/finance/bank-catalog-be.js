// The Belgian banks Nordla Finance offers for a read-only connection, mapped to the names Enable Banking uses (official sources consulted 2026-11-17:
// enablebanking.com/open-banking-apis/belgium and enablebanking.com/docs/markets/be/). DATA only: nothing here contacts a bank.
//
// `names` = the ASPSP name candidates, most likely first. Enable Banking prints "Belfius" on one page and "Belfius Bank" on another, so the exact string must be matched against
// the provider's own ASPSP list at the first real call (matchAspsp below does it, case-insensitively, and refuses when nothing matches: never a guessed bank).
// `notes` are facts from the provider's Belgium page that change what the merchant sees.
const BE = 'BE';
export const BELGIAN_BANKS = Object.freeze([
  { key: 'kbc', label: 'KBC', group: 'KBC Group', names: ['KBC'], country: BE, notes: ['Le client choisit « privé » ou « professionnel » sur la page web de la banque.', 'Les comptes de carte de crédit ne sont pas pris en charge.'] },
  { key: 'cbc', label: 'CBC', group: 'KBC Group', names: ['CBC'], country: BE, notes: ['Même parcours que KBC (privé / professionnel).', 'Les comptes de carte de crédit ne sont pas pris en charge.'] },
  { key: 'kbc-brussels', label: 'KBC Brussels', group: 'KBC Group', names: ['KBC Brussels'], country: BE, notes: ['Même parcours que KBC (privé / professionnel).'] },
  { key: 'belfius', label: 'Belfius', group: 'Belfius', names: ['Belfius', 'Belfius Bank'], country: BE, notes: ['Application Belfius Mobile si elle est installée sur le même appareil ; sinon itsme ou lecteur de carte.'] },
  { key: 'bnp-paribas-fortis', label: 'BNP Paribas Fortis', group: 'BNP Paribas Fortis', names: ['BNP Paribas Fortis'], country: BE, notes: ['itsme ou lecteur de carte, choisi sur la page de la banque.'] },
  { key: 'ing', label: 'ING', group: 'ING', names: ['ING'], country: BE, notes: ['Application ING Banking si elle est installée ; sinon itsme (par défaut), lecteur de carte, QR code ou méthodes Isabel.'] },
  { key: 'argenta', label: 'Argenta', group: 'Argenta', names: ['Argenta'], country: BE, notes: ['Application Argenta si elle est installée ; sinon Digipass ou itsme.'] },
  { key: 'beobank', label: 'Beobank', group: 'Beobank', names: ['Beobank'], country: BE, notes: ['Listée par Enable Banking ; aucune particularité d’authentification n’est décrite sur sa page Belgique.'] },
  // AXA Bank Belgium no longer exists under that name: its customers are Crelan customers. Enable Banking lists it as « Crelan (AXA Bank) ».
  { key: 'axa', label: 'AXA Banque (aujourd’hui Crelan)', group: 'Crelan', names: ['Crelan', 'Crelan (AXA Bank)'], country: BE, aliasOf: 'crelan', notes: ['AXA Bank Belgium est devenue Crelan : la connexion se fait avec Crelan.', 'Les comptes de carte de crédit ne sont pas pris en charge.'] },
  { key: 'crelan', label: 'Crelan', group: 'Crelan', names: ['Crelan', 'Crelan (AXA Bank)'], country: BE, notes: ['Les comptes de carte de crédit ne sont pas pris en charge.'] },
]);

const BY_KEY = new Map(BELGIAN_BANKS.map((b) => [b.key, b]));
const norm = (s) => String(s ?? '').normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase().replace(/\s+/g, ' ').trim();

/** @returns {object|null} the catalogue entry of a bank key, or null. */
export const belgianBank = (key) => BY_KEY.get(String(key ?? '').toLowerCase()) ?? null;

/** The default ASPSP value (first candidate name) to send until the provider's own list is read. */
export function aspspOf(key) {
  const b = belgianBank(key); if (!b) return null;
  return { name: b.names[0], country: b.country };
}

/**
 * Matches a bank key against the provider's own ASPSP list (rows with at least a `name` and a `country`): exact name first (case/space/accent-insensitive), candidates in order.
 * @returns {{ name: string, country: string }|null} null when the provider does not list this bank for this country: the caller must refuse, never guess.
 */
export function matchAspsp(list, key) {
  const b = belgianBank(key); if (!b || !Array.isArray(list)) return null;
  const rows = list.filter((r) => r && typeof r.name === 'string' && norm(r.country ?? b.country) === norm(b.country));
  for (const candidate of b.names) { const hit = rows.find((r) => norm(r.name) === norm(candidate)); if (hit) return { name: hit.name, country: hit.country ?? b.country }; }
  return null;
}
