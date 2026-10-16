// Parle à Nordla - universal TEXT router (requirement 13). Deterministic, FR/EN keyword + entity + context + permission; no model, no voice.
// It decides WHERE a sentence goes and what is missing; it never guesses an ambiguous entity ("ce fournisseur" with two candidates => ASK) and never executes.
import { MODULE as M, ID_KIND as K, LEVEL } from './constants.js';
import { ACTION_POLICY } from './approval.js';

export const INTENT = Object.freeze({ SEARCH: 'SEARCH', SHOW: 'SHOW', SUMMARIZE: 'SUMMARIZE', COMPARE: 'COMPARE', EXPLAIN: 'EXPLAIN', CALCULATE: 'CALCULATE', CREATE: 'CREATE', ASK: 'ASK' });
export const STATUS = Object.freeze({ ROUTED: 'ROUTED', ASK: 'ASK', BLOCKED: 'BLOCKED', MODULE_NOT_AVAILABLE: 'MODULE_NOT_AVAILABLE', UNROUTABLE: 'UNROUTABLE' });

const norm = (s) => String(s).toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[’']/g, ' ').replace(/\s+/g, ' ').trim();

/** Ordered rules: the first match wins. `needs` lists the entity kinds the command cannot run without. */
const RULES = [
  { id: 'sales_drop', re: /(pourquoi|why).*(vente|ventes|ca |chiffre|sales|revenue).*(baiss|chut|drop|down|decline|diminu)|(baiss|chut|drop|decline).*(vente|ventes|sales)/, intent: INTENT.EXPLAIN, route: [[M.ANALYTICS, 'explain_change']], needs: [] },
  { id: 'supplier_invoices', re: /(facture|invoice).*(fournisseur|supplier)|(fournisseur|supplier).*(facture|invoice)/, intent: INTENT.SEARCH, route: [[M.FINANCE, 'search_invoices']], needs: [K.SUPPLIER], pronoun: /ce fournisseur|this supplier|ce dernier/ },
  { id: 'supplier_finance', re: /(tout|everything|exposition|exposure).*(financ).*(fournisseur|supplier)|(fournisseur|supplier).*(financ|exposition|exposure|engagement)/, intent: INTENT.SUMMARIZE, route: [[M.FINANCE, 'supplier_overview']], needs: [K.SUPPLIER], pronoun: /ce fournisseur|this supplier/ },
  { id: 'compare_suppliers', re: /(compar|meilleur|best|versus|\bvs\b).*(fournisseur|supplier)|(fournisseur|supplier).*(compar|meilleur|best)/, intent: INTENT.COMPARE, route: [[M.CHINA_SOURCING, 'compare']], needs: [K.PRODUCT], pronoun: /ce produit|this product/ },
  { id: 'stock_left', re: /(combien|how many|how much).*(reste|left|remain|stock|dispon)|(reste|left|remain).*(stock|produit)|\bstock\b.*(de|of|du|pour)/, intent: INTENT.SHOW, route: [[M.STOCK_SALES, 'read_availability']], needs: [K.PRODUCT], pronoun: /ce produit|this product|celui la|that one/ },
  { id: 'campaign', re: /(prepar|cree|create|lance|build|monte).*(campagne|campaign)|(campagne|campaign).*(prepar|cree|create)/, intent: INTENT.CREATE, route: [[M.MARKETING, 'build_campaign_contract'], [M.CREATIVE, 'produce_draft']], needs: [K.PRODUCT], pronoun: /ce produit|this product/ },
  { id: 'summarize_case', re: /(resum|summar|synthese|recap).*(dossier|case|file)|(dossier|case).*(resum|summar)/, intent: INTENT.SUMMARIZE, route: 'ACTIVE_CONTEXT', needs: [] },
];
const ACTIVE_MODULE_COMMAND = { [M.CHINA_SOURCING]: 'summarize_case', [M.FINANCE]: 'supplier_overview', [M.STOCK_SALES]: 'read_availability', [M.MARKETING]: 'build_campaign_contract', [M.ANALYTICS]: 'read' };

/**
 * @param {string} text
 * @param {{ active?: {module?, entities?: Record<kind, string[]>}, registry?, permissions?: { modules?: string[] }, available?: (m)=>boolean }} ctx
 * entities[kind] = the refs currently in focus (e.g. the one supplier on screen); more than one => the pronoun is ambiguous.
 */
export function routeUtterance(text, ctx = {}) {
  const t = norm(text);
  const rule = [...RULES, ...(ctx.extraRules ?? [])].find((r) => r.re.test(t)); // extraRules (e.g. Stock / Achats) are tried only after every built-in rule
  if (!rule) return { status: STATUS.UNROUTABLE, text, reason: 'no module claims this sentence' };

  // "résume ce dossier": the active context decides the module (never a default)
  let route = rule.route;
  if (route === 'ACTIVE_CONTEXT') {
    const mod = ctx.active?.module;
    if (!mod || !ACTIVE_MODULE_COMMAND[mod]) return { status: STATUS.ASK, intent: rule.intent, rule: rule.id, question: 'Quel dossier ? Aucun contexte actif.', reason: 'NO_ACTIVE_CONTEXT' };
    route = [[mod, ACTIVE_MODULE_COMMAND[mod]]];
  }

  // entities: a named mention is resolved through the registry; a pronoun through the active context. Several candidates = ASK.
  const entities = {};
  for (const kind of rule.needs) {
    const r = resolveEntity({ kind, t, rule, ctx });
    if (r.status) return { ...r, intent: rule.intent, rule: rule.id, route: route.map(([module, command]) => ({ module, command })) };
    entities[kind] = r.ref;
  }

  const steps = route.map(([module, command]) => ({ module, command, level: ACTION_POLICY[`${module}.${command}`] ?? LEVEL.BLOCKED }));
  const available = ctx.available ?? (() => true);
  const missing = steps.find((s) => !available(s.module));
  if (missing) return { status: STATUS.MODULE_NOT_AVAILABLE, intent: rule.intent, rule: rule.id, module: missing.module, route: steps, entities };
  const allowed = ctx.permissions?.modules;
  const denied = allowed && steps.find((s) => !allowed.includes(s.module));
  if (denied) return { status: STATUS.BLOCKED, intent: rule.intent, rule: rule.id, reason: `no permission on ${denied.module}`, route: steps, entities };
  const blocked = steps.find((s) => s.level === LEVEL.BLOCKED);
  if (blocked) return { status: STATUS.BLOCKED, intent: rule.intent, rule: rule.id, reason: `${blocked.module}.${blocked.command} is blocked`, route: steps, entities };
  return { status: STATUS.ROUTED, intent: rule.intent, rule: rule.id, route: steps, entities, needs_approval: steps.some((s) => s.level === LEVEL.OWNER_APPROVAL_REQUIRED), needs_review: steps.some((s) => s.level === LEVEL.OWNER_REVIEW) };
}

function resolveEntity({ kind, t, rule, ctx }) {
  const focus = ctx.active?.entities?.[kind] ?? [];
  if (rule.pronoun?.test(t) || /\b(ce|cet|cette|this|that|celui|ca)\b/.test(t) && !namedMention(kind, t, ctx)) {
    if (focus.length === 1) return { ref: focus[0] };
    if (focus.length > 1) return { status: STATUS.ASK, reason: 'AMBIGUOUS_REFERENCE', question: `Lequel ? ${focus.length} possibilités`, options: focus };
    return { status: STATUS.ASK, reason: 'NO_ENTITY_IN_CONTEXT', question: `Quel ${kind === K.SUPPLIER ? 'fournisseur' : 'produit'} ?` };
  }
  const named = namedMention(kind, t, ctx);
  if (named) {
    if (named.length === 1) return { ref: named[0].ref };
    return { status: STATUS.ASK, reason: 'AMBIGUOUS_NAME', question: 'Plusieurs correspondances', options: named.map((n) => n.ref) };
  }
  if (focus.length === 1) return { ref: focus[0] };
  if (focus.length > 1) return { status: STATUS.ASK, reason: 'AMBIGUOUS_REFERENCE', question: 'Lequel ?', options: focus };
  return { status: STATUS.ASK, reason: 'NO_ENTITY', question: `Quel ${kind === K.SUPPLIER ? 'fournisseur' : 'produit'} ?` };
}

/** Names the registry knows, found in the sentence. null = no known name mentioned. */
function namedMention(kind, t, ctx) {
  if (!ctx.registry) return null;
  const hits = ctx.registry.all(kind).filter((e) => t.includes(norm(e.display)) || norm(e.display).split(' ').filter((w) => w.length > 3).some((w) => t.includes(w) && e.display));
  return hits.length ? hits : null;
}
