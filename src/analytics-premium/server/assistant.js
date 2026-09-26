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
import { MAX_SPAN_DAYS, periodReport } from './period-engine.js';
import { createToolLayer } from './tools/index.js';
import { createOrchestrator } from './ai/orchestrator.js';

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

/**
 * Explicit period in the question -> a period-engine query ({period, days?}), or null when the question does not name one (the period the user selected in
 * the page is then used). Returns { unsupported: true } for spans the engine does not know (quarter, "since the start"...).
 */
function explicitPeriod(q) {
  const n = /\b(\d{1,4})\s*(?:derniers?\s+)?(jours?|days?|dagen)\b/.exec(q);
  if (n) { const d = Number(n[1]); return d >= 1 && d <= MAX_SPAN_DAYS ? { query: d === 7 ? { period: 'last_7_days' } : d === 30 ? { period: 'last_30_days' } : d === 90 ? { period: 'last_90_days' } : { period: 'last_n_days', days: d }, label: `last_${d}_days` } : { unsupported: true }; }
  if (/\b(3|trois)\s*mois\b|\b3 months\b/.test(q)) return { query: { period: 'last_90_days' }, label: 'last_90_days' };
  if (has(q, ['mois dernier', 'mois precedent', 'last month', 'previous month', 'vorige maand'])) return { query: { period: 'previous_month' }, label: 'previous_month' };
  if (has(q, ['ce mois', 'this month', 'deze maand', 'mois en cours'])) return { query: { period: 'this_month' }, label: 'this_month' };
  if (has(q, ['cette semaine', 'this week', 'deze week'])) return { query: { period: 'this_week' }, label: 'this_week' };
  if (has(q, ['cette annee', 'this year', 'dit jaar'])) return { query: { period: 'this_year' }, label: 'this_year' };
  if (has(q, ['hier', 'yesterday', 'gisteren'])) return { query: { period: 'yesterday' }, label: 'yesterday' };
  if (has(q, ['semaine derniere', 'last week', 'semaine', 'vorige week']) || /\bweek\b/.test(q)) return { query: { period: 'last_7_days' }, label: 'last_7_days' };
  if (has(q, ['dernier mois', '30 derniers'])) return { query: { period: 'last_30_days' }, label: 'last_30_days' };
  if (has(q, ['trimestre', 'quarter', 'kwartaal', 'annee derniere', 'last year', 'vorig jaar', 'depuis le debut', 'since the start', 'depuis toujours', 'jaar'])) return { unsupported: true };
  return null;
}

/** Deterministic intent + period from the question text (French, Dutch, English keywords). Returns null intent when the question is not understood. */
export function understand(question) {
  const q = norm(question);
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
  const ep = explicitPeriod(q);
  return { intent, period: ep?.label ?? null, periodQuery: ep?.query ?? null, periodExplicit: !!ep && !ep.unsupported, unsupportedSpan: !!ep?.unsupported };
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
/**
 * `provider` (legacy) only words the figures of the keyword path. `aiProvider` is the Phase 2 contract { plan, explain }: when it is configured, questions go through
 * plan -> Nordla tools -> facts -> explain -> verify (ai/orchestrator.js); when it is absent - or when its planning fails - the deterministic keyword path below answers
 * the simple questions exactly as before.
 */
export function createAssistant({ reportsDir, provider = null, providerStatus = provider ? 'OK' : 'NOT_CONFIGURED', timeoutMs = EXPLAIN_TIMEOUT_MS, now = () => new Date(), aiProvider = null, aiTimeoutMs }) {
  const orchestrate = aiProvider ? createOrchestrator({ provider: aiProvider, tools: createToolLayer({ reportsDir, now }), ...(aiTimeoutMs ? { timeoutMs: aiTimeoutMs } : {}) }) : null;
  // `selected` = the period chosen in the page ({period, from, to}); it is used only when the question does not name a period itself.
  return async function ask({ question, lang = 'fr', selected = null, history = [] }) {
    const text = typeof question === 'string' ? question.trim() : '';
    if (!text) return { status: 400, body: { error: { code: 'EMPTY_QUESTION' } } };
    if (text.length > MAX_QUESTION) return { status: 400, body: { error: { code: 'QUESTION_TOO_LONG', max: MAX_QUESTION } } };

    let aiFailure = null;
    if (orchestrate) {
      const r = await orchestrate({ question: text, lang, history, selected });
      if (r.status !== 'PLAN_FAILED') return { status: 200, body: { mode: 'ai', ...r } };
      aiFailure = r.code; // the AI planner is unavailable or invalid: fall back to the deterministic keyword path, and say so
    }

    const u = understand(text);
    if (!u.intent) return { status: 422, body: { error: { code: 'UNSUPPORTED_QUESTION', supported: SUPPORTED_QUESTIONS } } };
    if (u.unsupportedSpan) return { status: 422, body: { error: { code: 'UNSUPPORTED_PERIOD', available: ['yesterday', 'last_7_days', 'last_30_days', 'last_90_days', 'this_week', 'this_month', 'previous_month', 'this_year'] } } };

    // The period: the one named in the question, else the one selected in the page, else the last 30 days. The figures then come from the SAME
    // period engine as Explorer (same deterministic functions, same dataset), so the answer always matches what the page shows for that period.
    const query = u.periodQuery ?? (selected && typeof selected.period === 'string' ? { period: selected.period, from: selected.from ?? undefined, to: selected.to ?? undefined } : { period: 'last_30_days' });
    let report; let periodKey = 'last_30_days';
    const eng = await periodReport(reportsDir, query, { now: now() });
    if (eng.ok) report = eng.report;
    else if (eng.code === 'DATASET_UNAVAILABLE') {
      // No dataset snapshot yet (right after a deploy): only the three periods stored in the generated report can be answered, and only from it.
      const legacy = { yesterday: 'yesterday', last_7_days: 'last_7_days', last_30_days: 'last_30_days' }[query.period];
      const rep0 = await latestReport(reportsDir);
      if (!rep0) return { status: 404, body: { error: { code: 'NO_REPORT_AVAILABLE' } } };
      if (!legacy) return { status: 404, body: { error: { code: 'DATASET_UNAVAILABLE' } } };
      report = rep0.report; periodKey = legacy; report.__file = rep0.file;
    } else return { status: eng.status, body: { error: { code: eng.code } } };
    const got = figuresFor(u.intent, periodKey, report);
    if (got.unavailable) return { status: 422, body: { error: { code: got.unavailable === 'ONLY_LAST_30_DAYS' ? 'ONLY_LAST_30_DAYS' : got.unavailable === 'NO_SALES' ? 'NO_DATA_FOR_QUESTION' : 'PERIOD_NOT_IN_REPORT', intent: u.intent, period: periodKey } } };
    const rep = { file: report.__file ?? String(report.generated_at ?? '').slice(0, 10), report };
    const pi = rep.report.period_info;
    const w = rep.report.sales[periodKey].window;
    const tz = w?.timeZone ?? rep.report.merchant_timezone ?? 'UTC';
    const period = pi ? { key: pi.key, start: pi.start, end: pi.end, days: pi.days, timeZone: pi.timeZone } : w ? { key: periodKey, start: localDateString(new Date(w.start), tz), end: localDateString(dayBefore(w.end), tz), timeZone: tz } : { key: periodKey };
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
    if (aiFailure) body.ai = { status: 'UNAVAILABLE', code: aiFailure };
    return { status: 200, body };
  };
}
