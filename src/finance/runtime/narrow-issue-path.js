// PILOT: narrow runtime path for the invoice flow: the issue role (one document read by id, fin_issue_document) and the reader
// role (the reads that happen before an issue: linkage and ledger, see narrow-reader.js). Local pilot only, not wired by default.
//
// Identity: the merchant is the one bound to the PostgreSQL LOGIN of the pool (session_user), not a value this module sends.
// Every transaction first asks the database to assert that identity for the role it is about to use, then switches to that role.
//
// Rules (see docs/finance-narrow-role-pilot-20261120.md):
//  - the connection pool is injected; this module reads no environment variable, secret or URL;
//  - no fallback: a connection, assertion or query failure is thrown; the caller must not retry through service_role;
//  - the statements are the exact ones the service needs.

import { createNarrowReader, PILOT_READER_ROLE } from './narrow-reader.js';
import { PILOT_ARCHIVE_ROLE } from './narrow-archive.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const PILOT_ROLE = 'nordla_fin_issuer_pilot';

export function createNarrowIssuePath({ pool, merchantId }) {
  if (!pool || typeof pool.connect !== 'function') throw new TypeError('a connection pool is required');
  if (typeof merchantId !== 'string' || !UUID.test(merchantId)) throw new TypeError('a merchant id is required');
  const merchant = merchantId.toLowerCase();

  async function transaction(run, role = PILOT_ROLE) {
    let client;
    try { client = await pool.connect(); }
    catch (cause) { const e = new Error('NARROW_CONNECTION_FAILED'); e.cause = cause; throw e; }
    try {
      await client.query('begin');
      await client.query(`set local role ${role}`);
      // Refuses the transaction unless the LOGIN identity (session_user, unchanged by SET ROLE) is bound to this merchant,
      // is not privileged, and is a member of this role and of no other role than the two pilot roles.
      if (role === PILOT_ROLE) await client.query('select nordla_runtime.fin_pilot_assert($1::uuid)', [merchant]);
      else await client.query('select nordla_runtime.fin_pilot_assert_role($1::uuid, $2::text)', [merchant, role]);
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

  const read = createNarrowReader({ transaction: (run) => transaction(run, PILOT_READER_ROLE) });

  return Object.freeze({
    /** Asserts the identity for both roles without touching any business row. Call once at start-up. */
    async verify() {
      await transaction(async () => true, PILOT_ROLE);
      await transaction(async () => true, PILOT_READER_ROLE);
      await transaction(async () => true, PILOT_ARCHIVE_ROLE);
      return true;
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

    /** Reads for the pre-issue checks (fin_documents, commerce tables), on the reader role only. */
    read,

    /** Runs `run` on the archive role for this merchant (database side of the legal archive only). */
    archiveTransaction: (run) => transaction(run, PILOT_ARCHIVE_ROLE),
  });
}
