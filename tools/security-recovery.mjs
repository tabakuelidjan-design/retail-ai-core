// Complete database + original-file recovery bundle. No plaintext database dump is written to disk.
// capture <new-directory>: requires NORDLA_BACKUP_DATABASE_URL and NORDLA_RECOVERY_PASSPHRASE.
// verify <bundle>: authenticates every record before a restore can start.
// restore <bundle> <empty-files-directory>: ONLY a new, empty loopback PostgreSQL drill database.
import { randomBytes, scryptSync, createCipheriv, createDecipheriv, createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, readdir, lstat } from 'node:fs/promises';
import { resolve, join, sep, isAbsolute } from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const LIMIT = 256 * 1024 * 1024;
const MAX_FILES = 50000;
const MAX_TOTAL = 512 * 1024 * 1024;
const hash = (data) => createHash('sha256').update(data).digest('hex');
export class RecoveryError extends Error {
  constructor(code) { super(code); this.name = 'RecoveryError'; this.code = code; }
}
const fail = (code) => { throw new RecoveryError(code); };
function safePath(value) {
  if (typeof value !== 'string' || !value || isAbsolute(value) || /[\\:\u0000-\u001f]/.test(value) || value.split('/').some(p => !p || p === '.' || p === '..')) fail('RECOVERY_PATH_UNSAFE');
  return value;
}
function keyOf(passphrase, salt) {
  if (typeof passphrase !== 'string' || passphrase.length < 24) fail('RECOVERY_PASSPHRASE_REQUIRED');
  return scryptSync(passphrase, salt, 32);
}
function seal(data, key, name) {
  const iv = randomBytes(12); const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(name));
  return Buffer.concat([iv, cipher.update(data), cipher.final(), cipher.getAuthTag()]);
}
function open(data, key, name) {
  if (data.length < 28 || data.length > LIMIT + 28) fail('RECOVERY_RECORD_INVALID');
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, data.subarray(0, 12));
    decipher.setAAD(Buffer.from(name)); decipher.setAuthTag(data.subarray(-16));
    return Buffer.concat([decipher.update(data.subarray(12, -16)), decipher.final()]);
  } catch { fail('RECOVERY_AUTHENTICATION_FAILED'); }
}
async function emptyDirectory(path, create = false) {
  let entries;
  try { const info = await lstat(path); if (info.isSymbolicLink() || !info.isDirectory()) fail('RECOVERY_TARGET_UNSAFE'); entries = await readdir(path); } catch (e) { if (e.code !== 'ENOENT') throw e; entries = []; if (create) await mkdir(path, { recursive: true, mode: 0o700 }); }
  if (entries.length) fail('RECOVERY_TARGET_NOT_EMPTY');
}
async function recordFile(root, name) {
  if (!/^(manifest|record-\d{6})\.enc$/.test(name)) fail('RECOVERY_RECORD_INVALID');
  const path = join(root, name); const info = await lstat(path);
  if (info.isSymbolicLink() || !info.isFile() || info.size > LIMIT + 28) fail('RECOVERY_RECORD_TOO_LARGE');
  return readFile(path);
}

export async function createBundle({ directory, passphrase, database, files = [], createdAt = new Date().toISOString() }) {
  if (!Buffer.isBuffer(database) || database.subarray(0, 5).toString() !== 'PGDMP') fail('RECOVERY_DATABASE_DUMP_REQUIRED');
  if (database.length > LIMIT || files.length > MAX_FILES) fail('RECOVERY_LIMIT_EXCEEDED');
  const root = resolve(directory); await emptyDirectory(root, true);
  const salt = randomBytes(32); const key = keyOf(passphrase, salt);
  const records = []; const paths = new Set(); let total = 0;
  const add = async (kind, path, data) => {
    if (!Buffer.isBuffer(data) || data.length > LIMIT || (total += data.length) > MAX_TOTAL) fail('RECOVERY_LIMIT_EXCEEDED');
    safePath(path); if (paths.has(path)) fail('RECOVERY_DUPLICATE_PATH'); paths.add(path);
    const record = 'record-' + String(records.length).padStart(6, '0') + '.enc';
    await writeFile(join(root, record), seal(data, key, record), { flag: 'wx', mode: 0o600 });
    records.push({ kind, path, record, bytes: data.length, sha256: hash(data) });
  };
  try {
    await add('database', 'database.dump', database);
    for (const file of files) await add('file', file.path, file.data);
    const manifest = Buffer.from(JSON.stringify({ version: 1, createdAt, records }));
    const encryptedManifest = seal(manifest, key, 'manifest.enc');
    await writeFile(join(root, 'manifest.enc'), encryptedManifest, { flag: 'wx', mode: 0o600 });
    // Written last: a partial capture never looks like a complete bundle.
    await writeFile(join(root, 'bundle.json'), JSON.stringify({ version: 1, salt: salt.toString('base64'), manifestSha256: hash(encryptedManifest) }), { flag: 'wx', mode: 0o600 });
    return { ok: true, files: files.length, bytes: total, manifestSha256: hash(encryptedManifest) };
  } finally { key.fill(0); }
}

