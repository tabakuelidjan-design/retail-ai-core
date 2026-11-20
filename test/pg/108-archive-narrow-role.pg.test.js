// PILOT v7 (local, disposable database, two synthetic merchants, REAL distinct LOGIN roles with the ARCHIVE role only).
// The database side of the legal archive (fin_artifacts, fin_seller_profile_versions, fin_events) on nordla_fin_archive_pilot:
// company isolation, what the role cannot do, duplicate / other-content refusals, connection failure then retry, and integrity on read.
// The PDF bytes stay in storage (not tested here: the storage key is an administrative access, see the pilot report).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { freshDatabase, seedMerchants, issuedInvoice, adminClient, clientFor, MERCHANT_A, MERCHANT_B } from './lib/db.js';
import { poolFor, PW, dropPilotLogins } from './lib/pilot.js';
import { createNarrowIssuePath } from '../../src/finance/runtime/narrow-issue-path.js';
import { createNarrowArchive } from '../../src/finance/runtime/narrow-archive.js';
import { createLegalArtifacts } from '../../src/finance/legal-artifacts.js';

after(dropPilotLogins);
const LA = 'nordla_fin_arch_login_a';
const LB = 'nordla_fin_arch_login_b';
const sha = (s) => createHash('sha256').update(s).digest('hex');
const codeOf = async (fn) => { try { await fn(); return null; } catch (e) { return e.code ?? e.message; } };

async function setup() {
  const db = await freshDatabase();
  const admin = await clientFor(db.name);
  await seedMerchants(admin);
  for (const l of [LA, LB]) {
    await admin.query(`do $$ begin if not exists (select 1 from pg_roles where rolname='${l}') then create role ${l} login noinherit nobypassrls password '${PW}'; end if; end $$`);
    await admin.query(`grant nordla_fin_archive_pilot to ${l}`);
  }
  await admin.query(`insert into nordla_runtime.fin_pilot_principals (login_role, merchant_id) values ('${LA}', '${MERCHANT_A}'), ('${LB}', '${MERCHANT_B}') on conflict do nothing`);
  const docA = await issuedInvoice(admin, MERCHANT_A, 12100);
  const docB = await issuedInvoice(admin, MERCHANT_B, 24200);
  docA.merchant = MERCHANT_A; docB.merchant = MERCHANT_B;
  const pools = [];
  const archiveFor = (login, merchantId) => {
    const pool = poolFor(db, login, { max: 2 });
    pools.push(pool);
    const path = createNarrowIssuePath({ pool, merchantId });
    return { pool, archive: createNarrowArchive({ transaction: path.archiveTransaction, merchantId }) };
  };
  const cleanup = async () => { for (const p of pools) await p.end().catch(() => {}); await admin.end(); await db.drop(); };
  return { db, admin, docA, docB, archiveFor, cleanup };
}

const pdfRow = (doc, bytes = 'pdf-A-1', extra = {}) => ({
  kind: 'PDF_ORIGINAL', classification: 'ORIGINAL', documentId: doc.id, storageRef: `${doc.merchant}/legal/${doc.id}/pdf/${sha(bytes)}`,
  sha256: sha(bytes), sizeBytes: bytes.length, mediaType: 'application/pdf', fileName: 'FACT-2026-0001.pdf', provenance: { source: 'issue' }, ...extra,
});

test('own company: the original is archived once; the same bytes are a duplicate; other bytes for the same original are refused', async () => {
  const s = await setup();
  try {
    const { archive } = s.archiveFor(LA, MERCHANT_A);
    const first = await archive.archiveArtifact(pdfRow(s.docA));
    assert.equal(first.duplicate, false);
    assert.equal(first.artifact.merchantId, MERCHANT_A);
    const again = await archive.archiveArtifact(pdfRow(s.docA));
    assert.equal(again.duplicate, true, 'the identical retry is a duplicate');
    assert.equal(again.artifact.id, first.artifact.id);
    assert.equal(await codeOf(() => archive.archiveArtifact(pdfRow(s.docA, 'pdf-A-OTHER'))), 'ARTIFACT_ORIGINAL_EXISTS_WITH_OTHER_CONTENT');
    const count = (await s.admin.query('select count(*)::int n from fin_artifacts where document_id = $1', [s.docA.id])).rows[0].n;
    assert.equal(count, 1, 'exactly one row for the original');
  } finally { await s.cleanup(); }
});

test('other company: a login cannot archive, list or read an artifact of the other merchant', async () => {
  const s = await setup();
  try {
    const a = s.archiveFor(LA, MERCHANT_A).archive;
    const b = s.archiveFor(LB, MERCHANT_B).archive;
    const ownB = await b.archiveArtifact(pdfRow(s.docB, 'pdf-B-1'));
    // A tries to archive a document of B (and to borrow B's merchant id in the row)
    assert.ok(await codeOf(() => a.archiveArtifact(pdfRow(s.docB, 'pdf-B-2'))), 'archiving another merchant\'s document is refused');
    assert.ok(await codeOf(() => a.archiveArtifact({ ...pdfRow(s.docA, 'pdf-A-9'), merchantId: MERCHANT_B })), 'a forged merchant id is refused');
    assert.deepEqual(await a.listArtifacts({ documentId: s.docB.id }), [], 'A lists nothing of B');
    assert.equal(await a.getArtifact(MERCHANT_A, ownB.artifact.id), null, 'A cannot read B\'s artifact by id');
    assert.equal(await codeOf(() => a.appendEvent({ merchantId: MERCHANT_B, documentId: s.docB.id, at: '2026-11-20T10:00:00Z', actor: { type: 'system' }, action: 'X', detail: {} })) !== null, true, 'A cannot write an event for B');
    const rows = (await s.admin.query('select count(*)::int n from fin_artifacts where merchant_id = $1', [MERCHANT_B])).rows[0].n;
    assert.equal(rows, 1, 'B has only its own artifact');
  } finally { await s.cleanup(); }
});

