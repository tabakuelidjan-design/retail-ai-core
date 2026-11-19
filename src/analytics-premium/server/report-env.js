// Environment of the report child process (src/report/index.js), built from an explicit allowlist.
// Before: the child inherited the WHOLE environment of the Analytics server, and then received the Supabase service key.
// Now: no service key at all. The child reads and writes Postgres through two least-privilege login roles:
//   ANALYTICS_REPORT_READ_DATABASE_URL  -> analytics_report_reader (SELECT on the 13 report tables, merchant-scoped)
//   ANALYTICS_REPORT_WRITE_DATABASE_URL -> analytics_report_writer (SELECT/INSERT/UPDATE on data_quality_flags, merchant-scoped)
// NORDLA_REPORT_CHILD=1 tells the child it must use those URLs and must never fall back to a REST key.

const SYSTEM = ['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'TEMP', 'TMP', 'HOME', 'USERPROFILE', 'NODE_ENV', 'TZ'];
const REPORT = ['NORDLA_MERCHANT_ID', 'MERCHANT_TIMEZONE', 'ANALYTICS_REPORT_READ_DATABASE_URL', 'ANALYTICS_REPORT_WRITE_DATABASE_URL'];
const MARK = 'NORDLA_REPORT_CHILD';

/** The explicit environment for the report child. Missing names are simply absent. */
export function reportChildEnv(env = process.env) {
  const out = { [MARK]: '1' };
  for (const name of [...SYSTEM, ...REPORT]) {
    if (env[name] !== undefined && env[name] !== '') out[name] = String(env[name]);
  }
  return out;
}

/** The names the child receives, for tests and reviews (never the values). */
export const REPORT_CHILD_ENV_NAMES = Object.freeze([MARK, ...SYSTEM, ...REPORT]);