export async function verifyBundle({ directory, passphrase }) {
  const root = resolve(directory); const descriptor = JSON.parse(await readFile(join(root, 'bundle.json'), 'utf8'));
  if (descriptor.version !== 1 || typeof descriptor.salt !== 'string') fail('RECOVERY_FORMAT_INVALID');
  const salt = Buffer.from(descriptor.salt, 'base64'); if (salt.length !== 32) fail('RECOVERY_FORMAT_INVALID');
  const key = keyOf(passphrase, salt);
  try {
    const encrypted = await recordFile(root, 'manifest.enc');
    if (hash(encrypted) !== descriptor.manifestSha256) fail('RECOVERY_MANIFEST_CHANGED');
    const manifest = JSON.parse(open(encrypted, key, 'manifest.enc').toString('utf8'));
    if (manifest.version !== 1 || !Array.isArray(manifest.records) || manifest.records.length > MAX_FILES + 1) fail('RECOVERY_FORMAT_INVALID');
    const names = new Set(); let databases = 0; let total = 0;
    for (const record of manifest.records) {
      safePath(record.path);
      if (names.has(record.path) || !['database', 'file'].includes(record.kind)) fail('RECOVERY_FORMAT_INVALID'); names.add(record.path);
      const plain = open(await recordFile(root, record.record), key, record.record);
      if (plain.length !== record.bytes || hash(plain) !== record.sha256 || (total += plain.length) > MAX_TOTAL) fail('RECOVERY_CONTENT_CHANGED');
      if (record.kind === 'database') { databases++; if (plain.subarray(0, 5).toString() !== 'PGDMP') fail('RECOVERY_DATABASE_DUMP_REQUIRED'); }
    }
    if (databases !== 1) fail('RECOVERY_DATABASE_DUMP_REQUIRED');
    return { ok: true, manifest, bytes: total, files: manifest.records.length - 1, manifestSha256: descriptor.manifestSha256 };
  } finally { key.fill(0); }
}

export async function restoreBundle({ directory, passphrase, targetDirectory, restoreDatabase }) {
  if (typeof restoreDatabase !== 'function') fail('RECOVERY_DATABASE_RESTORE_REQUIRED');
  const verified = await verifyBundle({ directory, passphrase }); // verify ALL files before ANY side effect
  const root = resolve(directory); const target = resolve(targetDirectory); await emptyDirectory(target);
  const descriptor = JSON.parse(await readFile(join(root, 'bundle.json'), 'utf8'));
  const key = keyOf(passphrase, Buffer.from(descriptor.salt, 'base64'));
  try {
    const database = verified.manifest.records.find(r => r.kind === 'database');
    await restoreDatabase(open(await recordFile(root, database.record), key, database.record));
    await mkdir(target, { recursive: true, mode: 0o700 });
    for (const record of verified.manifest.records.filter(r => r.kind === 'file')) {
      const file = resolve(target, ...record.path.split('/')); if (!file.startsWith(target + sep)) fail('RECOVERY_PATH_UNSAFE');
      await mkdir(resolve(file, '..'), { recursive: true, mode: 0o700 });
      const data = open(await recordFile(root, record.record), key, record.record);
      await writeFile(file, data, { flag: 'wx', mode: 0o600 });
      if (hash(await readFile(file)) !== record.sha256) fail('RECOVERY_WRITE_MISMATCH');
    }
    return { ok: true, files: verified.files, bytes: verified.bytes, manifestSha256: verified.manifestSha256 };
  } finally { key.fill(0); }
}

