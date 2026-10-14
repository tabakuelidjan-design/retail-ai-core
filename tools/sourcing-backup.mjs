#!/usr/bin/env node
// China Sourcing backup / verify / restore (the server's data directory: cases, workspace, Safety Gate cache). Scripted so it can run from cron
// on the hosted server and be TESTED; the copy is useful only if a restore has been tried (docs/infrastructure/nordla-cloud-plan.md §4).
//
//   node tools/sourcing-backup.mjs backup  <dataDir> <outDir> [--keep N]     writes <outDir>/sourcing-<UTC time>.nsb (encrypted), keeps the N newest (default 30)
//   node tools/sourcing-backup.mjs verify  <file.nsb>                         decrypts and checks every file's SHA-256; changes nothing
//   node tools/sourcing-backup.mjs restore <file.nsb> <targetDir>             verifies first, then writes into an EMPTY or new directory, then checks what it wrote
//
// SOURCING_BACKUP_PASSPHRASE (>= 16 characters) is required: archives are encrypted (scrypt -> AES-256-GCM; a wrong passphrase or any changed
// byte is refused, never half-restored). Keep the passphrase OFF the server too (password manager + paper): without it no archive can be read.
// A restore never overwrites: the target must be empty; the live directory is switched by the operator after checking the restored copy.
// Off-site, immutable copies (object lock, write-only key) are the operator's next step and stay an owner decision (provider/account).
import { createCipheriv, createDecipheriv, createHash, randomBytes, scryptSync } from 'node:crypto';
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
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
    else if (e.isFile() && !e.name.endsWith('.tmp')) yield full; // an interrupted atomic write is not data
  }
}

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
  return { created_at: doc.created_at, source: doc.source ?? null, files };
}

export async function backup(dataDir, outDir, { env = process.env, keep = 30, now = () => new Date() } = {}) {
  const passphrase = passphraseOf(env);
  const root = resolve(dataDir);
  try { if (!(await stat(root)).isDirectory()) throw new Error(); } catch { throw new BackupError('BACKUP_SOURCE_MISSING', `data directory not found: ${dataDir}`); }
  const files = [];
  for await (const full of walk(root)) { const data = await readFile(full); files.push({ path: relative(root, full).split(sep).join('/'), size: data.length, sha256: sha256(data), data: data.toString('base64') }); }
  const created_at = now().toISOString();
  const plain = gzipSync(Buffer.from(JSON.stringify({ format: FORMAT, version: VERSION, created_at, source: 'sourcing-data-dir', files })));
  await mkdir(outDir, { recursive: true });
  const name = `sourcing-${created_at.replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')}.nsb`;
  const file = join(outDir, name);
  await writeFile(`${file}.tmp`, seal(plain, passphrase));
  await readArchive(`${file}.tmp`, { env }); // a backup is kept only if it reads back
  await rename(`${file}.tmp`, file);
  const all = (await readdir(outDir)).filter((n) => /^sourcing-\d{8}T\d{6}Z\.nsb$/.test(n)).sort();
  const removed = all.slice(0, Math.max(0, all.length - keep));
  for (const n of removed) await rm(join(outDir, n));
  return { file, files: files.length, bytes: files.reduce((n, f) => n + f.size, 0), removed };
}

export async function verify(file, opts = {}) {
  const a = await readArchive(file, opts);
  return { ok: true, created_at: a.created_at, files: a.files.length, bytes: a.files.reduce((n, f) => n + f.size, 0) };
}

export async function restore(file, targetDir, opts = {}) {
  const a = await readArchive(file, opts); // nothing is written unless the whole archive is valid
  const target = resolve(targetDir);
  let existing = [];
  try { existing = await readdir(target); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  if (existing.length) throw new BackupError('RESTORE_TARGET_NOT_EMPTY', `restore target is not empty: ${targetDir} (a restore never overwrites)`);
  for (const f of a.files) { const out = join(target, ...f.path.split('/')); if (!out.startsWith(target + sep)) throw new BackupError('BACKUP_PATH_UNSAFE', f.path); await mkdir(dirname(out), { recursive: true }); await writeFile(out, f.data); }
  for (const f of a.files) { const back = await readFile(join(target, ...f.path.split('/'))); if (sha256(back) !== f.sha256) throw new BackupError('RESTORE_WRITE_MISMATCH', `written file differs: ${f.path}`); }
  return { ok: true, created_at: a.created_at, files: a.files.length, target };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [cmd, a, b] = process.argv.slice(2);
  const keepIx = process.argv.indexOf('--keep'); const keep = keepIx > 0 ? Number(process.argv[keepIx + 1]) : 30;
  try {
    let r;
    if (cmd === 'backup' && a && b) r = await backup(a, b, { keep: Number.isInteger(keep) && keep > 0 ? keep : 30 });
    else if (cmd === 'verify' && a) r = await verify(a);
    else if (cmd === 'restore' && a && b) r = await restore(a, b);
    else { console.error('usage: sourcing-backup.mjs backup <dataDir> <outDir> [--keep N] | verify <file.nsb> | restore <file.nsb> <emptyTargetDir>'); process.exit(2); }
    console.log(JSON.stringify(r));
  } catch (e) { console.error(`${e.code ?? 'ERROR'}: ${e.message}`); process.exit(1); }
}
