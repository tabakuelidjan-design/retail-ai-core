// merchant_connectors access layer (ADR 0003 section 4). A connector links a Nordla tenant (merchants.id) to an external
// system; it never defines the tenant. This layer only reads/writes Supabase: no Shopify call, no provider network.
// Not used by any module yet (ADR 0003 step 3 is the data foundation only).

export const KNOWN_CONNECTOR_KINDS = Object.freeze(['shopify', 'woocommerce', 'prestashop', 'odoo', 'peppol', 'bank', 'csv']);
/** Kinds whose identity IS an external object (a shop, an instance): they cannot be linked without external_id. */
export const KINDS_REQUIRING_EXTERNAL_ID = Object.freeze(['shopify', 'woocommerce', 'prestashop', 'odoo']);
/** States written to the database. */
export const PERSISTED_CONNECTOR_STATUSES = Object.freeze(['CONFIGURED', 'NOT_CONFIGURED', 'MISCONFIGURED']);
/** All states a connector can report; UNAVAILABLE is runtime-only (a transient outage never causes a write). */
export const CONNECTOR_STATES = Object.freeze([...PERSISTED_CONNECTOR_STATUSES, 'UNAVAILABLE']);

export const CONNECTOR_ERROR_CODES = Object.freeze({
  MERCHANT_ID_INVALID: 'MERCHANT_ID_INVALID',
  MERCHANT_NOT_FOUND: 'MERCHANT_NOT_FOUND',
  CONNECTOR_KIND_INVALID: 'CONNECTOR_KIND_INVALID',
  CONNECTOR_EXTERNAL_ID_REQUIRED: 'CONNECTOR_EXTERNAL_ID_REQUIRED',
  CONNECTOR_EXTERNAL_ID_INVALID: 'CONNECTOR_EXTERNAL_ID_INVALID',
  CONNECTOR_STATUS_INVALID: 'CONNECTOR_STATUS_INVALID',
  CONNECTOR_STATUS_NOT_PERSISTABLE: 'CONNECTOR_STATUS_NOT_PERSISTABLE',
  CONNECTOR_CONFIG_INVALID: 'CONNECTOR_CONFIG_INVALID',
  CONNECTOR_CONFIG_SECRET: 'CONNECTOR_CONFIG_SECRET',
  CONNECTOR_EXTERNAL_TAKEN: 'CONNECTOR_EXTERNAL_TAKEN', // the external object is linked to another merchant
  CONNECTOR_AMBIGUOUS: 'CONNECTOR_AMBIGUOUS', // several connectors of that kind: never pick one silently
  CONNECTOR_NOT_FOUND: 'CONNECTOR_NOT_FOUND',
  CONNECTOR_STORE_FAILED: 'CONNECTOR_STORE_FAILED',
});

export class ConnectorError extends Error {
  constructor(code, message, detail = {}) { super(message); this.name = 'ConnectorError'; this.code = code; this.detail = detail; }
}
const E = CONNECTOR_ERROR_CODES;
const fail = (code, message, detail) => { throw new ConnectorError(code, message, detail); };

const TABLE = 'merchant_connectors';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KIND = /^[a-z][a-z0-9_]{1,39}$/; // same rule as the SQL check
const MAX_CONFIG_BYTES = 16 * 1024;

// ---------- config: never a secret ----------
// A key whose normalised name (lower case, letters and digits only) contains one of these is refused, at any depth.
const SECRET_KEY_PARTS = ['token', 'secret', 'password', 'passwd', 'apikey', 'authorization', 'privatekey', 'credential', 'bearer', 'cookie'];
// A value that looks like a credential is refused whatever its key is called.
const SECRET_VALUE = [/^shp(at|ss|ca|pa)_/i, /^sk_(live|test)_/i, /^bearer\s+\S/i, /^eyJ[\w-]+\.[\w-]+\.[\w-]+$/, /^-----BEGIN [A-Z ]*PRIVATE KEY-----/];

/** Paths (never values) of every key or value in `config` that looks like a secret. */
export function findSecretPaths(config, path = '') {
  const out = [];
  if (Array.isArray(config)) config.forEach((v, i) => out.push(...findSecretPaths(v, `${path}[${i}]`)));
  else if (config && typeof config === 'object') {
    for (const [k, v] of Object.entries(config)) {
      const p = path ? `${path}.${k}` : k; const norm = k.toLowerCase().replace(/[^a-z0-9]/g, '');
      if (SECRET_KEY_PARTS.some((s) => norm.includes(s))) out.push(p);
      else out.push(...findSecretPaths(v, p));
    }
  } else if (typeof config === 'string' && SECRET_VALUE.some((re) => re.test(config.trim()))) out.push(path || '(value)');
  return out;
}

