// Phase 4 - which code is running: the commit (SHA) and branch a server was built from, served on GET /version.
// Source, in order: NORDLA_RELEASE_SHA (declared at build), then RAILWAY_GIT_COMMIT_SHA (set by Railway for a Git deploy), else 'unknown'.
// `source` says where the value came from, so a deploy by upload (no Git) shows up as 'unknown' instead of a guess.
// Nothing secret is read: no key, no token, no commit message.

const SHA = /^[0-9a-f]{7,40}$/;
const BRANCH = /^[A-Za-z0-9._/-]{1,100}$/;

export function releaseOf(env = {}) {
  const declared = String(env.NORDLA_RELEASE_SHA ?? '').trim().toLowerCase();
  const git = String(env.RAILWAY_GIT_COMMIT_SHA ?? '').trim().toLowerCase();
  const branchRaw = String(env.NORDLA_RELEASE_BRANCH ?? env.RAILWAY_GIT_BRANCH ?? '').trim();
  const sha = SHA.test(declared) ? declared : SHA.test(git) ? git : null;
  const source = SHA.test(declared) ? 'declared' : SHA.test(git) ? 'railway-git' : 'none';
  return Object.freeze({
    sha: sha ?? 'unknown',
    branch: BRANCH.test(branchRaw) ? branchRaw : 'unknown',
    source,
  });
}

/** True when the served commit is the expected one (a short or full SHA of at least 7 characters, lowercase hex). */
export function releaseMatches(servedSha, expectedSha) {
  const served = String(servedSha ?? '').toLowerCase();
  const expected = String(expectedSha ?? '').trim().toLowerCase();
  if (!SHA.test(served) || !SHA.test(expected)) return false;
  return served.startsWith(expected) || expected.startsWith(served);
}
