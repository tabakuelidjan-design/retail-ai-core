// PARITY run: the SAME procurement suites that run on the in-memory store are run against a REAL PostgreSQL (throw-away container, never a shared or production database).
//
//   node test/postgres/procurement-parity.mjs [suite.test.js ...]      (needs Docker and `npm ci --prefix test/pg`)
//
// It starts postgres:17, applies the phase-1 schema (for `merchants`) and the procurement migration, then runs each suite in its own process with
// PROCUREMENT_STORE=pg PROCUREMENT_PG_URL=<the container>. Exit code 0 only if every suite passes. KEEP_PG_SMOKE=1 keeps the container.
import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const NAME = 'nordla-pg-parity-procurement';
const IMAGE = process.env.PG_SMOKE_IMAGE ?? 'postgres:17';
const docker = (args, input) => spawnSync('docker', args, { input, encoding: 'utf8' });
const sleepMs = (ms) => spawnSync(process.execPath, ['-e', `setTimeout(()=>{},${ms})`]);
if (docker(['version', '--format', '{{.Server.Version}}']).status !== 0) { console.error('STOP: Docker is required.'); process.exit(2); }

docker(['rm', '-f', NAME]);
const run = docker(['run', '-d', '--name', NAME, '-e', 'POSTGRES_PASSWORD=parity', '-p', '127.0.0.1::5432', IMAGE]);
if (run.status !== 0) { console.error(run.stderr); process.exit(2); }
let failed = 0;
try {
  const psql = (text) => docker(['exec', '-i', NAME, 'psql', '-U', 'postgres', '-d', 'postgres', '-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1'], text);
  const ready = () => ((docker(['logs', NAME]).stderr ?? '') + (docker(['logs', NAME]).stdout ?? '')).split('database system is ready to accept connections').length - 1;
  for (let i = 0; i < 90 && ready() < 2; i += 1) sleepMs(1000);
  for (let i = 0; i < 30 && psql('select 1').status !== 0; i += 1) sleepMs(1000);
  const apply = (file, dir = 'migrations') => { const r = psql(`begin;\n${readFileSync(`${ROOT}supabase/${dir}/${file}`, 'utf8')}\ncommit;`); if (r.status !== 0) { console.error(r.stderr); process.exit(2); } };
  apply('20260920132005_phase1_schema.sql'); apply('20261016090000_procurement_stock.sql', 'migrations-pending'); apply('20261016091000_procurement_permissions.sql', 'migrations-pending');
  const port = /:(\d+)\s*$/m.exec(docker(['port', NAME, '5432']).stdout)?.[1];
  const url = `postgres://postgres:parity@127.0.0.1:${port}/postgres`;
  const suites = process.argv.length > 2 ? process.argv.slice(2) : readdirSync(`${ROOT}test`).filter((f) => /^procurement-.*\.test\.js$/.test(f)).map((f) => `test/${f}`);
  for (const s of suites) {
    const t = Date.now();
    const r = spawnSync(process.execPath, ['--test', s], { cwd: ROOT, encoding: 'utf8', env: { ...process.env, PROCUREMENT_STORE: 'pg', PROCUREMENT_PG_URL: url } });
    const out = (r.stdout ?? '') + (r.stderr ?? '');
    const m = (k) => new RegExp(`^(?:ℹ|#) ${k} (\\d+)`, 'm').exec(out)?.[1] ?? '?';
    console.log(`${r.status === 0 ? 'PASS' : 'FAIL'}  ${s}  tests ${m('tests')} pass ${m('pass')} fail ${m('fail')}  ${Math.round((Date.now() - t) / 1000)}s`);
    if (r.status !== 0) { failed += 1; console.log(out.split('\n').filter((l) => /✖|not ok|Error|expected|actual/.test(l)).slice(0, 25).join('\n')); }
  }
} finally { if (process.env.KEEP_PG_SMOKE !== '1') docker(['rm', '-f', NAME]); }
console.log(failed ? `\n${failed} suite(s) FAILED on PostgreSQL` : '\nall suites pass on PostgreSQL');
process.exit(failed ? 1 : 0);
