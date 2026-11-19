#!/usr/bin/env node
// Phase 4 - checks which commit a server actually serves. Usage: node scripts/check-release.mjs <https-base-url> <expected-sha>
// Exit 0 only when /version reports the expected commit. Prints the service, commit, branch and source - never a secret.
import { releaseMatches } from '../src/sourcing/server/release.js';

const [base, expected] = process.argv.slice(2);
if (!base || !expected) { console.error('usage: check-release.mjs <https-base-url> <expected-sha>'); process.exit(2); }
if (!/^https:\/\//.test(base)) { console.error('the base URL must be https'); process.exit(2); }

const res = await fetch(new URL('/version', base), { redirect: 'error', signal: AbortSignal.timeout(15000) });
const body = await res.json().catch(() => null);
if (!res.ok || !body) { console.error(`/version answered ${res.status}`); process.exit(1); }
console.log(`service=${body.service} served=${body.sha} branch=${body.branch} source=${body.source} expected=${expected}`);
if (!releaseMatches(body.sha, expected)) { console.error('MISMATCH: the served commit is not the expected one'); process.exit(1); }
console.log('OK: the served commit is the expected one');
