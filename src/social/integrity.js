// Integrity of approvals (audit finding C6): an approval is a SIGNED record. Editing the data folder - by hand, by a sync tool, by a restore, by another program - can no longer create
// an authorisation, because the signing key does NOT live in the data folder.
//
//   approval = { approved_by, approved_at, content_hash, [duplicate_ack], key_id, sig }
//   sig      = HMAC-SHA256(key, canonical { v, post_id, content_hash, approved_by, approved_at, duplicate_ack, key_id })
//
// A signed approval is valid for a post only if (1) the signature verifies with OUR key, (2) its content_hash is the hash of the post AS IT IS NOW (text, asset, hashtags, platform, format,
// account, subject, date), (3) it belongs to this very post (the post id is signed: an approval copied from another post is worthless).
//
// Where the key lives: its own folder, OUTSIDE the data folder (`SOCIAL_KEY_DIR`, default %LOCALAPPDATA%\Nordla\social-keys on Windows, ~/.config/nordla/social-keys elsewhere), created
// with owner-only rights (0700 / 0600; on Windows `icacls` removes inherited rights and grants the current user only). The folder is refused if it is inside the data folder (or contains it).
// The key is never printed, logged, stored in a post, an audit line, an error message or a test report.
//
// Threat model, stated plainly. PROTECTED: any change made to the data folder by something that cannot read the key folder (hand edits, sync/restore tools, a script, another application,
// an accidental overwrite, a forged "approved" file). NOT PROTECTED: a program running as the same operating-system user that can read the key file (it can sign anything), and the
// replacement of a post file by an OLDER copy of itself that carried a genuine approval for that older content (rollback): an approval ledger kept next to the key would close that gap.
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import {
  chmodSync, existsSync, linkSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { SOCIAL_ERROR as E, fail } from './constants.js';
import { canonical, contentHashOf } from './post.js';

const HEX64 = /^[0-9a-f]{64}$/;

export function approvalPayload(post, approval, keyId) {
  return canonical({
    v: 1, post_id: post.id, content_hash: approval.content_hash, approved_by: approval.approved_by, approved_at: approval.approved_at, duplicate_ack: approval.duplicate_ack ?? null, key_id: keyId,
  });
}

function makeIntegrity(key, info) {
  const keyId = createHash('sha256').update(key).digest('hex').slice(0, 12);
  const mac = (post, approval) => createHmac('sha256', key).update(approvalPayload(post, approval, keyId)).digest('hex');
  return Object.freeze({
    keyId,
    /** The signature to store in `approval.sig` (the caller stores `key_id` too). */
    sign: (post, approval) => mac(post, approval),
    /** true only for a signed approval that covers THIS post as it is now. */
    verifyApproval(post) {
      const a = post.approval;
      if (!a || typeof a.sig !== 'string' || !/^[0-9a-f]{64}$/.test(a.sig) || a.key_id !== keyId) return false;
      if (a.content_hash !== contentHashOf(post)) return false;
      const expected = Buffer.from(mac(post, a), 'hex');
      const given = Buffer.from(a.sig, 'hex');
      return expected.length === given.length && timingSafeEqual(expected, given);
    },
    describe: () => ({ key_id: keyId, ...info }),
  });
}

/** In-memory key (tests, and a process without a key ring). Approvals signed with it die with the process: fail closed. */
export function createEphemeralIntegrity() {
  return makeIntegrity(randomBytes(32), { persistent: false, source: 'memory' });
}
let shared = null;
/** One ephemeral key per process, shared by every service of that process (a "restart" inside one process keeps working in tests). A real server passes a file key ring. */
export const defaultIntegrity = () => (shared ??= createEphemeralIntegrity());

export function defaultKeyDir(env = process.env, platform = process.platform) {
  if (env.SOCIAL_KEY_DIR) return resolve(env.SOCIAL_KEY_DIR);
  if (platform === 'win32') return join(env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'Nordla', 'social-keys');
  return join(env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'nordla', 'social-keys');
}

function inside(parent, child) {
  const rel = relative(resolve(parent), resolve(child));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/** Owner-only rights. POSIX: modes. Windows: remove inherited rights, grant the current user only. Returns whether the OS accepted it. */
export function harden(path, { directory }) {
  if (process.platform !== 'win32') { try { chmodSync(path, directory ? 0o700 : 0o600); return true; } catch { return false; } }
  const user = process.env.USERDOMAIN && process.env.USERNAME ? `${process.env.USERDOMAIN}\\${process.env.USERNAME}` : process.env.USERNAME;
  if (!user) return false;
  const grant = directory ? `${user}:(OI)(CI)F` : `${user}:F`;
  const r = spawnSync('icacls', [path, '/inheritance:r', '/grant:r', grant], { encoding: 'utf8', windowsHide: true });
  return r.status === 0;
}

/** For tools that only READ approvals (the CLI calendar): the key ring if the key already exists, otherwise the process key (no approval can be valid). Never creates a key. */
export function openKeyringIfPresent({ keyDir, dataDir }) {
  return existsSync(join(keyDir, 'approval.key')) ? createFileKeyring({ keyDir, dataDir }) : defaultIntegrity();
}

/**
 * The persistent key ring of a real server. `dataDir` is given so that a key folder inside (or around) the data folder is REFUSED.
 * @returns the integrity object, with describe() -> { persistent: true, key_id, hardened, source: 'file' } (never the key)
 */
export function createFileKeyring({ keyDir, dataDir }) {
  if (!keyDir) fail(E.INTEGRITY, 'a key folder is required');
  if (dataDir && (inside(dataDir, keyDir) || inside(keyDir, dataDir))) fail(E.INTEGRITY, 'the key folder must be OUTSIDE the data folder (and must not contain it): whoever can edit the data must not be able to read the key');
  mkdirSync(keyDir, { recursive: true, mode: 0o700 });
  const file = join(keyDir, 'approval.key');
  let hardened = null; // unknown unless this very call created the key
  if (!existsSync(file)) {
    // written COMPLETE under a temporary name, then linked into place: link fails if the key already exists, and nobody ever reads a half-written key
    const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
    writeFileSync(tmp, `${randomBytes(32).toString('hex')}\n`, { mode: 0o600 });
    try {
      linkSync(tmp, file);
      hardened = harden(file, { directory: false }) && harden(keyDir, { directory: true });
    } catch (e) { if (e.code !== 'EEXIST') throw e; } // another process created it first: use theirs
    finally { unlinkSync(tmp); }
  }
  if (process.platform !== 'win32' && (statSync(file).mode & 0o077) !== 0) fail(E.INTEGRITY, 'the key file is readable by other users: refusing to use it (chmod 600)');
  const hex = readFileSync(file, 'utf8').trim();
  if (!HEX64.test(hex)) fail(E.INTEGRITY, 'the key file is not a 256-bit key');
  return makeIntegrity(Buffer.from(hex, 'hex'), { persistent: true, source: 'file', hardened });
}
