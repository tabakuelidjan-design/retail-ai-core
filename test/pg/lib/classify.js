// Result classification for the Phase 0 test bench. A reproducer that shows a KNOWN defect is a success of the bench (it proves the bench can see the defect):
//   EXPECTED P0 REPRODUCTION   the defect is present, as documented in the audit  -> test passes, defect is listed
//   CONTROL PASS               a protection that must already hold, and does       -> test passes
//   UNEXPECTED: DEFECT ABSENT  a documented defect was NOT reproduced              -> test FAILS (the bench or the code changed: investigate)
//   UNEXPECTED: CONTROL BROKEN a protection that must hold does not               -> test FAILS
//   INFRA FAILURE              anything thrown that is not a measured outcome       -> test FAILS (never confused with a P0)
import { test, after } from 'node:test';
import { mkdirSync, appendFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const OUT = fileURLToPath(new URL('../.results/', import.meta.url));
mkdirSync(OUT, { recursive: true });
const log = (rec) => { appendFileSync(`${OUT}results.jsonl`, `${JSON.stringify(rec)}\n`); console.log(`  [${rec.tag}] ${rec.id} :: ${rec.evidence}`); };

async function run(id, kind, fn) {
  let res;
  try { res = await fn(); } catch (e) { log({ id, kind, tag: 'INFRA FAILURE', evidence: String(e.message).split('\n')[0] }); throw e; }
  const { holds, evidence } = res; // holds = the protection holds / the defect is absent
  if (kind === 'legacy') {
    if (!holds) { log({ id, kind, tag: 'KNOWN LEGACY GAP', evidence }); return; }
    log({ id, kind, tag: 'UNEXPECTED: LEGACY GAP CLOSED', evidence }); throw new Error(`${id}: legacy gap no longer present - turn it into a control - ${evidence}`);
  }
  if (kind === 'p0') {
    if (!holds) { log({ id, kind, tag: 'EXPECTED P0 REPRODUCTION', evidence }); return; }
    log({ id, kind, tag: 'UNEXPECTED: DEFECT ABSENT', evidence }); throw new Error(`${id}: documented defect not reproduced - ${evidence}`);
  }
  if (holds) { log({ id, kind, tag: 'CONTROL PASS', evidence }); return; }
  log({ id, kind, tag: 'UNEXPECTED: CONTROL BROKEN', evidence }); throw new Error(`${id}: control broken - ${evidence}`);
}

/** A documented P0: fn resolves { holds, evidence }; holds === false means the defect is reproduced. */
export const expectedP0 = (id, fn) => test(id, () => run(id, 'p0', fn));
/** A known defect of the frozen legacy table fin_payments: documented, not fixed (the application no longer writes it; the cutover freezes it). */
export const legacyGap = (id, fn) => test(id, () => run(id, 'legacy', fn));
/** A protection that must hold today. */
export const control = (id, fn) => test(id, () => run(id, 'control', fn));
export { after };
