// Belgium & Peppol on a real PostgreSQL 17: VCS/OGM in SQL == JavaScript, immutable artifacts, one original per document, unique payment reference, seller versions under concurrency,
// the Peppol message state machine (one claim, one message per document, guarded transitions), inbound deduplication, merchant isolation, concurrent issuance + references.
import { createHash } from 'node:crypto';
import { openMany, race, seedMerchants, issuedInvoice, insertDraft, issueDocument, attempt, codeOf, num, freshDatabase, MERCHANT_A, MERCHANT_B } from './lib/db.js';
import { control } from './lib/classify.js';
import { vcsGenerate, vcsValid, vcsForInvoiceNumber } from '../../src/finance/belgium-compliance.js';

const withDb = (fn) => async () => { const db = await freshDatabase(); const s = await db.open(); await seedMerchants(s); await s.end(); try { return await fn(db); } finally { await db.drop(); } };
const A = MERCHANT_A; const B = MERCHANT_B; const sha = (s) => createHash('sha256').update(String(s)).digest('hex');
const art = (m, doc, o = {}) => ({ sql: "insert into fin_artifacts (merchant_id, kind, classification, document_id, storage_ref, sha256, size_bytes, media_type, payment_reference, provenance) values ($1,$2,$3,$4,$5,$6,10,'application/pdf',$7,'{}') returning id",
  args: [m, o.kind ?? 'PDF_ORIGINAL', o.classification ?? 'ORIGINAL', doc, o.ref ?? `ref/${o.sha ?? 'x'}`, sha(o.sha ?? 'x'), o.vcs ?? null] });
const run = (c, q) => c.query(q.sql, q.args);
const enq = (c, m, doc, key, hash, state = 'QUEUED') => c.query('select fin_peppol_enqueue($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) r', [m, doc, key, hash, 'fake', state, null, '0208:0000000097', '0208:0000000196', 'BIS 3.0.21', null, '2026-10-03T10:00:00Z']);
const trans = (c, m, id, from, to, patch = {}) => c.query('select fin_peppol_transition($1,$2,$3,$4,$5,$6) r', [m, id, JSON.stringify(from), to, JSON.stringify(patch), '2026-10-03T10:00:00Z']);
const reg = (c, m, o) => c.query('select fin_peppol_inbound_register($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) r', [m, 'fake', o.pid ?? null, o.key, o.sha, 'scheme:sender', '0208:0000000097', o.business ?? null, null, '2026-10-03T10:00:00Z']);

// ===================================================== VCS in SQL == JS
control('VCS: fin_vcs_valid (SQL) agrees with the JavaScript rule on valid, invalid, remainder-0 -> 97, leading zeros and malformed values', withDb(async (d) => {
  const c = await d.open(); const out = [];
  try {
    const vectors = ['010806817183', '090933755493', '000000009797', '000000000101', '000000000100', '090933755494', '12345', 'abcdefghijkl', '', '0108068171830', vcsGenerate('1234567890'), vcsGenerate('97'), vcsGenerate('0'), vcsGenerate('194'), vcsGenerate('9999999999')];
    let mismatches = 0; for (const v of vectors) { const sql = (await c.query('select fin_vcs_valid($1) v', [v])).rows[0].v; if (sql !== vcsValid(v)) { mismatches++; out.push(`${v}: sql=${sql} js=${vcsValid(v)}`); } }
    for (let i = 0; i < 300; i++) { const base = String(Math.floor(Math.random() * 1e10)).padStart(10, '0'); const good = vcsGenerate(base); const bad = base + String((Number(good.slice(10)) % 97) + 1).padStart(2, '0'); for (const v of [good, bad]) if ((await c.query('select fin_vcs_valid($1) v', [v])).rows[0].v !== vcsValid(v)) mismatches++; }
    return { holds: mismatches === 0 && vcsGenerate('97') === '000000009797', evidence: `${vectors.length} fixed vectors and 600 random ones: ${mismatches} mismatch(es); 0000000097 -> check digits 97 in both` };
  } finally { await c.end(); }
}));

