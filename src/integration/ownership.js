// Single source of truth (requirement 2): one owner per entity. A module may READ other entities through the hub; it may WRITE only what it owns.
// Where the code today does not match this table the gap is listed in KNOWN_DUPLICATIONS (reported, never silently refactored).
import { ENTITY as E, MODULE as M, ERR, fail, deepFreeze } from './constants.js';

export const OWNERSHIP = deepFreeze({
  [E.PRODUCT]: { owner: M.STOCK_SALES, note: 'catalogue + variants (Shopify is a temporary source, NDR-012); Marketing/Sourcing/Creative hold product_ref only' },
  [E.SUPPLIER]: { owner: M.FINANCE, note: 'fin_companies is the supplier identity record; Sourcing keeps only per-case supplier CLAIMS until linked to it' },
  [E.CUSTOMER]: { owner: M.STOCK_SALES, note: 'pseudonymised customer keys from the sales ledger' },
  [E.ORDER]: { owner: M.STOCK_SALES, note: 'sales orders' },
  [E.PURCHASE]: { owner: M.BUYING, note: 'purchase plan lifecycle (PLANNED -> approved for order); placing the order and paying it are separate approved actions' },
  [E.INVOICE]: { owner: M.FINANCE, note: 'supplier and customer invoices' },
  [E.PAYMENT]: { owner: M.FINANCE, note: 'payments and allocations' },
  [E.STOCK]: { owner: M.STOCK_SALES, note: 'on-hand per variant/location; incoming expectations are a separate bucket that never counts as available' },
  [E.CAMPAIGN]: { owner: M.MARKETING, note: 'objective, audience, offer, channel; Creative references campaign_ref and keeps no campaign state of its own' },
  [E.CREATIVE_ASSET]: { owner: M.CREATIVE, note: 'visual execution and its status' },
  [E.BRAND_PROFILE]: { owner: M.BRANDING, note: 'brand identity, constraints, approved claim registry' },
  [E.SOURCING_CASE]: { owner: M.CHINA_SOURCING, note: 'case, quotes, evidence, negotiation history, verdict' },
  [E.FINANCIAL_FACT]: { owner: M.FINANCE, note: 'every landed cost, margin, cash requirement and exposure figure shown to the owner' },
  [E.SOCIAL_POST]: { owner: M.SOCIAL_PUBLISHING, note: 'calendar, owner approval (signed, bound to the exact content) and publication of a social post; Creative proposes (social-post-proposal.v1) and never approves, schedules or publishes' },
  [E.CLAIM_EVIDENCE]: { owner: M.BRANDING, note: 'Marketing proposes claims, Branding approves them, Creative only consumes approved ones; nobody but Finance/Stock creates the underlying commercial fact' },
});

/** Declared reads: which modules may read which entity (through the hub). Everything else is refused. */
export const READS = deepFreeze({
  [E.PRODUCT]: [M.MARKETING, M.CREATIVE, M.CHINA_SOURCING, M.BUYING, M.FINANCE, M.ANALYTICS, M.GROWTH, M.PARLE_A_NORDLA],
  [E.SUPPLIER]: [M.CHINA_SOURCING, M.BUYING, M.ANALYTICS, M.PARLE_A_NORDLA],
  [E.PURCHASE]: [M.FINANCE, M.STOCK_SALES, M.MARKETING, M.ANALYTICS, M.PARLE_A_NORDLA],
  [E.STOCK]: [M.MARKETING, M.BUYING, M.ANALYTICS, M.GROWTH, M.PARLE_A_NORDLA],
  [E.SOURCING_CASE]: [M.BUYING, M.FINANCE, M.PARLE_A_NORDLA],
  [E.CAMPAIGN]: [M.CREATIVE, M.ANALYTICS, M.PARLE_A_NORDLA],
  [E.CREATIVE_ASSET]: [M.MARKETING, M.ANALYTICS, M.PARLE_A_NORDLA],
  [E.BRAND_PROFILE]: [M.MARKETING, M.CREATIVE, M.PARLE_A_NORDLA],
  [E.CLAIM_EVIDENCE]: [M.MARKETING, M.CREATIVE],
  [E.FINANCIAL_FACT]: [M.BUYING, M.CHINA_SOURCING, M.ANALYTICS, M.PARLE_A_NORDLA],
  [E.INVOICE]: [M.ANALYTICS, M.PARLE_A_NORDLA],
  [E.PAYMENT]: [M.ANALYTICS, M.PARLE_A_NORDLA],
  [E.ORDER]: [M.ANALYTICS, M.MARKETING, M.GROWTH, M.FINANCE],
  [E.CUSTOMER]: [M.ANALYTICS, M.GROWTH],
  [E.SOCIAL_POST]: [M.CREATIVE, M.MARKETING, M.ANALYTICS, M.PARLE_A_NORDLA],
});