/** Validates a connector config: a plain JSON object, bounded size, no secret. Returns a JSON copy. */
export function validateConnectorConfig(config = {}) {
  if (config === null || typeof config !== 'object' || Array.isArray(config)) fail(E.CONNECTOR_CONFIG_INVALID, 'config must be a JSON object.');
  let json;
  try { json = JSON.stringify(config); } catch { fail(E.CONNECTOR_CONFIG_INVALID, 'config must be JSON-serialisable.'); }
  if (Buffer.byteLength(json, 'utf8') > MAX_CONFIG_BYTES) fail(E.CONNECTOR_CONFIG_INVALID, `config is larger than ${MAX_CONFIG_BYTES} bytes.`);
  const copy = JSON.parse(json);
  const paths = findSecretPaths(copy);
  if (paths.length) fail(E.CONNECTOR_CONFIG_SECRET, 'config must not contain secrets (keep them in environment variables or a vault).', { paths });
  return copy;
}

// ---------- field validation ----------
const checkMerchantId = (id) => { if (typeof id !== 'string' || !UUID.test(id)) fail(E.MERCHANT_ID_INVALID, 'merchantId must be a UUID.'); return id.toLowerCase(); };
const checkKind = (kind) => { if (typeof kind !== 'string' || !KIND.test(kind)) fail(E.CONNECTOR_KIND_INVALID, 'kind must be lower-case letters, digits or _ (2-40 characters).', { kind: String(kind).slice(0, 40) }); return kind; };
function checkExternalId(kind, externalId) {
  if (externalId === undefined || externalId === null) {
    if (KINDS_REQUIRING_EXTERNAL_ID.includes(kind)) fail(E.CONNECTOR_EXTERNAL_ID_REQUIRED, `A ${kind} connector needs an external_id.`, { kind });
    return null;
  }
  if (typeof externalId !== 'string' || externalId.trim() === '' || externalId !== externalId.trim() || externalId.length > 512) fail(E.CONNECTOR_EXTERNAL_ID_INVALID, 'external_id must be a non-blank, trimmed string.', { kind });
  return externalId;
}
function checkStatus(status) {
  if (status === 'UNAVAILABLE') fail(E.CONNECTOR_STATUS_NOT_PERSISTABLE, 'UNAVAILABLE is a runtime state and is never stored.');
  if (!PERSISTED_CONNECTOR_STATUSES.includes(status)) fail(E.CONNECTOR_STATUS_INVALID, `status must be one of ${PERSISTED_CONNECTOR_STATUSES.join(', ')}.`);
  return status;
}

const fromRow = (r) => Object.freeze({ id: r.id, merchantId: r.merchant_id, kind: r.kind, externalId: r.external_id ?? null, externalDomain: r.external_domain ?? null, status: r.status, config: r.config ?? {}, createdAt: r.created_at ?? null, updatedAt: r.updated_at ?? null });
const isUniqueViolation = (e) => /HTTP 409|23505/.test(String(e?.message ?? ''));

// ---------- backfill (mirror of the M1 SQL, used to document and test the rule) ----------
/**
 * The Shopify connectors M1 creates: one per merchant whose source_system is 'shopify' and source_id is not blank, skipping any
 * (kind, external_id) already present. Pure: never mutates its inputs. The SQL in the migration is authoritative.
 * @param {Array<{id: string, source_system: string, source_id: string|null, source_domain: string|null}>} merchants
 * @param {Array<{kind: string, external_id: string|null}>} existingConnectors
 */
export function planShopifyConnectorBackfill(merchants, existingConnectors = []) {
  const taken = new Set(existingConnectors.filter((c) => c.external_id != null).map((c) => `${c.kind}\u0000${c.external_id}`));
  const rows = [];
  for (const m of merchants) {
    if (m.source_system !== 'shopify' || m.source_id == null || String(m.source_id).trim() === '') continue;
    const key = `shopify\u0000${m.source_id}`;
    if (taken.has(key)) continue;
    taken.add(key);
    rows.push({ merchant_id: m.id, kind: 'shopify', external_id: m.source_id, external_domain: m.source_domain ?? null, status: 'CONFIGURED', config: {} });
  }
  return rows;
}

// ---------- repository ----------
/**
 * @param {{ supabase: { select: Function, insert: Function, update: Function } }} deps
 */
