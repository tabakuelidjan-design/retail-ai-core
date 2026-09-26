// "Parle à Nordla" - backend. Architecture (CLAUDE.md: code calculates, the model explains):
//   1. understand the question deterministically (intent + period) - no model involved;
//   2. read the figures from the latest generated Nordla report (the same numbers every Analytics page shows) - never computed here, never by a model;
//   3. optionally hand ONLY those figures to an AI provider so it can explain them in words;
//   4. return figures + sources + the explanation status. Nothing is ever invented: an unknown question, a missing report or an unavailable
//      provider each produce an explicit status, never a made-up answer.
//
// Provider-neutral: a provider is any object { name, explain({ question, facts, lang, signal }) => Promise<{ text }> }. NO provider is bundled or
// selected here; `loadAssistantProvider` reads NORDLA_ASSISTANT_PROVIDER and looks it up in a registry that is empty today, so with no adapter the
// explanation status is honestly NOT_CONFIGURED (or UNKNOWN_PROVIDER when a name is set that has no adapter).

import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { localDateString } from '../../metrics/windows.js';

const REPORT_NAME = /^report-(\d{4}-\d{2}-\d{2})\.json$/;
export const MAX_QUESTION = 500;
export const EXPLAIN_TIMEOUT_MS = 20_000;

/** Registered provider adapters: name -> (env) => provider. Intentionally empty: adding a provider is a separate, explicit decision. */
export const PROVIDER_REGISTRY = {};

export function loadAssistantProvider(env = process.env, registry = PROVIDER_REGISTRY) {
  const name = String(env.NORDLA_ASSISTANT_PROVIDER ?? '').trim();
  if (!name) return { status: 'NOT_CONFIGURED', provider: null };
  const make = registry[name];
  if (!make) return { status: 'UNKNOWN_PROVIDER', provider: null };
  try { return { status: 'OK', provider: make(env) }; } catch { return { status: 'MISCONFIGURED', provider: null }; }
}

