// Guard rails: a Finance PostgreSQL test must never run against anything but the disposable local container.
// Layer 1 (before any connection): the URL must be loopback, a non-production port-less host, and must not look like Supabase/Railway/cloud.
// Layer 2 (after connecting): the server must be PostgreSQL 17 AND carry the cluster_name sentinel that only pgctl sets.
// The harness never reads .env, SUPABASE_*, DATABASE_URL or any production variable.
import { CLUSTER_NAME, DEFAULT_URL } from '../pgctl.mjs';

const FORBIDDEN = /(supabase|pooler|railway|amazonaws|rds\.|neon\.|render\.com|azure|googleapis|cloud|prod)/i;
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

export function assertSafeTestUrl(url) {
  let u;
  try { u = new URL(url); } catch { throw new Error('UNSAFE TEST TARGET: unparsable connection URL'); }
  if (!['postgres:', 'postgresql:'].includes(u.protocol)) throw new Error('UNSAFE TEST TARGET: not a postgres URL');
  if (!LOOPBACK.has(u.hostname)) throw new Error(`UNSAFE TEST TARGET: host "${u.hostname}" is not loopback`);
  if (FORBIDDEN.test(url)) throw new Error('UNSAFE TEST TARGET: URL looks like a hosted/production database');
  return u;
}

export function testUrl() {
  const url = process.env.FINANCE_PG_TEST_URL ?? DEFAULT_URL; // the only variable honoured, and it is re-validated
  assertSafeTestUrl(url);
  return url;
}

export async function assertSafeServer(client) {
  const v = (await client.query('show server_version_num')).rows[0].server_version_num;
  if (!String(v).startsWith('17')) throw new Error(`UNSAFE/UNSUPPORTED TEST SERVER: version_num ${v}, PostgreSQL 17 required`);
  const cn = (await client.query("select current_setting('cluster_name', true) c")).rows[0].c;
  if (cn !== CLUSTER_NAME) throw new Error(`UNSAFE TEST TARGET: cluster_name sentinel missing (got "${cn}"); only the pgctl container is allowed`);
}

export const safeDbName = (name) => /^finance_test_[a-z0-9_]{1,40}$/.test(name);