function databaseEnvironment(connection, env, restore = false) {
  let url; try { url = new URL(connection); } catch { fail('RECOVERY_DATABASE_CONNECTION_REQUIRED'); }
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !url.username || !url.hostname || !url.pathname.slice(1)) fail('RECOVERY_DATABASE_CONNECTION_REQUIRED');
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (restore && (!local || env.NORDLA_RECOVERY_LOCAL_DRILL !== '1' || !/^nordla_recovery_[a-z0-9_]+$/.test(url.pathname.slice(1)))) fail('RECOVERY_REMOTE_RESTORE_REFUSED');
  const sslmode = local ? 'disable' : 'verify-full';
  if (!local && url.searchParams.has('sslmode') && url.searchParams.get('sslmode') !== 'verify-full') fail('RECOVERY_TLS_REQUIRED');
  const allowed = ['PATH', 'SystemRoot', 'WINDIR', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP', 'LD_LIBRARY_PATH'];
  return { ...Object.fromEntries(allowed.filter(k => env[k]).map(k => [k, env[k]])),
    PGHOST: url.hostname.replace(/^\[|\]$/g,''), PGPORT: url.port || '5432', PGDATABASE: decodeURIComponent(url.pathname.slice(1)),
    PGUSER: decodeURIComponent(url.username), PGPASSWORD: decodeURIComponent(url.password), PGSSLMODE: sslmode,
    ...(local ? {} : { PGSSLROOTCERT: env.NORDLA_PGSSLROOTCERT || 'system' }),
    PGCONNECT_TIMEOUT: '15', PGOPTIONS: '-c statement_timeout=300000' };
}
function pgCommand(binary, args, env, input) {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { env, windowsHide: true, stdio: ['pipe','pipe','pipe'] });
    const chunks = []; let size = 0; let rejected = false;
    const timer = setTimeout(() => { rejected = true; child.kill(); reject(new RecoveryError('RECOVERY_COMMAND_TIMEOUT')); }, 300000);
    child.stdout.on('data', b => { size += b.length; if (size > LIMIT) { rejected = true; child.kill(); reject(new RecoveryError('RECOVERY_LIMIT_EXCEEDED')); } else chunks.push(b); });
    child.stderr.on('data', () => {}); // upstream text may contain credentials: never return it
    child.on('error', () => { clearTimeout(timer); if (!rejected) reject(new RecoveryError('RECOVERY_PG_BINARY_UNAVAILABLE')); });
    child.on('close', code => { clearTimeout(timer); if (rejected) return; code === 0 ? resolve(Buffer.concat(chunks)) : reject(new RecoveryError('RECOVERY_PG_COMMAND_FAILED')); });
    child.stdin.on('error', () => {}); child.stdin.end(input);
  });
}
export async function dumpDatabase({ connection, env = process.env }) {
  return pgCommand(env.NORDLA_PG_DUMP || 'pg_dump', ['--format=custom','--no-password','--lock-wait-timeout=10000'], databaseEnvironment(connection, env));
}
export async function restoreDrillDatabase({ connection, data, env = process.env }) {
  const pgEnv = databaseEnvironment(connection, env, true);
  const check = await pgCommand(env.NORDLA_PSQL || 'psql', ['--no-password','-At','-c', "select count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname not in ('pg_catalog','information_schema') and n.nspname not like 'pg_%' and c.relkind in ('r','p','v','m')"], pgEnv);
  if (check.toString().trim() !== '0') fail('RECOVERY_DATABASE_NOT_EMPTY');
  await pgCommand(env.NORDLA_PG_RESTORE || 'pg_restore', ['--no-password','--exit-on-error','--single-transaction','--no-owner','--dbname',pgEnv.PGDATABASE], pgEnv, data);
}