const norm = (s) => String(s ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[’'`´]/g, ' ').replace(/\s+/g, ' ').trim() + ' ';
const has = (q, words) => words.some((w) => q.includes(w));

/** Deterministic intent + period from the question text (French, Dutch, English keywords). Returns null intent when the question is not understood. */
export function understand(question) {
  const q = norm(question);
  const periodWords = { yesterday: ['hier', 'yesterday', 'gisteren'], last_7_days: ['7 jours', '7 derniers jours', '7 days', '7 dagen', 'semaine', 'week'], last_30_days: ['30 jours', '30 derniers jours', '30 days', '30 dagen', 'dernier mois', 'mois dernier', 'last month', 'vorige maand', 'ce mois'] };
  let period = null;
  for (const [k, w] of Object.entries(periodWords)) if (has(q, w)) { period = k; break; }
  // any other explicit span (90 jours, 12 mois, trimestre, annee, year, 3 months ...) is not available in the report
  const unsupportedSpan = period === null && (/\b\d+\s*(jours?|days?|dagen|mois|months?|maanden|semaines?|weeks?)\b/.test(q) || has(q, ['trimestre', 'quarter', 'kwartaal', 'annee', 'year', 'jaar', 'depuis le debut', 'since the start']));
  const intents = [
    ['top_product', ['meilleur produit', 'produit le plus', 'best product', 'top product', 'beste product', 'produit phare', 'best seller', 'meilleure vente']],
    ['top_channel', ['canal', 'channel', 'kanaal', 'point of sale', 'boutique ou en ligne', 'en ligne ou']],
    ['customers', ['client', 'customer', 'klant']],
    ['aov', ['panier moyen', 'average order', 'gemiddelde bestelling', 'gemiddeld winkelmand', 'aov']],
    ['orders', ['commande', 'order', 'bestelling']],
    ['units', ['unites', 'articles vendus', 'units', 'stuks', 'exemplaires', 'pieces vendues']],
    ['refunds', ['rembours', 'refund', 'terugbetal']],
    ['revenue', ['chiffre d affaires', 'chiffre daffaires', 'revenue', 'omzet', 'ventes', 'sales', 'verkoop', 'combien ai-je vendu', 'ca ']],
  ];
  const intent = intents.find(([, w]) => has(q, w))?.[0] ?? null;
  return { intent, period: period ?? 'last_30_days', periodExplicit: period !== null, unsupportedSpan };
}

async function latestReport(reportsDir) {
  reportsDir = reportsDir instanceof URL ? fileURLToPath(reportsDir) : reportsDir;
  const entries = await readdir(reportsDir).catch(() => []);
  const dated = entries.map((f) => ({ f, m: f.match(REPORT_NAME) })).filter((x) => x.m).sort((a, b) => (a.m[1] < b.m[1] ? 1 : -1));
  if (!dated.length) return null;
  try { return { file: dated[0].m[1], report: JSON.parse(await readFile(path.join(reportsDir, dated[0].f), 'utf8')) }; } catch { return null; }
}

const dayBefore = (iso) => new Date(new Date(iso).getTime() - 1);

/** Figures for an intent, copied from the report (never recomputed). Returns { figures } or { unavailable: reason }. */
export function figuresFor(intent, periodKey, report) {
  const s = report.sales?.[periodKey];
  if (!s) return { unavailable: 'PERIOD_NOT_IN_REPORT' };
  const cur = report.currency ?? 'EUR';
  const num = (id, value, extra = {}) => ({ id, value, ...extra });
  if (intent === 'revenue') {
    const f = [num('net_sales_ex_tax', s.net_sales_ex_tax, { currency: cur }), num('net_sales_incl_tax', s.net_sales, { currency: cur })];
    if (s.shipping) f.push(num('shipping_net_ex_tax', s.shipping.net_ex_tax_after_refunds, { currency: cur, note: 'SEPARATE_FROM_PRODUCT_REVENUE' }));
    return { figures: f };
  }
  if (intent === 'orders') return { figures: [num('order_count', s.order_count)] };
  if (intent === 'units') return { figures: [num('units_sold', s.units_sold)] };
  if (intent === 'aov') return { figures: [num('aov_ex_tax', s.aov_ex_tax, { currency: cur })] };
  if (intent === 'refunds') return { figures: [num('refunds_products', s.refunds, { currency: cur }), ...(s.refunds_breakdown ? [num('refunds_total', s.refunds_breakdown.total, { currency: cur })] : [])] };
  // 30-day-only blocks (Explorer)
  const ex = report.explorer?.last_30_days;
  if (periodKey !== 'last_30_days') return { unavailable: 'ONLY_LAST_30_DAYS' };
  if (!ex) return { unavailable: 'PERIOD_NOT_IN_REPORT' };
  if (intent === 'customers') return { figures: [num('active_customers', ex.kpis?.active_customers), num('identified_share', ex.kpis?.identified_share)] };
  if (intent === 'top_product') { const p = ex.top_products?.[0]; return p ? { figures: [num('top_product', p.title, { net_sales_ex_tax: p.net_sales_ex_tax, units_sold: p.units_sold, currency: cur })] } : { unavailable: 'NO_SALES' }; }
  if (intent === 'top_channel') { const c = ex.channels?.[0]; return c ? { figures: [num('top_channel', c.name, { net_sales_ex_tax: c.net_sales_ex_tax, share: c.share, currency: cur })] } : { unavailable: 'NO_SALES' }; }
  return { unavailable: 'PERIOD_NOT_IN_REPORT' };
}

export const SUPPORTED_QUESTIONS = ['revenue', 'orders', 'units', 'aov', 'refunds', 'customers', 'top_product', 'top_channel'];

/**
 * @param {{reportsDir: string|URL, provider?: {name: string, explain: Function}|null, providerStatus?: string, timeoutMs?: number}} deps
 * @returns {Promise<{status: number, body: object}>}
 */
export function createAssistant({ reportsDir, provider = null, providerStatus = provider ? 'OK' : 'NOT_CONFIGURED', timeoutMs = EXPLAIN_TIMEOUT_MS }) {
  return async function ask({ question, lang = 'fr' }) {
    const text = typeof question === 'string' ? question.trim() : '';
    if (!text) return { status: 400, body: { error: { code: 'EMPTY_QUESTION' } } };
    if (text.length > MAX_QUESTION) return { status: 400, body: { error: { code: 'QUESTION_TOO_LONG', max: MAX_QUESTION } } };

    const u = understand(text);
    if (!u.intent) return { status: 422, body: { error: { code: 'UNSUPPORTED_QUESTION', supported: SUPPORTED_QUESTIONS } } };
    if (u.unsupportedSpan) return { status: 422, body: { error: { code: 'UNSUPPORTED_PERIOD', available: ['yesterday', 'last_7_days', 'last_30_days'] } } };

    const rep = await latestReport(reportsDir);
    if (!rep) return { status: 404, body: { error: { code: 'NO_REPORT_AVAILABLE' } } };
    const got = figuresFor(u.intent, u.period, rep.report);
    if (got.unavailable) return { status: 422, body: { error: { code: got.unavailable === 'ONLY_LAST_30_DAYS' ? 'ONLY_LAST_30_DAYS' : got.unavailable === 'NO_SALES' ? 'NO_DATA_FOR_QUESTION' : 'PERIOD_NOT_IN_REPORT', intent: u.intent, period: u.period } } };

    const w = rep.report.sales[u.period].window;
    const tz = w?.timeZone ?? rep.report.merchant_timezone ?? 'UTC';
    const period = w ? { key: u.period, start: localDateString(new Date(w.start), tz), end: localDateString(dayBefore(w.end), tz), timeZone: tz } : { key: u.period };
    const body = { intent: u.intent, period, figures: got.figures, currency: rep.report.currency ?? 'EUR', sources: [{ report: rep.file, generatedAt: rep.report.generated_at }], explanation: { status: providerStatus === 'OK' ? 'PENDING' : providerStatus } };

    if (provider && providerStatus === 'OK') {
      const ac = new AbortController(); let timer;
      try {
        // ONLY the question and the figures above are handed over: no raw orders, no customer data.
        const r = await Promise.race([
          provider.explain({ question: text, facts: { intent: u.intent, period, figures: got.figures, currency: body.currency }, lang, signal: ac.signal }),
          new Promise((_, reject) => { timer = setTimeout(() => { ac.abort(); reject(Object.assign(new Error('timeout'), { code: 'TIMEOUT' })); }, timeoutMs); }),
        ]);
        const out = typeof r?.text === 'string' ? r.text.trim() : '';
        body.explanation = out ? { status: 'OK', provider: provider.name, text: out.slice(0, 2000) } : { status: 'PROVIDER_UNAVAILABLE', provider: provider.name };
      } catch (e) {
        body.explanation = { status: e?.code === 'TIMEOUT' ? 'TIMEOUT' : 'PROVIDER_UNAVAILABLE', provider: provider.name }; // explicit, never hidden; the provider's message is not exposed
      } finally { clearTimeout(timer); }
    }
    return { status: 200, body };
  };
}