test('the archive role cannot read the documents, change an artifact or delete one', async () => {
  const s = await setup();
  try {
    const { archive, pool } = s.archiveFor(LA, MERCHANT_A);
    const first = await archive.archiveArtifact(pdfRow(s.docA));
    // the same entry as the adapter: identity asserted, then the archive role, then the statement under test
    const tryOn = async (sql) => {
      const c = await pool.connect();
      try {
        await c.query('begin'); await c.query('set local role nordla_fin_archive_pilot');
        await c.query('select nordla_runtime.fin_pilot_assert_role($1::uuid, $2::text)', [MERCHANT_A, 'nordla_fin_archive_pilot']);
        await c.query(sql, [first.artifact.id]); await c.query('commit'); return 'allowed';
      } catch (e) { await c.query('rollback').catch(() => {}); return e.message; } finally { c.release(); }
    };
    assert.match(await tryOn('select * from public.fin_documents where id = $1'), /permission denied/);
    assert.match(await tryOn("update public.fin_artifacts set file_name = 'x' where id = $1"), /permission denied/);
    assert.match(await tryOn('delete from public.fin_artifacts where id = $1'), /permission denied/);
    assert.match(await tryOn('select 1 from public.fin_number_sequences where $1::uuid is not null'), /permission denied/);
  } finally { await s.cleanup(); }
});

test('seller profile versions: the same profile is a duplicate; a changed profile is a new version; both stay on the merchant', async () => {
  const s = await setup();
  try {
    const { archive } = s.archiveFor(LA, MERCHANT_A);
    const p1 = { name: 'Fictive A', vat: 'BE0000000000' };
    const v1 = await archive.recordSellerProfile({ profile: p1, sha256: sha(JSON.stringify(p1)), actor: null, at: '2026-11-20T10:00:00Z' });
    assert.equal(v1.duplicate, false);
    const again = await archive.recordSellerProfile({ profile: p1, sha256: sha(JSON.stringify(p1)), actor: null, at: '2026-11-20T10:01:00Z' });
    assert.equal(again.duplicate, true);
    assert.equal(again.version.version, v1.version.version);
    const p2 = { name: 'Fictive A bis', vat: 'BE0000000000' };
    const v2 = await archive.recordSellerProfile({ profile: p2, sha256: sha(JSON.stringify(p2)), actor: null, at: '2026-11-20T11:00:00Z' });
    assert.equal(v2.version.version, v1.version.version + 1);
    const rows = (await s.admin.query('select merchant_id from fin_seller_profile_versions')).rows.map((r) => r.merchant_id);
    assert.ok(rows.every((m) => m === MERCHANT_A), 'every version belongs to the merchant of the login');
  } finally { await s.cleanup(); }
});

test('recovery: the connection fails before the artifact is written; the retry writes it once, with no second original and no re-issue', async () => {
  const s = await setup();
  try {
    const first = s.archiveFor(LA, MERCHANT_A);
    await first.pool.end(); // the database connection is lost before the write
    assert.equal(await codeOf(() => first.archive.archiveArtifact(pdfRow(s.docA))), 'NARROW_CONNECTION_FAILED');
    const { archive } = s.archiveFor(LA, MERCHANT_A);
    const retried = await archive.archiveArtifact(pdfRow(s.docA));
    assert.equal(retried.duplicate, false, 'the first attempt wrote nothing, so the retry is the first write');
    const again = await archive.archiveArtifact(pdfRow(s.docA));
    assert.equal(again.duplicate, true);
    const count = (await s.admin.query('select count(*)::int n from fin_artifacts where document_id = $1', [s.docA.id])).rows[0].n;
    assert.equal(count, 1, 'no second original after the recovery');
    const docs = (await s.admin.query('select count(*)::int n from fin_documents where merchant_id = $1 and status = $2', [MERCHANT_A, 'ISSUED'])).rows[0].n;
    assert.equal(docs, 1, 'the document is not re-issued (still one issued document)');
  } finally { await s.cleanup(); }
});

test('integrity on read: the stored bytes are checked against the archived hash; a changed or missing object is reported, never hidden', async () => {
  const s = await setup();
  try {
    const { archive } = s.archiveFor(LA, MERCHANT_A);
    const bytes = 'pdf-A-integrity';
    const { artifact } = await archive.archiveArtifact(pdfRow(s.docA, bytes));
    const store = { ...archive, appendEvent: archive.appendEvent };
    const storage = (data) => ({ async put() {}, async get() { return data === null ? null : { data: Buffer.from(data) }; } });
    const ok = await createLegalArtifacts({ store, merchantId: MERCHANT_A, storage: storage(bytes), clock: { now: () => new Date() }, renderPdf: async () => Buffer.alloc(0) }).read(artifact.id);
    assert.equal(ok.verified, true);
    const bad = await createLegalArtifacts({ store, merchantId: MERCHANT_A, storage: storage('tampered'), clock: { now: () => new Date() }, renderPdf: async () => Buffer.alloc(0) }).read(artifact.id);
    assert.equal(bad.verified, false);
    assert.equal(bad.problem, 'HASH_MISMATCH');
    const missing = await createLegalArtifacts({ store, merchantId: MERCHANT_A, storage: storage(null), clock: { now: () => new Date() }, renderPdf: async () => Buffer.alloc(0) }).read(artifact.id);
    assert.equal(missing.problem, 'STORAGE_OBJECT_MISSING');
  } finally { await s.cleanup(); }
});
