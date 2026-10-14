# Finance - real PostgreSQL 17 test bench (Phase 0)

Why: PGlite (single session, PostgreSQL 18 engine) cannot prove concurrency. Money mechanisms are only trusted once they pass here, on a real PostgreSQL 17 with many simultaneous connections.

## Run

```
node test/pg/run.mjs          # starts the disposable container if needed, runs the 4 suites serially, prints a summary
node test/pg/pgctl.mjs reset  # destroy and recreate the PostgreSQL 17 container from zero
node test/pg/pgctl.mjs down   # remove it
```

Requires Docker (Desktop on Windows with the WSL2 backend). `cd test/pg && npm install` once (the `pg` driver lives only here; it is never a dependency of the product).

## What it is

- Image: official `postgres:17`, pinned by digest (`pgctl.mjs`). Data on tmpfs: gone with the container. Bound to 127.0.0.1:54329. Throw-away password. No production secret anywhere.
- Each suite works on a database copied from a template that was built by replaying every `supabase/migrations/*.sql` from zero; a copy is dropped after each test (= reset).
- Supabase is simulated only as far as the migrations need it (roles `anon`/`authenticated`/`service_role`, `auth`/`storage` stubs, `pgcrypto` in `extensions`).

## Safety (never run against production)

1. `lib/safety.js` refuses, before any connection, every URL that is not loopback or that looks hosted (supabase, pooler, railway, aws, cloud, prod...).
2. After connecting it requires PostgreSQL 17 **and** the `cluster_name = nordla_finance_test` sentinel that only `pgctl.mjs` sets.
3. Test databases must be named `finance_test_*`.
4. The harness never reads `.env`, `SUPABASE_*` or `DATABASE_URL`. The only honoured override is `FINANCE_PG_TEST_URL`, and it goes through the same guard.

## Result vocabulary (`lib/classify.js`)

| Tag | Meaning | Run |
|---|---|---|
| CONTROL PASS | a protection that must hold, holds | passes |
| EXPECTED P0 REPRODUCTION | a documented defect is reproduced (the bench sees it) | passes |
| UNEXPECTED: DEFECT ABSENT | a documented defect is not reproduced (code or bench changed) | fails |
| UNEXPECTED: CONTROL BROKEN | a protection that must hold does not | fails |
| INFRA FAILURE | anything thrown that is not a measured outcome | fails |

Phase 1 turns each EXPECTED P0 REPRODUCTION into a CONTROL PASS (by flipping `expectedP0` to `control`) as the defect is fixed.

## CI

`.github/workflows/finance-pg.yml` (not activated until pushed) starts the same container with `pgctl.mjs up` and runs `run.mjs`. No secret.
