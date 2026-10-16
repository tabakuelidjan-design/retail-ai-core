// Stock / Achats mobile server (HTTP + JSON, no dependency). It serves the phone screens (src/procurement/ui) and a small API over the procurement module.
//
// Safety, by construction:
//  - every /api and /uploads call needs a personal access token (header x-nordla-token); 8 wrong tokens per minute lock the sender out (429);
//  - the Host header must be local or in the allow-list (blocks DNS rebinding); strict CSP, no cookies, no CORS;
//  - the phone never supplies an approval: when a user presses Approve / Order, the SERVER builds the named-human approval from the authenticated user
//    (and only if that user is configured `canApprove`). Separation of duties is enforced by the module, not by the screen;
//  - every write needs an Idempotency-Key header (the phone generates it once per action and reuses it on retry), so a lost connection is always safe to retry;
//  - nothing here pays, writes to Shopify or messages a supplier. "Order" records that a named human placed the order elsewhere.
import { createServer } from 'node:http';
import { createHash, timingSafeEqual } from 'node:crypto';
import { readFile, readdir, writeFile, mkdir, rename } from 'node:fs/promises';
import { join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ProcurementError } from '../errors.js';
import { importSourcingCase, draftOrderFromCase } from '../sourcing-bridge.js';

const UI_DIR = fileURLToPath(new URL('../ui/', import.meta.url));
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json' };
const IMAGE_EXT = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp' };
const CSP = "default-src 'self'; img-src 'self' blob: data:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";
const FAIL_LIMIT = 8; const FAIL_WINDOW_MS = 60_000;
const STATUS = {
  INVALID_INPUT: 400, TIER_ORDER: 400, FX_REQUIRED: 400, FX_MISMATCH: 400,
  ACTOR_REQUIRED: 401, FORBIDDEN: 403, APPROVAL_REQUIRED: 403, APPROVER_NOT_HUMAN: 403, SEPARATION_OF_DUTIES: 403,
  ITEM_NOT_FOUND: 404, SUPPLIER_NOT_FOUND: 404, QUOTE_NOT_FOUND: 404, PO_NOT_FOUND: 404, VISIT_NOT_FOUND: 404, LOCATION_NOT_FOUND: 404, PO_LINE_NOT_FOUND: 404,
  STORE_UNAVAILABLE: 503, STORE_RETRYABLE: 503,
};
const hash = (v) => createHash('sha256').update(String(v ?? '')).digest();
const sameToken = (given, expected) => timingSafeEqual(hash(given), hash(expected));

/**
 * @param {object} deps
 *  procurement   { commands, queries } from createProcurement()
 *  users         [{ token, id, role, name?, canApprove?, approverRole? }] - tokens at least 24 characters
 *  sourcingDir   directory of Sourcing case files (<id>.json), read-only; optional
 *  uploadsDir    where photos are stored (named by their SHA-256)
 *  allowedHosts  extra Host names (a live array: a tunnel adds its own)
 */