// ===================================================== ARTIFACTS
control('ARTIFACTS: immutable (no update but legal_hold, no delete), valid classification, valid and unique payment reference, cross-merchant refused', withDb(async (d) => {
  const c = await d.open(); const out = [];
  try {
    const invA = await issuedInvoice(c, A, 1000); const invA2 = await issuedInvoice(c, A, 2000); const invB = await issuedInvoice(c, B, 3000); const vcs = vcsForInvoiceNumber(invA.number);
    const id = (await run(c, art(A, invA.id, { sha: 'pdfA', vcs }))).rows[0].id;
    out.push((await attempt(c, "update fin_artifacts set sha256 = $2 where id = $1", [id, sha('other')])).code, (await attempt(c, "update fin_artifacts set size_bytes = 1 where id = $1", [id])).code, (await attempt(c, 'delete from fin_artifacts where id = $1', [id])).code);
    out.push((await attempt(c, 'update fin_artifacts set legal_hold = true where id = $1', [id])).ok ? 'legal_hold ok' : 'legal_hold refused');
    out.push((await attempt(c, art(A, invA2.id, { sha: 'p2', kind: 'PDF_ORIGINAL', classification: 'REGENERATED' }).sql, art(A, invA2.id, { sha: 'p2', kind: 'PDF_ORIGINAL', classification: 'REGENERATED' }).args)).code); // an original cannot be labelled regenerated
    out.push((await attempt(c, art(A, invA2.id, { sha: 'p3', vcs: '090933755494' }).sql, art(A, invA2.id, { sha: 'p3', vcs: '090933755494' }).args)).code); // invalid check digits
    out.push((await attempt(c, art(A, invA2.id, { sha: 'p4', vcs }).sql, art(A, invA2.id, { sha: 'p4', vcs }).args)).code); // the same reference on another document
    out.push((await attempt(c, art(A, invA2.id, { sha: 'p5', kind: 'STRUCTURED_ORIGINAL', vcs: vcsForInvoiceNumber(invA2.number) }).sql, art(A, invA2.id, { sha: 'p5', kind: 'STRUCTURED_ORIGINAL', vcs: vcsForInvoiceNumber(invA2.number) }).args)).code); // the reference lives on the PDF original only
    out.push((await attempt(c, art(B, invA.id, { sha: 'x1' }).sql, art(B, invA.id, { sha: 'x1' }).args)).code); // merchant B on A's document
    out.push((await attempt(c, art(A, invB.id, { sha: 'x2' }).sql, art(A, invB.id, { sha: 'x2' }).args)).code);
    out.push((await attempt(c, "insert into fin_artifacts (merchant_id, kind, classification, storage_ref, sha256, size_bytes, media_type) values ($1,'PDF_ORIGINAL','ORIGINAL','r',$2,1,'application/pdf')", [A, sha('o')])).code); // no owner
    const expect = ['FIN_ARTIFACTS_ARE_IMMUTABLE', 'FIN_ARTIFACTS_ARE_IMMUTABLE', 'FIN_ARTIFACTS_ARE_IMMUTABLE', 'legal_hold ok', 'fin_artifacts_original_has_class', 'fin_artifacts_vcs_valid', 'fin_artifacts_payment_reference_uq', 'fin_artifacts_vcs_only_pdf_original', 'fin_artifacts_document_fk', 'fin_artifacts_document_fk', 'fin_artifacts_owner'];
    return { holds: out.join() === expect.join(), evidence: out.join(' / ') };
  } finally { await c.end(); }
}));

