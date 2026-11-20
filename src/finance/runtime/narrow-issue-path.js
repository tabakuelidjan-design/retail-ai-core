// PILOT (v2): narrow runtime path for the invoice issue flow (read one document, issue it). Local pilot only, not wired by default.
//
// Identity (v2): the merchant is the one bound to the PostgreSQL LOGIN of the pool (session_user), not a value this module
// sends. Every transaction first asks the database to assert that the login is bound to `merchantId` and holds no
// privilege beyond the pilot role (nordla_runtime.fin_pilot_assert); only then does it switch to nordla_fin_issuer_pilot.
//
// Rules (see docs/finance-narrow-role-pilot-20261120.md):
//  - the connection pool is injected; this module reads no environment variable, secret or URL;
//  - no fallback: a connection, assertion or query failure is thrown; the caller must not retry through service_role;
//  - the statements are the exact ones the service needs: one document row by id, and fin_issue_document.

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
      await client.query(`set local role ${PILOT_ROLE}`);
      // Refuses the transaction unless the LOGIN identity (session_user, unchanged by SET ROLE) is bound to this merchant
      // and is not privileged. The assertion runs as the pilot role, which is the only role with EXECUTE on it.
      await client.query('select nordla_runtime.fin_pilot_assert($1::uuid)', [merchant]);
      const result = await run(client);
      await client.query('commit');
      return result;
    } catch (err) {
      await client.query('rollback').catch(() => {});
      throw err; // the original database error is kept so the store translates it as before
    } finally {
      client.release();
    }
  }

  return Object.freeze({
    /** Asserts the identity without touching any business row. Call once at start-up; throws if the login is not allowed. */
    async verify() {
      return transaction(async () => true);
    },

    /** The document row, if it belongs to the bound merchant; null otherwise (the policies hide every other row). */
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
