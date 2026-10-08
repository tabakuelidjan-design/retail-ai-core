// Strict SUBSET validator for Nordla Branding schemas - NOT a general JSON Schema implementation.
//
// It supports only the keywords listed in SUPPORTED below (type, enum, const, properties, required,
// additionalProperties, items, min/max constraints, pattern, uniqueItems, local #/$defs/ $ref) and
// REFUSES every other keyword (oneOf, allOf, if/then, patternProperties, format, remote $ref...),
// even in branches the data never reaches. A schema file is therefore either enforced for real or
// rejected - it can never silently contain an unenforced constraint. `$schema`/`$id` are treated as
// annotations only. Do not rely on it for third-party schemas or full draft 2020-12 semantics.
//
// Why it exists: a schema nobody executes rots (the first Branding schema was removed for that
// reason), and a full validator would add a dependency (NDR-P10: build/own what is cheap).

const ANNOTATIONS = new Set(['$schema', '$id', 'title', 'description', '$defs']);
const SUPPORTED = new Set([
  ...ANNOTATIONS, '$ref', 'type', 'enum', 'const', 'properties', 'required', 'additionalProperties',
  'items', 'minItems', 'maxItems', 'uniqueItems', 'minLength', 'maxLength', 'pattern', 'minimum', 'maximum',
]);

const typeOf = (value) => {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (Number.isInteger(value)) return 'integer';
  return typeof value; // string | number | boolean | object
};

const matchesType = (value, type) => {
  const actual = typeOf(value);
  return actual === type || (type === 'number' && actual === 'integer');
};

function resolveRef(root, ref) {
  if (!ref.startsWith('#/$defs/')) throw new Error(`UNSUPPORTED_SCHEMA_REF: ${ref}`);
  const target = root.$defs?.[ref.slice('#/$defs/'.length)];
  if (!target) throw new Error(`UNRESOLVED_SCHEMA_REF: ${ref}`);
  return target;
}

function check(schema, value, path, root, errors) {
  for (const keyword of Object.keys(schema)) {
    if (!SUPPORTED.has(keyword)) throw new Error(`UNSUPPORTED_SCHEMA_KEYWORD: ${keyword}`);
  }
  if (schema.$ref) {
    check(resolveRef(root, schema.$ref), value, path, root, errors);
    return;
  }

  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((type) => matchesType(value, type))) {
      errors.push(`${path}: expected ${types.join('|')}`);
      return;
    }
  }
  if (schema.const !== undefined && value !== schema.const) errors.push(`${path}: must equal ${JSON.stringify(schema.const)}`);
  if (schema.enum && !schema.enum.includes(value)) errors.push(`${path}: not one of ${schema.enum.join(', ')}`);

  if (typeof value === 'string') {
    if (schema.minLength !== undefined && value.length < schema.minLength) errors.push(`${path}: too short`);
    if (schema.maxLength !== undefined && value.length > schema.maxLength) errors.push(`${path}: too long`);
    if (schema.pattern && !new RegExp(schema.pattern, 'u').test(value)) errors.push(`${path}: does not match pattern`);
  }
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) errors.push(`${path}: below minimum`);
    if (schema.maximum !== undefined && value > schema.maximum) errors.push(`${path}: above maximum`);
  }

  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) errors.push(`${path}: too few items`);
    if (schema.maxItems !== undefined && value.length > schema.maxItems) errors.push(`${path}: too many items`);
    if (schema.uniqueItems && new Set(value.map((item) => JSON.stringify(item))).size !== value.length) {
      errors.push(`${path}: items must be unique`);
    }
    if (schema.items) value.forEach((item, index) => check(schema.items, item, `${path}[${index}]`, root, errors));
  }

  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    for (const key of schema.required ?? []) {
      if (!(key in value)) errors.push(`${path}: missing required property ${key}`);
    }
    const props = schema.properties ?? {};
    for (const [key, sub] of Object.entries(props)) {
      if (key in value) check(sub, value[key], `${path}.${key}`, root, errors);
    }
    for (const key of Object.keys(value)) {
      if (key in props) continue;
      if (schema.additionalProperties === false) errors.push(`${path}: unexpected property ${key}`);
      else if (schema.additionalProperties && typeof schema.additionalProperties === 'object') {
        check(schema.additionalProperties, value[key], `${path}.${key}`, root, errors);
      }
    }
  }
}

// Eager walk: an unsupported keyword is refused even in a branch the data never reaches.
function assertSupported(schema) {
  if (schema == null || typeof schema !== 'object') return;
  for (const keyword of Object.keys(schema)) {
    if (!SUPPORTED.has(keyword)) throw new Error(`UNSUPPORTED_SCHEMA_KEYWORD: ${keyword}`);
  }
  for (const sub of Object.values(schema.properties ?? {})) assertSupported(sub);
  for (const sub of Object.values(schema.$defs ?? {})) assertSupported(sub);
  assertSupported(schema.items);
  if (typeof schema.additionalProperties === 'object') assertSupported(schema.additionalProperties);
}

/** @returns {{ ok: boolean, errors: string[] }} - throws on a schema using an unsupported keyword. */
export function validateSchemaSubset(schema, value) {
  assertSupported(schema);
  const errors = [];
  check(schema, value, '$', schema, errors);
  return Object.freeze({ ok: errors.length === 0, errors: Object.freeze(errors) });
}