control('ARTIFACTS concurrency: eight workers archive the same issued document -> exactly ONE original PDF and ONE structured original, whatever the bytes', withDb(async (d) => {
  const s = await d.open(); const inv = await issuedInvoice(s, A, 5000); await s.end(); const { clients, closeAll } = await openMany(d.name, 8);
  try {
    const vcs = vcsForInvoiceNumber(inv.number);
    const same = await race(clients, (c) => run(c, art(A, inv.id, { sha: 'same-bytes', vcs })));
    const differing = await race(clients, (c, i) => run(c, art(A, inv.id, { sha: `bytes-${i}`, kind: 'STRUCTURED_ORIGINAL' })));
    const pdfs = await num(clients[0], "select count(*) s from fin_artifacts where kind='PDF_ORIGINAL' and document_id=$1", [inv.id]); const xml = await num(clients[0], "select count(*) s from fin_artifacts where kind='STRUCTURED_ORIGINAL' and document_id=$1", [inv.id]);
    return { holds: pdfs === 1 && xml === 1 && same.filter((r) => r.status === 'fulfilled').length === 1 && differing.filter((r) => r.status === 'fulfilled').length === 1, evidence: `PDF originals=${pdfs} (accepted ${same.filter((r) => r.status === 'fulfilled').length}/8), structured originals=${xml} (accepted ${differing.filter((r) => r.status === 'fulfilled').length}/8); losers: ${[...new Set([...same, ...differing].map(codeOf))].join('|')}` };
  } finally { await closeAll(); }
}));

control('ISSUANCE + REFERENCES: eight concurrent issuances get distinct consecutive numbers and eight distinct, valid payment references', withDb(async (d) => {
  const s = await d.open(); const drafts = []; for (let i = 0; i < 8; i++) drafts.push(await insertDraft(s, A, { gross: 1000 + i })); await s.end(); const { clients, closeAll } = await openMany(d.name, 8);
  try {
    const res = await race(clients, (c, i) => issueDocument(c, A, drafts[i]));
    const issued = res.filter((r) => r.status === 'fulfilled').map((r) => r.value); const numbers = issued.map((x) => x.number).sort();
    const refs = issued.map((x) => vcsForInvoiceNumber(x.number));
    const ins = await race(clients, (c, i) => run(c, art(A, issued[i].id, { sha: `pdf-${i}`, vcs: refs[i] })));
    const stored = await num(clients[0], "select count(distinct payment_reference) s from fin_artifacts where payment_reference is not null");
    return { holds: issued.length === 8 && new Set(numbers).size === 8 && new Set(refs).size === 8 && refs.every(vcsValid) && ins.every((r) => r.status === 'fulfilled') && stored === 8, evidence: `numbers ${numbers[0]}..${numbers[7]}, ${new Set(refs).size} distinct references, ${stored} stored, all valid` };
  } finally { await closeAll(); }
}));

// ===================================================== SELLER PROFILE VERSIONS
control('SELLER PROFILE: eight concurrent recordings of two profiles -> exactly versions 1 and 2, same content = same version, append-only, isolated per merchant', withDb(async (d) => {
  const { clients, closeAll } = await openMany(d.name, 8);
  try {
    const rec = (c, m, p, h) => c.query('select fin_seller_profile_record($1,$2,$3,$4,$5) r', [m, JSON.stringify(p), h, '{}', '2026-10-03T10:00:00Z']);
    const P1 = { name: 'Seller v1' }; const P2 = { name: 'Seller v2' };
    const res = await race(clients, (c, i) => rec(c, A, i % 2 ? P1 : P2, sha(i % 2 ? 'p1' : 'p2')));
    const versions = (await clients[0].query('select version, profile_sha256 from fin_seller_profile_versions where merchant_id=$1 order by version', [A])).rows;
    const again = (await rec(clients[0], A, P1, sha('p1'))).rows[0].r; const b = (await rec(clients[0], B, P1, sha('p1'))).rows[0].r;
    const upd = await attempt(clients[0], "update fin_seller_profile_versions set profile = '{}' where merchant_id=$1", [A]); const del = await attempt(clients[0], 'delete from fin_seller_profile_versions where merchant_id=$1', [A]);
    return { holds: res.every((r) => r.status === 'fulfilled') && versions.length === 2 && versions.map((v) => v.version).join() === '1,2' && again.duplicate === true && b.duplicate === false && b.version.version === 1 && upd.code === 'FIN_SELLER_PROFILE_VERSIONS_ARE_APPEND_ONLY' && del.code === 'FIN_SELLER_PROFILE_VERSIONS_ARE_APPEND_ONLY',
      evidence: `versions=${versions.map((v) => v.version)}; replay duplicate=${again.duplicate}; merchant B starts at version ${b.version.version}; update/delete -> ${upd.code}` };
  } finally { await closeAll(); }
}));