export const ownerOf = (entity) => OWNERSHIP[entity]?.owner ?? null;
export function assertCanWrite(module, entity) {
  const owner = ownerOf(entity);
  if (!owner) fail(ERR.OWNERSHIP_VIOLATION, `unknown entity ${entity}`);
  if (owner !== module) fail(ERR.OWNERSHIP_VIOLATION, `${module} cannot write ${entity}: it belongs to ${owner}`, { module, entity, owner });
}
export function assertCanRead(module, entity) {
  const owner = ownerOf(entity);
  if (!owner) fail(ERR.OWNERSHIP_VIOLATION, `unknown entity ${entity}`);
  if (module !== owner && !(READS[entity] ?? []).includes(module)) fail(ERR.OWNERSHIP_VIOLATION, `${module} may not read ${entity} (owner ${owner})`, { module, entity, owner });
}

/** Where today's code already breaks the table. Documented, not fixed (CLAUDE.md rule 14): each needs its own approved task. */
export const KNOWN_DUPLICATIONS = deepFreeze([
  { id: 'DUP-LANDED-COST', severity: 'HIGH', where: ['src/sourcing/core/landed.js', 'src/sourcing/core/economics.js', 'src/buying/economics.js', 'src/finance/purchase-analysis.js'],
    what: 'three landed-cost / margin engines (Sourcing integer EUR minor, Buying floats, Finance new purchase-analysis). Finance is the authority for the integration handoff; Sourcing and Buying still compute their own.',
    migration: 'Sourcing keeps its field estimate as ADVISORY; the Buying handoff always asks Finance; later retire Sourcing landed.js behind a Finance call.' },
  { id: 'DUP-MONEY-TYPE', severity: 'MEDIUM', where: ['src/sourcing/core/money.js', 'src/finance/money.js'], what: 'two integer money libraries with different scales (minor units vs cents/micro)', migration: 'adapt at the boundary only' },
  { id: 'DUP-SUPPLIER', severity: 'MEDIUM', where: ['src/sourcing/core/supplier.js', 'src/finance/contacts.js'], what: 'Sourcing identifies a supplier by name string per case; Finance by UUID company', migration: 'link through the identity registry; Sourcing keeps claims only' },
  { id: 'DUP-PROVENANCE-ENUMS', severity: 'LOW', where: ['src/sourcing/core/provenance.js', 'src/marketing/provenance.js', 'src/branding/constants.js', 'src/buying/contract.js'], what: 'at least 8 provenance enums; mapped in src/integration/provenance.js, none replaced', migration: 'keep mapping; unify only with an approved Socle change (NDR-010)' },
  { id: 'DUP-CAMPAIGN-STATE', severity: 'MEDIUM', where: ['src/marketing/marketing-run.js', 'src/creative-campaign/campaign-planner.js'], what: 'Marketing push/run and Creative campaign plan both hold objective/audience/channel; no mapping existed', migration: 'integration campaign contract is the single source; Creative receives a projection' },
  { id: 'DUP-PO-NONE', severity: 'HIGH', where: ['src/buying'], what: 'no purchase order / commitment / incoming-stock object existed anywhere; the integration layer defines the minimal PurchasePlan and IncomingExpectation, in memory', migration: 'persist (Supabase tables) in a separate approved task' },
]);
