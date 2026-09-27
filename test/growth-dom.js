// Test helper (not a test file): renders the Growth UI (router, sidebar, pages) in a minimal fake DOM with the demo payloads.
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { buildDemoOverview } from '../src/growth/server/demo-overview.js';
import { buildDemoOpportunities } from '../src/growth/server/demo-opportunities.js';
import { buildDemoCampaigns } from '../src/growth/server/demo-campaigns.js';
import { productPotentialFacts } from '../src/growth/products/facts.js';
import { buildProductPotential } from '../src/growth/products/potential.js';
import { makeDemandData, NOW as DEMAND_NOW, TZ as DEMAND_TZ, CONFIG as DEMAND_CONFIG } from './fixtures/demand-sample.js';

const UI = new URL('../src/growth/ui/', import.meta.url);
const ANALYTICS_UI = new URL('../src/analytics-premium/ui/', import.meta.url);
export const NOW = new Date('2026-09-26T10:00:00Z');

export class Node { constructor(tag) { this.tagName = String(tag).toUpperCase(); this.nodeType = 1; this.children = []; this.attrs = {}; this.className = ''; this.style = { cssText: '' }; this.listeners = {}; }
  setAttribute(k, v) { this.attrs[k] = String(v); } getAttribute(k) { return this.attrs[k] ?? null; }
  append(...c) { this.children.push(...c); } appendChild(c) { this.children.push(c); return c; } replaceChildren(...c) { this.children = c; }
  addEventListener(e, f) { (this.listeners[e] ||= []).push(f); } replaceWith() {} }
export const text = (n) => (n.nodeType === 3 ? n.data : (n.children || []).map(text).join(''));
export const all = (n, pred, out = []) => { if (n.nodeType === 1) { if (pred(n)) out.push(n); n.children.forEach((c) => all(c, pred, out)); } return out; };
export const hasClass = (n, c) => ` ${n.className} `.includes(` ${c} `);

/** Potentiel produits payload from the synthetic demand fixture (the page has no demo data: tests use a synthetic dataset). */
export function potentialPayload(data = makeDemandData()) {
  const f = productPotentialFacts({ data, now: DEMAND_NOW, timeZone: DEMAND_TZ, config: DEMAND_CONFIG });
  return { generatedAt: DEMAND_NOW.toISOString(), ...buildProductPotential(f.facts, { config: DEMAND_CONFIG, currency: f.currency, window: f.window, dataQuality: f.dataQuality }) };
}

export async function growthDom(hash, { products = potentialPayload(), productsStatus = 200 } = {}) {
  const root = new Node('div');
  const errors = [];
  const listeners = {};
  const doc = { createElement: (t) => new Node(t), createElementNS: (_, t) => new Node(t), createTextNode: (s) => ({ nodeType: 3, data: s }), getElementById: () => root, querySelector: () => null, documentElement: { lang: '' } };
  const payloads = { '/api/growth/overview': buildDemoOverview(NOW), '/api/growth/opportunities': buildDemoOpportunities(NOW), '/api/growth/campaigns': buildDemoCampaigns(NOW), '/api/growth/products': products };
  const el = () => new Node('div');
  const ctx = {
    document: doc, location: { hash }, console: { error: (...a) => errors.push(a.join(' ')), log() {} },
    localStorage: { getItem: () => 'fr', setItem() {} }, Intl, Math, Date, JSON, Object, Array, Set, Number, String, Error, Promise, setTimeout,
    fetch: async (u) => (u === '/api/growth/products' && productsStatus !== 200 ? { ok: false, status: productsStatus, json: async () => ({ error: { code: 'TENANT_NOT_CONFIGURED' } }) } : { ok: true, json: async () => JSON.parse(JSON.stringify(payloads[u])) }),
    NordlaIcon: { semantic: (n) => Object.assign(new Node('img'), { className: `nordla-icon official ${n}` }), parle: () => new Node('img') },
    NordlaCharts: { head: el, trendLines: el, trendLine: el, sparkline: el, insufficient: el, donut: el },
  };
  ctx.window = ctx; ctx.window.addEventListener = (e, f) => { listeners[e] = f; }; ctx.window.scrollTo = () => {};
  vm.createContext(ctx);
  for (const f of [new URL('i18n.js', ANALYTICS_UI), new URL('lang-fr.js', UI), new URL('lang-nl.js', UI), new URL('lang-en.js', UI), new URL('opportunities.js', UI), new URL('campaigns.js', UI), new URL('potential.js', UI), new URL('app.js', UI)]) vm.runInContext(await readFile(f, 'utf8'), ctx, { filename: f.pathname });
  await new Promise((r) => setTimeout(r, 20));
  const navigate = async (h) => { ctx.location.hash = h; await listeners.hashchange(); };
  return { root, errors, navigate, ctx };
}
export const navState = (root) => all(root, (n) => hasClass(n, 'nav-item')).map((n) => ({ label: text(n), active: hasClass(n, 'active'), href: n.getAttribute('href'), inert: hasClass(n, 'inert') }));
export const title = (root) => text(all(root, (n) => hasClass(n, 'ex-title'))[0]);
