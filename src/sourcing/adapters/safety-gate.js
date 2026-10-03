// EU Safety Gate adapter. The only verified programmatic route is the official weekly report XML (index + detail, no authentication). Nordla downloads the reports,
// keeps them in a local cache and MATCHES locally (core/safety.js). It never scrapes the portal UI and never uses unofficial JSON endpoints.
// Reuse conditions stated by the Commission: acknowledge the source, the extraction date and the language version (carried in `attribution`).
import { mkdir, readFile, writeFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { parseXml, child, textOf, walk, isNil } from './xml.js';

export const INDEX_URL = 'https://ec.europa.eu/safety-gate-alerts/api/download/weeklyReport/list/xml/en';
export const detailUrl = (id) => `https://ec.europa.eu/safety-gate-alerts/api/download/weeklyReport/detail/xml/${id}?language=en&search=WEB_REPORT%7C:%7C${id}`;
const FIELDS = { caseNumber: 'caseNumber', reference: 'reference', category: 'category', product: 'product', brand: 'brand', name: 'name', type_numberOfModel: 'model', batchNumber: 'batchNumber', barcode: 'barcode', riskType: 'riskType', danger: 'danger', measures: 'measures', URLrecall: 'URLrecall', description: 'description', notifyingCountry: 'notifyingCountry', countryOfOrigin: 'countryOfOrigin', level: 'level', onlineTrader: 'onlineTrader' };

/** @returns {{ reference: string, publicationDate: string|null, url: string|null, id: string|null }[]} newest first */
export function parseWeeklyIndex(xml) {
  const out = [];
  for (const el of walk(parseXml(xml))) {
    const ref = textOf(child(el, 'reference')); if (!/^Report-\d{4}-\d{1,2}$/i.test(ref)) continue;
    const url = (textOf(child(el, 'url')) || textOf(child(el, 'URL')) || '').replace(/[,\s]+$/, '') || null; const id = url ? (/\/detail\/xml\/(\d+)/.exec(url)?.[1] ?? null) : (textOf(child(el, 'id')) || null);
    out.push({ reference: ref, publicationDate: textOf(child(el, 'publicationDate')) || null, url, id });
  }
  const key = (r) => { const m = /(\d{4})-(\d+)/.exec(r.reference); return Number(m[1]) * 100 + Number(m[2]); };
  return out.sort((a, b) => key(b) - key(a));
}

/** @returns alert objects with the field names core/safety.js reads (model <- type_numberOfModel). Missing / xsi:nil fields are null. */
export function parseWeeklyReport(xml, reportRef = null) {
  const alerts = [];
  for (const el of walk(parseXml(xml))) {
    if (!child(el, 'caseNumber')) continue;
    const a = { reportRef };
    for (const [tag, key] of Object.entries(FIELDS)) { const c = child(el, tag); a[key] = c && !isNil(c) && textOf(c) ? textOf(c) : null; }
    alerts.push(a);
  }
  return alerts;
}

/**
 * Local cache + refresh. `fetchImpl(url)` must return { ok, text() }. Modes: LIVE_VERIFIED (refreshed in this process within `liveWithinMs`), CACHED (disk only),
 * OFFLINE_VERIFICATION_REQUIRED (nothing cached). A failed refresh NEVER erases the cache and never turns a cache into "live".
 */
/** The fields matching needs, shortened: a few hundred KB for half a year, small enough to keep on the phone and match offline. */
export const compactAlert = (a) => ({ caseNumber: a.caseNumber, category: a.category, product: a.product, brand: a.brand, name: a.name, model: a.model, barcode: a.barcode, riskType: a.riskType, danger: a.danger?.slice(0, 220) ?? null, description: a.description?.slice(0, 120) ?? null, countryOfOrigin: a.countryOfOrigin, level: a.level, URLrecall: a.URLrecall, reportRef: a.reportRef });

export function createSafetyGateAdapter({ cacheDir, fetchImpl = (u) => fetch(u, { headers: { 'user-agent': 'nordla-sourcing/0 (+local)' } }), now = () => new Date(), liveWithinMs = 24 * 3600 * 1000 } = {}) {
  let lastRefresh = null; let lastError = null;
  const fileOf = (ref) => join(cacheDir, `${ref}.json`);
  async function cached() {
    try { await mkdir(cacheDir, { recursive: true }); const num = (f) => { const m = /(\d{4})-(\d+)/.exec(f); return m ? Number(m[1]) * 100 + Number(m[2]) : 0; }; const files = (await readdir(cacheDir)).filter((f) => /^Report-.*\.json$/.test(f)).sort((a, b) => num(a) - num(b)); const reports = []; for (const f of files) reports.push(JSON.parse(await readFile(join(cacheDir, f), 'utf8'))); return reports; } catch { return []; }
  }
  return {
    async refresh({ maxReports = 12 } = {}) {
      try {
        await mkdir(cacheDir, { recursive: true });
        const idx = await fetchImpl(INDEX_URL); if (!idx.ok) throw new Error(`index HTTP ${idx.status ?? '?'}`);
        const list = parseWeeklyIndex(await idx.text()).slice(0, maxReports); let added = 0; const have = new Set((await cached()).map((r) => r.reference));
        for (const r of list) {
          if (have.has(r.reference) || !r.id) continue;
          const res = await fetchImpl(r.url ?? detailUrl(r.id)); if (!res.ok) throw new Error(`report ${r.reference} HTTP ${res.status ?? '?'}`);
          const alerts = parseWeeklyReport(await res.text(), r.reference); await writeFile(fileOf(r.reference), JSON.stringify({ reference: r.reference, publicationDate: r.publicationDate, fetchedAt: now().toISOString(), alerts })); added += 1;
        }
        lastRefresh = now(); lastError = null; return { ok: true, indexed: list.length, added };
      } catch (e) { lastError = String(e.message ?? e); return { ok: false, error: lastError }; }
    },
    /** @returns {{ alerts: object[]|null, source: object }} ready for assess({ externals: { safety } }) */
    async get() {
      const reports = await cached(); const alerts = reports.flatMap((r) => r.alerts);
      const live = lastRefresh && now().getTime() - lastRefresh.getTime() <= liveWithinMs;
      if (!reports.length) return { alerts: null, source: { mode: 'OFFLINE_VERIFICATION_REQUIRED', fetchedAt: null, coverage: 'no Safety Gate report ingested yet', error: lastError } };
      const newest = reports.map((r) => r.fetchedAt).sort().at(-1);
      const pubs = reports.map((r) => /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(r.publicationDate ?? '')).filter(Boolean).map((m) => `${m[3]}-${m[2]}-${m[1]}`).sort(); const newestPublication = pubs.at(-1) ?? null;
      const reportAgeDays = newestPublication ? Math.floor((now().getTime() - Date.parse(newestPublication)) / 86400000) : null;
      return { alerts, source: { mode: live ? 'LIVE_VERIFIED' : 'CACHED', fetchedAt: live ? lastRefresh.toISOString() : newest, coverage: `${reports.length} weekly report(s) ${reports[0].reference} to ${reports.at(-1).reference}, ${alerts.length} alerts; older alerts are NOT ingested`, attribution: `EU Safety Gate (European Commission), weekly reports, English version, extracted ${newest?.slice(0, 10)}`, newestPublication, reportAgeDays, error: lastError } };
    },
  };
}
