// The owner's access token (the phone app's password). It used to sit in clear text in the DATA folder (`token.txt`), next to the posts: anything that copies, syncs, backs up or
// shares that folder carried the password with it.
//
// Now:
//   - SOCIAL_TOKEN in the environment (24+ characters) wins, and nothing is written anywhere: the way to run it hosted (the secret lives in the host's secret store);
//   - otherwise the token lives in `owner.token` inside the KEY folder (integrity.js): outside the data folder, owner-only rights (0600 / icacls), never copied by a data backup;
//   - a legacy `<data>/token.txt` is MIGRATED once (same value, so the phone keeps working), then removed from the data folder.
// The token is never printed, logged, put in a post, an audit line or an error. Honest limit: a program running as the same operating-system user can read the key folder.
import { randomBytes } from 'node:crypto';
import {
  existsSync, linkSync, readFileSync, statSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { SOCIAL_ERROR as E, fail } from './constants.js';
import { harden } from './integrity.js';

export const MIN_TOKEN_LENGTH = 24;
const readToken = (file) => { try { return readFileSync(file, 'utf8').trim(); } catch { return ''; } };

function writeOnce(file, token) { // complete under a temporary name, then linked into place: nobody ever reads half a token, and an existing token is never overwritten
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  writeFileSync(tmp, `${token}\n`, { mode: 0o600 });
  try { linkSync(tmp, file); return true; } catch (e) { if (e.code !== 'EEXIST') throw e; return false; } finally { unlinkSync(tmp); }
}

/**
 * @returns {{ token: string, source: 'env' | 'key-folder', file: string | null, migrated: boolean }}  (`file` is where the token lives; never its content)
 */
export function ensureOwnerToken({ env = process.env, keyDir, dataDir }) {
  if (env.SOCIAL_TOKEN && env.SOCIAL_TOKEN.length >= MIN_TOKEN_LENGTH) return { token: env.SOCIAL_TOKEN, source: 'env', file: null, migrated: false };
  if (!keyDir) fail(E.INTEGRITY, 'a key folder is required to keep the access token');
  const file = join(keyDir, 'owner.token');
  let migrated = false;
  if (!existsSync(file)) {
    const legacyFile = dataDir ? join(dataDir, 'token.txt') : null;
    const legacy = legacyFile ? readToken(legacyFile) : '';
    const token = legacy.length >= MIN_TOKEN_LENGTH ? legacy : randomBytes(24).toString('hex');
    if (writeOnce(file, token)) {
      harden(file, { directory: false });
      if (legacy.length >= MIN_TOKEN_LENGTH) { try { unlinkSync(legacyFile); migrated = true; } catch { /* could not remove: reported through `migrated: false` */ } }
    }
  }
  if (process.platform !== 'win32' && (statSync(file).mode & 0o077) !== 0) fail(E.INTEGRITY, 'the access token file is readable by other users: refusing to use it (chmod 600)');
  const token = readToken(file);
  if (token.length < MIN_TOKEN_LENGTH) fail(E.INTEGRITY, 'the access token file is empty or too short');
  return { token, source: 'key-folder', file, migrated };
}
