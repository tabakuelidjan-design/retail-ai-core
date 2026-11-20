// PILOT: narrow runtime path for the invoice issue flow (read one document, issue it), on the least-privilege role
// nordla_fin_issuer_pilot (migration 20261120110000). Local pilot only: not wired by default, not deployed.
//
// Rules (see docs/finance-narrow-role-pilot-20261120.md):
//  - the connection pool is injected; this module never reads environment variables, secrets or URLs;
//  - every transaction sets the tenant context (app.merchant_id) and switches to the pilot role with SET LOCAL ROLE;
//  - NO fallback: a connection or query failure is thrown to the caller, which must not retry through service_role;
//  - the queries are the exact statements that the service needs: one row by id and merchant, and fin_issue_document.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const PILOT_ROLE = 'nordla_fin_issuer_pilot';

export function createNarrowIssuePath({ pool, merchantId }) {
  if (!pool || typeof pool.connect !== 'function') throw new TypeError('a connection pool is required');
  if (typeof merchantId !== 'string' || !UUID.test(merchantId)) throw new TypeError('a merchant id is required');
  const merchant = merchantId.toLowerCase();

  async function transaction(run) {
    let client;
    try { client = await pool.connect(); }
    catch (cause) { const e = new Error('NARROW_CONNECTION_FAILED'); e.cause = cause; throw e; }
    try {
      await client.query('begin');
      await client.query("select set_config('app.merchant_id', $1, true)", [merchant]);
      await client.query(`set local role ${PILOT_ROLE}`);
      const result = await run(client);
      await client.query('commit');
      return result;
    } catch (err) {
      await client.query('rollback').catch(() => {});
      throw err; // the original database error is kept so the store can translate it as before
    } finally {
      client.release();
    }
  }

  return Object.freeze({
    /** The document row, if it belongs to this merchant; null otherwise (the policy hides every other row). */
    async getDocument(id) {
      return transaction(async (c) => {
        const r = await c.query('select * from public.fin_documents where id = $1 and merchant_id = $2', [id, merchant]);
        return r.rows[0] ?? null;
      });
    },

    /** Same RPC and arguments as the service path; returns the document as the RPC returns it (jsonb). */
    async issueDocument({ docId, expectedVersion, newStatus, numbering, year, canonical, placeholder, lockedAt, event }) {
      return transaction(async (c) => {
        const r = await c.query(
          'select fin_issue_document($1::uuid, $2::uuid, $3::int, $4::text, $5::text, $6::int, $7::text, $8::int, $9::text, $10::text, $11::timestamptz, $12::jsonb) as r',
          [merchant, docId, expectedVersion, newStatus, numbering.prefix, numbering.pad, numbering.format, year, canonical, placeholder, lockedAt, JSON.stringify(event)],
        );
        return r.rows[0].r;
      });
    },
  });
}
