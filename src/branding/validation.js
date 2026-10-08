const plainObject = (value) => (
  value != null && typeof value === 'object' && !Array.isArray(value)
);

export function assertObject(value, field) {
  if (!plainObject(value)) throw new TypeError(`${field} must be an object`);
  return value;
}

export function requiredString(value, field) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new TypeError(`${field} must be a non-empty string`);
  }
  return value.trim();
}

export function optionalString(value, field) {
  return value == null ? null : requiredString(value, field);
}

export function integerVersion(value, field = 'version') {
  if (!Number.isInteger(value) || value < 1) {
    throw new TypeError(`${field} must be an integer >= 1`);
  }
  return value;
}

export function isoDate(value, field) {
  const text = requiredString(value, field);
  const date = new Date(text);
  if (Number.isNaN(date.getTime())) throw new TypeError(`${field} must be an ISO date/time`);
  return date.toISOString();
}

export function enumValue(value, allowed, field) {
  const normalized = requiredString(value, field);
  if (!Object.values(allowed).includes(normalized)) {
    throw new TypeError(`unsupported ${field}: ${normalized}`);
  }
  return normalized;
}

export function stringList(value, field, { max = null } = {}) {
  if (value == null) return Object.freeze([]);
  if (!Array.isArray(value)) throw new TypeError(`${field} must be an array`);
  const out = [...new Set(value.map((item) => requiredString(item, field)))];
  if (max != null && out.length > max) {
    throw new RangeError(`${field} must contain at most ${max} items`);
  }
  return Object.freeze(out);
}

export function objectList(value, field, normalizer) {
  if (value == null) return Object.freeze([]);
  if (!Array.isArray(value)) throw new TypeError(`${field} must be an array`);
  return Object.freeze(value.map((item, index) => normalizer(item, `${field}[${index}]`)));
}

export function jsonValue(value, field = 'value') {
  try {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) throw new Error();
    return JSON.parse(encoded);
  } catch {
    throw new TypeError(`${field} must be JSON-serializable`);
  }
}

export function uniqueIds(items, field) {
  const ids = items.map((item) => item.id);
  if (new Set(ids).size !== ids.length) {
    throw new Error(`${field} contains duplicate ids`);
  }
}

export function approval(input, field = 'approval') {
  if (input == null) return null;
  assertObject(input, field);
  return Object.freeze({
    approved_by: requiredString(input.approved_by, `${field}.approved_by`),
    approved_at: isoDate(input.approved_at, `${field}.approved_at`),
    note: optionalString(input.note, `${field}.note`),
  });
}

export function validationResult(reasons = []) {
  const unique = [...new Set(reasons)];
  return Object.freeze({
    ok: unique.length === 0,
    reasons: Object.freeze(unique),
  });
}
