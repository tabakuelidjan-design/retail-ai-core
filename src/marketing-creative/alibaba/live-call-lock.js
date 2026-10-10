import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

// The one-live-call protection. A live attempt takes an exclusive lock (the 'wx' flag: it fails if the file exists, atomically) BEFORE anything can be sent, and
// the lock is NEVER released by code: whatever happens next (a provider-side 403 / 429 / 5xx, a timeout, a success) the attempt may have reached the provider and
// may have been billed, so a second attempt needs a human who has reviewed the first one and archived its evidence. There is no automatic retry anywhere.

export const LIVE_CALL_ALREADY_ATTEMPTED = 'LIVE_CALL_ALREADY_ATTEMPTED';

export async function takeLiveCallLock(lockPath, { now = () => new Date().toISOString() } = {}) {
  await mkdir(path.dirname(lockPath), { recursive: true });
  try {
    await writeFile(lockPath, JSON.stringify({ started_at: now(), note: 'delete this file only after reviewing why the single live call did not complete' }), { flag: 'wx', mode: 0o600 });
  } catch (error) {
    if (error?.code === 'EEXIST') throw Object.assign(new Error(`${LIVE_CALL_ALREADY_ATTEMPTED}: a live call was already attempted`), { code: LIVE_CALL_ALREADY_ATTEMPTED });
    throw error;
  }
}

/** Takes the lock, then runs `call` once. The lock stays whatever `call` does. */
export async function runSingleLiveCall({ lockPath, call }) {
  await takeLiveCallLock(lockPath);
  return call();
}