// ===================================================== PEPPOL MESSAGES
control('PEPPOL idempotency: eight simultaneous enqueues of one document -> ONE message; other bytes for the same document are refused; eight simultaneous claims -> exactly ONE', withDb(async (d) => {
  const s = await d.open(); const inv = await issuedInvoice(s, A, 5000); await s.end(); const { clients, closeAll } = await openMany(d.name, 8);
  try {
    const h = sha('ubl-1'); const res = await race(clients, (c, i) => enq(c, A, inv.id, `peppol-out:${inv.id}`.slice(0, 60) + (i % 2 ? '' : ''), h));
    const msgs = await num(clients[0], "select count(*) s from fin_peppol_messages where document_id=$1 and direction='OUT'", [inv.id]); const fresh = res.filter((r) => r.status === 'fulfilled' && r.value.rows[0].r.duplicate === false).length;
    const other = await attempt(clients[0], 'select fin_peppol_enqueue($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)', [A, inv.id, 'peppol-out:another-key', sha('ubl-2'), 'fake', 'QUEUED', null, null, null, null, null, null]);
    const id = (await clients[0].query('select id from fin_peppol_messages where document_id=$1', [inv.id])).rows[0].id;
    const claims = await race(clients, (c) => trans(c, A, id, ['QUEUED'], 'SUBMITTING')); const changed = claims.filter((r) => r.status === 'fulfilled' && r.value.rows[0].r.changed === true).length;
    const row = (await clients[0].query('select state, attempts from fin_peppol_messages where id=$1', [id])).rows[0];
    return { holds: msgs === 1 && fresh === 1 && res.every((r) => r.status === 'fulfilled') && other.code === 'FIN_PEPPOL_DOCUMENT_CHANGED' && changed === 1 && row.state === 'SUBMITTING' && row.attempts === 1, evidence: `messages=${msgs} (fresh ${fresh}/8), other bytes -> ${other.code}; claims changed=${changed}/8, attempts=${row.attempts}, state=${row.state}` };
  } finally { await closeAll(); }
}));

