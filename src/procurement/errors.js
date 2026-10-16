// Stock / Achats: one error type with a stable code. A refusal is always an explicit, named code - never a silent no-op.
export class ProcurementError extends Error {
  constructor(code, message, detail = {}) { super(message); this.name = 'ProcurementError'; this.code = code; this.detail = detail; }
}
export const fail = (code, message, detail) => { throw new ProcurementError(code, message, detail); };

export class StoreError extends Error {
  constructor(code, message, detail = {}) { super(message); this.name = 'StoreError'; this.code = code; this.detail = detail; }
}
