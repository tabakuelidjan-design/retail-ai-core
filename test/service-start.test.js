// Every Nordla service deployed from this repository starts through ONE dispatcher (src/service-start.js) that runs the program named by
// the required NORDLA_SERVICE variable. These checks catch a future inversion: a root config file starting a specific program again
// (e.g. the Core scheduler on every service), a service mapped to another service's program, or a missing variable that starts anything.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { SERVICE_ENTRIES, resolveServiceEntry, ServiceStartError } from '../src/service-start.js';

const ROOT = new URL('../', import.meta.url);
const read = (f) => readFileSync(new URL(f, ROOT), 'utf8');
const DISPATCHER = 'node src/service-start.js';

test('every root deployment config starts the dispatcher - never a specific service program', () => {
  const railway = JSON.parse(read('railway.json')); const railpack = JSON.parse(read('railpack.json'));
  assert.equal(railway.deploy.startCommand, DISPATCHER); assert.equal(railpack.deploy.startCommand, DISPATCHER);
  for (const f of ['railway.toml', 'nixpacks.toml', 'Procfile']) assert.equal(existsSync(new URL(f, ROOT)), false, `${f} would be a second, competing start command`);
  for (const cfg of [read('railway.json'), read('railpack.json')]) for (const entry of Object.values(SERVICE_ENTRIES)) assert.ok(!cfg.includes(entry), `a root config names ${entry} directly`);
});

test('each service maps to its own program (no inversion), and each program is really that service', () => {
  assert.deepEqual(Object.keys(SERVICE_ENTRIES).sort(), ['analytics', 'core', 'finance']);
  const signature = { core: /export async function schedule\(/, finance: /export async function startFinanceServer\(/, analytics: /export async function startAnalyticsServer\(/ };
  for (const [name, entry] of Object.entries(SERVICE_ENTRIES)) {
    assert.ok(existsSync(new URL(entry, ROOT)), `${name}: ${entry} exists`);
    assert.match(read(entry), signature[name], `${name} starts ${entry}, which must be the ${name} program`);
  }
  assert.doesNotMatch(SERVICE_ENTRIES.analytics, /sync|finance/); assert.doesNotMatch(SERVICE_ENTRIES.finance, /sync|analytics/); assert.match(SERVICE_ENTRIES.core, /^src\/sync\//);
});

test('NORDLA_SERVICE is required and exact: missing, empty or unknown refuses to start', () => {
  for (const env of [{}, { NORDLA_SERVICE: '' }, { NORDLA_SERVICE: '  ' }, { NORDLA_SERVICE: 'growth' }, { NORDLA_SERVICE: 'sync' }]) assert.throws(() => resolveServiceEntry(env), ServiceStartError, JSON.stringify(env));
  assert.deepEqual(resolveServiceEntry({ NORDLA_SERVICE: 'analytics' }), { name: 'analytics', entry: 'src/analytics-premium/server/serve.js' });
  assert.equal(resolveServiceEntry({ NORDLA_SERVICE: ' Core ' }).entry, 'src/sync/scheduler.js');
});

test('the real dispatcher process: without NORDLA_SERVICE it exits 1 immediately and starts nothing', () => {
  const env = { PATH: process.env.PATH, SYSTEMROOT: process.env.SYSTEMROOT };
  const r = spawnSync(process.execPath, ['src/service-start.js'], { cwd: ROOT, env, encoding: 'utf8', timeout: 10_000 });
  assert.equal(r.status, 1); assert.match(r.stderr, /service start refused: NORDLA_SERVICE is not set/);
  assert.doesNotMatch(r.stdout, /Nordla service:/);
});
