// Three-valued predicate language for the rule engine. A rule applies only when the identity facts ESTABLISH it; when the facts needed are
// unknown the answer is UNKNOWN (never silently true or false). Rules are DATA (JSON), never prompts.
//
//   { all: [p, ...] }   true if every p true; false if any false; else unknown
//   { any: [p, ...] }   true if any true; false if all false; else unknown
//   { not: p }
//   { trait: 'battery.present', is: true }            equality on a trait value (unknown when the trait is unknown)
//   { trait: 'electrical.maxVoltageDc', gte: 75 }     numeric comparison (gte / gt / lte / lt)
//   { trait: 'category', in: ['power_bank', ...] }    membership
//   { ctx: 'channel', in: ['amazon'] }                a context value (target market, channel, role facts)
//   { always: true }
export const T = Object.freeze({ TRUE: true, FALSE: false, UNKNOWN: null });

const and3 = (xs) => (xs.some((x) => x === false) ? false : xs.every((x) => x === true) ? true : null);
const or3 = (xs) => (xs.some((x) => x === true) ? true : xs.every((x) => x === false) ? false : null);

/** @param {object} p predicate @param {{ trait: (name: string) => any, ctx: (name: string) => any }} env value getters; undefined/null = unknown */
export function evaluate(p, env) {
  if (p === true || (p && p.always === true)) return true;
  if (p === false) return false;
  if (!p || typeof p !== 'object') throw new Error('predicate must be an object');
  if (p.all) return and3(p.all.map((x) => evaluate(x, env)));
  if (p.any) return or3(p.any.map((x) => evaluate(x, env)));
  if ('not' in p) { const v = evaluate(p.not, env); return v === null ? null : !v; }
  const get = 'trait' in p ? env.trait(p.trait) : 'ctx' in p ? env.ctx(p.ctx) : undefined;
  if (!('trait' in p) && !('ctx' in p)) throw new Error(`unknown predicate: ${JSON.stringify(p)}`);
  if (get === undefined || get === null) return null;
  if ('is' in p) return get === p.is;
  if ('in' in p) return p.in.includes(get);
  if ('notIn' in p) return !p.notIn.includes(get);
  const n = Number(get);
  if (Number.isNaN(n)) return null;
  if ('gte' in p) return n >= p.gte; if ('gt' in p) return n > p.gt; if ('lte' in p) return n <= p.lte; if ('lt' in p) return n < p.lt;
  throw new Error(`predicate has no operator: ${JSON.stringify(p)}`);
}

/** The trait / context names a predicate reads (to say WHICH missing fact leaves a rule unresolved). */
export function readsOf(p, out = new Set()) {
  if (!p || typeof p !== 'object') return out;
  for (const k of ['all', 'any']) if (p[k]) p[k].forEach((x) => readsOf(x, out));
  if ('not' in p) readsOf(p.not, out);
  if ('trait' in p) out.add(`trait:${p.trait}`); if ('ctx' in p) out.add(`ctx:${p.ctx}`);
  return out;
}
