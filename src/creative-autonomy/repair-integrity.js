// A repair that is told "change only these fields" is CHECKED, not trusted: every field that was not refused must come back exactly as it was. No artistic rule here: only "what you did not have to change, you did not change".
const isObj = (v) => v !== null && typeof v === 'object';
/** { 'elements[1].element': '...', 'text_reserve.zone': '...', ... } : every leaf of an answer, by path. */
export function leavesOf(value, prefix = '', out = {}) {
  if (Array.isArray(value)) { if (!value.length) out[prefix] = '[]'; value.forEach((v, i) => leavesOf(v, `${prefix}[${i}]`, out)); }
  else if (isObj(value)) { const keys = Object.keys(value); if (!keys.length) out[prefix] = '{}'; keys.forEach((k) => leavesOf(value[k], prefix ? `${prefix}.${k}` : k, out)); }
  else out[prefix] = JSON.stringify(value);
  return out;
}
// a path is related to a refused field when one is the other or lies under it ("elements" covers "elements[1].element"; "text_reserve.description" is covered by "text_reserve")
const related = (path, field) => path === field || path.startsWith(`${field}.`) || path.startsWith(`${field}[`) || field.startsWith(`${path}.`) || field.startsWith(`${path}[`);
/** The paths whose value differs between `previous` and `repaired` although none of the `refusedFields` concerns them. */
export function unrefusedChanges(previous, repaired, refusedFields) {
  const a = leavesOf(previous); const b = leavesOf(repaired); const paths = [...new Set([...Object.keys(a), ...Object.keys(b)])];
  return paths.filter((p) => a[p] !== b[p] && !refusedFields.some((f) => related(p, f)));
}