export function createConnectorRepository({ supabase }) {
  if (!supabase || typeof supabase.select !== 'function') throw new TypeError('createConnectorRepository needs a Supabase client');
  const read = async (params) => { try { return await supabase.select(TABLE, params); } catch (e) { return fail(E.CONNECTOR_STORE_FAILED, 'merchant_connectors could not be read.', { cause: e?.name ?? 'Error' }); } };

  async function listForMerchant(merchantId) {
    const id = checkMerchantId(merchantId);
    return (await read({ select: '*', merchant_id: `eq.${id}`, order: 'created_at.asc' })).map(fromRow);
  }

  /** The merchant's single connector of `kind`, or null. Several of the same kind -> CONNECTOR_AMBIGUOUS (never picks one). */
  async function getForMerchant(merchantId, kind) {
    const id = checkMerchantId(merchantId); checkKind(kind);
    const rows = await read({ select: '*', merchant_id: `eq.${id}`, kind: `eq.${kind}` });
    if (rows.length > 1) fail(E.CONNECTOR_AMBIGUOUS, `Merchant has ${rows.length} ${kind} connectors; select one explicitly.`, { kind, count: rows.length });
    return rows.length ? fromRow(rows[0]) : null;
  }

  /** Which tenant owns this external object: { merchantId, connector } or null. */
  async function findMerchantByExternal(kind, externalId) {
    checkKind(kind); const ext = checkExternalId(kind, externalId);
    if (ext === null) fail(E.CONNECTOR_EXTERNAL_ID_REQUIRED, 'An external_id is needed to find its merchant.', { kind });
    const rows = await read({ select: '*', kind: `eq.${kind}`, external_id: `eq.${ext}` });
    return rows.length ? { merchantId: rows[0].merchant_id, connector: fromRow(rows[0]) } : null;
  }

  /**
   * Explicitly link a connector to a merchant. Idempotent for the same merchant (returns the existing link, created: false);
   * refused if the external object already belongs to another merchant.
   */
  async function link({ merchantId, kind, externalId = null, externalDomain = null, status = 'NOT_CONFIGURED', config = {} }) {
    const id = checkMerchantId(merchantId); checkKind(kind); const ext = checkExternalId(kind, externalId); checkStatus(status);
    const cfg = validateConnectorConfig(config);
    const [merchant] = await supabase.select('merchants', { select: 'id', id: `eq.${id}`, limit: '1' });
    if (!merchant) fail(E.MERCHANT_NOT_FOUND, 'No merchant exists with this id.', { merchantId: id });
    const owner = async () => (ext === null ? null : findMerchantByExternal(kind, ext));
    const existing = await owner();
    if (existing) {
      if (existing.merchantId !== id) fail(E.CONNECTOR_EXTERNAL_TAKEN, 'This external account is already linked to another merchant.', { kind });
      return { connector: existing.connector, created: false };
    }
    let rows;
    try {
      rows = await supabase.insert(TABLE, [{ merchant_id: id, kind, external_id: ext, external_domain: externalDomain, status, config: cfg }]);
    } catch (e) {
      if (!isUniqueViolation(e)) fail(E.CONNECTOR_STORE_FAILED, 'The connector could not be stored.', { cause: e?.name ?? 'Error' });
      const raced = await owner(); // linked concurrently: same rules as above
      if (raced && raced.merchantId === id) return { connector: raced.connector, created: false };
      fail(E.CONNECTOR_EXTERNAL_TAKEN, 'This external account is already linked to another merchant.', { kind });
    }
    return { connector: fromRow(rows[0]), created: true };
  }

  /** Update the persisted status and/or the non-secret config of one of the merchant's connectors. Identity fields never change. */
  async function update({ merchantId, connectorId, status, config, externalDomain }) {
    const id = checkMerchantId(merchantId);
    if (typeof connectorId !== 'string' || !UUID.test(connectorId)) fail(E.CONNECTOR_NOT_FOUND, 'Unknown connector.');
    const patch = {};
    if (status !== undefined) patch.status = checkStatus(status);
    if (config !== undefined) patch.config = validateConnectorConfig(config);
    if (externalDomain !== undefined) patch.external_domain = externalDomain;
    if (!Object.keys(patch).length) fail(E.CONNECTOR_CONFIG_INVALID, 'Nothing to update.');
    let rows;
    try { rows = await supabase.update(TABLE, { id: `eq.${connectorId.toLowerCase()}`, merchant_id: `eq.${id}` }, patch); } catch (e) { fail(E.CONNECTOR_STORE_FAILED, 'The connector could not be updated.', { cause: e?.name ?? 'Error' }); }
    if (!rows || !rows.length) fail(E.CONNECTOR_NOT_FOUND, 'No such connector for this merchant.'); // also covers another merchant's connector
    return fromRow(rows[0]);
  }

  return { listForMerchant, getForMerchant, findMerchantByExternal, link, update };
}
