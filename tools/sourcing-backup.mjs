#!/usr/bin/env node
// China Sourcing backup / verify / restore (the server's data directory: cases, workspace, Safety Gate cache). Scripted so it can run from cron
// on the hosted server and be TESTED; the copy is useful only if a restore has been tried (docs/infrastructure/nordla-cloud-plan.md §4).
//
//   node tools/sourcing-backup.mjs backup  <dataDir> <outDir> [--keep N]     writes <outDir>/sourcing-<UTC time>.nsb (encrypted), keeps the N newest (default 30)
//   node tools/sourcing-backup.mjs verify  <file.nsb>                         decrypts and checks every file's SHA-256; changes nothing
//   node tools/sourcing-backup.mjs restore <file.nsb> <targetDir>             verifies first, then writes into an EMPTY or new directory, then checks what it wrote
//   node tools/sourcing-backup.mjs offsite <dataDir> <outDir> [--keep N]     backup, then copy the archive to the private bucket SOURCING_BACKUP_BUCKET (no overwrite)
//   node tools/sourcing-backup.mjs fetch   <archiveName> <outDir>            downloads one archive from that bucket and verifies it (then: restore)
//   node tools/sourcing-backup.mjs list                                       the archive names in that bucket, newest first
//   node tools/sourcing-backup.mjs drill   <downloadDir> <emptyTargetDir>     independent restore drill: newest off-server archive -> verify -> restore
//   node tools/sourcing-backup.mjs drill-isolated <downloadDir> <emptyDir>    the same on the isolated, immutable store (Backblaze B2, Object Lock)
//
// SOURCING_BACKUP_PASSPHRASE (>= 16 characters) is required: archives are encrypted (scrypt -> AES-256-GCM; a wrong passphrase or any changed
// byte is refused, never half-restored). Keep the passphrase OFF the server too (password manager + paper): without it no archive can be read.
// A restore never overwrites: the target must be empty; the live directory is switched by the operator after checking the restored copy.
// Off-site, immutable copies (object lock, write-only key) are the operator's next step and stay an owner decision (provider/account).
import { createCipheriv, createDecipheriv, createHash, randomBytes, scryptSync } from 'node:crypto';
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import { inspectJournalText, JournalError } from '../src/core-pilot/journal.js';
import { pathToFileURL } from 'node:url';