export async function captureStorage({ url, key, buckets = ['finance-inbox'], fetchImpl = fetch }) {
  if (!url || !key) fail('RECOVERY_STORAGE_CONFIGURATION_REQUIRED');
  const headers = { apikey: key, Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' };
  const files = []; let total = 0;
  for (const bucket of buckets) {
    if (!/^[a-z0-9][a-z0-9_-]{0,62}$/.test(bucket)) fail('RECOVERY_STORAGE_BUCKET_INVALID');
    const visit = async (prefix = '', depth = 0) => {
      if (depth > 16) fail('RECOVERY_STORAGE_DEPTH_EXCEEDED');
      for (let offset = 0; ; offset += 1000) {
        const listed = await fetchImpl(url.replace(/\/$/,'')+'/storage/v1/object/list/'+bucket, { method:'POST', headers, body:JSON.stringify({prefix,offset,limit:1000,sortBy:{column:'name',order:'asc'}}), signal:AbortSignal.timeout(30000) });
        if (!listed.ok) fail('RECOVERY_STORAGE_LIST_FAILED');
        const entries = await listed.json(); if (!Array.isArray(entries)) fail('RECOVERY_STORAGE_LIST_FAILED');
        for (const item of entries) {
          const name = safePath((prefix ? prefix + '/' : '') + item.name);
          if (item.id === null) { await visit(name, depth + 1); continue; }
          if (files.length >= MAX_FILES || Number(item.metadata?.size ?? 0) > LIMIT) fail('RECOVERY_LIMIT_EXCEEDED');
          const response = await fetchImpl(url.replace(/\/$/,'')+'/storage/v1/object/'+bucket+'/'+name.split('/').map(encodeURIComponent).join('/'), { headers, signal:AbortSignal.timeout(30000) });
          if (!response.ok) fail('RECOVERY_STORAGE_DOWNLOAD_FAILED');
          if (Number(response.headers.get('content-length') ?? 0) > LIMIT) fail('RECOVERY_LIMIT_EXCEEDED');
          const chunks = []; let bytes = 0;
          for await (const chunk of response.body) { bytes += chunk.length; if (bytes > LIMIT || total + bytes > MAX_TOTAL) fail('RECOVERY_LIMIT_EXCEEDED'); chunks.push(Buffer.from(chunk)); }
          total += bytes; files.push({ path:'storage/'+bucket+'/'+name, data:Buffer.concat(chunks) });
        }
        if (entries.length < 1000) break;
      }
    };
    await visit();
  }
  return files;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const [command, directory, targetDirectory] = process.argv.slice(2);
    const passphrase = process.env.NORDLA_RECOVERY_PASSPHRASE;
    let result;
    if (command === 'capture') {
      const database = await dumpDatabase({ connection:process.env.NORDLA_BACKUP_DATABASE_URL });
      const files = await captureStorage({ url:process.env.SUPABASE_URL, key:process.env.SUPABASE_SERVICE_ROLE_KEY, buckets:['finance-inbox',process.env.SOURCING_BACKUP_BUCKET || 'nordla-backups'] });
      const roles = await pgCommand(process.env.NORDLA_PG_DUMPALL || 'pg_dumpall', ['--roles-only','--no-role-passwords','--no-password'], databaseEnvironment(process.env.NORDLA_BACKUP_DATABASE_URL, process.env));
      files.push({ path:'configuration/roles-without-passwords.sql', data:roles });
      files.push({ path:'configuration/release.json', data:Buffer.from(JSON.stringify({ capturedAt:new Date().toISOString(), sourceSha:process.env.RAILWAY_GIT_COMMIT_SHA || null, branch:process.env.RAILWAY_GIT_BRANCH || null, recoveryScope:'database, Finance objects, Sourcing archives; provider credentials and personal MFA recovery remain separate' })) });
      result = await createBundle({ directory, passphrase, database, files });
    } else if (command === 'verify') { const r = await verifyBundle({ directory, passphrase }); result = { ok:r.ok, files:r.files, bytes:r.bytes, manifestSha256:r.manifestSha256 }; }
    else if (command === 'restore') result = await restoreBundle({ directory, passphrase, targetDirectory, restoreDatabase:data => restoreDrillDatabase({ connection:process.env.NORDLA_RESTORE_DATABASE_URL, data }) });
    else fail('RECOVERY_COMMAND_INVALID');
    console.log(JSON.stringify(result));
  } catch (error) { console.error(JSON.stringify({ ok:false, code:error instanceof RecoveryError ? error.code : 'RECOVERY_FAILED' })); process.exitCode = 1; }
}