export function createProcurementApp({ procurement, users, sourcingDir = null, uploadsDir, allowedHosts = [], now = () => new Date(), maxJson = 262_144, maxUpload = 8_000_000 }) {
  for (const u of users) if (typeof u.token !== 'string' || u.token.length < 24) throw new Error('every access token needs at least 24 characters');
  const { commands: c, queries: q } = procurement;
  const fails = new Map();
  const blocked = (ip) => { const f = (fails.get(ip) ?? []).filter((t) => now().getTime() - t < FAIL_WINDOW_MS); fails.set(ip, f); return f.length >= FAIL_LIMIT; };
  const failed = (ip) => { const f = fails.get(ip) ?? []; f.push(now().getTime()); fails.set(ip, f); };
  const clientIp = (req) => String(req.headers['x-forwarded-for'] ?? req.socket.remoteAddress ?? '').split(',')[0].trim();
  const hostOk = (req) => { const h = String(req.headers.host ?? '').toLowerCase().replace(/:\d+$/, ''); return ['localhost', '127.0.0.1', '[::1]', ...allowedHosts.map((x) => String(x).toLowerCase())].includes(h); };
  const files = new Map();
  const asset = async (name) => { if (!files.has(name)) files.set(name, await readFile(join(UI_DIR, name))); return files.get(name); };

  const send = (res, code, body, headers = {}) => { res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...headers }); res.end(JSON.stringify(body)); };
  async function readRaw(req, limit) {
    const chunks = []; let n = 0;
    for await (const ch of req) { n += ch.length; if (n > limit) throw Object.assign(new Error('body too large'), { code: 'BODY_TOO_LARGE' }); chunks.push(ch); }
    return Buffer.concat(chunks);
  }
  async function readJson(req) {
    const raw = await readRaw(req, maxJson);
    if (!raw.length) return {};
    try { return JSON.parse(raw.toString('utf8')); } catch { throw Object.assign(new Error('invalid JSON'), { code: 'INVALID_JSON' }); }
  }
  const idemKey = (req) => {
    const k = String(req.headers['idempotency-key'] ?? '');
    if (!/^[A-Za-z0-9_.:-]{8,100}$/.test(k)) throw new ProcurementError('INVALID_INPUT', 'a write needs an Idempotency-Key header (8-100 characters)');
    return `ui:${k}`;
  };
  const fail = (res, e) => {
    if (e instanceof ProcurementError) return send(res, STATUS[e.code] ?? (/_NOT_FOUND$/.test(e.code) ? 404 : /^(INVALID_|OVER_|UNIQUE|VERSION|IDEMPOTENCY|ALREADY|HAS_|BELOW|QUOTE_|VISIT_|SUPPLIER_|DUPLICATE|RESERVED|INSUFFICIENT|CURRENCY|TIER|STOCK|LIMIT)/.test(e.code) ? 409 : 400), { error: e.code, message: e.message, detail: e.detail });
    if (e?.code === 'BODY_TOO_LARGE') return send(res, 413, { error: 'BODY_TOO_LARGE' });
    if (e?.code === 'INVALID_JSON') return send(res, 400, { error: 'INVALID_JSON' });
    console.error('procurement server error:', e);
    return send(res, 500, { error: 'INTERNAL', message: 'unexpected error (see the server log)' });
  };
  const approvalFor = (user, action, poId, key) => {
    if (!user.canApprove) throw new ProcurementError('FORBIDDEN', 'your access cannot approve: ask the owner or an authorized reviewer');
    return { id: `ap:${key}:${action}`, action, subject_ref: `nordla:purchase:${poId}`, approver: { kind: 'HUMAN', id: user.id, role: user.approverRole ?? 'AUTHORIZED_REVIEWER' }, approved_at: now().toISOString() };
  };

  // ---- views: what the phone needs, in one request, with names instead of ids
  async function poView(po, ctx = {}) {
    const items = ctx.items ?? new Map((await q.items()).map((i) => [i.id, i])); const suppliers = ctx.suppliers ?? new Map((await q.suppliers()).map((s) => [s.id, s]));
    return {
      id: po.id, number: po.number, status: po.status, supplier: { id: po.supplierId, name: suppliers.get(po.supplierId)?.name ?? null }, currency: po.currency, totalMinor: po.totalMinor, expectedDate: po.expectedDate, depositBps: po.depositBps,
      createdBy: po.createdBy, submittedBy: po.submittedBy ?? null, fx: po.fx, version: po.version, schedule: po.schedule.map((s) => ({ kind: s.kind, amountMinor: s.amountMinor, status: s.status })),
      lines: po.lines.map((l) => ({ id: l.id, itemId: l.itemId, sku: items.get(l.itemId)?.sku ?? null, name: items.get(l.itemId)?.name ?? null, qty: l.qty, qtyReceived: l.qtyReceived, unitPriceMicro: l.unitPriceMicro, totalMinor: l.totalMinor, quoteId: l.quoteId })),
    };
  }
  async function itemView(item) {
    const quotes = (await q.quotes()).filter((x) => x.itemId === item.id);
    const suppliers = new Map((await q.suppliers()).map((s) => [s.id, s]));
    return {
      id: item.id, sku: item.sku, name: item.name, status: item.status, barcode: item.barcode, photos: (item.attachments ?? []).filter((a) => a.kind === 'PHOTO').map((a) => a.ref),
      quotes: quotes.sort((a, b) => b.revision - a.revision).map((x) => ({ id: x.id, supplierId: x.supplierId, supplier: suppliers.get(x.supplierId)?.name ?? null, revision: x.revision, status: x.status, currency: x.currency, tiers: x.tiers, moq: x.moq, incoterm: x.incoterm, leadTimeDays: x.leadTimeDays, validUntil: x.validUntil, reason: x.reason, at: x.createdAt })),
    };
  }
  async function visitView(v) {
    const sup = await q.supplier(v.supplierId); const items = new Map((await q.items()).map((i) => [i.id, i])); const quotes = new Map((await q.quotes()).map((x) => [x.id, x]));
    return {
      id: v.id, date: v.visitDate, place: v.place, note: v.note, status: v.status, supplier: { id: v.supplierId, name: sup?.name ?? null, currency: sup?.currency ?? null }, version: v.version,
      entries: v.entries.map((e) => { const it = items.get(e.itemId); const qt = e.quoteId ? quotes.get(e.quoteId) : null; return { id: e.id, at: e.at, note: e.note, itemId: e.itemId, sku: it?.sku ?? null, name: it?.name ?? null, photo: (it?.attachments ?? []).find((a) => a.kind === 'PHOTO')?.ref ?? null, quote: qt ? { id: qt.id, currency: qt.currency, tiers: qt.tiers, moq: qt.moq, incoterm: qt.incoterm } : null }; }),
    };
  }

  async function sourcingCases() {
    if (!sourcingDir) return { available: false, reason: 'no Sourcing directory configured', cases: [] };
    let names; try { names = await readdir(sourcingDir); } catch { return { available: false, reason: 'the Sourcing directory is not readable', cases: [] }; }
    const cases = [];
    for (const f of names.filter((n) => /^[A-Za-z0-9_-]+\.json$/.test(n))) {
      try { const s = JSON.parse(await readFile(join(sourcingDir, f), 'utf8')); cases.push({ id: s.id, name: s.identity?.workingName ?? '', supplier: s.supplier?.name ?? null, quotes: (s.quotes ?? []).length, photos: (s.identity?.photos ?? []).length, updatedAt: s.updatedAt ?? null }); } catch { /* a corrupt case file is skipped, never fatal */ }
    }
    return { available: true, cases: cases.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt))) };
  }
  async function readCase(id) {
    if (!sourcingDir || !/^[A-Za-z0-9_-]{1,80}$/.test(String(id))) throw new ProcurementError('INVALID_INPUT', 'unknown Sourcing case');
    try { return JSON.parse(await readFile(join(sourcingDir, `${id}.json`), 'utf8')); } catch { throw new ProcurementError('INVALID_INPUT', 'that Sourcing case could not be read'); }
  }

  async function api(req, res, url) {
    const ip = clientIp(req);
    if (blocked(ip)) return send(res, 429, { error: 'TOO_MANY_ATTEMPTS' }, { 'retry-after': '60' });
    const given = req.headers['x-nordla-token'];
    const user = given ? users.find((u) => sameToken(given, u.token)) : null;
    if (!user) { failed(ip); return send(res, 401, { error: 'UNAUTHORIZED' }); }
    const actor = { id: user.id, role: user.role }; const p = url.pathname; const m = req.method;
    let r;

    if (p === '/api/health' && m === 'GET') return send(res, 200, { ok: true, time: now().toISOString() });
    if (p === '/api/me' && m === 'GET') return send(res, 200, { id: user.id, name: user.name ?? user.id, role: user.role, canApprove: Boolean(user.canApprove) });

    if (p === '/api/overview' && m === 'GET') {
      const pos = await q.purchaseOrders(); const visits = await q.visits();
      const count = (st) => pos.filter((x) => x.status === st).length;
      return send(res, 200, { openVisits: visits.filter((v) => v.status === 'OPEN').length, purchases: { DRAFT: count('DRAFT'), PENDING_APPROVAL: count('PENDING_APPROVAL'), APPROVED: count('APPROVED'), ORDERED: count('ORDERED') + count('CONFIRMED'), IN_RECEIPT: count('PARTIALLY_RECEIVED') }, items: (await q.items()).length, locations: (await q.locations()).map((l) => ({ id: l.id, name: l.name, type: l.type })) });
    }

    // ---- visits
    if (p === '/api/visits' && m === 'GET') { const sup = new Map((await q.suppliers()).map((s) => [s.id, s])); return send(res, 200, { visits: (await q.visits()).reverse().map((v) => ({ id: v.id, date: v.visitDate, place: v.place, status: v.status, supplier: sup.get(v.supplierId)?.name ?? null, products: v.entries.length })) }); }
    if (p === '/api/visits' && m === 'POST') { const b = await readJson(req); r = await c.startVisit(actor, idemKey(req), { supplierName: b.supplierName, supplierId: b.supplierId, currency: b.currency, country: b.country, date: b.date, place: b.place, note: b.note }); return send(res, r.replayed ? 200 : 201, { visit: await visitView(r.visit), supplier: r.supplier, replayed: r.replayed }); }
    let mm = /^\/api\/visits\/([\w-]+)$/.exec(p);
    if (mm && m === 'GET') { const v = await q.visit(mm[1]); return v ? send(res, 200, await visitView(v)) : send(res, 404, { error: 'VISIT_NOT_FOUND' }); }
    mm = /^\/api\/visits\/([\w-]+)\/products$/.exec(p);
    if (mm && m === 'POST') { const b = await readJson(req); r = await c.captureProduct(actor, idemKey(req), { visitId: mm[1], itemId: b.itemId, product: b.product, quote: b.quote, note: b.note }); return send(res, r.replayed ? 200 : 201, { itemId: r.item.id, sku: r.item.sku, itemCreated: r.itemCreated, quoteId: r.quote?.id ?? null, replayed: r.replayed }); }
    mm = /^\/api\/visits\/([\w-]+)\/close$/.exec(p);
    if (mm && m === 'POST') { const b = await readJson(req); r = await c.closeVisit(actor, idemKey(req), { visitId: mm[1], note: b.note }); return send(res, 200, { status: r.visit.status, replayed: r.replayed }); }

    // ---- items, comparison
    if (p === '/api/items' && m === 'GET') { const out = []; for (const i of await q.items()) out.push(await itemView(i)); return send(res, 200, { items: out.sort((a, b) => a.name.localeCompare(b.name)) }); }
    mm = /^\/api\/items\/([\w-]+)$/.exec(p);
    if (mm && m === 'GET') { const i = await q.item(mm[1]); return i ? send(res, 200, await itemView(i)) : send(res, 404, { error: 'ITEM_NOT_FOUND' }); }
    if (p === '/api/compare' && m === 'GET') {
      const qty = Number(url.searchParams.get('qty')); let fx = {};
      try { fx = JSON.parse(url.searchParams.get('fx') || '{}'); } catch { throw new ProcurementError('INVALID_INPUT', 'fx must be JSON'); }
      const freight = url.searchParams.get('freight'); const duty = url.searchParams.get('dutyPct'); const sell = url.searchParams.get('sellPrice');
      const costInputs = freight ? { default: { freight_total: freight, duty_rate_pct: duty || '0', import_vat_rate_pct: '21' } } : {};
      const cmp = await q.compareSuppliers({ itemId: url.searchParams.get('itemId') ?? '', qty, fx, costInputs, ...(sell ? { expectedSellingPriceGross: sell } : {}) });
      return send(res, 200, cmp);
    }

    // ---- purchases
    if (p === '/api/purchase-orders' && m === 'GET') {
      const want = url.searchParams.get('status'); const all = await q.purchaseOrders(); const items = new Map((await q.items()).map((i) => [i.id, i])); const suppliers = new Map((await q.suppliers()).map((s) => [s.id, s]));
      const list = all.filter((x) => (want ? x.status === want : !['CLOSED', 'CANCELLED', 'RECEIVED'].includes(x.status)));
      const out = []; for (const po of list.reverse()) out.push(await poView(po, { items, suppliers }));
      return send(res, 200, { purchaseOrders: out });
    }
    if (p === '/api/purchase-orders' && m === 'POST') {
      const b = await readJson(req); const locs = await q.locations();
      const dest = b.destinationLocationId ?? locs.find((l) => l.type === 'WAREHOUSE')?.id ?? locs.find((l) => l.type === 'STORE')?.id;
      const lines = []; let supplierId = b.supplierId; let currency = b.currency;
      for (const l of Array.isArray(b.lines) ? b.lines : []) {
        const qt = await q.quote(l.quoteId); if (!qt) throw new ProcurementError('QUOTE_NOT_FOUND', 'unknown quote');
        supplierId ??= qt.supplierId; currency ??= qt.currency;
        lines.push({ itemId: qt.itemId, quoteId: qt.id, qty: l.qty });
      }
      r = await c.createPurchaseOrder(actor, idemKey(req), { supplierId, currency, expectedDate: b.expectedDate, destinationLocationId: dest, lines, ...(b.fx ? { fx: b.fx } : {}) });
      return send(res, r.replayed ? 200 : 201, { purchaseOrder: await poView(await q.purchaseOrder(r.purchaseOrder.id)), replayed: r.replayed });
    }
    mm = /^\/api\/purchase-orders\/([\w-]+)$/.exec(p);
    if (mm && m === 'GET') { const po = await q.purchaseOrder(mm[1]); return po ? send(res, 200, await poView(po)) : send(res, 404, { error: 'PO_NOT_FOUND' }); }
    mm = /^\/api\/purchase-orders\/([\w-]+)\/(submit|reject|approve|order|cancel)$/.exec(p);
    if (mm && m === 'POST') {
      const [, poId, act] = mm; const b = await readJson(req); const key = idemKey(req);
      if (act === 'submit') r = await c.submitPurchaseOrder(actor, key, { poId });
      else if (act === 'reject') r = await c.rejectPurchaseOrder(actor, key, { poId, reason: b.reason });
      else if (act === 'approve') r = await c.approvePurchaseOrder(actor, key, { poId, approval: approvalFor(user, 'BUYING.approve_purchase_plan', poId, key) });
      else if (act === 'order') r = await c.placeOrder(actor, key, { poId, approval: approvalFor(user, 'BUYING.place_order', poId, key), supplierReference: b.supplierReference });
      else r = await c.cancelPurchaseOrder(actor, key, { poId, reason: b.reason });
      return send(res, 200, { purchaseOrder: await poView(await q.purchaseOrder(poId)), replayed: r.replayed });
    }

    // ---- photos (stored by SHA-256; the module keeps only the reference)
    if (p === '/api/uploads' && m === 'POST') {
      const type = String(req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
      if (!IMAGE_EXT[type]) return send(res, 415, { error: 'UNSUPPORTED_MEDIA', message: 'JPEG, PNG or WebP only' });
      const raw = await readRaw(req, maxUpload);
      if (!raw.length) return send(res, 400, { error: 'EMPTY_UPLOAD' });
      const sha = createHash('sha256').update(raw).digest('hex'); const name = `${sha}${IMAGE_EXT[type]}`;
      await mkdir(uploadsDir, { recursive: true }); const tmp = join(uploadsDir, `${name}.${process.pid}.tmp`);
      await writeFile(tmp, raw); await rename(tmp, join(uploadsDir, name));
      return send(res, 201, { ref: `upload://${name}`, sha256: sha, bytes: raw.length });
    }
    mm = /^\/api\/uploads\/([0-9a-f]{64}\.(?:jpg|png|webp))$/.exec(p);
    if (mm && m === 'GET') {
      try { const data = await readFile(join(uploadsDir, mm[1])); res.writeHead(200, { 'content-type': Object.entries(IMAGE_EXT).find(([, e]) => e === extname(mm[1]))[0], 'cache-control': 'private, max-age=31536000, immutable', 'x-content-type-options': 'nosniff' }); return res.end(data); } catch { return send(res, 404, { error: 'NOT_FOUND' }); }
    }

    // ---- China Sourcing
    if (p === '/api/sourcing/cases' && m === 'GET') return send(res, 200, await sourcingCases());
    if (p === '/api/sourcing/import' && m === 'POST') {
      const b = await readJson(req); const caseState = await readCase(b.caseId);
      if (b.qty !== undefined) {
        const locs = await q.locations(); const dest = b.destinationLocationId ?? locs.find((l) => l.type === 'WAREHOUSE')?.id;
        return send(res, 200, await draftOrderFromCase({ commands: c, queries: q, actor, caseState, qty: b.qty, destinationLocationId: dest, expectedDate: b.expectedDate, ...(b.fxRate ? { fx: (cur) => ({ from: cur, to: 'EUR', rate: String(b.fxRate), date: now().toISOString().slice(0, 10), source: 'saisie sur téléphone' }) } : b.fx ? { fx: b.fx } : {}) }));
      }
      return send(res, 200, await importSourcingCase({ commands: c, queries: q, actor, caseState }));
    }
    return send(res, 404, { error: 'NOT_FOUND' });
  }

  return async function handler(req, res) {
    try {
      if (!hostOk(req)) return send(res, 421, { error: 'HOST_NOT_ALLOWED' });
      const url = new URL(req.url, 'http://local');
      res.setHeader('content-security-policy', CSP); res.setHeader('referrer-policy', 'no-referrer'); res.setHeader('x-frame-options', 'DENY');
      if (url.pathname.startsWith('/api/')) return await api(req, res, url);
      if (req.method !== 'GET') return send(res, 405, { error: 'METHOD_NOT_ALLOWED' });
      const name = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
      if (!/^[A-Za-z0-9._-]+$/.test(name) || !MIME[extname(name)]) return send(res, 404, { error: 'NOT_FOUND' });
      try { const data = await asset(name); res.writeHead(200, { 'content-type': MIME[extname(name)], 'cache-control': 'no-cache', 'x-content-type-options': 'nosniff' }); return res.end(data); } catch { return send(res, 404, { error: 'NOT_FOUND' }); }
    } catch (e) { return fail(res, e); }
  };
}

export function listen(handler, { host = '127.0.0.1', port = 0 } = {}) {
  const server = createServer(handler);
  return new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, host, () => resolve({ server, port: server.address().port })); });
}