export class BackupError extends Error { constructor(code, message) { super(message); this.name = 'BackupError'; this.code = code; } }
const MAGIC = Buffer.from('NSB1'); const FORMAT = 'nordla-sourcing-backup'; const VERSION = 1;
const SCRYPT = { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const sha256 = (b) => createHash('sha256').update(b).digest('hex');

function passphraseOf(env) {
  const p = String(env.SOURCING_BACKUP_PASSPHRASE ?? '');
  if (p.length < 16) throw new BackupError('BACKUP_PASSPHRASE_REQUIRED', 'SOURCING_BACKUP_PASSPHRASE (at least 16 characters) is required: archives are always encrypted');
  return p;
}

async function* walk(root, dir = root) {
  for (const e of (await readdir(dir, { withFileTypes: true })).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const full = join(dir, e.name);
    if (e.isDirectory()) yield* walk(root, full);
    else if (e.isFile() && !e.name.endsWith('.tmp') && !e.name.endsWith('.lock')) yield full; // an interrupted atomic write and a writer lock are not data
  }
}

// ---- decision journal integrity. A backup that restores into a Core that refuses to start is not a backup, so the journal inside an archive is VERIFIED
// (hash chain, order, merchant) when the archive is made, when it is verified and before anything is restored. The live file is never touched.
const JOURNAL_FILE = /(^|\/)decision-journal\.jsonl$/;
/** [{ path, status: 'OK' | 'TORN_TAIL' | 'INCONSISTENT', events, head, code?, diagnostic?, message? }] for every decision journal among `files` ({ path, data: Buffer }). */
export function journalReport(files) {
  return files.filter((f) => JOURNAL_FILE.test(f.path)).map((f) => {
    try { const { events } = inspectJournalText(f.data.toString('utf8'), null); return { path: f.path, status: 'OK', events: events.length, head: events.at(-1)?.hash ?? null }; } catch (e) {
      if (!(e instanceof JournalError)) throw e;
      return { path: f.path, status: e.code === 'JOURNAL_TORN_TAIL' ? 'TORN_TAIL' : 'INCONSISTENT', code: e.code, diagnostic: e.diagnostic, message: e.message, details: e.details };
    }
  });
}
export const journalsRestorable = (report) => report.every((j) => j.status === 'OK');

function seal(plain, passphrase) {
  const salt = randomBytes(16); const iv = randomBytes(12);
  const key = scryptSync(passphrase, salt, 32, SCRYPT);
  const c = createCipheriv('aes-256-gcm', key, iv); const body = Buffer.concat([c.update(plain), c.final()]);
  return Buffer.concat([MAGIC, salt, iv, c.getAuthTag(), body]);
}
function open(sealed, passphrase) {
  if (sealed.length < 48 || !sealed.subarray(0, 4).equals(MAGIC)) throw new BackupError('BACKUP_NOT_AN_ARCHIVE', 'not a Nordla Sourcing backup');
  const salt = sealed.subarray(4, 20); const iv = sealed.subarray(20, 32); const tag = sealed.subarray(32, 48);
  const key = scryptSync(passphrase, salt, 32, SCRYPT);
  try { const d = createDecipheriv('aes-256-gcm', key, iv); d.setAuthTag(tag); return Buffer.concat([d.update(sealed.subarray(48)), d.final()]); }
  catch { throw new BackupError('BACKUP_DECRYPT_FAILED', 'wrong passphrase, or the archive was changed or damaged'); }
}

/** Reads and checks an archive. Returns { created_at, files: [{ path, size, sha256, data: Buffer }] } or throws BackupError. */
export async function readArchive(file, { env = process.env } = {}) {
  const doc = JSON.parse(gunzipSync(open(await readFile(file), passphraseOf(env))).toString('utf8'));
  if (doc.format !== FORMAT || doc.version !== VERSION || !Array.isArray(doc.files)) throw new BackupError('BACKUP_FORMAT_UNKNOWN', 'unknown backup format or version');
  const files = doc.files.map((f) => {
    if (typeof f.path !== 'string' || f.path.startsWith('/') || f.path.split('/').includes('..') || f.path.includes('\\')) throw new BackupError('BACKUP_PATH_UNSAFE', `unsafe path in archive: ${f.path}`);
    const data = Buffer.from(f.data, 'base64');
    if (data.length !== f.size || sha256(data) !== f.sha256) throw new BackupError('BACKUP_FILE_CORRUPT', `checksum mismatch: ${f.path}`);
    return { path: f.path, size: f.size, sha256: f.sha256, data };
  });
  return { created_at: doc.created_at, source: doc.source ?? null, files, adjustments: Array.isArray(doc.adjustments) ? doc.adjustments : [] };
}

export async function backup(dataDir, outDir, { env = process.env, keep = 30, now = () => new Date() } = {}) {
  const passphrase = passphraseOf(env);
  const root = resolve(dataDir);
  try { if (!(await stat(root)).isDirectory()) throw new Error(); } catch { throw new BackupError('BACKUP_SOURCE_MISSING', `data directory not found: ${dataDir}`); }
  const raw = [];
  for await (const full of walk(root)) raw.push({ path: relative(root, full).split(sep).join('/'), data: await readFile(full) });
  // a decision journal read while the server was appending can end with a half line: the COPY is cut back to its last whole event and the cut is recorded;
  // the live file is never modified. Any other damage is reported (restorable: false) and the archive is still made, so cases and photos are protected.
  const adjustments = [];
  for (const f of raw) {
    if (!JOURNAL_FILE.test(f.path)) continue;
    const [r] = journalReport([f]);
    if (r.status === 'TORN_TAIL') {
      const keep = r.details.complete_event ? Buffer.concat([f.data, Buffer.from('\n')]) : f.data.subarray(0, r.details.offset);
      adjustments.push({ path: f.path, kind: 'TORN_TAIL_TRIMMED_IN_COPY', removed_bytes: f.data.length - Math.min(f.data.length, keep.length), original_sha256: sha256(f.data), events_kept: r.details.valid_events });
      f.data = keep;
    }
  }
  const journals = journalReport(raw);
  const files = raw.map((f) => ({ path: f.path, size: f.data.length, sha256: sha256(f.data), data: f.data.toString('base64') }));
  const created_at = now().toISOString();
  const plain = gzipSync(Buffer.from(JSON.stringify({ format: FORMAT, version: VERSION, created_at, source: 'sourcing-data-dir', files, adjustments, journals })));
  await mkdir(outDir, { recursive: true });
  const name = `sourcing-${created_at.replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')}.nsb`;
  const file = join(outDir, name);
  await writeFile(`${file}.tmp`, seal(plain, passphrase));
  await readArchive(`${file}.tmp`, { env }); // a backup is kept only if it reads back
  await rename(`${file}.tmp`, file);
  const all = (await readdir(outDir)).filter((n) => /^sourcing-\d{8}T\d{6}Z\.nsb$/.test(n)).sort();
  const removed = all.slice(0, Math.max(0, all.length - keep));
  for (const n of removed) await rm(join(outDir, n));
  return { file, files: files.length, bytes: files.reduce((n, f) => n + f.size, 0), removed, journals, adjustments, restorable: journalsRestorable(journals) };
}

export async function verify(file, opts = {}) {
  const a = await readArchive(file, opts);
  const journals = journalReport(a.files);
  return { ok: journalsRestorable(journals), created_at: a.created_at, files: a.files.length, bytes: a.files.reduce((n, f) => n + f.size, 0), journals, adjustments: a.adjustments };
}

export async function restore(file, targetDir, opts = {}) {
  const a = await readArchive(file, opts); // nothing is written unless the whole archive is valid
  const journals = journalReport(a.files);
  if (!journalsRestorable(journals) && !opts.allowInconsistentJournal) throw new BackupError('RESTORE_JOURNAL_INCONSISTENT', `the archive holds a decision journal that does not verify (${journals.filter((j) => j.status !== 'OK').map((j) => `${j.path}: ${j.diagnostic ?? j.status}`).join('; ')}); it is not declared restorable`);
  const target = resolve(targetDir);
  let existing = [];
  try { existing = await readdir(target); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  if (existing.length) throw new BackupError('RESTORE_TARGET_NOT_EMPTY', `restore target is not empty: ${targetDir} (a restore never overwrites)`);
  for (const f of a.files) { const out = join(target, ...f.path.split('/')); if (!out.startsWith(target + sep)) throw new BackupError('BACKUP_PATH_UNSAFE', f.path); await mkdir(dirname(out), { recursive: true }); await writeFile(out, f.data); }
  for (const f of a.files) { const back = await readFile(join(target, ...f.path.split('/'))); if (sha256(back) !== f.sha256) throw new BackupError('RESTORE_WRITE_MISMATCH', `written file differs: ${f.path}`); }
  const after = journalReport(await Promise.all(a.files.filter((f) => JOURNAL_FILE.test(f.path)).map(async (f) => ({ path: f.path, data: await readFile(join(target, ...f.path.split('/'))) }))));
  if (!journalsRestorable(after) && !opts.allowInconsistentJournal) throw new BackupError('RESTORE_JOURNAL_INCONSISTENT', 'the restored journal does not verify');
  return { ok: true, created_at: a.created_at, files: a.files.length, target, journals: after, adjustments: a.adjustments };
}

// ---- off-server copy: a private Supabase Storage bucket (another provider than the Railway volume). Upload WITHOUT overwrite
// (x-upsert: false): an archive name that already exists is refused, never replaced. The archive is encrypted before it leaves.
// Not immutable against someone holding the service key (that needs object lock: an owner decision on provider / account).
const storageOf = (env) => {
  const url = String(env.SUPABASE_URL ?? '').replace(/\/+$/, ''); const key = String(env.SUPABASE_SERVICE_ROLE_KEY ?? ''); const bucket = String(env.SOURCING_BACKUP_BUCKET ?? '').trim();
  if (!url || !key || !/^[a-z0-9][a-z0-9_-]{2,62}$/.test(bucket)) throw new BackupError('OFFSITE_NOT_CONFIGURED', 'off-server copy needs SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY and SOURCING_BACKUP_BUCKET');
  return { base: `${url}/storage/v1/object/${bucket}`, list: `${url}/storage/v1/object/list/${bucket}`, headers: { authorization: `Bearer ${key}`, apikey: key } };
};
const ARCHIVE = /^sourcing-\d{8}T\d{6}Z\.nsb$/;

export async function uploadOffsite(file, { env = process.env, fetchImpl = fetch } = {}) {
  const name = basename(file); if (!ARCHIVE.test(name)) throw new BackupError('OFFSITE_NAME_INVALID', name);
  await readArchive(file, { env }); // only a readable archive leaves the server
  const { base, headers } = storageOf(env);
  const r = await fetchImpl(`${base}/${name}`, { method: 'POST', headers: { ...headers, 'content-type': 'application/octet-stream', 'x-upsert': 'false' }, body: await readFile(file) });
  if (!r.ok) throw new BackupError(r.status === 409 || r.status === 400 ? 'OFFSITE_EXISTS_OR_REFUSED' : 'OFFSITE_UPLOAD_FAILED', `upload of ${name} answered ${r.status}`);
  return { ok: true, name };
}

export async function downloadOffsite(name, outDir, { env = process.env, fetchImpl = fetch } = {}) {
  if (!ARCHIVE.test(name)) throw new BackupError('OFFSITE_NAME_INVALID', name);
  const { base, headers } = storageOf(env);
  const r = await fetchImpl(`${base}/${name}`, { headers });
  if (!r.ok) throw new BackupError('OFFSITE_DOWNLOAD_FAILED', `download of ${name} answered ${r.status}`);
  await mkdir(outDir, { recursive: true }); const file = join(outDir, name);
  await writeFile(file, Buffer.from(await r.arrayBuffer()));
  await readArchive(file, { env }); // a copy that does not decrypt / verify is reported at once
  return { ok: true, file };
}

/** The archive names in the bucket, newest first (names carry their UTC time). Only well-formed archive names are returned. */
export async function listOffsite({ env = process.env, fetchImpl = fetch } = {}) {
  const { list, headers } = storageOf(env);
  const r = await fetchImpl(list, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify({ prefix: '', limit: 1000, offset: 0, sortBy: { column: 'name', order: 'desc' } }) });
  if (!r.ok) throw new BackupError('OFFSITE_LIST_FAILED', `listing the bucket answered ${r.status}`);
  const rows = await r.json();
  return (Array.isArray(rows) ? rows : []).map((o) => String(o?.name ?? '')).filter((n) => ARCHIVE.test(n)).sort().reverse();
}

/** Independent restore drill (another machine than the server): the NEWEST off-server archive is downloaded, decrypted, verified and restored into an empty directory. */
export async function drillLatest(outDir, targetDir, opts = {}) {
  const names = await listOffsite(opts);
  if (!names.length) throw new BackupError('OFFSITE_EMPTY', 'the bucket holds no archive: there is nothing off-server to restore');
  const got = await downloadOffsite(names[0], outDir, opts);
  const r = await restore(got.file, targetDir, opts);
  return { ok: true, archive: names[0], archives_in_bucket: names.length, sha256: sha256(await readFile(got.file)), created_at: r.created_at, files: r.files, journals: r.journals.map((j) => ({ path: j.path, status: j.status, events: j.events ?? null })) };
}

// ---- ISOLATED, IMMUTABLE copy (optional, owner decision): a Backblaze B2 bucket with Object Lock and a DEFAULT retention in COMPLIANCE mode
// (set by the owner when creating the bucket). The server holds a key whose ONLY capability is writeFiles: it can add archives, never list,
// read, delete, shorten a retention or bypass it. A stolen server (or Supabase service key) therefore cannot erase this copy: compliance
// retention cannot be removed by anyone, the account owner included, before its date. The drill reads it with ANOTHER key (read-only,
// kept outside the server) and checks the retention of what it restores.
//   server : SOURCING_BACKUP_B2_KEY_ID, SOURCING_BACKUP_B2_KEY (writeFiles only), SOURCING_BACKUP_B2_BUCKET_ID
//   drill  : the same variables with a read key (listFiles, readFiles, readFileRetentions) + SOURCING_BACKUP_B2_BUCKET_NAME
const B2_API = 'https://api.backblazeb2.com';
const WRITER_CAPABILITIES = new Set(['writeFiles']);
export const isolatedConfigured = (env) => Boolean(String(env.SOURCING_BACKUP_B2_KEY_ID ?? '').trim() && String(env.SOURCING_BACKUP_B2_KEY ?? '').trim() && String(env.SOURCING_BACKUP_B2_BUCKET_ID ?? '').trim());
async function b2Authorize(env, fetchImpl) {
  const id = String(env.SOURCING_BACKUP_B2_KEY_ID ?? '').trim(); const key = String(env.SOURCING_BACKUP_B2_KEY ?? '').trim();
  if (!id || !key) throw new BackupError('ISOLATED_NOT_CONFIGURED', 'isolated copy needs SOURCING_BACKUP_B2_KEY_ID, SOURCING_BACKUP_B2_KEY and SOURCING_BACKUP_B2_BUCKET_ID');
  const r = await fetchImpl(`${B2_API}/b2api/v2/b2_authorize_account`, { headers: { authorization: `Basic ${Buffer.from(`${id}:${key}`).toString('base64')}` } });
  if (!r.ok) throw new BackupError('ISOLATED_AUTH_FAILED', `the isolated store refused the key (${r.status})`);
  const a = await r.json();
  return { apiUrl: a.apiUrl, downloadUrl: a.downloadUrl, token: a.authorizationToken, capabilities: Array.isArray(a.allowed?.capabilities) ? a.allowed.capabilities : [], allowedBucketId: a.allowed?.bucketId ?? null };
}
const b2Call = async (auth, fetchImpl, op, body) => {
  const r = await fetchImpl(`${auth.apiUrl}/b2api/v2/${op}`, { method: 'POST', headers: { authorization: auth.token, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  if (!r.ok) throw new BackupError('ISOLATED_CALL_FAILED', `${op} answered ${r.status}`);
  return r.json();
};

/** Adds one archive to the isolated store. Refuses a key that can do MORE than add files (least privilege is checked, not assumed). */
export async function uploadIsolated(file, { env = process.env, fetchImpl = fetch } = {}) {
  const name = basename(file); if (!ARCHIVE.test(name)) throw new BackupError('OFFSITE_NAME_INVALID', name);
  const bucketId = String(env.SOURCING_BACKUP_B2_BUCKET_ID ?? '').trim();
  await readArchive(file, { env }); // only a readable archive leaves the server
  const auth = await b2Authorize(env, fetchImpl);
  const extra = auth.capabilities.filter((c) => !WRITER_CAPABILITIES.has(c));
  if (extra.length) throw new BackupError('ISOLATED_KEY_TOO_POWERFUL', `the server's isolated-store key may also ${extra.join(', ')}: a stolen server could then alter the copy; give it writeFiles only`);
  if (auth.allowedBucketId && auth.allowedBucketId !== bucketId) throw new BackupError('ISOLATED_BUCKET_MISMATCH', 'the key is restricted to another bucket');
  const up = await b2Call(auth, fetchImpl, 'b2_get_upload_url', { bucketId });
  const data = await readFile(file);
  const r = await fetchImpl(up.uploadUrl, { method: 'POST', headers: { authorization: up.authorizationToken, 'x-bz-file-name': encodeURIComponent(name), 'content-type': 'application/octet-stream', 'x-bz-content-sha1': createHash('sha1').update(data).digest('hex') }, body: data });
  if (!r.ok) throw new BackupError('ISOLATED_UPLOAD_FAILED', `upload of ${name} to the isolated store answered ${r.status}`);
  return { ok: true, name };
}

/** Drill on the isolated store: newest archive -> download -> verify -> restore; reports its retention (compliance, until when). */
export async function drillIsolated(outDir, targetDir, { env = process.env, fetchImpl = fetch, now = () => Date.now() } = {}) {
  const bucketId = String(env.SOURCING_BACKUP_B2_BUCKET_ID ?? '').trim(); const bucketName = String(env.SOURCING_BACKUP_B2_BUCKET_NAME ?? '').trim();
  if (!bucketId || !/^[a-zA-Z0-9-]{6,63}$/.test(bucketName)) throw new BackupError('ISOLATED_NOT_CONFIGURED', 'the isolated drill needs SOURCING_BACKUP_B2_BUCKET_ID and SOURCING_BACKUP_B2_BUCKET_NAME');
  const auth = await b2Authorize(env, fetchImpl);
  const listed = await b2Call(auth, fetchImpl, 'b2_list_file_names', { bucketId, prefix: 'sourcing-', maxFileCount: 1000 });
  const files = (listed.files ?? []).filter((f) => ARCHIVE.test(f.fileName)).sort((a, b) => (a.fileName < b.fileName ? 1 : -1));
  if (!files.length) throw new BackupError('ISOLATED_EMPTY', 'the isolated store holds no archive');
  const newest = files[0];
  const info = await b2Call(auth, fetchImpl, 'b2_get_file_info', { fileId: newest.fileId });
  const ret = info.fileRetention?.value ?? null;
  const r = await fetchImpl(`${auth.downloadUrl}/file/${bucketName}/${encodeURIComponent(newest.fileName)}`, { headers: { authorization: auth.token } });
  if (!r.ok) throw new BackupError('ISOLATED_DOWNLOAD_FAILED', `download answered ${r.status}`);
  await mkdir(outDir, { recursive: true }); const local = join(outDir, newest.fileName); await writeFile(local, Buffer.from(await r.arrayBuffer()));
  const restored = await restore(local, targetDir, { env });
  const until = Number(ret?.retainUntilTimestamp ?? 0);
  return { ok: true, archive: newest.fileName, archives_in_store: files.length, sha256: sha256(await readFile(local)), files: restored.files, created_at: restored.created_at, retention: { mode: ret?.mode ?? null, retain_until: until ? new Date(until).toISOString() : null, locked_now: ret?.mode === 'compliance' && until > now() } };
}

/** One scheduled run on the hosted server: local encrypted archive (kept `keep`), then the off-server copy. */
export async function backupAndShip(dataDir, outDir, opts = {}) {
  const b = await backup(dataDir, outDir, opts);
  const u = await uploadOffsite(b.file, opts);
  const isolated = isolatedConfigured(opts.env ?? process.env) ? (await uploadIsolated(b.file, opts)).name : null; // a failure here fails the run: retried, alerted
  return { ...b, offsite: u.name, isolated };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [cmd, a, b] = process.argv.slice(2);
  const keepIx = process.argv.indexOf('--keep'); const keep = keepIx > 0 ? Number(process.argv[keepIx + 1]) : 30;
  try {
    let r;
    if (cmd === 'backup' && a && b) r = await backup(a, b, { keep: Number.isInteger(keep) && keep > 0 ? keep : 30 });
    else if (cmd === 'verify' && a) r = await verify(a);
    else if (cmd === 'restore' && a && b) r = await restore(a, b);
    else if (cmd === 'offsite' && a && b) r = await backupAndShip(a, b, { keep: Number.isInteger(keep) && keep > 0 ? keep : 30 });
    else if (cmd === 'fetch' && a && b) r = await downloadOffsite(a, b);
    else if (cmd === 'list') r = await listOffsite();
    else if (cmd === 'drill' && a && b) r = await drillLatest(a, b);
    else if (cmd === 'drill-isolated' && a && b) r = await drillIsolated(a, b);
    else { console.error('usage: sourcing-backup.mjs backup <dataDir> <outDir> [--keep N] | offsite <dataDir> <outDir> [--keep N] | fetch <archiveName> <outDir> | list | drill <downloadDir> <emptyTargetDir> | drill-isolated <downloadDir> <emptyTargetDir> | verify <file.nsb> | restore <file.nsb> <emptyTargetDir>'); process.exit(2); }
    console.log(JSON.stringify(r));
  } catch (e) { console.error(`${e.code ?? 'ERROR'}: ${e.message}`); process.exit(1); }
}