control('PEPPOL state machine: only the declared transitions; HTTP-style acceptance is SUBMITTED not DELIVERED; terminal states stay; identity immutable; no delete', withDb(async (d) => {
  const c = await d.open(); const out = [];
  try {
    const inv = await issuedInvoice(c, A, 1000); const m = (await enq(c, A, inv.id, 'peppol-out:sm-1', sha('x'))).rows[0].r.message; const id = m.id;
    out.push((await attempt(c, "update fin_peppol_messages set state='DELIVERED' where id=$1", [id])).code); // QUEUED -> DELIVERED directly
    out.push((await attempt(c, "update fin_peppol_messages set state='SUBMITTED' where id=$1", [id])).code); // QUEUED -> SUBMITTED directly
    await trans(c, A, id, ['QUEUED'], 'SUBMITTING'); const ok = (await trans(c, A, id, ['SUBMITTING'], 'SUBMITTED', { providerMessageId: 'pm-1' })).rows[0].r;
    out.push(ok.changed && ok.message.state === 'SUBMITTED' && ok.message.provider_message_id === 'pm-1' ? 'submitted' : 'BAD');
    out.push((await trans(c, A, id, ['SUBMITTING'], 'SUBMITTED')).rows[0].r.changed === false ? 'stale transition ignored' : 'BAD'); // compare-and-set: a late duplicate does nothing
    out.push((await attempt(c, "update fin_peppol_messages set state='QUEUED' where id=$1", [id])).code); // no way back from SUBMITTED
    await trans(c, A, id, ['SUBMITTED'], 'DELIVERED'); out.push((await attempt(c, "update fin_peppol_messages set state='DELIVERY_FAILED' where id=$1", [id])).code); // DELIVERED is final
    out.push((await attempt(c, "update fin_peppol_messages set document_sha256=$2 where id=$1", [id, sha('y')])).code, (await attempt(c, "update fin_peppol_messages set idempotency_key='peppol-out:changed-1' where id=$1", [id])).code, (await attempt(c, 'delete from fin_peppol_messages where id=$1', [id])).code);
    const inv2 = await issuedInvoice(c, A, 2000); const f = (await enq(c, A, inv2.id, 'peppol-out:sm-2', sha('z'), 'VALIDATION_FAILED')).rows[0].r.message; out.push((await attempt(c, "update fin_peppol_messages set state='QUEUED' where id=$1", [f.id])).code); // a failed validation is never queued
    out.push((await attempt(c, 'select fin_peppol_enqueue($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)', [A, (await issuedInvoice(c, A, 3000)).id, 'peppol-out:sm-3', sha('w'), 'fake', 'DELIVERED', null, null, null, null, null, null])).code); // cannot be created already delivered
    const expect = ['FIN_PEPPOL_INVALID_TRANSITION', 'FIN_PEPPOL_INVALID_TRANSITION', 'submitted', 'stale transition ignored', 'FIN_PEPPOL_INVALID_TRANSITION', 'FIN_PEPPOL_INVALID_TRANSITION', 'FIN_PEPPOL_MESSAGE_IDENTITY_IS_IMMUTABLE', 'FIN_PEPPOL_MESSAGE_IDENTITY_IS_IMMUTABLE', 'FIN_PEPPOL_MESSAGES_ARE_NOT_DELETABLE', 'FIN_PEPPOL_INVALID_TRANSITION', 'FIN_PEPPOL_INVALID_INITIAL_STATE'];
    return { holds: out.join() === expect.join(), evidence: out.join(' / ') };
  } finally { await c.end(); }
}));

control('INBOUND dedup: eight workers register the same message (webhook + polling + provider retry) -> ONE message; same bytes under another transport id and the same business document under other bytes are DUPLICATE', withDb(async (d) => {
  const { clients, closeAll } = await openMany(d.name, 8);
  try {
    const h = sha('invoice-xml'); const res = await race(clients, (c, i) => reg(c, A, { pid: 'prov-1', key: `peppol-in:fake:prov-1${i % 2 ? '' : ''}`, sha: h, business: '0208:0000000196|F-1|2026-09-01' }));
    const base = await num(clients[0], "select count(*) s from fin_peppol_messages where direction='IN' and state <> 'DUPLICATE'", []); const fresh = res.filter((r) => r.status === 'fulfilled' && r.value.rows[0].r.duplicate === false).length;
    const sameBytesNewTransport = (await reg(clients[0], A, { pid: 'prov-2', key: 'peppol-in:fake:prov-2', sha: h, business: null })).rows[0].r;
    const businessDup = (await reg(clients[0], A, { pid: 'prov-3', key: 'peppol-in:fake:prov-3', sha: sha('other-bytes'), business: '0208:0000000196|F-1|2026-09-01' })).rows[0].r;
    const different = (await reg(clients[0], A, { pid: 'prov-4', key: 'peppol-in:fake:prov-4', sha: sha('another'), business: '0208:0000000196|F-2|2026-09-01' })).rows[0].r;
    const realCount = await num(clients[0], "select count(*) s from fin_peppol_messages where direction='IN' and state <> 'DUPLICATE'", []);
    return { holds: base === 1 && fresh === 1 && res.every((r) => r.status === 'fulfilled') && sameBytesNewTransport.duplicate && businessDup.duplicate && businessDup.message.state === 'DUPLICATE' && businessDup.message.duplicate_of === businessDup.first.id && !different.duplicate && realCount === 2,
      evidence: `8 registrations -> ${base} message (fresh ${fresh}); same bytes new transport duplicate=${sameBytesNewTransport.duplicate}; business duplicate state=${businessDup.message.state}; a different invoice is its own message (${realCount} real messages)` };
  } finally { await closeAll(); }
}));

