import {
  EXECUTION_MODE,
  LICENSE_STATUS,
  MODEL_STATUS,
} from './constants.js';

const str = (value, field) => {
  if (typeof value !== 'string' || !value.trim()) {
    throw new TypeError(`${field} must be a non-empty string`);
  }
  return value.trim();
};

const bool = (value, field) => {
  if (typeof value !== 'boolean') throw new TypeError(`${field} must be boolean`);
  return value;
};

export function normalizeCapabilityEntry(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new TypeError('capability entry must be an object');
  }

  const capabilities = Array.isArray(input.capabilities)
    ? [...new Set(input.capabilities.map((x) => str(x, 'capability')))].sort()
    : [];
  if (!capabilities.length) {
    throw new TypeError('capabilities must contain at least one item');
  }

  const executionMode = str(input.execution_mode, 'execution_mode');
  if (!Object.values(EXECUTION_MODE).includes(executionMode)) {
    throw new TypeError(`unsupported execution_mode: ${executionMode}`);
  }

  const status = str(input.status, 'status');
  if (!Object.values(MODEL_STATUS).includes(status)) {
    throw new TypeError(`unsupported status: ${status}`);
  }

  const licenseStatus = str(input.license_status, 'license_status');
  if (!Object.values(LICENSE_STATUS).includes(licenseStatus)) {
    throw new TypeError(`unsupported license_status: ${licenseStatus}`);
  }

  return Object.freeze({
    id: str(input.id, 'id'),
    name: str(input.name, 'name'),
    provider: str(input.provider, 'provider'),
    kind: str(input.kind, 'kind'),
    version: input.version == null ? null : str(input.version, 'version'),
    version_hash: input.version_hash == null
      ? null
      : str(input.version_hash, 'version_hash'),
    execution_mode: executionMode,
    capabilities,
    status,
    license_status: licenseStatus,
    license_name: input.license_name == null
      ? null
      : str(input.license_name, 'license_name'),
    license_source: input.license_source == null
      ? null
      : str(input.license_source, 'license_source'),
    license_verified_at: input.license_verified_at ?? null,
    commercial_use: bool(input.commercial_use, 'commercial_use'),
    eu_allowed: bool(input.eu_allowed, 'eu_allowed'),
    self_hostable: bool(input.self_hostable, 'self_hostable'),
    hardware: Object.freeze({ ...(input.hardware ?? {}) }),
    pricing: Object.freeze({ ...(input.pricing ?? {}) }),
    notes: Object.freeze([...(input.notes ?? [])]),
  });
}

export function evaluateModelExecutionGate(model, {
  capability = null,
  requireSelfHost = false,
} = {}) {
  if (!model) {
    return Object.freeze({ allowed: false, reason: 'MODEL_NOT_REGISTERED' });
  }
  if ([MODEL_STATUS.REJECT, MODEL_STATUS.WATCH].includes(model.status)) {
    return Object.freeze({ allowed: false, reason: 'MODEL_NOT_EXECUTABLE' });
  }
  if (model.license_status !== LICENSE_STATUS.VERIFIED) {
    return Object.freeze({ allowed: false, reason: 'LICENSE_NOT_VERIFIED' });
  }
  if (!model.license_source) {
    return Object.freeze({ allowed: false, reason: 'LICENSE_EVIDENCE_MISSING' });
  }
  if (model.commercial_use !== true) {
    return Object.freeze({ allowed: false, reason: 'COMMERCIAL_USE_NOT_ALLOWED' });
  }
  if (model.eu_allowed !== true) {
    return Object.freeze({ allowed: false, reason: 'EU_USE_NOT_ALLOWED' });
  }
  if (requireSelfHost && model.self_hostable !== true) {
    return Object.freeze({ allowed: false, reason: 'SELF_HOST_REQUIRED' });
  }
  if (
    model.execution_mode === EXECUTION_MODE.SELF_HOST
    && !model.version_hash
  ) {
    return Object.freeze({ allowed: false, reason: 'ARTIFACT_HASH_MISSING' });
  }
  if (capability && !model.capabilities.includes(capability)) {
    return Object.freeze({ allowed: false, reason: 'CAPABILITY_NOT_SUPPORTED' });
  }
  return Object.freeze({ allowed: true, reason: null });
}

export class CapabilityRegistry {
  #entries = new Map();

  constructor(entries = []) {
    for (const entry of entries) this.add(entry);
  }

  add(input) {
    const entry = normalizeCapabilityEntry(input);
    if (this.#entries.has(entry.id)) {
      throw new Error(`duplicate capability id: ${entry.id}`);
    }
    this.#entries.set(entry.id, entry);
    return entry;
  }

  get(id) {
    return this.#entries.get(id) ?? null;
  }

  list() {
    return [...this.#entries.values()]
      .sort((a, b) => a.id.localeCompare(b.id));
  }

  eligible(options = {}) {
    return this.list()
      .filter((entry) => evaluateModelExecutionGate(entry, options).allowed);
  }
}
