// Checks ONE SSO key variable against the policy (32 random bytes, canonical base64url). Prints only a verdict, never the value.
// Usage (local shell, value never echoed):  node scripts/check-sso-key.mjs FINANCE_SSO_KEY
import { parseSsoKey } from '../src/identity/sso-keys.js';

const name = process.argv[2];
if (!name || !/^[A-Z_]+$/.test(name)) { console.error('usage: node scripts/check-sso-key.mjs <VARIABLE_NAME>'); process.exit(2); }
const r = parseSsoKey(process.env[name]);
console.log(r.ok ? `${name}: OK (32 bytes, canonical base64url)` : `${name}: ${r.code}`);
process.exit(r.ok ? 0 : 1);