control('ISOLATION: merchant B cannot queue, move, read through the RPCs or share the dedup scope of merchant A; identical inbound bytes are independent per merchant', withDb(async (d) => {
  const c = await d.open(); const out = [];
  try {
    const invA = await issuedInvoice(c, A, 1000); const mA = (await enq(c, A, invA.id, 'peppol-out:iso-a1', sha('a'))).rows[0].r.message;
    out.push((await attempt(c, 'select fin_peppol_enqueue($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)', [B, invA.id, 'peppol-out:iso-b1', sha('a'), 'fake', 'QUEUED', null, null, null, null, null, null])).code); // B queues A's document
    out.push((await attempt(c, 'select fin_peppol_transition($1,$2,$3,$4,$5,$6)', [B, mA.id, '["QUEUED"]', 'SUBMITTING', '{}', null])).code); // B moves A's message
    const inA = (await reg(c, A, { pid: 'p1', key: 'peppol-in:fake:iso-1', sha: sha('same-xml') })).rows[0].r; const inB = (await reg(c, B, { pid: 'p1', key: 'peppol-in:fake:iso-1', sha: sha('same-xml') })).rows[0].r;
    out.push(!inA.duplicate && !inB.duplicate ? 'independent' : 'SHARED');
    const sellerB = (await c.query('select fin_seller_profile_record($1,$2,$3,$4,$5) r', [B, '{}', sha('prof'), '{}', null])).rows[0].r; out.push(sellerB.version.version === 1 ? 'versions per merchant' : 'BAD');
    const counts = [await num(c, "select count(*) s from fin_peppol_messages where merchant_id=$1", [A]), await num(c, "select count(*) s from fin_peppol_messages where merchant_id=$1", [B])];
    return { holds: out[0] === 'fin_peppol_messages_document_fk' && out[1] === 'FIN_PEPPOL_MESSAGE_NOT_FOUND' && out[2] === 'independent' && out[3] === 'versions per merchant' && counts.join() === '2,1', evidence: `${out.join(' / ')}; messages A=${counts[0]} B=${counts[1]}` };
  } finally { await c.end(); }
}));

control('PERMISSIONS: anon and authenticated can read or call nothing of the legal tables and RPCs; service_role can', withDb(async (d) => {
  const c = await d.open(); const out = [];
  try {
    const inv = await issuedInvoice(c, A, 1000);
    for (const role of ['anon', 'authenticated']) { await c.query(`set role ${role}`); for (const t of ['fin_artifacts', 'fin_peppol_messages', 'fin_seller_profile_versions']) out.push(`${role}:${t}=${(await attempt(c, `select * from ${t}`)).ok ? 'ALLOWED' : 'refused'}`); out.push(`${role}:rpc=${(await attempt(c, 'select fin_peppol_enqueue($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)', [A, inv.id, 'peppol-out:perm-1', sha('p'), 'fake', 'QUEUED', null, null, null, null, null, null])).ok ? 'ALLOWED' : 'refused'}`); await c.query('reset role'); }
    await c.query('set role service_role'); const ok = await attempt(c, 'select fin_peppol_enqueue($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)', [A, inv.id, 'peppol-out:perm-2', sha('p'), 'fake', 'QUEUED', null, null, null, null, null, null]); await c.query('reset role');
    return { holds: out.every((x) => x.endsWith('refused')) && ok.ok, evidence: `${out.join(', ')}, service_role:rpc=${ok.ok ? 'allowed' : ok.code}` };
  } finally { await c.end(); }
}));
